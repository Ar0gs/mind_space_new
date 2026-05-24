// ============================================================
// notifications.js — MindSpace Push Notification Engine v4
// ============================================================
// Flow:
//   1. Page loads → auto-init polls for window.currentUser
//   2. Once user is known, SW subscription is checked
//   3. User clicks "Enable" → requestNotificationPermission()
//      → browser asks permission → if granted → subscribe to push
//      → save subscription (endpoint + keys) to push_subscriptions table
//   4. Superadmin sends push via Edge Function → SW receives it
//      → shows OS-level notification even if tab is closed
//   5. Local realtime listener fires a notification when a
//      new message arrives and the tab is hidden
// ============================================================

(function (global) {
  'use strict';

  // ── Internal state ──
  let _pushSubscription = null;
  let _userId           = null;
  let _isAdmin          = false;
  let _realtimeChannel  = null;
  let _initDone         = false;

  // ── Public init ──
  async function initNotifications(userId, isAdmin) {
    _userId   = userId;
    _isAdmin  = !!isAdmin;
    _initDone = true;

    if (!('Notification' in window)) {
      console.warn('[Notif] Notifications not supported.');
      return;
    }
    if (!('serviceWorker' in navigator)) {
      console.warn('[Notif] Service Worker not supported.');
      return;
    }

    // Listen for SW → page messages
    navigator.serviceWorker.addEventListener('message', _handleSWMessage);

    // Already granted → silently resubscribe (re-saves to DB on each login)
    if (Notification.permission === 'granted') {
      await _subscribeToPush();
    }

    _syncAllButtons(Notification.permission === 'granted');

    // Show gentle nudge bar on user chat page if not yet decided
    if (!_isAdmin && Notification.permission === 'default') {
      _showNudgeBar();
    }
  }

  // ── Request permission + subscribe ──
  async function requestNotificationPermission() {
    if (!('Notification' in window)) {
      _showToast('Notifications are not supported on this browser.', 'error');
      return false;
    }
    if (Notification.permission === 'denied') {
      _showToast(
        'Notifications are blocked. Tap the 🔒 lock icon in your address bar → Notifications → Allow, then reload.',
        'error', 7000
      );
      return false;
    }

    // Grab userId from window.currentUser immediately if available
    if (!_userId && global.currentUser?.id) {
      _userId = global.currentUser.id;
    }

    // Trigger init if it hasn't run yet
    if (!_initDone && _userId) {
      await initNotifications(_userId, _isAdmin);
    }

    // Poll briefly if still no userId
    if (!_userId) {
      await _waitForUserId(4000);
    }

    if (!_userId) {
      _showToast('Still loading your session — please try again in a moment.', 'warning');
      return false;
    }

    const permission = await Notification.requestPermission();

    if (permission === 'granted') {
      const saved = await _subscribeToPush();
      if (saved) {
        _showToast('✓ Notifications enabled — you\'ll be alerted when your counsellor replies!', 'success');
      } else {
        // Still mark UI as enabled — local notifications work even without server push
        _showToast('✓ Notifications enabled! (Server push will activate once set up.)', 'success');
      }
      _syncAllButtons(true);
      _dismissNudge();
      return true;
    } else {
      _showToast('Notifications were not enabled. You can enable them any time from the menu.', 'warning');
      _syncAllButtons(false);
      return false;
    }
  }

  // ── Unsubscribe ──
  async function unsubscribeFromPush() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        if (_userId && global.sb) {
          await global.sb.from('push_subscriptions')
            .delete()
            .eq('user_id', _userId)
            .eq('endpoint', endpoint);
        }
        _pushSubscription = null;
      }
      _syncAllButtons(false);
      _showToast('Notifications turned off.', 'info');
    } catch (err) {
      console.error('[Notif] Unsubscribe error:', err);
    }
  }

  // ── Subscribe to push and save to Supabase ──
  // Returns true if subscription was saved to DB, false otherwise
  async function _subscribeToPush() {
    try {
      // Ensure SW is registered first — register it if missing
      if (!navigator.serviceWorker.controller) {
        try {
          await navigator.serviceWorker.register('/sw.js');
          // Wait briefly for the new SW to take control
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (regErr) {
          console.warn('[Notif] SW registration error (non-fatal):', regErr);
        }
      }

      // Wait for SW ready with a timeout so we don't hang forever
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error('SW ready timeout')), 8000))
      ]);

      let sub = await reg.pushManager.getSubscription();

      if (!sub) {
        const vapidKey = global.VAPID_PUBLIC_KEY;
        if (!vapidKey) {
          console.info('[Notif] No VAPID_PUBLIC_KEY — server push disabled; local notifications still work.');
          return false;
        }
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: _urlBase64ToUint8Array(vapidKey)
        });
        console.log('[Notif] ✓ New push subscription created:', sub.endpoint.substring(0, 60) + '…');
      } else {
        console.log('[Notif] ✓ Existing push subscription found.');
      }

      _pushSubscription = sub;
      return await _saveSubscription(sub);
    } catch (err) {
      console.error('[Notif] Push subscription error:', err.message || err);
      return false;
    }
  }

  // ── Save subscription to Supabase push_subscriptions table ──
  // Returns true on success, false on failure
  async function _saveSubscription(sub) {
    if (!_userId) {
      console.warn('[Notif] Cannot save subscription — userId not set. Make sure initNotifications() was called first.');
      return false;
    }
    if (!global.sb) {
      console.warn('[Notif] Cannot save subscription — Supabase client (sb) not ready.');
      return false;
    }

    // Verify we have an active auth session — without it, RLS will block the insert
    const { data: { session } } = await global.sb.auth.getSession();
    if (!session) {
      console.error('[Notif] ✗ No auth session found — user must be logged in to save subscription. The insert will be blocked by RLS.');
      return false;
    }

    const json   = sub.toJSON();
    const record = {
      user_id:    _userId,
      endpoint:   json.endpoint,
      p256dh:     json.keys?.p256dh  || '',
      auth:       json.keys?.auth    || '',
      user_agent: navigator.userAgent.substring(0, 200),
      updated_at: new Date().toISOString()
    };

    console.log('[Notif] Saving subscription for user', _userId, '| session uid:', session.user.id);

    // Step 1: Delete any stale record for this user+endpoint
    await global.sb
      .from('push_subscriptions')
      .delete()
      .eq('user_id', _userId)
      .eq('endpoint', json.endpoint);

    // Step 2: Fresh insert
    const { data: inserted, error: insertErr } = await global.sb
      .from('push_subscriptions')
      .insert(record)
      .select();

    if (!insertErr) {
      console.log('[Notif] ✓ Subscription saved to DB:', inserted);
      return true;
    }

    console.error('[Notif] ✗ Insert failed — code:', insertErr.code, '| message:', insertErr.message, '| details:', insertErr.details, '| hint:', insertErr.hint);

    // Step 3: Unique constraint conflict → try upsert
    if (insertErr.code === '23505') {
      console.warn('[Notif] Retrying with upsert (unique conflict)…');
      const { data: upserted, error: upsertErr } = await global.sb
        .from('push_subscriptions')
        .upsert(record, { onConflict: 'endpoint' })
        .select();
      if (!upsertErr) {
        console.log('[Notif] ✓ Subscription upserted:', upserted);
        return true;
      }
      console.error('[Notif] ✗ Upsert also failed:', upsertErr.message);
      return false;
    }

    // Friendly guidance for common failure codes
    if (insertErr.code === '42P01') {
      console.error(
        '[Notif] ✗ The push_subscriptions table does not exist in your Supabase project.\n' +
        'Solution: Run push_subscriptions_fix.sql in your Supabase SQL Editor.'
      );
    } else if (insertErr.code === '42501' || insertErr.message?.includes('policy') || insertErr.message?.includes('permission')) {
      console.error(
        '[Notif] ✗ RLS is blocking the insert.\n' +
        'Solution: Run push_subscriptions_fix.sql in your Supabase SQL Editor to create the correct policies.'
      );
    }

    return false;
  }

  // ── Send a local notification via the SW (works when tab is hidden) ──
  async function sendLocalNotification({ title, body, url, tag, type = 'message' }) {
    if (Notification.permission !== 'granted') return;
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title || 'MindSpace', {
        body:    body || 'You have a new message.',
        icon:    'icons/icon-192.png',
        badge:   'icons/icon-96.png',
        tag:     tag || 'mindspace-local',
        renotify: true,
        vibrate: [200, 100, 200],
        data:    { url: url || '/chat.html', type },
        actions: type === 'message'
          ? [{ action: 'reply', title: '💬 Reply' }, { action: 'dismiss', title: 'Dismiss' }]
          : []
      });
    } catch (err) {
      console.error('[Notif] Local notification error:', err);
    }
  }

  // ── Realtime listener: fires local notification when a message arrives ──
  function setupRealtimeNotifications(conversationId) {
    if (!global.sb || !conversationId) return;
    if (_realtimeChannel) {
      global.sb.removeChannel(_realtimeChannel);
      _realtimeChannel = null;
    }

    _realtimeChannel = global.sb.channel('notif-' + conversationId)
      .on('postgres_changes', {
        event:  'INSERT',
        schema: 'public',
        table:  'messages',
        filter: 'conversation_id=eq.' + conversationId
      }, async payload => {
        const msg = payload.new;
        if (msg.sender_id === _userId) return;     // own message
        if (!document.hidden)          return;     // tab is visible — no pop needed

        const preview = (msg.content || '').substring(0, 100) +
          (msg.content?.length > 100 ? '…' : '');

        const body = preview ||
          (msg.message_type === 'voice' ? '🎙 Voice message' :
           msg.message_type === 'image' ? '📷 Image' :
           msg.message_type === 'video' ? '🎥 Video' : 'New message');

        await sendLocalNotification({
          title: _isAdmin ? 'MindSpace — New message from user' : 'MindSpace — Your counsellor replied',
          body,
          url:  _isAdmin ? 'admin.html' : 'chat.html',
          tag:  'mindspace-chat-' + conversationId,
          type: 'message'
        });
      })
      .subscribe();

    return _realtimeChannel;
  }

  // ── Admin helpers (used by admin.html / superadmin.html) ──
  async function adminSendPushToUser(targetUserId, { title, body, url, type = 'message' }) {
    return _callEdgeFunction({
      targetUserId,
      notification: { title, body, url: url || '/chat.html', type }
    });
  }

  async function adminBroadcastPush({ title, body, url, type = 'announcement' }) {
    return _callEdgeFunction({
      broadcast: true,
      notification: { title, body, url: url || '/chat.html', type }
    });
  }

  // ── Call the send-push Edge Function ──
  async function _callEdgeFunction(payload) {
    if (!global.sb) return { success: false, error: 'Supabase not ready' };
    if (typeof global.SUPABASE_URL === 'undefined' || typeof global.SUPABASE_ANON_KEY === 'undefined') {
      return { success: false, error: 'SUPABASE_URL / SUPABASE_ANON_KEY not defined' };
    }
    try {
      const { data: { session } } = await global.sb.auth.getSession();
      const token = session?.access_token || global.SUPABASE_ANON_KEY;

      const res = await fetch(`${global.SUPABASE_URL}/functions/v1/send-push`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'apikey':        global.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });

      let json = {};
      try { json = await res.json(); } catch (_) {}

      if (!res.ok) throw new Error(json.error || json.message || `HTTP ${res.status}`);
      return { success: true, data: json };
    } catch (err) {
      console.error('[Notif] Edge function error:', err);
      return { success: false, error: err.message };
    }
  }

  // ── Nudge bar ──
  function _showNudgeBar() {
    if (sessionStorage.getItem('ms_notif_nudge_dismissed')) return;
    if (document.getElementById('ms-notif-nudge')) return;

    setTimeout(() => {
      const bar = document.createElement('div');
      bar.id = 'ms-notif-nudge';

      bar.style.cssText = [
        'position:fixed',
        'bottom:36px',
        'left:50%',
        'transform:translateX(-50%) translateY(120px)',
        'z-index:999999',
        'background:#fff',
        'border:1.5px solid #E0DDD8',
        'border-top:3px solid #1900ff',
        'box-shadow:0 8px 32px rgba(0,0,0,.18)',
        'padding:14px 16px',
        'display:flex',
        'align-items:center',
        'gap:12px',
        'width:min(440px,calc(100vw - 32px))',
        'box-sizing:border-box',
        'font-family:DM Sans,sans-serif',
        'font-size:13px',
        'transition:transform .5s cubic-bezier(.16,1,.3,1),opacity .4s',
        'opacity:0',
        'pointer-events:all'
      ].join(';');

      const bell = document.createElement('span');
      bell.style.cssText = 'font-size:22px;flex-shrink:0';
      bell.textContent = '🔔';

      const textWrap = document.createElement('div');
      textWrap.style.cssText = 'flex:1;min-width:0';

      const titleEl = document.createElement('div');
      titleEl.style.cssText = 'font-weight:600;color:#0a0a0a;font-size:13px;margin-bottom:2px';
      titleEl.textContent = 'Get session alerts';

      const subEl = document.createElement('div');
      subEl.style.cssText = 'font-size:11px;color:#888;font-weight:300;line-height:1.5';
      subEl.textContent = 'Enable notifications so your counsellor can reach you even when this tab is in the background.';

      textWrap.appendChild(titleEl);
      textWrap.appendChild(subEl);

      const btnCol = document.createElement('div');
      btnCol.style.cssText = 'display:flex;flex-direction:column;gap:6px;flex-shrink:0';

      const enableBtn = document.createElement('button');
      enableBtn.style.cssText = [
        'background:#1900ff', 'color:#fff', 'border:none',
        'padding:10px 18px', 'font-size:12px', 'font-weight:700',
        'letter-spacing:1px', 'text-transform:uppercase',
        'cursor:pointer', 'font-family:inherit',
        'white-space:nowrap', 'min-height:40px',
        'pointer-events:all', '-webkit-tap-highlight-color:transparent'
      ].join(';');
      enableBtn.textContent = 'Enable';

      const dismissBtn = document.createElement('button');
      dismissBtn.style.cssText = [
        'background:transparent', 'color:#aaa', 'border:none',
        'padding:4px 6px', 'font-size:11px',
        'cursor:pointer', 'font-family:inherit',
        'pointer-events:all', '-webkit-tap-highlight-color:transparent'
      ].join(';');
      dismissBtn.textContent = 'Not now';

      btnCol.appendChild(enableBtn);
      btnCol.appendChild(dismissBtn);

      bar.appendChild(bell);
      bar.appendChild(textWrap);
      bar.appendChild(btnCol);

      document.body.appendChild(bar);

      requestAnimationFrame(() => requestAnimationFrame(() => {
        bar.style.transform = 'translateX(-50%) translateY(0)';
        bar.style.opacity   = '1';
      }));

      enableBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        _dismissNudge();
        await requestNotificationPermission();
      });

      dismissBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _dismissNudge();
        sessionStorage.setItem('ms_notif_nudge_dismissed', '1');
      });

      enableBtn.addEventListener('touchend', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        _dismissNudge();
        await requestNotificationPermission();
      }, { passive: false });

      dismissBtn.addEventListener('touchend', (e) => {
        e.preventDefault();
        e.stopPropagation();
        _dismissNudge();
        sessionStorage.setItem('ms_notif_nudge_dismissed', '1');
      }, { passive: false });

    }, 4000);
  }

  function _dismissNudge() {
    const bar = document.getElementById('ms-notif-nudge');
    if (!bar) return;
    bar.style.transform = 'translateX(-50%) translateY(120px)';
    bar.style.opacity   = '0';
    setTimeout(() => bar.remove(), 500);
  }

  // ── Sync every notification button/status element on the page ──
  function _syncAllButtons(enabled) {
    const topBtn = document.getElementById('notif-toggle-btn');
    if (topBtn) {
      topBtn.textContent = enabled ? '🔔 Notifications On' : '🔕 Notifications';
      topBtn.style.color = enabled ? 'var(--sage,#1900ff)' : '';
    }
    const sideBtn = document.getElementById('notif-sidebar-btn');
    const sideSt  = document.getElementById('notif-sidebar-status');
    if (sideBtn) {
      sideBtn.textContent       = enabled ? '🔔 Notifications On' : '🔕 Enable Notifications';
      sideBtn.style.borderColor = enabled ? 'var(--sage,#1900ff)' : '';
      sideBtn.style.color       = enabled ? 'var(--sage,#1900ff)' : '';
    }
    if (sideSt) {
      sideSt.textContent = enabled ? '✓ You will receive alerts for new messages.' : '';
      sideSt.style.color = 'var(--sage,#1900ff)';
    }
    const drawerBtn = document.getElementById('drawer-notif-btn');
    const drawerSt  = document.getElementById('drawer-notif-status');
    if (drawerBtn) {
      drawerBtn.textContent = enabled ? '🔔 Notifications On' : '🔕 Enable Notifications';
      drawerBtn.classList.toggle('enabled', enabled);
    }
    if (drawerSt) {
      drawerSt.textContent = enabled ? '✓ You\'ll be alerted when your counsellor replies.' : '';
    }

    if (typeof global.syncNotifUI === 'function') global.syncNotifUI(enabled);
  }

  // ── Handle SW → page messages ──
  function _handleSWMessage(event) {
    const data = event.data;
    if (!data) return;
    switch (data.type) {
      case 'DECLINE_CALL':
        if (typeof global.declineCall === 'function') global.declineCall();
        break;
      case 'SYNC_MESSAGES':
        if (typeof global.sendQueuedMessages === 'function') global.sendQueuedMessages();
        break;
      case 'PUSH_SUBSCRIPTION_CHANGED':
        _subscribeToPush();
        break;
    }
  }

  // ── Wait until window.currentUser is set (up to maxMs) ──
  function _waitForUserId(maxMs) {
    return new Promise(resolve => {
      if (_userId) return resolve();

      const directId = global.currentUser?.id;
      if (directId) { _userId = directId; return resolve(); }

      const start = Date.now();
      const t = setInterval(() => {
        const id = _userId || global.currentUser?.id;
        if (id) {
          if (!_userId) _userId = id;
          clearInterval(t);
          resolve();
        } else if (Date.now() - start > maxMs) {
          clearInterval(t);
          resolve();
        }
      }, 80);
    });
  }

  // ── Toast ──
  function _showToast(msg, variant = 'info', duration = 4500) {
    if (typeof global.showToast === 'function') { global.showToast(msg); return; }
    let el = document.getElementById('ms-notif-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ms-notif-toast';
      el.style.cssText = [
        'position:fixed', 'bottom:52px', 'left:50%',
        'transform:translateX(-50%) translateY(20px)',
        'z-index:9999999', 'background:#0a0a0a', 'color:#fff',
        'padding:12px 20px', 'font-family:DM Sans,sans-serif', 'font-size:13px',
        'max-width:min(360px,calc(100vw - 32px))', 'text-align:center',
        'opacity:0', 'transition:all .35s', 'border-left:3px solid #1900ff',
        'pointer-events:none', 'line-height:1.5'
      ].join(';');
      document.body.appendChild(el);
    }
    const colors = { success: '#27ae60', error: '#c0392b', warning: '#e67e22', info: '#1900ff' };
    el.style.borderLeftColor = colors[variant] || '#1900ff';
    el.textContent = msg;
    el.style.opacity   = '1';
    el.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(el._t);
    el._t = setTimeout(() => {
      el.style.opacity   = '0';
      el.style.transform = 'translateX(-50%) translateY(20px)';
    }, duration);
  }

  // ── Utility: VAPID key conversion ──
  function _urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
  }

  // ── Auto-init on user chat page ──
  function _autoInit() {
    if (window.location.pathname.includes('admin')) return;

    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      if (attempts > 100) { clearInterval(poll); return; }

      const userId = global.currentUser?.id;
      const convId = global.conversationId;

      if (userId && !_initDone) {
        clearInterval(poll);
        _userId = userId;
        await initNotifications(userId, false);
        if (convId) setupRealtimeNotifications(convId);
        return;
      }

      if (_initDone && convId && !_realtimeChannel) {
        clearInterval(poll);
        setupRealtimeNotifications(convId);
      }
    }, 200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _autoInit);
  } else {
    _autoInit();
  }

  // ── Public API ──
  global.MSNotif = {
    init:               initNotifications,
    requestPermission:  requestNotificationPermission,
    unsubscribe:        unsubscribeFromPush,
    sendLocal:          sendLocalNotification,
    setupRealtime:      setupRealtimeNotifications,
    adminSendToUser:    adminSendPushToUser,
    adminBroadcast:     adminBroadcastPush,
    callEdgeFunction:   _callEdgeFunction,
    getPermissionState: () => Notification.permission,
    showToast:          _showToast
  };

  // Backward-compat globals
  global.requestNotificationPermission = requestNotificationPermission;
  global.sendLocalNotification         = sendLocalNotification;

})(window);

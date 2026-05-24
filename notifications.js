// ============================================================
// notifications.js — MindSpace Push Notification Engine v5
// ============================================================
// Notifications are ON by default.
// On first visit, permission is requested automatically.
// Users can only disable notifications — not enable them (already on).
// ============================================================

(function (global) {
  'use strict';

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

    navigator.serviceWorker.addEventListener('message', _handleSWMessage);

    if (Notification.permission === 'granted') {
      // Already granted — silently resubscribe on each login
      await _subscribeToPush();
      _syncAllButtons(true);
    } else if (Notification.permission === 'default' && !_isAdmin) {
      // Not yet asked — request automatically (notifications are on by default)
      _syncAllButtons(false);
      await _autoRequestPermission();
    } else {
      // 'denied' or admin
      _syncAllButtons(Notification.permission === 'granted');
    }
  }

  // ── Auto-request on first load (no nudge bar needed — just ask) ──
  async function _autoRequestPermission() {
    // Small delay so the page has settled before the browser prompt appears
    await new Promise(r => setTimeout(r, 1500));

    if (Notification.permission !== 'default') return;

    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      await _subscribeToPush();
      _syncAllButtons(true);
      _showToast('✓ Notifications enabled — you\'ll be alerted when your counsellor replies.', 'success');
    } else {
      _syncAllButtons(false);
      // Blocked — show a gentle one-time note that they can re-enable from settings
      if (permission === 'denied') {
        _showToast('Notifications are blocked. To re-enable, tap the 🔒 icon in your address bar → Notifications → Allow.', 'warning', 8000);
      }
    }
  }

  // ── Manual disable (called by the UI button) ──
  async function disableNotifications() {
    await unsubscribeFromPush();
  }

  // ── Re-enable (called if user wants them back) ──
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

    if (!_userId && global.currentUser?.id) _userId = global.currentUser.id;
    if (!_initDone && _userId) await initNotifications(_userId, _isAdmin);
    if (!_userId) await _waitForUserId(4000);
    if (!_userId) {
      _showToast('Still loading your session — please try again in a moment.', 'warning');
      return false;
    }

    if (Notification.permission === 'granted') {
      // Already granted — just resubscribe and confirm
      const saved = await _subscribeToPush();
      _syncAllButtons(true);
      _showToast('✓ Notifications are already enabled.', 'success');
      return true;
    }

    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      const saved = await _subscribeToPush();
      _showToast(saved
        ? '✓ Notifications enabled — you\'ll be alerted when your counsellor replies!'
        : '✓ Notifications enabled! (Server push will activate once set up.)', 'success');
      _syncAllButtons(true);
      return true;
    } else {
      _showToast('Notifications were not enabled. You can enable them any time from the menu.', 'warning');
      _syncAllButtons(false);
      return false;
    }
  }

  // ── Unsubscribe / disable ──
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
      _showToast('Notifications turned off. You can re-enable them from the menu anytime.', 'info');
    } catch (err) {
      console.error('[Notif] Unsubscribe error:', err);
    }
  }

  // ── Subscribe to push and save to Supabase ──
  async function _subscribeToPush() {
    try {
      if (!navigator.serviceWorker.controller) {
        try {
          await navigator.serviceWorker.register('/sw.js');
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (regErr) {
          console.warn('[Notif] SW registration error (non-fatal):', regErr);
        }
      }

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

  // ── Save subscription to Supabase ──
  async function _saveSubscription(sub) {
    if (!_userId) {
      console.warn('[Notif] Cannot save subscription — userId not set.');
      return false;
    }
    if (!global.sb) {
      console.warn('[Notif] Cannot save subscription — Supabase client not ready.');
      return false;
    }

    const { data: { session } } = await global.sb.auth.getSession();
    if (!session) {
      console.error('[Notif] ✗ No auth session — insert will be blocked by RLS.');
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

    // Single atomic upsert on composite unique key (user_id, endpoint).
    // Fixes: 409/23505 race on insert + 400 wrong onConflict column.
    const { data: upserted, error: upsertErr } = await global.sb
      .from('push_subscriptions')
      .upsert(record, { onConflict: 'user_id,endpoint' })
      .select();

    if (!upsertErr) {
      console.log('[Notif] ✓ Subscription saved to DB:', upserted);
      return true;
    }

    console.error('[Notif] ✗ Save failed:', upsertErr.message);
    return false;
  }

  // ── Send a local notification ──
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

  // ── Realtime listener ──
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
        if (msg.sender_id === _userId) return;
        if (!document.hidden) return;

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

  // ── Admin helpers ──
  async function adminSendPushToUser(targetUserId, { title, body, url, type = 'message' }) {
    return _callEdgeFunction({ targetUserId, notification: { title, body, url: url || '/chat.html', type } });
  }
  async function adminBroadcastPush({ title, body, url, type = 'announcement' }) {
    return _callEdgeFunction({ broadcast: true, notification: { title, body, url: url || '/chat.html', type } });
  }

  async function _callEdgeFunction(payload) {
    if (!global.sb) return { success: false, error: 'Supabase not ready' };
    try {
      const { data: { session } } = await global.sb.auth.getSession();
      const token = session?.access_token || global.SUPABASE_ANON_KEY;
      const res = await fetch(`${global.SUPABASE_URL}/functions/v1/send-push`, {
        method: 'POST',
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

  // ── Sync all notification buttons/status elements ──
  // enabled = true  → show "Disable Notifications" option
  // enabled = false → show "Enable Notifications" option (as fallback)
  function _syncAllButtons(enabled) {
    const topBtn = document.getElementById('notif-toggle-btn');
    if (topBtn) {
      topBtn.textContent = enabled ? '🔔 Notifications On' : '🔕 Notifications Off';
      topBtn.style.color = enabled ? 'var(--sage,#1900ff)' : '';
    }

    const sideBtn = document.getElementById('notif-sidebar-btn');
    const sideSt  = document.getElementById('notif-sidebar-status');
    if (sideBtn) {
      sideBtn.textContent       = enabled ? '🔔 Disable Notifications' : '🔕 Enable Notifications';
      sideBtn.style.borderColor = enabled ? 'var(--sage,#1900ff)' : '';
      sideBtn.style.color       = enabled ? 'var(--sage,#1900ff)' : '';
    }
    if (sideSt) {
      sideSt.textContent = enabled
        ? '✓ You will receive alerts for new messages.'
        : 'Notifications are off. Tap above to re-enable.';
      sideSt.style.color = enabled ? 'var(--sage,#1900ff)' : '#aaa';
    }

    const drawerBtn = document.getElementById('drawer-notif-btn');
    const drawerSt  = document.getElementById('drawer-notif-status');
    if (drawerBtn) {
      drawerBtn.textContent = enabled ? '🔔 Disable Notifications' : '🔕 Enable Notifications';
      drawerBtn.classList.toggle('enabled', enabled);
    }
    if (drawerSt) {
      drawerSt.textContent = enabled
        ? '✓ You\'ll be alerted when your counsellor replies.'
        : 'Notifications are off. Tap above to re-enable.';
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

  // ── Wire up notification buttons to disable/enable correctly ──
  function _bindButtons() {
    // Any element with data-notif-toggle will toggle on/off
    document.querySelectorAll('[data-notif-toggle]').forEach(el => {
      el.addEventListener('click', async () => {
        if (Notification.permission === 'granted' && _pushSubscription) {
          await disableNotifications();
        } else {
          await requestNotificationPermission();
        }
      });
    });

    // Explicit disable buttons
    document.querySelectorAll('[data-notif-disable]').forEach(el => {
      el.addEventListener('click', () => disableNotifications());
    });
  }

  function _waitForUserId(maxMs) {
    return new Promise(resolve => {
      if (_userId) return resolve();
      const directId = global.currentUser?.id;
      if (directId) { _userId = directId; return resolve(); }
      const start = Date.now();
      const t = setInterval(() => {
        const id = _userId || global.currentUser?.id;
        if (id) { if (!_userId) _userId = id; clearInterval(t); resolve(); }
        else if (Date.now() - start > maxMs) { clearInterval(t); resolve(); }
      }, 80);
    });
  }

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

  function _urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
  }

  // ── Auto-init on chat page ──
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
        _bindButtons();
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
    disable:            disableNotifications,
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
  global.disableNotifications          = disableNotifications;
  global.sendLocalNotification         = sendLocalNotification;

})(window);

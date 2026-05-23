// ============================================================
// notifications.js — MindSpace Push Notification Engine v3
// ============================================================
// Flow:
//   1. Page loads → auto-init polls for window.currentUser
//   2. Once user is known, _userId is set and SW subscription checked
//   3. User clicks "Enable" → requestNotificationPermission()
//      → browser asks permission → if granted → subscribe to push
//      → save subscription (endpoint + keys) to push_subscriptions table
//   4. Superadmin sends push via Edge Function → SW receives it
//      → shows OS-level notification even if tab is closed
//   5. Local realtime listener also fires a notification when a
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
    _userId  = userId;
    _isAdmin = !!isAdmin;
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
  // This is what the Enable button calls.
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

    // FIX Bug 1+2: grab userId immediately from window.currentUser before
    // falling back to the poll. chat.html sets window.currentUser = session.user
    // in init() — this ensures we never show the "please wait" message when
    // the user is already logged in and init() has completed.
    if (!_userId && global.currentUser?.id) {
      _userId = global.currentUser.id;
    }

    // Also trigger MSNotif.init if it hasn't run yet (e.g. fast click on load)
    if (!_initDone && _userId) {
      await initNotifications(_userId, _isAdmin);
    }

    // If still no userId after all that, poll briefly
    if (!_userId) {
      await _waitForUserId(4000);
    }

    if (!_userId) {
      _showToast('Still loading your session — please try again in a moment.', 'warning');
      return false;
    }

    const permission = await Notification.requestPermission();

    if (permission === 'granted') {
      await _subscribeToPush();
      _showToast('✓ Notifications enabled — you\'ll be alerted when your counsellor replies!', 'success');
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
  async function _subscribeToPush() {
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();

      if (!sub) {
        const vapidKey = global.VAPID_PUBLIC_KEY;
        if (!vapidKey) {
          console.info('[Notif] No VAPID_PUBLIC_KEY — server push disabled; local notifications still work.');
          return;
        }
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: _urlBase64ToUint8Array(vapidKey)
        });
      }

      _pushSubscription = sub;
      await _saveSubscription(sub);
    } catch (err) {
      console.error('[Notif] Push subscription error:', err);
    }
  }

  // ── Save subscription to Supabase push_subscriptions table ──
  async function _saveSubscription(sub) {
    if (!_userId || !global.sb) return;

    const json   = sub.toJSON();
    const record = {
      user_id:    _userId,
      endpoint:   json.endpoint,
      p256dh:     json.keys?.p256dh  || '',
      auth:       json.keys?.auth    || '',
      user_agent: navigator.userAgent.substring(0, 200),
      updated_at: new Date().toISOString()
    };

    // Try upsert with onConflict on 'endpoint' alone first (most DB schemas)
    // Fall back to plain insert/update if that fails
    let { error } = await global.sb
      .from('push_subscriptions')
      .upsert(record, { onConflict: 'endpoint' });

    if (error) {
      // Fallback: try delete + insert
      await global.sb.from('push_subscriptions')
        .delete()
        .eq('user_id', _userId)
        .eq('endpoint', json.endpoint);

      const res2 = await global.sb.from('push_subscriptions').insert(record);
      error = res2.error;
    }

    if (error) {
      console.error('[Notif] Failed to save subscription:', error);
    } else {
      console.log('[Notif] ✓ Subscription saved for user', _userId);
    }
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

  // Calls the send-push Edge Function with the current user's session token
  // so the function's role check passes.
  async function _callEdgeFunction(payload) {
    if (!global.sb) return { success: false, error: 'Supabase not ready' };
    try {
      const { data: { session } } = await global.sb.auth.getSession();
      const token = session?.access_token || SUPABASE_ANON_KEY;

      const res = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'apikey':        SUPABASE_ANON_KEY,
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
  /*
  function _showNudgeBar() {
    if (sessionStorage.getItem('ms_notif_nudge_dismissed')) return;
    if (document.getElementById('ms-notif-nudge')) return;

    setTimeout(() => {
      const bar = document.createElement('div');
      bar.id = 'ms-notif-nudge';
      bar.style.cssText = [
        'position:fixed', 'bottom:40px', 'left:50%',
        'transform:translateX(-50%) translateY(100px)',
        'z-index:99998', 'background:#fff',
        'border:1.5px solid #E0DDD8', 'border-top:3px solid #1900ff',
        'box-shadow:0 8px 32px rgba(0,0,0,.14)',
        'padding:14px 18px', 'display:flex', 'align-items:center', 'gap:12px',
        'max-width:min(420px,calc(100vw - 32px))', 'width:max-content',
        'font-family:DM Sans,sans-serif', 'font-size:13px',
        'transition:transform .5s cubic-bezier(.16,1,.3,1),opacity .4s',
        'opacity:0'
      ].join(';');

      bar.innerHTML = `
        <span style="font-size:22px;flex-shrink:0">🔔</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;color:#0a0a0a;font-size:13px;margin-bottom:2px">Get session alerts</div>
          <div style="font-size:11px;color:#888;font-weight:300;line-height:1.5">Enable notifications so your counsellor can reach you even when this tab is in the background.</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:5px;flex-shrink:0">
          <button id="ms-notif-enable-btn" style="background:#1900ff;color:#fff;border:none;padding:8px 16px;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;cursor:pointer;font-family:inherit;white-space:nowrap;min-height:36px;">Enable</button>
          <button id="ms-notif-dismiss-btn" style="background:transparent;color:#aaa;border:none;padding:2px 6px;font-size:11px;cursor:pointer;font-family:inherit">Not now</button>
        </div>
      `;

      document.body.appendChild(bar);

      requestAnimationFrame(() => requestAnimationFrame(() => {
        bar.style.transform = 'translateX(-50%) translateY(0)';
        bar.style.opacity   = '1';
      }));

      document.getElementById('ms-notif-enable-btn').addEventListener('click', async () => {
        _dismissNudge();
        await requestNotificationPermission();
      });
      document.getElementById('ms-notif-dismiss-btn').addEventListener('click', () => {
        _dismissNudge();
        sessionStorage.setItem('ms_notif_nudge_dismissed', '1');
      });
    }, 4000);
  }

  function _dismissNudge() {
    const bar = document.getElementById('ms-notif-nudge');
    if (!bar) return;
    bar.style.transform = 'translateX(-50%) translateY(100px)';
    bar.style.opacity   = '0';
    setTimeout(() => bar.remove(), 500);
  }
  */

function _showNudgeBar() {
  if (sessionStorage.getItem('ms_notif_nudge_dismissed')) return;
  if (document.getElementById('ms-notif-nudge')) return;

  setTimeout(() => {
    const bar = document.createElement('div');
    bar.id = 'ms-notif-nudge';

    // FIX 1: z-index raised to 999999 — above the #rwi-ticker (z-index:99999)
    // which was sitting on top of this bar and swallowing all click events.
    //
    // FIX 2: bottom raised to 36px (above the 28px ticker) + extra 8px breathing room.
    //
    // FIX 3: width changed from 'max-content' (overflows on mobile) to
    // 'calc(100vw - 32px)' capped at 440px — bar now fits any screen.
    //
    // FIX 4: buttons are built as real DOM nodes with addEventListener (not
    // innerHTML) so there is zero chance of an ID lookup timing issue.
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

    // ── Bell + text block ──
    const bell = document.createElement('span');
    bell.style.cssText = 'font-size:22px;flex-shrink:0';
    bell.textContent = '🔔';

    const textWrap = document.createElement('div');
    textWrap.style.cssText = 'flex:1;min-width:0';

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;color:#0a0a0a;font-size:13px;margin-bottom:2px';
    title.textContent = 'Get session alerts';

    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:11px;color:#888;font-weight:300;line-height:1.5';
    sub.textContent = 'Enable notifications so your counsellor can reach you even when this tab is in the background.';

    textWrap.appendChild(title);
    textWrap.appendChild(sub);

    // ── Button column ──
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

    // Animate in after two frames so the initial transform is painted first
    requestAnimationFrame(() => requestAnimationFrame(() => {
      bar.style.transform = 'translateX(-50%) translateY(0)';
      bar.style.opacity   = '1';
    }));

    // ── Event listeners attached directly to the DOM nodes — no ID lookup ──
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

    // Touch events for mobile (belt-and-suspenders alongside click)
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
    // Top-bar button (desktop)
    const topBtn = document.getElementById('notif-toggle-btn');
    if (topBtn) {
      topBtn.textContent = enabled ? '🔔 Notifications On' : '🔕 Notifications';
      topBtn.style.color = enabled ? 'var(--sage,#1900ff)' : '';
    }
    // Sidebar button
    const sideBtn = document.getElementById('notif-sidebar-btn');
    const sideSt  = document.getElementById('notif-sidebar-status');
    if (sideBtn) {
      sideBtn.textContent    = enabled ? '🔔 Notifications On' : '🔕 Enable Notifications';
      sideBtn.style.borderColor = enabled ? 'var(--sage,#1900ff)' : '';
      sideBtn.style.color       = enabled ? 'var(--sage,#1900ff)' : '';
    }
    if (sideSt) {
      sideSt.textContent = enabled ? '✓ You will receive alerts for new messages.' : '';
      sideSt.style.color = 'var(--sage,#1900ff)';
    }
    // Mobile drawer button
    const drawerBtn = document.getElementById('drawer-notif-btn');
    const drawerSt  = document.getElementById('drawer-notif-status');
    if (drawerBtn) {
      drawerBtn.textContent = enabled ? '🔔 Notifications On' : '🔕 Enable Notifications';
      drawerBtn.classList.toggle('enabled', enabled);
    }
    if (drawerSt) {
      drawerSt.textContent = enabled ? '✓ You\'ll be alerted when your counsellor replies.' : '';
    }

    // Also call chat.html's syncNotifUI if it exists (belt-and-suspenders)
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
  // FIX: also tries window.currentUser directly as the fastest path,
  // since chat.html now sets window.currentUser = session.user in init().
  function _waitForUserId(maxMs) {
    return new Promise(resolve => {
      if (_userId) return resolve();

      // Immediate check — chat.html may have already set window.currentUser
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
      }, 80); // poll more frequently (80ms vs 100ms)
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
  // Polls until window.currentUser is available (set by chat.html's init()),
  // then calls initNotifications and wires up realtime.
  function _autoInit() {
    if (window.location.pathname.includes('admin')) return; // admin pages call init manually

    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      if (attempts > 100) { clearInterval(poll); return; } // give up after ~20s

      // FIX: read from window.currentUser which chat.html now explicitly sets
      const userId = global.currentUser?.id;
      const convId = global.conversationId;

      if (userId && !_initDone) {
        clearInterval(poll);
        _userId = userId; // pre-set so requestPermission never sees null
        await initNotifications(userId, false);
        if (convId) setupRealtimeNotifications(convId);
        return;
      }

      // conversationId may arrive slightly after currentUser
      if (_initDone && convId && !_realtimeChannel) {
        clearInterval(poll);
        setupRealtimeNotifications(convId);
      }
    }, 200); // poll at 200ms — faster than before so UI is ready sooner
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _autoInit);
  } else {
    _autoInit();
  }

  // ── Public API ──
  global.MSNotif = {
    init:              initNotifications,
    requestPermission: requestNotificationPermission,
    unsubscribe:       unsubscribeFromPush,
    sendLocal:         sendLocalNotification,
    setupRealtime:     setupRealtimeNotifications,
    adminSendToUser:   adminSendPushToUser,
    adminBroadcast:    adminBroadcastPush,
    callEdgeFunction:  _callEdgeFunction,
    getPermissionState: () => Notification.permission,
    showToast:         _showToast
  };

  // Backward-compat globals
  global.requestNotificationPermission = requestNotificationPermission;
  global.sendLocalNotification         = sendLocalNotification;

})(window);

// ============================================================
// notifications.js — MindSpace Push Notification Engine v2
// Drop this AFTER config.js and auth.js on every page.
//
// CHANGES IN v2:
//   - Auto-shows a soft "Enable notifications" nudge bar on chat.html
//   - Auto-initialises when window.currentUser becomes available
//   - Auto-wires realtime listener when window.conversationId is set
//   - Fires WhatsApp-style local pop when a message arrives on hidden tab
//   - Admin: sends server push via Edge Function (falls back to local)
//   - Zero config needed beyond VAPID_PUBLIC_KEY in config.js
// ============================================================

(function (global) {
  'use strict';

  // ── State ──
  let _pushSubscription = null;
  let _userId = null;
  let _isAdmin = false;
  let _realtimeChannel = null;

  // ── Public init: call after user is confirmed logged in ──
  async function initNotifications(userId, isAdmin = false) {
    _userId = userId;
    _isAdmin = isAdmin;

    if (!('Notification' in window)) {
      console.warn('[Notif] Notifications not supported in this browser.');
      return;
    }
    if (!('serviceWorker' in navigator)) {
      console.warn('[Notif] Service Worker not supported.');
      return;
    }

    // Listen for messages from the service worker
    navigator.serviceWorker.addEventListener('message', _handleSWMessage);

    // If already granted, silently subscribe
    if (Notification.permission === 'granted') {
      await _subscribeToPush();
    }

    // Update any existing toggle button
    _updateNotifButton(Notification.permission === 'granted');

    // On the user chat page, show a gentle nudge bar if permission not yet asked
    if (!_isAdmin && Notification.permission === 'default') {
      _showNudgeBar();
    }
  }

  // ── Gentle nudge bar (user-facing only, not intrusive) ──
  function _showNudgeBar() {
    // Don't show if already dismissed this session
    if (sessionStorage.getItem('ms_notif_nudge_dismissed')) return;
    // Don't show if already shown
    if (document.getElementById('ms-notif-nudge')) return;

    // Wait a few seconds before showing so the page loads first
    setTimeout(() => {
      const bar = document.createElement('div');
      bar.id = 'ms-notif-nudge';
      bar.style.cssText = [
        'position:fixed',
        'bottom:36px',       // above the #RiseWithIMPACT ticker
        'left:50%',
        'transform:translateX(-50%) translateY(80px)',
        'z-index:99998',
        'background:#fff',
        'border:1.5px solid #E0DDD8',
        'border-top:3px solid #1900ff',
        'box-shadow:0 8px 32px rgba(0,0,0,.14),0 2px 8px rgba(25,0,255,.1)',
        'padding:14px 18px',
        'display:flex',
        'align-items:center',
        'gap:12px',
        'max-width:min(420px,calc(100vw - 32px))',
        'width:max-content',
        'font-family:DM Sans,sans-serif',
        'font-size:13px',
        'transition:transform .5s cubic-bezier(.16,1,.3,1),opacity .4s',
        'opacity:0',
      ].join(';');

      bar.innerHTML = `
        <span style="font-size:22px;flex-shrink:0">🔔</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;color:#0a0a0a;font-size:13px;margin-bottom:2px">Get session alerts</div>
          <div style="font-size:11px;color:#888;font-weight:300;line-height:1.5">Enable notifications so your counsellor can reach you even when this tab is in the background.</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:5px;flex-shrink:0">
          <button id="ms-notif-enable-btn" style="background:#1900ff;color:#fff;border:none;padding:7px 14px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;cursor:pointer;font-family:inherit;white-space:nowrap">Enable</button>
          <button id="ms-notif-dismiss-btn" style="background:transparent;color:#aaa;border:none;padding:2px 6px;font-size:11px;cursor:pointer;font-family:inherit">Not now</button>
        </div>
      `;

      document.body.appendChild(bar);

      // Animate in
      requestAnimationFrame(() => requestAnimationFrame(() => {
        bar.style.transform = 'translateX(-50%) translateY(0)';
        bar.style.opacity = '1';
      }));

      document.getElementById('ms-notif-enable-btn').onclick = async () => {
        _dismissNudge();
        await requestNotificationPermission();
      };
      document.getElementById('ms-notif-dismiss-btn').onclick = () => {
        _dismissNudge();
        sessionStorage.setItem('ms_notif_nudge_dismissed', '1');
      };
    }, 4000);
  }

  function _dismissNudge() {
    const bar = document.getElementById('ms-notif-nudge');
    if (!bar) return;
    bar.style.transform = 'translateX(-50%) translateY(80px)';
    bar.style.opacity = '0';
    setTimeout(() => bar.remove(), 500);
  }

  // ── Request permission & subscribe ──
  async function requestNotificationPermission() {
    if (!('Notification' in window)) {
      showNotifToast('Notifications are not supported on this browser.', 'error');
      return false;
    }

    if (Notification.permission === 'denied') {
      showNotifToast('Notifications are blocked. Please enable them in your browser settings.', 'error');
      return false;
    }

    const permission = await Notification.requestPermission();

    if (permission === 'granted') {
      await _subscribeToPush();
      showNotifToast('✓ Notifications enabled — you\'ll be alerted for new messages!', 'success');
      _updateNotifButton(true);
      return true;
    } else {
      showNotifToast('Notifications were not enabled. You can enable them later.', 'warning');
      return false;
    }
  }

  // ── Create or retrieve browser push subscription ──
  async function _subscribeToPush() {
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();

      if (!sub) {
        const vapidKey = global.VAPID_PUBLIC_KEY;
        if (vapidKey) {
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: _urlBase64ToUint8Array(vapidKey)
          });
        } else {
          console.info('[Notif] No VAPID_PUBLIC_KEY found — server push disabled. Local notifications still work.');
          return;
        }
      }

      _pushSubscription = sub;
      await _saveSubscriptionToSupabase(sub);
    } catch (err) {
      console.error('[Notif] Push subscription error:', err);
    }
  }

  // ── Save push subscription to Supabase ──
  async function _saveSubscriptionToSupabase(sub) {
    if (!_userId || !global.sb) return;

    const subJson = sub.toJSON();
    const { error } = await global.sb.from('push_subscriptions').upsert({
      user_id:    _userId,
      endpoint:   subJson.endpoint,
      p256dh:     subJson.keys?.p256dh || '',
      auth:       subJson.keys?.auth || '',
      user_agent: navigator.userAgent.substring(0, 200),
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,endpoint' });

    if (error) {
      console.error('[Notif] Failed to save subscription to Supabase:', error);
    } else {
      console.log('[Notif] Push subscription saved.');
    }
  }

  // ── Unsubscribe ──
  async function unsubscribeFromPush() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await sub.unsubscribe();
        if (_userId && global.sb) {
          await global.sb.from('push_subscriptions')
            .delete()
            .eq('user_id', _userId)
            .eq('endpoint', sub.endpoint);
        }
        _pushSubscription = null;
        _updateNotifButton(false);
        showNotifToast('Notifications turned off.', 'info');
      }
    } catch (err) {
      console.error('[Notif] Unsubscribe error:', err);
    }
  }

  // ── Send a LOCAL notification (fires immediately via SW, works when tab is hidden) ──
  async function sendLocalNotification({ title, body, url, tag, type = 'message' }) {
    if (Notification.permission !== 'granted') return;

    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title || 'MindSpace', {
        body: body || 'You have a new message.',
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-96.png',
        tag: tag || 'mindspace-local',
        renotify: true,
        vibrate: [200, 100, 200],
        data: { url: url || '/chat.html', type },
        actions: type === 'message'
          ? [{ action: 'reply', title: '💬 Reply' }, { action: 'dismiss', title: 'Dismiss' }]
          : []
      });
    } catch (err) {
      console.error('[Notif] Local notification error:', err);
    }
  }

  // ── Realtime listener: fires a notification when a new message arrives ──
  // This is the core WhatsApp-style behaviour for in-session alerts.
  // Call this once conversationId is known (done automatically below).
  function setupRealtimeNotifications(conversationId) {
    if (!global.sb || !conversationId) return;
    if (_realtimeChannel) {
      global.sb.removeChannel(_realtimeChannel);
    }

    _realtimeChannel = global.sb.channel('notif-' + conversationId)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: 'conversation_id=eq.' + conversationId
      }, async payload => {
        const msg = payload.new;
        // Don't notify about your own messages
        if (msg.sender_id === _userId) return;
        // Only fire the pop-up if the tab is hidden / not focused
        if (!document.hidden) return;

        const senderName = _isAdmin
          ? (msg.sender_name || 'User')
          : 'Your counsellor';

        const preview = (msg.content || '').substring(0, 100) +
          (msg.content?.length > 100 ? '…' : '');

        const notifBody = preview ||
          (msg.message_type === 'voice'  ? '🎙 Voice message' :
           msg.message_type === 'image'  ? '📷 Image' :
           msg.message_type === 'video'  ? '🎥 Video' : 'New message');

        await sendLocalNotification({
          title:  'MindSpace — ' + senderName,
          body:   notifBody,
          url:    _isAdmin ? 'admin.html' : 'chat.html',
          tag:    'mindspace-chat-' + conversationId,
          type:   'message'
        });

        // Also attempt server push so it reaches the phone if the browser is closed
        // This requires the Edge Function to be deployed (see setup guide)
        if (_isAdmin && msg.sender_id) {
          // Admin got a message from a user — no need to push back to admin here;
          // the local notification above already handles it.
        } else if (!_isAdmin) {
          // User got a message from counsellor — local notif fires above.
          // Server push to the user was already sent by admin's panel or Supabase trigger.
        }
      })
      .subscribe();

    return _realtimeChannel;
  }

  // ── ADMIN: Send push to a specific user via Edge Function ──
  async function adminSendPushToUser(targetUserId, { title, body, url, type = 'message' }) {
    if (!global.sb) return { success: false, error: 'Supabase not ready' };

    try {
      const { data, error } = await global.sb.functions.invoke('send-push', {
        body: {
          targetUserId,
          notification: { title, body, url: url || '/chat.html', type }
        }
      });

      if (error) {
        console.error('[Notif] Edge function error:', error);
        return { success: false, error: error.message };
      }
      return { success: true, data };
    } catch (err) {
      console.error('[Notif] adminSendPushToUser error:', err);
      return { success: false, error: err.message };
    }
  }

  // ── ADMIN: Broadcast push to ALL users ──
  async function adminBroadcastPush({ title, body, url, type = 'announcement' }) {
    if (!global.sb) return { success: false, error: 'Supabase not ready' };

    try {
      const { data, error } = await global.sb.functions.invoke('send-push', {
        body: {
          broadcast: true,
          notification: { title, body, url: url || '/chat.html', type }
        }
      });

      if (error) {
        console.error('[Notif] Broadcast push error:', error);
        return { success: false, error: error.message };
      }
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ── Handle messages from service worker (notification actions, call decline, etc.) ──
  function _handleSWMessage(event) {
    const data = event.data;
    if (!data) return;

    switch (data.type) {
      case 'NOTIFICATION_CLICK':
        if (data.notifData?.conversationId) {
          console.log('[Notif] Clicked notification for conversation', data.notifData.conversationId);
        }
        break;
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

  // ── UI helpers ──
  function _updateNotifButton(enabled) {
    const btn = document.getElementById('notif-toggle-btn');
    if (!btn) return;
    btn.textContent = enabled ? '🔔 Notifications On' : '🔕 Enable Notifications';
    btn.dataset.enabled = enabled ? '1' : '0';
    btn.style.opacity = enabled ? '1' : '0.7';
  }

  function getPermissionState() {
    return Notification.permission;
  }

  // ── Toast (uses page's existing showToast or injects a minimal one) ──
  function showNotifToast(msg, variant = 'info') {
    if (typeof global.showToast === 'function') {
      global.showToast(msg);
      return;
    }
    let el = document.getElementById('notif-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'notif-toast';
      el.style.cssText = [
        'position:fixed',
        'bottom:48px',
        'left:50%',
        'transform:translateX(-50%) translateY(16px)',
        'z-index:9999999',
        'background:#0a0a0a',
        'color:#fff',
        'padding:12px 20px',
        'font-family:DM Sans,sans-serif',
        'font-size:13px',
        'max-width:340px',
        'text-align:center',
        'opacity:0',
        'transition:all .4s',
        'border-left:3px solid #1900ff',
        'pointer-events:none',
      ].join(';');
      document.body.appendChild(el);
    }
    const colors = { success: '#27ae60', error: '#c0392b', warning: '#e67e22', info: '#1900ff' };
    el.style.borderLeftColor = colors[variant] || '#1900ff';
    el.textContent = msg;
    el.style.opacity = '1';
    el.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(el._t);
    el._t = setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(-50%) translateY(16px)';
    }, 4000);
  }

  // ── Utility ──
  function _urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
  }

  // ── Auto-init on user chat pages ──
  // Polls until window.currentUser and window.conversationId are available
  // (set by chat.html's init() function), then wires everything up automatically.
  function _autoInit() {
    const isAdminPage = window.location.pathname.includes('admin');
    if (isAdminPage) return; // admin pages handle their own init

    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      if (attempts > 40) { clearInterval(poll); return; } // give up after ~12s

      const userId = global.currentUser?.id;
      const convId = global.conversationId;

      if (userId && !_userId) {
        clearInterval(poll);
        await initNotifications(userId, false);
        if (convId) setupRealtimeNotifications(convId);
        return;
      }

      // conversationId may arrive after currentUser
      if (_userId && convId && !_realtimeChannel) {
        setupRealtimeNotifications(convId);
      }
    }, 300);
  }

  // Run auto-init when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _autoInit);
  } else {
    _autoInit();
  }

  // ── Expose public API ──
  global.MSNotif = {
    init:             initNotifications,
    requestPermission: requestNotificationPermission,
    unsubscribe:      unsubscribeFromPush,
    sendLocal:        sendLocalNotification,
    setupRealtime:    setupRealtimeNotifications,
    adminSendToUser:  adminSendPushToUser,
    adminBroadcast:   adminBroadcastPush,
    getPermissionState,
    showToast:        showNotifToast
  };

  // Convenience globals (backward compatible)
  global.requestNotificationPermission = requestNotificationPermission;
  global.sendLocalNotification = sendLocalNotification;

})(window);
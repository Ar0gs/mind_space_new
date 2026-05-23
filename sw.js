// ============================================================
// sw.js — MindSpace Service Worker v2
// Cache-first for assets · Network-first for API
// Full WhatsApp-style push notification support
// ============================================================

const CACHE_NAME = 'mindspace-v2';
const CACHE_VERSION = 2;

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/chat.html',
  '/admin.html',
  '/superadmin.html',
  '/config.js',
  '/auth.js',
  '/webrtc.js',
  '/notifications.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/offline.html',
  'https://fonts.googleapis.com/css2?family=Anton&family=DM+Sans:ital,wght@0,300;0,400;0,500;0,700;1,300&family=DM+Mono:wght@300;400;500&display=swap'
];

// ── INSTALL ──
self.addEventListener('install', event => {
  console.log('[SW] Installing MindSpace v' + CACHE_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE_URLS).catch(err => {
        console.warn('[SW] Pre-cache partial failure (non-fatal):', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ──
self.addEventListener('activate', event => {
  console.log('[SW] Activating v' + CACHE_VERSION);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => {
          console.log('[SW] Deleting old cache:', k);
          return caches.delete(k);
        })
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.hostname.includes('supabase.co')) return;
  if (!url.protocol.startsWith('http')) return;

  if (event.request.headers.get('accept')?.includes('text/html') || url.pathname.endsWith('.html')) {
    event.respondWith(networkFirst(event.request));
    return;
  }
  if (url.hostname.includes('fonts.gstatic.com') ||
      url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('cdn.jsdelivr.net')) {
    event.respondWith(cacheFirst(event.request));
    return;
  }
  if (url.pathname.match(/\.(js|css|png|jpg|jpeg|svg|ico|webp|woff2?)$/)) {
    event.respondWith(staleWhileRevalidate(event.request));
    return;
  }
  event.respondWith(networkFirst(event.request));
});

// ── CACHE STRATEGIES ──
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return caches.match('/offline.html');
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || caches.match('/offline.html');
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  return cached || fetchPromise;
}

// ── PUSH NOTIFICATIONS ──
// Handles incoming push events from Supabase Edge Functions or your backend
// Payload shape: { title, body, icon, url, tag, senderName, type }
self.addEventListener('push', event => {
  if (!event.data) return;

  let data = {};
  try { data = event.data.json(); }
  catch { data = { title: 'MindSpace', body: event.data.text() }; }

  const type = data.type || 'message'; // 'message' | 'call' | 'announcement'

  // Build notification options based on type
  let options = {};

  if (type === 'message') {
    options = {
      body: data.body || 'You have a new message from your counsellor.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-96.png',
      tag: 'mindspace-chat-' + (data.conversationId || 'main'), // group per conversation
      renotify: true,          // vibrate even if same tag (like WhatsApp)
      requireInteraction: false,
      silent: false,
      vibrate: [200, 100, 200, 100, 200],
      timestamp: data.timestamp || Date.now(),
      data: {
        url: data.url || '/chat.html',
        type: 'message',
        conversationId: data.conversationId,
        senderId: data.senderId
      },
      actions: [
        { action: 'reply',   title: '💬 Reply' },
        { action: 'dismiss', title: 'Dismiss' }
      ]
    };
  } else if (type === 'call') {
    options = {
      body: data.body || (data.senderName || 'Your counsellor') + ' is calling you.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-96.png',
      tag: 'mindspace-call',
      renotify: true,
      requireInteraction: true,  // stay on screen until user acts (like incoming calls)
      silent: false,
      vibrate: [500, 200, 500, 200, 500, 200, 500],
      data: { url: data.url || '/chat.html', type: 'call' },
      actions: [
        { action: 'accept',  title: '📞 Accept' },
        { action: 'decline', title: '❌ Decline' }
      ]
    };
  } else {
    // announcement / general
    options = {
      body: data.body || 'You have a notification from MindSpace.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-96.png',
      tag: 'mindspace-announcement',
      renotify: false,
      requireInteraction: false,
      silent: false,
      vibrate: [200, 100, 200],
      data: { url: data.url || '/chat.html', type: 'announcement' }
    };
  }

  const title = data.title || 'MindSpace';

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ── NOTIFICATION CLICK ──
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const notifData = event.notification.data || {};
  const action = event.action;
  const type = notifData.type || 'message';

  // Handle action buttons
  if (action === 'dismiss') return;
  if (action === 'decline') {
    // Post message to all clients to decline the call
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
        clientList.forEach(c => c.postMessage({ type: 'DECLINE_CALL' }));
      })
    );
    return;
  }

  const targetUrl = notifData.url || '/chat.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Focus existing window if possible
      for (const client of clientList) {
        if (client.url.includes('chat.html') && 'focus' in client) {
          client.focus();
          // Tell the page what notification was clicked
          client.postMessage({ type: 'NOTIFICATION_CLICK', action, notifData });
          return;
        }
      }
      // Otherwise open a new window
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

// ── NOTIFICATION CLOSE ──
// Fires when user swipes away the notification without clicking
self.addEventListener('notificationclose', event => {
  const notifData = event.notification.data || {};
  // Optionally: track dismiss analytics here
  console.log('[SW] Notification dismissed:', event.notification.tag);
});

// ── PUSH SUBSCRIPTION CHANGE ──
// Fires when browser rotates the push subscription — re-register with your server
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil(
    self.registration.pushManager.subscribe(event.oldSubscription.options)
      .then(newSub => {
        // Post to all clients so they can update Supabase with the new subscription
        return clients.matchAll({ type: 'window' }).then(clientList => {
          clientList.forEach(c => c.postMessage({
            type: 'PUSH_SUBSCRIPTION_CHANGED',
            subscription: newSub.toJSON()
          }));
        });
      })
  );
});

// ── BACKGROUND SYNC ──
self.addEventListener('sync', event => {
  if (event.tag === 'sync-messages') {
    event.waitUntil(
      clients.matchAll({ type: 'window' }).then(clientList => {
        clientList.forEach(c => c.postMessage({ type: 'SYNC_MESSAGES' }));
      })
    );
  }
});

// ── MESSAGE FROM PAGE ──
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ============================================================
// sw.js — MindSpace Service Worker
// Cache-first for assets, network-first for API/realtime
// ============================================================

const CACHE_NAME = 'mindspace-v1';
const CACHE_VERSION = 1;

// Assets to pre-cache on install
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/chat.html',
  '/admin.html',
  '/superadmin.html',
  '/config.js',
  '/auth.js',
  '/webrtc.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/offline.html',
  // Google Fonts (cached on first load)
  'https://fonts.googleapis.com/css2?family=Anton&family=DM+Sans:ital,wght@0,300;0,400;0,500;0,700;1,300&family=DM+Mono:wght@300;400;500&display=swap',
  'https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap'
];

// ── INSTALL: pre-cache all shell assets ──
self.addEventListener('install', event => {
  console.log('[SW] Installing MindSpace Service Worker v' + CACHE_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE_URLS).catch(err => {
        // Non-fatal: some URLs may not exist yet
        console.warn('[SW] Pre-cache partial failure (non-fatal):', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: clean old caches ──
self.addEventListener('activate', event => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: routing strategy ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. Skip non-GET requests (POST, etc.)
  if (event.request.method !== 'GET') return;

  // 2. Skip Supabase API & Realtime — always network (live chat must be fresh)
  if (url.hostname.includes('supabase.co')) return;

  // 3. Skip chrome-extension and non-http requests
  if (!url.protocol.startsWith('http')) return;

  // 4. HTML pages — Network-first (so users always get latest version)
  if (event.request.headers.get('accept')?.includes('text/html') || url.pathname.endsWith('.html')) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // 5. Google Fonts, CDN assets — Cache-first (stable, long-lived)
  if (url.hostname.includes('fonts.gstatic.com') ||
      url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('cdn.jsdelivr.net')) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // 6. App JS/CSS/icons — Stale-while-revalidate
  if (url.pathname.match(/\.(js|css|png|jpg|jpeg|svg|ico|webp|woff2?)$/)) {
    event.respondWith(staleWhileRevalidate(event.request));
    return;
  }

  // 7. Everything else — Network-first with cache fallback
  event.respondWith(networkFirst(event.request));
});

// ── STRATEGIES ──

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
self.addEventListener('push', event => {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); } catch { data = { title: 'MindSpace', body: event.data.text() }; }

  const options = {
    body: data.body || 'You have a new message from your counsellor.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    tag: 'mindspace-msg',
    renotify: true,
    requireInteraction: false,
    vibrate: [200, 100, 200],
    data: { url: data.url || '/chat.html' },
    actions: [
      { action: 'open', title: 'Open Chat' },
      { action: 'dismiss', title: 'Dismiss' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'MindSpace', options)
  );
});

// ── NOTIFICATION CLICK ──
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const targetUrl = event.notification.data?.url || '/chat.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(targetUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

// ── BACKGROUND SYNC (for offline message queue) ──
self.addEventListener('sync', event => {
  if (event.tag === 'sync-messages') {
    event.waitUntil(syncOfflineMessages());
  }
});

async function syncOfflineMessages() {
  // Notify all open clients to retry sending queued messages
  const allClients = await clients.matchAll({ type: 'window' });
  allClients.forEach(client => client.postMessage({ type: 'SYNC_MESSAGES' }));
}

/* domar portal service worker (spec §9). Offline shell only: no API response is ever cached. */
const CACHE = 'domar-portal-v1';
const OFFLINE = '/portal/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, '/icon.svg'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/**
 * Navigations only, and only same-origin ones. `/api` is never touched: an owner's invoice must
 * come from the server behind their session, never from a cache this worker controls.
 */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api')) return;
  event.respondWith(fetch(req).catch(() => caches.open(CACHE).then((c) => c.match(OFFLINE))));
});

/** Spec §11: the payload carries a title and a link, so that is all the notification can show. */
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = payload.title || 'domar';
  const link = payload.link || '/portal';
  event.waitUntil(self.registration.showNotification(title, {
    body: '',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: payload.id || link,
    data: { link },
  }));
});

self.addEventListener('notificationclick', (event) => {
  const link = (event.notification.data && event.notification.data.link) || '/portal';
  event.notification.close();
  // Focus an open portal tab if there is one, so a tap does not pile up windows.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if (new URL(w.url).pathname.startsWith('/portal')) {
          w.navigate(link);
          return w.focus();
        }
      }
      return self.clients.openWindow(link);
    }),
  );
});

// Envelo service worker: keeps the app and the last loaded budget available
// without a connection. Everything is fetched from the network first, so
// updates show up straight away; the copy is only used when offline.
// (Browsers only run service workers over HTTPS or on localhost.)

const CACHE = 'envelo-0.3.0-beta.3';
const SHELL = [
  '/', '/manifest.webmanifest',
  '/src/styles.css', '/src/app.js', '/src/budget.js', '/src/loans.js', '/src/bank-csv.js', '/src/charts.js',
  '/src/sounds.js', '/src/vendor/qrcode.js',
  '/src/brand/logo.svg', '/src/brand/favicon.svg', '/src/brand/icon-192.png',
  '/src/fonts/dm-serif-display-latin-400-normal.woff2', '/src/fonts/dm-serif-display-latin-400-italic.woff2',
  '/src/fonts/space-grotesk-latin-500-normal.woff2', '/src/fonts/space-grotesk-latin-700-normal.woff2',
];
// API reads that are useful offline. Never the live event stream.
const CACHED_API = ['/api/me', '/api/budget', '/api/version', '/api/shares'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const isApi = url.pathname.startsWith('/api/');
  if (isApi && !CACHED_API.includes(url.pathname)) return;
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(isApi ? url.pathname : req, copy));
      }
      // Signed out: forget the cached budget.
      if (isApi && res.status === 401) caches.open(CACHE).then((c) => Promise.all(CACHED_API.map((p) => c.delete(p))));
      return res;
    } catch (err) {
      const hit = await caches.match(isApi ? url.pathname : req, { ignoreSearch: !isApi });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await caches.match('/');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});

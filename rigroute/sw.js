// RigRoute service worker: always checks the network first (bypassing the browser cache) so updates
// arrive straight away; the last good copy still opens without signal. Live data is never cached here.
const CACHE = 'rigroute-shell-v8';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'img/icon-192.png', 'img/logo-mark.png', 'img/logo-full.png', 'js/vendor/leaflet.js', 'js/vendor/leaflet.css', 'js/vendor/Leaflet.GoogleMutant.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => fetch(u, { cache: 'reload' }).then(r => r.ok && c.put(u, r))))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // map tiles, Main Roads and Google go straight to the network
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request).then(m => m || (e.request.mode === 'navigate' ? caches.match('index.html') : undefined))));
});

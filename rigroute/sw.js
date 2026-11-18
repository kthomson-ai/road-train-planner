// RigRoute service worker: network-first for the app shell, so updates arrive straight away
// and the last version still opens without signal. Live data is never cached here.
const CACHE = 'rigroute-shell-v2';
const SHELL = ['./', 'index.html', 'css/rigroute.css', 'js/core.js', 'js/nav.js', 'js/services/config.js', 'js/services/store.js', 'js/services/mainroads.js', 'js/services/google.js', 'js/services/vehicles.js', 'js/services/routing.js', 'js/services/alerts.js', 'js/ui/icons.js', 'js/ui/map.js', 'js/ui/app.js', 'img/icon-192.png', 'manifest.webmanifest'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // map tiles, Main Roads and Google go straight to the network
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request).then(m => m || caches.match('index.html'))));
});

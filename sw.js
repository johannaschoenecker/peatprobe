// PeatProbe service worker.
//
// Scope: the app shell only. Map tiles are deliberately NOT handled here -
// they live in IndexedDB via the field-pack system, which gives us per-fire
// download, progress, and deletion that a cache-everything worker cannot.

const VERSION = 'peatprobe-v9';

const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/config.js',
  'js/db.js',
  'js/geo.js',
  'js/info.js',
  'js/map.js',
  'js/packs.js',
  'js/sync.js',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
  'vendor/markercluster/leaflet.markercluster.js',
  'vendor/markercluster/MarkerCluster.css',
  'vendor/markercluster/MarkerCluster.Default.css',
  'icons/logo.svg',
  'manifest.webmanifest',
  'data/fires-index.geojson',
  'data/dnbr/index.json',
  'data/dnbr/stats.json',
  'js/chart.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // addAll is all-or-nothing; add individually so one missing optional
      // file cannot brick the whole install.
      //
      // cache:'reload' bypasses the browser's HTTP cache. Without it a new
      // service worker version happily fills its fresh cache with STALE copies
      // the HTTP cache already held, and a deploy silently ships old
      // JavaScript to everyone.
      .then(c => Promise.all(
        SHELL.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {}))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // tiles, Firebase, fonts: straight to network

  // Cache-first: the shell rarely changes and must work with no signal.
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) {
        // Refresh in the background so an update lands next launch.
        fetch(req).then(res => {
          if (res && res.ok) caches.open(VERSION).then(c => c.put(req, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match('index.html'));
    })
  );
});

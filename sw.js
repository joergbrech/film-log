/* Film Log service worker: keeps the app shell available offline.
   Cached files are served first and refreshed in the background, so an update
   shows up the second time the app is opened. Bump CACHE with every release. */
const CACHE = "film-log-1.0.3";
const SHELL = ["./", "index.html", "docs.html", "app.css", "app.js", "store.js", "sync.js", "manifest.webmanifest",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png",
  "fonts/familjen-grotesk-latin-400-normal.woff2", "fonts/familjen-grotesk-latin-500-normal.woff2",
  "fonts/familjen-grotesk-latin-600-normal.woff2", "fonts/familjen-grotesk-latin-700-normal.woff2",
  "fonts/jetbrains-mono-latin-400-normal.woff2", "fonts/jetbrains-mono-latin-600-normal.woff2"];

self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("film-log-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;   // GitHub API calls go straight to the network
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then(r => { if (r.ok) cache.put(e.request, r.clone()); return r; });
    if (hit) { fresh.catch(() => {}); return hit; }
    return fresh;
  }));
});

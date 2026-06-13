// Aggressive update-friendly service worker.
// - skipWaiting + clients.claim → new SW takes over immediately on next page load
// - Tells open pages to reload when activate fires (no manual cache busting)
// - network-first for /, /index.html, /sw.js → so updates are picked up fast
// - cache-first for static assets only
const SHELL = 'triibe-shell-v176';
const ALWAYS_LIVE = new Set(['/', '/index.html', '/sw.js', '/manifest.webmanifest']);

self.addEventListener('install', e => {
  // Don't wait for old SW to die — take over right away.
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k)));
    await self.clients.claim();
    // Force open clients (Dock app, browser tabs) to reload with new code.
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const c of clients) c.postMessage({ type: 'SW_UPDATED', shell: SHELL });
  })());
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return; // always live (no caching)
  // For HTML + sw.js: network first, fall back to cache (catches updates fast).
  if (ALWAYS_LIVE.has(url.pathname)) {
    e.respondWith(
      fetch(e.request).then(r => {
        const copy = r.clone();
        caches.open(SHELL).then(c => c.put(e.request, copy)).catch(()=>{});
        return r;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  // Other static (icon, etc.) — cache first.
  e.respondWith(caches.match(e.request).then(c => c || fetch(e.request)));
});

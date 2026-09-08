// Minimal service worker -- exists mainly to satisfy PWA installability
// (Chrome/Android's "Install app" prompt requires a registered service
// worker with a fetch handler; iOS's manual "Add to Home Screen" doesn't
// strictly need one, but gets the same offline-shell benefit from it).
//
// Deliberately does NOT cache app.js/style.css or anything from the
// Cloudflare Worker relay -- those two files already have their own
// cache-busting (?v=N query strings in index.html) and the relay is live
// game/auth data that must never be served stale, so a second caching
// layer here would just fight both. The only thing ever cached is the
// page shell itself (index.html), network-first so a live connection
// always wins, falling back to the last cached copy only when actually
// offline.
const SHELL_CACHE = "shell-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

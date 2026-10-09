const CACHE = "radar-mobile-v3";
const SHELL = ["./","./index.html","./pair.html","./mobile.css","./mobile.js","./manifest.webmanifest","./icon.svg"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(request).then(response => {
      const clone = response.clone();
      caches.open(CACHE).then(cache => cache.put(request, clone)).catch(() => {});
      return response;
    }).catch(() => caches.match(request).then(hit => hit || caches.match("./index.html")))
  );
});

const CACHE = "radar-mobile-v6";
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
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/bridge/")) return;
  event.respondWith(
    fetch(request).then(response => {
      const clone = response.clone();
      caches.open(CACHE).then(cache => cache.put(request, clone)).catch(() => {});
      return response;
    }).catch(() => caches.match(request).then(hit => hit || caches.match("./index.html")))
  );
});

self.addEventListener("push", event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {
      title: "Radar 2.0",
      body: event.data ? event.data.text() : "",
    };
  }

  const title = payload.title || "Radar 2.0";
  const target = new URL(
    payload.url || "./",
    self.location.origin,
  ).href;

  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "",
      tag: payload.tag || "radar-alert",
      renotify: true,
      icon: new URL("./icon.svg", self.location.href).href,
      data: {
        url: target,
        kind: payload.kind || null,
        listing_id: payload.listing_id || null,
        radar_id: payload.radar_id || null,
      },
    }),
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target =
    event.notification.data?.url ||
    new URL("./", self.location.origin).href;

  event.waitUntil(
    clients
      .matchAll({
        type: "window",
        includeUncontrolled: true,
      })
      .then(async windows => {
        const targetUrl = new URL(target);
        const sameOrigin = windows.find(windowClient => {
          try {
            return (
              new URL(windowClient.url).origin ===
              targetUrl.origin
            );
          } catch {
            return false;
          }
        });

        if (sameOrigin) {
          if ("navigate" in sameOrigin) {
            await sameOrigin.navigate(target).catch(() => {});
          }
          return sameOrigin.focus();
        }

        return clients.openWindow(target);
      }),
  );
});

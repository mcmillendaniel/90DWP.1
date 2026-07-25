/* Service Worker: offline + push handling */
const CACHE_NAME = "90dwp-v8";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll([
      "./",
      "./index.html",
      "./styles.css",
      "./app.js",
      "./manifest.webmanifest"
    ]))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const title = data.title || "90DWP";
  const body = data.body || "Check in.";
  const url = data.url || "./index.html";
  const tag = data.tag || "90dwp";
  const actions = data.actions || [];
  event.waitUntil(
    self.registration.showNotification(title, {
      body, tag, data: { url, ...data }, actions,
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png"
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "./index.html";
  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: "window", includeUncontrolled: true });
    // Match on scope, not on "index.html" — the PWA launches at the directory
    // root, so the old check never matched and opened a duplicate window.
    const scope = self.registration.scope;
    for (const c of allClients) {
      if (c.url.startsWith(scope)) {
        await c.focus();
        c.postMessage({ type: "NOTIF_ACTION", action: event.action || "open", data: event.notification.data || {} });
        return;
      }
    }
    await clients.openWindow(url);
  })());
});

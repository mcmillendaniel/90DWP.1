/* Service Worker: offline + push handling */

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open("90dwp-v2").then((cache) => cache.addAll([
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
  event.waitUntil(self.clients.claim());
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
      body,
      tag,
      data: { url, ...data },
      actions
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "./index.html";
  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of allClients) {
      if (c.url.includes("index.html")) {
        c.focus();
        c.postMessage({ type: "NOTIF_ACTION", action: event.action || "open", data: event.notification.data || {} });
        return;
      }
    }
    const newClient = await clients.openWindow(url);
    if (newClient) {
      // best-effort
    }
  })());
});

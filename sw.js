/*
 * Service worker: offline shell + push handling.
 *
 * Caching is network-first (with a short timeout) for app code, so a deploy is
 * picked up on the next launch without bumping CACHE_NAME by hand. The previous
 * cache-first version served stale JS indefinitely, which is why every deploy
 * needed a manual version bump to take effect.
 */
const CACHE_NAME = "90dwp-v12";
const NETWORK_TIMEOUT_MS = 3000;

const PRECACHE = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./js/config.js",
  "./js/dom.js",
  "./js/uid.js",
  "./js/version.js",
  "./js/state.js",
  "./js/push.js",
  "./js/wake.js",
  "./js/timepicker.js",
  "./js/views.js",
  "./js/backup.js",
  "./js/ui.js",
  "./js/reminders/recur.js",
  "./js/reminders/parse.js",
  "./js/reminders/schema.js",
  "./js/reminders/model.js",
  "./js/reminders/schedule.js",
  "./js/reminders/nav.js",
  "./js/reminders/views.js",
  "./js/reminders/actions.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // Individual adds so one bad URL cannot fail the entire install.
      .then((cache) => Promise.all(
        PRECACHE.map((url) => cache.add(url).catch((e) => console.warn("[sw] precache miss", url, e)))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** Code and markup: always prefer the network so deploys land immediately. */
function isAppCode(url, request){
  return request.mode === "navigate" || /\.(html|css|js|webmanifest)$/.test(url.pathname);
}

async function networkFirst(request){
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  // Never rejects, so a failed fetch cannot produce an unhandled rejection
  // while it keeps running in the background after a timeout.
  const network = fetch(request)
    .then((res) => {
      if(res && res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);

  if(!cached){
    const res = await network;
    return res || offlineFallback(request, cache);
  }

  // With a cached copy in hand, don't let a slow network stall the launch:
  // serve the cache after the timeout while the fetch continues and refreshes
  // the cache for next time.
  const res = await Promise.race([
    network,
    new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS))
  ]);
  return res || cached;
}

/** Icons and other static assets: cache-first is fine, they rarely change. */
async function cacheFirst(request){
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if(cached) return cached;
  try {
    const res = await fetch(request);
    if(res && res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    return offlineFallback(request, cache);
  }
}

async function offlineFallback(request, cache){
  if(request.mode === "navigate"){
    const shell = await cache.match("./index.html");
    if(shell) return shell;
  }
  return new Response("Offline and not cached.", {
    status: 503,
    headers: { "Content-Type": "text/plain" }
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if(request.method !== "GET") return;

  const url = new URL(request.url);
  // Never intercept the push worker API — those calls must always hit the
  // network and must never be served from or written to the cache.
  if(url.origin !== self.location.origin) return;

  event.respondWith(isAppCode(url, request) ? networkFirst(request) : cacheFirst(request));
});

// Lets the page report which cache it is actually being served from, so a
// mixed build shows up in Settings instead of as a tab that renders the wrong
// screen.
self.addEventListener("message", (event) => {
  if(event.data?.type !== "GET_VERSION") return;
  event.ports?.[0]?.postMessage({ cache: CACHE_NAME });
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
    // root, so an index.html check never matched and opened a duplicate window.
    const scope = self.registration.scope;
    for(const c of allClients){
      if(c.url.startsWith(scope)){
        await c.focus();
        c.postMessage({ type: "NOTIF_ACTION", action: event.action || "open", data: event.notification.data || {} });
        return;
      }
    }
    await clients.openWindow(url);
  })());
});

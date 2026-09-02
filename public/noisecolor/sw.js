const VERSION = "0.6.4";
const CACHE_NAME = `noisecolor-shell-${VERSION}`;
const SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=0.6.4",
  "./app.js?v=0.6.4",
  "./analysis-engine.js?v=0.6.4",
  "./analysis-worker.js?v=0.6.4",
  "./audio-worklet.js?v=0.6.4",
  "./live-state.js?v=0.6.4",
  "./live-runtime.js?v=0.6.4",
  "./history.js?v=0.6.4",
  "./upload-safety.js?v=0.6.4",
  "./pwa.js?v=0.6.4",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("noisecolor-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key)))),
    self.clients.claim(),
  ]));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(new URL("./", self.location).pathname)) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put("./", response.clone());
      }
      return response;
    }).catch(() => caches.match("./")));
    return;
  }
  event.respondWith(caches.open(CACHE_NAME).then(async (cache) => {
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  }));
});

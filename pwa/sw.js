const CACHE = "pferdedecke-v7"; // bump to invalidate after adding local TF.js
const ASSETS = [
  "/pwa/",
  "/pwa/index.html",
  "/pwa/styles.css",
  "/pwa/app.js",
  "/pwa/vendor/tf.min.js",
  "/pwa/manifest.json",
  // Icons sind optional/Platzhalter; falls vorhanden, werden sie gecached
  "/pwa/icons/icon-192.png",
  "/pwa/icons/icon-512.png",
  "/pwa/icons/apple-touch-icon-180.png",
  "/pwa/icons/Logo.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => Promise.resolve())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  e.respondWith(
    caches.match(request).then((r) => r || fetch(request).then((resp) => {
      const url = new URL(request.url);
      if (url.origin === location.origin) {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
      }
      return resp;
    }).catch(() => caches.match("/pwa/index.html")))
  );
});

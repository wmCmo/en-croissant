// Network first (so a new pack or app version arrives when online), cache
// fallback (so everything works on the plane). The API is never cached.
const CACHE = "offline-puzzles-v5";
const ASSETS = ["./", "index.html", "app.js", "manifest.webmanifest", "pieces.css", "rules.js", "icon-192.png", "icon-512.png", "pack.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin || url.pathname.includes("/api/")) return;
  // authorised calls (relay /whoami, /state) go straight to the network with their headers
  if (event.request.headers.has("authorization")) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        // revalidate, never the HTTP cache: a stale index.html beside a new app.js breaks the page
        const res = await fetch(event.request.url, { cache: "no-cache", signal: controller.signal });
        clearTimeout(timer);
        if (res.ok) cache.put(event.request, res.clone());
        return res;
      } catch {
        const hit = await cache.match(event.request, { ignoreSearch: true });
        return hit ?? (await cache.match("index.html")) ?? Response.error();
      }
    })(),
  );
});

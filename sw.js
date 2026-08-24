const CACHE_NAME = "cgo-music-pwa-v17-white-transport-icons";

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/styles.css",
  "./js/config.js",
  "./js/app.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./data/catalogs.json",
  "./data/ingles/50s.json",
  "./data/ingles/60s.json",
  "./data/ingles/70s.json",
  "./data/ingles/80s.json",
  "./data/ingles/90s.json",
  "./data/ingles/2000s.json",
  "./data/espanol/50s.json",
  "./data/espanol/60s.json",
  "./data/espanol/70s.json",
  "./data/espanol/80s.json",
  "./data/espanol/90s.json",
  "./data/espanol/2000s.json"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // No guardamos archivos de audio en Cache Storage. Pueden ser muy grandes y
  // los navegadores móviles suelen solicitar audio mediante peticiones Range.
  const isAudioRequest =
    request.destination === "audio" ||
    /\.(mp3|m4a|aac|ogg|oga|wav|flac|opus)(?:$|\?)/i.test(url.pathname) ||
    request.headers.has("range");

  if (isAudioRequest) {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    try {
      const response = await fetch(request);
      if (response && response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;

      if (request.mode === "navigate") {
        const fallback = await cache.match("./index.html");
        if (fallback) return fallback;
      }

      throw error;
    }
  })());
});

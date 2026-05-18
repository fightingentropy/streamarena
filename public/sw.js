const CACHE_VERSION = "netflix-pwa-v1";
const APP_SHELL_URLS = [
  "/",
  "/login.html",
  "/settings.html",
  "/upload.html",
  "/live.html",
  "/new-popular.html",
  "/player.html",
  "/manifest.webmanifest",
  "/assets/icons/netflix-n.svg",
  "/assets/icons/netflix-app-icon-180.png",
  "/assets/icons/netflix-app-icon-192.png",
  "/assets/icons/netflix-app-icon-512.png",
  "/assets/icons/netflix-maskable-icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => precacheUrls(cache, APP_SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_VERSION)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/assets/videos/") ||
    url.pathname.startsWith("/cache/")
  ) {
    return;
  }

  if (request.mode === "navigate") {
    let fallbackUrl = "/";
    if (url.pathname.startsWith("/watch")) {
      fallbackUrl = "/player.html";
    } else if (url.pathname.endsWith(".html")) {
      fallbackUrl = url.pathname;
    }
    event.respondWith(networkFirst(request, fallbackUrl));
    return;
  }

  if (
    url.pathname.startsWith("/ui-assets/") ||
    url.pathname.startsWith("/assets/icons/") ||
    url.pathname === "/manifest.webmanifest"
  ) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(networkFirst(request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_VERSION);
    cache.put(request, response.clone());
  }
  return response;
}

async function precacheUrls(cache, urls) {
  await Promise.allSettled(
    urls.map(async (url) => {
      const response = await fetch(url, { cache: "reload" });
      if (response.ok) {
        await cache.put(url, response);
      }
    }),
  );
}

async function networkFirst(request, fallbackUrl = "") {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }
    if (fallbackUrl) {
      const fallback = await caches.match(fallbackUrl);
      if (fallback) {
        return fallback;
      }
    }
    throw new Error("Offline and no cached response is available.");
  }
}

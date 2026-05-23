// Bump CACHE_VERSION when shell assets change so clients pick up updates.
const CACHE_VERSION = "netflix-pwa-v18";
const OFFLINE_URL = "/offline.html";
const APP_SHELL_URLS = [
  "/",
  "/login.html",
  "/settings.html",
  "/upload.html",
  "/live.html",
  "/sports.html",
  "/player.html",
  OFFLINE_URL,
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
    } else if (url.pathname === "/sports") {
      fallbackUrl = "/sports.html";
    } else if (url.pathname.endsWith(".html")) {
      fallbackUrl = url.pathname;
    }
    event.respondWith(networkFirstNavigation(request, fallbackUrl));
    return;
  }

  if (url.pathname.startsWith("/ui-assets/")) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  if (
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

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await caches.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if (response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    void networkPromise;
    return cached;
  }

  const network = await networkPromise;
  if (network) {
    return network;
  }

  return offlineResponse();
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

async function networkFirst(request) {
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
    return offlineResponse();
  }
}

async function networkFirstNavigation(request, fallbackUrl = "") {
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
    const offline = await caches.match(OFFLINE_URL);
    if (offline) {
      return offline;
    }
    return offlineResponse();
  }
}

async function offlineResponse() {
  const offline = await caches.match(OFFLINE_URL);
  if (offline) {
    return offline;
  }
  return new Response("You are offline.", {
    status: 503,
    statusText: "Offline",
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

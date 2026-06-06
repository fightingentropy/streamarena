// Bump CACHE_PREFIX when shell assets change so clients pick up updates.
const CACHE_PREFIX = "netflix-pwa-v23";
const SHELL_CACHE = `${CACHE_PREFIX}:shell`;
const PAGE_CACHE = `${CACHE_PREFIX}:pages`;
const API_CACHE = `${CACHE_PREFIX}:api`;
const ARTWORK_CACHE = `${CACHE_PREFIX}:artwork`;
const RUNTIME_CACHE = `${CACHE_PREFIX}:runtime`;
const CACHE_NAMES = new Set([
  SHELL_CACHE,
  PAGE_CACHE,
  API_CACHE,
  ARTWORK_CACHE,
  RUNTIME_CACHE,
]);

const OFFLINE_URL = "/offline.html";
const ARTWORK_FALLBACK_URL = "/assets/images/thumbnail.jpg";
const ARTWORK_CACHE_MAX_ENTRIES = 320;
const API_CACHE_MAX_ENTRIES = 140;
const RUNTIME_CACHE_MAX_ENTRIES = 90;
const WARM_CACHE_LIMIT = 100;

const APP_SHELL_URLS = [
  "/login.html",
  "/settings.html",
  "/live.html",
  "/sports.html",
  "/player.html",
  OFFLINE_URL,
  "/manifest.webmanifest",
  ARTWORK_FALLBACK_URL,
  "/assets/images/thumbnail-top10-h.jpg",
  "/assets/icons/netflix-n.svg",
  "/assets/icons/netflix-logo-clean.png",
  "/assets/icons/netflix-app-icon-180.png",
  "/assets/icons/netflix-app-icon-192.png",
  "/assets/icons/netflix-app-icon-512.png",
  "/assets/icons/netflix-maskable-icon-512.png",
];

const TMDB_IMAGE_HOSTS = new Set(["image.tmdb.org"]);
const CACHEABLE_API_PATHS = new Set([
  "/api/tmdb/popular-movies",
]);
const NETWORK_FIRST_API_PATHS = new Set([]);
const LOCAL_IMAGE_EXTENSIONS = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
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
            .filter((key) => !CACHE_NAMES.has(key))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data && typeof event.data === "object" ? event.data : {};
  if (data.type === "CACHE_URLS" && Array.isArray(data.urls)) {
    event.waitUntil(warmUrls(data.urls));
  } else if (data.type === "DELETE_CACHED_URLS" && Array.isArray(data.urls)) {
    event.waitUntil(deleteCachedUrls(data.urls));
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET") {
    if (shouldClearApiCacheAfterMutation(request, url)) {
      event.waitUntil(caches.delete(API_CACHE));
    }
    return;
  }

  if (isTmdbArtworkRequest(request, url)) {
    event.respondWith(
      cacheFirstWithFallback(request, {
        cacheName: ARTWORK_CACHE,
        cacheOpaque: true,
        fallbackUrl: ARTWORK_FALLBACK_URL,
        maxEntries: ARTWORK_CACHE_MAX_ENTRIES,
      }),
    );
    return;
  }

  if (url.origin !== self.location.origin) {
    return;
  }

  if (isCacheableApiRequest(url)) {
    event.respondWith(
      NETWORK_FIRST_API_PATHS.has(url.pathname)
        ? networkFirst(request, {
            cacheName: API_CACHE,
            maxEntries: API_CACHE_MAX_ENTRIES,
            skipWarmingHomeBootstrap: true,
          })
        : staleWhileRevalidate(request, {
            cacheName: API_CACHE,
            maxEntries: API_CACHE_MAX_ENTRIES,
            skipWarmingHomeBootstrap: true,
          }),
    );
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

  if (isLocalArtworkRequest(request, url)) {
    event.respondWith(
      cacheFirstWithFallback(request, {
        cacheName: ARTWORK_CACHE,
        fallbackUrl: ARTWORK_FALLBACK_URL,
        maxEntries: ARTWORK_CACHE_MAX_ENTRIES,
      }),
    );
    return;
  }

  if (url.pathname.startsWith("/ui-assets/")) {
    event.respondWith(
      staleWhileRevalidate(request, {
        cacheName: RUNTIME_CACHE,
        maxEntries: RUNTIME_CACHE_MAX_ENTRIES,
      }),
    );
    return;
  }

  if (
    url.pathname.startsWith("/assets/icons/") ||
    url.pathname === "/manifest.webmanifest"
  ) {
    event.respondWith(cacheFirst(request, { cacheName: SHELL_CACHE }));
    return;
  }

  event.respondWith(
    networkFirst(request, {
      cacheName: RUNTIME_CACHE,
      maxEntries: RUNTIME_CACHE_MAX_ENTRIES,
    }),
  );
});

async function cacheFirst(request, { cacheName }) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }
  const response = await fetch(request);
  await maybeCacheResponse(cacheName, request, response);
  return response;
}

async function cacheFirstWithFallback(
  request,
  {
    cacheName,
    cacheOpaque = false,
    fallbackUrl = "",
    maxEntries = 0,
  },
) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(request);
    await maybeCacheResponse(cacheName, request, response, {
      cacheOpaque,
      maxEntries,
    });
    return response;
  } catch {
    return fallbackResponse(fallbackUrl);
  }
}

async function staleWhileRevalidate(
  request,
  {
    cacheName,
    cacheOpaque = false,
    fallbackUrl = "",
    maxEntries = 0,
    skipWarmingHomeBootstrap = false,
  },
) {
  const cached = await caches.match(request);
  const networkPromise = fetch(request)
    .then(async (response) => {
      await maybeCacheResponse(cacheName, request, response, {
        cacheOpaque,
        maxEntries,
        skipWarmingHomeBootstrap,
      });
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

  return fallbackResponse(fallbackUrl);
}

async function precacheUrls(cache, urls) {
  await Promise.allSettled(
    urls.map(async (url) => {
      const response = await fetch(url, { cache: "reload" });
      if (
        isCacheableResponse(response) &&
        !responseCacheControlDisallowsStorage(response)
      ) {
        await cache.put(url, response.clone());
      }
    }),
  );
}

async function networkFirst(
  request,
  {
    cacheName,
    cacheOpaque = false,
    maxEntries = 0,
    skipWarmingHomeBootstrap = false,
  },
) {
  try {
    const response = await fetch(request);
    await maybeCacheResponse(cacheName, request, response, {
      cacheOpaque,
      maxEntries,
      skipWarmingHomeBootstrap,
    });
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
  try {
    const response = await fetch(request);
    await maybeCacheResponse(PAGE_CACHE, request, response);
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

async function maybeCacheResponse(
  cacheName,
  request,
  response,
  {
    cacheOpaque = false,
    maxEntries = 0,
    skipWarmingHomeBootstrap = false,
  } = {},
) {
  if (!isCacheableResponse(response, { cacheOpaque })) {
    return;
  }
  if (responseCacheControlDisallowsStorage(response)) {
    return;
  }
  if (
    skipWarmingHomeBootstrap &&
    new URL(request.url).pathname === "/api/home/bootstrap" &&
    (await isWarmingHomeBootstrapResponse(response))
  ) {
    return;
  }
  const cache = await caches.open(cacheName);
  await cache.put(request, response.clone());
  if (maxEntries > 0) {
    await trimCache(cache, maxEntries);
  }
}

function isCacheableResponse(response, { cacheOpaque = false } = {}) {
  return Boolean(response && (response.ok || (cacheOpaque && response.type === "opaque")));
}

function responseCacheControlDisallowsStorage(response) {
  const cacheControl = String(response?.headers?.get("Cache-Control") || "")
    .trim()
    .toLowerCase();
  return /(?:^|,)\s*(?:no-store|private)\b/.test(cacheControl);
}

async function isWarmingHomeBootstrapResponse(response) {
  try {
    const payload = await response.clone().json();
    return String(payload?._meta?.status || "") === "warming";
  } catch {
    return false;
  }
}

async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) {
    return;
  }
  await Promise.all(keys.slice(0, keys.length - maxEntries).map((key) => cache.delete(key)));
}

async function fallbackResponse(fallbackUrl) {
  if (fallbackUrl) {
    const fallback = await caches.match(fallbackUrl);
    if (fallback) {
      return fallback;
    }
  }
  return offlineResponse();
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

function isCacheableApiRequest(url) {
  return url.origin === self.location.origin && CACHEABLE_API_PATHS.has(url.pathname);
}

function shouldClearApiCacheAfterMutation(request, url) {
  return (
    url.origin === self.location.origin &&
    request.method !== "GET" &&
    (url.pathname === "/api/auth/logout" ||
      url.pathname === "/api/library" ||
      url.pathname.startsWith("/api/user/"))
  );
}

function isTmdbArtworkRequest(request, url) {
  return TMDB_IMAGE_HOSTS.has(url.hostname) && isImageLikeRequest(request, url);
}

function isLocalArtworkRequest(request, url) {
  return (
    url.origin === self.location.origin &&
    isImageLikeRequest(request, url) &&
    (url.pathname.startsWith("/assets/images/") ||
      url.pathname.startsWith("/assets/icons/") ||
      LOCAL_IMAGE_EXTENSIONS.test(url.pathname))
  );
}

function isImageLikeRequest(request, url) {
  return request.destination === "image" || LOCAL_IMAGE_EXTENSIONS.test(url.pathname);
}

async function warmUrls(urls) {
  const normalizedUrls = Array.from(
    new Set(
      urls
        .map((url) => normalizeWarmUrl(url))
        .filter(Boolean),
    ),
  ).slice(0, WARM_CACHE_LIMIT);

  await Promise.allSettled(normalizedUrls.map((url) => warmUrl(url)));
}

async function deleteCachedUrls(urls) {
  const normalizedUrls = Array.from(
    new Set(
      urls
        .map((url) => normalizeWarmUrl(url))
        .filter(Boolean),
    ),
  );
  if (!normalizedUrls.length) {
    return;
  }
  const cache = await caches.open(ARTWORK_CACHE);
  await Promise.allSettled(
    normalizedUrls.map((url) => {
      const request = buildArtworkRequest(url);
      return cache.delete(request);
    }),
  );
}

function normalizeWarmUrl(value) {
  try {
    const url = new URL(String(value || ""), self.location.origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }
    if (url.origin === self.location.origin && isLocalArtworkRequest(new Request(url.href), url)) {
      return url.href;
    }
    if (TMDB_IMAGE_HOSTS.has(url.hostname) && LOCAL_IMAGE_EXTENSIONS.test(url.pathname)) {
      return url.href;
    }
  } catch {
    return "";
  }
  return "";
}

async function warmUrl(rawUrl) {
  const request = buildArtworkRequest(rawUrl);
  const url = new URL(request.url);
  const isTmdb = TMDB_IMAGE_HOSTS.has(url.hostname);
  const cache = await caches.open(ARTWORK_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    return;
  }
  const response = await fetch(request);
  await maybeCacheResponse(ARTWORK_CACHE, request, response, {
    cacheOpaque: isTmdb,
    maxEntries: ARTWORK_CACHE_MAX_ENTRIES,
  });
}

function buildArtworkRequest(rawUrl) {
  const url = new URL(rawUrl);
  return TMDB_IMAGE_HOSTS.has(url.hostname)
    ? new Request(url.href, { mode: "no-cors" })
    : new Request(url.href, { credentials: "same-origin" });
}

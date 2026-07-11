import { TMDB_IMAGE_BASE } from "../shared.js";
import { DEFAULT_LOCAL_THUMBNAIL } from "./continue-watching.js";

const OFFLINE_ARTWORK_WARM_DELAY_MS = 300;
const OFFLINE_ARTWORK_WARM_LIMIT = 100;
const HOME_BOOTSTRAP_ARTWORK_KEYS = [
  "popular",
  "bingeworthy",
  "crowdPleasers",
  "topSeries",
  "criticallyAcclaimed",
  "trending",
  "nowPlaying",
  "topRated",
];

let offlineArtworkWarmTimer = null;
const pendingOfflineArtworkUrls = new Set();

export function toCacheableArtworkUrl(value) {
  try {
    const raw = String(value || "").trim();
    if (
      !raw ||
      raw.startsWith("data:") ||
      raw.startsWith("blob:") ||
      raw.startsWith("#")
    ) {
      return "";
    }
    const url = new URL(raw, window.location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }
    if (
      url.origin !== window.location.origin &&
      url.hostname !== "image.tmdb.org"
    ) {
      return "";
    }
    return url.href;
  } catch {
    return "";
  }
}

export function queueOfflineArtworkCache(urls) {
  if (!("serviceWorker" in navigator) || !Array.isArray(urls)) {
    return;
  }
  urls
    .map(toCacheableArtworkUrl)
    .filter(Boolean)
    .forEach((url) => pendingOfflineArtworkUrls.add(url));
  if (!pendingOfflineArtworkUrls.size || offlineArtworkWarmTimer) {
    return;
  }
  offlineArtworkWarmTimer = window.setTimeout(() => {
    offlineArtworkWarmTimer = null;
    const urlsToCache = Array.from(pendingOfflineArtworkUrls).slice(
      0,
      OFFLINE_ARTWORK_WARM_LIMIT,
    );
    urlsToCache.forEach((url) => pendingOfflineArtworkUrls.delete(url));
    navigator.serviceWorker.ready
      .then((registration) => {
        const worker =
          registration.active || navigator.serviceWorker.controller;
        worker?.postMessage({ type: "CACHE_URLS", urls: urlsToCache });
      })
      .catch(() => {});
    if (pendingOfflineArtworkUrls.size) {
      queueOfflineArtworkCache([]);
    }
  }, OFFLINE_ARTWORK_WARM_DELAY_MS);
}

export function deleteCachedArtworkUrls(urls) {
  if (!("serviceWorker" in navigator) || !Array.isArray(urls)) {
    return;
  }
  const urlsToDelete = urls.map(toCacheableArtworkUrl).filter(Boolean);
  if (!urlsToDelete.length) {
    return;
  }
  navigator.serviceWorker.ready
    .then((registration) => {
      const worker = registration.active || navigator.serviceWorker.controller;
      worker?.postMessage({ type: "DELETE_CACHED_URLS", urls: urlsToDelete });
    })
    .catch(() => {});
}

export function queueOfflineArtworkFromElement(root) {
  if (!(root instanceof Element)) {
    return;
  }
  const urls = [];
  root.querySelectorAll("img").forEach((image) => {
    urls.push(image.currentSrc || image.src || image.getAttribute("src") || "");
  });
  if (root instanceof HTMLElement) {
    urls.push(root.dataset.thumb || "");
  }
  root.querySelectorAll("[data-thumb]").forEach((element) => {
    if (element instanceof HTMLElement) {
      urls.push(element.dataset.thumb || "");
    }
  });
  queueOfflineArtworkCache(urls);
}

export function collectLocalLibraryArtworkUrls(localLibrary) {
  const urls = [];
  (Array.isArray(localLibrary?.movies) ? localLibrary.movies : []).forEach(
    (movie) => {
      urls.push(movie?.thumb || "");
    },
  );
  (Array.isArray(localLibrary?.series) ? localLibrary.series : []).forEach(
    (series) => {
      (Array.isArray(series?.episodes) ? series.episodes : []).forEach(
        (episode) => {
          urls.push(episode?.thumb || "");
        },
      );
    },
  );
  return urls;
}

function collectTmdbItemArtworkUrls(item, imageBase = TMDB_IMAGE_BASE) {
  const posterPath = String(item?.poster_path || item?.posterPath || "").trim();
  const backdropPath = String(
    item?.backdrop_path || item?.backdropPath || "",
  ).trim();
  const urls = [];
  if (backdropPath) {
    urls.push(`${imageBase}/w1280${backdropPath}`);
    urls.push(`${imageBase}/w780${backdropPath}`);
  }
  if (posterPath) {
    urls.push(`${imageBase}/w780${posterPath}`);
    urls.push(`${imageBase}/w500${posterPath}`);
  }
  return urls;
}

export function collectHomeBootstrapArtworkUrls(
  bootstrap,
  imageBase = TMDB_IMAGE_BASE,
) {
  const urls = [];
  HOME_BOOTSTRAP_ARTWORK_KEYS.forEach((key) => {
    const results = bootstrap?.[key]?.results;
    (Array.isArray(results) ? results : []).forEach((item) => {
      urls.push(...collectTmdbItemArtworkUrls(item, imageBase));
    });
  });
  urls.push(...collectLocalLibraryArtworkUrls(bootstrap?.library));
  return urls;
}

function setArtworkImageFallback(image) {
  if (!(image instanceof HTMLImageElement)) {
    return;
  }
  if (image.classList.contains("card-rail-logo")) {
    // A missing title-logo should reveal the styled text title beneath it, not swap in a
    // generic thumbnail. Drop the logo and clear the flag so the `.card-rail-title` shows.
    image.closest(".card-rail-art")?.classList.remove("has-logo");
    image.remove();
    return;
  }
  const fallbackPath = image.classList.contains("hero-poster")
    ? "assets/images/thumbnail-top10-h.jpg"
    : DEFAULT_LOCAL_THUMBNAIL;
  const fallbackUrl = new URL(fallbackPath, window.location.href).href;
  const failedUrl = toCacheableArtworkUrl(
    image.currentSrc || image.src || image.getAttribute("src") || "",
  );
  if (failedUrl && failedUrl !== fallbackUrl) {
    deleteCachedArtworkUrls([failedUrl]);
  }
  if (image.src !== fallbackUrl) {
    image.src = fallbackPath;
  }
}

export function handleArtworkImageError(event) {
  setArtworkImageFallback(event.currentTarget);
}

export function attachArtworkImageFallbacks(root) {
  if (!(root instanceof Element)) {
    return;
  }
  root.querySelectorAll("img").forEach((image) => {
    if (!(image instanceof HTMLImageElement)) {
      return;
    }
    if (!image.dataset.artworkFallbackAttached) {
      image.dataset.artworkFallbackAttached = "true";
      image.addEventListener("error", handleArtworkImageError);
    }
    if (image.complete && image.naturalWidth === 0) {
      setArtworkImageFallback(image);
    }
  });
}

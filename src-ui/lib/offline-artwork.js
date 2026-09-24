import { TMDB_IMAGE_BASE } from "../shared.js";
import { DEFAULT_LOCAL_THUMBNAIL } from "./continue-watching.js";

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

// The service worker caches artwork fetched by the browser. Do not scan hidden
// DOM or whole catalogues to fetch additional sizes speculatively.
let artworkObserver;

function activateDeferredImage(image) {
  const src = image.dataset.src;
  if (!src) return;
  image.loading = "eager";
  if (image.dataset.srcset) {
    image.srcset = image.dataset.srcset;
    delete image.dataset.srcset;
  }
  image.src = src;
  delete image.dataset.src;
}

export function revealDeferredArtwork(root) {
  if (!(root instanceof Element)) return;
  root.querySelectorAll("img[data-src]").forEach(activateDeferredImage);
}

export function observeDeferredArtwork(root) {
  if (!(root instanceof Element)) return;
  const images = root.querySelectorAll("img[data-src]:not(.card-hover-image)");
  if (!("IntersectionObserver" in window)) {
    images.forEach(activateDeferredImage);
    return;
  }
  artworkObserver ||= new window.IntersectionObserver((entries) => {
    entries.forEach(({ target, isIntersecting }) => {
      if (!isIntersecting) return;
      artworkObserver.unobserve(target);
      activateDeferredImage(target);
    });
  }, { rootMargin: "200px" });
  images.forEach((image) => artworkObserver.observe(image));
}

export function unobserveDeferredArtwork(root) {
  if (!(root instanceof Element)) return;
  root.querySelectorAll("img").forEach((image) => artworkObserver?.unobserve(image));
}

export function stopObservingDeferredArtwork() {
  artworkObserver?.disconnect();
  artworkObserver = null;
}

export function buildTmdbArtworkSrcSet(value, widths) {
  const url = String(value || "");
  if (!url.startsWith(`${TMDB_IMAGE_BASE}/`)) return "";
  return widths.map((width) =>
    `${url.replace(/\/(?:w\d+|original)\//, `/w${width}/`)} ${width}w`,
  ).join(", ");
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
    image.removeAttribute("srcset");
    delete image.dataset.srcset;
    delete image.dataset.src;
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
    if (image.getAttribute("src") && image.complete && image.naturalWidth === 0) {
      setArtworkImageFallback(image);
    }
  });
}

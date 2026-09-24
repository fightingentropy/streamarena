#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const workerMessages = [];
const activeWorker = {
  postMessage(message) {
    workerMessages.push(message);
  },
};

class FakeElement {
  constructor({ images = [], thumbs = [] } = {}) {
    this.images = images;
    this.thumbs = thumbs;
  }

  querySelectorAll(selector) {
    if (selector === "img") return this.images;
    if (selector === "img[data-src]") return this.images.filter((image) => image.dataset.src);
    if (selector === "img[data-src]:not(.card-hover-image)") {
      return this.images.filter((image) => image.dataset.src && !image.classList.contains("card-hover-image"));
    }
    if (selector === "[data-thumb]") return this.thumbs;
    return [];
  }
}

class FakeHTMLElement extends FakeElement {
  constructor(options = {}) {
    super(options);
    this.dataset = options.dataset || {};
  }
}

class FakeHTMLImageElement extends FakeHTMLElement {
  constructor(options = {}) {
    super(options);
    this.currentSrc = options.currentSrc || "";
    this.src = options.src || "";
    this.complete = options.complete ?? false;
    this.naturalWidth = options.naturalWidth ?? 1;
    this.listeners = new Map();
    this.removed = false;
    this.artworkClassRemoved = false;
    const classes = new Set(options.classes || []);
    this.classList = { contains: (name) => classes.has(name) };
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  getAttribute(name) {
    return name === "src" ? this.src : null;
  }

  removeAttribute(name) {
    if (name === "srcset") this.srcset = "";
  }

  closest() {
    return {
      classList: {
        remove: (name) => {
          this.artworkClassRemoved ||= name === "has-logo";
        },
      },
    };
  }

  remove() {
    this.removed = true;
  }
}

Object.defineProperty(globalThis, "window", {
  value: {
    location: {
      href: "https://streamarena.test/home.html",
      origin: "https://streamarena.test",
    },
    setTimeout,
    clearTimeout,
  },
  configurable: true,
});
Object.defineProperty(globalThis, "navigator", {
  value: {
    serviceWorker: {
      ready: Promise.resolve({ active: activeWorker }),
      controller: activeWorker,
    },
  },
  configurable: true,
});
Object.defineProperties(globalThis, {
  Element: { value: FakeElement, configurable: true },
  HTMLElement: { value: FakeHTMLElement, configurable: true },
  HTMLImageElement: { value: FakeHTMLImageElement, configurable: true },
});

const {
  attachArtworkImageFallbacks,
  buildTmdbArtworkSrcSet,
  observeDeferredArtwork,
  revealDeferredArtwork,
  stopObservingDeferredArtwork,
  deleteCachedArtworkUrls,
  handleArtworkImageError,
  toCacheableArtworkUrl,
} = await import("../src-ui/lib/offline-artwork.js");
const { DEFAULT_LOCAL_THUMBNAIL } = await import(
  "../src-ui/lib/continue-watching.js"
);

const serviceWorkerSource = await readFile(
  new URL("../public/sw.js", import.meta.url),
  "utf8",
);
assert.match(serviceWorkerSource, /CACHE_PREFIX = "streamarena-pwa-v32"/);
assert.match(
  serviceWorkerSource,
  /url\.pathname\.startsWith\("\/assets\/images\/"\)[\s\S]*?return;/,
  "service worker must bypass Cache Storage for authenticated local artwork",
);
const appShellSource = serviceWorkerSource.match(
  /const APP_SHELL_URLS = \[([\s\S]*?)\];/,
)?.[1] || "";
assert.doesNotMatch(
  appShellSource,
  /\/assets\/images\//,
  "private local artwork must not be app-shell precached",
);

assert.equal(
  toCacheableArtworkUrl(" /assets/poster.jpg "),
  "https://streamarena.test/assets/poster.jpg",
  "same-origin artwork should resolve to an absolute URL",
);
assert.equal(
  toCacheableArtworkUrl("https://image.tmdb.org/t/p/w500/poster.jpg"),
  "https://image.tmdb.org/t/p/w500/poster.jpg",
  "TMDB artwork should be cacheable",
);
for (const rejectedUrl of [
  "https://example.com/poster.jpg",
  "data:image/png;base64,AAAA",
  "blob:https://streamarena.test/123",
  "javascript:alert(1)",
  "#poster",
]) {
  assert.equal(
    toCacheableArtworkUrl(rejectedUrl),
    "",
    `${rejectedUrl} should not be cacheable`,
  );
}

const deferredHover = new FakeHTMLImageElement({
  dataset: { src: "https://image.tmdb.org/t/p/w780/preview.jpg" },
  classes: ["card-hover-image"], complete: true, naturalWidth: 0,
});
const deferredPoster = new FakeHTMLImageElement({
  dataset: { src: "https://image.tmdb.org/t/p/w500/poster.jpg", srcset: "small.jpg 185w, large.jpg 500w" },
  complete: true, naturalWidth: 0,
});
const deferredRoot = new FakeElement({ images: [deferredHover, deferredPoster] });
attachArtworkImageFallbacks(deferredRoot);
assert.equal(deferredHover.src, "", "missing src is deferred, not a failed image");
assert.equal(deferredPoster.src, "", "fallback handling must not download a placeholder");
let observeCallback;
const observedImages = new Set();
window.IntersectionObserver = class {
  constructor(callback, options) {
    observeCallback = callback;
    assert.equal(options.rootMargin, "200px");
  }
  observe(image) { observedImages.add(image); }
  unobserve(image) { observedImages.delete(image); }
  disconnect() { observedImages.clear(); }
};
observeDeferredArtwork(deferredRoot);
assert.deepEqual([...observedImages], [deferredPoster], "offscreen previews must never be observed as visible artwork");
observeCallback([{ target: deferredPoster, isIntersecting: false }]);
assert.equal(deferredPoster.src, "", "offscreen cards must not start downloads");
observeCallback([{ target: deferredPoster, isIntersecting: true }]);
assert.equal(deferredPoster.src, "https://image.tmdb.org/t/p/w500/poster.jpg");
assert.equal(deferredPoster.srcset, "small.jpg 185w, large.jpg 500w");
assert.equal(deferredPoster.loading, "eager");
assert.equal(observedImages.size, 0);
assert.equal(deferredHover.src, "");
revealDeferredArtwork(deferredRoot);
assert.equal(deferredHover.src, "https://image.tmdb.org/t/p/w780/preview.jpg", "explicit hover/focus activates the preview");
assert.equal(deferredHover.dataset.src, undefined);
stopObservingDeferredArtwork();
delete window.IntersectionObserver;
const legacyImage = new FakeHTMLImageElement({ dataset: { src: "/legacy.jpg" } });
observeDeferredArtwork(new FakeElement({ images: [legacyImage] }));
assert.equal(legacyImage.src, "/legacy.jpg", "browsers without IntersectionObserver still display cards");
assert.equal(buildTmdbArtworkSrcSet("https://image.tmdb.org/t/p/w1280/backdrop.jpg", [780, 1280]),
  "https://image.tmdb.org/t/p/w780/backdrop.jpg 780w, https://image.tmdb.org/t/p/w1280/backdrop.jpg 1280w");
assert.equal(buildTmdbArtworkSrcSet("/local.jpg", [780, 1280]), "", "local thumbnails must retain their original URL");

deleteCachedArtworkUrls([
  "/broken.jpg",
  "https://example.com/not-owned.jpg",
]);
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(workerMessages.shift(), {
  type: "DELETE_CACHED_URLS",
  urls: ["https://streamarena.test/broken.jpg"],
});

const brokenImage = new FakeHTMLImageElement({
  currentSrc: "https://streamarena.test/broken-artwork.jpg",
  src: "https://streamarena.test/broken-artwork.jpg",
  complete: true,
  naturalWidth: 0,
});
brokenImage.srcset = "https://image.tmdb.org/t/p/w780/broken.jpg 780w";
const fallbackRoot = new FakeElement({ images: [brokenImage] });
attachArtworkImageFallbacks(fallbackRoot);
brokenImage.complete = false;
attachArtworkImageFallbacks(fallbackRoot);
assert.equal(brokenImage.listeners.size, 1, "fallback listener should attach once");
assert.equal(brokenImage.src, DEFAULT_LOCAL_THUMBNAIL);
assert.equal(brokenImage.srcset, "", "broken responsive candidates must not override the local fallback");
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(workerMessages.shift(), {
  type: "DELETE_CACHED_URLS",
  urls: ["https://streamarena.test/broken-artwork.jpg"],
});

const brokenLogo = new FakeHTMLImageElement({ classes: ["card-rail-logo"] });
handleArtworkImageError({ currentTarget: brokenLogo });
assert.equal(brokenLogo.artworkClassRemoved, true);
assert.equal(brokenLogo.removed, true);
assert.equal(workerMessages.length, 0);

// Execute the unchanged worker implementation: overlapping messages must share
// one bounded queue, deduplicate in-flight work, and retain ordinary fetch caching.
const storedArtwork = new Map();
const fetchedUrls = [];
let activeFetches = 0;
let maxActiveFetches = 0;
const cache = {
  match: async (request) => storedArtwork.get(request.url),
  put: async (request, response) => storedArtwork.set(request.url, response),
  keys: async () => [...storedArtwork.keys()].map((url) => new Request(url)),
  delete: async (request) => storedArtwork.delete(request.url),
};
const listeners = new Map();
const workerContext = vm.createContext({
  URL, Request, Response, AbortController, setTimeout, clearTimeout,
  self: { location: { origin: "https://streamarena.test" }, addEventListener: (type, callback) => listeners.set(type, callback) },
  caches: { open: async () => cache, match: cache.match },
  fetch: async (request) => {
    fetchedUrls.push(request.url);
    activeFetches += 1;
    maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeFetches -= 1;
    if (request.url.endsWith("/broken.jpg")) throw new Error("temporary image failure");
    return new Response("image", { headers: { "Cache-Control": "public, max-age=3600" } });
  },
});
vm.runInContext(serviceWorkerSource, workerContext);
const warmUrls = vm.runInContext("warmUrls", workerContext);
const artworkUrl = (id) => `https://image.tmdb.org/t/p/w500/${id}.jpg`;
await Promise.all([
  warmUrls([1, 2, 3, 4, 5].map(artworkUrl)),
  warmUrls([3, 4, 5, 6, 7, "broken", 8].map(artworkUrl)),
]);
assert.equal(maxActiveFetches, 3, "parallel messages must never exceed three artwork fetches globally");
assert.equal(fetchedUrls.length, 9, "overlapping warm requests should share in-flight work");
assert.equal(storedArtwork.size, 8, "one failed image must not stop the queue");
await warmUrls([artworkUrl(1)]);
assert.equal(fetchedUrls.length, 9, "cached artwork must not be downloaded again");
await warmUrls(["https://streamarena.test/assets/images/private-poster.jpg"]);
assert.equal(fetchedUrls.length, 9, "authenticated local artwork must not enter the warming cache");
let fetchResponse;
listeners.get("fetch")({
  request: new Request(artworkUrl(20)),
  respondWith: (promise) => { fetchResponse = promise; },
});
await fetchResponse;
assert(storedArtwork.has(artworkUrl(20)), "requested artwork must still be available offline without speculative warming");
assert.doesNotMatch(appShellSource, /"\/(?:index|login|settings|live|sports|player)\.html"/, "protected/no-store pages do not belong in the install precache");

// Ready injected data must not trigger a second bootstrap request.
let bootstrapJson = JSON.stringify({ popular: { results: [{ id: 1 }] }, library: { movies: [], series: [] } });
globalThis.document = { getElementById: () => ({ textContent: bootstrapJson }) };
const { loadInitialHomeBootstrap } = await import("../src-ui/lib/home-bootstrap.js");
let bootstrapFetches = 0;
globalThis.fetch = async () => { bootstrapFetches += 1; return { ok: true, json: async () => ({ popular: { results: [{ id: 2 }] } }) }; };
assert.equal((await loadInitialHomeBootstrap()).popular.results[0].id, 1);
assert.equal(bootstrapFetches, 0);
delete window.__HOME_BOOTSTRAP__;
bootstrapJson = JSON.stringify({ _meta: { status: "warming" } });
assert.equal((await loadInitialHomeBootstrap()).popular.results[0].id, 2);
assert.equal(bootstrapFetches, 1, "warming snapshots must still be refreshed");
delete window.__HOME_BOOTSTRAP__;
bootstrapJson = "invalid json";
assert.equal((await loadInitialHomeBootstrap()).popular.results[0].id, 2);
assert.equal(bootstrapFetches, 2, "invalid snapshots must retain the normal fetch fallback");
console.log("Offline artwork and Home bootstrap tests passed.");

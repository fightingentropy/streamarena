#!/usr/bin/env node
import assert from "node:assert/strict";

const scheduledCallbacks = [];
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
    setTimeout(callback) {
      scheduledCallbacks.push(callback);
      return scheduledCallbacks.length;
    },
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
  collectHomeBootstrapArtworkUrls,
  collectLocalLibraryArtworkUrls,
  deleteCachedArtworkUrls,
  handleArtworkImageError,
  queueOfflineArtworkCache,
  queueOfflineArtworkFromElement,
  toCacheableArtworkUrl,
} = await import("../src-ui/lib/offline-artwork.js");
const { DEFAULT_LOCAL_THUMBNAIL } = await import(
  "../src-ui/lib/continue-watching.js"
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

const libraryArtwork = collectLocalLibraryArtworkUrls({
  movies: [{ thumb: "/movie.jpg" }, { title: "No artwork" }],
  series: [
    {
      episodes: [{ thumb: "/episode-1.jpg" }, { thumb: "/episode-2.jpg" }],
    },
  ],
});
assert.deepEqual(libraryArtwork, [
  "/movie.jpg",
  "",
  "/episode-1.jpg",
  "/episode-2.jpg",
]);

const bootstrapArtwork = collectHomeBootstrapArtworkUrls(
  {
    popular: {
      results: [{ poster_path: "/popular-p.jpg", backdrop_path: "/popular-b.jpg" }],
    },
    trending: {
      results: [{ posterPath: "/trending-p.jpg", backdropPath: "/trending-b.jpg" }],
    },
    ignoredRail: {
      results: [{ poster_path: "/ignored.jpg" }],
    },
    library: {
      movies: [{ thumb: "/local.jpg" }],
    },
  },
  "https://images.test",
);
assert.deepEqual(bootstrapArtwork, [
  "https://images.test/w1280/popular-b.jpg",
  "https://images.test/w780/popular-b.jpg",
  "https://images.test/w780/popular-p.jpg",
  "https://images.test/w500/popular-p.jpg",
  "https://images.test/w1280/trending-b.jpg",
  "https://images.test/w780/trending-b.jpg",
  "https://images.test/w780/trending-p.jpg",
  "https://images.test/w500/trending-p.jpg",
  "/local.jpg",
]);

queueOfflineArtworkCache([
  "/one.jpg",
  "/one.jpg",
  "https://image.tmdb.org/t/p/w500/two.jpg",
  "https://example.com/rejected.jpg",
]);
queueOfflineArtworkCache(["/three.jpg"]);
assert.equal(
  scheduledCallbacks.length,
  1,
  "cache requests should share one warm-up timer",
);
scheduledCallbacks.shift()();
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(workerMessages.shift(), {
  type: "CACHE_URLS",
  urls: [
    "https://streamarena.test/one.jpg",
    "https://image.tmdb.org/t/p/w500/two.jpg",
    "https://streamarena.test/three.jpg",
  ],
});

const scannedImage = new FakeHTMLImageElement({
  currentSrc: "https://streamarena.test/scanned.jpg",
});
const scannedThumb = new FakeHTMLElement({ dataset: { thumb: "/nested-thumb.jpg" } });
const scannedRoot = new FakeHTMLElement({
  images: [scannedImage],
  thumbs: [scannedThumb],
  dataset: { thumb: "/root-thumb.jpg" },
});
queueOfflineArtworkFromElement(scannedRoot);
assert.equal(scheduledCallbacks.length, 1, "element scans should queue one timer");
scheduledCallbacks.shift()();
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(workerMessages.shift(), {
  type: "CACHE_URLS",
  urls: [
    "https://streamarena.test/scanned.jpg",
    "https://streamarena.test/root-thumb.jpg",
    "https://streamarena.test/nested-thumb.jpg",
  ],
});

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
const fallbackRoot = new FakeElement({ images: [brokenImage] });
attachArtworkImageFallbacks(fallbackRoot);
brokenImage.complete = false;
attachArtworkImageFallbacks(fallbackRoot);
assert.equal(brokenImage.listeners.size, 1, "fallback listener should attach once");
assert.equal(brokenImage.src, DEFAULT_LOCAL_THUMBNAIL);
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

console.log("Offline artwork tests passed.");

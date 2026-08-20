import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  FEATURED_HERO_POSTER_ROTATION_MS,
  FEATURED_HERO_TRAILER_LOAD_TIMEOUT_MS,
  buildFeaturedHeroCandidates,
  buildYoutubeTrailerEmbedUrl,
  createDefaultFeaturedHero,
  getFeaturedHeroAutoAdvanceDelay,
  getFeaturedHeroTitleLines,
  getPopularRowTitle,
  selectFeaturedHeroCandidate,
} from "../src-ui/lib/featured-hero.js";

const trailerKey = "smokeTrailer1";
const embedUrl = new URL(buildYoutubeTrailerEmbedUrl(trailerKey));

assert.equal(embedUrl.hostname, "www.youtube-nocookie.com");
assert.equal(embedUrl.pathname, `/embed/${trailerKey}`);
assert.equal(embedUrl.searchParams.get("autoplay"), "1");
assert.equal(embedUrl.searchParams.get("mute"), "1");
assert.equal(embedUrl.searchParams.has("loop"), false);
assert.equal(embedUrl.searchParams.has("playlist"), false);

const homeSource = await readFile(
  new URL("../src-ui/pages/home.jsx", import.meta.url),
  "utf8",
);
assert.match(
  homeSource,
  /sandbox="allow-scripts allow-same-origin allow-presentation"/,
);
assert.doesNotMatch(homeSource, /sandbox="[^"]*(?:allow-forms|allow-popups|allow-top-navigation)/);

assert.equal(
  getFeaturedHeroAutoAdvanceDelay({ trailerKey }),
  FEATURED_HERO_TRAILER_LOAD_TIMEOUT_MS,
);
assert.equal(
  getFeaturedHeroAutoAdvanceDelay({ trailerKey }, { reducedMotion: true }),
  FEATURED_HERO_POSTER_ROTATION_MS,
);
assert.equal(
  getFeaturedHeroAutoAdvanceDelay({ trailerKey: "" }),
  FEATURED_HERO_POSTER_ROTATION_MS,
);

assert.deepEqual(getFeaturedHeroTitleLines({ title: "Spider-Man Homecoming" }), [
  "SPIDER-MAN",
  "HOMECOMING",
]);

assert.equal(createDefaultFeaturedHero("Unrated").title, "Popular Movies");
assert.equal(
  getPopularRowTitle({
    genres: [{ id: 28, name: "Action" }],
    results: [{ genre_ids: [28] }, { genre_ids: [28] }],
  }),
  "Adrenaline-Fueled Action",
);

const storage = {
  entries: new Map(),
  getItem(key) {
    return this.entries.has(key) ? this.entries.get(key) : null;
  },
  setItem(key, value) {
    this.entries.set(key, String(value));
  },
};
const candidates = [
  { tmdbId: "1", title: "One", poster: "a.jpg" },
  { tmdbId: "2", title: "Two", poster: "b.jpg" },
];
const first = selectFeaturedHeroCandidate(candidates, {
  now: 1_000,
  storage,
  rotationMs: 1_000,
});
assert.ok(first?.tmdbId);
const sameWindow = selectFeaturedHeroCandidate(candidates, {
  now: 1_500,
  storage,
  rotationMs: 1_000,
});
assert.equal(sameWindow.tmdbId, first.tmdbId);

const built = buildFeaturedHeroCandidates(
  {
    imageBase: "https://image.tmdb.org/t/p",
    genres: [{ id: 28, name: "Action" }],
    results: [
      {
        id: 11,
        title: "Dune",
        poster_path: "/dune.jpg",
        genre_ids: [28],
      },
      {
        id: 12,
        title: "Your Heart Will Be Broken",
        poster_path: "/blocked.jpg",
        genre_ids: [28],
      },
    ],
  },
  null,
  null,
  { imageBase: "https://image.tmdb.org/t/p" },
);
assert.equal(built.length, 1);
assert.equal(built[0].tmdbId, "11");
assert.equal(built[0].title, "Dune");

console.log("Featured hero timing and embed tests passed.");

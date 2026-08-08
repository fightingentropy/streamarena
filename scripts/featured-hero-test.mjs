import assert from "node:assert/strict";

import {
  FEATURED_HERO_POSTER_ROTATION_MS,
  FEATURED_HERO_TRAILER_LOAD_TIMEOUT_MS,
  buildYoutubeTrailerEmbedUrl,
  getFeaturedHeroAutoAdvanceDelay,
  getFeaturedHeroTitleLines,
} from "../src-ui/lib/featured-hero.js";

const trailerKey = "smokeTrailer1";
const embedUrl = new URL(buildYoutubeTrailerEmbedUrl(trailerKey));

assert.equal(embedUrl.hostname, "www.youtube-nocookie.com");
assert.equal(embedUrl.pathname, `/embed/${trailerKey}`);
assert.equal(embedUrl.searchParams.get("autoplay"), "1");
assert.equal(embedUrl.searchParams.get("mute"), "1");
assert.equal(embedUrl.searchParams.has("loop"), false);
assert.equal(embedUrl.searchParams.has("playlist"), false);

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

console.log("Featured hero timing and embed tests passed.");

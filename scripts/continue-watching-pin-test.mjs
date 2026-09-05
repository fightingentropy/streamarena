#!/usr/bin/env node
import assert from "node:assert/strict";

function makeStorage() {
  const entries = new Map();
  return {
    getItem(key) {
      return entries.has(key) ? entries.get(key) : null;
    },
    setItem(key, value) {
      entries.set(key, String(value));
    },
    removeItem(key) {
      entries.delete(key);
    },
  };
}

const storage = makeStorage();
Object.defineProperty(globalThis, "localStorage", {
  value: storage,
  configurable: true,
});

const {
  getContinueWatchingSeriesKey,
  isTorrentResolverProvider,
  mergeRememberedServerContinueWatchingEntry,
  normalizeRememberedResolverProvider,
  parseTmdbTvSourceIdentity,
  removeContinueWatchingMeta,
  writeContinueWatchingEntry,
} = await import("../src-ui/player/continue-watching-pin.js");

assert.equal(normalizeRememberedResolverProvider("Real-Debrid"), "real-debrid");
assert.equal(normalizeRememberedResolverProvider("fastest"), "");
assert.equal(isTorrentResolverProvider("local-torrent"), true);
assert.equal(isTorrentResolverProvider("external-embed"), false);

assert.deepEqual(parseTmdbTvSourceIdentity("tmdb:tv:99:s2:e4"), {
  tmdbId: "99",
  seasonNumber: 2,
  episodeNumber: 4,
});
assert.equal(
  getContinueWatchingSeriesKey("tmdb:tv:99:s1:e1", { mediaType: "tv", tmdbId: "99" }),
  "tmdb:tv:99",
);
assert.equal(
  getContinueWatchingSeriesKey("series:breaking-bad:episode:3", {}),
  "series:breaking-bad",
);

const { applyStoredParamsToSearchParams } = await import(
  "../src-ui/lib/watch-params.js"
);
const explicitParams = new URLSearchParams("sourceHash=explicit&benchmark=1");
applyStoredParamsToSearchParams(
  explicitParams,
  "sourceHash=remembered&quality=1080p",
);
assert.equal(explicitParams.get("sourceHash"), "explicit");
assert.equal(explicitParams.get("benchmark"), "1");
assert.equal(explicitParams.get("quality"), "1080p");

const { readContinueWatchingMetaMap } = await import("../src-ui/shared.js");
const identity = "tmdb:movie:42";
writeContinueWatchingEntry(identity, 95, {
  title: "Test",
  episode: "Now Playing",
  tmdbId: "42",
  mediaType: "movie",
  sourceHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  resolverProvider: "external-embed",
});
assert.equal(
  readContinueWatchingMetaMap()[identity].resolverProvider,
  "external-embed",
);
assert.equal(
  mergeRememberedServerContinueWatchingEntry(identity, {
    sourceIdentity: identity,
    sessionKey: "sess-1",
    resumeSeconds: 120,
  }),
  true,
);
assert.equal(
  readContinueWatchingMetaMap()[identity]?.sessionKey || "",
  "sess-1",
);
assert.equal(removeContinueWatchingMeta(identity), true);
assert.equal(
  readContinueWatchingMetaMap()[identity]?.sessionKey || "",
  "",
);

console.log("continue-watching-pin tests passed");

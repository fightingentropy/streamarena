#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  LIVE_FAILED_STREAM_CACHE_STORAGE_PREFIX,
  LIVE_WORKING_STREAM_CACHE_STORAGE_PREFIX,
  createLiveStreamCache,
  getLiveSourcePreferenceKeys,
  liveStreamCacheStorageKey,
  liveStreamEntryMatchesOption,
  normalizeLiveStreamPreferenceProvider,
} from "../src-ui/player/live-stream-cache.js";

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

assert.equal(
  normalizeLiveStreamPreferenceProvider({
    source: "https://rr.streamed.pk/live/1",
  }),
  "streamed",
);
assert.equal(
  normalizeLiveStreamPreferenceProvider({
    source: "https://embed.st/alpha",
  }),
  "ntvs",
);
assert.equal(
  normalizeLiveStreamPreferenceProvider({
    source: "https://watch.matchstream.to/game",
  }),
  "matchstream",
);
assert.equal(
  normalizeLiveStreamPreferenceProvider({
    provider: "custom",
    source: "https://rr.streamed.pk/live/1",
  }),
  "custom",
);
assert.equal(
  normalizeLiveStreamPreferenceProvider({
    source: "https://cdn.example.com/live.m3u8",
  }),
  "live",
);

const preferenceKeys = getLiveSourcePreferenceKeys({
  source: "https://rr.streamed.pk/live/1",
  label: "Home #2",
});
assert.deepEqual(preferenceKeys, [
  "source:https://rr.streamed.pk/live/1",
  "host:streamed:rr.streamed.pk",
  "slot:streamed:2",
]);

assert.equal(
  liveStreamEntryMatchesOption(
    { streamId: "alpha", source: "https://a.example/1" },
    { id: "alpha", source: "https://a.example/1" },
  ),
  true,
);
assert.equal(
  liveStreamEntryMatchesOption(
    { streamId: "alpha", source: "https://a.example/1" },
    { id: "beta", source: "https://a.example/1" },
  ),
  false,
);

const storage = makeStorage();
let eventSlug = "final";
let live = true;
const options = [
  { id: "alpha", label: "Alpha #1", source: "https://alpha.example/a" },
  { id: "beta", label: "Beta #2", source: "https://beta.example/b" },
];
let clock = 1_000_000;

const cache = createLiveStreamCache({
  getEventSlug: () => eventSlug,
  getStreamOptions: () => options,
  isLivePlayback: () => live,
  storage,
  now: () => clock,
  origin: "https://player.example",
});

cache.prepareForCurrentEvent();
assert.equal(cache.isRecentlyFailed(options[0]), false);
assert.equal(cache.getOptionStatus(options[0]), null);

assert.equal(cache.rememberFailure(options[0], "timeout"), true);
assert.equal(cache.isRecentlyFailed(options[0]), true);
assert.deepEqual(cache.getOptionStatus(options[0]), {
  state: "skipped",
  label: "Skipped",
  detail: "Recently failed. Select it manually to retry.",
});
assert.equal(cache.getRememberedWorkingOption(), null);

const failedKey = liveStreamCacheStorageKey(
  LIVE_FAILED_STREAM_CACHE_STORAGE_PREFIX,
  "final",
);
assert.ok(storage.getItem(failedKey));

assert.equal(cache.rememberSuccess(options[0], "playing"), true);
assert.equal(cache.isRecentlyFailed(options[0]), false);
assert.equal(cache.getRememberedWorkingOption()?.id, "alpha");
assert.equal(
  cache.getPreferredRankedOption()?.id,
  "alpha",
);

const workingKey = liveStreamCacheStorageKey(
  LIVE_WORKING_STREAM_CACHE_STORAGE_PREFIX,
  "final",
);
assert.ok(storage.getItem(workingKey));

assert.equal(cache.rememberSuccess(options[0], "playing"), false);

const reloaded = createLiveStreamCache({
  getEventSlug: () => eventSlug,
  getStreamOptions: () => options,
  isLivePlayback: () => live,
  storage,
  now: () => clock,
  origin: "https://player.example",
});
reloaded.prepareForCurrentEvent();
assert.equal(reloaded.getRememberedWorkingOption()?.id, "alpha");
assert.equal(reloaded.getPreferenceScore(options[0]) > 0, true);

live = false;
cache.prepareForCurrentEvent();
assert.equal(cache.getRememberedWorkingOption(), null);

live = true;
eventSlug = "other";
cache.prepareForCurrentEvent();
assert.equal(cache.getRememberedWorkingOption(), null);
assert.equal(cache.isRecentlyFailed(options[0]), false);

console.log("live-stream-cache tests passed");

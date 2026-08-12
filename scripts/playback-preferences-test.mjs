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
  getAudioLangPreferenceStorageKey,
  getStoredAudioLangForTmdbMovie,
  getStoredSubtitleLangForTmdbMovie,
  getStoredSubtitleStreamPreferenceForTmdbMovie,
  getTvSubtitlePreferenceKey,
  isRecognizedAudioLang,
  normalizePreferredQuality,
  normalizeSubtitlePreference,
  persistAudioLangPreference,
  persistSubtitleLangPreferenceForTarget,
  persistSubtitleStreamPreferenceForTarget,
  resolveSubtitlePreferenceStorageTarget,
  shouldIncludePreferredQualityInUrl,
} = await import("../src-ui/player/playback-preferences.js");

assert.equal(normalizePreferredQuality(""), "1080p");
assert.equal(normalizePreferredQuality("4k"), "2160p");
assert.equal(normalizePreferredQuality("720"), "720p");
assert.equal(normalizePreferredQuality("auto"), "auto");
assert.equal(shouldIncludePreferredQualityInUrl("1080p"), false);
assert.equal(shouldIncludePreferredQualityInUrl("720p"), true);

assert.equal(isRecognizedAudioLang("en"), true);
assert.equal(isRecognizedAudioLang("auto"), true);
assert.equal(isRecognizedAudioLang("english"), false);

assert.equal(normalizeSubtitlePreference("auto"), "");
assert.equal(normalizeSubtitlePreference("OFF"), "off");
assert.equal(normalizeSubtitlePreference("French"), "fr");
assert.equal(getTvSubtitlePreferenceKey("123", 2, 4), "123:s2:e4");
assert.equal(
  getAudioLangPreferenceStorageKey("42"),
  "streamarena-audio-lang:movie:42",
);

const movieTarget = resolveSubtitlePreferenceStorageTarget({
  isTmdbMoviePlayback: true,
  tmdbId: "99",
});
assert.deepEqual(movieTarget, { scope: "movie", key: "99" });

persistSubtitleLangPreferenceForTarget(movieTarget, "es");
assert.equal(getStoredSubtitleLangForTmdbMovie("99"), "es");
persistSubtitleStreamPreferenceForTarget(movieTarget, 2);
assert.deepEqual(getStoredSubtitleStreamPreferenceForTmdbMovie("99"), {
  mode: "on",
  streamIndex: 2,
});
persistSubtitleStreamPreferenceForTarget(movieTarget, -1);
assert.deepEqual(getStoredSubtitleStreamPreferenceForTmdbMovie("99"), {
  mode: "off",
  streamIndex: -1,
});

persistAudioLangPreference("99", "ja");
assert.equal(getStoredAudioLangForTmdbMovie("99"), "ja");
persistAudioLangPreference("99", "auto");
assert.equal(getStoredAudioLangForTmdbMovie("99"), "auto");

console.log("playback-preferences tests passed");

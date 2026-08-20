#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildOrderedRemuxFallbacks,
  buildResolvedRemuxVariantSource,
  createRemuxRouting,
  getBrowserSupportedRemuxVideoCodecs,
} from "../src-ui/player/remux-routing.js";

const sourceHash = "a".repeat(40);
const remoteMkv = "https://download.example.test/Game.of.Thrones.S01E01.HEVC.mkv";
const video = {
  canPlayType(contentType) {
    if (contentType.includes("avc1")) return "probably";
    if (contentType.includes("hvc1")) return "maybe";
    return "";
  },
};
const browserVideoCodecs = getBrowserSupportedRemuxVideoCodecs(video);
assert.deepEqual(browserVideoCodecs, ["h264", "hevc"]);

const routing = createRemuxRouting({
  getOrigin: () => "https://streamarena.test",
  getSelectedSourceHash: () => sourceHash,
  getBrowserVideoCodecs: () => browserVideoCodecs,
});

const automatic = routing.buildSoftwareDecodeUrl(
  remoteMkv,
  91,
  2,
  125,
  -1,
  sourceHash,
  "auto",
);
const automaticMeta = routing.parseTranscodeSource(automatic);
assert.equal(automaticMeta.input, remoteMkv);
assert.equal(automaticMeta.startSeconds, 91);
assert.equal(automaticMeta.audioStreamIndex, 2);
assert.equal(automaticMeta.audioSyncMs, 125);
assert.equal(automaticMeta.sourceHash, sourceHash);
assert.equal(automaticMeta.remuxVideoMode, "auto");
assert.deepEqual(automaticMeta.browserVideoCodecs, ["h264", "hevc"]);

const normalizeFallback = buildResolvedRemuxVariantSource(
  {
    playableUrl: automatic,
    sourceHash,
    selectedAudioStreamIndex: null,
    selectedSubtitleStreamIndex: null,
  },
  {
    sourceHash,
    audioSyncMs: 125,
    remuxVideoMode: "normalize",
    parseTranscodeSource: routing.parseTranscodeSource,
    buildSoftwareDecodeUrl: routing.buildSoftwareDecodeUrl,
  },
);
const normalizeMeta = routing.parseTranscodeSource(normalizeFallback);
assert.equal(normalizeMeta.input, remoteMkv);
assert.equal(normalizeMeta.startSeconds, 91, "fallback must preserve the active seek");
assert.equal(normalizeMeta.audioStreamIndex, 2, "null selection must preserve remux metadata");
assert.equal(normalizeMeta.remuxVideoMode, "normalize");
assert.deepEqual(
  normalizeMeta.browserVideoCodecs,
  ["h264", "hevc"],
  "remote remux variants must carry the browser codec capability hint",
);

assert.deepEqual(
  buildOrderedRemuxFallbacks({
    normalizeSource: normalizeFallback,
    nativePreferredSource: automatic,
    fallbackUrls: ["https://backup.example.test/video.mp4"],
    parseTranscodeSource: routing.parseTranscodeSource,
  }),
  [normalizeFallback, "https://backup.example.test/video.mp4"],
  "copy failure must try explicit normalize next and skip the same remux input",
);

const defensiveRouting = createRemuxRouting({
  getOrigin: () => "https://streamarena.test",
  getBrowserVideoCodecs: () => "not-an-array",
});
assert.doesNotThrow(() => defensiveRouting.buildSoftwareDecodeUrl(remoteMkv));
assert.deepEqual(
  defensiveRouting.parseTranscodeSource(
    defensiveRouting.buildSoftwareDecodeUrl(remoteMkv),
  ).browserVideoCodecs,
  [],
);

console.log("remux-routing-test: ok");

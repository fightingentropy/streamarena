#!/usr/bin/env node
import assert from "node:assert/strict";
import { createPlaybackRouting } from "../src-ui/player/playback-routing.js";

const hashA = "a".repeat(40);
const hashB = "b".repeat(40);
const hashMp4 = "c".repeat(40);
const hashHls = "d".repeat(40);
const hashHlsBackup = "e".repeat(40);

const mkv1080 = {
  sourceHash: hashA,
  primary: "Off.Campus.S01E01.1080p.WEB.h264",
  filename: "Off.Campus.S01E01.1080p.WEB.h264.mkv",
  qualityLabel: "1080p",
  container: "mkv",
  seeders: 490,
};
const mkv2160 = {
  sourceHash: hashB,
  primary: "Off.Campus.S01E01.MULTI.2160p.WEB.h265",
  filename: "Off.Campus.S01E01.MULTI.2160p.WEB.h265.mkv",
  qualityLabel: "4K HDR",
  container: "mkv",
  seeders: 377,
};
const mp41080 = {
  sourceHash: hashMp4,
  primary: "Off.Campus.S01E01.1080p.WEB.h264",
  filename: "Off.Campus.S01E01.1080p.WEB.h264.mp4",
  qualityLabel: "1080p",
  container: "mp4",
  seeders: 120,
};
const hlsDefault = {
  sourceHash: hashHls,
  primary: "Meridian",
  provider: "LivNet",
  qualityLabel: "HLS",
  container: "hls",
  seeders: 0,
  score: 1_001_000,
};
const hlsBackup = {
  ...hlsDefault,
  sourceHash: hashHlsBackup,
  primary: "Aether backup",
  score: 1_000_000,
};

const desktopRouting = createPlaybackRouting({
  getPreferredSourceFormats: () => ["mp4", "mkv"],
  getSupportedSourceFormatSet: () => new Set(["mp4", "mkv"]),
});

assert.equal(
  desktopRouting.getPreferredDefaultSourceHash([mkv1080, mkv2160]),
  hashB,
  "unpinned mkv-only lists should default to the highest-quality release",
);

assert.equal(
  desktopRouting.getPreferredDefaultSourceHash([mkv2160, mkv1080, mp41080]),
  hashMp4,
  "desktop still prefers an mp4 match when one exists",
);

assert.equal(
  desktopRouting.getPreferredDefaultSourceHash([
    mkv2160,
    hlsBackup,
    hlsDefault,
    mkv1080,
    mp41080,
  ]),
  hashHls,
  "a fresh mixed source list should stay on HLS instead of auto-selecting a torrent",
);

const localTorrentRouting = createPlaybackRouting({
  getPreferredSourceFormats: () => ["mp4", "mkv"],
  getSupportedSourceFormatSet: () => new Set(["mp4", "mkv"]),
  shouldPreferDirectMp4Default: () => false,
});

assert.equal(
  localTorrentRouting.getPreferredDefaultSourceHash([mkv2160, mkv1080, mp41080]),
  hashA,
  "local torrent defaults to the healthiest swarm instead of a weak mp4",
);

assert.equal(
  localTorrentRouting.getPreferredDefaultSourceHash([
    mkv2160,
    hlsBackup,
    hlsDefault,
    mkv1080,
    mp41080,
  ]),
  hashHls,
  "enabling local torrent must not replace an available HLS default",
);

const mobileRouting = createPlaybackRouting({
  shouldPreferMobileLightTmdbSources: () => true,
  getPreferredSourceFormats: () => ["mp4", "mkv"],
  getSupportedSourceFormatSet: () => new Set(["mp4", "mkv"]),
});

assert.equal(
  mobileRouting.getPreferredDefaultSourceHash([mkv1080, mkv2160]),
  hashA,
  "mobile-light defaults keep the lighter 1080p mkv ahead of 4K",
);

console.log("playback-routing-test: ok");

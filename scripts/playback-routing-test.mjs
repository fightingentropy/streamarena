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

globalThis.window = {
  navigator: {
    userAgent: "Mozilla/5.0 Chrome/150 Safari/537.36",
    vendor: "Google Inc.",
    platform: "MacIntel",
    maxTouchPoints: 0,
  },
  MediaSource: {
    isTypeSupported: () => true,
  },
  matchMedia: () => ({ matches: false }),
  location: { origin: "https://streamarena.test" },
};
const remoteHevcMkv =
  "https://download.example.test/Game.of.Thrones.S01E01.HEVC.x265.mkv";
const automaticHevcRemux =
  `/api/remux?${new URLSearchParams({
    input: remoteHevcMkv,
    videoMode: "auto",
    videoCodecs: "h264,hevc",
  })}`;
const hevcCopyRouting = createPlaybackRouting({
  getOrigin: () => "https://streamarena.test",
  getBrowserVideoCodecs: () => ["h264", "hevc"],
  parseTranscodeSource: (source) => {
    const url = new URL(source, "https://streamarena.test");
    if (url.pathname !== "/api/remux") return null;
    return { input: url.searchParams.get("input") || "" };
  },
});
assert.equal(
  hevcCopyRouting.buildPreferredBrowserPlaybackSource(
    automaticHevcRemux,
    remoteHevcMkv,
  ),
  automaticHevcRemux,
  "a browser that declares HEVC support must keep the copy-capable remux instead of starting HLS",
);

const highRiskHevcMkv =
  "https://download.example.test/Game.of.Thrones.S01E01.DV.HDR.10bit.HEVC.x265.mkv";
const highRiskHevcRemux =
  `/api/remux?${new URLSearchParams({
    input: highRiskHevcMkv,
    videoMode: "auto",
    videoCodecs: "h264,hevc",
  })}`;
assert.match(
  hevcCopyRouting.buildPreferredBrowserPlaybackSource(
    highRiskHevcRemux,
    highRiskHevcMkv,
  ),
  /^\/api\/hls\/master\.m3u8\?/,
  "generic HEVC support must not copy-remux an unproven DV/HDR/Main10 profile",
);

const unsupportedHevcRouting = createPlaybackRouting({
  getOrigin: () => "https://streamarena.test",
  getBrowserVideoCodecs: () => ["h264"],
  parseTranscodeSource: (source) => {
    const url = new URL(source, "https://streamarena.test");
    if (url.pathname !== "/api/remux") return null;
    return { input: url.searchParams.get("input") || "" };
  },
});
assert.match(
  unsupportedHevcRouting.buildPreferredBrowserPlaybackSource(
    automaticHevcRemux,
    remoteHevcMkv,
  ),
  /^\/api\/hls\/master\.m3u8\?/,
  "an HEVC-unsafe browser should retain the HLS normalization path",
);

console.log("playback-routing-test: ok");

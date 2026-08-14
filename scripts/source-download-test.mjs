import assert from "node:assert/strict";
import {
  buildSourceExportUrl,
  createSourceDownloadController,
  ensureExportUrlReady,
  pickCurrentPlaybackExportInput,
  pickExportFilename,
  pickResolvedExportInput,
  sanitizeExportFilename,
  startBrowserFileDownload,
} from "../src-ui/player/source-download.js";
import { normalizeSourceHash } from "../src-ui/player/sources.js";

assert.equal(sanitizeExportFilename("Game.of.Thrones.S02E10.mkv"), "Game.of.Thrones.S02E10");
assert.equal(sanitizeExportFilename("Game.of.Thrones.S02E10"), "Game.of.Thrones.S02E10");
assert.equal(sanitizeExportFilename("/api/local-torrent/stream?sourceHash=abc"), "stream");
assert.equal(sanitizeExportFilename("../../../etc/passwd"), "passwd");
assert.equal(sanitizeExportFilename(""), "");

const torrentInput = "/api/local-torrent/stream?sourceHash=abc";
assert.equal(
  buildSourceExportUrl(torrentInput),
  `/api/download/export.mp4?${new URLSearchParams({ input: torrentInput })}`,
);
assert.equal(
  buildSourceExportUrl(torrentInput, {
    audioStreamIndex: 1,
    filename: "Game.of.Thrones.S02E10.mkv",
  }),
  `/api/download/export.mp4?${new URLSearchParams({
    input: torrentInput,
    audioStream: "1",
    filename: "Game.of.Thrones.S02E10",
  })}`,
);

assert.equal(
  pickCurrentPlaybackExportInput({
    activeTrackSourceInput: torrentInput,
    lastRequestedPlaybackSource: "live-iframe:%2Fapi%2Flive%2Fhls.m3u8",
    extractPlaybackSourceInput: () => "ignored",
    parseLiveIframePlaybackSource: () => "/api/live/hls.m3u8",
  }),
  torrentInput,
);
assert.equal(
  pickCurrentPlaybackExportInput({
    lastRequestedPlaybackSource: "live-iframe:encoded",
    extractPlaybackSourceInput: () => "ignored",
    parseLiveIframePlaybackSource: () => "/api/live/hls.m3u8?sig=1",
  }),
  "/api/live/hls.m3u8?sig=1",
);
assert.equal(
  pickResolvedExportInput({
    sourceInput: torrentInput,
    playableUrl: "/api/hls/master.m3u8?input=other",
  }),
  torrentInput,
);
assert.equal(
  pickExportFilename(
    { primary: "Fallback name", filename: "shown.mkv" },
    { filename: "resolved.mkv" },
  ),
  "resolved.mkv",
);

const clicks = [];
const removed = [];
const mockDoc = {
  body: {
    child: null,
    appendChild(node) {
      this.child = node;
    },
    removeChild(node) {
      removed.push(node);
    },
  },
  createElement() {
    return {
      href: "",
      rel: "",
      setAttribute() {},
      click() {
        clicks.push(this.href);
      },
      remove() {
        removed.push(this);
      },
    };
  },
};
assert.equal(startBrowserFileDownload("/api/download/export.mp4?input=a", mockDoc), true);
assert.deepEqual(clicks, ["/api/download/export.mp4?input=a"]);
assert.equal(removed.length, 1);

let headCalls = 0;
await ensureExportUrlReady("/api/download/export.mp4?input=a", async () => {
  headCalls += 1;
  return { ok: true, status: 200 };
});
assert.equal(headCalls, 1);
await assert.rejects(
  () =>
    ensureExportUrlReady("/api/download/export.mp4?input=a", async () => ({
      ok: false,
      status: 400,
    })),
  /isn't ready to download/,
);

const hashA = "a".repeat(40);
const hashB = "b".repeat(40);
const downloadClicks = [];
const resolveCalls = [];
let preferredProvider = "fastest";
const downloadDoc = {
  body: {
    appendChild() {},
    removeChild() {},
  },
  createElement() {
    return {
      href: "",
      rel: "",
      setAttribute() {},
      click() {
        downloadClicks.push(this.href);
      },
      remove() {},
    };
  },
};

function createDownloadController(overrides = {}) {
  return createSourceDownloadController({
    normalizeSourceHash,
    getSelectedSourceHash: () => hashA,
    getPendingSourceSwitchHash: () => "",
    getActiveTrackSourceInput: () => "/api/local-torrent/stream?sourceHash=a",
    getLastRequestedPlaybackSource: () => "",
    extractPlaybackSourceInput: (value) => String(value || "").trim(),
    parseLiveIframePlaybackSource: () => "",
    isTmdbResolvedPlayback: () => true,
    getSourceOptionByHash: (hash) => ({
      sourceHash: hash,
      primary: "Game.of.Thrones.S02E10.mkv",
      filename: "Game.of.Thrones.S02E10.mkv",
      container: hash === hashB ? "mkv" : "mkv",
    }),
    isSourceOptionEmbed: () => false,
    getManualSourceSwitchTimeouts: () => ({
      resolveTimeoutMs: 300_000,
      startupTimeoutMs: 120_000,
    }),
    getUserLocalTorrentEnabled: () => true,
    getUserRealDebridConfigured: () => false,
    getPreferredResolverProvider: () => preferredProvider,
    setPreferredResolverProvider: (value) => {
      preferredProvider = value;
    },
    resolveTmdbSourcesAndPlay: async (options) => {
      resolveCalls.push(options);
      return {
        resolved: {
          sourceInput: "/api/local-torrent/stream?sourceHash=b",
          filename: "Other.Source.mkv",
          selectedAudioStreamIndex: 1,
        },
      };
    },
    getActiveAudioStreamIndex: () => -1,
    getSelectedAudioStreamIndex: () => 0,
    getCurrentTmdbResolvedFilename: () => "Game.of.Thrones.S02E10.mkv",
    normalizeResolverFailureMessage: (error, fallback) =>
      error instanceof Error ? error.message : fallback,
    syncSourceSelectionState: () => {},
    renderSelectedSourceDetails: () => {},
    fetchImpl: async () => ({ ok: true, status: 200 }),
    documentRef: downloadDoc,
    ...overrides,
  });
}

const currentDownload = createDownloadController();
await currentDownload.download(hashA);
assert.equal(resolveCalls.length, 0, "playing source should not re-resolve");
assert.equal(downloadClicks.length, 1);
assert.match(downloadClicks[0], /input=%2Fapi%2Flocal-torrent%2Fstream/);
assert.match(downloadClicks[0], /filename=Game.of.Thrones.S02E10/);

const otherDownload = createDownloadController();
await otherDownload.download(hashB);
assert.equal(resolveCalls.length, 1);
assert.equal(resolveCalls[0].applyPlayback, false);
assert.equal(resolveCalls[0].requestSourceHash, hashB);
assert.match(downloadClicks[1], /sourceHash%3Db/);
assert.equal(preferredProvider, "fastest");

console.log("source-download-test: ok");

import assert from "node:assert/strict";
import {
  buildSourceExportUrl,
  createSourceDownloadController,
  ensureExportUrlReady,
  pickCurrentPlaybackExportInput,
  sanitizeExportFilename,
  startBrowserFileDownload,
} from "../src-ui/player/source-download.js";
import { getCopyableVideoLink } from "../src-ui/player/video-context-menu.js";

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
assert.equal(getCopyableVideoLink("/api/hls/master.m3u8?input=abc", "https://streamarena.xyz/watch/movie/1"), "https://streamarena.xyz/api/hls/master.m3u8?input=abc");
assert.equal(getCopyableVideoLink("https://cdn.test/video.m3u8?sig=123", "https://streamarena.xyz"), "https://cdn.test/video.m3u8?sig=123");
for (const value of ["", "blob:https://streamarena.xyz/123", "javascript:alert(1)", "data:video/mp4;base64,abc"]) {
  assert.equal(getCopyableVideoLink(value, "https://streamarena.xyz"), "", "copy links must not be blobs or non-network URLs");
}

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

const downloadClicks = [];
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
    getCurrentPlayback: () => ({
      input: "/api/local-torrent/stream?sourceHash=a",
      filename: "Game.of.Thrones.S02E10.mkv",
      audioStreamIndex: 1,
    }),
    fetchImpl: async () => ({ ok: true, status: 200 }),
    documentRef: downloadDoc,
    ...overrides,
  });
}

const currentDownload = createDownloadController();
await currentDownload.download();
assert.equal(downloadClicks.length, 1);
assert.match(downloadClicks[0], /input=%2Fapi%2Flocal-torrent%2Fstream/);
assert.match(downloadClicks[0], /filename=Game.of.Thrones.S02E10/);
assert.match(downloadClicks[0], /audioStream=1/);
assert.equal(currentDownload.getState(), "handedOff");
assert.match(currentDownload.getStatusMessage(), /browser’s downloads/);

let releaseHead;
let pendingHeadCalls = 0;
let currentInput = "/api/video-a.mp4";
const pendingDownload = createDownloadController({
  getCurrentPlayback: () => ({ input: currentInput }),
  fetchImpl: () => {
    pendingHeadCalls += 1;
    return new Promise((resolve) => { releaseHead = resolve; });
  },
});
const pending = pendingDownload.download();
assert.equal(pendingDownload.getState(), "preparing");
currentInput = "/api/video-b.mp4";
await pendingDownload.download();
assert.equal(pendingHeadCalls, 1, "repeated clicks must not launch competing exports");
releaseHead({ ok: true, status: 200 });
await pending;
assert.match(downloadClicks.at(-1), /input=%2Fapi%2Fvideo-a.mp4/, "capture the current video at the moment Download was clicked");
assert.equal(pendingDownload.getState(), "handedOff", "handoff is not completed-download proof");

let failExport = true;
const retryDownload = createDownloadController({
  fetchImpl: async () => ({ ok: !failExport, status: failExport ? 503 : 200 }),
});
const clicksBeforeFailure = downloadClicks.length;
await retryDownload.download();
assert.equal(retryDownload.getState(), "error");
assert.equal(downloadClicks.length, clicksBeforeFailure, "a failed readiness check must not start a transfer");
failExport = false;
await retryDownload.download();
assert.equal(retryDownload.getState(), "handedOff");
assert.equal(downloadClicks.length, clicksBeforeFailure + 1);

const unavailableBrowser = createDownloadController({ documentRef: null });
await unavailableBrowser.download();
assert.equal(unavailableBrowser.getState(), "error");
const loadingVideo = createDownloadController({ getCurrentPlayback: () => null });
const clicksBeforeLoading = downloadClicks.length;
await loadingVideo.download();
assert.equal(loadingVideo.getState(), "error");
assert.equal(downloadClicks.length, clicksBeforeLoading);

console.log("source-download-test: ok");

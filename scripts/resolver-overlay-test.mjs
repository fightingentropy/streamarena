#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  createResolverOverlayController,
  normalizeResolverFailureMessage,
} from "../src-ui/player/resolver-overlay.js";

assert.equal(
  normalizeResolverFailureMessage("Add a Real-Debrid API key in Settings."),
  "Add a Real-Debrid API key in Settings.",
);
assert.equal(
  normalizeResolverFailureMessage("MEDIA_ERR_SRC_NOT_SUPPORTED"),
  "This video could not be opened. Try another source.",
);
assert.equal(
  normalizeResolverFailureMessage("open context failed", undefined, {
    isExplicitLocalUploadSource: true,
  }),
  "This local video file could not be opened. It may be missing from the library or unsupported.",
);
assert.equal(
  normalizeResolverFailureMessage("Resolving stream timed out", undefined, {
    preferredResolverProvider: "fastest",
  }),
  "This source could not start quickly enough. Try another source.",
);
assert.equal(
  normalizeResolverFailureMessage("first byte wait failed", undefined, {
    preferredResolverProvider: "local-torrent",
  }),
  "Local torrent could not start this source quickly enough. Try another source.",
);
assert.equal(
  normalizeResolverFailureMessage("502 Bad Gateway", undefined, {
    isLivePlayback: true,
    hasAlternatePlaybackSource: false,
    preferredResolverProvider: "real-debrid",
  }),
  "This live channel is temporarily unavailable. Please try again shortly.",
);
assert.equal(
  normalizeResolverFailureMessage("502 Bad Gateway", undefined, {
    isLivePlayback: true,
    hasAlternatePlaybackSource: true,
  }),
  "This live stream could not start. Try another source.",
);
assert.equal(
  normalizeResolverFailureMessage("MEDIA_ERR_SRC_NOT_SUPPORTED", undefined, {
    isLivePlayback: true,
    hasAlternatePlaybackSource: false,
  }),
  "This live channel is temporarily unavailable. Please try again shortly.",
);
assert.equal(
  normalizeResolverFailureMessage("Selected source is unavailable. Try another source.", undefined, {
    isLivePlayback: true,
    hasAlternatePlaybackSource: false,
  }),
  "This live channel is temporarily unavailable. Please try again shortly.",
);

function makeEl(hidden = true) {
  return {
    hidden,
    textContent: "",
    classList: {
      tokens: new Set(),
      contains(name) {
        return this.tokens.has(name);
      },
      add(...names) {
        names.forEach((name) => this.tokens.add(name));
      },
      remove(...names) {
        names.forEach((name) => this.tokens.delete(name));
      },
      toggle(name, force) {
        if (force) this.tokens.add(name);
        else this.tokens.delete(name);
      },
    },
  };
}

const overlay = makeEl(true);
const status = makeEl(true);
const title = makeEl(true);
const detail = makeEl(true);
const countdown = makeEl(true);
const retry = makeEl(true);
const alternate = makeEl(true);
const loader = makeEl(false);
const seekLoading = makeEl(true);
let scheduled = [];
let liveIframe = false;
let controlsHidden = 0;

const overlayController = createResolverOverlayController({
  getOverlay: () => overlay,
  getStatus: () => status,
  getTitle: () => title,
  getDetail: () => detail,
  getCountdown: () => countdown,
  getRetryButton: () => retry,
  getAlternateButton: () => alternate,
  getLoader: () => loader,
  getSeekLoadingOverlay: () => seekLoading,
  hasExplicitSource: () => false,
  isLiveIframePlaybackActive: () => liveIframe,
  scheduleControlsHide: () => {
    controlsHidden += 1;
  },
  seekLoadingTimeoutMs: 25,
  setTimeoutFn: (callback) => {
    scheduled.push(callback);
    return scheduled.length;
  },
  clearTimeoutFn: () => {
    scheduled = [];
  },
});

overlayController.showSeekLoadingIndicator();
assert.equal(seekLoading.hidden, false);
overlayController.showResolver("Finding a source…");
assert.equal(overlay.hidden, false);
assert.equal(seekLoading.hidden, true);
assert.equal(overlayController.isResolvingSource(), true);

overlayController.showResolver("Unable to load this video.", {
  isError: true,
  showRetry: true,
  showAlternate: true,
});
assert.equal(overlay.classList.contains("is-error"), true);
assert.equal(retry.hidden, false);
assert.equal(alternate.hidden, false);
assert.equal(overlayController.isResolvingSource(), false);

liveIframe = true;
overlayController.hideResolver();
assert.equal(overlay.hidden, true);
assert.equal(controlsHidden, 1);

console.log("resolver-overlay tests passed");

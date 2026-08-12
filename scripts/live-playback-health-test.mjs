#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  LIVE_STARTUP_HEALTH_TIMEOUT_MS,
  LIVE_VISUAL_HEALTH_GRACE_MS,
  LIVE_VISUAL_HEALTH_MAX_BLANK_SAMPLES,
  analyzeLiveVideoBlankness,
  createLivePlaybackHealthWatch,
  hasLivePlaybackStarted,
} from "../src-ui/player/live-playback-health.js";

assert.equal(
  hasLivePlaybackStarted({ readyState: 2 }),
  true,
);
assert.equal(
  hasLivePlaybackStarted({ videoWidth: 1280 }),
  true,
);
assert.equal(
  hasLivePlaybackStarted({ currentTimeSeconds: 0.3 }),
  true,
);
assert.equal(
  hasLivePlaybackStarted({ readyState: 1, currentTimeSeconds: 0.1 }),
  false,
);

function makePixels({ r = 0, g = 0, b = 0, count = 4 } = {}) {
  const data = new Uint8ClampedArray(count * 4);
  for (let index = 0; index < count; index += 1) {
    const offset = index * 4;
    data[offset] = r;
    data[offset + 1] = g;
    data[offset + 2] = b;
    data[offset + 3] = 255;
  }
  return data;
}

const blank = analyzeLiveVideoBlankness(makePixels());
assert.equal(blank.isBlank, true);
assert.equal(blank.avgLuma, 0);

const bright = analyzeLiveVideoBlankness(makePixels({ r: 255, g: 255, b: 255 }));
assert.equal(bright.isBlank, false);
assert.equal(analyzeLiveVideoBlankness(new Uint8ClampedArray()), null);

function createWatch(overrides = {}) {
  let nowMs = 0;
  let live = true;
  let iframe = false;
  let optionCount = 2;
  let fallbackInFlight = false;
  let recoverable = true;
  let activeSource = true;
  let paused = false;
  let hidden = false;
  let currentTime = 0;
  let source = "https://a.example/live";
  let streamId = "alpha";
  let lastSourceSetAt = 0;
  const visualFailovers = [];
  const startupFailovers = [];
  const intervals = [];
  const timeouts = [];

  const watch = createLivePlaybackHealthWatch({
    isLivePlayback: () => live,
    isIframePlayback: () => iframe,
    getStreamOptionCount: () => optionCount,
    isAutoFallbackInFlight: () => fallbackInFlight,
    hasRecoverablePlaybackSource: () => recoverable,
    hasActiveSource: () => activeSource,
    isVideoPaused: () => paused,
    isDocumentHidden: () => hidden,
    getVideo: () => ({
      readyState: 0,
      videoWidth: 1920,
      videoHeight: 1080,
    }),
    getCurrentTimeSeconds: () => currentTime,
    getCurrentSource: () => source,
    getSelectedStreamId: () => streamId,
    getLastSourceSetAt: () => lastSourceSetAt,
    onVisualFailover: () => visualFailovers.push("visual"),
    onStartupFailover: () => startupFailovers.push("startup"),
    now: () => nowMs,
    setIntervalFn: (callback) => {
      intervals.push(callback);
      return intervals.length;
    },
    clearIntervalFn: () => {
      intervals.length = 0;
    },
    setTimeoutFn: (callback, delayMs) => {
      timeouts.push({ callback, delayMs });
      return timeouts.length;
    },
    clearTimeoutFn: () => {
      timeouts.length = 0;
    },
    readVideoPixels: () => makePixels(),
    ...overrides,
  });

  return {
    watch,
    visualFailovers,
    startupFailovers,
    intervals,
    timeouts,
    set nowMs(value) {
      nowMs = value;
    },
    set live(value) {
      live = value;
    },
    set paused(value) {
      paused = value;
    },
    set hidden(value) {
      hidden = value;
    },
    set optionCount(value) {
      optionCount = value;
    },
    set currentTime(value) {
      currentTime = value;
    },
    set source(value) {
      source = value;
    },
    set lastSourceSetAt(value) {
      lastSourceSetAt = value;
    },
  };
}

const visual = createWatch();
visual.nowMs = LIVE_VISUAL_HEALTH_GRACE_MS + 1;
visual.watch.startVisual();
assert.equal(visual.intervals.length, 1);
for (let sample = 0; sample < LIVE_VISUAL_HEALTH_MAX_BLANK_SAMPLES - 1; sample += 1) {
  visual.intervals[0]();
}
assert.equal(visual.visualFailovers.length, 0);
visual.intervals[0]();
assert.equal(visual.visualFailovers.length, 1);

const pausedVisual = createWatch();
pausedVisual.nowMs = LIVE_VISUAL_HEALTH_GRACE_MS + 1;
pausedVisual.watch.startVisual();
pausedVisual.paused = true;
pausedVisual.intervals[0]();
pausedVisual.intervals[0]();
pausedVisual.intervals[0]();
pausedVisual.intervals[0]();
assert.equal(pausedVisual.visualFailovers.length, 0);

const graceVisual = createWatch();
graceVisual.lastSourceSetAt = 0;
graceVisual.nowMs = LIVE_VISUAL_HEALTH_GRACE_MS - 1;
graceVisual.watch.startVisual();
graceVisual.intervals[0]();
graceVisual.intervals[0]();
graceVisual.intervals[0]();
graceVisual.intervals[0]();
assert.equal(graceVisual.visualFailovers.length, 0);

const startup = createWatch({
  getVideo: () => ({ readyState: 0, videoWidth: 0, videoHeight: 0 }),
});
startup.watch.armStartup();
assert.equal(startup.watch.isStartupArmed(), true);
assert.equal(startup.timeouts.length, 1);
assert.equal(startup.timeouts[0].delayMs, LIVE_STARTUP_HEALTH_TIMEOUT_MS);
startup.nowMs = LIVE_STARTUP_HEALTH_TIMEOUT_MS;
startup.timeouts[0].callback();
assert.equal(startup.startupFailovers.length, 1);

const started = createWatch({
  getVideo: () => ({ readyState: 2, videoWidth: 0, videoHeight: 0 }),
});
started.watch.armStartup();
started.nowMs = LIVE_STARTUP_HEALTH_TIMEOUT_MS;
started.timeouts[0].callback();
assert.equal(started.startupFailovers.length, 0);
assert.equal(started.watch.isStartupArmed(), false);

const early = createWatch({
  getVideo: () => ({ readyState: 0, videoWidth: 0, videoHeight: 0 }),
});
early.watch.armStartup();
early.nowMs = LIVE_STARTUP_HEALTH_TIMEOUT_MS / 2;
early.timeouts[0].callback();
assert.equal(early.startupFailovers.length, 0);
assert.equal(early.timeouts.at(-1).delayMs, LIVE_STARTUP_HEALTH_TIMEOUT_MS / 2);

const skipped = createWatch();
skipped.optionCount = 1;
skipped.watch.armStartup();
assert.equal(skipped.watch.isStartupArmed(), false);
assert.equal(skipped.timeouts.length, 0);

console.log("live-playback-health tests passed");

#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  LIVE_EDGE_PIN_RATIO,
  LIVE_EDGE_PLAYBACK_OFFSET_SECONDS,
  LIVE_EDGE_REJOIN_TOLERANCE_SECONDS,
  clampLiveSeekTargetSeconds,
  getLiveEdgeTargetSeconds,
  getLiveSeekableWindow,
  getSeekTargetSecondsFromRatio,
  shouldPinLiveEdgeFromTarget,
} from "../src-ui/player/live-seek.js";

function makeVideo({ ranges = [], duration = Number.NaN } = {}) {
  return {
    duration,
    seekable: {
      length: ranges.length,
      start(index) {
        return ranges[index].start;
      },
      end(index) {
        return ranges[index].end;
      },
    },
  };
}

assert.equal(getLiveSeekableWindow(null, true), null);
assert.equal(getLiveSeekableWindow(makeVideo(), false), null);

const windowFromRanges = getLiveSeekableWindow(
  makeVideo({ ranges: [{ start: 10, end: 110 }] }),
  true,
);
assert.deepEqual(windowFromRanges, { start: 10, end: 110, duration: 100 });

const windowFromDuration = getLiveSeekableWindow(
  makeVideo({ duration: 42 }),
  true,
);
assert.deepEqual(windowFromDuration, { start: 0, end: 42, duration: 42 });

assert.equal(getLiveEdgeTargetSeconds(null), null);
assert.equal(
  getLiveEdgeTargetSeconds(windowFromRanges),
  110 - LIVE_EDGE_PLAYBACK_OFFSET_SECONDS,
);

assert.equal(clampLiveSeekTargetSeconds(Number.NaN, windowFromRanges), 0);
assert.equal(clampLiveSeekTargetSeconds(5, windowFromRanges), 10);
assert.equal(clampLiveSeekTargetSeconds(200, windowFromRanges), 110);
assert.equal(clampLiveSeekTargetSeconds(55, windowFromRanges), 55);
assert.equal(clampLiveSeekTargetSeconds(-3, null), 0);

assert.equal(
  getSeekTargetSecondsFromRatio(1, {
    isLivePlayback: true,
    liveWindow: windowFromRanges,
  }),
  getLiveEdgeTargetSeconds(windowFromRanges),
);
assert.equal(
  getSeekTargetSecondsFromRatio(LIVE_EDGE_PIN_RATIO, {
    isLivePlayback: true,
    liveWindow: windowFromRanges,
  }),
  getLiveEdgeTargetSeconds(windowFromRanges),
);
assert.equal(
  getSeekTargetSecondsFromRatio(0.5, {
    isLivePlayback: true,
    liveWindow: windowFromRanges,
  }),
  60,
);
assert.equal(
  getSeekTargetSecondsFromRatio(0.25, { fallbackDurationSeconds: 200 }),
  50,
);

const liveEdgeTarget = getLiveEdgeTargetSeconds(windowFromRanges);
assert.equal(shouldPinLiveEdgeFromTarget(liveEdgeTarget, liveEdgeTarget), true);
assert.equal(
  shouldPinLiveEdgeFromTarget(
    liveEdgeTarget - LIVE_EDGE_REJOIN_TOLERANCE_SECONDS,
    liveEdgeTarget,
  ),
  true,
);
assert.equal(
  shouldPinLiveEdgeFromTarget(
    liveEdgeTarget - LIVE_EDGE_REJOIN_TOLERANCE_SECONDS - 0.1,
    liveEdgeTarget,
  ),
  false,
);
assert.equal(shouldPinLiveEdgeFromTarget(0, Number.NaN), true);

console.log("Live seek/edge helper tests passed.");

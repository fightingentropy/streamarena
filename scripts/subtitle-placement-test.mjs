#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  SUBTITLE_CUE_POSITION_PERCENT,
  SUBTITLE_CUE_SIZE_PERCENT,
  SUBTITLE_FALLBACK_LINE_PERCENT,
  SUBTITLE_LINE_FROM_BOTTOM,
  SUBTITLE_MATTE_LINE_LIFT_PERCENT,
  applySubtitleCuePlacement,
  computeSubtitleLinePercentInBottomMatte,
  nudgeSubtitleTrackPlacementUp,
  resolveSubtitleTrackLinePercent,
} from "../src-ui/player/subtitle-placement.js";

assert.equal(
  computeSubtitleLinePercentInBottomMatte({
    viewportWidth: 0,
    viewportHeight: 1080,
    mediaWidth: 1920,
    mediaHeight: 1080,
  }),
  null,
);

const letterboxed = computeSubtitleLinePercentInBottomMatte({
  viewportWidth: 1920,
  viewportHeight: 1080,
  mediaWidth: 1920,
  mediaHeight: 800,
});
assert.equal(typeof letterboxed, "number");
assert.ok(letterboxed > 50);
assert.ok(letterboxed <= 100);

assert.equal(
  computeSubtitleLinePercentInBottomMatte({
    viewportWidth: 1920,
    viewportHeight: 1080,
    mediaWidth: 1920,
    mediaHeight: 1080,
  }),
  null,
);

assert.equal(resolveSubtitleTrackLinePercent(null), SUBTITLE_FALLBACK_LINE_PERCENT);
assert.equal(
  resolveSubtitleTrackLinePercent(90),
  90 - SUBTITLE_MATTE_LINE_LIFT_PERCENT,
);

const cue = {
  snapToLines: true,
  line: 0,
  position: 0,
  size: 0,
  align: "start",
};
assert.equal(applySubtitleCuePlacement(cue, 82.5), true);
assert.equal(cue.snapToLines, false);
assert.equal(cue.line, 82.5);
assert.equal(cue.position, SUBTITLE_CUE_POSITION_PERCENT);
assert.equal(cue.size, SUBTITLE_CUE_SIZE_PERCENT);
assert.equal(cue.align, "center");

const lineOnlyCue = { position: 10 };
assert.equal(applySubtitleCuePlacement(lineOnlyCue, 70), true);
assert.equal(lineOnlyCue.line, SUBTITLE_LINE_FROM_BOTTOM);

const track = {
  cues: [{ snapToLines: true, line: 0, position: 0, size: 0, align: "start" }],
};
nudgeSubtitleTrackPlacementUp(track, 90);
assert.equal(track.cues[0].line, 90 - SUBTITLE_MATTE_LINE_LIFT_PERCENT);

console.log("Subtitle placement helper tests passed.");

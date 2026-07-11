#!/usr/bin/env node
import assert from "node:assert/strict";
import { createLiveIframePlaybackClock } from "../src-ui/player/live-iframe-playback-clock.js";

function createHarness() {
  const state = {
    nowMs: 0,
    active: true,
    visible: true,
  };
  const clock = createLiveIframePlaybackClock({
    now: () => state.nowMs,
    isActive: () => state.active,
    isVisible: () => state.visible,
  });
  return { clock, state };
}

function run(label, test) {
  test();
  console.log(`✓ ${label}`);
}

run("autoplay starts at a zero-valued monotonic timestamp", () => {
  const { clock, state } = createHarness();
  clock.start({ startSeconds: 12.5, autoplay: true });

  assert.equal(clock.isPaused(), false);
  assert.equal(clock.isRunning(), true);
  state.nowMs = 2_500;
  assert.equal(clock.getSeconds(), 15);
});

run("explicit pause freezes progress and play continues from that base", () => {
  const { clock, state } = createHarness();
  clock.start({ startSeconds: 20, autoplay: true });
  state.nowMs = 1_750;
  clock.pause();

  assert.equal(clock.isPaused(), true);
  assert.equal(clock.isRunning(), false);
  state.nowMs = 9_000;
  assert.equal(clock.getSeconds(), 21.75);

  clock.play();
  assert.equal(clock.isPaused(), false);
  assert.equal(clock.isRunning(), true);
  state.nowMs = 10_250;
  assert.equal(clock.getSeconds(), 23);
});

run("autoplay false records paused intent without starting", () => {
  const { clock, state } = createHarness();
  clock.start({ startSeconds: 7, autoplay: false });
  state.nowMs = 5_000;

  assert.equal(clock.isPaused(), true);
  assert.equal(clock.isRunning(), false);
  assert.equal(clock.getSeconds(), 7);
});

run("visibility suspension preserves play intent but stops elapsed time", () => {
  const { clock, state } = createHarness();
  clock.start({ startSeconds: 30, autoplay: true });
  state.nowMs = 2_000;
  state.visible = false;
  clock.suspend();

  assert.equal(clock.isPaused(), false, "the user still wants playback");
  assert.equal(clock.isRunning(), false);
  state.nowMs = 12_000;
  assert.equal(clock.getSeconds(), 32);

  state.visible = true;
  clock.resume();
  state.nowMs = 15_000;
  assert.equal(clock.getSeconds(), 35);
});

run("a user pause while suspended prevents visibility resume", () => {
  const { clock, state } = createHarness();
  clock.start({ autoplay: true });
  state.nowMs = 1_000;
  state.visible = false;
  clock.suspend();
  clock.pause();

  state.nowMs = 8_000;
  state.visible = true;
  clock.resume();
  assert.equal(clock.isPaused(), true);
  assert.equal(clock.isRunning(), false);
  assert.equal(clock.getSeconds(), 1);
});

run("starting while hidden retains autoplay intent until resume", () => {
  const { clock, state } = createHarness();
  state.visible = false;
  clock.start({ startSeconds: 4, autoplay: true });
  state.nowMs = 6_000;

  assert.equal(clock.isPaused(), false);
  assert.equal(clock.isRunning(), false);
  assert.equal(clock.getSeconds(), 4);

  state.visible = true;
  clock.resume();
  state.nowMs = 8_500;
  assert.equal(clock.getSeconds(), 6.5);
});

run("inactive iframe state blocks the clock without discarding play intent", () => {
  const { clock, state } = createHarness();
  state.active = false;
  clock.start({ startSeconds: 9, autoplay: true });

  assert.equal(clock.isPaused(), false);
  assert.equal(clock.isRunning(), false);
  state.nowMs = 4_000;
  assert.equal(clock.getSeconds(), 9);

  state.active = true;
  assert.equal(clock.isRunning(), true);
  state.nowMs = 5_500;
  assert.equal(clock.getSeconds(), 10.5);
});

run("environment changes stop a running clock at the observation boundary", () => {
  const { clock, state } = createHarness();
  clock.start({ startSeconds: 3, autoplay: true });
  state.nowMs = 1_250;
  state.active = false;

  assert.equal(clock.isRunning(), false);
  assert.equal(clock.getSeconds(), 4.25);
  state.nowMs = 7_000;
  assert.equal(clock.getSeconds(), 4.25);
});

run("reset clears progress, running state, and play intent", () => {
  const { clock, state } = createHarness();
  clock.start({ startSeconds: 40, autoplay: true });
  state.nowMs = 2_000;
  clock.reset();

  assert.equal(clock.getSeconds(), 0);
  assert.equal(clock.isPaused(), true);
  assert.equal(clock.isRunning(), false);
});

run("invalid starts normalize to zero and backward time never rewinds", () => {
  const { clock, state } = createHarness();
  state.nowMs = 5_000;
  clock.start({ startSeconds: Number.NaN, autoplay: true });
  state.nowMs = 4_000;
  assert.equal(clock.getSeconds(), 0);

  clock.start({ startSeconds: -12, autoplay: false });
  assert.equal(clock.getSeconds(), 0);
});

console.log("\nAll live iframe playback clock tests passed (10 cases).");

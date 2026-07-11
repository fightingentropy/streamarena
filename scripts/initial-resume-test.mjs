#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  RESUME_CLEAR_AT_END_THRESHOLD_SECONDS,
  createInitialResumeController,
} from "../src-ui/player/resume-start.js";

function createFakeClock() {
  let currentTimeMs = 0;
  let nextId = 1;
  let scheduledCount = 0;
  const tasks = new Map();

  function setTimeoutFn(callback, delayMs) {
    const id = nextId;
    nextId += 1;
    scheduledCount += 1;
    tasks.set(id, {
      callback,
      runAtMs: currentTimeMs + Math.max(0, Number(delayMs) || 0),
    });
    return id;
  }

  function clearTimeoutFn(id) {
    tasks.delete(id);
  }

  function advance(ms) {
    const targetTimeMs = currentTimeMs + ms;
    while (true) {
      const nextTask = [...tasks.entries()]
        .filter(([, task]) => task.runAtMs <= targetTimeMs)
        .sort((left, right) => left[1].runAtMs - right[1].runAtMs)[0];
      if (!nextTask) break;
      const [id, task] = nextTask;
      tasks.delete(id);
      currentTimeMs = task.runAtMs;
      task.callback();
    }
    currentTimeMs = targetTimeMs;
  }

  return {
    now: () => currentTimeMs,
    setTimeoutFn,
    clearTimeoutFn,
    advance,
    pendingCount: () => tasks.size,
    scheduledCount: () => scheduledCount,
  };
}

function createHarness(overrides = {}) {
  const clock = createFakeClock();
  const state = {
    resumeTime: 120,
    effectiveCurrentTime: 0,
    seekScaleDurationSeconds: 600,
    timelineDurationSeconds: 600,
    transcodeActive: false,
    transcodeBaseOffsetSeconds: 0,
    video: { currentTime: 0, duration: 600 },
    absoluteSeeks: [],
    syncCount: 0,
    ...overrides.state,
  };

  const controller = createInitialResumeController({
    getResumeTime: () => state.resumeTime,
    getEffectiveCurrentTime: () => state.effectiveCurrentTime,
    getSeekScaleDurationSeconds: () => state.seekScaleDurationSeconds,
    getTimelineDurationSeconds: () => state.timelineDurationSeconds,
    isTranscodeSourceActive: () => state.transcodeActive,
    getTranscodeBaseOffsetSeconds: () => state.transcodeBaseOffsetSeconds,
    getVideo: () => state.video,
    seekToAbsoluteTime: (seconds) => state.absoluteSeeks.push(seconds),
    syncSeekState: () => {
      state.syncCount += 1;
    },
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    retryMs: 10,
    maxAttempts: 3,
    applyWindowMs: 100,
    ...overrides.controller,
  });

  return { clock, controller, state };
}

function run(label, test) {
  test();
  console.log(`✓ ${label}`);
}

run("exports the shared near-end threshold", () => {
  assert.equal(RESUME_CLEAR_AT_END_THRESHOLD_SECONDS, 8);
});

run("applies a standard-source resume and reads later target changes", () => {
  const { controller, state } = createHarness();
  controller.reset();
  assert.equal(controller.hasTarget(), true);
  assert.equal(controller.getStartSeconds(), 120);
  assert.equal(controller.shouldHoldProgressSave(0), true);
  assert.equal(controller.applyIfReady(), true);
  assert.equal(state.video.currentTime, 120);
  assert.equal(state.syncCount, 1);

  state.resumeTime = 240.9;
  assert.equal(controller.getStartSeconds(), 240);
});

run("uses a relative seek for an active transcode", () => {
  const { controller, state } = createHarness({
    state: { transcodeActive: true, transcodeBaseOffsetSeconds: 100 },
  });
  controller.reset();
  assert.equal(controller.applyIfReady(), true);
  assert.equal(state.video.currentTime, 20);
  assert.deepEqual(state.absoluteSeeks, []);
});

run("falls back to an absolute transcode seek outside the loaded segment", () => {
  const { controller, state } = createHarness({
    state: {
      transcodeActive: true,
      transcodeBaseOffsetSeconds: 200,
      video: { currentTime: 0, duration: 60 },
    },
  });
  controller.reset();
  assert.equal(controller.applyIfReady(), true);
  assert.deepEqual(state.absoluteSeeks, [120]);
  assert.equal(state.syncCount, 1);
});

run("rejects a resume target near either known end boundary", () => {
  const seekScale = createHarness({
    state: { resumeTime: 120, seekScaleDurationSeconds: 127 },
  });
  seekScale.controller.reset();
  assert.equal(seekScale.controller.applyIfReady(), false);
  assert.equal(seekScale.state.syncCount, 0);

  const timeline = createHarness({
    state: { resumeTime: 120, timelineDurationSeconds: 127 },
  });
  timeline.controller.reset();
  assert.equal(timeline.controller.applyIfReady(), false);
  assert.equal(timeline.state.syncCount, 0);
});

run("retries until duration metadata becomes available", () => {
  const { clock, controller, state } = createHarness({
    state: { seekScaleDurationSeconds: 0, timelineDurationSeconds: 0 },
  });
  controller.reset();
  controller.scheduleRetry();
  assert.equal(clock.pendingCount(), 1);
  clock.advance(10);
  assert.equal(clock.pendingCount(), 1);
  assert.equal(state.syncCount, 0);

  state.seekScaleDurationSeconds = 600;
  state.timelineDurationSeconds = 600;
  clock.advance(10);
  assert.equal(clock.pendingCount(), 0);
  assert.equal(state.video.currentTime, 120);
  assert.equal(state.syncCount, 1);
});

run("stops retrying at the configured attempt cap", () => {
  const { clock, controller, state } = createHarness({
    state: { seekScaleDurationSeconds: 0, timelineDurationSeconds: 0 },
  });
  controller.reset();
  controller.scheduleRetry();
  clock.advance(30);
  assert.equal(clock.scheduledCount(), 3);
  assert.equal(clock.pendingCount(), 0);
  assert.equal(state.syncCount, 0);
});

run("reapplies a rolled-back resume only inside the application window", () => {
  const { clock, controller, state } = createHarness();
  controller.reset();
  assert.equal(controller.applyIfReady(), true);
  assert.equal(state.syncCount, 1);

  state.video.currentTime = 0;
  state.effectiveCurrentTime = 0;
  assert.equal(controller.applyIfReady(), true);
  assert.equal(state.video.currentTime, 120);
  assert.equal(state.syncCount, 2);

  clock.advance(101);
  state.video.currentTime = 0;
  assert.equal(controller.applyIfReady(), true);
  assert.equal(state.video.currentTime, 0);
  assert.equal(state.syncCount, 2);
});

run("manual handling cancels retries and prevents resume reapplication", () => {
  const { clock, controller, state } = createHarness({
    state: { seekScaleDurationSeconds: 0, timelineDurationSeconds: 0 },
  });
  controller.reset();
  controller.scheduleRetry();
  controller.markHandled();
  assert.equal(clock.pendingCount(), 0);
  assert.equal(controller.shouldHoldProgressSave(0), false);

  state.seekScaleDurationSeconds = 600;
  state.timelineDurationSeconds = 600;
  assert.equal(controller.applyIfReady(), true);
  assert.equal(state.video.currentTime, 0);
  assert.equal(state.syncCount, 0);
});

run("cleanup cancels a pending retry", () => {
  const { clock, controller, state } = createHarness({
    state: { seekScaleDurationSeconds: 0, timelineDurationSeconds: 0 },
  });
  controller.reset();
  controller.scheduleRetry();
  controller.cleanup();
  assert.equal(clock.pendingCount(), 0);
  clock.advance(100);
  assert.equal(state.syncCount, 0);
});

run("a missing target applies trivially and never schedules work", () => {
  const { clock, controller } = createHarness({ state: { resumeTime: 0 } });
  controller.reset();
  assert.equal(controller.hasTarget(), false);
  assert.equal(controller.getStartSeconds(), 0);
  assert.equal(controller.shouldHoldProgressSave(0), false);
  assert.equal(controller.applyIfReady(), true);
  controller.scheduleRetry();
  assert.equal(clock.pendingCount(), 0);
});

run("applies a resume target hydrated after controller creation", () => {
  const { controller, state } = createHarness({ state: { resumeTime: 0 } });
  controller.reset();
  state.resumeTime = 180;
  controller.reset();
  assert.equal(controller.applyIfReady(), true);
  assert.equal(state.video.currentTime, 180);
  assert.equal(state.syncCount, 1);
});

console.log("\nAll initial-resume tests passed (12 cases).");

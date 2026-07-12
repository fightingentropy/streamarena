#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  createManualSourceSwitchController,
  getManualSourceSwitchTimeouts,
} from "../src-ui/player/manual-source-switch.js";

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const HASH_C = "c".repeat(40);

function createFakeClock() {
  let currentTimeMs = 0;
  let nextId = 1;
  const tasks = new Map();

  function setTimeoutFn(callback, delayMs) {
    const id = nextId;
    nextId += 1;
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
    setTimeoutFn,
    clearTimeoutFn,
    advance,
    pendingCount: () => tasks.size,
  };
}

function normalizeSourceHash(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(normalized) ? normalized : "";
}

function createHarness(overrides = {}) {
  const clock = createFakeClock();
  const state = {
    progress: { readyState: 0, bufferedEnd: 0, currentTime: 0 },
    activeSource: "",
    commits: [],
    rollbacks: [],
    failed: [],
    logs: [],
  };
  const controller = createManualSourceSwitchController({
    normalizeSourceHash,
    captureProgress: () => ({ ...state.progress }),
    getActivePlaybackSource: () => state.activeSource,
    commit: (commitData, context) => {
      state.commits.push({ commitData, context });
    },
    rollback: (baseline, context) => {
      state.rollbacks.push({ baseline, context });
    },
    markFailed: (sourceHash, context) => {
      state.failed.push({ sourceHash, context });
    },
    logger: (message, error) => state.logs.push({ message, error }),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    progressIntervalMs: 10,
    noProgressLimit: 4,
    ...overrides.controller,
  });
  return { clock, controller, state };
}

function run(label, test) {
  return Promise.resolve()
    .then(test)
    .then(() => console.log(`✓ ${label}`));
}

await run("uses source-specific resolve and startup timeouts", () => {
  assert.deepEqual(
    getManualSourceSwitchTimeouts({
      isEmbed: true,
      localTorrentEnabled: true,
    }),
    { resolveTimeoutMs: 30_000, startupTimeoutMs: 12_000 },
  );
  assert.deepEqual(
    getManualSourceSwitchTimeouts({ localTorrentEnabled: true }),
    { resolveTimeoutMs: 180_000, startupTimeoutMs: 60_000 },
  );
  assert.deepEqual(
    getManualSourceSwitchTimeouts({ realDebridConfigured: true }),
    { resolveTimeoutMs: 95_000, startupTimeoutMs: 30_000 },
  );
});

await run("honors a per-request startup timeout", async () => {
  const { clock, controller, state } = createHarness();
  const request = controller.begin({
    targetSourceHash: HASH_B,
    baseline: { source: "A" },
    startupTimeoutMs: 60,
  });
  controller.arm(request);

  clock.advance(40);
  assert.equal(state.rollbacks.length, 0);
  assert.equal(controller.isPending(), true);
  clock.advance(20);
  await request.rollbackPromise;
  assert.equal(state.rollbacks.length, 1);
  assert.equal(state.rollbacks[0].context.reason, "Source startup timed out.");
});

await run("tracks resolving and armed request states", () => {
  const { clock, controller } = createHarness();
  const baseline = { source: "A" };
  const request = controller.begin({ targetSourceHash: HASH_B, baseline });

  assert.equal(request.phase, "resolving");
  assert.equal(request.baseline, baseline);
  assert.equal(controller.getPending(), request);
  assert.equal(controller.isPending(), true);
  assert.equal(controller.isRequestActive(), true);
  assert.equal(controller.isCurrent(request), true);

  assert.equal(controller.arm(request), true);
  assert.equal(request.phase, "armed");
  assert.equal(request.armed, true);
  assert.equal(clock.pendingCount(), 1);
  assert.equal(controller.finish(request), true);
  assert.equal(controller.isRequestActive(), false);
  assert.equal(controller.isPending(), true);
});

await run("inherits the one confirmed baseline across rapid A to B to C", async () => {
  const { controller, state } = createHarness();
  const baselineA = { source: "A", position: 42 };
  const unconfirmedB = { source: "B", position: 1 };
  const requestB = controller.begin({ targetSourceHash: HASH_B, baseline: baselineA });
  controller.arm(requestB);
  const requestC = controller.begin({ targetSourceHash: HASH_C, baseline: unconfirmedB });

  assert.equal(requestB.phase, "superseded");
  assert.equal(controller.isCurrent(requestB), false);
  assert.equal(requestC.baseline, baselineA);
  await controller.fail(requestC, "C failed");
  assert.equal(state.rollbacks.length, 1);
  assert.equal(state.rollbacks[0].baseline, baselineA);
});

await run("stale request callbacks cannot mutate or roll back the newer request", async () => {
  const { clock, controller, state } = createHarness();
  const requestB = controller.begin({ targetSourceHash: HASH_B, baseline: { source: "A" } });
  controller.arm(requestB);
  const requestC = controller.begin({ targetSourceHash: HASH_C, baseline: { source: "B" } });
  controller.arm(requestC);

  assert.equal(controller.arm(requestB), false);
  assert.equal(
    controller.recordPlaybackRequested(requestB, {
      sourceHash: HASH_B,
      absolutePlaybackSource: "https://media.test/b",
    }),
    false,
  );
  assert.equal(controller.noteProgress(requestB), false);
  assert.equal(controller.completeIfActive(requestB), false);
  assert.equal(controller.finish(requestB), false);
  assert.equal(await controller.fail(requestB, "stale failure"), false);
  assert.equal(state.rollbacks.length, 0);
  assert.equal(state.failed.length, 0);
  assert.equal(controller.getPending(), requestC);
  assert.equal(clock.pendingCount(), 1);
});

await run("rejects playback records for an invalid or different target", () => {
  const { controller } = createHarness();
  const request = controller.begin({ targetSourceHash: HASH_B, baseline: {} });
  assert.equal(
    controller.recordPlaybackRequested(request, {
      sourceHash: "not-a-hash",
      absolutePlaybackSource: "https://media.test/b",
    }),
    false,
  );
  assert.equal(
    controller.recordPlaybackRequested(request, {
      sourceHash: HASH_C,
      absolutePlaybackSource: "https://media.test/c",
    }),
    false,
  );
  assert.equal(request.targetAbsolutePlaybackSource, "");
});

await run("recording new playback resets its progress baseline and watchdog", () => {
  const { clock, controller, state } = createHarness();
  state.progress = { readyState: 4, bufferedEnd: 90, currentTime: 45 };
  const request = controller.begin({ targetSourceHash: HASH_B, baseline: {} });
  controller.arm(request);
  clock.advance(20);
  assert.equal(request.noProgressTicks, 2);

  state.progress = { readyState: 0, bufferedEnd: 0, currentTime: 0 };
  assert.equal(
    controller.recordPlaybackRequested(request, {
      sourceHash: HASH_B,
      playbackSource: "/api/remux?id=b",
      absolutePlaybackSource: "https://media.test/api/remux?id=b",
    }),
    true,
  );
  assert.deepEqual(request.progressBaseline, state.progress);
  assert.equal(request.noProgressTicks, 0);
  assert.equal(request.phase, "playback-requested");
  assert.equal(clock.pendingCount(), 1);
});

await run("counts only forward time, buffered, or ready-state movement", () => {
  const { clock, controller, state } = createHarness({
    controller: { noProgressLimit: 100 },
  });
  state.progress = { readyState: 2, bufferedEnd: 20, currentTime: 10 };
  const request = controller.begin({ targetSourceHash: HASH_B, baseline: {} });
  controller.arm(request);

  state.progress.currentTime = 5;
  clock.advance(10);
  assert.equal(request.noProgressTicks, 1);
  state.progress.currentTime = 10.005;
  clock.advance(10);
  assert.equal(request.noProgressTicks, 2);
  state.progress.currentTime = 10.02;
  clock.advance(10);
  assert.equal(request.noProgressTicks, 0);

  state.progress.bufferedEnd = 20.02;
  clock.advance(10);
  assert.equal(request.noProgressTicks, 0);

  state.progress.readyState = 3;
  clock.advance(10);
  assert.equal(request.noProgressTicks, 0);
});

await run("uses high-water progress so a rewind does not become progress", () => {
  const { clock, controller, state } = createHarness({
    controller: { noProgressLimit: 100 },
  });
  state.progress.currentTime = 20;
  const request = controller.begin({ targetSourceHash: HASH_B, baseline: {} });
  controller.arm(request);
  state.progress.currentTime = 1;
  clock.advance(10);
  assert.equal(request.noProgressTicks, 1);
  state.progress.currentTime = 10;
  clock.advance(10);
  assert.equal(request.noProgressTicks, 2);
  state.progress.currentTime = 20.02;
  clock.advance(10);
  assert.equal(request.noProgressTicks, 0);
});

await run("restores exactly once after four no-progress watchdog ticks", async () => {
  const { clock, controller, state } = createHarness();
  const baseline = { source: "A" };
  const request = controller.begin({ targetSourceHash: HASH_B, baseline });
  controller.arm(request);

  clock.advance(30);
  assert.equal(request.noProgressTicks, 3);
  assert.equal(state.rollbacks.length, 0);
  assert.equal(controller.isPending(), true);
  clock.advance(10);
  await request.rollbackPromise;
  assert.equal(state.rollbacks.length, 1);
  assert.equal(state.rollbacks[0].baseline, baseline);
  assert.equal(state.rollbacks[0].context.reason, "Source startup timed out.");
  assert.deepEqual(state.failed.map(({ sourceHash }) => sourceHash), [HASH_B]);
  assert.equal(controller.isPending(), false);
  assert.equal(clock.pendingCount(), 0);
  clock.advance(100);
  assert.equal(state.rollbacks.length, 1);
});

await run("real forward progress resets the no-progress streak", () => {
  const { clock, controller, state } = createHarness();
  const request = controller.begin({ targetSourceHash: HASH_B, baseline: {} });
  controller.arm(request);
  clock.advance(30);
  assert.equal(request.noProgressTicks, 3);
  state.progress.currentTime = 0.02;
  clock.advance(10);
  assert.equal(request.noProgressTicks, 0);
  assert.equal(controller.isPending(), true);
  state.progress.bufferedEnd = 0.02;
  clock.advance(10);
  assert.equal(request.noProgressTicks, 0);
});

await run("an explicit HLS load signal resets the no-progress streak", () => {
  const { clock, controller } = createHarness();
  const request = controller.begin({ targetSourceHash: HASH_B, baseline: {} });
  controller.arm(request);
  clock.advance(30);
  assert.equal(request.noProgressTicks, 3);
  assert.equal(controller.noteProgress(request), true);
  clock.advance(10);
  assert.equal(request.noProgressTicks, 0);
  assert.equal(request.sawLoadProgress, false);
});

await run("completion requires a recorded target and exact active URL", () => {
  const { clock, controller, state } = createHarness();
  const request = controller.begin({ targetSourceHash: HASH_B, baseline: {} });
  const commitData = { source: "B" };
  assert.equal(controller.setCommitData(request, commitData), true);
  state.activeSource = "https://media.test/b";
  assert.equal(controller.completeIfActive(request), false);

  controller.recordPlaybackRequested(request, {
    sourceHash: HASH_B,
    playbackSource: "/b",
    absolutePlaybackSource: "https://media.test/b",
  });
  assert.equal(controller.completeIfActive(request), false);
  controller.arm(request);
  state.activeSource = "https://media.test/old";
  assert.equal(controller.completeIfActive(request), false);
  assert.equal(controller.isPending(), true);
  state.activeSource = "/b";
  assert.equal(controller.completeIfActive(request), false);
  state.activeSource = "https://media.test/b";
  assert.equal(controller.completeIfActive(request), true);
  assert.equal(request.phase, "completed");
  assert.equal(controller.isPending(), false);
  assert.equal(clock.pendingCount(), 0);
  assert.equal(state.commits.length, 1);
  assert.equal(state.commits[0].commitData, commitData);
});

await run("trusted HLS readiness can prove the recorded source without a media-element URL", () => {
  const { controller, state } = createHarness();
  const request = controller.begin({ targetSourceHash: HASH_B, baseline: {} });
  controller.recordPlaybackRequested(request, {
    sourceHash: HASH_B,
    absolutePlaybackSource: "https://media.test/b.m3u8",
  });
  controller.arm(request);
  state.activeSource = "blob:https://app.test/media-source";

  assert.equal(controller.completeIfActive(request), false);
  assert.equal(
    controller.completeIfActive(request, {
      activePlaybackSource: "https://media.test/b.m3u8",
    }),
    true,
  );
  assert.equal(state.commits.length, 1);
});

await run("stale and failed requests never commit provisional effects", async () => {
  const { controller, state } = createHarness();
  const requestB = controller.begin({ targetSourceHash: HASH_B, baseline: {} });
  controller.setCommitData(requestB, { source: "B" });
  const requestC = controller.begin({ targetSourceHash: HASH_C, baseline: {} });
  assert.equal(controller.setCommitData(requestB, { source: "stale" }), false);
  controller.setCommitData(requestC, { source: "C" });
  await controller.fail(requestC, "failed");
  assert.equal(state.commits.length, 0);
});

await run("duplicate failures restore and mark the source only once", async () => {
  const { controller, state } = createHarness();
  const request = controller.begin({ targetSourceHash: HASH_B, baseline: { source: "A" } });
  controller.arm(request);
  const first = controller.fail(request, "broken");
  const second = controller.fail(request, "duplicate");
  assert.equal(await first, true);
  assert.equal(await second, false);
  assert.equal(state.rollbacks.length, 1);
  assert.equal(state.failed.length, 1);
  assert.equal(state.failed[0].context.reason, "broken");
});

await run("a newer switch supersedes an in-flight rollback without losing the confirmed baseline", async () => {
  let releaseRollback;
  const rollbackGate = new Promise((resolve) => {
    releaseRollback = resolve;
  });
  const { controller } = createHarness({
    controller: {
      rollback: () => rollbackGate,
    },
  });
  const baselineA = { source: "A", position: 42 };
  const requestB = controller.begin({
    targetSourceHash: HASH_B,
    baseline: baselineA,
  });
  controller.arm(requestB);
  const rollbackPromise = controller.fail(requestB, "B failed");

  assert.equal(controller.getPending(), requestB);
  const requestC = controller.begin({
    targetSourceHash: HASH_C,
    baseline: { source: "partially restored B" },
  });
  assert.equal(requestB.phase, "superseded");
  assert.equal(requestC.baseline, baselineA);

  releaseRollback();
  assert.equal(await rollbackPromise, true);
  assert.equal(controller.getPending(), requestC);
});

await run("finish releases an unarmed resolve but preserves an armed watchdog", () => {
  const { clock, controller } = createHarness();
  const unresolved = controller.begin({ targetSourceHash: HASH_B, baseline: {} });
  assert.equal(controller.finish(unresolved), true);
  assert.equal(unresolved.phase, "finished");
  assert.equal(controller.isPending(), false);

  const armed = controller.begin({ targetSourceHash: HASH_C, baseline: {} });
  controller.arm(armed);
  assert.equal(controller.finish(armed), true);
  assert.equal(controller.isPending(), true);
  assert.equal(controller.isRequestActive(), false);
  assert.equal(clock.pendingCount(), 1);
});

await run("clear cancels without rollback and leaves old callbacks stale", async () => {
  const { clock, controller, state } = createHarness();
  const request = controller.begin({ targetSourceHash: HASH_B, baseline: {} });
  controller.arm(request);
  assert.equal(controller.clear(), true);
  assert.equal(request.phase, "cleared");
  assert.equal(controller.isPending(), false);
  assert.equal(clock.pendingCount(), 0);
  clock.advance(100);
  assert.equal(await controller.fail(request, "late"), false);
  assert.equal(state.rollbacks.length, 0);
});

await run("dispose cancels work and prevents reuse", () => {
  const { clock, controller, state } = createHarness();
  const request = controller.begin({ targetSourceHash: HASH_B, baseline: {} });
  controller.arm(request);
  controller.dispose();
  assert.equal(clock.pendingCount(), 0);
  assert.equal(controller.isPending(), false);
  clock.advance(100);
  assert.equal(state.rollbacks.length, 0);
  assert.throws(
    () => controller.begin({ targetSourceHash: HASH_C, baseline: {} }),
    /disposed/,
  );
});

await run("rollback callback failures are contained and logged once", async () => {
  const failure = new Error("rollback exploded");
  const { controller, state } = createHarness({
    controller: {
      rollback: () => {
        throw failure;
      },
    },
  });
  const request = controller.begin({ targetSourceHash: HASH_B, baseline: {} });
  assert.equal(await controller.fail(request, "broken"), true);
  assert.equal(state.logs.length, 1);
  assert.equal(state.logs[0].error, failure);
  assert.equal(controller.isPending(), false);
});

console.log("\nAll manual source-switch tests passed (19 cases).");

#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  RESUME_CLEAR_AT_END_THRESHOLD_SECONDS,
  createBoundedWatchProgressRetry,
  createInitialResumeController,
  isPlayerStartupOwnerCurrent,
  resolvePendingDirectSeekSeconds,
  shouldRetryPlayerContinueWatching,
  shouldRetryPlayerWatchProgress,
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

async function runAsync(label, test) {
  await test();
  console.log(`✓ ${label}`);
}

run("exports the shared near-end threshold", () => {
  assert.equal(RESUME_CLEAR_AT_END_THRESHOLD_SECONDS, 8);
});

run("carries a requested seek across a direct-source recovery", () => {
  assert.equal(resolvePendingDirectSeekSeconds(2700.9, null), 2700);
  assert.equal(resolvePendingDirectSeekSeconds(1800, 2700), 1800);
  assert.equal(resolvePendingDirectSeekSeconds(0, 2700.9), 2700);
  assert.equal(resolvePendingDirectSeekSeconds(0, null), null);
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

const [playerSource, playerEntrySource, pageEntrySource, resumeStartSource] =
  await Promise.all([
    readFile(new URL("../src-ui/pages/player.js", import.meta.url), "utf8"),
    readFile(new URL("../src-ui/entries/player.js", import.meta.url), "utf8"),
    readFile(new URL("../src-ui/lib/page-entry.js", import.meta.url), "utf8"),
    readFile(new URL("../src-ui/player/resume-start.js", import.meta.url), "utf8"),
  ]);
run("owns startup progress hydration before the authenticated player mount", () => {
  const hydrationIndex = pageEntrySource.indexOf("await hydrateFromServer()");
  const authExpiryIndex = pageEntrySource.indexOf("hydration.authExpired");
  const mountIndex = pageEntrySource.indexOf("mountPage(await componentPromise");

  assert.match(playerEntrySource, /await mountAuthenticatedPage/);
  assert.ok(hydrationIndex >= 0, "authenticated progress hydration is missing");
  assert.ok(
    hydrationIndex < authExpiryIndex && authExpiryIndex < mountIndex,
    "hydration and auth-expiry handling must finish before player mount",
  );
  const playerProgressCalls = [
    ...playerSource.matchAll(/["']\/api\/user\/watch-progress["']/g),
  ];
  assert.ok(playerProgressCalls.length > 0, "progress persistence calls are missing");
  playerProgressCalls.forEach((match) => {
    assert.match(
      playerSource.slice(match.index, match.index + 180),
      /method:\s*["'](?:PUT|DELETE)["']/,
      "player progress calls must remain persistence mutations",
    );
  });
  const recoveryProgressCalls = [
    ...resumeStartSource.matchAll(/["']\/api\/user\/watch-progress["']/g),
  ];
  const recoveryProgressReads = recoveryProgressCalls.filter((match) =>
    /cache:\s*["']no-store["']/.test(
      resumeStartSource.slice(match.index, match.index + 180),
    ),
  );
  assert.equal(
    recoveryProgressReads.length,
    1,
    "the player helper must expose exactly one bounded recovery read",
  );
  assert.equal(
    [...playerSource.matchAll(/localStorage\.getItem\(resumeStorageKey\)/g)]
      .length,
    1,
    "resume must be read once, after the playback identity is finalized",
  );
});

run("gates recovery reads for all hydration result combinations", () => {
  const base = {
    resumeTime: 0,
    userStateOwner: "account-7",
    hydrationStatus: {
      authExpired: false,
      didLoadProgress: false,
      didLoadContinueWatching: false,
    },
  };
  const combinations = [
    {
      didLoadProgress: true,
      didLoadContinueWatching: true,
      retryProgress: false,
      retryContinueWatching: false,
    },
    {
      didLoadProgress: true,
      didLoadContinueWatching: false,
      retryProgress: false,
      retryContinueWatching: true,
    },
    {
      didLoadProgress: false,
      didLoadContinueWatching: true,
      retryProgress: true,
      retryContinueWatching: false,
    },
    {
      didLoadProgress: false,
      didLoadContinueWatching: false,
      retryProgress: true,
      retryContinueWatching: true,
    },
  ];
  combinations.forEach(
    ({
      didLoadProgress,
      didLoadContinueWatching,
      retryProgress,
      retryContinueWatching,
    }) => {
      const hydrationStatus = {
        authExpired: false,
        didLoadProgress,
        didLoadContinueWatching,
      };
      assert.equal(
        shouldRetryPlayerWatchProgress({ ...base, hydrationStatus }),
        retryProgress,
      );
      assert.equal(
        shouldRetryPlayerContinueWatching({
          isTmdbResolvedPlayback: true,
          userStateOwner: base.userStateOwner,
          hydrationStatus,
        }),
        retryContinueWatching,
      );
    },
  );
  assert.equal(shouldRetryPlayerWatchProgress({ ...base, resumeTime: 42 }), false);
  assert.equal(
    shouldRetryPlayerWatchProgress({ ...base, userStateOwner: "" }),
    false,
  );
  assert.equal(
    shouldRetryPlayerWatchProgress({
      ...base,
      hydrationStatus: { ...base.hydrationStatus, authExpired: true },
    }),
    false,
  );
  assert.equal(
    shouldRetryPlayerContinueWatching({
      isTmdbResolvedPlayback: true,
      userStateOwner: base.userStateOwner,
      hydrationStatus: { ...base.hydrationStatus, authExpired: true },
    }),
    false,
  );
  assert.equal(
    shouldRetryPlayerContinueWatching({
      isTmdbResolvedPlayback: false,
      userStateOwner: base.userStateOwner,
      hydrationStatus: base.hydrationStatus,
    }),
    false,
  );
  assert.equal(
    shouldRetryPlayerContinueWatching({
      isTmdbResolvedPlayback: true,
      userStateOwner: "",
      hydrationStatus: base.hydrationStatus,
    }),
    false,
  );
});

await runAsync("stops startup after an owner switch or auth clear", async () => {
  const startupOwner = "account-7";
  let currentOwner = startupOwner;
  assert.equal(isPlayerStartupOwnerCurrent(startupOwner, currentOwner), true);

  await Promise.resolve().then(() => {
    currentOwner = "account-8";
  });
  assert.equal(isPlayerStartupOwnerCurrent(startupOwner, currentOwner), false);

  currentOwner = "";
  assert.equal(
    isPlayerStartupOwnerCurrent(startupOwner, currentOwner),
    false,
    "a 401/403 owner clear must invalidate the in-flight startup",
  );
  assert.equal(
    isPlayerStartupOwnerCurrent("", ""),
    true,
    "an ownerless startup remains valid while it stays ownerless",
  );
});

await runAsync("bounds and deduplicates the handled recovery read", async () => {
  let hydratedRequestCount = 0;
  const startHydratedRetry = createBoundedWatchProgressRetry({
    fetchUserApiFn: async () => {
      hydratedRequestCount += 1;
      return { ok: true, json: async () => ({ entries: [] }) };
    },
  });
  if (
    shouldRetryPlayerWatchProgress({
      resumeTime: 0,
      userStateOwner: "account-7",
      hydrationStatus: {
        authExpired: false,
        didLoadProgress: true,
        didLoadContinueWatching: true,
      },
    })
  ) {
    await startHydratedRetry();
  }
  assert.equal(
    hydratedRequestCount,
    0,
    "successful pre-mount hydration must not trigger a player progress GET",
  );

  let requestCount = 0;
  let jsonCount = 0;
  let clearCount = 0;
  let timeoutCallback = null;
  let timeoutDelay = 0;
  let resolveRequest;
  const request = new Promise((resolve) => {
    resolveRequest = resolve;
  });
  const abortController = {
    signal: { aborted: false },
    abort() {
      this.signal.aborted = true;
    },
  };
  const startRetry = createBoundedWatchProgressRetry({
    fetchUserApiFn: (path, options) => {
      requestCount += 1;
      assert.equal(path, "/api/user/watch-progress");
      assert.equal(options.cache, "no-store");
      assert.equal(options.signal, abortController.signal);
      return request;
    },
    setTimeoutFn: (callback, delayMs) => {
      timeoutCallback = callback;
      timeoutDelay = delayMs;
      return 9;
    },
    clearTimeoutFn: (timeoutId) => {
      assert.equal(timeoutId, 9);
      clearCount += 1;
    },
    createAbortController: () => abortController,
  });

  const retryNeeded = shouldRetryPlayerWatchProgress({
    resumeTime: 0,
    userStateOwner: "account-7",
    hydrationStatus: {
      authExpired: false,
      didLoadProgress: false,
      didLoadContinueWatching: true,
    },
  });
  assert.equal(retryNeeded, true);
  const first = retryNeeded ? startRetry() : null;
  const second = startRetry();
  assert.equal(first, second);
  assert.equal(requestCount, 1);
  assert.equal(timeoutDelay, 1200);
  assert.equal(typeof timeoutCallback, "function");
  resolveRequest({
    ok: true,
    async json() {
      jsonCount += 1;
      return { entries: [{ sourceIdentity: "tmdb:movie:1", resumeSeconds: 30 }] };
    },
  });
  assert.deepEqual(await first, {
    entries: [{ sourceIdentity: "tmdb:movie:1", resumeSeconds: 30 }],
  });
  assert.equal(startRetry(), first);
  assert.equal(requestCount, 1);
  assert.equal(jsonCount, 1);
  assert.equal(clearCount, 1);

  let rejectTimedRequest;
  let didAbort = false;
  let timedCallback = null;
  const startTimedRetry = createBoundedWatchProgressRetry({
    fetchUserApiFn: () =>
      new Promise((_, reject) => {
        rejectTimedRequest = reject;
      }),
    setTimeoutFn: (callback) => {
      timedCallback = callback;
      return 10;
    },
    clearTimeoutFn: () => {},
    createAbortController: () => ({
      signal: {},
      abort() {
        didAbort = true;
        rejectTimedRequest(new Error("aborted"));
      },
    }),
  });
  const timedRetry = startTimedRetry();
  timedCallback();
  assert.equal(await timedRetry, null);
  assert.equal(didAbort, true);
});

run("hydrates resume from the finalized playback identity before startup reads", () => {
  const initSource = playerSource.slice(
    playerSource.indexOf("async function initPlaybackSource()"),
  );
  const sourceIdentityIndex = initSource.indexOf("sourceIdentity =");
  const resumeStorageKeyIndex = initSource.indexOf(
    "resumeStorageKey = `streamarena-resume:${sourceIdentity}`",
  );
  const finalResumeStorageReadIndex = initSource.indexOf(
    "localStorage.getItem(resumeStorageKey)",
  );
  const settingsStartIndex = initSource.indexOf(
    "const userRealDebridSettingsReady",
  );
  const retryStartIndex = initSource.indexOf(
    "const serverWatchProgressRetry",
  );
  const settingsAwaitIndex = initSource.indexOf(
    "await userRealDebridSettingsReady",
  );
  const retryAwaitIndex = initSource.indexOf(
    "await serverWatchProgressRetry",
  );
  const ownerGuardIndexes = [
    ...initSource.matchAll(/if \(!startupUserStateOwnerIsCurrent\(\)\) return;/g),
  ].map((match) => match.index);
  const hydrationStatusCalls = [
    ...initSource.matchAll(/getServerHydrationStatus\(\)/g),
  ];
  const continueGateIndex = initSource.indexOf(
    "const serverContinueWatchingFetch = shouldRetryContinueWatching",
  );
  const finalSourceGuardIndex = initSource.indexOf(
    "clearDisabledTorrentPlaybackState();",
    settingsAwaitIndex,
  );
  const continueAwaitIndex = initSource.indexOf(
    "await serverContinueWatchingFetch",
  );
  const finalPersistenceIndex = initSource.indexOf("if (resumeTime > 1)");

  assert.ok(
    sourceIdentityIndex >= 0 &&
      sourceIdentityIndex < resumeStorageKeyIndex &&
      resumeStorageKeyIndex < finalResumeStorageReadIndex &&
      finalResumeStorageReadIndex < settingsStartIndex,
    "the finalized source key must hydrate local or offline resume before startup requests",
  );
  assert.ok(
    settingsStartIndex < retryStartIndex &&
      retryStartIndex < settingsAwaitIndex &&
      settingsAwaitIndex < retryAwaitIndex,
    "the bounded retry must start in parallel and be awaited only at the fallback boundary",
  );
  assert.equal(
    ownerGuardIndexes.length,
    3,
    "owner validity must be checked after each startup await boundary",
  );
  assert.ok(
    settingsAwaitIndex < ownerGuardIndexes[0] &&
      ownerGuardIndexes[0] < finalSourceGuardIndex &&
      continueAwaitIndex < ownerGuardIndexes[1] &&
      retryAwaitIndex < ownerGuardIndexes[2] &&
      ownerGuardIndexes[2] < finalPersistenceIndex,
    "owner/auth changes must stop startup before source validation, persistence, or source work",
  );
  assert.equal(
    hydrationStatusCalls.length,
    1,
    "startup must use one captured hydration-status snapshot for both retry gates",
  );
  assert.ok(
    continueGateIndex >= 0 && continueGateIndex < retryStartIndex,
    "Continue Watching recovery must be gated by the captured hydration result",
  );
  assert.ok(
    settingsAwaitIndex < finalSourceGuardIndex &&
      finalSourceGuardIndex < continueAwaitIndex,
    "the finalized identity must validate enabled sources before awaiting Continue Watching",
  );
  assert.match(
    initSource.slice(continueAwaitIndex, continueAwaitIndex + 500),
    /startupUserStateOwnerIsCurrent\(\)/,
    "a late Continue Watching response must not cross the captured account owner",
  );
  assert.match(
    initSource.slice(retryAwaitIndex, retryAwaitIndex + 500),
    /startupUserStateOwnerIsCurrent\(\)/,
    "a late recovery response must not cross the captured account owner",
  );
});

console.log("\nAll initial-resume tests passed (18 cases).");

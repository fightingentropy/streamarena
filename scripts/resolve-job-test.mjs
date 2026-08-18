#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  createResolveJobRequestCoordinator,
  createResolveRequester,
  isResolveAbortError,
  runResolveWithSupersession,
  waitForResolveJob,
} from "../src-ui/player/resolve-job.js";
import { requestJson } from "../src-ui/player/api.js";

function createClock() {
  let nowMs = 1_000;
  return {
    now: () => nowMs,
    advance: (delayMs) => {
      nowMs += Math.max(0, Number(delayMs) || 0);
    },
  };
}

async function run(label, test) {
  await test();
  console.log(`✓ ${label}`);
}

await run("returns immediately when a long poll observes completion", async () => {
  const clock = createClock();
  const requests = [];
  const sleeps = [];
  const result = await waitForResolveJob({
    jobId: "job/one",
    timeoutMs: 60_000,
    nowFn: clock.now,
    requestJsonFn: async (url, options, timeoutMs) => {
      requests.push({ url, options, timeoutMs });
      clock.advance(37);
      return { status: "done", result: { playableUrl: "/ready" } };
    },
    sleepFn: async (delayMs) => sleeps.push(delayMs),
  });

  assert.deepEqual(result, { playableUrl: "/ready" });
  assert.deepEqual(sleeps, []);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/resolve/job/job%2Fone?waitMs=25000");
  assert.deepEqual(requests[0].options, { credentials: "same-origin" });
  assert.equal(requests[0].timeoutMs, 30_000);
});

await run("reissues bounded waits without a fixed sleep after a server timeout", async () => {
  const clock = createClock();
  const requests = [];
  const sleeps = [];
  const result = await waitForResolveJob({
    jobId: "two",
    timeoutMs: 70_000,
    nowFn: clock.now,
    requestJsonFn: async (url) => {
      requests.push(url);
      if (requests.length === 1) {
        clock.advance(25_000);
        return { status: "pending" };
      }
      clock.advance(400);
      return { status: "done", result: { sourceHash: "abc" } };
    },
    sleepFn: async (delayMs) => sleeps.push(delayMs),
  });

  assert.deepEqual(result, { sourceHash: "abc" });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((url) => url.endsWith("?waitMs=25000")));
  assert.deepEqual(sleeps, []);
});

await run("falls back to legacy polling when an old server ignores waitMs", async () => {
  const clock = createClock();
  const requests = [];
  const sleeps = [];
  const result = await waitForResolveJob({
    jobId: "legacy",
    timeoutMs: 60_000,
    nowFn: clock.now,
    requestJsonFn: async (url) => {
      requests.push(url);
      if (url.includes("waitMs=")) {
        return { status: "pending" };
      }
      return { status: "done", result: { playableUrl: "/legacy-ready" } };
    },
    sleepFn: async (delayMs) => {
      sleeps.push(delayMs);
      clock.advance(delayMs);
    },
  });

  assert.equal(result.playableUrl, "/legacy-ready");
  assert.deepEqual(sleeps, [2_000]);
  assert.deepEqual(requests, [
    "/api/resolve/job/legacy?waitMs=25000",
    "/api/resolve/job/legacy",
  ]);
});

await run("keeps following the same job after a proxy long-poll failure", async () => {
  const clock = createClock();
  const requests = [];
  const sleeps = [];
  const result = await waitForResolveJob({
    jobId: "proxy",
    timeoutMs: 60_000,
    nowFn: clock.now,
    requestJsonFn: async (url) => {
      requests.push(url);
      if (url.includes("waitMs=")) {
        const error = new Error("Cloudflare returned 524 A Timeout Occurred.");
        error.status = 524;
        throw error;
      }
      return { status: "done", result: { playableUrl: "/proxy-ready" } };
    },
    sleepFn: async (delayMs) => {
      sleeps.push(delayMs);
      clock.advance(delayMs);
    },
  });

  assert.equal(result.playableUrl, "/proxy-ready");
  assert.deepEqual(sleeps, [2_000]);
  assert.equal(requests.length, 2);
});

await run("recognizes Safari and Firefox long-poll transport failures", async () => {
  for (const message of [
    "Load failed",
    "NetworkError when attempting to fetch resource.",
  ]) {
    const clock = createClock();
    let requestCount = 0;
    const result = await waitForResolveJob({
      jobId: "browser-network",
      timeoutMs: 60_000,
      nowFn: clock.now,
      requestJsonFn: async (url) => {
        requestCount += 1;
        if (url.includes("waitMs=")) {
          throw new TypeError(message);
        }
        return { status: "done", result: { playableUrl: "/browser-ready" } };
      },
      sleepFn: async (delayMs) => clock.advance(delayMs),
    });
    assert.equal(result.playableUrl, "/browser-ready");
    assert.equal(requestCount, 2);
  }
});

await run("retries transient transport errors in fallback polling", async () => {
  const clock = createClock();
  const requests = [];
  const sleeps = [];
  const result = await waitForResolveJob({
    jobId: "transient-fallback",
    timeoutMs: 60_000,
    nowFn: clock.now,
    requestJsonFn: async (url) => {
      requests.push(url);
      if (url.includes("waitMs=")) {
        throw new TypeError("Load failed");
      }
      if (requests.length === 2) {
        throw new TypeError("NetworkError when attempting to fetch resource.");
      }
      return { status: "done", result: { playableUrl: "/fallback-ready" } };
    },
    sleepFn: async (delayMs) => {
      sleeps.push(delayMs);
      clock.advance(delayMs);
    },
  });

  assert.equal(result.playableUrl, "/fallback-ready");
  assert.deepEqual(sleeps, [2_000, 2_000]);
  assert.equal(requests.length, 3);
});

await run("propagates terminal resolve errors", async () => {
  const clock = createClock();
  await assert.rejects(
    waitForResolveJob({
      jobId: "failed",
      timeoutMs: 60_000,
      nowFn: clock.now,
      requestJsonFn: async () => ({
        status: "error",
        error: "torrent unavailable",
      }),
    }),
    /torrent unavailable/,
  );
});

await run("enforces the overall resolve deadline in fallback mode", async () => {
  const clock = createClock();
  await assert.rejects(
    waitForResolveJob({
      jobId: "timeout",
      timeoutMs: 1_000,
      nowFn: clock.now,
      requestJsonFn: async () => ({ status: "pending" }),
      sleepFn: async (delayMs) => clock.advance(delayMs),
    }),
    /Resolving stream timed out/,
  );
});

await run("aborts an in-flight long poll and cancels its backend job", async () => {
  const controller = new AbortController();
  const cancelledJobs = [];
  let observedSignal = null;
  const waiting = waitForResolveJob({
    jobId: "superseded-b",
    timeoutMs: 60_000,
    signal: controller.signal,
    requestJsonFn: (_url, options) => {
      observedSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("cancelled");
          error.name = "AbortError";
          reject(error);
        });
      });
    },
    cancelResolveJobFn: async ({ jobId }) => {
      cancelledJobs.push(jobId);
      return true;
    },
  });

  await Promise.resolve();
  controller.abort();
  await assert.rejects(waiting, (error) => error?.name === "AbortError");
  assert.equal(observedSignal, controller.signal);
  assert.deepEqual(cancelledJobs, ["superseded-b"]);
});

await run("waits for B cancellation before admitting C", async () => {
  let releaseCancellation;
  const cancellationReachedBackend = new Promise((resolve) => {
    releaseCancellation = resolve;
  });
  const cancelledJobs = [];
  const coordinator = createResolveJobRequestCoordinator({
    cancelResolveJobFn: async ({ jobId }) => {
      cancelledJobs.push(jobId);
      await cancellationReachedBackend;
      return true;
    },
  });
  const b = await coordinator.begin();
  b.setJobId("job-b");

  let cStarted = false;
  const cPromise = coordinator.begin().then((request) => {
    cStarted = true;
    return request;
  });
  await Promise.resolve();
  assert.equal(b.signal.aborted, true);
  assert.equal(cStarted, false);
  assert.deepEqual(cancelledJobs, ["job-b"]);

  releaseCancellation();
  const c = await cPromise;
  assert.equal(cStarted, true);
  assert.equal(c.signal.aborted, false);
  c.finish();
});

await run("a stale C begin cannot overwrite a newer D begin", async () => {
  let releaseCancellation;
  const cancellationReachedBackend = new Promise((resolve) => {
    releaseCancellation = resolve;
  });
  const coordinator = createResolveJobRequestCoordinator({
    cancelResolveJobFn: async () => {
      await cancellationReachedBackend;
      return true;
    },
  });
  const b = await coordinator.begin();
  b.setJobId("job-b");

  const cPromise = coordinator.begin();
  await Promise.resolve();
  const dPromise = coordinator.begin();
  releaseCancellation();

  await assert.rejects(cPromise, (error) => error?.name === "AbortError");
  const d = await dPromise;
  assert.equal(d.signal.aborted, false);
  assert.equal(d.isCurrent(), true);
  d.finish();
});

await run("learns and cancels B when superseded during job registration", async () => {
  let finishRegistration;
  const registration = new Promise((resolve) => {
    finishRegistration = resolve;
  });
  const cancelledJobs = [];
  const coordinator = createResolveJobRequestCoordinator({
    cancelResolveJobFn: async ({ jobId }) => {
      cancelledJobs.push(jobId);
      return true;
    },
  });
  const b = await coordinator.begin();
  const trackedRegistration = b.trackStart(registration);
  let cStarted = false;
  const cPromise = coordinator.begin().then((request) => {
    cStarted = true;
    return request;
  });
  await Promise.resolve();
  assert.equal(b.signal.aborted, true);
  assert.equal(cStarted, false);

  finishRegistration({ jobId: "late-job-b" });
  await trackedRegistration;
  const c = await cPromise;
  assert.deepEqual(cancelledJobs, ["late-job-b"]);
  assert.equal(cStarted, true);
  c.finish();
});

await run("requestJson preserves an external abort signal", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = {
    setTimeout,
    clearTimeout,
  };
  globalThis.fetch = (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("fetch aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  try {
    const controller = new AbortController();
    const pending = requestJson(
      "/api/test-abort",
      { signal: controller.signal },
      60_000,
    );
    controller.abort();
    await assert.rejects(pending, (error) => error?.name === "AbortError");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  }
});

await run("resolve requester owns async registration and wait transport", async () => {
  const coordinator = createResolveJobRequestCoordinator({
    cancelResolveJobFn: async () => true,
  });
  const requests = [];
  const waits = [];
  const requestResolveJson = createResolveRequester({
    coordinator,
    getResolverProvider: () => "local-torrent",
    requestJsonFn: async (url, options, timeoutMs) => {
      requests.push({ url, options, timeoutMs });
      return { jobId: "job-local" };
    },
    waitForResolveJobFn: async (options) => {
      waits.push(options);
      return { playableUrl: "/local-ready" };
    },
  });

  const result = await requestResolveJson("/api/resolve/movie?tmdbId=1", 190_000);
  assert.deepEqual(result, { playableUrl: "/local-ready" });
  assert.deepEqual(requests, [
    {
      url: "/api/resolve/movie?tmdbId=1&async=1",
      options: {},
      timeoutMs: 5_000,
    },
  ]);
  assert.equal(waits.length, 1);
  assert.equal(waits[0].jobId, "job-local");
  assert.equal(waits[0].timeoutMs, 190_000);
  assert.equal(waits[0].cancelOnAbort, false);
});

await run("preferred B supersedes delayed A without an overlay or fallback C", async () => {
  const preferredHash = "b".repeat(40);
  let notifyInitialStarted;
  const initialStarted = new Promise((resolve) => {
    notifyInitialStarted = resolve;
  });
  const requests = [];
  const appliedHashes = [];
  const overlayErrors = [];
  let fallbackCount = 0;
  let playbackGeneration = 0;
  const coordinator = createResolveJobRequestCoordinator({
    cancelResolveJobFn: async () => true,
  });
  const requestResolveJson = createResolveRequester({
    coordinator,
    getResolverProvider: () => "fastest",
    requestJsonFn: async (url, { signal } = {}) => {
      requests.push(url);
      if (url.includes(`sourceHash=${preferredHash}`)) {
        return {
          playableUrl: `/preferred-${preferredHash}.m3u8`,
          sourceHash: preferredHash,
        };
      }
      if (url.includes("fallback=c")) {
        fallbackCount += 1;
        return { playableUrl: "/fallback-c.m3u8", sourceHash: "c" };
      }
      notifyInitialStarted();
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            const error = new Error("initial A cancelled");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    },
  });

  async function resolveMovie(url) {
    try {
      return await requestResolveJson(url);
    } catch (error) {
      // Mirrors the movie/TV wrappers: cancellation belongs to the newer
      // request and must never enter source fallback.
      if (isResolveAbortError(error)) {
        throw error;
      }
      return requestResolveJson("/api/resolve/movie?fallback=c");
    }
  }

  async function resolveAndApply(url, requiredHash = "") {
    const requestGeneration = ++playbackGeneration;
    try {
      const attempt = await runResolveWithSupersession({
        resolve: () => resolveMovie(url),
        isSuperseded: () => requestGeneration !== playbackGeneration,
      });
      if (attempt.stale) {
        return { stale: true };
      }
      if (requiredHash && attempt.value?.sourceHash !== requiredHash) {
        throw new Error("Selected source is unavailable.");
      }
      if (requestGeneration !== playbackGeneration) {
        return { stale: true };
      }
      appliedHashes.push(attempt.value.sourceHash);
      return { stale: false, sourceHash: attempt.value.sourceHash };
    } catch (error) {
      overlayErrors.push(error.message);
      throw error;
    }
  }

  const initialA = resolveAndApply("/api/resolve/movie?tmdbId=27205");
  await initialStarted;
  // Source discovery finishes while A is unresolved and gives preferred B
  // ownership. Starting B must cancel A, not let A wake and launch fallback C.
  const preferredB = resolveAndApply(
    `/api/resolve/movie?tmdbId=27205&sourceHash=${preferredHash}`,
    preferredHash,
  );

  assert.deepEqual(await initialA, { stale: true });
  assert.deepEqual(await preferredB, {
    stale: false,
    sourceHash: preferredHash,
  });
  assert.deepEqual(appliedHashes, [preferredHash]);
  assert.deepEqual(overlayErrors, []);
  assert.equal(fallbackCount, 0);
  assert.equal(requests.length, 2);
});

await run("a sleeping B retry cannot wake and cancel newer C", async () => {
  let provider = "real-debrid";
  let notifyRetrySleep;
  const retrySleepStarted = new Promise((resolve) => {
    notifyRetrySleep = resolve;
  });
  let registrationCount = 0;
  const cancelledJobs = [];
  const coordinator = createResolveJobRequestCoordinator({
    cancelResolveJobFn: async ({ jobId }) => {
      cancelledJobs.push(jobId);
      return true;
    },
  });
  const requestResolveJson = createResolveRequester({
    coordinator,
    getResolverProvider: () => provider,
    requestJsonFn: async () => ({ jobId: `job-${++registrationCount}` }),
    waitForResolveJobFn: async ({ jobId }) => {
      if (jobId === "job-1") {
        throw new Error("Real-Debrid request timed out.");
      }
      return { playableUrl: "/newer-c" };
    },
    sleepFn: async () => {
      notifyRetrySleep();
      await new Promise(() => {});
    },
  });

  const b = requestResolveJson("/api/resolve/movie?source=b", 95_000);
  const bRejected = assert.rejects(b, (error) => error?.name === "AbortError");
  await retrySleepStarted;
  provider = "local-torrent";
  const c = await requestResolveJson(
    "/api/resolve/movie?source=c",
    190_000,
  );

  await bRejected;
  assert.deepEqual(c, { playableUrl: "/newer-c" });
  assert.equal(registrationCount, 2);
  assert.deepEqual(cancelledJobs, []);
});

await run("disposing a requester prevents a sleeping retry from waking", async () => {
  let notifyRetrySleep;
  const retrySleepStarted = new Promise((resolve) => {
    notifyRetrySleep = resolve;
  });
  let releaseRetrySleep;
  let registrationCount = 0;
  const coordinator = createResolveJobRequestCoordinator({
    cancelResolveJobFn: async () => true,
  });
  const requestResolveJson = createResolveRequester({
    coordinator,
    getResolverProvider: () => "real-debrid",
    requestJsonFn: async () => ({ jobId: `job-${++registrationCount}` }),
    waitForResolveJobFn: async () => {
      throw new Error("Real-Debrid request timed out.");
    },
    sleepFn: async () => {
      notifyRetrySleep();
      await new Promise((resolve) => {
        releaseRetrySleep = resolve;
      });
    },
  });

  const pending = requestResolveJson("/api/resolve/movie?source=b", 95_000);
  const rejected = assert.rejects(
    pending,
    (error) => error?.name === "AbortError",
  );
  await retrySleepStarted;
  await requestResolveJson.dispose();
  await rejected;
  releaseRetrySleep();
  await Promise.resolve();

  assert.equal(registrationCount, 1);
  await assert.rejects(
    requestResolveJson("/api/resolve/movie?source=c", 95_000),
    (error) => error?.name === "AbortError",
  );
  assert.equal(registrationCount, 1);
});

console.log("Resolve job tests passed.");

#!/usr/bin/env node
import assert from "node:assert/strict";
import { createLocalCacheUpgradeWatch } from "../src-ui/player/local-cache-upgrade-watch.js";

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createScheduler() {
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    setTimeoutFn(callback) {
      const id = nextId++;
      timeouts.set(id, callback);
      return id;
    },
    clearTimeoutFn(id) {
      timeouts.delete(id);
    },
    setIntervalFn(callback) {
      const id = nextId++;
      intervals.set(id, callback);
      return id;
    },
    clearIntervalFn(id) {
      intervals.delete(id);
    },
    runTimeout() {
      const entry = [...timeouts.entries()][0];
      if (!entry) return false;
      timeouts.delete(entry[0]);
      entry[1]();
      return true;
    },
    runInterval() {
      const callback = [...intervals.values()][0];
      if (!callback) return false;
      callback();
      return true;
    },
    timeoutCount: () => timeouts.size,
    intervalCount: () => intervals.size,
  };
}

function createHarness(overrides = {}) {
  const scheduler = createScheduler();
  const state = {
    shouldWatch: true,
    canPoll: true,
    identity: { sourceHash: "a", sessionKey: "one", activeSource: "/a" },
    requests: [],
    applied: [],
    logs: [],
  };
  const responses = [];
  const watch = createLocalCacheUpgradeWatch({
    shouldWatch: () => state.shouldWatch,
    canPoll: () => state.canPoll,
    getRequestIdentity: () => state.identity && { ...state.identity },
    requestUpgrade: (identity) => {
      state.requests.push(identity);
      const response = deferred();
      responses.push(response);
      return response.promise;
    },
    shouldApplyPayload: (payload) => Boolean(payload?.ready),
    applyUpgrade: (payload, identity) => {
      state.applied.push({ payload, identity });
    },
    logger: (message, error) => state.logs.push({ message, error }),
    ...scheduler,
    ...overrides,
  });
  return { responses, scheduler, state, watch };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

async function run(label, test) {
  await test();
  console.log(`✓ ${label}`);
}

await run("start schedules both polling paths and stop clears them", () => {
  const { scheduler, watch } = createHarness();
  assert.equal(watch.start({}), true);
  assert.equal(watch.isActive(), true);
  assert.equal(scheduler.timeoutCount(), 1);
  assert.equal(scheduler.intervalCount(), 1);
  watch.stop();
  assert.equal(watch.isActive(), false);
  assert.equal(scheduler.timeoutCount(), 0);
  assert.equal(scheduler.intervalCount(), 0);
});

await run("a stopped in-flight response cannot upgrade playback", async () => {
  const { responses, scheduler, state, watch } = createHarness();
  watch.start({});
  scheduler.runTimeout();
  assert.equal(state.requests.length, 1);
  watch.stop();
  responses[0].resolve({ ready: true, playableUrl: "/cached-a" });
  await flush();
  assert.equal(state.applied.length, 0);
  assert.equal(watch.isActive(), false);
});

await run("a prior generation cannot clear or block the next request", async () => {
  const { responses, scheduler, state, watch } = createHarness();
  watch.start({});
  scheduler.runTimeout();
  state.identity = { sourceHash: "b", sessionKey: "two", activeSource: "/b" };
  watch.start({});
  scheduler.runTimeout();
  assert.equal(state.requests.length, 2);

  responses[0].resolve({ ready: true, playableUrl: "/stale" });
  await flush();
  scheduler.runInterval();
  assert.equal(state.requests.length, 2, "current generation remains in flight");

  responses[1].resolve({ ready: true, playableUrl: "/cached-b" });
  await flush();
  assert.equal(state.applied.length, 1);
  assert.equal(state.applied[0].identity.sourceHash, "b");
});

await run("duplicate polls in one generation share one request", () => {
  const { scheduler, state, watch } = createHarness();
  watch.start({});
  scheduler.runTimeout();
  scheduler.runInterval();
  scheduler.runInterval();
  assert.equal(state.requests.length, 1);
});

await run("identity changes invalidate an otherwise ready response", async () => {
  const { responses, scheduler, state, watch } = createHarness();
  watch.start({});
  scheduler.runTimeout();
  state.identity = { sourceHash: "b", sessionKey: "one", activeSource: "/a" };
  responses[0].resolve({ ready: true, playableUrl: "/cached-a" });
  await flush();
  assert.equal(state.applied.length, 0);
});

await run("transient polling blocks keep the watcher scheduled", () => {
  const { scheduler, state, watch } = createHarness();
  state.canPoll = false;
  watch.start({});
  scheduler.runTimeout();
  assert.equal(state.requests.length, 0);
  assert.equal(watch.isActive(), true);
  state.canPoll = true;
  scheduler.runInterval();
  assert.equal(state.requests.length, 1);
});

await run("a missing request identity stops a terminal watcher", () => {
  const { scheduler, state, watch } = createHarness();
  state.identity = null;
  watch.start({});
  scheduler.runTimeout();
  assert.equal(state.requests.length, 0);
  assert.equal(watch.isActive(), false);
});

await run("semantic upgraded state blocks polls and resets on restart", () => {
  const { scheduler, state, watch } = createHarness();
  watch.start({});
  watch.setHasUpgraded(true);
  assert.equal(watch.hasUpgraded(), true);
  scheduler.runTimeout();
  assert.equal(state.requests.length, 0);
  watch.start({});
  assert.equal(watch.hasUpgraded(), false);
  scheduler.runTimeout();
  assert.equal(state.requests.length, 1);
});

await run("dispose invalidates work and prevents another start", async () => {
  const { responses, scheduler, state, watch } = createHarness();
  watch.start({});
  scheduler.runTimeout();
  watch.dispose();
  responses[0].resolve({ ready: true, playableUrl: "/cached-a" });
  await flush();
  assert.equal(state.applied.length, 0);
  assert.equal(watch.start({}), false);
  assert.equal(watch.isActive(), false);
});

console.log("\nAll local-cache upgrade watcher tests passed (9 cases).");

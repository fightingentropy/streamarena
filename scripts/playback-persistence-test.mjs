#!/usr/bin/env node
import assert from "node:assert/strict";
import { createCheckpointSaveQueue } from "../src-ui/player/checkpoint-save.js";
import { createRecentPlaybackSourceCache } from "../src-ui/player/recent-playback-source.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function clock() {
  let id = 0;
  const timers = new Map();
  return {
    setTimeoutFn(fn, delay) { timers.set(++id, { fn, delay }); return id; },
    clearTimeoutFn(key) { timers.delete(key); },
    fire(delay) { const entry = [...timers].find(([, item]) => item.delay === delay); assert.ok(entry, `missing timer ${delay}`); timers.delete(entry[0]); entry[1].fn(); },
    get size() { return timers.size; },
  };
}
function setup(fetchResponse, { retryDelays = [100, 200] } = {}) {
  const calls = [], errors = [], timers = clock();
  let timestamp = 100, owner = "viewer";
  const queue = createCheckpointSaveQueue({
    fetchFn(path, options) { const call = { path, ...options, payload: JSON.parse(options.body) }; calls.push(call); return fetchResponse?.(call, calls.length) || Promise.resolve({ ok: true }); },
    owner, getOwner: () => owner,
    mutationBody(payload) { return JSON.stringify({ ...payload, updatedAt: payload.updatedAt || ++timestamp }); },
    ...timers, retryDelays, onError: (error) => errors.push(error),
  });
  return { queue, calls, errors, timers, setOwner: (value) => { owner = value; } };
}
const identity = "tmdb:movie:42";
{
  const { queue, calls, timers } = setup(() => Promise.resolve({ ok: false, status: 503 }), { retryDelays: [] });
  queue.enqueue({ sourceIdentity: identity, remove: true }); await settle();
  assert.equal(calls.length, 1);
  assert.equal(timers.size, 0, "an exhausted final delete must not restart automatic retries");
  queue.flushForExit();
  assert.equal(calls.length, 3, "exit retries the retained final delete even when no more checkpoints arrive");
  assert.ok(calls.every((call) => call.method === "DELETE" && call.payload.updatedAt === calls[0].payload.updatedAt));
  assert.ok(calls.slice(1).every((call) => call.keepalive));
  await settle(); queue.dispose();
}
{
  let available = false;
  const { queue, calls, timers } = setup(() => Promise.resolve(available ? { ok: true } : { ok: false, status: 503 }), { retryDelays: [] });
  queue.enqueue({ sourceIdentity: identity, remove: true }); await settle();
  queue.enqueue({ sourceIdentity: identity, resumeSeconds: 90 }); await settle();
  const latestTimestamp = calls[1].payload.updatedAt;
  assert.equal(timers.size, 0);
  available = true; queue.retryPending(); await settle();
  assert.equal(calls.length, 4);
  assert.ok(calls.slice(2).every((call) => call.method === "PUT" && call.payload.resumeSeconds === 90 && call.payload.updatedAt === latestTimestamp), "online retry sends the newest snapshot, never its superseded delete");
  queue.flushForExit(); assert.equal(calls.length, 4, "acknowledged checkpoints are no longer retained");
  queue.dispose();
}
{
  const { queue, calls, setOwner } = setup(() => Promise.resolve({ ok: false, status: 503 }), { retryDelays: [] });
  queue.enqueue({ sourceIdentity: identity, remove: true }); await settle();
  setOwner("other-viewer"); queue.retryPending(); queue.flushForExit();
  assert.equal(calls.length, 1, "account changes also discard exhausted snapshots");
  setOwner("viewer"); queue.retryPending(); queue.flushForExit();
  assert.equal(calls.length, 1, "returning to an account does not resurrect discarded work");
  queue.dispose();
}
{
  const first = deferred();
  const { queue, calls } = setup((_, count) => count === 1 ? first.promise : undefined);
  queue.enqueue({ sourceIdentity: identity, resumeSeconds: 10, metadata: { title: "Film" } });
  queue.enqueue({ sourceIdentity: identity, resumeSeconds: 20 });
  queue.enqueue({ sourceIdentity: identity, resumeSeconds: 30 });
  assert.equal(calls.length, 1, "watch progress and metadata never compete for the writer");
  first.resolve({ ok: true }); await settle();
  assert.deepEqual(calls.map((call) => call.payload.resumeSeconds), [10, 10, 30, 30], "only latest queued position survives");
  assert.deepEqual(calls.map((call) => call.path), ["/api/user/watch-progress", "/api/user/continue-watching", "/api/user/watch-progress", "/api/user/continue-watching"]);
  assert.equal(calls[0].payload.updatedAt, calls[1].payload.updatedAt);
  queue.dispose();
}
{
  const { queue, calls, errors, timers } = setup((_, count) => Promise.resolve(count === 1 ? { ok: false, status: 500 } : { ok: true }));
  queue.enqueue({ sourceIdentity: identity, resumeSeconds: 10 }); await settle();
  assert.equal(errors.length, 1, "HTTP500 must be observed as failure");
  queue.enqueue({ sourceIdentity: identity, resumeSeconds: 90 });
  assert.equal(calls.length, 1, "new positions do not bypass failure backoff");
  timers.fire(100); await settle();
  assert.deepEqual(calls.map((call) => call.payload.resumeSeconds), [10, 90, 90]);
  queue.dispose();
}
{
  const { queue, calls, timers } = setup(() => Promise.resolve({ ok: false, status: 503 }));
  queue.enqueue({ sourceIdentity: identity, resumeSeconds: 10 }); await settle();
  const originalTimestamp = calls[0].payload.updatedAt;
  timers.fire(100); await settle(); timers.fire(200); await settle();
  assert.equal(calls.length, 3, "retries stop after the configured budget");
  assert.equal(timers.size, 0);
  assert.ok(calls.every((call) => call.payload.updatedAt === originalTimestamp), "retrying never makes old data newer");
  queue.dispose();
}
{
  const first = deferred(); const { queue, calls, setOwner } = setup((_, count) => count === 1 ? first.promise : undefined);
  queue.enqueue({ sourceIdentity: identity, resumeSeconds: 10 });
  queue.enqueue({ sourceIdentity: identity, resumeSeconds: 20 });
  setOwner("other-viewer"); first.resolve({ ok: true }); await settle();
  assert.equal(calls.length, 1, "account changes stop the second request and pending writes");
  assert.equal(queue.enqueue({ sourceIdentity: identity, resumeSeconds: 30 }), false);
  queue.flushForExit(); assert.equal(calls.length, 1);
  queue.dispose();
}
{
  const first = deferred(); const { queue, calls } = setup((_, count) => count === 1 ? first.promise : undefined);
  queue.enqueue({ sourceIdentity: identity, resumeSeconds: 10 });
  queue.enqueue({ sourceIdentity: identity, remove: true });
  queue.flushForExit();
  assert.equal(calls.length, 3, "exit starts both final writes before the page disappears");
  assert.ok(calls.slice(1).every((call) => call.method === "DELETE" && call.keepalive));
  assert.ok(calls[1].payload.updatedAt > calls[0].payload.updatedAt);
  assert.equal(calls[1].payload.updatedAt, calls[2].payload.updatedAt);
  first.resolve({ ok: true }); await settle();
  assert.equal(calls.length, 3, "exit supersedes the old pair instead of later resurrecting its metadata");
  queue.dispose();
}
{
  const { queue, calls, timers } = setup(() => Promise.resolve({ ok: false, status: 401 }));
  queue.enqueue({ sourceIdentity: identity, resumeSeconds: 10 }); await settle();
  assert.equal(calls.length, 1); assert.equal(timers.size, 0, "authentication failures are not retried");
  queue.dispose();
}

const entries = new Map();
const storage = { getItem: (key) => entries.get(key), setItem: (key, value) => entries.set(key, value) };
let time = 1000, owner = "viewer";
const cache = createRecentPlaybackSourceCache({ storage, owner, getOwner: () => owner, now: () => time, ttlMs: 1000 });
const hash = "a".repeat(40), preferences = '["en","off","auto"]';
assert.equal(cache.remember({ sourceIdentity: identity, sourceHash: hash, provider: "real-debrid", preferences }), true);
const lookup = { sourceIdentity: identity, preferences, resumeSeconds: 50 };
assert.deepEqual(cache.get(lookup), { sourceHash: hash, provider: "real-debrid" });
assert.equal(cache.get({ ...lookup, explicitSourceHash: "b".repeat(40) }), null, "manual source pins win over automatic resume hints");
assert.equal(cache.get({ ...lookup, resumeSeconds: 0 }), null, "new playback keeps the normal default source policy");
assert.equal(cache.get({ ...lookup, preferences: "different" }), null, "changed playback preferences invalidate hints");
assert.equal(cache.get({ ...lookup, providerAllowed: () => false }), null, "disabled torrent integrations are respected");
owner = "other-viewer"; assert.equal(cache.get(lookup), null); owner = "viewer";
time += 1000; assert.equal(cache.get(lookup), null, "expired sources are not replayed");
time += 1; cache.remember({ sourceIdentity: identity, sourceHash: hash, provider: "external-embed", preferences });
cache.forget(identity); assert.equal(cache.get(lookup), null, "failed playback clears the resume hint");
assert.equal(cache.remember({ sourceIdentity: identity, sourceHash: "invalid", provider: "real-debrid" }), false);
console.log("Playback checkpoint and resume source tests passed.");

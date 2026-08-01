import assert from "node:assert/strict";

import {
  MUTATION_CLOCK_STORAGE_KEY,
  nextUserStateMutationTimestamp,
  replaySafeMutationBody,
} from "../src-ui/lib/replay-safe-state.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

const storage = memoryStorage();
assert.equal(nextUserStateMutationTimestamp({ storage, now: 1_000 }), 1_000);
assert.equal(nextUserStateMutationTimestamp({ storage, now: 1_000 }), 1_001);
assert.equal(
  nextUserStateMutationTimestamp({ storage, now: 900 }),
  1_002,
  "a wall-clock rollback must not reorder mutations",
);

const persisted = memoryStorage({ [MUTATION_CLOCK_STORAGE_KEY]: "5000" });
assert.equal(
  nextUserStateMutationTimestamp({ storage: persisted, now: 4_000 }),
  5_001,
  "the clock high-water mark must survive a reload",
);

assert.deepEqual(
  JSON.parse(replaySafeMutationBody({ sourceIdentity: "movie:1" }, { storage, now: 2_000 })),
  { sourceIdentity: "movie:1", updatedAt: 2_000 },
);
assert.deepEqual(
  JSON.parse(
    replaySafeMutationBody(
      { sourceIdentity: "movie:1", updatedAt: 42 },
      { storage, now: 9_000 },
    ),
  ),
  { sourceIdentity: "movie:1", updatedAt: 42 },
  "a queued mutation must retain its original version when replayed",
);

console.log("Replay-safe user-state checks passed.");

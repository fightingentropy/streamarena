#!/usr/bin/env node
/**
 * Unit tests for the subtitle delay/offset logic.
 *
 * Covers the pure helpers (clamp/format), the per-source persistence state
 * machine, and the idempotent native-cue shifting used to honour a viewer's
 * subtitle-delay correction.
 */
function makeStorage() {
  const entries = new Map();
  return {
    entries,
    getItem(key) {
      return entries.has(key) ? entries.get(key) : null;
    },
    setItem(key, value) {
      entries.set(key, String(value));
    },
    removeItem(key) {
      entries.delete(key);
    },
  };
}

const storage = makeStorage();
Object.defineProperty(globalThis, "window", {
  value: { localStorage: storage },
  configurable: true,
});

const {
  SUBTITLE_OFFSET_STEP_MS,
  normalizeSubtitleOffsetMs,
  formatSubtitleOffsetLabel,
  createSubtitleOffsetController,
} = await import("../src-ui/player/subtitle-offset.js");

let failures = 0;
function assert(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) {
    failures += 1;
    console.error(`✗ ${label}: expected ${expected}, got ${actual}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

// --- normalizeSubtitleOffsetMs ---
assert("normalize: passthrough", normalizeSubtitleOffsetMs(250), 250);
assert("normalize: rounds", normalizeSubtitleOffsetMs(249.6), 250);
assert("normalize: NaN -> 0", normalizeSubtitleOffsetMs("abc"), 0);
assert("normalize: clamps high", normalizeSubtitleOffsetMs(999999), 30000);
assert("normalize: clamps low", normalizeSubtitleOffsetMs(-999999), -30000);

// --- formatSubtitleOffsetLabel ---
assert("format: zero", formatSubtitleOffsetLabel(0), "0s");
assert("format: +0.25s", formatSubtitleOffsetLabel(250), "+0.25s");
assert("format: -0.5s", formatSubtitleOffsetLabel(-500), "-0.5s");
assert("format: +1s", formatSubtitleOffsetLabel(1000), "+1s");
assert("format: -1.5s", formatSubtitleOffsetLabel(-1500), "-1.5s");

// --- controller: adjust / persist / reset / applyForSource ---
const hash = "a".repeat(40); // normalizeSourceHash only accepts 40-hex
const ctrl = createSubtitleOffsetController();
assert("ctrl: starts at 0", ctrl.getOffsetMs(), 0);

assert("ctrl: adjust returns true", ctrl.adjust(SUBTITLE_OFFSET_STEP_MS, hash), true);
assert("ctrl: offset accumulated", ctrl.getOffsetMs(), 250);
assert("ctrl: offset seconds", ctrl.getOffsetSeconds(), 0.25);
assert("ctrl: label reflects offset", ctrl.getLabel(), "+0.25s");
assert("ctrl: persisted to storage", storage.getItem(`netflix-source-subtitle-offset:${hash}`), "250");

ctrl.adjust(SUBTITLE_OFFSET_STEP_MS, hash);
assert("ctrl: second adjust accumulates", ctrl.getOffsetMs(), 500);

// A fresh controller should load the persisted value for that source.
const ctrl2 = createSubtitleOffsetController();
assert("ctrl2: applyForSource loads persisted", ctrl2.applyForSource(hash), 500);

// No-op adjust at the clamp limit returns false.
ctrl2.adjust(1_000_000, hash);
assert("ctrl2: clamped to max", ctrl2.getOffsetMs(), 30000);
assert("ctrl2: adjust at limit returns false", ctrl2.adjust(SUBTITLE_OFFSET_STEP_MS, hash), false);

// Reset clears value and persistence.
assert("ctrl2: reset returns true", ctrl2.reset(hash), true);
assert("ctrl2: reset to zero", ctrl2.getOffsetMs(), 0);
assert("ctrl2: storage cleared", storage.getItem(`netflix-source-subtitle-offset:${hash}`), null);
assert("ctrl2: reset again returns false", ctrl2.reset(hash), false);

// --- applyToNativeTracks: shift + idempotency + restore ---
function makeCue(start, end) {
  return { startTime: start, endTime: end };
}
function makeTrackList(cues) {
  return [{ cues }];
}

const cueA = makeCue(10, 12);
const cueB = makeCue(20, 22);
const tracks = makeTrackList([cueA, cueB]);

const native = createSubtitleOffsetController();
// Fast path: zero offset, never shifted -> must NOT touch cues.
native.applyToNativeTracks(tracks);
assert("native: zero offset leaves start untouched", cueA.startTime, 10);

// Delay by +0.5s -> cues move later.
native.adjust(500, hash);
native.applyToNativeTracks(tracks);
assert("native: cueA start shifted +0.5", cueA.startTime, 10.5);
assert("native: cueA end shifted +0.5", cueA.endTime, 12.5);
assert("native: cueB start shifted +0.5", cueB.startTime, 20.5);

// Idempotent: applying again recomputes from base, no compounding.
native.applyToNativeTracks(tracks);
assert("native: idempotent start", cueA.startTime, 10.5);
assert("native: idempotent end", cueA.endTime, 12.5);

// Change to -0.25s relative to base (base 10 -> 9.75).
native.adjust(-750, hash); // 500 - 750 = -250ms
assert("native: offset now -250ms", native.getOffsetMs(), -250);
native.applyToNativeTracks(tracks);
assert("native: cueA start shifted -0.25 from base", cueA.startTime, 9.75);

// Reset restores original base timing.
native.reset(hash);
native.applyToNativeTracks(tracks);
assert("native: reset restores cueA start", cueA.startTime, 10);
assert("native: reset restores cueA end", cueA.endTime, 12);

if (failures > 0) {
  console.error(`\nsubtitle-offset tests FAILED: ${failures} assertion(s).`);
  process.exit(1);
}
console.log("\nAll subtitle-offset tests passed.");

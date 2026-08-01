const MUTATION_CLOCK_STORAGE_KEY = "streamarena-user-state-mutation-clock";

function readStoredClock(storage) {
  try {
    const value = Number(storage?.getItem?.(MUTATION_CLOCK_STORAGE_KEY));
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function storeClock(storage, value) {
  try {
    storage?.setItem?.(MUTATION_CLOCK_STORAGE_KEY, String(value));
  } catch {
    // Storage can be unavailable in private/locked-down browser contexts. The
    // server-side LWW/tombstone rules remain authoritative in that case.
  }
}

/// Return a monotonically increasing client mutation timestamp.
///
/// Persisting the high-water mark prevents a device clock rollback or several
/// writes in one millisecond from reordering offline progress/delete replays.
export function nextUserStateMutationTimestamp({
  storage = globalThis.localStorage,
  now = Date.now(),
} = {}) {
  const wallClock = Number.isSafeInteger(Number(now)) && Number(now) > 0
    ? Math.floor(Number(now))
    : Date.now();
  const timestamp = Math.max(wallClock, readStoredClock(storage) + 1);
  storeClock(storage, timestamp);
  return timestamp;
}

export function replaySafeMutationBody(payload, options) {
  const existing = Number(payload?.updatedAt);
  const updatedAt = Number.isSafeInteger(existing) && existing > 0
    ? existing
    : nextUserStateMutationTimestamp(options);
  return JSON.stringify({ ...payload, updatedAt });
}

export { MUTATION_CLOCK_STORAGE_KEY };

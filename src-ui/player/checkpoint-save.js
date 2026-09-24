import { replaySafeMutationBody } from "../lib/replay-safe-state.js";

const CHECKPOINT_PATHS = ["/api/user/watch-progress", "/api/user/continue-watching"];

/** One writer per player. New checkpoints replace queued positions, while an
 * in-flight pair finishes before another begins. Retries retain their original
 * mutation timestamps so an old response cannot resurrect completed progress. */
export function createCheckpointSaveQueue({
  fetchFn = globalThis.fetch,
  owner,
  getOwner = () => owner,
  mutationBody = replaySafeMutationBody,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  retryDelays = [1000, 2000, 4000, 8000],
  onError = () => {},
} = {}) {
  const queued = new Map();
  // Keep unsaved final positions/deletes even after automatic retries stop.
  // A later online event or page exit can retry them without a background loop.
  const unsynced = new Map();
  let active = null;
  let retryTimer = null;
  let retryAttempt = 0;
  let disposed = false;
  let generation = 0;
  const ownsState = () => Boolean(owner && owner === getOwner());

  function clearRetry() {
    if (retryTimer !== null) clearTimeoutFn(retryTimer);
    retryTimer = null;
  }

  async function request(snapshot, path, keepalive = false) {
    const controller = new AbortController();
    const timeout = setTimeoutFn(() => controller.abort(), 8000);
    try {
      const response = await fetchFn(path, {
        method: snapshot.method,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: path === CHECKPOINT_PATHS[0] ? snapshot.progressBody : snapshot.metadataBody,
        keepalive,
        signal: controller.signal,
      });
      if (!response?.ok) {
        const error = new Error(`Watch progress save failed (${response?.status || 0}).`);
        error.status = response?.status || 0;
        throw error;
      }
    } finally {
      clearTimeoutFn(timeout);
    }
  }

  async function drain() {
    if (active || retryTimer !== null || disposed) return;
    if (!ownsState()) { queued.clear(); unsynced.clear(); return; }
    const snapshot = queued.values().next().value;
    if (!snapshot) return;
    queued.delete(snapshot.sourceIdentity);
    active = snapshot;
    const startedGeneration = generation;
    try {
      for (const path of CHECKPOINT_PATHS) {
        if (disposed || !ownsState()) { queued.clear(); unsynced.clear(); return; }
        if (generation !== startedGeneration) return;
        await request(snapshot, path);
      }
      if (unsynced.get(snapshot.sourceIdentity) === snapshot) unsynced.delete(snapshot.sourceIdentity);
      retryAttempt = 0;
    } catch (error) {
      if (!disposed && ownsState() && generation === startedGeneration) {
        const retryable = !error.status || error.status === 408 || error.status === 429 || error.status >= 500;
        if (retryable && retryAttempt < retryDelays.length) {
          // Preserve a newer seek, metadata update, or delete already enqueued.
          if (!queued.has(snapshot.sourceIdentity)) queued.set(snapshot.sourceIdentity, snapshot);
          const delay = retryDelays[retryAttempt++];
          retryTimer = setTimeoutFn(() => { retryTimer = null; void drain(); }, delay);
        } else {
          retryAttempt = 0;
          if (!retryable && unsynced.get(snapshot.sourceIdentity) === snapshot) unsynced.delete(snapshot.sourceIdentity);
        }
        onError(error);
      }
    } finally {
      active = null;
      if (!disposed && retryTimer === null) void drain();
    }
  }

  function enqueue({ sourceIdentity, resumeSeconds = 0, metadata = {}, remove = false } = {}) {
    if (!ownsState()) { queued.clear(); unsynced.clear(); return false; }
    if (disposed || !sourceIdentity || (!remove && !(resumeSeconds >= 1))) return false;
    const progressBody = mutationBody(remove ? { sourceIdentity } : { sourceIdentity, resumeSeconds });
    const updatedAt = JSON.parse(progressBody).updatedAt;
    const metadataBody = mutationBody(remove
      ? { sourceIdentity, updatedAt }
      : { ...metadata, sourceIdentity, resumeSeconds, updatedAt });
    const snapshot = { sourceIdentity, method: remove ? "DELETE" : "PUT", progressBody, metadataBody };
    unsynced.set(sourceIdentity, snapshot);
    queued.set(sourceIdentity, snapshot);
    void drain();
    return true;
  }

  // Page dismissal cannot await the first write before starting the second.
  // Dispatch both keepalive requests now, replaying only the newest snapshot.
  // The server's timestamp ordering makes an overlapping older write harmless.
  function flushForExit() {
    generation += 1;
    clearRetry();
    if (!ownsState()) { queued.clear(); unsynced.clear(); return; }
    const snapshots = new Map(unsynced);
    queued.clear();
    for (const snapshot of snapshots.values()) {
      void Promise.all(CHECKPOINT_PATHS.map((path) => request(snapshot, path, true)))
        .then(() => {
          if (unsynced.get(snapshot.sourceIdentity) === snapshot) unsynced.delete(snapshot.sourceIdentity);
        })
        .catch(onError);
    }
  }

  function retryPending() {
    if (disposed) return;
    if (!ownsState()) { queued.clear(); unsynced.clear(); return; }
    clearRetry();
    retryAttempt = 0;
    for (const [key, snapshot] of unsynced) {
      if (snapshot !== active) queued.set(key, snapshot);
    }
    void drain();
  }

  return {
    enqueue,
    flushForExit,
    retryPending,
    dispose() { disposed = true; clearRetry(); queued.clear(); unsynced.clear(); },
  };
}

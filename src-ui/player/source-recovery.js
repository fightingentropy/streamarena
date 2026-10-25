// Automatic recovery from a failed TMDB source is one bounded attempt: at most a
// few distinct replacement sources within a fixed time budget, never resolving a
// source twice. A replacement that starts and then fails again (opening segments
// play, later media returns 424) continues the same attempt, so recovery cannot
// cycle between providers forever. The attempt ends after sustained playback or
// when the viewer acts (Retry now, Try another source, a Sources/audio change).
export const AUTOMATIC_RECOVERY_MAX_SOURCES = 3;
export const AUTOMATIC_RECOVERY_BUDGET_MS = 60_000;
export const AUTOMATIC_RECOVERY_SETTLE_SECONDS = 30;
// Keeps the avoid list well inside URL limits; recent failures come first.
const MAX_AVOIDED_SOURCE_HASHES = 16;
const MIN_RESOLVE_TIMEOUT_MS = 1_000;

export function createSourceRecoveryBudget({
  maxSources = AUTOMATIC_RECOVERY_MAX_SOURCES,
  budgetMs = AUTOMATIC_RECOVERY_BUDGET_MS,
  settleSeconds = AUTOMATIC_RECOVERY_SETTLE_SECONDS,
  // Page-lifetime failures (shared with the player) stay avoided across attempts.
  knownFailedSourceHashes = new Set(),
  nowFn = () => Date.now(),
} = {}) {
  let attempt = null;
  // The budget is spent only while recovery works (resolving and starting a
  // replacement). Time a replacement spends playing or paused is not counted.
  const spentMs = () =>
    attempt ? attempt.spentMs + (attempt.workFrom === null ? 0 : nowFn() - attempt.workFrom) : 0;
  const remainingMs = () => (attempt ? Math.max(0, budgetMs - spentMs()) : budgetMs);
  const summary = () => ({ sources: attempt?.sources || 0, elapsedMs: spentMs() });
  // Without an attempt (reset by the viewer) there is nothing left to spend.
  const isExhausted = () => !attempt || attempt.failed || attempt.sources >= maxSources || remainingMs() <= 0;

  return {
    /**
     * Start the attempt, or continue it when its last replacement failed too.
     * Returns true when the attempt has nothing left to spend.
     */
    begin(failedSourceHash = "") {
      attempt ??= { spentMs: 0, workFrom: null, tried: new Set(), sources: 0, failed: false, progressFrom: null };
      attempt.workFrom ??= nowFn();
      if (failedSourceHash) attempt.tried.add(failedSourceHash);
      attempt.progressFrom = null;
      return isExhausted();
    },
    isActive: () => attempt !== null,
    hasFailed: () => Boolean(attempt?.failed),
    isExhausted,
    // The current attempt's sources, then page-lifetime failures, newest first.
    avoidedSourceHashes: () => [
      ...new Set([...[...(attempt?.tried || [])].reverse(), ...[...knownFailedSourceHashes].reverse()]),
    ].slice(0, MAX_AVOIDED_SOURCE_HASHES),
    /** Count one replacement source; returns its resolve timeout. */
    claimSource() {
      attempt.sources += 1;
      attempt.progressFrom = null;
      return Math.max(MIN_RESOLVE_TIMEOUT_MS, remainingMs());
    },
    /** Give back a slot whose resolve failed for reasons unrelated to the source. */
    releaseSource() {
      if (attempt?.sources > 0) attempt.sources -= 1;
    },
    /** A replacement was applied: stop the clock until it fails again. */
    noteApplied() {
      if (!attempt || attempt.workFrom === null) return;
      attempt.spentMs += nowFn() - attempt.workFrom;
      attempt.workFrom = null;
    },
    markTried(sourceHash, { failed = false } = {}) {
      if (!attempt || !sourceHash) return;
      attempt.tried.add(sourceHash);
      if (failed) knownFailedSourceHashes.add(sourceHash);
    },
    /** Sustained playback on the replacement ends the attempt. */
    noteProgress(seconds) {
      if (!attempt || attempt.failed || !Number.isFinite(seconds)) return false;
      attempt.progressFrom ??= seconds;
      if (seconds - attempt.progressFrom < settleSeconds) return false;
      attempt = null;
      return true;
    },
    fail() {
      if (attempt) attempt.failed = true;
      return summary();
    },
    summary,
    reset() {
      attempt = null;
    },
  };
}

/**
 * Resolve replacement sources one at a time until one is applied, a newer
 * playback request supersedes this one, or the budget is spent. Each claim is a
 * single resolve request capped to the remaining budget. `pickSourceHash`
 * returns a source to pin, "" to let the server choose (avoiding every source
 * already tried), or null when no untried source remains.
 */
export async function runBoundedSourceRecovery({
  budget,
  pickSourceHash,
  resolveSource,
  isCurrent = () => true,
  classifyError = (error) => classifySourceRecoveryError(error, { offline: globalThis.navigator?.onLine === false }),
}) {
  let lastError = null;
  while (isCurrent() && !budget.isExhausted()) {
    const avoidSourceHashes = budget.avoidedSourceHashes();
    const sourceHash = pickSourceHash(new Set(avoidSourceHashes));
    if (sourceHash === null) break;
    const timeoutMs = budget.claimSource();
    try {
      const result = await resolveSource({ sourceHash, timeoutMs, avoidSourceHashes });
      if (!isCurrent() || result?.stale) return { stale: true };
      budget.markTried(result?.sourceHash || sourceHash);
      budget.noteApplied();
      return { recovered: true };
    } catch (error) {
      if (!isCurrent()) return { stale: true };
      lastError = error;
      const kind = classifyError(error);
      // Only the source's own failure is remembered for the page; a timeout or
      // a dropped connection says nothing about the source.
      budget.markTried(sourceHash, { failed: kind === "source" });
      if (kind === "connectivity") {
        budget.releaseSource();
        return { recovered: false, stale: false, connectivity: true, error };
      }
      // The server's own pick already skipped every avoided source.
      if (!sourceHash) break;
    }
  }
  return { recovered: false, stale: !isCurrent(), error: lastError };
}

/**
 * The replacement to pin: the catalog's next untried source, else "" to let the
 * server choose (avoiding every tried source) when the catalog is still loading,
 * failed, or holds only the resolved "Current" row, else null when none remain.
 */
export function pickRecoverySourceHash(picked, sources = [], { loading = false } = {}) {
  if (picked) return picked;
  const hasCatalog = !loading && sources.some((option) => option?.provider !== "Current");
  return hasCatalog ? null : "";
}

/** "source" (that source is unavailable), "transient" or "connectivity". */
export function classifySourceRecoveryError(error, { offline = false } = {}) {
  if (offline || error instanceof TypeError) return "connectivity";
  if (error?.name === "AbortError" || error?.message === "Request timed out.") return "transient";
  const status = Number(error?.status) || 0;
  if (status === 429 || status >= 500) return "transient";
  return "source";
}

export function describeFailedSourceRecovery({ sources = 0, connectivity = false } = {}) {
  if (connectivity) {
    return "Playback stopped because the connection dropped. Retry now once you're back online.";
  }
  if (sources <= 0) {
    return "No other working source is available for this title. Retry now, or try another source.";
  }
  const tried = sources === 1 ? "another source" : `${sources} other sources`;
  return `No working source found after trying ${tried}. Retry now, or try another source.`;
}

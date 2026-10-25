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
  const remainingMs = () => (attempt ? Math.max(0, attempt.deadline - nowFn()) : budgetMs);
  const summary = () => ({
    sources: attempt?.sources || 0,
    elapsedMs: attempt ? nowFn() - attempt.startedAt : 0,
  });

  return {
    /** Start the attempt, or continue it when its last replacement failed too. */
    begin(failedSourceHash = "") {
      const now = nowFn();
      attempt ??= { startedAt: now, deadline: now + budgetMs, tried: new Set(), sources: 0, failed: false, progressFrom: null };
      if (failedSourceHash) attempt.tried.add(failedSourceHash);
      attempt.progressFrom = null;
    },
    isActive: () => attempt !== null,
    hasFailed: () => Boolean(attempt?.failed),
    // Without an attempt (reset by the viewer) there is nothing left to spend.
    isExhausted: () => !attempt || attempt.failed || attempt.sources >= maxSources || remainingMs() <= 0,
    avoidedSourceHashes: () => [
      ...new Set([...(attempt?.tried || []), ...knownFailedSourceHashes]),
    ].slice(0, MAX_AVOIDED_SOURCE_HASHES),
    /** Count one replacement source; returns its resolve timeout. */
    claimSource() {
      attempt.sources += 1;
      attempt.progressFrom = null;
      return Math.max(MIN_RESOLVE_TIMEOUT_MS, remainingMs());
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
      return { recovered: true };
    } catch (error) {
      if (!isCurrent()) return { stale: true };
      lastError = error;
      budget.markTried(sourceHash, { failed: true });
      // The server's own pick already skipped every avoided source.
      if (!sourceHash) break;
    }
  }
  return { recovered: false, stale: !isCurrent(), error: lastError };
}

export function describeFailedSourceRecovery({ sources = 0 } = {}) {
  if (sources <= 0) {
    return "No other working source is available for this title. Retry now, or try another source.";
  }
  const tried = sources === 1 ? "another source" : `${sources} other sources`;
  return `No working source found after trying ${tried}. Retry now, or try another source.`;
}

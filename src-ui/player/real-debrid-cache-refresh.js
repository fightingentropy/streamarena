import { isRealDebridCachedTorrentSource } from "./sources.js";

export const REAL_DEBRID_SOURCE_REFRESH_DELAYS_MS = [1_200, 2_400];

export function shouldRefreshRealDebridCachedSources({
  realDebridActive = false,
  attemptCount = 0,
  maxAttempts = REAL_DEBRID_SOURCE_REFRESH_DELAYS_MS.length,
  sources = [],
} = {}) {
  const safeAttemptCount = Number.isFinite(Number(attemptCount))
    ? Math.max(0, Math.floor(Number(attemptCount)))
    : 0;
  const safeMaxAttempts = Number.isFinite(Number(maxAttempts))
    ? Math.max(0, Math.floor(Number(maxAttempts)))
    : 0;
  return Boolean(
    realDebridActive &&
      safeAttemptCount < safeMaxAttempts &&
      !sources.some((source) => isRealDebridCachedTorrentSource(source)),
  );
}

export function createRealDebridSourceRefreshController({
  isRealDebridActive = () => false,
  onRefresh = () => {},
  delaysMs = REAL_DEBRID_SOURCE_REFRESH_DELAYS_MS,
  setTimeoutFn = (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeoutFn = (handle) => window.clearTimeout(handle),
} = {}) {
  const delays = delaysMs
    .map((delayMs) => Number(delayMs))
    .filter((delayMs) => Number.isFinite(delayMs) && delayMs >= 0);
  let timeoutHandle = null;
  let activeRequestKey = "";
  let attemptCount = 0;

  const cancelPending = () => {
    if (timeoutHandle !== null) {
      clearTimeoutFn(timeoutHandle);
      timeoutHandle = null;
    }
  };

  const prepareRequest = ({
    requestKey = "",
    refreshRequest = false,
    expectedRequestKey = "",
  } = {}) => {
    const safeRequestKey = String(requestKey || "");
    if (refreshRequest) {
      return Boolean(
        safeRequestKey &&
          safeRequestKey === activeRequestKey &&
          expectedRequestKey === safeRequestKey,
      );
    }
    if (safeRequestKey !== activeRequestKey) {
      cancelPending();
      activeRequestKey = safeRequestKey;
      attemptCount = 0;
    }
    return true;
  };

  const observeSources = ({
    requestKey = "",
    refreshRequest = false,
    sources = [],
  } = {}) => {
    if (String(requestKey || "") !== activeRequestKey) {
      return false;
    }
    const safeSources = Array.isArray(sources) ? sources : [];
    if (
      safeSources.some((source) => isRealDebridCachedTorrentSource(source)) ||
      !isRealDebridActive()
    ) {
      cancelPending();
      return false;
    }
    if (!refreshRequest && attemptCount > 0) {
      return false;
    }
    if (
      !shouldRefreshRealDebridCachedSources({
        realDebridActive: true,
        attemptCount,
        maxAttempts: delays.length,
        sources: safeSources,
      })
    ) {
      cancelPending();
      return false;
    }

    const refreshDelay = delays[attemptCount];
    attemptCount += 1;
    cancelPending();
    timeoutHandle = setTimeoutFn(() => {
      timeoutHandle = null;
      onRefresh(activeRequestKey);
    }, refreshDelay);
    return true;
  };

  return {
    cancelPending,
    dispose: cancelPending,
    observeSources,
    prepareRequest,
  };
}

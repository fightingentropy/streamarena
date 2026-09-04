export const RESUME_CLEAR_AT_END_THRESHOLD_SECONDS = 8;

export function normalizeResumeStartSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 1 ? Math.floor(seconds) : 0;
}

export function shouldRetryPlayerWatchProgress({
  resumeTime,
  userStateOwner,
  hydrationStatus,
}) {
  return Boolean(
    !(Number(resumeTime) > 1) &&
      String(userStateOwner || "").trim() &&
      !hydrationStatus?.authExpired &&
      !hydrationStatus?.didLoadProgress,
  );
}

export function shouldRetryPlayerContinueWatching({
  isTmdbResolvedPlayback,
  userStateOwner,
  hydrationStatus,
}) {
  return Boolean(
    isTmdbResolvedPlayback &&
      String(userStateOwner || "").trim() &&
      !hydrationStatus?.authExpired &&
      !hydrationStatus?.didLoadContinueWatching,
  );
}

export function isPlayerStartupOwnerCurrent(startupOwner, currentOwner) {
  return (
    String(startupOwner || "").trim() ===
    String(currentOwner || "").trim()
  );
}

export function createBoundedWatchProgressRetry({
  fetchUserApiFn,
  timeoutMs = 1200,
  setTimeoutFn = (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeoutFn = (timeoutId) => globalThis.clearTimeout(timeoutId),
  createAbortController = () => new AbortController(),
}) {
  let retryPromise = null;

  return function startBoundedWatchProgressRetry() {
    if (retryPromise) return retryPromise;
    const abortController = createAbortController();
    const abortTimer = setTimeoutFn(() => abortController.abort(), timeoutMs);
    retryPromise = (async () => {
      try {
        const response = await fetchUserApiFn("/api/user/watch-progress", {
          cache: "no-store",
          signal: abortController.signal,
        });
        return response?.ok ? await response.json() : null;
      } catch {
        return null;
      } finally {
        clearTimeoutFn(abortTimer);
      }
    })();
    return retryPromise;
  };
}

export function resolvePendingDirectSeekSeconds(
  requestedStartSeconds,
  pendingSeekSeconds,
) {
  const requested = normalizeResumeStartSeconds(requestedStartSeconds);
  if (requested) return requested;
  return normalizeResumeStartSeconds(pendingSeekSeconds) || null;
}

export function withRemuxResumeStart(source, startSeconds, baseUrl) {
  const safeStart = normalizeResumeStartSeconds(startSeconds);
  if (!safeStart) {
    return source;
  }

  try {
    const url = new URL(source, baseUrl);
    if (url.pathname !== "/api/remux") {
      return source;
    }
    url.searchParams.set("start", String(safeStart));
    return `${url.pathname}?${url.searchParams.toString()}`;
  } catch {
    return source;
  }
}

export function createInitialResumeController({
  getResumeTime,
  getEffectiveCurrentTime,
  getSeekScaleDurationSeconds,
  getTimelineDurationSeconds,
  isTranscodeSourceActive,
  getTranscodeBaseOffsetSeconds,
  getVideo,
  seekToAbsoluteTime,
  syncSeekState,
  now = () => Date.now(),
  setTimeoutFn = (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeoutFn = (timeoutId) => globalThis.clearTimeout(timeoutId),
  retryMs = 250,
  maxAttempts = 120,
  applyWindowMs = 30_000,
  toleranceSeconds = 2,
  clearAtEndThresholdSeconds = RESUME_CLEAR_AT_END_THRESHOLD_SECONDS,
}) {
  let hasApplied = false;
  let retryTimeout = null;
  let attemptCount = 0;
  let applyDeadline = 0;

  function getTargetSeconds() {
    const seconds = Number(getResumeTime());
    return Number.isFinite(seconds) && seconds > 1 ? seconds : 0;
  }

  function hasTarget() {
    return getTargetSeconds() > 0;
  }

  function getStartSeconds() {
    return normalizeResumeStartSeconds(getTargetSeconds());
  }

  function clearRetry() {
    if (retryTimeout !== null) {
      clearTimeoutFn(retryTimeout);
      retryTimeout = null;
    }
  }

  function reset() {
    clearRetry();
    attemptCount = 0;
    hasApplied = false;
    applyDeadline = hasTarget() ? now() + applyWindowMs : 0;
  }

  function markHandled() {
    clearRetry();
    attemptCount = 0;
    hasApplied = true;
    applyDeadline = 0;
  }

  function isAtTarget() {
    const targetSeconds = getTargetSeconds();
    if (!targetSeconds) {
      return true;
    }
    const currentSeconds = getEffectiveCurrentTime();
    return (
      Number.isFinite(currentSeconds) &&
      currentSeconds >= targetSeconds - toleranceSeconds
    );
  }

  function shouldHoldProgressSave(effectiveCurrentTime) {
    const targetSeconds = getTargetSeconds();
    return (
      targetSeconds > 0 &&
      applyDeadline > 0 &&
      now() <= applyDeadline &&
      Number.isFinite(effectiveCurrentTime) &&
      effectiveCurrentTime < targetSeconds - toleranceSeconds
    );
  }

  function applyIfReady() {
    const targetSeconds = getTargetSeconds();
    if (!targetSeconds) {
      hasApplied = true;
      return true;
    }

    if (hasApplied && isAtTarget()) {
      return true;
    }

    if (
      hasApplied &&
      applyDeadline > 0 &&
      now() <= applyDeadline &&
      !isAtTarget()
    ) {
      hasApplied = false;
    }

    if (hasApplied) {
      return true;
    }

    const seekScaleDurationSeconds = getSeekScaleDurationSeconds();
    if (
      !Number.isFinite(seekScaleDurationSeconds) ||
      seekScaleDurationSeconds <= 0 ||
      targetSeconds >= seekScaleDurationSeconds - clearAtEndThresholdSeconds
    ) {
      return false;
    }

    try {
      const video = getVideo();
      if (isTranscodeSourceActive()) {
        const relativeTarget = targetSeconds - getTranscodeBaseOffsetSeconds();
        if (
          relativeTarget >= 0 &&
          Number.isFinite(video.duration) &&
          relativeTarget < video.duration - 3
        ) {
          video.currentTime = relativeTarget;
        } else {
          seekToAbsoluteTime(targetSeconds);
        }
      } else {
        const timelineDurationSeconds = getTimelineDurationSeconds();
        if (
          !Number.isFinite(timelineDurationSeconds) ||
          timelineDurationSeconds <= 0 ||
          targetSeconds >= timelineDurationSeconds - clearAtEndThresholdSeconds
        ) {
          return false;
        }
        video.currentTime = targetSeconds;
      }

      hasApplied = true;
      clearRetry();
      syncSeekState();
      return true;
    } catch {
      return false;
    }
  }

  function scheduleRetry() {
    if (
      hasApplied ||
      !hasTarget() ||
      retryTimeout !== null ||
      attemptCount >= maxAttempts
    ) {
      return;
    }

    attemptCount += 1;
    retryTimeout = setTimeoutFn(() => {
      retryTimeout = null;
      if (!applyIfReady()) {
        scheduleRetry();
      }
    }, retryMs);
  }

  return {
    hasTarget,
    getStartSeconds,
    reset,
    markHandled,
    isAtTarget,
    shouldHoldProgressSave,
    applyIfReady,
    scheduleRetry,
    clearRetry,
    cleanup: clearRetry,
  };
}

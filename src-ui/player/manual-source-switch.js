export function getManualSourceSwitchTimeouts({
  isEmbed = false,
  localTorrentEnabled = false,
  realDebridConfigured = false,
  resolverProvider = "",
} = {}) {
  if (isEmbed) {
    return { resolveTimeoutMs: 30_000, startupTimeoutMs: 12_000 };
  }
  if (localTorrentEnabled) {
    return { resolveTimeoutMs: 180_000, startupTimeoutMs: 60_000 };
  }
  if (
    realDebridConfigured ||
    String(resolverProvider || "").trim().toLowerCase() === "real-debrid"
  ) {
    return { resolveTimeoutMs: 95_000, startupTimeoutMs: 30_000 };
  }
  return { resolveTimeoutMs: 50_000, startupTimeoutMs: 30_000 };
}

/**
 * Coordinates a manual source change without depending on player globals or DOM
 * APIs. The controller keeps the last confirmed playback snapshot until a new
 * source is proven active, so a rapid A -> B -> C sequence can still restore A.
 */
export function createManualSourceSwitchController({
  normalizeSourceHash = (value) => String(value || "").trim(),
  captureProgress = () => ({}),
  getActivePlaybackSource = () => "",
  commit = () => {},
  rollback = () => {},
  markFailed = () => {},
  logger = null,
  setTimeoutFn = (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeoutFn = (timeoutId) => globalThis.clearTimeout(timeoutId),
  progressIntervalMs = 3_000,
  noProgressLimit = 4,
  progressEpsilon = 0.01,
} = {}) {
  let nextGeneration = 0;
  let currentRequest = null;
  let disposed = false;

  const safeProgressIntervalMs = Math.max(1, Number(progressIntervalMs) || 1);
  const safeNoProgressLimit = Math.max(1, Math.floor(noProgressLimit) || 1);
  const safeProgressEpsilon = Math.max(0, Number(progressEpsilon) || 0);

  function log(message, error) {
    try {
      if (typeof logger === "function") {
        logger(message, error);
      } else if (typeof logger?.warn === "function") {
        logger.warn(message, error);
      }
    } catch {
      // Diagnostics must never interfere with playback recovery.
    }
  }

  function normalizeProgress(value) {
    const readyState = Number(value?.readyState);
    const bufferedEnd = Number(value?.bufferedEnd);
    const currentTime = Number(value?.currentTime);
    return {
      readyState: Number.isFinite(readyState) ? readyState : 0,
      bufferedEnd: Number.isFinite(bufferedEnd) ? bufferedEnd : 0,
      currentTime: Number.isFinite(currentTime) ? currentTime : 0,
    };
  }

  function readProgress() {
    try {
      return normalizeProgress(captureProgress());
    } catch (error) {
      log("Unable to inspect manual source-switch progress.", error);
      return normalizeProgress();
    }
  }

  function cancelWatchdog(request) {
    if (request?.watchdogTimeout !== null && request?.watchdogTimeout !== undefined) {
      clearTimeoutFn(request.watchdogTimeout);
      request.watchdogTimeout = null;
    }
  }

  function isCurrent(request) {
    return !disposed && Boolean(request) && currentRequest === request;
  }

  function resetProgressBaseline(request) {
    request.progressBaseline = readProgress();
    request.noProgressTicks = 0;
    request.sawLoadProgress = false;
  }

  function observeForwardProgress(request) {
    if (!isCurrent(request) || !request.armed || request.failureStarted) {
      return false;
    }

    const previous = request.progressBaseline || normalizeProgress();
    const next = readProgress();
    const advanced =
      request.sawLoadProgress ||
      next.readyState > previous.readyState ||
      next.bufferedEnd > previous.bufferedEnd + safeProgressEpsilon ||
      next.currentTime > previous.currentTime + safeProgressEpsilon;
    request.sawLoadProgress = false;

    // Keep high-water marks. A source reset, rewind, or backward seek is not
    // evidence that startup is progressing and must not lower the baseline.
    request.progressBaseline = {
      readyState: Math.max(previous.readyState, next.readyState),
      bufferedEnd: Math.max(previous.bufferedEnd, next.bufferedEnd),
      currentTime: Math.max(previous.currentTime, next.currentTime),
    };

    if (advanced) {
      request.noProgressTicks = 0;
    }
    return advanced;
  }

  function scheduleWatchdog(request) {
    cancelWatchdog(request);
    if (!isCurrent(request) || !request.armed || request.failureStarted) {
      return;
    }

    request.watchdogTimeout = setTimeoutFn(() => {
      request.watchdogTimeout = null;
      if (!isCurrent(request) || !request.armed || request.failureStarted) {
        return;
      }

      if (observeForwardProgress(request)) {
        scheduleWatchdog(request);
        return;
      }

      request.noProgressTicks += 1;
      if (request.noProgressTicks >= request.noProgressLimit) {
        void fail(request, "Source startup timed out.");
        return;
      }
      scheduleWatchdog(request);
    }, safeProgressIntervalMs);
  }

  function begin({
    targetSourceHash = "",
    baseline = null,
    startupTimeoutMs = 0,
  } = {}) {
    if (disposed) {
      throw new Error("Manual source-switch controller has been disposed.");
    }

    const inheritedBaseline = currentRequest
      ? currentRequest.baseline
      : baseline;
    if (currentRequest) {
      cancelWatchdog(currentRequest);
      currentRequest.resolveActive = false;
      currentRequest.armed = false;
      currentRequest.phase = "superseded";
    }

    const normalizedStartupTimeoutMs = Number(startupTimeoutMs);
    const requestNoProgressLimit =
      Number.isFinite(normalizedStartupTimeoutMs) && normalizedStartupTimeoutMs > 0
        ? Math.max(1, Math.ceil(normalizedStartupTimeoutMs / safeProgressIntervalMs))
        : safeNoProgressLimit;
    const request = {
      generation: ++nextGeneration,
      targetSourceHash: normalizeSourceHash(targetSourceHash),
      targetPlaybackSource: "",
      targetAbsolutePlaybackSource: "",
      baseline: inheritedBaseline,
      phase: "resolving",
      resolveActive: true,
      armed: false,
      failureStarted: false,
      progressBaseline: null,
      noProgressTicks: 0,
      noProgressLimit: requestNoProgressLimit,
      sawLoadProgress: false,
      commitData: null,
      watchdogTimeout: null,
      rollbackPromise: null,
    };
    currentRequest = request;
    return request;
  }

  function arm(request) {
    if (!isCurrent(request) || request.failureStarted) {
      return false;
    }
    request.armed = true;
    request.phase = request.targetAbsolutePlaybackSource || request.targetPlaybackSource
      ? "playback-requested"
      : "armed";
    resetProgressBaseline(request);
    scheduleWatchdog(request);
    return true;
  }

  function recordPlaybackRequested(
    request,
    {
      sourceHash = "",
      playbackSource = "",
      absolutePlaybackSource = "",
    } = {},
  ) {
    if (!isCurrent(request) || request.failureStarted) {
      return false;
    }

    const rawSourceHash = String(sourceHash || "").trim();
    const normalizedSourceHash = normalizeSourceHash(rawSourceHash);
    if (rawSourceHash && !normalizedSourceHash) {
      return false;
    }
    if (
      request.targetSourceHash &&
      normalizedSourceHash !== request.targetSourceHash
    ) {
      return false;
    }

    const nextPlaybackSource = String(playbackSource || "").trim();
    const nextAbsolutePlaybackSource = String(
      absolutePlaybackSource || "",
    ).trim();
    if (!nextPlaybackSource && !nextAbsolutePlaybackSource) {
      return false;
    }

    if (!request.targetSourceHash && normalizedSourceHash) {
      request.targetSourceHash = normalizedSourceHash;
    }
    request.targetPlaybackSource = nextPlaybackSource;
    request.targetAbsolutePlaybackSource = nextAbsolutePlaybackSource;
    request.phase = "playback-requested";

    // Source assignment often resets readyState, buffered ranges, and time.
    // Start a fresh watchdog window from the newly requested media's values.
    resetProgressBaseline(request);
    if (request.armed) {
      scheduleWatchdog(request);
    }
    return true;
  }

  function noteProgress(request = currentRequest) {
    if (!isCurrent(request) || !request.armed || request.failureStarted) {
      return false;
    }
    request.sawLoadProgress = true;
    return true;
  }

  function setCommitData(request, commitData) {
    if (!isCurrent(request) || request.failureStarted) {
      return false;
    }
    request.commitData = commitData;
    return true;
  }

  function completeIfActive(
    request = currentRequest,
    { activePlaybackSource = "" } = {},
  ) {
    if (!isCurrent(request) || !request.armed || request.failureStarted) {
      return false;
    }

    const expectedSource = String(
      request.targetAbsolutePlaybackSource || request.targetPlaybackSource || "",
    ).trim();
    if (!expectedSource) {
      return false;
    }

    let activeSource = String(activePlaybackSource || "").trim();
    if (!activeSource) {
      try {
        activeSource = String(getActivePlaybackSource(request) || "").trim();
      } catch (error) {
        log("Unable to inspect the active manual source-switch URL.", error);
        return false;
      }
    }
    if (!activeSource || activeSource !== expectedSource) {
      return false;
    }

    cancelWatchdog(request);
    request.resolveActive = false;
    request.armed = false;
    request.phase = "completed";
    currentRequest = null;
    try {
      const commitResult = commit(request.commitData, { request });
      if (commitResult && typeof commitResult.catch === "function") {
        void commitResult.catch((error) => {
          log("Unable to commit the manual playback source.", error);
        });
      }
    } catch (error) {
      log("Unable to commit the manual playback source.", error);
    }
    return true;
  }

  function fail(request, reason = "") {
    if (!isCurrent(request) || request.failureStarted) {
      return Promise.resolve(false);
    }

    request.failureStarted = true;
    request.resolveActive = false;
    request.armed = false;
    request.phase = "failed";
    cancelWatchdog(request);

    const context = {
      reason: String(reason || "").trim(),
      request,
    };
    if (request.targetSourceHash) {
      try {
        markFailed(request.targetSourceHash, context);
      } catch (error) {
        log("Unable to mark a failed manual playback source.", error);
      }
    }

    let rollbackResult;
    try {
      rollbackResult = rollback(request.baseline, context);
    } catch (error) {
      log("Unable to restore the confirmed playback source.", error);
      if (currentRequest === request) {
        currentRequest = null;
      }
      request.rollbackPromise = Promise.resolve(true);
      return request.rollbackPromise;
    }

    request.rollbackPromise = Promise.resolve(rollbackResult)
      .catch((error) => {
        log("Unable to restore the confirmed playback source.", error);
      })
      .then(() => {
        if (currentRequest === request) {
          currentRequest = null;
        }
        return true;
      });
    return request.rollbackPromise;
  }

  function finish(request) {
    if (!isCurrent(request) || request.failureStarted) {
      return false;
    }
    request.resolveActive = false;
    if (!request.armed) {
      request.phase = "finished";
      currentRequest = null;
    }
    return true;
  }

  function isPending() {
    return Boolean(currentRequest);
  }

  function isRequestActive() {
    return Boolean(currentRequest?.resolveActive);
  }

  function getPending() {
    return currentRequest;
  }

  function clear() {
    if (!currentRequest) {
      return false;
    }
    const request = currentRequest;
    cancelWatchdog(request);
    request.resolveActive = false;
    request.armed = false;
    request.phase = "cleared";
    currentRequest = null;
    return true;
  }

  function dispose() {
    clear();
    disposed = true;
  }

  return {
    begin,
    isCurrent,
    arm,
    recordPlaybackRequested,
    noteProgress,
    setCommitData,
    completeIfActive,
    fail,
    finish,
    isPending,
    isRequestActive,
    getPending,
    clear,
    dispose,
  };
}

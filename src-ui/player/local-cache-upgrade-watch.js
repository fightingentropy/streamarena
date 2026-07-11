function shallowEqual(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => Object.is(left[key], right[key]));
}

export function createLocalCacheUpgradeWatch({
  shouldWatch = () => false,
  canPoll = () => false,
  getRequestIdentity = () => null,
  requestUpgrade = async () => null,
  shouldApplyPayload = (payload) => Boolean(payload),
  applyUpgrade = async () => {},
  isSameIdentity = shallowEqual,
  setTimeoutFn = (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeoutFn = (timeoutId) => globalThis.clearTimeout(timeoutId),
  setIntervalFn = (callback, delayMs) => globalThis.setInterval(callback, delayMs),
  clearIntervalFn = (intervalId) => globalThis.clearInterval(intervalId),
  initialDelayMs = 8_000,
  pollIntervalMs = 20_000,
  logger = null,
} = {}) {
  let generation = 0;
  let initialTimeout = null;
  let pollInterval = null;
  let upgraded = false;
  let disposed = false;
  const inFlightGenerations = new Set();

  function log(message, error) {
    try {
      if (typeof logger === "function") {
        logger(message, error);
      } else if (typeof logger?.warn === "function") {
        logger.warn(message, error);
      }
    } catch {
      // Best-effort cache upgrades must never interfere with playback.
    }
  }

  function clearTimers() {
    if (pollInterval !== null) {
      clearIntervalFn(pollInterval);
      pollInterval = null;
    }
    if (initialTimeout !== null) {
      clearTimeoutFn(initialTimeout);
      initialTimeout = null;
    }
  }

  function stop() {
    generation += 1;
    clearTimers();
  }

  async function poll(expectedGeneration) {
    if (
      disposed ||
      expectedGeneration !== generation ||
      upgraded ||
      inFlightGenerations.has(expectedGeneration) ||
      !canPoll()
    ) {
      return false;
    }

    let requestIdentity;
    try {
      requestIdentity = getRequestIdentity();
    } catch (error) {
      log("Unable to identify the local-cache upgrade request.", error);
      return false;
    }
    if (!requestIdentity) {
      stop();
      return false;
    }

    inFlightGenerations.add(expectedGeneration);
    try {
      const payload = await requestUpgrade(requestIdentity);
      if (
        disposed ||
        expectedGeneration !== generation ||
        upgraded ||
        !isSameIdentity(requestIdentity, getRequestIdentity()) ||
        !shouldApplyPayload(payload)
      ) {
        return false;
      }
      await applyUpgrade(payload, requestIdentity);
      return true;
    } catch (error) {
      log("Unable to upgrade playback from the local cache.", error);
      return false;
    } finally {
      inFlightGenerations.delete(expectedGeneration);
    }
  }

  function start(resolved) {
    if (disposed) {
      return false;
    }
    stop();
    upgraded = false;
    if (!shouldWatch(resolved)) {
      return false;
    }

    const watchGeneration = generation;
    initialTimeout = setTimeoutFn(() => {
      initialTimeout = null;
      void poll(watchGeneration);
    }, initialDelayMs);
    pollInterval = setIntervalFn(() => {
      void poll(watchGeneration);
    }, pollIntervalMs);
    return true;
  }

  function isActive() {
    return Boolean(
      initialTimeout !== null ||
        pollInterval !== null ||
        inFlightGenerations.has(generation),
    );
  }

  function hasUpgraded() {
    return upgraded;
  }

  function setHasUpgraded(value) {
    upgraded = Boolean(value);
  }

  function dispose() {
    stop();
    disposed = true;
  }

  return {
    start,
    stop,
    isActive,
    hasUpgraded,
    setHasUpgraded,
    dispose,
  };
}

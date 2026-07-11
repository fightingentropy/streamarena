function normalizeSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
}

/**
 * Estimates playback progress for cross-origin iframe players whose media time
 * cannot be read directly. Explicit play/pause intent is kept separate from a
 * temporary visibility suspension, so returning to a visible tab only resumes
 * a clock that the user still wants to play.
 */
export function createLiveIframePlaybackClock({
  now = () => globalThis.performance.now(),
  isActive = () => true,
  isVisible = () => true,
} = {}) {
  let baseSeconds = 0;
  let startedAtMs = null;
  let wantsPlay = false;
  let visibilitySuspended = false;

  function readNow() {
    const value = Number(now());
    return Number.isFinite(value) ? value : 0;
  }

  function canRun() {
    return Boolean(
      wantsPlay &&
        !visibilitySuspended &&
        isActive() &&
        isVisible(),
    );
  }

  function getElapsedSeconds(nowMs) {
    if (startedAtMs === null) {
      return 0;
    }
    return Math.max(0, (nowMs - startedAtMs) / 1_000);
  }

  function settle(nowMs) {
    if (startedAtMs === null) {
      return;
    }
    baseSeconds += getElapsedSeconds(nowMs);
    startedAtMs = null;
  }

  function reconcile(nowMs) {
    if (startedAtMs !== null && !canRun()) {
      settle(nowMs);
      return;
    }
    if (startedAtMs === null && canRun()) {
      startedAtMs = nowMs;
    }
  }

  function start({ startSeconds = 0, autoplay = true } = {}) {
    baseSeconds = normalizeSeconds(startSeconds);
    startedAtMs = null;
    wantsPlay = Boolean(autoplay);
    visibilitySuspended = !isVisible();
    reconcile(readNow());
  }

  function play() {
    wantsPlay = true;
    reconcile(readNow());
  }

  function pause() {
    const nowMs = readNow();
    settle(nowMs);
    wantsPlay = false;
  }

  function suspend() {
    settle(readNow());
    visibilitySuspended = true;
  }

  function resume() {
    visibilitySuspended = false;
    reconcile(readNow());
  }

  function reset() {
    baseSeconds = 0;
    startedAtMs = null;
    wantsPlay = false;
    visibilitySuspended = false;
  }

  function getSeconds() {
    const nowMs = readNow();
    reconcile(nowMs);
    return baseSeconds + getElapsedSeconds(nowMs);
  }

  function isPaused() {
    return !wantsPlay;
  }

  function isRunning() {
    reconcile(readNow());
    return startedAtMs !== null;
  }

  return {
    start,
    play,
    pause,
    suspend,
    resume,
    reset,
    getSeconds,
    isPaused,
    isRunning,
  };
}

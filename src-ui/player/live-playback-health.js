export const LIVE_VISUAL_HEALTH_GRACE_MS = 6000;
export const LIVE_VISUAL_HEALTH_INTERVAL_MS = 2000;
export const LIVE_VISUAL_HEALTH_SAMPLE_WIDTH = 32;
export const LIVE_VISUAL_HEALTH_SAMPLE_HEIGHT = 18;
export const LIVE_VISUAL_HEALTH_MAX_BLANK_SAMPLES = 4;
export const LIVE_VISUAL_HEALTH_MAX_AVG_LUMA = 8;
export const LIVE_VISUAL_HEALTH_MIN_BRIGHT_PIXEL_RATIO = 0.012;
// If a live source has not started playing within this window, give up on it
// and fail over to the next source. Kept short so a dead/stalled source is
// abandoned quickly instead of making the viewer wait (or click through).
export const LIVE_STARTUP_HEALTH_TIMEOUT_MS = 6000;

export function hasLivePlaybackStarted({
  readyState = 0,
  videoWidth = 0,
  videoHeight = 0,
  currentTimeSeconds = 0,
} = {}) {
  return Boolean(
    Number(readyState) >= 2 ||
      Number(videoWidth) > 0 ||
      Number(videoHeight) > 0 ||
      Number(currentTimeSeconds) > 0.25,
  );
}

export function analyzeLiveVideoBlankness(
  pixelData,
  {
    maxAvgLuma = LIVE_VISUAL_HEALTH_MAX_AVG_LUMA,
    minBrightPixelRatio = LIVE_VISUAL_HEALTH_MIN_BRIGHT_PIXEL_RATIO,
  } = {},
) {
  const data = pixelData || [];
  const pixels = data.length / 4;
  if (pixels <= 0) {
    return null;
  }

  let totalLuma = 0;
  let brightPixels = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    const luma =
      data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
    totalLuma += luma;
    if (luma > maxAvgLuma * 2) {
      brightPixels += 1;
    }
  }

  const avgLuma = totalLuma / pixels;
  const brightPixelRatio = brightPixels / pixels;
  return {
    avgLuma,
    brightPixelRatio,
    isBlank:
      avgLuma <= maxAvgLuma && brightPixelRatio <= minBrightPixelRatio,
  };
}

export function createLivePlaybackHealthWatch({
  isLivePlayback,
  isIframePlayback,
  getStreamOptionCount,
  isAutoFallbackInFlight,
  hasRecoverablePlaybackSource,
  hasActiveSource,
  isVideoPaused,
  isDocumentHidden,
  getVideo,
  getCurrentTimeSeconds,
  getCurrentSource,
  getSelectedStreamId,
  getLastSourceSetAt,
  onVisualFailover,
  onStartupFailover,
  now = () => globalThis.performance.now(),
  setIntervalFn = (callback, delayMs) =>
    globalThis.setInterval(callback, delayMs),
  clearIntervalFn = (intervalId) => globalThis.clearInterval(intervalId),
  setTimeoutFn = (callback, delayMs) =>
    globalThis.setTimeout(callback, delayMs),
  clearTimeoutFn = (timeoutId) => globalThis.clearTimeout(timeoutId),
  readVideoPixels = null,
} = {}) {
  let visualInterval = null;
  let blankSampleCount = 0;
  let startupTimeout = null;
  let startupArmed = false;
  let sampleCanvas = null;

  function readNow() {
    const value = Number(now());
    return Number.isFinite(value) ? value : 0;
  }

  function readPixels(media) {
    if (readVideoPixels) {
      return readVideoPixels(media);
    }
    if (!sampleCanvas) {
      sampleCanvas = document.createElement("canvas");
      sampleCanvas.width = LIVE_VISUAL_HEALTH_SAMPLE_WIDTH;
      sampleCanvas.height = LIVE_VISUAL_HEALTH_SAMPLE_HEIGHT;
    }
    const context = sampleCanvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      return null;
    }
    context.drawImage(
      media,
      0,
      0,
      LIVE_VISUAL_HEALTH_SAMPLE_WIDTH,
      LIVE_VISUAL_HEALTH_SAMPLE_HEIGHT,
    );
    return context.getImageData(
      0,
      0,
      LIVE_VISUAL_HEALTH_SAMPLE_WIDTH,
      LIVE_VISUAL_HEALTH_SAMPLE_HEIGHT,
    ).data;
  }

  function shouldWatchStartup() {
    return Boolean(
      isLivePlayback?.() &&
        !isAutoFallbackInFlight?.() &&
        Number(getStreamOptionCount?.() || 0) > 1 &&
        !isIframePlayback?.() &&
        hasRecoverablePlaybackSource?.(),
    );
  }

  function mediaHasStarted() {
    const media = getVideo?.() || {};
    return hasLivePlaybackStarted({
      readyState: media.readyState,
      videoWidth: media.videoWidth,
      videoHeight: media.videoHeight,
      currentTimeSeconds: getCurrentTimeSeconds?.(),
    });
  }

  function currentSource() {
    return String(getCurrentSource?.() || "");
  }

  function clearVisual({ resetSamples = false } = {}) {
    if (visualInterval !== null) {
      clearIntervalFn(visualInterval);
      visualInterval = null;
    }
    if (resetSamples) {
      blankSampleCount = 0;
    }
  }

  function clearStartup({ resetRequest = false } = {}) {
    if (startupTimeout !== null) {
      clearTimeoutFn(startupTimeout);
      startupTimeout = null;
    }
    if (resetRequest) {
      startupArmed = false;
    }
  }

  function sampleBlankness() {
    const media = getVideo?.();
    if (
      !media ||
      media.videoWidth <= 0 ||
      media.videoHeight <= 0 ||
      isIframePlayback?.()
    ) {
      return null;
    }
    try {
      return analyzeLiveVideoBlankness(readPixels(media));
    } catch {
      return null;
    }
  }

  function checkVisual() {
    if (
      !isLivePlayback?.() ||
      isAutoFallbackInFlight?.() ||
      Number(getStreamOptionCount?.() || 0) <= 1 ||
      isDocumentHidden?.() ||
      isIframePlayback?.() ||
      isVideoPaused?.() ||
      !hasActiveSource?.() ||
      readNow() - Number(getLastSourceSetAt?.() || 0) < LIVE_VISUAL_HEALTH_GRACE_MS
    ) {
      blankSampleCount = 0;
      return;
    }

    const sample = sampleBlankness();
    if (!sample) {
      return;
    }
    if (!sample.isBlank) {
      blankSampleCount = 0;
      return;
    }

    blankSampleCount += 1;
    if (blankSampleCount < LIVE_VISUAL_HEALTH_MAX_BLANK_SAMPLES) {
      return;
    }

    blankSampleCount = 0;
    onVisualFailover?.();
  }

  function startVisual() {
    if (
      !isLivePlayback?.() ||
      isIframePlayback?.() ||
      Number(getStreamOptionCount?.() || 0) <= 1
    ) {
      return;
    }
    if (visualInterval !== null) {
      return;
    }
    visualInterval = setIntervalFn(checkVisual, LIVE_VISUAL_HEALTH_INTERVAL_MS);
  }

  function checkStartup(expectedSource, expectedStreamId) {
    startupTimeout = null;

    if (
      !startupArmed ||
      !shouldWatchStartup() ||
      isDocumentHidden?.()
    ) {
      return;
    }

    const source = currentSource();
    if (expectedSource && source && source !== expectedSource) {
      return;
    }
    if (
      expectedStreamId &&
      getSelectedStreamId?.() &&
      getSelectedStreamId() !== expectedStreamId
    ) {
      return;
    }

    if (mediaHasStarted()) {
      clearStartup({ resetRequest: true });
      return;
    }

    const elapsedSinceSourceSet = readNow() - Number(getLastSourceSetAt?.() || 0);
    if (elapsedSinceSourceSet < LIVE_STARTUP_HEALTH_TIMEOUT_MS) {
      scheduleStartup();
      return;
    }

    onStartupFailover?.();
  }

  function scheduleStartup() {
    if (!startupArmed || !shouldWatchStartup()) {
      return;
    }

    clearStartup();
    const elapsedSinceSourceSet = readNow() - Number(getLastSourceSetAt?.() || 0);
    const delayMs = Math.max(
      0,
      LIVE_STARTUP_HEALTH_TIMEOUT_MS - elapsedSinceSourceSet,
    );
    const expectedSource = currentSource();
    const expectedStreamId = getSelectedStreamId?.();
    startupTimeout = setTimeoutFn(
      () => checkStartup(expectedSource, expectedStreamId),
      delayMs,
    );
  }

  function armStartup() {
    if (!shouldWatchStartup()) {
      return;
    }
    startupArmed = true;
    scheduleStartup();
  }

  return {
    clearVisual,
    clearStartup,
    startVisual,
    armStartup,
    hasPlaybackStarted: mediaHasStarted,
    isStartupArmed: () => startupArmed,
  };
}

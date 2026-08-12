export const LIVE_EDGE_PIN_RATIO = 0.985;
export const LIVE_EDGE_PLAYBACK_OFFSET_SECONDS = 0.5;
export const LIVE_EDGE_REJOIN_TOLERANCE_SECONDS = 2.5;

export function getLiveSeekableWindow(video, isLivePlayback) {
  if (!isLivePlayback || !video) {
    return null;
  }

  const seekable = video.seekable;
  if (seekable?.length > 0) {
    for (let index = seekable.length - 1; index >= 0; index -= 1) {
      try {
        const start = Number(seekable.start(index));
        const end = Number(seekable.end(index));
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
          return { start, end, duration: end - start };
        }
      } catch {
        // Continue to older ranges if the browser invalidated this one.
      }
    }
  }

  const duration = Number(video.duration);
  if (Number.isFinite(duration) && duration > 0) {
    return { start: 0, end: duration, duration };
  }

  return null;
}

export function getLiveEdgeTargetSeconds(
  liveWindow,
  offsetSeconds = LIVE_EDGE_PLAYBACK_OFFSET_SECONDS,
) {
  if (!liveWindow) {
    return null;
  }
  return Math.max(liveWindow.start, liveWindow.end - offsetSeconds);
}

export function clampLiveSeekTargetSeconds(targetSeconds, liveWindow) {
  const target = Number(targetSeconds);
  if (!Number.isFinite(target)) {
    return 0;
  }
  if (!liveWindow) {
    return Math.max(0, target);
  }
  return Math.max(liveWindow.start, Math.min(liveWindow.end, target));
}

export function getSeekTargetSecondsFromRatio(
  ratio,
  {
    isLivePlayback = false,
    liveWindow = null,
    fallbackDurationSeconds = 0,
    pinRatio = LIVE_EDGE_PIN_RATIO,
  } = {},
) {
  const clampedRatio = Math.max(0, Math.min(1, Number(ratio) || 0));
  if (isLivePlayback && liveWindow) {
    const liveEdgeTarget = getLiveEdgeTargetSeconds(liveWindow);
    if (clampedRatio >= pinRatio && Number.isFinite(liveEdgeTarget)) {
      return liveEdgeTarget;
    }
    return liveWindow.start + clampedRatio * liveWindow.duration;
  }

  const duration = Number(fallbackDurationSeconds);
  return clampedRatio * (Number.isFinite(duration) && duration > 0 ? duration : 0);
}

export function shouldPinLiveEdgeFromTarget(
  targetSeconds,
  liveEdgeTarget,
  toleranceSeconds = LIVE_EDGE_REJOIN_TOLERANCE_SECONDS,
) {
  if (!Number.isFinite(liveEdgeTarget)) {
    return true;
  }
  return Number(targetSeconds) >= liveEdgeTarget - toleranceSeconds;
}

import { setRuntimeStyleRule } from "../lib/runtime-styles.js";

const SEEK_PREVIEW_WIDTH = 160;
const SEEK_PREVIEW_HEIGHT = 90;
const SEEK_PREVIEW_SEEK_THROTTLE_MS = 220;
const SEEK_PREVIEW_RENDERED_TARGET_EPSILON_SECONDS = 0.08;
const SEEK_PREVIEW_IDLE_TIMEOUT_MS = 15_000;

export function attachSeekInteractions({
  clampLiveSeekTargetSeconds,
  clearPendingSeekRatios,
  formatTime,
  getBufferedSeekValue,
  getLastRequestedAbsolutePlaybackSource,
  getLastRequestedPlaybackSource,
  getLiveSeekableWindow,
  getPendingStandardSeekRatio,
  getPendingTranscodeSeekRatio,
  getSeekRatioFromPointerEvent,
  getSeekScaleDurationSeconds,
  getSeekTargetSecondsFromRatio,
  hasActiveSource,
  isDraggingSeek,
  isHlsPlaybackSource,
  isLivePlayback,
  isResolvingSource,
  isTranscodeSourceActive,
  liveEdgePinRatio,
  liveEdgeRejoinToleranceSeconds,
  paintSeekProgress,
  parseLiveIframePlaybackSource,
  seekBar,
  seekPreview,
  seekPreviewCanvas,
  seekPreviewTime,
  seekToAbsoluteTime,
  setDraggingSeek,
  setPendingSeekRatio,
  shouldUseHlsJsForSource,
  syncDurationText,
  trackListener,
  video,
}) {
  const seekPreviewCtx = seekPreviewCanvas.getContext("2d", {
    willReadFrequently: false,
  });
  let seekPreviewVideo = null;
  let seekPreviewHlsController = null;
  let seekPreviewHlsConstructorPromise = null;
  let seekPreviewSource = "";
  let seekPreviewReady = false;
  let seekPreviewPendingTarget = null;
  let seekPreviewLoadingTarget = null;
  let seekPreviewRenderedTarget = null;
  let seekPreviewLastSeekAt = Number.NEGATIVE_INFINITY;
  let seekPreviewThrottleTimer = null;
  let seekPreviewIdleTimer = null;
  let seekPreviewSourceRequestId = 0;
  seekPreviewCanvas.hidden = true;

  function clearSeekPreviewCanvas() {
    seekPreviewCanvas.hidden = true;
    seekPreviewCtx.clearRect(0, 0, SEEK_PREVIEW_WIDTH, SEEK_PREVIEW_HEIGHT);
  }

  function drawSeekPreviewFrame() {
    if (
      !seekPreviewVideo ||
      seekPreviewLoadingTarget === null ||
      seekPreviewVideo.seeking ||
      seekPreviewVideo.readyState < 2 ||
      !seekPreviewVideo.videoWidth ||
      Math.abs(seekPreviewVideo.currentTime - seekPreviewLoadingTarget) > 0.25
    ) {
      return false;
    }
    try {
      seekPreviewCtx.drawImage(
        seekPreviewVideo,
        0,
        0,
        SEEK_PREVIEW_WIDTH,
        SEEK_PREVIEW_HEIGHT,
      );
      seekPreviewRenderedTarget = Number(seekPreviewVideo.currentTime) || 0;
      seekPreviewLoadingTarget = null;
      seekPreviewCanvas.hidden = false;
      // A paused thumbnail needs one decoded frame, not a playback buffer.
      seekPreviewHlsController?.stopLoad();
      return true;
    } catch {
      return false;
    }
  }

  function handleSeekPreviewFrameReady(event) {
    const previewVideo = seekPreviewVideo;
    const requestId = seekPreviewSourceRequestId;
    const target = seekPreviewLoadingTarget;
    if (event.currentTarget !== previewVideo || target === null) {
      return;
    }
    window.requestAnimationFrame(() => {
      if (
        previewVideo === seekPreviewVideo &&
        requestId === seekPreviewSourceRequestId &&
        target === seekPreviewLoadingTarget
      ) {
        drawSeekPreviewFrame();
      }
    });
  }

  function handleSeekPreviewMetadataReady(event) {
    if (event.currentTarget === seekPreviewVideo) {
      markSeekPreviewReady();
    }
  }

  function getOrCreatePreviewVideo() {
    if (seekPreviewVideo) return seekPreviewVideo;
    seekPreviewVideo = document.createElement("video");
    seekPreviewVideo.preload = "metadata";
    seekPreviewVideo.muted = true;
    seekPreviewVideo.playsInline = true;
    seekPreviewVideo.crossOrigin = video.crossOrigin || "anonymous";
    seekPreviewVideo.setAttribute("aria-hidden", "true");
    seekPreviewVideo.tabIndex = -1;
    seekPreviewVideo.className = "seek-preview-video-probe";
    seekPreviewVideo.addEventListener("seeked", handleSeekPreviewFrameReady);
    seekPreviewVideo.addEventListener(
      "loadedmetadata",
      handleSeekPreviewMetadataReady,
    );
    seekPreviewVideo.addEventListener("loadeddata", handleSeekPreviewFrameReady);
    seekPreviewVideo.addEventListener("canplay", handleSeekPreviewFrameReady);
    document.body.appendChild(seekPreviewVideo);
    return seekPreviewVideo;
  }

  function loadSeekPreviewHlsConstructor() {
    if (!seekPreviewHlsConstructorPromise) {
      seekPreviewHlsConstructorPromise = import("hls.js").then(
        (module) => module.default || module.Hls || module,
      );
    }
    return seekPreviewHlsConstructorPromise;
  }

  function destroySeekPreviewHlsController() {
    if (!seekPreviewHlsController) {
      return;
    }
    try {
      seekPreviewHlsController.destroy();
    } catch {
      // Ignore preview teardown failures.
    }
    seekPreviewHlsController = null;
  }

  function closeSeekPreviewVideo() {
    destroySeekPreviewHlsController();
    window.clearTimeout(seekPreviewIdleTimer);
    seekPreviewIdleTimer = null;
    if (seekPreviewThrottleTimer) {
      window.clearTimeout(seekPreviewThrottleTimer);
      seekPreviewThrottleTimer = null;
    }
    if (seekPreviewVideo) {
      seekPreviewVideo.pause();
      seekPreviewVideo.removeAttribute("src");
      seekPreviewVideo.load();
      seekPreviewVideo.remove();
      seekPreviewVideo = null;
    }
    seekPreviewSource = "";
    seekPreviewPendingTarget = null;
    seekPreviewLoadingTarget = null;
    seekPreviewRenderedTarget = null;
    seekPreviewReady = false;
    seekPreviewLastSeekAt = Number.NEGATIVE_INFINITY;
    seekPreviewSourceRequestId += 1;
    clearSeekPreviewCanvas();
  }

  function getSeekPreviewPlaybackSource() {
    if (parseLiveIframePlaybackSource(getLastRequestedPlaybackSource())) {
      return "";
    }
    const requestedSource =
      String(getLastRequestedAbsolutePlaybackSource() || "").trim() ||
      (() => {
        try {
          const requestedPlaybackSource = getLastRequestedPlaybackSource();
          return requestedPlaybackSource
            ? new URL(requestedPlaybackSource, window.location.origin).toString()
            : "";
        } catch {
          return "";
        }
      })();
    if (requestedSource && isHlsPlaybackSource(requestedSource)) {
      return requestedSource;
    }
    const currentSource = String(
      video.currentSrc || video.getAttribute("src") || "",
    ).trim();
    if (currentSource && !currentSource.startsWith("blob:")) {
      return currentSource;
    }
    return requestedSource;
  }

  function markSeekPreviewReady() {
    if (!seekPreviewSource) {
      return;
    }
    seekPreviewReady = true;
    const target = seekPreviewPendingTarget ?? seekPreviewLoadingTarget;
    if (target !== null && !seekPreview.hidden) {
      scheduleSeekPreviewFrame(target, { force: true });
    }
  }

  function syncPreviewVideoSource() {
    const pv = getOrCreatePreviewVideo();
    const nextSource = getSeekPreviewPlaybackSource();
    if (!nextSource) {
      closeSeekPreviewVideo();
      return false;
    }
    if (seekPreviewSource === nextSource) {
      return seekPreviewReady;
    }

    destroySeekPreviewHlsController();
    seekPreviewSourceRequestId += 1;
    const requestId = seekPreviewSourceRequestId;
    seekPreviewSource = nextSource;
    seekPreviewReady = false;
    seekPreviewPendingTarget = null;
    seekPreviewLoadingTarget = null;
    seekPreviewRenderedTarget = null;
    seekPreviewLastSeekAt = Number.NEGATIVE_INFINITY;
    window.clearTimeout(seekPreviewThrottleTimer);
    seekPreviewThrottleTimer = null;
    clearSeekPreviewCanvas();
    pv.pause();
    pv.removeAttribute("src");
    pv.load();

    if (isHlsPlaybackSource(nextSource) && shouldUseHlsJsForSource(nextSource)) {
      void loadSeekPreviewHlsConstructor()
        .then((HlsConstructor) => {
          if (
            requestId !== seekPreviewSourceRequestId ||
            seekPreviewSource !== nextSource
          ) {
            return;
          }
          if (!HlsConstructor?.isSupported?.()) {
            return;
          }
          const hls = new HlsConstructor({
            autoStartLoad: false,
            startLevel: 0,
            maxBufferLength: 2,
            maxMaxBufferLength: 4,
            maxBufferSize: 2_000_000,
            backBufferLength: 0,
          });
          seekPreviewHlsController = hls;
          hls.on(HlsConstructor.Events.MEDIA_ATTACHED, () => {
            if (seekPreviewHlsController === hls) {
              hls.loadSource(nextSource);
            }
          });
          hls.on(HlsConstructor.Events.MANIFEST_PARSED, () => {
            if (seekPreviewHlsController === hls) {
              // The smallest rendition is sufficient for a 160px thumbnail.
              hls.loadLevel = 0;
              markSeekPreviewReady();
            }
          });
          hls.on(HlsConstructor.Events.ERROR, (_event, data = {}) => {
            if (seekPreviewHlsController !== hls || !data?.fatal) {
              return;
            }
            seekPreviewReady = false;
            seekPreviewLoadingTarget = null;
            clearSeekPreviewCanvas();
          });
          hls.attachMedia(pv);
        })
        .catch(() => {});
      return false;
    }

    pv.src = nextSource;
    pv.load();
    return false;
  }

  function normalizeSeekPreviewTarget(timeAtCursor, duration) {
    const rawTarget = Number(timeAtCursor) || 0;
    return isLivePlayback()
      ? clampLiveSeekTargetSeconds(rawTarget)
      : Math.max(0, Math.min(duration, rawTarget));
  }

  function requestSeekPreviewFrame(target) {
    if (!seekPreviewVideo || !seekPreviewReady) {
      seekPreviewPendingTarget = target;
      return;
    }
    const videoDuration = Number(seekPreviewVideo.duration);
    const clampedTarget =
      Number.isFinite(videoDuration) && videoDuration > 0
        ? Math.max(0, Math.min(videoDuration, target))
        : Math.max(0, target);
    if (
      seekPreviewRenderedTarget !== null &&
      Math.abs(seekPreviewRenderedTarget - clampedTarget) <
        SEEK_PREVIEW_RENDERED_TARGET_EPSILON_SECONDS
    ) {
      seekPreviewPendingTarget = null;
      seekPreviewLoadingTarget = null;
      seekPreviewHlsController?.stopLoad();
      return;
    }
    seekPreviewPendingTarget = null;
    seekPreviewLoadingTarget = clampedTarget;
    // Keep the last decoded frame visible while the new timestamp loads.
    try {
      if (
        Math.abs(Number(seekPreviewVideo.currentTime || 0) - clampedTarget) <
          0.25 &&
        drawSeekPreviewFrame()
      ) {
        return;
      }
      if (seekPreviewVideo.currentTime !== clampedTarget) {
        seekPreviewVideo.currentTime = clampedTarget;
      }
      if (
        seekPreviewHlsController &&
        (!seekPreviewHlsController.loadingEnabled || seekPreviewVideo.readyState === 0)
      ) {
        seekPreviewHlsController.startLoad(clampedTarget);
      }
    } catch {
      seekPreviewPendingTarget = clampedTarget;
    }
  }

  function scheduleSeekPreviewFrame(target, { force = false } = {}) {
    if (!seekPreviewReady) {
      seekPreviewPendingTarget = target;
      return;
    }
    const now = performance.now();
    const remainingDelay = force
      ? 0
      : Math.max(
          0,
          SEEK_PREVIEW_SEEK_THROTTLE_MS - (now - seekPreviewLastSeekAt),
        );
    seekPreviewPendingTarget = target;
    if (remainingDelay > 0) {
      if (!seekPreviewThrottleTimer) {
        seekPreviewThrottleTimer = window.setTimeout(() => {
          seekPreviewThrottleTimer = null;
          const queuedTarget = seekPreviewPendingTarget;
          if (queuedTarget !== null) {
            seekPreviewLastSeekAt = performance.now();
            requestSeekPreviewFrame(queuedTarget);
          }
        }, remainingDelay);
      }
      return;
    }
    window.clearTimeout(seekPreviewThrottleTimer);
    seekPreviewThrottleTimer = null;
    seekPreviewLastSeekAt = now;
    requestSeekPreviewFrame(target);
  }

  function updateSeekPreview(event) {
    window.clearTimeout(seekPreviewIdleTimer);
    seekPreviewIdleTimer = null;
    const rect = seekBar.getBoundingClientRect();
    const x = Math.max(0, Math.min(event.clientX - rect.left, rect.width));
    const ratio = x / rect.width;
    const duration = getSeekScaleDurationSeconds();
    if (duration <= 0) return;

    const timeAtCursor = getSeekTargetSecondsFromRatio(ratio, duration);
    if (isLivePlayback()) {
      const liveWindow = getLiveSeekableWindow();
      const secondsBehindLive = liveWindow
        ? Math.max(0, liveWindow.end - timeAtCursor)
        : 0;
      seekPreviewTime.textContent =
        ratio >= liveEdgePinRatio ||
        secondsBehindLive <= liveEdgeRejoinToleranceSeconds
          ? "LIVE"
          : `-${formatTime(secondsBehindLive)}`;
    } else {
      seekPreviewTime.textContent = formatTime(timeAtCursor);
    }

    const previewWidth = 160;
    const minLeft = previewWidth / 2;
    const maxLeft = rect.width - previewWidth / 2;
    const left = Math.max(minLeft, Math.min(x, maxLeft));
    setRuntimeStyleRule("#seekPreview", { left: `${left}px` });
    seekPreview.hidden = false;

    syncPreviewVideoSource();
    scheduleSeekPreviewFrame(normalizeSeekPreviewTarget(timeAtCursor, duration));
  }

  function handleSeekPointerUp(event) {
    if (!isDraggingSeek()) {
      return;
    }
    setDraggingSeek(false);
    const seekScaleDurationSeconds = getSeekScaleDurationSeconds();
    if (seekScaleDurationSeconds <= 0) {
      clearPendingSeekRatios();
      return;
    }

    if (
      getPendingTranscodeSeekRatio() === null &&
      getPendingStandardSeekRatio() === null
    ) {
      const pointerRatio = getSeekRatioFromPointerEvent(event);
      if (pointerRatio !== null) {
        setPendingSeekRatio(pointerRatio);
      }
    }

    const pendingTranscodeSeekRatio = getPendingTranscodeSeekRatio();
    const pendingStandardSeekRatio = getPendingStandardSeekRatio();
    if (pendingTranscodeSeekRatio !== null && isTranscodeSourceActive()) {
      seekToAbsoluteTime(
        getSeekTargetSecondsFromRatio(
          pendingTranscodeSeekRatio,
          seekScaleDurationSeconds,
        ),
        { showLoading: true },
      );
    } else if (
      pendingStandardSeekRatio !== null &&
      !isTranscodeSourceActive()
    ) {
      seekToAbsoluteTime(
        getSeekTargetSecondsFromRatio(
          pendingStandardSeekRatio,
          seekScaleDurationSeconds,
        ),
        { showLoading: true },
      );
    }

    clearPendingSeekRatios();
  }

  trackListener(seekBar, "pointermove", (event) => {
    updateSeekPreview(event);
    if (isDraggingSeek()) {
      const pointerRatio = getSeekRatioFromPointerEvent(event);
      if (pointerRatio !== null) {
        setPendingSeekRatio(pointerRatio);
      }
    }
  });
  trackListener(seekBar, "pointerenter", updateSeekPreview);
  trackListener(seekBar, "pointerleave", () => {
    seekPreview.hidden = true;
    window.clearTimeout(seekPreviewThrottleTimer);
    seekPreviewThrottleTimer = null;
    seekPreviewPendingTarget = null;
    seekPreviewLoadingTarget = null;
    seekPreviewHlsController?.stopLoad();
    // Reuse metadata and the decoded frame on a quick return, without fetching
    // HLS segments in the background or retaining an idle decoder indefinitely.
    window.clearTimeout(seekPreviewIdleTimer);
    seekPreviewIdleTimer = window.setTimeout(
      closeSeekPreviewVideo,
      SEEK_PREVIEW_IDLE_TIMEOUT_MS,
    );
  });

  trackListener(seekBar, "pointerdown", (event) => {
    setDraggingSeek(true);
    clearPendingSeekRatios();
    const pointerRatio = getSeekRatioFromPointerEvent(event);
    if (pointerRatio !== null) {
      setPendingSeekRatio(pointerRatio);
    }
  });

  trackListener(seekBar, "pointerup", handleSeekPointerUp);
  trackListener(seekBar, "pointercancel", handleSeekPointerUp);
  trackListener(document, "pointerup", handleSeekPointerUp);

  trackListener(seekBar, "input", () => {
    const seekScaleDurationSeconds = getSeekScaleDurationSeconds();
    if (
      !hasActiveSource() ||
      isResolvingSource() ||
      seekScaleDurationSeconds <= 0
    ) {
      return;
    }

    const ratio = Number(seekBar.value) / 1000;
    syncDurationText(ratio * seekScaleDurationSeconds);
    if (isTranscodeSourceActive()) {
      paintSeekProgress(
        seekBar.value,
        getBufferedSeekValue(seekScaleDurationSeconds),
      );
      if (isDraggingSeek()) {
        setPendingSeekRatio(ratio);
        return;
      }
      seekToAbsoluteTime(
        getSeekTargetSecondsFromRatio(ratio, seekScaleDurationSeconds),
        { showLoading: true },
      );
      return;
    }

    paintSeekProgress(
      seekBar.value,
      getBufferedSeekValue(seekScaleDurationSeconds),
    );
    if (isDraggingSeek()) {
      setPendingSeekRatio(ratio);
      return;
    }
    seekToAbsoluteTime(
      getSeekTargetSecondsFromRatio(ratio, seekScaleDurationSeconds),
      { showLoading: true },
    );
  });

  return {
    closeSeekPreviewVideo,
  };
}

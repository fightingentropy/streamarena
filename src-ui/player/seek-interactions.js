const SEEK_PREVIEW_WIDTH = 160;
const SEEK_PREVIEW_HEIGHT = 90;
const SEEK_PREVIEW_SEEK_THROTTLE_MS = 220;
const SEEK_PREVIEW_RENDERED_TARGET_EPSILON_SECONDS = 0.08;

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
  let seekPreviewSourceRequestId = 0;

  function clearSeekPreviewCanvas() {
    seekPreviewCtx.clearRect(0, 0, SEEK_PREVIEW_WIDTH, SEEK_PREVIEW_HEIGHT);
    seekPreviewCtx.fillStyle = "#000";
    seekPreviewCtx.fillRect(0, 0, SEEK_PREVIEW_WIDTH, SEEK_PREVIEW_HEIGHT);
  }

  function drawSeekPreviewFrame() {
    if (!seekPreviewVideo || seekPreviewVideo.readyState < 2) {
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
      return true;
    } catch {
      return false;
    }
  }

  function handleSeekPreviewFrameReady() {
    if (seekPreviewLoadingTarget === null) {
      return;
    }
    window.requestAnimationFrame(() => {
      drawSeekPreviewFrame();
    });
  }

  function handleSeekPreviewMetadataReady() {
    markSeekPreviewReady();
    const target = seekPreviewLoadingTarget ?? seekPreviewPendingTarget;
    if (target !== null) {
      scheduleSeekPreviewFrame(target, { force: true });
    }
  }

  function getOrCreatePreviewVideo() {
    if (seekPreviewVideo) return seekPreviewVideo;
    seekPreviewVideo = document.createElement("video");
    seekPreviewVideo.preload = "auto";
    seekPreviewVideo.muted = true;
    seekPreviewVideo.playsInline = true;
    seekPreviewVideo.crossOrigin = video.crossOrigin || "anonymous";
    seekPreviewVideo.setAttribute("aria-hidden", "true");
    seekPreviewVideo.tabIndex = -1;
    seekPreviewVideo.style.cssText =
      "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
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
    if (seekPreviewPendingTarget !== null) {
      scheduleSeekPreviewFrame(seekPreviewPendingTarget, { force: true });
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
            autoStartLoad: true,
            startPosition: -1,
            maxBufferLength: 8,
            maxMaxBufferLength: 12,
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

    pv.addEventListener("loadedmetadata", markSeekPreviewReady, { once: true });
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
      return;
    }
    seekPreviewPendingTarget = null;
    seekPreviewLoadingTarget = clampedTarget;
    clearSeekPreviewCanvas();
    try {
      if (
        Math.abs(Number(seekPreviewVideo.currentTime || 0) - clampedTarget) <
        0.25
      ) {
        drawSeekPreviewFrame();
        return;
      }
      seekPreviewVideo.currentTime = clampedTarget;
      if (seekPreviewHlsController?.startLoad) {
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
    seekPreviewLastSeekAt = now;
    requestSeekPreviewFrame(target);
  }

  function updateSeekPreview(event) {
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
    seekPreview.style.left = `${left}px`;
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
    closeSeekPreviewVideo();
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

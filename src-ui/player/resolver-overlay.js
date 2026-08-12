export const DEFAULT_SEEK_LOADING_TIMEOUT_MS = 9000;

export function normalizeResolverFailureMessage(
  errorOrMessage,
  fallbackMessage = "Unable to resolve this stream.",
  {
    isExplicitLocalUploadSource = false,
    src = "",
    preferredResolverProvider = "",
  } = {},
) {
  const rawMessage =
    typeof errorOrMessage === "string"
      ? errorOrMessage
      : errorOrMessage?.message;
  const message = String(rawMessage || fallbackMessage || "")
    .trim()
    .replace(/\s+/g, " ");
  const normalized = message.toLowerCase();

  if (
    normalized.includes("add a real-debrid api key") ||
    normalized.includes("enable local torrent cache")
  ) {
    return message;
  }

  if (
    normalized.includes("pipelinestatus::") ||
    normalized.includes("ffmpegdemuxer") ||
    normalized.includes("demuxer_error") ||
    normalized.includes("open context failed") ||
    normalized.includes("error opening input") ||
    normalized.includes("no such file or directory") ||
    normalized.includes("media_err_src_not_supported")
  ) {
    if (isExplicitLocalUploadSource || /^\/?assets\//i.test(src)) {
      return "This local video file could not be opened. It may be missing from the library or unsupported.";
    }
    return "This video could not be opened. Try another source.";
  }

  if (
    preferredResolverProvider !== "real-debrid" &&
    (normalized.includes("resolving stream timed out") ||
      normalized.includes("request timed out") ||
      normalized.includes("local torrent") ||
      normalized.includes("metadata") ||
      normalized.includes("first byte") ||
      normalized.includes("peer") ||
      normalized.includes("bad gateway") ||
      normalized.includes("502"))
  ) {
    if (preferredResolverProvider === "fastest") {
      return "This source could not start quickly enough. Try another source.";
    }
    return "Local torrent could not start this source quickly enough. Try another source.";
  }

  return message || fallbackMessage || "Unable to resolve this stream.";
}

export function createResolverOverlayController({
  getOverlay,
  getStatus,
  getTitle,
  getDetail,
  getCountdown,
  getRetryButton,
  getAlternateButton,
  getLoader,
  getSeekLoadingOverlay,
  hasExplicitSource,
  isLiveIframePlaybackActive,
  scheduleControlsHide,
  seekLoadingTimeoutMs = DEFAULT_SEEK_LOADING_TIMEOUT_MS,
  setTimeoutFn = (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeoutFn = (timeoutId) => globalThis.clearTimeout(timeoutId),
}) {
  let seekLoadingTimeout = null;

  function isResolvingSource() {
    const resolverOverlay = getOverlay();
    return Boolean(
      resolverOverlay &&
        !resolverOverlay.hidden &&
        !resolverOverlay.classList.contains("is-error"),
    );
  }

  function clearSeekLoadingTimeout() {
    if (seekLoadingTimeout !== null) {
      clearTimeoutFn(seekLoadingTimeout);
      seekLoadingTimeout = null;
    }
  }

  function hideSeekLoadingIndicator() {
    const seekLoadingOverlay = getSeekLoadingOverlay();
    if (!seekLoadingOverlay) {
      return;
    }
    clearSeekLoadingTimeout();
    seekLoadingOverlay.hidden = true;
  }

  function showSeekLoadingIndicator() {
    const seekLoadingOverlay = getSeekLoadingOverlay();
    if (!seekLoadingOverlay || isResolvingSource()) {
      return;
    }
    seekLoadingOverlay.hidden = false;
    clearSeekLoadingTimeout();
    seekLoadingTimeout = setTimeoutFn(() => {
      seekLoadingTimeout = null;
      hideSeekLoadingIndicator();
    }, seekLoadingTimeoutMs);
  }

  function hideResolver() {
    const resolverOverlay = getOverlay();
    if (!resolverOverlay) {
      return;
    }

    resolverOverlay.hidden = true;
    resolverOverlay.classList.remove("is-error");
    resolverOverlay.classList.remove("is-recovery");
    resolverOverlay.classList.remove("has-status");
    resolverOverlay.classList.remove("has-actions");
    const resolverLoader = getLoader();
    if (resolverLoader) {
      resolverLoader.hidden = false;
    }
    const resolverStatus = getStatus();
    if (resolverStatus) {
      resolverStatus.hidden = true;
    }
    const resolverTitle = getTitle();
    if (resolverTitle) {
      resolverTitle.hidden = true;
    }
    const resolverDetail = getDetail();
    if (resolverDetail) {
      resolverDetail.hidden = true;
    }
    const resolverCountdown = getCountdown();
    if (resolverCountdown) {
      resolverCountdown.hidden = true;
    }
    const resolverRetryButton = getRetryButton();
    if (resolverRetryButton) {
      resolverRetryButton.hidden = true;
    }
    const resolverAlternateButton = getAlternateButton();
    if (resolverAlternateButton) {
      resolverAlternateButton.hidden = true;
    }
    if (isLiveIframePlaybackActive()) {
      scheduleControlsHide();
    }
  }

  function showResolver(
    message,
    {
      isError = false,
      showStatus = isError,
      isRecovery = false,
      title = "",
      detail = "",
      countdown = "",
      showRetry = false,
      showAlternate = false,
    } = {},
  ) {
    if (hasExplicitSource() && !showStatus && !isError) {
      hideResolver();
      return;
    }

    const resolverOverlay = getOverlay();
    if (!resolverOverlay) {
      return;
    }

    const shouldShowStatus = showStatus || isError || isRecovery;
    const resolverStatus = getStatus();
    if (resolverStatus) {
      resolverStatus.textContent =
        String(message || "").trim() || "Unable to load this video.";
      resolverStatus.hidden = !shouldShowStatus;
    }
    const resolverTitle = getTitle();
    if (resolverTitle) {
      resolverTitle.textContent = String(title || "").trim();
      resolverTitle.hidden = !isRecovery || !resolverTitle.textContent;
    }
    const resolverDetail = getDetail();
    if (resolverDetail) {
      resolverDetail.textContent = String(detail || "").trim();
      resolverDetail.hidden = !isRecovery || !resolverDetail.textContent;
    }
    const resolverCountdown = getCountdown();
    if (resolverCountdown) {
      resolverCountdown.textContent = String(countdown || "").trim();
      resolverCountdown.hidden = !isRecovery || !resolverCountdown.textContent;
    }
    const shouldShowRetry = (isRecovery || isError) && showRetry;
    const shouldShowAlternate = (isRecovery || isError) && showAlternate;
    const resolverRetryButton = getRetryButton();
    if (resolverRetryButton) {
      resolverRetryButton.hidden = !shouldShowRetry;
    }
    const resolverAlternateButton = getAlternateButton();
    if (resolverAlternateButton) {
      resolverAlternateButton.hidden = !shouldShowAlternate;
    }
    const resolverLoader = getLoader();
    if (resolverLoader) {
      resolverLoader.hidden = shouldShowStatus;
    }
    hideSeekLoadingIndicator();
    resolverOverlay.hidden = false;
    resolverOverlay.classList.toggle("is-error", isError);
    resolverOverlay.classList.toggle("is-recovery", isRecovery);
    resolverOverlay.classList.toggle("has-status", shouldShowStatus);
    resolverOverlay.classList.toggle(
      "has-actions",
      shouldShowRetry || shouldShowAlternate,
    );
  }

  return {
    isResolvingSource,
    clearSeekLoadingTimeout,
    showSeekLoadingIndicator,
    hideSeekLoadingIndicator,
    showResolver,
    hideResolver,
  };
}

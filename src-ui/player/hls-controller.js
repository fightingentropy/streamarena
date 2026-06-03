export function createHlsPlaybackController({
  getVideo = () => null,
  getLastRequestedAbsolutePlaybackSource = () => "",
  hasNativeHlsPlaybackSupport = () => false,
  hasHlsJsPlaybackSupport = () => false,
  shouldAvoidRemuxFallbackForHls = () => false,
  buildSoftwareDecodeUrl = () => "",
  getEffectiveCurrentTime = () => 0,
  tryPlay = () => {},
  scheduleStreamStallRecovery = () => {},
  schedulePlaybackRecovery = () => {},
  isBrowserOffline = () => false,
  shouldFailFastForHlsNetworkErrors = () => false,
  getPreferredQualityLevel = () => -1,
  onQualityLevelsChanged = () => {},
} = {}) {
  let activeHlsController = null;
  let hlsConstructorPromise = null;
  let pendingHlsJsPlaybackSource = "";
  let qualityLevels = [];
  let selectedQualityLevel = -1;
  let activeQualityLevel = -1;

  function normalizeQualityLevel(level = {}, index = 0) {
    const attrs = level.attrs || {};
    const width = Number(level.width || attrs.RESOLUTION?.width || 0);
    const height = Number(level.height || attrs.RESOLUTION?.height || 0);
    const bitrate = Number(
      level.bitrate ||
        level.maxBitrate ||
        attrs.BANDWIDTH ||
        attrs["AVERAGE-BANDWIDTH"] ||
        0,
    );
    return {
      index,
      width: Number.isFinite(width) && width > 0 ? width : 0,
      height: Number.isFinite(height) && height > 0 ? height : 0,
      bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : 0,
      name: String(level.name || attrs.NAME || "").trim(),
    };
  }

  function normalizeRequestedQualityLevel(levelIndex, levels = qualityLevels) {
    const normalized = Number(levelIndex);
    if (!Number.isFinite(normalized) || normalized < 0) {
      return -1;
    }
    const requested = Math.floor(normalized);
    return levels.some((level) => level.index === requested) ? requested : -1;
  }

  function publishQualityLevels() {
    onQualityLevelsChanged({
      levels: qualityLevels,
      selectedLevel: selectedQualityLevel,
      activeLevel: activeQualityLevel,
    });
  }

  function resetQualityLevels() {
    qualityLevels = [];
    selectedQualityLevel = -1;
    activeQualityLevel = -1;
    publishQualityLevels();
  }

  function loadHlsConstructor() {
    if (!hlsConstructorPromise) {
      hlsConstructorPromise = import("hls.js").then(
        (module) => module.default || module.Hls || module,
      );
    }
    return hlsConstructorPromise;
  }

  function destroy() {
    pendingHlsJsPlaybackSource = "";
    if (!activeHlsController) {
      resetQualityLevels();
      return;
    }
    try {
      activeHlsController.destroy();
    } catch {
      // Ignore teardown failures while switching streams.
    }
    activeHlsController = null;
    resetQualityLevels();
  }

  function isActive() {
    return Boolean(activeHlsController);
  }

  function isPendingSource(source) {
    return pendingHlsJsPlaybackSource === source;
  }

  function setQualityLevel(levelIndex) {
    if (!activeHlsController || !qualityLevels.length) {
      return false;
    }
    const normalized = normalizeRequestedQualityLevel(levelIndex);
    selectedQualityLevel = normalized;
    activeHlsController.currentLevel = normalized;
    publishQualityLevels();
    return true;
  }

  function play({
    absoluteSource,
    hlsMeta = null,
    requestedStartSeconds = 0,
    preferredAudioSyncMs = 0,
    handleHlsPlaybackFailure = () => {},
  } = {}) {
    const video = getVideo();
    if (!video || !absoluteSource) {
      return false;
    }

    const hlsStartPosition =
      hlsMeta?.input && requestedStartSeconds > 0 ? requestedStartSeconds : -1;

    if (hasNativeHlsPlaybackSupport()) {
      resetQualityLevels();
      video.setAttribute("src", absoluteSource);
      video.load();

      const onNativeHlsError = () => {
        video.removeEventListener("error", onNativeHlsError);
        if (shouldAvoidRemuxFallbackForHls() || !hlsMeta?.input) {
          handleHlsPlaybackFailure("HLS playback failed.");
          return;
        }
        const resumeAt = Math.max(0, Math.floor(getEffectiveCurrentTime()));
        const remuxFallback = buildSoftwareDecodeUrl(
          hlsMeta.input,
          resumeAt,
          hlsMeta.audioStreamIndex,
          preferredAudioSyncMs,
          hlsMeta.subtitleStreamIndex,
        );
        video.setAttribute(
          "src",
          new URL(remuxFallback, window.location.origin).toString(),
        );
        video.load();
        void tryPlay();
      };
      video.addEventListener("error", onNativeHlsError, { once: true });

      void tryPlay();
      scheduleStreamStallRecovery();
      return true;
    }

    if (hasHlsJsPlaybackSupport()) {
      pendingHlsJsPlaybackSource = absoluteSource;
      void loadHlsConstructor()
        .then((HlsConstructor) => {
          if (getLastRequestedAbsolutePlaybackSource() !== absoluteSource) {
            return;
          }
          pendingHlsJsPlaybackSource = "";
          if (!HlsConstructor?.isSupported?.()) {
            handleHlsPlaybackFailure("This browser cannot play the HLS stream.");
            return;
          }

          const failFastNetworkErrors = shouldFailFastForHlsNetworkErrors();
          const createFastFailureLoadPolicy = (
            maxTimeToFirstByteMs,
            maxLoadTimeMs,
          ) => ({
            default: {
              maxTimeToFirstByteMs,
              maxLoadTimeMs,
              timeoutRetry: {
                maxNumRetry: 0,
                retryDelayMs: 0,
                maxRetryDelayMs: 0,
              },
              errorRetry: {
                maxNumRetry: 0,
                retryDelayMs: 0,
                maxRetryDelayMs: 0,
              },
            },
          });
          const fastFailurePlaylistLoadPolicy = createFastFailureLoadPolicy(
            20000,
            45000,
          );
          const fastFailureResourceLoadPolicy = createFastFailureLoadPolicy(
            30000,
            60000,
          );
          const hls = new HlsConstructor({
            backBufferLength: 90,
            maxBufferLength: 60,
            autoStartLoad: hlsStartPosition < 0,
            startPosition: hlsStartPosition,
            ...(failFastNetworkErrors
              ? {
                  manifestLoadPolicy: fastFailurePlaylistLoadPolicy,
                  playlistLoadPolicy: fastFailurePlaylistLoadPolicy,
                  fragLoadPolicy: fastFailureResourceLoadPolicy,
                  keyLoadPolicy: fastFailureResourceLoadPolicy,
                }
              : {}),
          });
          let hlsRecoveryAttempts = 0;
          activeHlsController = hls;
          qualityLevels = [];
          selectedQualityLevel = -1;
          activeQualityLevel = -1;

          hls.on(HlsConstructor.Events.ERROR, (_event, data = {}) => {
            if (activeHlsController !== hls || !data?.fatal) {
              return;
            }
            if (
              data.type === HlsConstructor.ErrorTypes.NETWORK_ERROR &&
              failFastNetworkErrors
            ) {
              handleHlsPlaybackFailure(
                data.details
                  ? `HLS playback failed (${data.details}).`
                  : "HLS playback failed.",
              );
              return;
            }
            if (
              data.type === HlsConstructor.ErrorTypes.NETWORK_ERROR &&
              hlsRecoveryAttempts < 1
            ) {
              hlsRecoveryAttempts += 1;
              hls.startLoad();
              return;
            }
            if (data.type === HlsConstructor.ErrorTypes.NETWORK_ERROR) {
              schedulePlaybackRecovery(
                isBrowserOffline() ? "offline" : "buffering",
                "Network interrupted. Retrying stream...",
              );
              return;
            }
            if (
              data.type === HlsConstructor.ErrorTypes.MEDIA_ERROR &&
              hlsRecoveryAttempts < 2
            ) {
              hlsRecoveryAttempts += 1;
              hls.recoverMediaError();
              return;
            }
            handleHlsPlaybackFailure(
              data.details
                ? `HLS playback failed (${data.details}).`
                : "HLS playback failed.",
            );
          });
          hls.on(HlsConstructor.Events.MEDIA_ATTACHED, () => {
            if (activeHlsController === hls) {
              hls.loadSource(absoluteSource);
            }
          });
          hls.on(HlsConstructor.Events.MANIFEST_PARSED, () => {
            if (activeHlsController === hls) {
              qualityLevels = Array.isArray(hls.levels)
                ? hls.levels.map(normalizeQualityLevel)
                : [];
              selectedQualityLevel = normalizeRequestedQualityLevel(
                getPreferredQualityLevel(qualityLevels),
                qualityLevels,
              );
              hls.currentLevel = selectedQualityLevel;
              publishQualityLevels();
              if (hlsStartPosition >= 0) {
                hls.startLoad(hlsStartPosition);
              }
              void tryPlay();
            }
          });
          hls.on(HlsConstructor.Events.LEVEL_SWITCHED, (_event, data = {}) => {
            if (activeHlsController !== hls) {
              return;
            }
            const nextActiveLevel = Number(data.level);
            activeQualityLevel =
              Number.isFinite(nextActiveLevel) && nextActiveLevel >= 0
                ? Math.floor(nextActiveLevel)
                : -1;
            publishQualityLevels();
          });
          hls.attachMedia(video);
        })
        .catch(() => {
          if (getLastRequestedAbsolutePlaybackSource() === absoluteSource) {
            pendingHlsJsPlaybackSource = "";
            handleHlsPlaybackFailure("Unable to load HLS playback support.");
          }
        });

      scheduleStreamStallRecovery();
      return true;
    }

    if (hlsMeta?.input) {
      resetQualityLevels();
      const resumeAt =
        hlsStartPosition >= 0
          ? hlsStartPosition
          : Math.max(0, Math.floor(getEffectiveCurrentTime()));
      const remuxFallback = buildSoftwareDecodeUrl(
        hlsMeta.input,
        resumeAt,
        hlsMeta.audioStreamIndex,
        preferredAudioSyncMs,
        hlsMeta.subtitleStreamIndex,
      );
      video.setAttribute(
        "src",
        new URL(remuxFallback, window.location.origin).toString(),
      );
      video.load();
      void tryPlay();
      scheduleStreamStallRecovery();
      return true;
    }

    handleHlsPlaybackFailure("This browser cannot play the HLS stream.");
    resetQualityLevels();
    return true;
  }

  return {
    destroy,
    isActive,
    isPendingSource,
    setQualityLevel,
    play,
  };
}

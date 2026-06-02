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
} = {}) {
  let activeHlsController = null;
  let hlsConstructorPromise = null;
  let pendingHlsJsPlaybackSource = "";

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
      return;
    }
    try {
      activeHlsController.destroy();
    } catch {
      // Ignore teardown failures while switching streams.
    }
    activeHlsController = null;
  }

  function isActive() {
    return Boolean(activeHlsController);
  }

  function isPendingSource(source) {
    return pendingHlsJsPlaybackSource === source;
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
              if (hlsStartPosition >= 0) {
                hls.startLoad(hlsStartPosition);
              }
              void tryPlay();
            }
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
    return true;
  }

  return {
    destroy,
    isActive,
    isPendingSource,
    play,
  };
}

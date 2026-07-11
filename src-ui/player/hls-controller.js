// Some external-embed CDNs (e.g. LordFlix's tiktokcdn segments) disguise each
// `.ts` as a PNG: a short real PNG header (magic `89 50 4E 47 0D 0A 1A 0A`) is
// prepended before the MPEG-TS payload, served as `content-type: image/png`, so
// naive filters see an image. hls.js times out trying to demux past the prefix.
// Strip it back to the first MPEG-TS sync byte (0x47 with 188-byte periodicity)
// before the demuxer sees the fragment. Pure passthrough for clean segments
// (the 4-byte magic check rejects non-PNG immediately), so it's safe to apply to
// every HLS fragment globally.
function stripPngPrefixedTsSegment(data) {
  if (!(data instanceof ArrayBuffer) || data.byteLength < 8) {
    return data;
  }
  const bytes = new Uint8Array(data);
  if (
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    return data; // not PNG-prefixed — leave untouched
  }
  const limit = Math.min(bytes.length - 376, 65536);
  for (let i = 0; i < limit; i += 1) {
    if (
      bytes[i] === 0x47 &&
      bytes[i + 188] === 0x47 &&
      bytes[i + 376] === 0x47
    ) {
      return i === 0 ? data : data.slice(i);
    }
  }
  return data; // PNG header but no TS sync found — pass through unchanged
}

// Wrap hls.js's default fragment loader so each downloaded segment is run through
// the PNG-prefix stripper before hls.js demuxes it. Only the fragment loader is
// overridden (playlists/keys are unaffected).
function createPngPrefixStrippingLoader(HlsConstructor) {
  const BaseLoader = HlsConstructor?.DefaultConfig?.loader;
  if (typeof BaseLoader !== "function") {
    return null;
  }
  return class PngPrefixStrippingFragmentLoader extends BaseLoader {
    load(context, config, callbacks) {
      const originalOnSuccess = callbacks.onSuccess;
      if (typeof originalOnSuccess === "function") {
        callbacks.onSuccess = (response, stats, ctx, networkDetails) => {
          if (response && response.data instanceof ArrayBuffer) {
            response.data = stripPngPrefixedTsSegment(response.data);
          }
          originalOnSuccess(response, stats, ctx, networkDetails);
        };
      }
      super.load(context, config, callbacks);
    }
  };
}

// hls.js's ABR starts every session from `abrEwmaDefaultEstimate`, so returning
// viewers spend the first seconds at low-res while it re-measures a throughput
// it already learned last time. Persist the measured estimate across sessions
// and seed the next session with it. Clamped to [300 kbps, 12 Mbps] so a single
// stalled session can't pin future startups to the floor, and an unrealistically
// high spike (cache hit, burst) can't make startup over-reach and rebuffer —
// within the clamp ABR still corrects within a few fragments either way. All
// localStorage access is try/catch'd: private-mode Safari throws on any touch.
const BANDWIDTH_ESTIMATE_STORAGE_KEY = "streamarena-hls-bandwidth-estimate";
const BANDWIDTH_ESTIMATE_MIN = 300_000;
const BANDWIDTH_ESTIMATE_MAX = 12_000_000;

function readPersistedBandwidthEstimate() {
  try {
    const stored = Number(
      localStorage.getItem(BANDWIDTH_ESTIMATE_STORAGE_KEY),
    );
    if (Number.isFinite(stored) && stored > 0) {
      return Math.min(
        Math.max(stored, BANDWIDTH_ESTIMATE_MIN),
        BANDWIDTH_ESTIMATE_MAX,
      );
    }
  } catch {
    // Unreadable storage — fall back to the conservative default.
  }
  return 0;
}

function persistBandwidthEstimate(estimate) {
  if (!Number.isFinite(estimate) || estimate <= 0) {
    return;
  }
  try {
    localStorage.setItem(
      BANDWIDTH_ESTIMATE_STORAGE_KEY,
      String(Math.round(estimate)),
    );
  } catch {
    // Best-effort — next session simply starts from the default again.
  }
}

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
  getLiveHlsReferer = () => "",
  onSourceLoadProgress = () => {},
  onSourcePlayable = () => {},
  onRemuxFallbackActivated = () => {},
} = {}) {
  let activeHlsController = null;
  let hlsConstructorPromise = null;
  let pendingHlsJsPlaybackSource = "";
  let qualityLevels = [];
  let selectedQualityLevel = -1;
  let activeQualityLevel = -1;
  // FRAG_BUFFERED fires per segment (every few seconds); writing localStorage
  // that often is pointless churn, so persistence is throttled to ~5s. Shared
  // across hls instances on purpose — a source switch shouldn't reset the
  // throttle window.
  let lastBandwidthEstimatePersistAt = 0;

  // Eagerly start downloading the hls.js chunk (~163 KB) the moment the player
  // mounts so it lands in parallel with the auth/init/resolve phase instead of
  // adding its own round trip after the source resolves (it was previously first
  // imported inside play(), i.e. only after resolve returned). Skipped on browsers
  // with native HLS (Safari), which never load hls.js. Errors are swallowed — play()
  // re-requests the constructor and surfaces any real failure then.
  if (hasHlsJsPlaybackSupport() && !hasNativeHlsPlaybackSupport()) {
    void loadHlsConstructor().catch(() => {});
  }

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
      // Final snapshot of the learned throughput before teardown so the next
      // session (or next source on this page) seeds ABR from it; the throttled
      // FRAG_BUFFERED writes can be up to ~5s stale. Own try-block so a getter
      // throw on a half-torn-down instance can never skip destroy() below.
      persistBandwidthEstimate(activeHlsController.bandwidthEstimate);
    } catch {
      // Skip the snapshot; ABR just re-learns from the last persisted value.
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
    autoplay = true,
    handleHlsPlaybackFailure = () => {},
  } = {}) {
    const video = getVideo();
    if (!video || !absoluteSource) {
      return false;
    }

    // Honor the resume offset for every VOD HLS source, not just local
    // transcoder masters: external-embed streams (VixSrc, LordFlix, ...) have
    // no `input` param, and seeking the <video> element from outside races
    // hls.js's async attachMedia (the MSE attach resets currentTime to 0).
    // Live playback never passes a start offset, so it always stays at -1.
    const hlsStartPosition = requestedStartSeconds > 0 ? requestedStartSeconds : -1;
    const loadRemuxFallback = (fallbackSource) => {
      const absoluteFallbackSource = new URL(
        fallbackSource,
        window.location.origin,
      ).toString();
      video.setAttribute("src", absoluteFallbackSource);
      video.addEventListener(
        "loadeddata",
        () => {
          if (getLastRequestedAbsolutePlaybackSource() !== absoluteSource) {
            return;
          }
          const currentSource = String(
            video.currentSrc || video.getAttribute?.("src") || "",
          ).trim();
          if (currentSource === absoluteFallbackSource) {
            onRemuxFallbackActivated(absoluteFallbackSource);
            onSourceLoadProgress();
            onSourcePlayable(absoluteFallbackSource);
          }
        },
        { once: true },
      );
      video.load();
      if (autoplay) {
        void tryPlay();
      }
    };

    if (hasNativeHlsPlaybackSupport()) {
      resetQualityLevels();
      video.setAttribute("src", absoluteSource);
      video.load();
      video.addEventListener(
        "loadeddata",
        () => {
          if (getLastRequestedAbsolutePlaybackSource() !== absoluteSource) {
            return;
          }
          const currentSource = String(
            video.currentSrc || video.getAttribute?.("src") || "",
          ).trim();
          if (currentSource === absoluteSource) {
            onSourcePlayable(absoluteSource);
          }
        },
        { once: true },
      );
      if (hlsStartPosition >= 0) {
        const applyNativeHlsStartPosition = () => {
          if (getLastRequestedAbsolutePlaybackSource() !== absoluteSource) {
            return;
          }
          try {
            video.currentTime = hlsStartPosition;
          } catch {
            // Keep the stream's default start if the seek is rejected.
          }
        };
        video.addEventListener("loadedmetadata", applyNativeHlsStartPosition, {
          once: true,
        });
      }

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
        loadRemuxFallback(remuxFallback);
      };
      video.addEventListener("error", onNativeHlsError, { once: true });

      if (autoplay) {
        void tryPlay();
      }
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
            { maxNumRetry = 0, retryDelayMs = 0, maxRetryDelayMs = 0 } = {},
          ) => ({
            default: {
              maxTimeToFirstByteMs,
              maxLoadTimeMs,
              timeoutRetry: {
                maxNumRetry,
                retryDelayMs,
                maxRetryDelayMs,
              },
              errorRetry: {
                maxNumRetry,
                retryDelayMs,
                maxRetryDelayMs,
              },
            },
          });
          // Playlists/manifests stay zero-retry so a genuinely dead source is
          // abandoned fast during startup failover (this is what makes a bad
          // candidate give up in ~20-45s instead of hls.js's long defaults).
          const fastFailurePlaylistLoadPolicy = createFastFailureLoadPolicy(
            20000,
            45000,
          );
          // Segments/keys keep the tight startup timeouts but get a small retry
          // budget: a single slow/failed fragment — common right after a far seek
          // on a bandwidth-limited embed CDN (e.g. LordFlix's proxied segments) —
          // must self-heal in place rather than killing the whole source and
          // bouncing the viewer to another provider from the start.
          const fastFailureResourceLoadPolicy = createFastFailureLoadPolicy(
            30000,
            60000,
            { maxNumRetry: 2, retryDelayMs: 500, maxRetryDelayMs: 2000 },
          );
          const pngStrippingLoader =
            createPngPrefixStrippingLoader(HlsConstructor);
          const persistedBandwidthEstimate = readPersistedBandwidthEstimate();
          const hls = new HlsConstructor({
            backBufferLength: 90,
            maxBufferLength: 60,
            // Strip PNG-disguised `.ts` prefixes (some embed CDNs) before demux.
            ...(pngStrippingLoader ? { fLoader: pngStrippingLoader } : {}),
            // Conservative ABR start: external-embed VOD and live are proxied
            // through the mini's bandwidth-limited home uplink, so a first-ever
            // session begins from a low estimate (fast, reliable startup even
            // under uplink contention) and lets ABR ramp up once it measures
            // real throughput. Returning viewers instead seed the clamped
            // estimate persisted from their last session, skipping the low-res
            // ramp-up. -1 keeps the start level auto-selected from the estimate
            // rather than pinned to a fixed index.
            startLevel: -1,
            abrEwmaDefaultEstimate: persistedBandwidthEstimate || 700000,
            // With testBandwidth on, hls.js ignores the seeded estimate and
            // spends the first fragment on a level-0 bitrate test anyway — so
            // the test is only kept for first-ever sessions, where there is no
            // persisted measurement to trust.
            testBandwidth: !persistedBandwidthEstimate,
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
          // Becomes true once this source has actually appended media (a buffered
          // fragment). Fast-fail / immediate provider-switch on a network error is
          // only appropriate while the source is still trying to start; once it has
          // proven it plays, a transient error (e.g. a far-seek segment hiccup) must
          // recover in place on the SAME source, never silently switch providers.
          let sourceHasStartedPlayback = false;
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
              failFastNetworkErrors &&
              !sourceHasStartedPlayback
            ) {
              // Startup-only fast failover: the source never produced playable media,
              // so abandon it quickly and let the player try the next candidate.
              handleHlsPlaybackFailure(
                data.details
                  ? `HLS playback failed (${data.details}).`
                  : "HLS playback failed.",
              );
              return;
            }
            if (
              data.type === HlsConstructor.ErrorTypes.NETWORK_ERROR &&
              hlsRecoveryAttempts < 2
            ) {
              // The source is already playing (or fast-fail is off): resume loading
              // the SAME source at the current position. This is the path a post-seek
              // segment error takes — it must not switch providers or restart at zero.
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
              // The playlist parsed: the source responded and is real. This lands well
              // before the first (possibly far-seek) segment, so it's the earliest
              // proof a freshly selected source is alive.
              onSourceLoadProgress();
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
              if (autoplay) {
                void tryPlay();
              }
            }
          });
          hls.on(HlsConstructor.Events.FRAG_BUFFERED, () => {
            if (activeHlsController === hls) {
              // A buffered fragment is real, playable progress: the source works.
              // From here on, transient errors recover in place instead of tripping
              // the startup fast-fail that would switch providers, and each clean
              // segment refreshes the in-place retry budget for the next hiccup.
              sourceHasStartedPlayback = true;
              hlsRecoveryAttempts = 0;
              onSourcePlayable(absoluteSource);
              // Each appended segment is forward progress — keeps a slow-but-working
              // source (e.g. a cold transcode buffering a far seek) from being treated
              // as a failed startup.
              onSourceLoadProgress();
              const now = Date.now();
              if (now - lastBandwidthEstimatePersistAt >= 5000) {
                lastBandwidthEstimatePersistAt = now;
                persistBandwidthEstimate(hls.bandwidthEstimate);
              }
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
      loadRemuxFallback(remuxFallback);
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

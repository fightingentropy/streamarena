import { onMount, onCleanup } from "solid-js";
import { createCustomSubtitleOverlay } from "../player/custom-subtitle-overlay.js";
import {
  getAudioTrackDisplayLabel,
  getAudioTrackDisplayParts,
  getLanguageDisplayLabel,
  getSubtitleTrackDisplayLabel,
  getSubtitleTrackDisplayParts,
  getUnknownAudioTrackDisplayLabel,
  isLikelyForcedSubtitleTrack, shouldPreferResolvedTranslatedSubtitleTrack,
} from "../player/media-track-labels.js";
import {
  SUBTITLE_OFFSET_STEP_MS,
  createSubtitleOffsetController,
} from "../player/subtitle-offset.js";
import {
  DEFAULT_EPISODE_THUMBNAIL,
  STATIC_SERIES_LIBRARY,
  mergeSeriesLibraries,
  fetchLocalSeriesLibrary,
  getSeriesEpisodeLabel,
} from "../player/episodes.js";
import {
  normalizeRequestTimeoutMs,
  requestJson,
  sleep,
} from "../player/api.js";
import {
  createResolveJobRequestCoordinator,
  createResolveRequester,
  isResolveAbortError,
  isTransientResolveError,
  runResolveWithSupersession,
} from "../player/resolve-job.js";
import {
  createDeferredMediaTrackController,
} from "../player/deferred-media-tracks.js";
import {
  normalizeSourceHash,
  getSourceDisplayName,
  getSourceDisplayHint,
  getSourceDisplayMeta,
  isSourceOptionEmbed,
  promoteSelectedSourceWithinCacheTier,
  sortSourcesBySeeders,
  isBrowserSafeAudioCodec,
} from "../player/sources.js";
import { buildSourceMenuView, createSourceOptionButton, shouldIgnoreRememberedTorrentSource, syncSourceMenuTabs } from "../player/source-menu-tabs.js";
import { createSourceDownloadController } from "../player/source-download.js";
import { createRealDebridSourceRefreshController } from "../player/real-debrid-cache-refresh.js";
import { buildTmdbSourceDiscoveryQuery } from "../player/source-discovery.js";
import {
  isTorrentResolverProvider,
  mergeRememberedServerContinueWatchingEntry,
  readRememberedContinueWatchingSourceState,
  removeContinueWatchingMeta,
  shouldIgnoreRememberedTmdbSourcePin as shouldIgnoreRememberedTmdbSourcePinForState,
  writeContinueWatchingEntry,
} from "../player/continue-watching-pin.js";
import {
  supportedAudioLangs,
  DEFAULT_STREAM_QUALITY_PREFERENCE,
  DEFAULT_AUDIO_LANGUAGE_PREF_KEY,
  SUBTITLE_COLOR_PREF_KEY,
} from "../lib/preferences.js";
import {
  getLocalSubtitlePreferenceSourceKey as buildLocalSubtitlePreferenceSourceKey,
  getStoredAudioLangForTmdbMovie,
  getStoredDefaultAudioLanguage,
  getStoredSubtitleLangForTarget,
  getStoredSubtitleStreamPreferenceForTarget,
  getTvSubtitlePreferenceKey as buildTvSubtitlePreferenceKey,
  isRecognizedAudioLang,
  normalizePreferredQuality,
  normalizeSubtitlePreference,
  persistAudioLangPreference as persistAudioLangPreferenceForMovie,
  persistSubtitleLangPreferenceForTarget,
  persistSubtitleStreamPreferenceForTarget,
  resolveSubtitlePreferenceStorageTarget,
  shouldIncludePreferredQualityInUrl,
} from "../player/playback-preferences.js";
import {
  createResolverOverlayController,
  normalizeResolverFailureMessage as formatResolverFailureMessage,
} from "../player/resolver-overlay.js";
import {
  LIVE_CHANNEL_PLAYBACK_FALLBACKS,
  findLiveChannelIdBySource,
} from "../lib/live-channels.js";
import {
  deriveLiveStreamStateFromParams,
  createBoundedRetryController,
  getLivePlaybackSource,
  hideStaleLiveResolverWhilePlaying as hideStaleLiveResolverWhilePlayingForState,
  getSelectedLiveStreamOption as getSelectedLiveStreamOptionFromState,
  normalizeBrowserBoundLiveHlsReferer,
  normalizePlaybackSourceValue,
  renderLiveStreamOptions as renderLiveStreamOptionsDom,
  shouldShowLiveStreamControls as shouldShowLiveStreamControlsForState,
  syncLiveStreamControls as syncLiveStreamControlsDom,
  SOURCE_OPTION_ICON_SVG,
} from "../player/live-streams.js";
import {
  createLiveStreamCache,
  normalizeLiveStreamPreferenceProvider,
} from "../player/live-stream-cache.js";
import { createLivePlaybackHealthWatch } from "../player/live-playback-health.js";
import {
  LIVE_EDGE_PIN_RATIO,
  LIVE_EDGE_REJOIN_TOLERANCE_SECONDS,
  clampLiveSeekTargetSeconds as clampLiveSeekTargetSecondsInWindow,
  getLiveEdgeTargetSeconds as getLiveEdgeTargetSecondsFromWindow,
  getLiveSeekableWindow as getLiveSeekableWindowFromVideo,
  getSeekTargetSecondsFromRatio as getSeekTargetSecondsFromRatioForWindow,
  shouldPinLiveEdgeFromTarget,
} from "../player/live-seek.js";
import {
  computeSubtitleLinePercentInBottomMatte as computeSubtitleLinePercentFromDimensions,
  nudgeSubtitleTrackPlacementUp as applySubtitleTrackPlacement,
} from "../player/subtitle-placement.js";
import { createHlsPlaybackController } from "../player/hls-controller.js";
import { createHlsQualityControls } from "../player/hls-quality-controls.js";
import {
  createPlaybackRouting,
  isHlsPlaybackSource,
} from "../player/playback-routing.js";
import { attachSeekInteractions } from "../player/seek-interactions.js";
import { createPlaybackBenchmarkApi } from "../player/playback-benchmark-api.js";
import { applySubtitleCueColor } from "../player/subtitle-style.js";
import {
  buildOrderedRemuxFallbacks,
  buildResolvedRemuxVariantSource,
  createRemuxRouting,
  getBrowserSupportedRemuxVideoCodecs,
  normalizeAudioSyncMs,
} from "../player/remux-routing.js";
import {
  RESUME_CLEAR_AT_END_THRESHOLD_SECONDS,
  createInitialResumeController,
  normalizeResumeStartSeconds,
  resolvePendingDirectSeekSeconds,
  withRemuxResumeStart,
} from "../player/resume-start.js";
import {
  createManualSourceSwitchController,
  getManualSourceSwitchTimeouts,
} from "../player/manual-source-switch.js";
import { createLocalCacheUpgradeWatch } from "../player/local-cache-upgrade-watch.js";
import { createLiveIframePlaybackClock } from "../player/live-iframe-playback-clock.js";
import { parseLiveIframePlaybackSource } from "../player/live-iframe-policy.js";
import {
  attachFullscreenControl,
  isFullscreenActive,
  toggleFullscreenMode as togglePlayerFullscreenMode,
} from "../player/fullscreen.js";
import { setRuntimeStyleRule } from "../lib/runtime-styles.js";
import { handleAuthFailureResponse } from "../lib/auth.js";
import {
  normalizeRealDebridSettings,
  pickTorrentResolverProvider,
  resolveTorrentRequestProvider,
} from "../lib/real-debrid-settings.js";
import { replaySafeMutationBody } from "../lib/replay-safe-state.js";
import { renderPlayerShell } from "../player/player-shell-template.jsx";
import {
  buildLiveWatchPath,
  buildTmdbWatchPath,
  buildWatchUrl,
  findSeriesEntryBySlug,
  loadWatchParams,
  normalizeInternalReturnToPath,
  saveWatchParams,
  slugifyTitle,
} from "../lib/watch-params.js";

function fetchUserApi(path, options) {
  return fetch(path, options).then((response) => {
    handleAuthFailureResponse(response);
    return response;
  });
}

export default function PlayerPage() {
  // ─── Ref declarations (replacing document.getElementById) ───
  let video, goBack, seekBar, seekPlayedProgress, seekBufferedProgress, seekPreview, seekPreviewCanvas, seekPreviewTime;
  let durationText, togglePlay, rewind10, forward10, volumeControl, volumeSlider;
  let toggleMutePlayer, toggleFullscreen, toggleSpeed, speedControl;
  let toggleHlsQuality, hlsQualityControl, hlsQualityMenu, hlsQualityOptionsContainer;
  let toggleLiveStream, liveStreamControl, liveStreamMenu, liveStreamOptionsContainer;
  let toggleSource, sourceControl, sourceMenu;
  let nextEpisode, toggleEpisodes, episodesControl, episodesList, episodesPopoverTitle;
  let episodesBackToSeasons, episodesOverline;
  let autoPlayOverlay, autoPlayThumb, autoPlayTitle, autoPlayEpLabel;
  let autoPlayCountdownText, autoPlayProgressRing, autoPlayBtn, autoPlayCancel;
  let toggleAudio, audioControl, audioMenu, audioOptionsContainer, subtitleOptionsContainer;
  let audioStatusBadge, subtitlePanel, audioTabSubtitles, audioTabSources;
  let subtitleSyncValue, subtitleSyncEarlier, subtitleSyncLater, subtitleSyncReset;
  let sourcePanel, sourceOptionsContainer, sourceOptionDetails, episodeLabel;
  let subtitleOverlay, resolverOverlay, resolverStatus, resolverLoader;
  let resolverTitle, resolverDetail, resolverCountdown;
  let resolverRetryButton, resolverAlternateButton;
  let seekLoadingOverlay, playerShell;
  let speedOptions = [];
  let closeSeekPreviewVideo = () => {};

const playbackRates = [0.5, 0.75, 1, 1.25, 1.5, 2];
const controlsHideDelayMs = 3000;
const popoverAutoOpenGraceMs = 650;
const singleClickToggleDelayMs = 220;
const SEEK_JUMP_SECONDS = 10;
const playbackRecoveryStallDelayMs = 8000;
const playbackRecoveryServerTimeoutMs = 3500;
const playbackRecoveryInitialDelayMs = 3000;
const playbackRecoveryMaxDelayMs = 10000;
const audioDecodeWatchIntervalMs = 2000;
const audioDecodeStallGraceMs = 8000;
const audioDecodeRecoveryCooldownMs = 30000;
const audioDecodeRecoveryMaxAttempts = 2;
const audioDecodeGraceAfterSourceChangeMs = 6000;
const audioDecodeGraceAfterSeekMs = 6000;
const audioDecodeVideoAdvanceThresholdSeconds = 6;
const LIVE_EMBED_FALLBACK_SOURCE_LIMIT = 5;
// When auto-failover has tried every source without success, keep retrying the
// whole set on this cadence (bounded by max cycles) instead of giving up — so
// the viewer never has to click "Retry" while a source is still coming online.
const LIVE_FALLBACK_RETRY_DELAY_MS = 6000;
const LIVE_FALLBACK_RETRY_MAX_CYCLES = 3;

let isDraggingSeek = false;
let speedPopoverCloseTimeout = null;
let hlsQualityPopoverCloseTimeout = null;
let liveStreamPopoverCloseTimeout = null;
let sourcePopoverCloseTimeout = null;
let sourceTogglePointerDownAt = 0;
let episodesPopoverCloseTimeout = null;
let episodesPopoverSticky = false;
let audioPopoverCloseTimeout = null;
const popoverAutoOpenedAt = new WeakMap();
let streamStallRecoveryTimeout = null;
let playbackRecoveryTimeout = null;
let playbackRecoveryCountdownInterval = null;
let playbackRecoveryMode = "";
let playbackRecoveryAttemptCount = 0;
let playbackRecoverySequence = 0;
let pendingRecoverySeekSeconds = null;
let controlsHideTimeout = null;
let singleClickPlaybackToggleTimeout = null;
let unavailableEpisodeResolverHideTimeout = null;
let audioDecodeRecoveryResetTimeout = null;
let subtitleRestoreAfterSourceChangeTimeout = null;
let tmdbSourceQueue = [];
let tmdbSourceAttemptIndex = 0;
let tmdbSkipExternalEmbed = false;
let tmdbResolveRetries = 0;
let tmdbPlaybackRequestToken = 0;
const resolveJobRequestCoordinator = createResolveJobRequestCoordinator();
const requestResolveJson = createResolveRequester({
  coordinator: resolveJobRequestCoordinator,
  getResolverProvider: () => preferredResolverProvider,
});
let userRealDebridSettingsLoaded = false;
let userRealDebridConfigured = false;
let userRealDebridEnabled = false;
let userLocalTorrentEnabled = false;
let userRealDebridSettingsPromise = null;
let knownDurationSeconds = 0;
let expectedDurationSeconds = 0;
const maxTmdbResolveRetries = 2;
let isRecoveringTmdbStream = false;
let activeTranscodeInput = "";
let activeAudioStreamIndex = -1;
let activeAudioSyncMs = 0;
let transcodeBaseOffsetSeconds = 0;
let pendingTranscodeSeekRatio = null;
let pendingStandardSeekRatio = null;
let activeTrackSourceInput = "";
let selectedAudioStreamIndex = -1;
let selectedSubtitleStreamIndex = -1;
let availableAudioTracks = [];
let availableSubtitleTracks = [];
let availablePlaybackSources = [];
let activeSourceTypeTab = "";
let isFetchingPlaybackSources = false;
let playbackSourcesRequestToken = 0;
let resolverFailedSourceHashes = new Set();
let subtitleTrackElement = null;
const subtitleOffset = createSubtitleOffsetController();
const {
  setText: setCustomSubtitleText,
  clear: clearCustomSubtitleOverlay,
  invalidateRenderedCue,
  render: renderCustomSubtitleOverlay,
  startRafLoop: startSubtitleRafLoop,
  stopRafLoop: stopSubtitleRafLoop,
  loadFromTrack: loadCustomSubtitleFromTrack,
} = createCustomSubtitleOverlay({
  getOverlay: () => subtitleOverlay,
  getSelectedSubtitleStreamIndex: () => selectedSubtitleStreamIndex,
  getCurrentTimeSeconds: () => getEffectiveCurrentTime(),
  getOffsetSeconds: () => subtitleOffset.getOffsetSeconds(),
  isVideoPlaying: () => Boolean(video && !video.paused && !video.ended),
});
let resolvedTrackPreferenceAudio = "auto";
let preferredSubtitleLang = "";
let audioOptions = [];
let subtitleOptions = [];
let activeAudioTab = "subtitles";
let seriesEpisodeThumbHydrationTask = null;
let hasHydratedSeriesEpisodeThumbs = false;
let episodesMenuMode = "episodes";
let selectedEpisodesSeasonNumber = 1;
let hasQueuedGallerySave = false;
let autoPlayCountdownInterval = null;
let autoPlayCountdownSeconds = 0;
let autoPlayOverlayVisible = false;
let autoPlayCancelled = false;
const AUTO_PLAY_COUNTDOWN_DURATION = 5;
const AUTO_PLAY_SHOW_BEFORE_END_SECONDS = 10;
const MAX_TMDB_EPISODE_LIST_SEASONS = 12;
const MAX_TMDB_EPISODE_LIST_EPISODES = 300;
let lastAudibleVolume = 1;
const reportedPlaybackFailureKeys = new Set();
let liveStreamOptions = [];
let selectedLiveStreamId = "";
let isLivePlayback = false;
let liveEdgePinned = true;
let shouldResolveLiveEmbedSource = false;
let liveEmbedResolver = "sports";
let lastRequestedPlaybackSource = "";
let lastRequestedAbsolutePlaybackSource = "";
let activeLiveHlsReferer = "";
let audioDecodeWatchInterval = null;
let audioDecodeWatchState = null;
let audioDecodeRecoveryInFlight = false;
let audioDecodeRecoverySourceKey = "";
let audioDecodeRecoveryAttempts = 0;
let lastAudioDecodeRecoveryAt = 0;
let lastPlaybackSourceSetAt = 0;
let lastPlaybackSeekAt = 0;
const liveIframePlaybackClock = createLiveIframePlaybackClock({
  now: () => performance.now(),
  isActive: () => isLiveIframePlaybackActive(),
  isVisible: () => document.visibilityState !== "hidden",
});
const {
  clearVisual: clearLiveVisualHealthWatch,
  clearStartup: clearLiveStartupHealthWatch,
  startVisual: startLiveVisualHealthWatch,
  armStartup: armLiveStartupHealthWatch,
  hasPlaybackStarted: hasLivePlaybackStarted,
  isStartupArmed,
} = createLivePlaybackHealthWatch({
  isLivePlayback: () => isLivePlayback,
  isIframePlayback: () => isLiveIframePlaybackActive(),
  getStreamOptionCount: () => liveStreamOptions.length,
  isAutoFallbackInFlight: () => liveAutoFallbackInFlight,
  hasRecoverablePlaybackSource,
  hasActiveSource,
  isVideoPaused: () => Boolean(video?.paused),
  isDocumentHidden: () => document.visibilityState === "hidden",
  getVideo: () => video,
  getCurrentTimeSeconds: () => getEffectiveCurrentTime(),
  getCurrentSource: () =>
    lastRequestedAbsolutePlaybackSource ||
    lastRequestedPlaybackSource ||
    video?.currentSrc ||
    video?.getAttribute?.("src") ||
    "",
  getSelectedStreamId: () => selectedLiveStreamId,
  getLastSourceSetAt: () => lastPlaybackSourceSetAt,
  onVisualFailover: () => {
    void attemptAutomaticLiveStreamFallback();
  },
  onStartupFailover: () => {
    void attemptAutomaticLiveStreamFallback(
      "Live stream did not start. Trying another source...",
    );
  },
});
let liveAutoFallbackInFlight = false;
let liveAutoFallbackAttemptedStreamIds = new Set();
const liveFallbackRetry = createBoundedRetryController({
  maxCycles: LIVE_FALLBACK_RETRY_MAX_CYCLES,
  delayMs: LIVE_FALLBACK_RETRY_DELAY_MS,
});
const liveStreamCache = createLiveStreamCache({
  getEventSlug: () => getLiveStreamCacheEventSlug(),
  getStreamOptions: () => liveStreamOptions,
  isLivePlayback: () => isLivePlayback,
});

const _cleanups = [];
function trackListener(target, event, handler, options) {
  if (!target) return;
  target.addEventListener(event, handler, options);
  _cleanups.push(() => target.removeEventListener(event, handler, options));
}

const remuxRouting = createRemuxRouting({
  getOrigin: () => window.location.origin,
  getSelectedSourceHash: () => selectedSourceHash,
  getAvailableAudioTracks: () => availableAudioTracks,
  getSelectedAudioStreamIndex: () => selectedAudioStreamIndex,
  getSelectedSubtitleStreamIndex: () => selectedSubtitleStreamIndex,
  getPreferredAudioSyncMs: () => preferredAudioSyncMs,
  getPreferredRemuxVideoMode: () => preferredRemuxVideoMode,
  getBrowserVideoCodecs: () => getBrowserSupportedRemuxVideoCodecs(video),
  isBrowserSafeAudioCodec,
  shouldMapSubtitleStreamIndex,
});
const {
  getDefaultEmbeddedAudioTrack,
  getSelectedEmbeddedAudioTrack,
  shouldForceRemuxForEmbeddedAudio,
  withPreferredAudioSyncForRemuxSource,
  buildSoftwareDecodeUrl,
  parseTranscodeSource,
} = remuxRouting;

const playbackRouting = createPlaybackRouting({
  getVideo: () => video,
  getOrigin: () => window.location.origin,
  getBrowserVideoCodecs: () => getBrowserSupportedRemuxVideoCodecs(video),
  getSelectedAudioStreamIndex: () => selectedAudioStreamIndex,
  getSelectedSubtitleStreamIndex: () => selectedSubtitleStreamIndex,
  getPreferredSourceLanguage: () => preferredSourceLanguage,
  getPreferredContainer: () => preferredContainer,
  getPreferredSourceFormats: () => preferredSourceFormats,
  getPreferredResolverProvider: () => preferredResolverProvider,
  getSupportedSourceFormatSet: () => supportedSourceFormatSet,
  shouldPreferMobileLightTmdbSources: () => shouldPreferMobileLightTmdbSources(),
  shouldPreferDirectMp4Default: () => !userLocalTorrentEnabled,
  shouldMapSubtitleStreamIndex,
  parseTranscodeSource,
  getSubtitleTrackByStreamIndex,
  shouldUseNativeEmbeddedSubtitleTrack,
});
const {
  parseHlsMasterSource,
  buildHlsPlaybackUrl,
  extractPlaybackSourceInput,
  hasNativeHlsPlaybackSupport,
  hasHlsJsPlaybackSupport,
  hasHlsPlaybackSupport,
  shouldUseHlsJsForSource,
  shouldAvoidRemuxFallbackForHls,
  isMobileOrTabletVideoEnvironment,
  buildPreferredBrowserPlaybackSource,
  shouldUseSoftwareDecode,
  scoreMobileLightSourceOption,
  getSourceListPreferredContainer,
  pickResolverAlternateSourceHash: pickResolverAlternateSourceHashFromRouting,
} = playbackRouting;

const deferredMediaTracks = createDeferredMediaTrackController({
  getState: () => ({
    video,
    sourceInput: activeTrackSourceInput, audioLang: preferredAudioLang,
    subtitleLang: normalizeSubtitlePreference(preferredSubtitleLang),
    currentPlaybackSource: String(lastRequestedPlaybackSource ||
      lastRequestedAbsolutePlaybackSource || video?.currentSrc ||
      video?.getAttribute?.("src") || "").trim(),
    title, year,
    filename: currentTmdbResolvedFilename, isTv: isTmdbTvPlayback,
    seasonNumber, episodeNumber,
    selectedAudioStreamIndex, selectedSubtitleStreamIndex,
    activeAudioSyncMs, preferredAudioSyncMs,
  }),
  setActiveSourceInput: (value) => { activeTrackSourceInput = value; },
  applyTrackState: (next, options = {}) => {
    availableAudioTracks = next.audioTracks;
    availableSubtitleTracks = next.subtitleTracks;
    selectedAudioStreamIndex = next.selectedAudioStreamIndex;
    selectedSubtitleStreamIndex = next.selectedSubtitleStreamIndex;
    if (Number.isFinite(next.durationSeconds)) {
      expectedDurationSeconds = next.durationSeconds;
    } else if (options.resetDuration) {
      expectedDurationSeconds = 0;
    }
    if (options.updateAudioPreference && next.audioPreference) {
      resolvedTrackPreferenceAudio = next.audioPreference;
    }
  },
  isSupportedAudioLanguage: (value) => supportedAudioLangs.has(value),
  parseTranscodeSource, parseHlsMasterSource,
  getDefaultEmbeddedAudioTrack, getSubtitleTrackByStreamIndex,
  shouldUseNativeEmbeddedSubtitleTrack, hasLoadedNativeSubtitleTrack,
  applyStoredSubtitleSelectionPreference,
  shouldForceRemuxForEmbeddedAudio, shouldUseSoftwareDecode,
  rebuildTrackOptionButtons, syncAudioState, syncDurationText,
  getEffectiveCurrentTime, buildHlsPlaybackUrl, buildSoftwareDecodeUrl,
  setVideoSource, applySubtitleTrackByStreamIndex,
  tryPlay,
});
const {
  schedule: scheduleDeferredMediaTrackEnrichment,
  resolveExplicit: resolveExplicitSourceTrackSelection,
} = deferredMediaTracks;

const sourceDownload = createSourceDownloadController({
  normalizeSourceHash, extractPlaybackSourceInput, parseLiveIframePlaybackSource,
  getSourceOptionByHash, isSourceOptionEmbed, getManualSourceSwitchTimeouts,
  resolveTmdbSourcesAndPlay, normalizeResolverFailureMessage,
  syncSourceSelectionState, renderSelectedSourceDetails,
  getSelectedSourceHash: () => selectedSourceHash,
  getPendingSourceSwitchHash: () => pendingSourceSwitchHash,
  getActiveTrackSourceInput: () => activeTrackSourceInput,
  getLastRequestedPlaybackSource: () => lastRequestedPlaybackSource,
  isTmdbResolvedPlayback: () => isTmdbResolvedPlayback,
  getUserLocalTorrentEnabled: () => userLocalTorrentEnabled,
  getUserRealDebridConfigured: () => isUserRealDebridPlaybackEnabled(),
  getPreferredResolverProvider: () => preferredResolverProvider,
  setPreferredResolverProvider: (value) => { preferredResolverProvider = value; },
  getActiveAudioStreamIndex: () => activeAudioStreamIndex,
  getSelectedAudioStreamIndex: () => selectedAudioStreamIndex,
  getCurrentTmdbResolvedFilename: () => currentTmdbResolvedFilename,
});

const realDebridSourceRefresh = createRealDebridSourceRefreshController({
  isRealDebridActive: () => isUserRealDebridPlaybackEnabled(),
  onRefresh: (expectedRequestKey) => void fetchTmdbSourceOptionsViaBackend({
    realDebridCacheRefresh: true, expectedRequestKey,
  }),
});

const hlsQualityControls = createHlsQualityControls({
  getElements: () => ({
    control: hlsQualityControl,
    toggle: toggleHlsQuality,
    menu: hlsQualityMenu,
    optionsContainer: hlsQualityOptionsContainer,
  }),
  isLiveIframePlaybackActive: () => isLiveIframePlaybackActive(),
  closePopover: (...args) => closeHlsQualityPopover(...args),
  setQualityLevel: (levelIndex) => hlsPlaybackController.setQualityLevel(levelIndex),
});

const hlsPlaybackController = createHlsPlaybackController({
  getVideo: () => video,
  getLastRequestedAbsolutePlaybackSource: () => lastRequestedAbsolutePlaybackSource,
  hasNativeHlsPlaybackSupport,
  hasHlsJsPlaybackSupport,
  shouldAvoidRemuxFallbackForHls,
  buildSoftwareDecodeUrl,
  getEffectiveCurrentTime: () => getEffectiveCurrentTime(),
  tryPlay: () => tryPlay(),
  scheduleStreamStallRecovery: () => scheduleStreamStallRecovery(),
  schedulePlaybackRecovery: (...args) => schedulePlaybackRecovery(...args),
  isBrowserOffline: () => isBrowserOffline(),
  shouldFailFastForHlsNetworkErrors: () =>
    isCurrentTmdbExternalEmbedSource() || isManualSourceSwitchPending(),
  getPreferredQualityLevel: (levels) =>
    hlsQualityControls.pickPreferredQualityLevel(levels),
  onQualityLevelsChanged: (state) => hlsQualityControls.handleLevelsChanged(state),
  getLiveHlsReferer: () => activeLiveHlsReferer,
  onSourceLoadProgress: () => noteManualSourceSwitchProgress(),
  onSourcePlayable: (absoluteSource) =>
    completeManualSourceSwitchIfActive(absoluteSource),
  onRemuxFallbackActivated: (absoluteSource) => adoptHlsRemuxFallbackSource(absoluteSource),
});

// ─── Watch URL support: reproducible /watch?... plus legacy /watch/<slug> ───
function slugify(text) {
  return slugifyTitle(text);
}
function parseWatchPath() {
  const path = window.location.pathname;
  // Short live form: /watch/live/<channelId>. The id rebuilds the full stream
  // set from the live-channel catalog.
  const liveMatch = path.match(/^\/watch\/live\/([^/]+)\/?$/i);
  if (liveMatch) {
    const channelId = decodeURIComponent(liveMatch[1]);
    return { kind: "live", channelId, slug: channelId };
  }
  // Short tmdb form: /watch/movie/<id>[/<slug>] and
  // /watch/tv/<id>[/<slug>][/s<season>e<episode>]. The id is the unique key;
  // the slug is cosmetic. Checked before the legacy shape so "movie"/"tv" are
  // not mistaken for a title slug.
  const tmdbMatch = path.match(/^\/watch\/(movie|tv)\/(\d+)((?:\/[^/]+)*)\/?$/i);
  if (tmdbMatch) {
    const rest = tmdbMatch[3].split("/").filter(Boolean);
    let slug = "";
    let seasonNumber = null;
    let episodeNumber = null;
    for (const segment of rest) {
      const seasonEpisode = /^s(\d+)e(\d+)$/i.exec(segment);
      if (seasonEpisode) {
        seasonNumber = Number(seasonEpisode[1]);
        episodeNumber = Number(seasonEpisode[2]);
      } else if (!slug) {
        slug = segment;
      }
    }
    return {
      kind: "tmdb",
      mediaType: tmdbMatch[1].toLowerCase(),
      tmdbId: tmdbMatch[2],
      slug,
      seasonNumber,
      episodeNumber,
    };
  }
  // Legacy form: /watch or /watch/<slug>[/<episodeIndex>].
  const match = path.match(/^\/watch(?:\/([^/]+))?(?:\/(\d+))?$/);
  if (!match) return null;
  return { kind: "legacy", slug: match[1] || "", episodeIndex: match[2] };
}
const _watchPath = parseWatchPath();
const _isCleanUrl = Boolean(_watchPath);

function stripEpisodeScopedSourceParams(searchParams) {
  searchParams.delete("sourceHash");
  searchParams.delete("sessionKey");
  searchParams.delete("skipExternalEmbed");
}

// Hydrate params from session/local storage (set before navigation) or slug resolve.
let _sessionParams = null;
if (_isCleanUrl && _watchPath.slug) {
  const _stored = loadWatchParams(_watchPath.slug);
  if (_stored) {
    const _storedParams = new URLSearchParams(_stored);
    // For a tmdb-id clean URL the id in the path is authoritative; only trust
    // stored params if they belong to the same title (two different titles can
    // slugify to the same key within one session).
    const _storedTmdbMatches =
      _watchPath.kind !== "tmdb" ||
      String(_storedParams.get("tmdbId") || "").trim() ===
        String(_watchPath.tmdbId || "").trim();
    if (_storedTmdbMatches) {
      _sessionParams = _storedParams;
    }
  }
}
const params = _sessionParams || new URLSearchParams(window.location.search);
// Seed identity from a short tmdb-id URL so a cold deep link (no stored params,
// no query string) resolves. Display metadata is hydrated from TMDB later in
// initPlaybackSource.
if (_watchPath?.kind === "tmdb") {
  if (!params.has("tmdbId")) params.set("tmdbId", _watchPath.tmdbId);
  if (!params.has("mediaType")) params.set("mediaType", _watchPath.mediaType);
  if (_watchPath.mediaType === "tv") {
    if (_watchPath.seasonNumber != null && !params.has("seasonNumber")) {
      params.set("seasonNumber", String(_watchPath.seasonNumber));
    }
    if (_watchPath.episodeNumber != null && !params.has("episodeNumber")) {
      params.set("episodeNumber", String(_watchPath.episodeNumber));
    }
  }
}
if (_isCleanUrl && _watchPath?.episodeIndex !== undefined) {
  const pathEpisodeIndex = Number(_watchPath.episodeIndex);
  if (Number.isFinite(pathEpisodeIndex) && pathEpisodeIndex >= 0) {
    const hasStoredEpisodeIndex = params.has("episodeIndex");
    const storedEpisodeIndex = Number(params.get("episodeIndex") || 0);
    if (
      (hasStoredEpisodeIndex &&
        Number.isFinite(storedEpisodeIndex) &&
        Math.floor(storedEpisodeIndex) !== Math.floor(pathEpisodeIndex)) ||
      (!hasStoredEpisodeIndex &&
        Math.floor(pathEpisodeIndex) !== 0 &&
        (params.has("sourceHash") || params.has("sessionKey")))
    ) {
      stripEpisodeScopedSourceParams(params);
    }
    params.set("episodeIndex", String(Math.floor(pathEpisodeIndex)));
  }
}
const _needsSlugResolve =
  _watchPath?.kind === "legacy" && _watchPath.slug && !_sessionParams;
// A short tmdb URL needs its display metadata fetched from TMDB whenever the
// title is missing or just a placeholder. Treating placeholders as "missing"
// lets a stored "Untitled" (e.g. from a transient cold-load state) self-heal.
function tmdbTitleIsMissing(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || normalized === "untitled" || normalized === "title";
}
const _needsTmdbResolve =
  _watchPath?.kind === "tmdb" && tmdbTitleIsMissing(params.get("title"));
// A short live URL rebuilds its stream set from the channel catalog when cold.
const _needsLiveResolve =
  _watchPath?.kind === "live" && !params.has("src");

const benchmarkModeEnabled = new Set(["1", "true", "yes", "on"]).has(
  String(params.get("benchmark") || "")
    .trim()
    .toLowerCase(),
);
// DEFAULT_EPISODE_THUMBNAIL, STATIC_SERIES_LIBRARY — imported from ./src-ui/player/episodes.js

// normalizeSeriesContentKind, cloneSeriesEpisode, mergeSeriesLibraries,
// normalizeLocalSeriesLibrary, fetchLocalSeriesLibrary — imported from ./src-ui/player/episodes.js

let SERIES_LIBRARY = Object.freeze({ ...STATIC_SERIES_LIBRARY });
// Async local library merge is deferred to onMount
let _seriesLibraryReady = fetchLocalSeriesLibrary().then((local) => {
  SERIES_LIBRARY = Object.freeze({ ...mergeSeriesLibraries(STATIC_SERIES_LIBRARY, local) });
});
let rawSourceParam = String(params.get("src") || "").trim();
let normalizedRawSourceParam = normalizePlaybackSourceValue(rawSourceParam);

function isTruthyParamValue(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function normalizeLiveEmbedResolver(value) {
  const resolver = String(value || "sports")
    .trim()
    .toLowerCase();
  if (resolver === "football" || resolver === "basketball" || resolver === "sports" || resolver === "twitch") {
    return resolver;
  }
  return "sports";
}

function normalizeLiveEpisodeLabel(value) {
  const label = String(value || "").trim();
  if (!isLivePlayback) {
    return label;
  }
  const normalized = label.toLowerCase();
  return normalized === "streamed" ||
    normalized === "matchstream" ||
    normalized === "ntvs" ||
    normalized === "auto"
    ? ""
    : label;
}

function refreshLiveStreamStateFromParams(queryParams = params) {
  const nextState = deriveLiveStreamStateFromParams(
    queryParams,
    normalizedRawSourceParam,
  );
  liveStreamOptions = nextState.options;
  selectedLiveStreamId = nextState.selectedStreamId;
  isLivePlayback = nextState.isLivePlayback;
  shouldResolveLiveEmbedSource =
    isLivePlayback && isTruthyParamValue(queryParams.get("liveEmbed"));
  liveEmbedResolver = normalizeLiveEmbedResolver(queryParams.get("liveResolver"));
  if (nextState.selectedSource) {
    rawSourceParam = nextState.selectedSource;
    normalizedRawSourceParam = nextState.selectedSource;
  }
}

refreshLiveStreamStateFromParams(params);

function normalizeSeriesSourceLookupValue(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  const prefixed = normalized.startsWith("assets/")
    ? `/${normalized}`
    : normalized;
  return prefixed.replace(/^\/+/, "").toLowerCase();
}

function inferSeriesPlaybackFromSource(sourceValue) {
  const normalizedSource = normalizeSeriesSourceLookupValue(sourceValue);
  if (!normalizedSource) {
    return null;
  }
  const entries = Object.entries(SERIES_LIBRARY || {});
  for (const [seriesId, seriesEntry] of entries) {
    const episodes = Array.isArray(seriesEntry?.episodes)
      ? seriesEntry.episodes
      : [];
    for (let index = 0; index < episodes.length; index += 1) {
      const candidateSource = normalizeSeriesSourceLookupValue(episodes[index]?.src);
      if (!candidateSource) {
        continue;
      }
      if (candidateSource === normalizedSource) {
        return {
          seriesId: String(seriesId || "")
            .trim()
            .toLowerCase(),
          series: seriesEntry,
          episodeIndex: index,
        };
      }
    }
  }
  return null;
}

let mediaTypeParam = String(params.get("mediaType") || "")
  .trim()
  .toLowerCase();
let isExplicitTvPlayback = mediaTypeParam === "tv";
let requestedSeriesId = String(params.get("seriesId") || "")
  .trim()
  .toLowerCase();
let hasRequestedEpisodeIndexParam = params.has("episodeIndex");
let requestedEpisodeIndex = Number(params.get("episodeIndex") || 0);
function resolveSeriesMatch() {
  const explicit =
    isExplicitTvPlayback &&
    Object.prototype.hasOwnProperty.call(SERIES_LIBRARY, requestedSeriesId)
      ? {
          seriesId: requestedSeriesId,
          series: SERIES_LIBRARY[requestedSeriesId],
          episodeIndex: 0,
        }
      : null;
  const inferred = inferSeriesPlaybackFromSource(normalizedRawSourceParam);
  const match = explicit || inferred;
  const series = match?.series || null;
  const episodes = Array.isArray(series?.episodes) ? series.episodes : [];
  const selectedIdx = hasRequestedEpisodeIndexParam
    ? requestedEpisodeIndex
    : Number(match?.episodeIndex || 0);
  const epIndex = episodes.length
    ? Math.max(
        0,
        Math.min(
          episodes.length - 1,
          Number.isFinite(selectedIdx) ? Math.floor(selectedIdx) : 0,
        ),
      )
    : -1;
  const ep = epIndex >= 0 ? episodes[epIndex] : null;
  const isSeries = Boolean(ep && (isExplicitTvPlayback || inferred));
  const rawSrc = String(ep?.src || "").trim();
  const normSrc = rawSrc.startsWith("assets/") ? `/${rawSrc}` : rawSrc;
  return { explicit, inferred, match, series, episodes, selectedIdx, epIndex, ep, isSeries, normSrc };
}
let _resolved = resolveSeriesMatch();
let explicitSeriesPlayback = _resolved.explicit;
let inferredSeriesPlayback = _resolved.inferred;
let activeSeriesMatch = _resolved.match;
let activeSeries = _resolved.series;
let seriesEpisodes = _resolved.episodes;
let seriesEpisodeIndex = _resolved.epIndex;
let activeSeriesEpisode = _resolved.ep;
let isSeriesPlayback = _resolved.isSeries;
let hasSeriesEpisodeControls =
  isSeriesPlayback && Boolean(activeSeries && seriesEpisodes.length > 1);
let normalizedSeriesSourceParam = _resolved.normSrc;
let thumbParam = String(params.get("thumb") || "").trim();
let src = isSeriesPlayback
  ? normalizedSeriesSourceParam || normalizedRawSourceParam
  : normalizedRawSourceParam;

function setExplicitPlaybackSourceState(nextSource) {
  const normalizedSource = normalizePlaybackSourceValue(nextSource);
  rawSourceParam = normalizedSource;
  normalizedRawSourceParam = normalizedSource;
  src = normalizedSource;
  hasExplicitSource = Boolean(src);
  isExplicitLocalUploadSource = computeIsExplicitLocalUploadSource();
}

const fallbackSeasonNumber = Number(
  params.get("seasonNumber") || params.get("season") || 1,
);
const fallbackEpisodeNumber = Number(
  params.get("episodeNumber") || params.get("episodeOrdinal") || 1,
);
let rawTitle = isSeriesPlayback
  ? String(activeSeries.title || "")
  : params.get("title") || "Untitled";
let rawEpisode = isSeriesPlayback
  ? getSeriesEpisodeLabel(
      seriesEpisodeIndex,
      activeSeriesEpisode?.title || "",
      activeSeries,
      Number(activeSeriesEpisode?.episodeNumber || seriesEpisodeIndex + 1),
    )
  : normalizeLiveEpisodeLabel(params.get("episode") || "");
let title = rawTitle;
let episode = rawEpisode;
let tmdbId = String(
  activeSeries?.tmdbId || params.get("tmdbId") || "",
).trim();
let mediaType = isSeriesPlayback ? "tv" : mediaTypeParam;
let year = String(activeSeries?.year || params.get("year") || "").trim();
let seasonNumber = isSeriesPlayback
  ? Math.max(1, Math.floor(Number(activeSeriesEpisode?.seasonNumber || 1)))
  : Number.isFinite(fallbackSeasonNumber)
    ? Math.max(1, Math.floor(fallbackSeasonNumber))
    : 1;
let episodeNumber = isSeriesPlayback
  ? Math.max(
      1,
      Math.floor(
        Number(activeSeriesEpisode?.episodeNumber || seriesEpisodeIndex + 1),
      ),
    )
  : Number.isFinite(fallbackEpisodeNumber)
    ? Math.max(1, Math.floor(fallbackEpisodeNumber))
    : 1;
const hasAudioLangParam = params.has("audioLang");
const audioLangParam = (params.get("audioLang") || "auto").trim().toLowerCase();
const hasQualityParam = params.has("quality");
const qualityParam = (params.get("quality") || "auto").trim().toLowerCase();
let preferredContainerParam = String(
  activeSeries?.preferredContainer || params.get("preferredContainer") || "",
)
  .trim()
  .toLowerCase();
let preferredContainer =
  preferredContainerParam === "mp4" || preferredContainerParam === "mkv"
    ? preferredContainerParam
    : "";
const hasSubtitleLangParam = params.has("subtitleLang");
const subtitleLangParam = (params.get("subtitleLang") || "")
  .trim()
  .toLowerCase();
const sourceHashParam = (params.get("sourceHash") || "").trim().toLowerCase();
const shouldResumeRememberedPlayback = /^(1|true|yes|on)$/.test(String(params.get("resumePlayback") || "").trim().toLowerCase());
const hasDirectSourceHashParam = new URLSearchParams(window.location.search).has(
  "sourceHash",
);
const saveToGalleryParam = (params.get("saveToGallery") || "")
  .trim()
  .toLowerCase();
const shouldSaveToGallery = new Set(["1", "true", "yes", "on"]).has(
  saveToGalleryParam,
);
let hasExplicitSource = Boolean(src);
function computeIsExplicitLocalUploadSource() {
  if (!hasExplicitSource) return false;
  const normalizedSource = String(src || "").trim().toLowerCase();
  return (
    normalizedSource.startsWith("/media/") ||
    normalizedSource.includes("/media/") ||
    normalizedSource.startsWith("/videos/") ||
    normalizedSource.startsWith("videos/") ||
    normalizedSource.includes("/videos/") ||
    normalizedSource.startsWith("assets/videos/") ||
    normalizedSource.includes("/assets/videos/")
  );
}
let isExplicitLocalUploadSource = computeIsExplicitLocalUploadSource();
let isTmdbMoviePlayback = Boolean(
  !hasExplicitSource && tmdbId && mediaType === "movie",
);
let isTmdbTvPlayback = Boolean(
  !hasExplicitSource && tmdbId && mediaType === "tv",
);
let isTmdbResolvedPlayback = Boolean(isTmdbMoviePlayback || isTmdbTvPlayback);
const SOURCE_AUDIO_SYNC_PREF_KEY_PREFIX = "streamarena-source-audio-sync:";
const DEFAULT_SOURCE_RESULTS_LIMIT = 20;
const SOURCE_FETCH_BATCH_LIMIT = 20;
const supportedSourceFormats = ["mp4", "mkv"];
const supportedSourceFormatSet = new Set(supportedSourceFormats);
const DEFAULT_SOURCE_MIN_SEEDERS = 0;
const DEFAULT_SOURCE_LANGUAGE = "en";
const DEFAULT_SOURCE_AUDIO_PROFILE = "single";
const DEFAULT_RESOLVER_PROVIDER = "fastest";
const DEFAULT_REMUX_VIDEO_MODE = "auto";
const MOBILE_DEFAULT_STREAM_QUALITY_PREFERENCE = "720p";
// SOURCE_LANGUAGE_TOKENS — imported from ./src-ui/player/sources.js
const AUDIO_SYNC_STEP_MS = 50;
const RESUME_SAVE_MIN_INTERVAL_MS = 3000;
const RESUME_SAVE_MIN_DELTA_SECONDS = 1.5;
const RESUME_FLUSH_INTERVAL_MS = 1000;
const LOCAL_CACHE_UPGRADE_POLL_MS = 20_000;
const LOCAL_CACHE_UPGRADE_INITIAL_DELAY_MS = 8_000;
// Benchmark API is deferred to onMount (needs video ref)
let playbackBenchmark = null;

let selectedSourceHash = normalizeSourceHash(sourceHashParam);
let pendingSourceSwitchHash = "";
let currentTmdbPlaybackSessionKey = "";
let currentTmdbResolverProvider = "";
let currentTmdbResolvedFilename = "";
let currentTmdbSelectedFile = "";
let sourceSelectionPinned = Boolean(selectedSourceHash);

function getPinnedSourceHashForRequests() {
  if (!sourceSelectionPinned) {
    return "";
  }
  return normalizeSourceHash(selectedSourceHash);
}

function getPinnedSessionKeyForRequests() {
  if (!sourceSelectionPinned || !getPinnedSourceHashForRequests()) {
    return "";
  }
  return String(currentTmdbPlaybackSessionKey || "").trim();
}


function getTvSubtitlePreferenceKey() {
  return buildTvSubtitlePreferenceKey(tmdbId, seasonNumber, episodeNumber);
}

function getLocalSubtitlePreferenceSourceKey() {
  return buildLocalSubtitlePreferenceSourceKey({
    isExplicitLocalUploadSource,
    isSeriesPlayback,
    activeSeries,
    seriesEpisodeIndex,
    src,
  });
}

function getSubtitlePreferenceStorageTarget() {
  return resolveSubtitlePreferenceStorageTarget({
    isTmdbMoviePlayback,
    isTmdbTvPlayback,
    tmdbId,
    seasonNumber,
    episodeNumber,
    isExplicitLocalUploadSource,
    isSeriesPlayback,
    activeSeries,
    seriesEpisodeIndex,
    src,
  });
}

function getStoredSubtitleStreamPreferenceForCurrentPlayback() {
  return getStoredSubtitleStreamPreferenceForTarget(
    getSubtitlePreferenceStorageTarget(),
  );
}

function getStoredSubtitleLangForCurrentPlayback() {
  return getStoredSubtitleLangForTarget(getSubtitlePreferenceStorageTarget());
}

function persistSubtitleLangPreference(lang) {
  persistSubtitleLangPreferenceForTarget(
    getSubtitlePreferenceStorageTarget(),
    lang,
  );
}

function persistSubtitleStreamPreference(streamIndex) {
  persistSubtitleStreamPreferenceForTarget(
    getSubtitlePreferenceStorageTarget(),
    streamIndex,
  );
}

function persistAudioLangPreference(lang) {
  if (!isTmdbMoviePlayback || !tmdbId) {
    return;
  }
  persistAudioLangPreferenceForMovie(tmdbId, lang);
}

let preferredAudioLang = hasAudioLangParam
  ? isRecognizedAudioLang(audioLangParam)
    ? audioLangParam
    : getStoredDefaultAudioLanguage()
  : getStoredDefaultAudioLanguage();
if (isTmdbMoviePlayback && !hasAudioLangParam) {
  const storedAudioLang = getStoredAudioLangForTmdbMovie(tmdbId);
  if (isRecognizedAudioLang(storedAudioLang) && storedAudioLang !== "auto") {
    preferredAudioLang = storedAudioLang;
  }
}
if (isTmdbMoviePlayback && hasAudioLangParam) {
  persistAudioLangPreference(preferredAudioLang);
}
let preferredQuality = normalizePreferredQuality(qualityParam);
applyMobileLightTmdbDefaults();
let preferredSourceMinSeeders = DEFAULT_SOURCE_MIN_SEEDERS;
let preferredSourceResultsLimit = DEFAULT_SOURCE_RESULTS_LIMIT;
let preferredSourceFormats = [...supportedSourceFormats];
let preferredSourceLanguage = DEFAULT_SOURCE_LANGUAGE;
let preferredSourceAudioProfile = DEFAULT_SOURCE_AUDIO_PROFILE;
let preferredResolverProvider = DEFAULT_RESOLVER_PROVIDER;
let preferredAudioSyncMs = 0;
let preferredRemuxVideoMode = DEFAULT_REMUX_VIDEO_MODE;
preferredSubtitleLang = normalizeSubtitlePreference(subtitleLangParam);
if (
  (isTmdbMoviePlayback || isTmdbTvPlayback || isExplicitLocalUploadSource) &&
  !hasSubtitleLangParam
) {
  preferredSubtitleLang =
    getStoredSubtitleLangForCurrentPlayback() || preferredSubtitleLang;
}
if (
  (isTmdbMoviePlayback || isTmdbTvPlayback || isExplicitLocalUploadSource) &&
  hasSubtitleLangParam
) {
  persistSubtitleLangPreference(preferredSubtitleLang);
}
applyPreferredSourceAudioSync(selectedSourceHash);
let sourceIdentity = isSeriesPlayback
  ? `series:${activeSeries.id}:episode:${seriesEpisodeIndex}`
  : isLivePlayback
    ? `live:${slugify(title) || "stream"}`
  : src ||
    (isTmdbResolvedPlayback
      ? `tmdb:${mediaType}:${tmdbId}${isTmdbTvPlayback ? `:s${seasonNumber}:e${episodeNumber}` : ""}`
      : `watch:${slugify(title) || "untitled"}`);
prepareLiveFailureCacheForCurrentEvent();
selectRememberedWorkingLiveStreamIfNeeded();
selectFirstFreshLiveStreamIfNeeded();
let resumeStorageKey = `streamarena-resume:${sourceIdentity}`;
const speedStorageKey = "streamarena-playback-speed";
let resumeTime = 0;
let lastPersistedResumeTime = 0;
let lastPersistedResumeAt = 0;
let resumeFlushIntervalId = 0;

function shouldPreferMobileLightTmdbSources() {
  return Boolean(isTmdbResolvedPlayback && isMobileOrTabletVideoEnvironment());
}

function shouldUseFreshMobileTmdbSourceOrder() {
  return shouldPreferMobileLightTmdbSources() && !normalizeSourceHash(sourceHashParam);
}

function applyMobileLightTmdbDefaults() {
  if (!shouldPreferMobileLightTmdbSources()) {
    return;
  }
  if (!hasQualityParam) {
    preferredQuality = MOBILE_DEFAULT_STREAM_QUALITY_PREFERENCE;
  }
  if (isTmdbTvPlayback && !preferredContainerParam) {
    preferredContainer = "mp4";
  }
}

function clearRememberedTmdbSourcePinForFreshResolve() {
  if (hasDirectSourceHashParam && normalizeSourceHash(sourceHashParam)) {
    return;
  }
  selectedSourceHash = "";
  sourceSelectionPinned = false;
  currentTmdbPlaybackSessionKey = "";
  currentTmdbResolverProvider = "";
  currentTmdbResolvedFilename = "";
  currentTmdbSelectedFile = "";
  activeTrackSourceInput = "";
  preferredResolverProvider = DEFAULT_RESOLVER_PROVIDER;
  tmdbSkipExternalEmbed = false;
  applyPreferredSourceAudioSync(selectedSourceHash);
}

function isTorrentResolverProviderEnabledForPlayback(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!isTorrentResolverProvider(normalized)) {
    return true;
  }
  if (!userRealDebridSettingsLoaded) return false;
  if (normalized === "local-torrent") return userLocalTorrentEnabled;
  return isUserRealDebridPlaybackEnabled();
}

function isUserRealDebridPlaybackEnabled() {
  return userRealDebridConfigured && userRealDebridEnabled;
}

async function loadUserRealDebridPlaybackSettings() {
  if (!isTmdbResolvedPlayback) {
    return;
  }
  if (userRealDebridSettingsPromise) {
    await userRealDebridSettingsPromise;
    return;
  }
  userRealDebridSettingsPromise = fetchUserApi("/api/user/torrent-settings", {
    cache: "no-store",
  })
    .then(async (response) => (response.ok ? response.json() : {}))
    .then((payload) => {
      const settings = normalizeRealDebridSettings(payload);
      userRealDebridConfigured = settings.configured;
      userRealDebridEnabled = settings.enabled;
      userLocalTorrentEnabled = settings.localTorrentEnabled;
    })
    .catch(() => {
      userRealDebridConfigured = false;
      userRealDebridEnabled = false;
      userLocalTorrentEnabled = false;
    })
    .finally(() => {
      userRealDebridSettingsLoaded = true;
    });
  await userRealDebridSettingsPromise;
}

function clearDisabledTorrentPlaybackState() {
  if (!isTmdbResolvedPlayback) {
    return false;
  }
  const provider = String(
    currentTmdbResolverProvider || preferredResolverProvider || "",
  )
    .trim()
    .toLowerCase();
  if (!isTorrentResolverProvider(provider)) {
    return false;
  }
  if (isTorrentResolverProviderEnabledForPlayback(provider)) {
    return false;
  }
  clearRememberedTmdbSourcePinForFreshResolve();
  return true;
}

function shouldAllowTorrentResolveFallback() {
  return Boolean(
    userRealDebridSettingsLoaded &&
      (isUserRealDebridPlaybackEnabled() || userLocalTorrentEnabled),
  );
}

function getTmdbTorrentResolveTimeoutMs() {
  return getManualSourceSwitchTimeouts({
    localTorrentEnabled: userLocalTorrentEnabled,
    realDebridConfigured: isUserRealDebridPlaybackEnabled(),
    resolverProvider: preferredResolverProvider,
  }).resolveTimeoutMs;
}

function getRememberedContinueWatchingSourceState() {
  return readRememberedContinueWatchingSourceState(sourceIdentity);
}

function rememberServerContinueWatchingEntry(entry) {
  return mergeRememberedServerContinueWatchingEntry(sourceIdentity, entry);
}

function shouldIgnoreRememberedTmdbSourcePinForIframeFirst(remembered) {
  return shouldIgnoreRememberedTmdbSourcePinForState({
    remembered,
    selectedSourceHash,
    hasDirectSourceHashParam,
    shouldResumeRememberedPlayback,
    torrentProviderEnabled: isTorrentResolverProviderEnabledForPlayback(
      remembered.resolverProvider,
    ),
    preferredResolverProvider,
    preferredTorrentEnabled: isTorrentResolverProviderEnabledForPlayback(
      preferredResolverProvider,
    ),
  });
}

function applyRememberedTmdbSourcePin({ force = false } = {}) {
  if (!isTmdbResolvedPlayback) {
    return false;
  }
  const remembered = getRememberedContinueWatchingSourceState();
  if (shouldIgnoreRememberedTmdbSourcePinForIframeFirst(remembered)) {
    clearRememberedTmdbSourcePinForFreshResolve();
    return false;
  }
  if (
    shouldUseFreshMobileTmdbSourceOrder() &&
    (remembered.sourceHash || remembered.sessionKey || remembered.resolverProvider)
  ) {
    clearRememberedTmdbSourcePinForFreshResolve();
    return false;
  }
  if (force) {
    selectedSourceHash = remembered.sourceHash;
    sourceSelectionPinned = Boolean(selectedSourceHash);
    currentTmdbPlaybackSessionKey = remembered.sessionKey;
    currentTmdbResolverProvider = remembered.resolverProvider;
    currentTmdbResolvedFilename = remembered.filename;
    activeTrackSourceInput = remembered.sourceInput;
    if (isTorrentResolverProvider(remembered.resolverProvider)) {
      if (!isTorrentResolverProviderEnabledForPlayback(remembered.resolverProvider)) {
        clearRememberedTmdbSourcePinForFreshResolve();
        return false;
      }
      preferredResolverProvider = remembered.resolverProvider;
      tmdbSkipExternalEmbed = true;
    } else if (remembered.resolverProvider === "external-embed") {
      tmdbSkipExternalEmbed = false;
    }
  } else if (!selectedSourceHash && remembered.sourceHash) {
    selectedSourceHash = remembered.sourceHash;
  }
  if (selectedSourceHash) {
    sourceSelectionPinned = true;
    if (remembered.sourceHash === selectedSourceHash) {
      currentTmdbPlaybackSessionKey =
        currentTmdbPlaybackSessionKey || remembered.sessionKey;
      currentTmdbResolverProvider = currentTmdbResolverProvider || remembered.resolverProvider;
      currentTmdbResolvedFilename = currentTmdbResolvedFilename || remembered.filename;
      activeTrackSourceInput = activeTrackSourceInput || remembered.sourceInput;
      if (isTorrentResolverProvider(remembered.resolverProvider)) {
        if (!isTorrentResolverProviderEnabledForPlayback(remembered.resolverProvider)) {
          clearRememberedTmdbSourcePinForFreshResolve();
          return false;
        }
        preferredResolverProvider = remembered.resolverProvider;
        tmdbSkipExternalEmbed = true;
      }
    }
    applyPreferredSourceAudioSync(selectedSourceHash);
    return true;
  }
  return false;
}

applyRememberedTmdbSourcePin();
clearDisabledTorrentPlaybackState();

try {
  const storedResume = Number(localStorage.getItem(resumeStorageKey));
  if (Number.isFinite(storedResume) && storedResume > 0) {
    resumeTime = storedResume;
    lastPersistedResumeTime = storedResume;
  }
} catch {
  // Ignore storage access issues.
}
// If localStorage has no resume, fetch from server and apply as fallback.
if (!(resumeTime > 1)) {
  fetchUserApi("/api/user/watch-progress")
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data) return;
      const entry = (data.entries || []).find(
        (e) => e.sourceIdentity === sourceIdentity,
      );
      if (entry && Number.isFinite(entry.resumeSeconds) && entry.resumeSeconds > 1) {
        resumeTime = entry.resumeSeconds;
        lastPersistedResumeTime = entry.resumeSeconds;
        resetInitialResumeApplication();
        try {
          localStorage.setItem(resumeStorageKey, String(entry.resumeSeconds));
        } catch {}
        persistContinueWatchingEntry(entry.resumeSeconds);
        if (!applyInitialResumeIfReady()) {
          scheduleInitialResumeRetry();
        }
      }
    })
    .catch(() => {});
}

function getCanonicalContinueWatchingMetadata() {
  const isTmdbSeriesPlayback = Boolean(isTmdbTvPlayback && tmdbId);
  const normalizedSeriesId = isSeriesPlayback
    ? String(activeSeries?.id || "")
    : isTmdbSeriesPlayback
      ? String(activeSeries?.id || `tmdb-tv-${tmdbId}`)
      : "";
  const normalizedEpisodeIndex =
    isSeriesPlayback || isTmdbSeriesPlayback
      ? Math.max(
          0,
          Math.floor(
            Number.isFinite(Number(seriesEpisodeIndex))
              ? Number(seriesEpisodeIndex)
              : Number(episodeNumber || 1) - 1,
          ),
        )
      : -1;
  const normalizedSourceHash = isTmdbResolvedPlayback
    ? normalizeSourceHash(selectedSourceHash)
    : "";
  const activeIframeSourceInput = isLiveIframePlaybackActive()
    ? parseLiveIframePlaybackSource(lastRequestedPlaybackSource) ||
      lastRequestedAbsolutePlaybackSource
    : "";
  const resolvedSourceInput = isTmdbResolvedPlayback
    ? String(
        activeTrackSourceInput ||
          activeTranscodeInput ||
          activeIframeSourceInput ||
          "",
      ).trim()
    : "";
  return {
    title: String(title || "Title"),
    episode: String(episode || "Now Playing"),
    src: String(src || ""),
    tmdbId: String(tmdbId || ""),
    mediaType: String(mediaType || ""),
    seriesId: normalizedSeriesId,
    episodeIndex: normalizedEpisodeIndex,
    seasonNumber:
      isSeriesPlayback || isTmdbSeriesPlayback
        ? Math.max(1, Math.floor(Number(seasonNumber || 1)))
        : 0,
    episodeNumber:
      isSeriesPlayback || isTmdbSeriesPlayback
        ? Math.max(1, Math.floor(Number(episodeNumber || 1)))
        : 0,
    year: String(year || ""),
    thumb: isSeriesPlayback || isTmdbSeriesPlayback
      ? String(activeSeriesEpisode?.thumb || DEFAULT_EPISODE_THUMBNAIL)
      : thumbParam,
    sourceHash: normalizedSourceHash,
    sessionKey: isTmdbResolvedPlayback ? String(currentTmdbPlaybackSessionKey || "").trim() : "",
    resolverProvider: isTmdbResolvedPlayback
      ? String(currentTmdbResolverProvider || preferredResolverProvider || "").trim()
      : "",
    sourceInput: resolvedSourceInput,
    filename: isTmdbResolvedPlayback ? String(currentTmdbResolvedFilename || "").trim() : "",
  };
}


function persistContinueWatchingEntry(resumeSeconds) {
  writeContinueWatchingEntry(
    sourceIdentity,
    resumeSeconds,
    getCanonicalContinueWatchingMetadata(),
  );
}

function syncContinueWatchingEntryToServer(resumeSeconds, { keepalive = false } = {}) {
  const normalizedSource = String(sourceIdentity || "").trim();
  if (
    !normalizedSource ||
    !Number.isFinite(resumeSeconds) ||
    resumeSeconds < 1
  ) {
    return;
  }

  const metadata = getCanonicalContinueWatchingMetadata();
  fetchUserApi("/api/user/continue-watching", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: replaySafeMutationBody({
      sourceIdentity: normalizedSource,
      resumeSeconds,
      ...metadata,
    }),
    keepalive,
  }).catch(() => {});
}

// Live playback has no resume position, so it never lands in continue-watching.
// Instead, once a live source is genuinely playing, log a single lightweight
// "watched live" event (deduped by title for 10 minutes so source failover and
// the resume-flush timer don't spam it) for the admin activity feed + top-live
// panel. Never let this interfere with playback.
let lastLiveWatchKey = "";
let lastLiveWatchAt = 0;
const LIVE_WATCH_DEDUPE_MS = 10 * 60 * 1000;

function maybeRecordLiveWatch() {
  try {
    const cleanTitle = String(title || "").trim();
    if (!cleanTitle) {
      return;
    }
    const nativePlaying =
      video && !video.paused && (Number(video.currentTime) || 0) > 1;
    const iframePlaying = liveIframePlaybackClock.isRunning();
    if (!nativePlaying && !iframePlaying) {
      return;
    }
    const now = Date.now();
    if (
      cleanTitle === lastLiveWatchKey &&
      now - lastLiveWatchAt < LIVE_WATCH_DEDUPE_MS
    ) {
      return;
    }
    lastLiveWatchKey = cleanTitle;
    lastLiveWatchAt = now;
    fetchUserApi("/api/user/live-watch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: cleanTitle,
        category: shouldResolveLiveEmbedSource ? "sports" : "channel",
        sourceIdentity: String(sourceIdentity || ""),
      }),
    }).catch(() => {});
  } catch {
    // Activity logging is best-effort.
  }
}

function removeContinueWatchingEntry() {
  const normalizedSource = String(sourceIdentity || "").trim();
  if (!normalizedSource) {
    return;
  }

  removeContinueWatchingMeta(normalizedSource);

  // Sync deletion to server in background
  fetchUserApi("/api/user/continue-watching", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: replaySafeMutationBody({ sourceIdentity: normalizedSource }),
  }).catch(() => {});
}

const {
  hasTarget: hasInitialResumeTarget,
  getStartSeconds: getInitialPlaybackStartSeconds,
  reset: resetInitialResumeApplication,
  markHandled: markInitialResumeHandled,
  shouldHoldProgressSave: shouldHoldProgressSaveForInitialResume,
  applyIfReady: applyInitialResumeIfReady,
  scheduleRetry: scheduleInitialResumeRetry,
  clearRetry: clearInitialResumeRetry,
} = createInitialResumeController({
  getResumeTime: () => resumeTime,
  getEffectiveCurrentTime,
  getSeekScaleDurationSeconds,
  getTimelineDurationSeconds,
  isTranscodeSourceActive,
  getTranscodeBaseOffsetSeconds: () => transcodeBaseOffsetSeconds,
  getVideo: () => video,
  seekToAbsoluteTime: (seconds) =>
    seekToAbsoluteTime(seconds, { isInitialResume: true }),
  syncSeekState,
  setTimeoutFn: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeoutFn: (timeoutId) => window.clearTimeout(timeoutId),
});

if (resumeTime > 1) {
  resetInitialResumeApplication();
  persistContinueWatchingEntry(resumeTime);
}

function stripAudioSyncFromPageUrl() {
  if (!params.has("audioSyncMs")) {
    return;
  }
  params.delete("audioSyncMs");
  replaceReproducibleWatchUrl();
}


const {
  isResolvingSource,
  clearSeekLoadingTimeout,
  showSeekLoadingIndicator,
  hideSeekLoadingIndicator,
  showResolver,
  hideResolver,
} = createResolverOverlayController({
  getOverlay: () => resolverOverlay,
  getStatus: () => resolverStatus,
  getTitle: () => resolverTitle,
  getDetail: () => resolverDetail,
  getCountdown: () => resolverCountdown,
  getRetryButton: () => resolverRetryButton,
  getAlternateButton: () => resolverAlternateButton,
  getLoader: () => resolverLoader,
  getSeekLoadingOverlay: () => seekLoadingOverlay,
  hasExplicitSource: () => hasExplicitSource,
  isLiveIframePlaybackActive,
  scheduleControlsHide,
});

function normalizeResolverFailureMessage(errorOrMessage, fallbackMessage) {
  return formatResolverFailureMessage(errorOrMessage, fallbackMessage, {
    isExplicitLocalUploadSource,
    src,
    preferredResolverProvider,
    isLivePlayback,
    hasAlternatePlaybackSource: liveStreamOptions.length > 1,
  });
}

function clearPendingVideoSource() {
  if (!video) {
    return;
  }
  try {
    clearLiveVisualHealthWatch({ resetSamples: true });
    clearLiveStartupHealthWatch({ resetRequest: true });
    video.pause();
    video.removeAttribute("src");
    video.load();
  } catch {
    // Ignore media cleanup failures; the resolver error is the user-visible state.
  }
}

function showResolverError(
  errorOrMessage,
  fallbackMessage = "Unable to resolve this stream.",
  {
    clearVideoSource = false,
    showRetry = !isTmdbResolvedPlayback && hasRecoverablePlaybackSource(),
    showAlternate = isTmdbResolvedPlayback,
  } = {},
) {
  clearPlaybackRecovery({ hideOverlay: false });
  hideSeekLoadingIndicator();
  if (clearVideoSource) {
    clearPendingVideoSource();
  }
  const failedSourceHash = normalizeSourceHash(selectedSourceHash);
  if (failedSourceHash) {
    resolverFailedSourceHashes.add(failedSourceHash);
  }

  const message = normalizeResolverFailureMessage(
    errorOrMessage,
    fallbackMessage,
  );
  showResolver(message, {
    isError: true,
    showStatus: true,
    showRetry,
    showAlternate,
  });

  if (resolverOverlay) {
    resolverOverlay.hidden = false;
    resolverOverlay.classList.add("is-error", "has-status");
    resolverOverlay.classList.remove("is-recovery");
    resolverOverlay.classList.toggle("has-actions", showRetry || showAlternate);
  }
  if (resolverLoader) {
    resolverLoader.hidden = true;
  }
  if (resolverStatus) {
    resolverStatus.hidden = false;
  }
  return message;
}

function hasActiveSource() {
  return Boolean(video.currentSrc || video.getAttribute("src"));
}

function hasRecoverablePlaybackSource() {
  return Boolean(
    hasActiveSource() ||
      lastRequestedAbsolutePlaybackSource ||
      lastRequestedPlaybackSource,
  );
}

function getLocalLibraryPlaybackProbeUrl(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return "";
  }
  let url;
  try {
    url = new URL(rawValue, window.location.origin);
  } catch {
    return "";
  }
  if (url.origin !== window.location.origin) {
    return "";
  }
  const pathname = url.pathname.toLowerCase();
  if (
    pathname.startsWith("/assets/videos/") ||
    pathname.startsWith("/videos/") ||
    pathname.startsWith("/media/")
  ) {
    return `${url.pathname}${url.search}`;
  }
  return "";
}

async function localLibraryPlaybackSourceExists(value) {
  const probeUrl = getLocalLibraryPlaybackProbeUrl(value);
  if (!probeUrl) {
    return true;
  }
  try {
    const response = await fetch(probeUrl, {
      method: "HEAD",
      cache: "no-store",
    });
    if (response.ok) {
      return true;
    }
    if (response.status === 405) {
      const rangeResponse = await fetch(probeUrl, {
        headers: { Range: "bytes=0-0" },
        cache: "no-store",
      });
      return rangeResponse.ok || rangeResponse.status === 206;
    }
    return false;
  } catch {
    return true;
  }
}

function appendSubtitleOptionContent(button, primaryLabel, secondaryLabel = "") {
  button.textContent = "";

  const name = document.createElement("span");
  name.className = "subtitle-option-name";
  name.textContent = String(primaryLabel || "").trim() || "Subtitle";
  button.appendChild(name);

  if (!String(secondaryLabel || "").trim()) {
    return;
  }

  const meta = document.createElement("span");
  meta.className = "subtitle-option-meta";
  meta.textContent = String(secondaryLabel || "").trim();
  button.appendChild(meta);
}

function restoreSelectedSubtitleTrackAfterSourceChange() {
  if (selectedSubtitleStreamIndex < 0) {
    setCustomSubtitleText("");
    return;
  }

  const selectedTrack = getSubtitleTrackByStreamIndex(selectedSubtitleStreamIndex);
  if (!selectedTrack) {
    setCustomSubtitleText("");
    return;
  }

  applySubtitleTrackByStreamIndex(selectedSubtitleStreamIndex);
}

// normalizeSourceHash — imported from ./src-ui/player/sources.js

function getSourceAudioSyncStorageKey(sourceHash) {
  return `${SOURCE_AUDIO_SYNC_PREF_KEY_PREFIX}${normalizeSourceHash(sourceHash)}`;
}

function getStoredSourceAudioSyncMs(sourceHash) {
  const normalizedHash = normalizeSourceHash(sourceHash);
  if (!normalizedHash) {
    return 0;
  }
  try {
    return normalizeAudioSyncMs(
      localStorage.getItem(getSourceAudioSyncStorageKey(normalizedHash)),
    );
  } catch {
    return 0;
  }
}

function persistSourceAudioSyncMs(sourceHash, audioSyncMs) {
  const normalizedHash = normalizeSourceHash(sourceHash);
  if (!normalizedHash) {
    return;
  }
  const normalizedSync = normalizeAudioSyncMs(audioSyncMs);
  try {
    if (normalizedSync === 0) {
      localStorage.removeItem(getSourceAudioSyncStorageKey(normalizedHash));
      return;
    }
    localStorage.setItem(
      getSourceAudioSyncStorageKey(normalizedHash),
      String(normalizedSync),
    );
  } catch {
    // Ignore storage access issues.
  }
}

function applyPreferredSourceAudioSync(sourceHash = selectedSourceHash) {
  const normalizedHash = normalizeSourceHash(sourceHash);
  preferredAudioSyncMs = normalizedHash
    ? getStoredSourceAudioSyncMs(normalizedHash)
    : 0;
  // Subtitle delay is also stored per source, so load it on the same hook.
  subtitleOffset.applyForSource(normalizedHash);
}

// getSourceDisplayName, getSourceDisplayHint, getSourceDisplayMeta — imported from ./src-ui/player/sources.js

// sortSourcesBySeeders — imported from ./src-ui/player/sources.js

function getSourceOptionByHash(sourceHash) {
  const normalizedHash = normalizeSourceHash(sourceHash);
  if (!normalizedHash) {
    return null;
  }
  return (
    availablePlaybackSources.find(
      (option) =>
        normalizeSourceHash(option?.sourceHash || "") === normalizedHash,
    ) || null
  );
}

function getCurrentResolvedSourceOptionFallback(sourceHash = selectedSourceHash) {
  const normalizedHash = normalizeSourceHash(sourceHash);
  if (!normalizedHash) {
    return null;
  }

  const existingOption = getSourceOptionByHash(normalizedHash);
  if (existingOption) {
    return existingOption;
  }

  const sourceName = String(
    currentTmdbResolvedFilename ||
      currentTmdbSelectedFile ||
      activeTrackSourceInput ||
      "",
  ).trim();
  const resolverProvider = String(currentTmdbResolverProvider || "")
    .trim()
    .toLowerCase();
  if (!sourceName && !resolverProvider) {
    return null;
  }

  const isExternalEmbed = resolverProvider === "external-embed";
  return {
    sourceHash: normalizedHash,
    infoHash: normalizedHash,
    primary: sourceName || "Current source",
    filename: sourceName,
    provider: isExternalEmbed ? "LivNet" : "Current",
    qualityLabel: isExternalEmbed ? "HLS" : "",
    container: isExternalEmbed ? "hls" : "",
    seeders: 0,
    size: "",
    releaseGroup: "",
  };
}

function getSourceSelectLabel(option = {}) {
  const name = getSourceDisplayName(option);
  const hint = getSourceDisplayHint(option);
  if (hint) {
    return `${name} — ${hint}`;
  }
  return name;
}

function renderSelectedSourceDetails() {
  if (!sourceOptionDetails) return;
  if (sourceDownload.applyStatus(sourceOptionDetails)) return;
  const selectedOption =
    getSourceOptionByHash(selectedSourceHash) ||
    availablePlaybackSources[0] ||
    null;
  if (!selectedOption) {
    sourceOptionDetails.hidden = true;
    sourceOptionDetails.textContent = "";
    return;
  }
  const details = [
    getSourceDisplayMeta(selectedOption),
    getSourceDisplayName(selectedOption),
  ]
    .filter(Boolean)
    .join("  ");
  sourceOptionDetails.hidden = !details;
  sourceOptionDetails.textContent = details;
}

function shouldShowTmdbSourceControls() {
  return Boolean(isTmdbResolvedPlayback);
}

function syncTmdbSourceControls() {
  const shouldShow = shouldShowTmdbSourceControls();
  if (sourceControl) {
    sourceControl.hidden = !shouldShow;
  }
  if (!shouldShow) {
    closeSourcePopover(false, { force: true });
  }

  const selectedOption =
    getSourceOptionByHash(selectedSourceHash) ||
    availablePlaybackSources[0] ||
    null;
  const sourceLabel = selectedOption
    ? getSourceSelectLabel(selectedOption)
    : "Playback sources";
  if (toggleSource) {
    toggleSource.setAttribute("aria-label", `Server (${sourceLabel})`);
    toggleSource.setAttribute("title", "Server");
    toggleSource.setAttribute(
      "aria-expanded",
      sourceControl?.classList.contains("is-open") ? "true" : "false",
    );
  }
  if (sourceMenu) {
    sourceMenu.setAttribute("aria-label", `Server (${sourceLabel})`);
  }
}

function syncSourcePanelVisibility() {
  activeAudioTab = "subtitles";

  if (audioTabSources) {
    audioTabSources.hidden = true;
    audioTabSources.disabled = true;
    audioTabSources.classList.remove("is-active");
    audioTabSources.setAttribute("aria-selected", "false");
    audioTabSources.tabIndex = -1;
  }

  if (audioTabSubtitles) {
    audioTabSubtitles.classList.add("is-active");
    audioTabSubtitles.setAttribute("aria-selected", "true");
    audioTabSubtitles.tabIndex = 0;
  }

  if (subtitlePanel) {
    subtitlePanel.hidden = false;
  }

  if (sourcePanel) {
    sourcePanel.hidden = true;
  }
}

function getPlayableSubtitleTracks() {
  return availableSubtitleTracks.filter((track) => isPlayableSubtitleTrack(track));
}

function shouldShowAudioSubtitleControl() {
  if (!isLivePlayback) {
    return true;
  }
  return availableAudioTracks.length > 0 || getPlayableSubtitleTracks().length > 0;
}

function syncAudioSubtitleControlVisibility() {
  if (!audioControl) {
    return;
  }
  const shouldShow = shouldShowAudioSubtitleControl();
  audioControl.hidden = !shouldShow;
  if (!shouldShow) {
    closeAudioPopover(false, { force: true });
  }
}

function setActiveAudioTab(nextTab = "subtitles") {
  const normalizedTab = nextTab === "sources" ? "sources" : "subtitles";
  const sourceTabVisible = isTmdbResolvedPlayback;
  activeAudioTab =
    normalizedTab === "sources" && sourceTabVisible ? "sources" : "subtitles";
  syncSourcePanelVisibility();
}

function syncSourceSelectionState() {
  if (!(sourceOptionsContainer instanceof HTMLElement)) {
    return;
  }

  const normalizedHash = normalizeSourceHash(selectedSourceHash);
  const loadingHash = normalizeSourceHash(pendingSourceSwitchHash);
  const optionButtons = Array.from(
    sourceOptionsContainer.querySelectorAll(".source-option"),
  );
  optionButtons.forEach((optionButton) => {
    const optionHash = normalizeSourceHash(
      optionButton.dataset.sourceHash || "",
    );
    const isLoading =
      Boolean(loadingHash) && Boolean(optionHash) && optionHash === loadingHash;
    optionButton.classList.toggle("is-loading", isLoading);
    optionButton.setAttribute("aria-busy", isLoading ? "true" : "false");
    optionButton.setAttribute(
      "aria-selected",
      !isLoading &&
        optionHash &&
        normalizedHash &&
        optionHash === normalizedHash
        ? "true"
        : "false",
    );
  });
  sourceDownload.syncButtons(sourceOptionsContainer);
}

function setPendingSourceSwitchHash(nextHash = "") {
  pendingSourceSwitchHash = normalizeSourceHash(nextHash);
  syncSourceSelectionState();
}

function renderSourceOptionButtons() {
  if (!(sourceOptionsContainer instanceof HTMLElement)) {
    return;
  }

  sourceOptionsContainer.innerHTML = "";
  const sourceView = buildSourceMenuView({
    sources: availablePlaybackSources,
    selectedSourceHash,
    requestedTab: activeSourceTypeTab,
    torrentsEnabled:
      userLocalTorrentEnabled || isUserRealDebridPlaybackEnabled(),
  });
  activeSourceTypeTab = sourceView.activeTab;
  syncSourceMenuTabs(sourceMenu?.querySelector(".source-type-tabs"), sourceView);

  if (!availablePlaybackSources.length) {
    const emptyState = document.createElement("p");
    emptyState.className = "source-option-empty";
    emptyState.textContent = isFetchingPlaybackSources
      ? "Loading sources..."
      : "No alternate sources available yet.";
    sourceOptionsContainer.appendChild(emptyState);
    if (sourceOptionDetails) {
      sourceOptionDetails.hidden = true;
      sourceOptionDetails.textContent = "";
    }
    syncTmdbSourceControls();
    return;
  }

  const seenHashes = new Set();
  const fragment = document.createDocumentFragment();
  const rankedSources = promoteSelectedSourceWithinCacheTier(
    sortSourcesBySeeders(sourceView.sources, {
      preferContainer: getSourceListPreferredContainer(),
    }),
    selectedSourceHash,
  );
  const sourceDisplayLimit = Math.max(
    preferredSourceResultsLimit,
    sourceView.sources.filter((option) => isSourceOptionEmbed(option)).length,
  );
  for (const option of rankedSources) {
    if (seenHashes.size >= sourceDisplayLimit) {
      break;
    }
    const sourceHash = normalizeSourceHash(
      option?.sourceHash || option?.infoHash || "",
    );
    if (!sourceHash || seenHashes.has(sourceHash)) {
      continue;
    }
    seenHashes.add(sourceHash);

    fragment.appendChild(createSourceOptionButton({
      iconSvg: SOURCE_OPTION_ICON_SVG,
      option,
      selectedSourceHash,
      sourceHash,
      loadingSourceHash: pendingSourceSwitchHash,
      downloadingSourceHash: sourceDownload.getDownloadingSourceHash(),
    }));
  }

  sourceOptionsContainer.appendChild(fragment);
  if (!seenHashes.size) {
    const emptyState = document.createElement("p");
    emptyState.className = "source-option-empty";
    emptyState.textContent = sourceView.emptyMessage;
    sourceOptionsContainer.appendChild(emptyState);
    if (sourceOptionDetails) {
      sourceOptionDetails.hidden = true;
      sourceOptionDetails.textContent = "";
    }
    return;
  }

  const normalizedSelectedSourceHash = normalizeSourceHash(selectedSourceHash);
  const hasSelectedSource =
    normalizedSelectedSourceHash &&
    availablePlaybackSources.some(
      (option) => normalizeSourceHash(option?.sourceHash || option?.infoHash || "") === normalizedSelectedSourceHash,
    );
  if (sourceSelectionPinned && !hasSelectedSource) {
    sourceSelectionPinned = false;
  }
  syncSourceSelectionState();
  renderSelectedSourceDetails();
  syncTmdbSourceControls();
  syncLiveStreamControls();
}

function shouldMapSubtitleStreamIndex(streamIndex) {
  const safeStreamIndex = Number.isFinite(streamIndex)
    ? Math.floor(streamIndex)
    : -1;
  if (safeStreamIndex < 0) {
    return false;
  }

  const selectedTrack = availableSubtitleTracks.find(
    (track) => Number(track?.streamIndex) === safeStreamIndex,
  );
  if (!selectedTrack) {
    return true;
  }

  return !selectedTrack.isExternal;
}

function isLocalPlaybackSource(source) {
  const normalizedSource = extractPlaybackSourceInput(source) || String(source || "").trim();
  return (
    normalizedSource.includes("/api/local-cache/stream") ||
    normalizedSource.includes("/api/local-torrent/stream")
  );
}

function shouldWatchForLocalCacheUpgrade(resolved) {
  if (!isTmdbResolvedPlayback || localCacheUpgradeWatch.hasUpgraded()) {
    return false;
  }
  const resolverProvider = String(
    resolved?.resolverProvider ||
      resolved?.session?.resolverProvider ||
      currentTmdbResolverProvider ||
      "",
  )
    .trim()
    .toLowerCase();
  if (resolverProvider === "local-torrent") {
    return false;
  }
  const playbackSource = String(
    resolved?.playableUrl || lastRequestedPlaybackSource || "",
  ).trim();
  if (
    resolverProvider === "external-embed" ||
    parseLiveIframePlaybackSource(playbackSource)
  ) {
    return false;
  }
  return playbackSource && !isLocalPlaybackSource(playbackSource);
}

function buildLocalCacheUpgradeUrl() {
  const query = new URLSearchParams({
    tmdbId: String(tmdbId || "").trim(),
    sourceHash: normalizeSourceHash(selectedSourceHash),
    audioLang: preferredAudioLang,
    quality: preferredQuality,
  });
  if (currentTmdbSelectedFile) {
    query.set("selectedFile", currentTmdbSelectedFile);
  }
  if (isTmdbTvPlayback) {
    query.set("mediaType", "tv");
    query.set("seasonNumber", String(Math.max(1, seasonNumber)));
    query.set("episodeNumber", String(Math.max(1, episodeNumber)));
  }
  return `/api/resolve/local-upgrade?${query.toString()}`;
}

const localCacheUpgradeWatch = createLocalCacheUpgradeWatch({
  shouldWatch: shouldWatchForLocalCacheUpgrade,
  canPoll: () => Boolean(
    isTmdbResolvedPlayback &&
      !isResolvingSource() &&
      !isRecoveringTmdbStream &&
      selectedSourceHash,
  ),
  getRequestIdentity: () => {
    const activeSource = String(
      lastRequestedPlaybackSource || video.currentSrc || "",
    ).trim();
    if (!activeSource || isLocalPlaybackSource(activeSource)) {
      return null;
    }
    return {
      activeSource,
      requestUrl: buildLocalCacheUpgradeUrl(),
      sessionKey: String(currentTmdbPlaybackSessionKey || "").trim(),
      sourceHash: normalizeSourceHash(selectedSourceHash),
    };
  },
  requestUpgrade: (identity) => requestJson(identity.requestUrl, {}, 8000),
  shouldApplyPayload: (payload) => Boolean(payload?.ready && payload?.playableUrl),
  applyUpgrade: (payload) => upgradePlaybackToLocalCache(payload),
  setTimeoutFn: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeoutFn: (timeoutId) => window.clearTimeout(timeoutId),
  setIntervalFn: (callback, delayMs) => window.setInterval(callback, delayMs),
  clearIntervalFn: (intervalId) => window.clearInterval(intervalId),
  initialDelayMs: LOCAL_CACHE_UPGRADE_INITIAL_DELAY_MS,
  pollIntervalMs: LOCAL_CACHE_UPGRADE_POLL_MS,
});

function stopLocalCacheUpgradeWatch() {
  localCacheUpgradeWatch.stop();
}

function startLocalCacheUpgradeWatch(resolved) {
  localCacheUpgradeWatch.start(resolved);
}

function isLocalCacheUpgradeWatchActive() {
  return localCacheUpgradeWatch.isActive();
}

async function upgradePlaybackToLocalCache(payload) {
  if (localCacheUpgradeWatch.hasUpgraded()) {
    return;
  }
  const localUrl = String(payload.playableUrl || "").trim();
  if (!localUrl || isLocalPlaybackSource(lastRequestedPlaybackSource)) {
    return;
  }
  const resumeSeconds = getEffectiveCurrentTime();
  if (!Number.isFinite(resumeSeconds) || resumeSeconds < 0) {
    return;
  }

  localCacheUpgradeWatch.setHasUpgraded(true);
  stopLocalCacheUpgradeWatch();

  activeTrackSourceInput = String(payload.sourceInput || localUrl).trim();
  currentTmdbPlaybackSessionKey =
    String(payload.session?.key || "").trim() || currentTmdbPlaybackSessionKey;
  currentTmdbResolverProvider = String(
    payload.resolverProvider || "local-torrent",
  ).trim();
  if (payload.filename) {
    currentTmdbResolvedFilename = String(payload.filename).trim();
  }
  if (payload.selectedFile) {
    currentTmdbSelectedFile = String(payload.selectedFile).trim();
  }

  const preferredSource = buildPreferredBrowserPlaybackSource(
    localUrl,
    activeTrackSourceInput,
    selectedAudioStreamIndex,
    selectedSubtitleStreamIndex,
  );
  setVideoSource(preferredSource, {
    startSeconds: resumeSeconds,
    resetInitialResume: false,
  });
  applySubtitleTrackByStreamIndex(selectedSubtitleStreamIndex);
  syncAudioState();
  scheduleDeferredMediaTrackEnrichment(payload);
  await tryPlay();
}

function getFullscreenContext() {
  return { video, playerShell, toggleFullscreen };
}

function clearSubtitleTrack() {
  if (!subtitleTrackElement) {
    clearCustomSubtitleOverlay({ invalidateToken: true });
    return;
  }
  try {
    subtitleTrackElement.remove();
  } catch {
    // Ignore DOM remove issues.
  }
  subtitleTrackElement = null;
  clearCustomSubtitleOverlay({ invalidateToken: true });
}

function hideAllSubtitleTracks() {
  Array.from(video.textTracks || []).forEach((textTrack) => {
    textTrack.mode = "disabled";
  });
}

function computeSubtitleLinePercentInBottomMatte() {
  return computeSubtitleLinePercentFromDimensions({
    viewportWidth: Number(video.clientWidth || 0),
    viewportHeight: Number(video.clientHeight || 0),
    mediaWidth: Number(video.videoWidth || 0),
    mediaHeight: Number(video.videoHeight || 0),
  });
}

function nudgeSubtitleTrackPlacementUp(textTrack) {
  applySubtitleTrackPlacement(textTrack, computeSubtitleLinePercentInBottomMatte());
}

function refreshActiveSubtitlePlacement() {
  const activeTrack =
    subtitleTrackElement?.track ||
    Array.from(video.textTracks || []).find(
      (track) => track.mode === "showing",
    ) ||
    null;
  if (activeTrack) {
    nudgeSubtitleTrackPlacementUp(activeTrack);
  }
  // Re-apply the subtitle delay to native cues whenever tracks (re)load.
  subtitleOffset.applyToNativeTracks(video.textTracks);
}

function showSubtitleTrackElement(trackElement) {
  if (!trackElement) {
    return;
  }
  hideAllSubtitleTracks();
  const directTrack = trackElement.track;
  if (directTrack) {
    nudgeSubtitleTrackPlacementUp(directTrack);
    directTrack.mode = "showing";
    return;
  }
  const fallbackTrack = Array.from(video.textTracks || []).find(
    (textTrack) => textTrack.label === trackElement.label,
  );
  if (fallbackTrack) {
    nudgeSubtitleTrackPlacementUp(fallbackTrack);
    fallbackTrack.mode = "showing";
  }
}

function syncSubtitleTrackVisibility() {
  if (subtitleTrackElement) {
    showSubtitleTrackElement(subtitleTrackElement);
    setCustomSubtitleText("");
    return;
  }
  const selectedTrack = getSubtitleTrackByStreamIndex(
    selectedSubtitleStreamIndex,
  );
  if (
    selectedTrack &&
    (!shouldUseNativeEmbeddedSubtitleTrack(selectedTrack) ||
      !hasLoadedNativeSubtitleTrack(selectedTrack)) &&
    isPlayableSubtitleTrack(selectedTrack)
  ) {
    hideAllSubtitleTracks();
    renderCustomSubtitleOverlay();
    return;
  }
  if (
    shouldUseNativeEmbeddedSubtitleTrack(selectedTrack) &&
    hasLoadedNativeSubtitleTrack(selectedTrack)
  ) {
    ensureNativeSubtitleTrackVisible();
    return;
  }
  hideAllSubtitleTracks();
  setCustomSubtitleText("");
}

function isPlayableSubtitleTrack(track) {
  return Boolean(
    track && track.isTextBased && String(track.vttUrl || "").trim(),
  );
}

function getSubtitleTrackByStreamIndex(streamIndex) {
  const safeStreamIndex = Number.isFinite(streamIndex)
    ? Math.floor(streamIndex)
    : -1;
  if (safeStreamIndex < 0) {
    return null;
  }
  return (
    availableSubtitleTracks.find(
      (track) => Number(track?.streamIndex) === safeStreamIndex,
    ) || null
  );
}

function shouldUseNativeEmbeddedSubtitleTrack(track) {
  // Prefer browser-native subtitle rendering for internal text tracks.
  // For remux playback this keeps subtitle selection attached to the source
  // and avoids slow VTT extraction against remote MKV URLs.
  // Skip for local sources — VTT overlay works fine and avoids forcing remux.
  const hasTrack = Boolean(track);
  if (!hasTrack || track.isExternal || !track.isTextBased) {
    return false;
  }
  if (isExplicitLocalUploadSource) {
    return false;
  }
  return true;
}

function getNativeEmbeddedSubtitleOrdinal(track) {
  if (!shouldUseNativeEmbeddedSubtitleTrack(track)) {
    return -1;
  }
  return availableSubtitleTracks
    .filter((candidate) => shouldUseNativeEmbeddedSubtitleTrack(candidate))
    .findIndex(
      (candidate) => Number(candidate?.streamIndex) === Number(track?.streamIndex),
    );
}

function hasLoadedNativeSubtitleTrack(track) {
  const preferredOrdinal = getNativeEmbeddedSubtitleOrdinal(track);
  if (preferredOrdinal < 0) {
    return false;
  }
  const nativeTracks = Array.from(video.textTracks || []);
  return preferredOrdinal < nativeTracks.length;
}

function ensureNativeSubtitleTrackVisible() {
  if (subtitleTrackElement) {
    return false;
  }
  const selectedTrack = getSubtitleTrackByStreamIndex(
    selectedSubtitleStreamIndex,
  );
  if (!shouldUseNativeEmbeddedSubtitleTrack(selectedTrack)) {
    return false;
  }
  if (!hasLoadedNativeSubtitleTrack(selectedTrack)) {
    return false;
  }

  const nativeTracks = Array.from(video.textTracks || []);
  const preferredOrdinal = getNativeEmbeddedSubtitleOrdinal(selectedTrack);
  nativeTracks.forEach((textTrack, index) => {
    textTrack.mode = index === preferredOrdinal ? "showing" : "disabled";
  });
  if (preferredOrdinal >= 0 && nativeTracks[preferredOrdinal]) {
    nudgeSubtitleTrackPlacementUp(nativeTracks[preferredOrdinal]);
  }
  return preferredOrdinal >= 0;
}

async function persistTrackPreferencesOnServer({
  audioLang = null,
  subtitleLang = null,
} = {}) {
  if (!isTmdbResolvedPlayback || !tmdbId) {
    return;
  }

  const payload = { tmdbId, mediaType: isTmdbTvPlayback ? "tv" : "movie" };
  if (audioLang !== null && audioLang !== undefined) {
    payload.audioLang = String(audioLang || "");
  }
  if (subtitleLang !== null && subtitleLang !== undefined) {
    payload.subtitleLang = String(subtitleLang || "");
  }

  try {
    await requestJson(
      "/api/title/preferences",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      10000,
    );
  } catch {
    // Ignore preference persistence failures.
  }
}

function applySubtitleTrackByStreamIndex(
  streamIndex,
  { preservePendingNative = false } = {},
) {
  clearSubtitleTrack();
  hideAllSubtitleTracks();

  const safeStreamIndex = Number.isFinite(streamIndex)
    ? Math.floor(streamIndex)
    : -1;
  if (safeStreamIndex < 0) {
    selectedSubtitleStreamIndex = -1;
    return;
  }

  const selectedTrack = getSubtitleTrackByStreamIndex(safeStreamIndex);
  if (!selectedTrack) {
    selectedSubtitleStreamIndex = -1;
    return;
  }

  selectedSubtitleStreamIndex = safeStreamIndex;
  const useNativeTrack = shouldUseNativeEmbeddedSubtitleTrack(selectedTrack);
  const hasNativeTrack = useNativeTrack && hasLoadedNativeSubtitleTrack(selectedTrack);
  if (hasNativeTrack || (useNativeTrack && preservePendingNative)) {
    if (hasNativeTrack) {
      ensureNativeSubtitleTrackVisible();
    }
    return;
  }

  if (!isPlayableSubtitleTrack(selectedTrack)) {
    selectedSubtitleStreamIndex = -1;
    return;
  }
  void loadCustomSubtitleFromTrack(selectedTrack).then(() => {
    if (Number.isFinite(selectedSubtitleStreamIndex) && selectedSubtitleStreamIndex >= 0) {
      renderCustomSubtitleOverlay();
    }
  });
  syncSubtitleTrackVisibility();
}

function rebuildTrackOptionButtons() {
  if (!audioOptionsContainer || !subtitleOptionsContainer) {
    return;
  }

  audioOptionsContainer.innerHTML = "";
  subtitleOptionsContainer.innerHTML = "";

  if (availableAudioTracks.length > 0) {
    availableAudioTracks.forEach((track) => {
      const button = document.createElement("button");
      button.className = "audio-option";
      button.type = "button";
      button.setAttribute("role", "option");
      button.dataset.streamIndex = String(track.streamIndex);
      button.dataset.trackLanguage = String(track.language || "");
      button.dataset.optionType = "audio-track";
      const { primary, secondary } = getAudioTrackDisplayParts(track);
      appendSubtitleOptionContent(button, primary, secondary);
      button.setAttribute(
        "aria-selected",
        Number(track.streamIndex) === selectedAudioStreamIndex
          ? "true"
          : "false",
      );
      audioOptionsContainer.appendChild(button);
    });
  } else if (isLivePlayback) {
    const button = document.createElement("button");
    button.className = "audio-option";
    button.type = "button";
    button.setAttribute("role", "option");
    button.dataset.optionType = "live-audio";
    appendSubtitleOptionContent(button, getUnknownAudioTrackDisplayLabel());
    button.setAttribute("aria-selected", "true");
    audioOptionsContainer.appendChild(button);
  } else {
    const button = document.createElement("button");
    button.className = "audio-option";
    button.type = "button";
    button.setAttribute("role", "option");
    button.dataset.optionType = "default-audio";
    appendSubtitleOptionContent(button, getUnknownAudioTrackDisplayLabel());
    button.setAttribute("aria-selected", "true");
    audioOptionsContainer.appendChild(button);
  }

  const subtitlesOffButton = document.createElement("button");
  subtitlesOffButton.className = "audio-option subtitle-option";
  subtitlesOffButton.type = "button";
  subtitlesOffButton.setAttribute("role", "option");
  subtitlesOffButton.dataset.optionType = "subtitle";
  subtitlesOffButton.dataset.subtitleStream = "-1";
  subtitlesOffButton.textContent = "Off";
  const currentSubtitleTrack = getSubtitleTrackByStreamIndex(
    selectedSubtitleStreamIndex,
  );
  if (
    selectedSubtitleStreamIndex >= 0 &&
    !isPlayableSubtitleTrack(currentSubtitleTrack)
  ) {
    selectedSubtitleStreamIndex = -1;
  }
  subtitlesOffButton.setAttribute(
    "aria-selected",
    selectedSubtitleStreamIndex < 0 ? "true" : "false",
  );
  appendSubtitleOptionContent(subtitlesOffButton, "Off");
  subtitleOptionsContainer.appendChild(subtitlesOffButton);

  const orderedSubtitleTracks = [...availableSubtitleTracks]
    .filter((track) => isPlayableSubtitleTrack(track))
    .map((track, index) => ({ track, index }))
    .sort((left, right) => {
      const leftForced = isLikelyForcedSubtitleTrack(left.track) ? 1 : 0;
      const rightForced = isLikelyForcedSubtitleTrack(right.track) ? 1 : 0;
      if (leftForced !== rightForced) {
        return leftForced - rightForced;
      }
      const leftExternal = left.track?.isExternal ? 0 : 1;
      const rightExternal = right.track?.isExternal ? 0 : 1;
      if (leftExternal !== rightExternal) {
        return leftExternal - rightExternal;
      }
      const leftDefault = left.track?.isDefault ? 0 : 1;
      const rightDefault = right.track?.isDefault ? 0 : 1;
      if (leftDefault !== rightDefault) {
        return leftDefault - rightDefault;
      }
      return left.index - right.index;
    })
    .map(({ track }) => track);

  orderedSubtitleTracks.forEach((track) => {
    const button = document.createElement("button");
    button.className = "audio-option subtitle-option";
    button.type = "button";
    button.setAttribute("role", "option");
    button.dataset.optionType = "subtitle";
    button.dataset.subtitleStream = String(track.streamIndex);
    button.dataset.subtitleLang = String(track.language || "");
    const { primary, secondary } = getSubtitleTrackDisplayParts(track);
    appendSubtitleOptionContent(button, primary, secondary);
    button.setAttribute(
      "aria-selected",
      Number(track.streamIndex) === selectedSubtitleStreamIndex
        ? "true"
        : "false",
    );
    subtitleOptionsContainer.appendChild(button);
  });

  audioOptions = Array.from(
    audioOptionsContainer.querySelectorAll(".audio-option"),
  );
  subtitleOptions = Array.from(
    subtitleOptionsContainer.querySelectorAll(".subtitle-option"),
  );
  renderSourceOptionButtons();
  syncAudioSubtitleControlVisibility();
}

function isTranscodeSourceActive() {
  return Boolean(activeTranscodeInput);
}

function getEffectiveCurrentTime() {
  if (isLiveIframePlaybackActive()) {
    return liveIframePlaybackClock.getSeconds();
  }
  if (isTranscodeSourceActive()) {
    return transcodeBaseOffsetSeconds + (Number(video.currentTime) || 0);
  }
  return Number(video.currentTime) || 0;
}

function getLiveSeekableWindow() {
  return getLiveSeekableWindowFromVideo(video, isLivePlayback);
}

function getLiveEdgeTargetSeconds(liveWindow = getLiveSeekableWindow()) {
  return getLiveEdgeTargetSecondsFromWindow(liveWindow);
}

function clampLiveSeekTargetSeconds(targetSeconds) {
  return clampLiveSeekTargetSecondsInWindow(targetSeconds, getLiveSeekableWindow());
}

function getSeekTargetSecondsFromRatio(ratio, fallbackDurationSeconds) {
  return getSeekTargetSecondsFromRatioForWindow(ratio, {
    isLivePlayback,
    liveWindow: getLiveSeekableWindow(),
    fallbackDurationSeconds,
  });
}

function updateLiveEdgePinFromTarget(targetSeconds) {
  if (!isLivePlayback) {
    liveEdgePinned = false;
    return;
  }
  liveEdgePinned = shouldPinLiveEdgeFromTarget(
    targetSeconds,
    getLiveEdgeTargetSeconds(),
  );
}

function getFallbackPlayerReturnPath() {
  if (isLivePlayback) {
    return shouldResolveLiveEmbedSource ? "/sports" : "/live";
  }
  return "/";
}

function getExplicitPlayerReturnPath() {
  return normalizeInternalReturnToPath(params.get("returnTo") || "");
}

function getReferrerPlayerReturnPath() {
  return normalizeInternalReturnToPath(document.referrer || "");
}

function navigateBackFromPlayer() {
  persistResumeTime(true);

  const explicitReturnPath = getExplicitPlayerReturnPath();
  const referrerReturnPath = getReferrerPlayerReturnPath();
  if (
    explicitReturnPath &&
    referrerReturnPath === explicitReturnPath &&
    window.history.length > 1
  ) {
    window.history.back();
    return;
  }
  if (explicitReturnPath) {
    window.location.href = explicitReturnPath;
    return;
  }
  if (referrerReturnPath && window.history.length > 1) {
    window.history.back();
    return;
  }
  if (referrerReturnPath) {
    window.location.href = referrerReturnPath;
    return;
  }

  window.location.href = getFallbackPlayerReturnPath();
}

function clearLiveIframePlayback() {
  liveIframePlaybackClock.reset();
  playerShell?.classList.remove("live-iframe-active");
}

function isLiveIframePlaybackActive() {
  return Boolean(parseLiveIframePlaybackSource(lastRequestedPlaybackSource));
}

function adoptHlsRemuxFallbackSource(absoluteSource) {
  const fallbackSource = String(absoluteSource || "").trim();
  const transcodeMeta = parseTranscodeSource(fallbackSource);
  if (!fallbackSource || !transcodeMeta) {
    return false;
  }
  lastRequestedPlaybackSource = fallbackSource;
  lastRequestedAbsolutePlaybackSource = fallbackSource;
  lastPlaybackSourceSetAt = performance.now();
  resetAudioDecodeWatchState();
  activeTranscodeInput = transcodeMeta.input;
  transcodeBaseOffsetSeconds = transcodeMeta.startSeconds;
  activeAudioStreamIndex = transcodeMeta.audioStreamIndex;
  activeAudioSyncMs = transcodeMeta.audioSyncMs;
  activeTrackSourceInput = transcodeMeta.input;
  playbackBenchmark?._recordSourceChange(fallbackSource);
  markManualSourceSwitchPlaybackRequested(selectedSourceHash);
}

function setVideoSource(
  nextSource,
  { resetInitialResume = true, startSeconds = 0, autoplay = true } = {},
) {
  if (!nextSource) return;
  deferredMediaTracks.cancel();
  const requestedStartSeconds = normalizeResumeStartSeconds(startSeconds);
  clearLiveIframePlayback();
  const sourceWithStart = withRemuxResumeStart(nextSource, requestedStartSeconds, window.location.origin);
  const sourceWithAudioSync = withPreferredAudioSyncForRemuxSource(
    sourceWithStart,
    preferredAudioSyncMs,
  );
  const previousRequestedSource =
    lastRequestedPlaybackSource || lastRequestedAbsolutePlaybackSource;
  if (isLivePlayback && sourceWithAudioSync !== previousRequestedSource) {
    liveEdgePinned = true;
  }
  lastRequestedPlaybackSource = sourceWithAudioSync;
  lastPlaybackSourceSetAt = performance.now();
  resetAudioDecodeWatchState();

  clearStreamStallRecovery();
  clearLiveVisualHealthWatch({ resetSamples: true });
  clearLiveStartupHealthWatch({ resetRequest: true });
  clearSubtitleTrack();
  hlsPlaybackController.destroy();

  // Explicitly tear down the previous source to close the HTTP connection
  // and let the server kill the old ffmpeg process (kill_on_drop).
  if (video.src) {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }

  const transcodeMeta = parseTranscodeSource(sourceWithAudioSync);
  if (transcodeMeta) {
    activeTranscodeInput = transcodeMeta.input;
    transcodeBaseOffsetSeconds = transcodeMeta.startSeconds;
    activeAudioStreamIndex = transcodeMeta.audioStreamIndex;
    activeAudioSyncMs = transcodeMeta.audioSyncMs;
    if (isTmdbResolvedPlayback && transcodeMeta.sourceHash && transcodeMeta.sourceHash !== selectedSourceHash) {
      selectedSourceHash = transcodeMeta.sourceHash;
      persistSourceHashInUrl();
    }
  } else {
    activeTranscodeInput = "";
    transcodeBaseOffsetSeconds = 0;
    activeAudioStreamIndex = -1;
    activeAudioSyncMs = 0;
  }

  const hlsMeta = parseHlsMasterSource(sourceWithAudioSync);
  if (hlsMeta?.input) {
    activeTrackSourceInput = hlsMeta.input;
  }

  knownDurationSeconds = 0;
  if (resetInitialResume && hasInitialResumeTarget()) {
    resetInitialResumeApplication();
  }
  const absoluteSource = new URL(
    sourceWithAudioSync,
    window.location.origin,
  ).toString();
  lastRequestedAbsolutePlaybackSource = absoluteSource;
  if (playbackBenchmark) {
    playbackBenchmark._recordSourceChange(absoluteSource);
  }
  const isHlsSource = isHlsPlaybackSource(absoluteSource);

  if (isHlsSource) {
    const hlsMeta = parseHlsMasterSource(sourceWithAudioSync);
    const handleHlsPlaybackFailure = (message) => {
      hlsPlaybackController.destroy();
      const fallbackMessage =
        String(message || "").trim() || "HLS playback failed.";
      if (
        isCurrentTmdbExternalEmbedSource() &&
        !hasQueuedTmdbSourceFallback()
      ) {
        // Only demote (and drop the menu selection) once this source has no
        // mirror fallbacks left. While queued mirrors remain we stay on the same
        // source -- recovery hops to the next mirror and keeps its tick. Demoting
        // here lets recovery escalate to torrent resolution.
        demoteCurrentExternalEmbedSourceForRecovery(fallbackMessage);
      }
      if (isLivePlayback && liveStreamOptions.length > 1) {
        void attemptAutomaticLiveStreamFallback(
          "Live stream failed. Trying another source...",
        ).then((recovered) => {
          if (!recovered) {
            showResolverError(fallbackMessage, "Live stream failed.");
          }
        });
        return;
      }
      void handlePlaybackErrorRecovery(fallbackMessage).then((recovered) => {
        if (!recovered && isTmdbResolvedPlayback) {
          reportCurrentTmdbPlaybackFailure(fallbackMessage);
        }
      });
    };

    hlsPlaybackController.play({
      absoluteSource,
      hlsMeta,
      requestedStartSeconds,
      preferredAudioSyncMs,
      autoplay,
      handleHlsPlaybackFailure,
    });
    startLiveVisualHealthWatch();
    armLiveStartupHealthWatch();
    return;
  }

  pendingRecoverySeekSeconds = resolvePendingDirectSeekSeconds(requestedStartSeconds, pendingRecoverySeekSeconds);
  video.setAttribute("src", absoluteSource);
  video.load();
  scheduleStreamStallRecovery();
  startLiveVisualHealthWatch();
  armLiveStartupHealthWatch();
}

function getActiveSubtitleVttUrl() {
  if (selectedSubtitleStreamIndex < 0) {
    return "";
  }
  const selectedTrack = availableSubtitleTracks.find(
    (track) => Number(track?.streamIndex) === selectedSubtitleStreamIndex,
  );
  return String(selectedTrack?.vttUrl || "").trim();
}

function setTmdbSourceQueue(primaryUrl, fallbackUrls = []) {
  const queue = [
    primaryUrl,
    ...(Array.isArray(fallbackUrls) ? fallbackUrls : []),
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);

  tmdbSourceQueue = queue;
  tmdbSourceAttemptIndex = queue.length > 0 ? 1 : 0;
}

function getManualSourceSwitchRestoreSource() {
  return (
    String(lastRequestedPlaybackSource || "").trim() ||
    String(lastRequestedAbsolutePlaybackSource || "").trim() ||
    String(video?.getAttribute?.("src") || "").trim() ||
    String(video?.currentSrc || "").trim()
  );
}

function captureManualSourceSwitchBaseline({
  resumeSeconds = 0,
  wasPaused = true,
} = {}) {
  return {
    restorePlaybackSource: getManualSourceSwitchRestoreSource(),
    restoreResumeSeconds: Math.max(0, Number(resumeSeconds) || 0),
    restoreWasPaused: Boolean(wasPaused),
    selectedSourceHash,
    sourceSelectionPinned,
    preferredResolverProvider,
    currentTmdbPlaybackSessionKey,
    currentTmdbResolverProvider,
    currentTmdbResolvedFilename,
    currentTmdbSelectedFile,
    activeTrackSourceInput,
    activeTranscodeInput,
    transcodeBaseOffsetSeconds,
    activeAudioStreamIndex,
    activeAudioSyncMs,
    selectedAudioStreamIndex,
    selectedSubtitleStreamIndex,
    availableAudioTracks: [...availableAudioTracks],
    availableSubtitleTracks: [...availableSubtitleTracks],
    resolvedTrackPreferenceAudio,
    preferredAudioLang,
    preferredSubtitleLang,
    expectedDurationSeconds,
    knownDurationSeconds,
    tmdbSkipExternalEmbed,
    tmdbSourceQueue: [...tmdbSourceQueue],
    tmdbSourceAttemptIndex,
    availablePlaybackSourceHashes: new Set(
      availablePlaybackSources
        .map((source) => normalizeSourceHash(source?.sourceHash))
        .filter(Boolean),
    ),
    hasUpgradedToLocalCache: localCacheUpgradeWatch.hasUpgraded(),
    localCacheUpgradeWatchWasActive: isLocalCacheUpgradeWatchActive(),
  };
}

function captureManualSourceSwitchProgress() {
  let bufferedEnd = 0;
  const buffered = video?.buffered;
  if (buffered && buffered.length > 0) {
    try {
      bufferedEnd = buffered.end(buffered.length - 1);
    } catch {
      // buffered ranges can throw if queried mid-update; treat as no data.
    }
  }
  return {
    readyState: Number(video?.readyState || 0),
    bufferedEnd: Number.isFinite(bufferedEnd) ? bufferedEnd : 0,
    currentTime: Number(video?.currentTime || 0),
  };
}

function commitManualSourceSwitchPlayback(commitData) {
  persistSourceHashInUrl();
  persistAudioLangPreference(preferredAudioLang);
  persistSubtitleLangPreference(preferredSubtitleLang);
  if (commitData?.persistSubtitleStreamPreference) {
    persistSubtitleStreamPreference(selectedSubtitleStreamIndex);
  }
  if (resumeTime > 1) {
    persistContinueWatchingEntry(resumeTime);
    syncContinueWatchingEntryToServer(resumeTime);
  }
  if (commitData?.resolved) {
    void queueGallerySaveIfRequested(commitData.resolved);
    startLocalCacheUpgradeWatch(commitData.resolved);
  }
}

async function rollbackManualSourceSwitchPlayback(
  restoreState,
  { reason = "", request = null } = {},
) {
  if (!restoreState) {
    return false;
  }

  await requestResolveJson.cancelActive();
  const rollbackPlaybackRequestToken = ++tmdbPlaybackRequestToken;
  stopLocalCacheUpgradeWatch();
  const activePlaybackSource = getManualSourceSwitchRestoreSource();

  selectedSourceHash = restoreState.selectedSourceHash;
  sourceSelectionPinned = restoreState.sourceSelectionPinned;
  if (restoreState.preferredResolverProvider) {
    preferredResolverProvider = restoreState.preferredResolverProvider;
  }
  currentTmdbPlaybackSessionKey = restoreState.currentTmdbPlaybackSessionKey;
  currentTmdbResolverProvider = restoreState.currentTmdbResolverProvider;
  currentTmdbResolvedFilename = restoreState.currentTmdbResolvedFilename;
  currentTmdbSelectedFile = restoreState.currentTmdbSelectedFile;
  activeTrackSourceInput = restoreState.activeTrackSourceInput;
  activeTranscodeInput = restoreState.activeTranscodeInput;
  transcodeBaseOffsetSeconds = restoreState.transcodeBaseOffsetSeconds;
  activeAudioStreamIndex = restoreState.activeAudioStreamIndex;
  activeAudioSyncMs = restoreState.activeAudioSyncMs;
  selectedAudioStreamIndex = restoreState.selectedAudioStreamIndex;
  selectedSubtitleStreamIndex = restoreState.selectedSubtitleStreamIndex;
  availableAudioTracks = [...restoreState.availableAudioTracks];
  availableSubtitleTracks = [...restoreState.availableSubtitleTracks];
  resolvedTrackPreferenceAudio = restoreState.resolvedTrackPreferenceAudio;
  preferredAudioLang = restoreState.preferredAudioLang;
  preferredSubtitleLang = restoreState.preferredSubtitleLang;
  expectedDurationSeconds = restoreState.expectedDurationSeconds;
  knownDurationSeconds = restoreState.knownDurationSeconds;
  tmdbSkipExternalEmbed = restoreState.tmdbSkipExternalEmbed;
  tmdbSourceQueue = [...restoreState.tmdbSourceQueue];
  tmdbSourceAttemptIndex = restoreState.tmdbSourceAttemptIndex;

  const targetSourceHash = normalizeSourceHash(request?.targetSourceHash);
  if (
    targetSourceHash &&
    !restoreState.availablePlaybackSourceHashes.has(targetSourceHash)
  ) {
    availablePlaybackSources = availablePlaybackSources.filter(
      (source) => normalizeSourceHash(source?.sourceHash) !== targetSourceHash,
    );
    renderSourceOptionButtons();
  }

  applyPreferredSourceAudioSync(selectedSourceHash);
  persistSourceHashInUrl();
  rebuildTrackOptionButtons();
  syncAudioState();
  setPendingSourceSwitchHash("");
  syncSourceSelectionState();
  renderSelectedSourceDetails();
  hideSeekLoadingIndicator();
  hideResolver();

  const restoreSource = String(restoreState.restorePlaybackSource || "").trim();
  if (restoreSource && activePlaybackSource !== restoreSource) {
    setVideoSource(restoreSource, {
      startSeconds: restoreState.restoreResumeSeconds,
      resetInitialResume: false,
      autoplay: !restoreState.restoreWasPaused,
    });
    applySubtitleTrackByStreamIndex(selectedSubtitleStreamIndex);
    if (restoreState.restoreWasPaused) {
      video.pause();
    } else {
      await tryPlay();
      if (
        !manualSourceSwitch.isCurrent(request) ||
        tmdbPlaybackRequestToken !== rollbackPlaybackRequestToken
      ) {
        return false;
      }
    }
    if (
      restoreState.restoreResumeSeconds > 1 &&
      !isTranscodeSourceActive()
    ) {
      seekToAbsoluteTime(restoreState.restoreResumeSeconds);
    }
    knownDurationSeconds = restoreState.knownDurationSeconds;
  }
  expectedDurationSeconds = restoreState.expectedDurationSeconds;
  syncDurationText();

  localCacheUpgradeWatch.setHasUpgraded(restoreState.hasUpgradedToLocalCache);
  if (restoreState.localCacheUpgradeWatchWasActive) {
    startLocalCacheUpgradeWatch({
      playableUrl: restoreSource,
      resolverProvider: restoreState.currentTmdbResolverProvider,
    });
  }

  console.warn(
    "Source switch failed; restored previous stream.",
    String(reason || "").trim(),
  );
  return true;
}

const manualSourceSwitch = createManualSourceSwitchController({
  normalizeSourceHash,
  captureProgress: captureManualSourceSwitchProgress,
  getActivePlaybackSource: () =>
    String(video?.currentSrc || "").trim(),
  commit: commitManualSourceSwitchPlayback,
  rollback: rollbackManualSourceSwitchPlayback,
  markFailed: (sourceHash) => resolverFailedSourceHashes.add(sourceHash),
  logger: console,
  setTimeoutFn: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeoutFn: (timeoutId) => window.clearTimeout(timeoutId),
});

function noteManualSourceSwitchProgress() {
  manualSourceSwitch.noteProgress();
}

function isManualSourceSwitchPending() {
  return manualSourceSwitch.isPending();
}

function markManualSourceSwitchPlaybackRequested(sourceHash = "") {
  const request = manualSourceSwitch.getPending();
  if (!request) {
    return false;
  }
  return manualSourceSwitch.recordPlaybackRequested(request, {
    sourceHash,
    playbackSource: lastRequestedPlaybackSource,
    absolutePlaybackSource: lastRequestedAbsolutePlaybackSource,
  });
}

function completeManualSourceSwitchIfActive(activePlaybackSource = "") {
  const completed = manualSourceSwitch.completeIfActive(undefined, {
    activePlaybackSource,
  });
  if (completed) {
    setPendingSourceSwitchHash("");
    syncSourceSelectionState();
    closeSourcePopover(false, { force: true });
  }
  return completed;
}

function failPendingManualSourceSwitch(message) {
  const request = manualSourceSwitch.getPending();
  return request
    ? manualSourceSwitch.fail(request, message)
    : Promise.resolve(false);
}

function reportCurrentTmdbPlaybackFailure(
  message,
  eventType = "playback_error",
  { includeSourceHash = true, dedupe = true } = {},
) {
  const sourceHash = normalizeSourceHash(selectedSourceHash);
  if (
    !isTmdbResolvedPlayback ||
    !tmdbId ||
    (includeSourceHash && !sourceHash) ||
    (!includeSourceHash && !currentTmdbPlaybackSessionKey)
  ) {
    return Promise.resolve(false);
  }
  const failureKey = [
    tmdbId,
    includeSourceHash ? sourceHash : currentTmdbPlaybackSessionKey,
    eventType,
    includeSourceHash ? "source" : "session",
  ].join(":");
  if (dedupe && reportedPlaybackFailureKeys.has(failureKey)) {
    return Promise.resolve(false);
  }
  if (dedupe) {
    reportedPlaybackFailureKeys.add(failureKey);
  }
  const payload = {
    tmdbId,
    mediaType: isTmdbTvPlayback ? "tv" : "movie",
    sessionKey: currentTmdbPlaybackSessionKey,
    audioLang: preferredAudioLang || "auto",
    quality: preferredQuality || DEFAULT_STREAM_QUALITY_PREFERENCE,
    positionSeconds: Math.max(0, getEffectiveCurrentTime()),
    healthState: "invalid",
    eventType,
    lastError: String(message || "Playback failed.").slice(0, 500),
  };
  if (includeSourceHash) {
    payload.sourceHash = sourceHash;
  }
  return fetch("/api/session/progress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  })
    .then((response) => response.ok)
    .catch(() => false);
}

function isCurrentTmdbExternalEmbedSource() {
  if (!isTmdbResolvedPlayback) {
    return false;
  }
  if (currentTmdbResolverProvider === "external-embed") {
    return true;
  }
  const selectedOption = getSourceOptionByHash(selectedSourceHash);
  return Boolean(selectedOption && isSourceOptionEmbed(selectedOption));
}

function demoteCurrentExternalEmbedSourceForRecovery(message = "") {
  if (!isCurrentTmdbExternalEmbedSource()) {
    return false;
  }

  const failedSourceHash = normalizeSourceHash(selectedSourceHash);
  if (failedSourceHash) {
    resolverFailedSourceHashes.add(failedSourceHash);
    void reportCurrentTmdbPlaybackFailure(
      message || "External HLS playback failed.",
      "playback_error",
      { includeSourceHash: true, dedupe: false },
    );
  }

  selectedSourceHash = "";
  sourceSelectionPinned = false;
  currentTmdbPlaybackSessionKey = "";
  currentTmdbResolverProvider = "";
  currentTmdbResolvedFilename = "";
  currentTmdbSelectedFile = "";
  activeTrackSourceInput = "";
  tmdbSkipExternalEmbed = true;
  applyPreferredSourceAudioSync(selectedSourceHash);
  persistSourceHashInUrl();
  syncSourceSelectionState();
  return true;
}

async function tryNextTmdbSource() {
  if (
    !isTmdbResolvedPlayback ||
    tmdbSourceAttemptIndex >= tmdbSourceQueue.length
  ) {
    return false;
  }

  const nextSource = tmdbSourceQueue[tmdbSourceAttemptIndex];
  tmdbSourceAttemptIndex += 1;
  const resumeAt = Math.max(0, Math.floor(getEffectiveCurrentTime()));
  showResolver("Switching source...");
  setVideoSource(nextSource, {
    startSeconds: resumeAt,
    resetInitialResume: false,
  });
  await tryPlay();
  return true;
}

function applyStoredSubtitleSelectionPreference() {
  if (hasSubtitleLangParam) {
    return;
  }

  if (!(isTmdbMoviePlayback || isTmdbTvPlayback || isExplicitLocalUploadSource)) {
    return;
  }

  const storedSubtitleStreamPreference =
    getStoredSubtitleStreamPreferenceForCurrentPlayback();

  if (storedSubtitleStreamPreference.mode === "off") {
    selectedSubtitleStreamIndex = -1;
    preferredSubtitleLang = "off";
    return;
  }

  if (storedSubtitleStreamPreference.mode !== "on") {
    return;
  }

  const exactTrack = availableSubtitleTracks.find(
    (track) =>
      Number(track?.streamIndex) ===
        storedSubtitleStreamPreference.streamIndex &&
      isPlayableSubtitleTrack(track),
  );
  if (shouldPreferResolvedTranslatedSubtitleTrack(exactTrack, getSubtitleTrackByStreamIndex(selectedSubtitleStreamIndex))) return;
  if (exactTrack) {
    selectedSubtitleStreamIndex = Number(exactTrack.streamIndex);
    const exactLanguage = normalizeSubtitlePreference(
      exactTrack.language || preferredSubtitleLang,
    );
    if (exactLanguage) {
      preferredSubtitleLang = exactLanguage;
    }
    return;
  }

  const playableSubtitleTracks = availableSubtitleTracks.filter((track) =>
    isPlayableSubtitleTrack(track),
  );
  const preferredLanguage = normalizeSubtitlePreference(preferredSubtitleLang);
  const fallbackTrack =
    playableSubtitleTracks.find(
      (track) =>
        preferredLanguage &&
        preferredLanguage !== "off" &&
        normalizeSubtitlePreference(track?.language || "") ===
          preferredLanguage,
    ) ||
    playableSubtitleTracks.find(
      (track) => !isLikelyForcedSubtitleTrack(track),
    ) ||
    playableSubtitleTracks[0] ||
    null;
  if (!fallbackTrack) {
    selectedSubtitleStreamIndex = -1;
    return;
  }

  const fallbackStreamIndex = Number(fallbackTrack.streamIndex);
  if (Number.isInteger(fallbackStreamIndex) && fallbackStreamIndex >= 0) {
    selectedSubtitleStreamIndex = fallbackStreamIndex;
  }
  const fallbackLanguage = normalizeSubtitlePreference(
    fallbackTrack.language || preferredLanguage,
  );
  if (fallbackLanguage) {
    preferredSubtitleLang = fallbackLanguage;
  }
}

async function applyResolvedTmdbPlayback(
  resolved,
  {
    resolvedSourceHash = "",
    startSeconds = 0,
    playbackRequestToken = 0,
    manualSourceSwitchRequest = null,
    autoplay = true,
  } = {},
) {
  if (
    playbackRequestToken &&
    playbackRequestToken !== tmdbPlaybackRequestToken
  ) {
    return { nativeLaunched: false, resolved, stale: true };
  }

  const normalizedResolvedSourceHash = normalizeSourceHash(
    resolvedSourceHash || resolved?.sourceHash || selectedSourceHash,
  );
  const previousSelectedSourceHash = normalizeSourceHash(selectedSourceHash);
  const isProvisionalManualSourceSwitch = Boolean(
    manualSourceSwitchRequest &&
      manualSourceSwitch.isCurrent(manualSourceSwitchRequest),
  );
  currentTmdbPlaybackSessionKey = String(resolved?.session?.key || "").trim();
  currentTmdbResolverProvider = String(
    resolved?.resolverProvider ||
      resolved?.session?.resolverProvider ||
      resolved?.metadata?.resolverProvider ||
      "",
  ).trim();
  if (currentTmdbResolverProvider !== "external-embed") {
    tmdbSkipExternalEmbed = false;
    tmdbResolveRetries = 0;
  }
  currentTmdbResolvedFilename = String(resolved?.filename || "").trim();
  currentTmdbSelectedFile = String(resolved?.selectedFile || "").trim();
  activeTrackSourceInput = String(resolved?.sourceInput || "").trim();
  availableAudioTracks = Array.isArray(resolved?.tracks?.audioTracks)
    ? resolved.tracks.audioTracks
    : [];
  availableSubtitleTracks = Array.isArray(resolved?.tracks?.subtitleTracks)
    ? resolved.tracks.subtitleTracks
    : [];
  selectedAudioStreamIndex = Number.isFinite(
    Number(resolved?.selectedAudioStreamIndex),
  )
    ? Number(resolved.selectedAudioStreamIndex)
    : -1;
  selectedSubtitleStreamIndex = Number.isFinite(
    Number(resolved?.selectedSubtitleStreamIndex),
  )
    ? Number(resolved.selectedSubtitleStreamIndex)
    : -1;
  resolvedTrackPreferenceAudio = String(
    resolved?.preferences?.audioLang || preferredAudioLang || "auto",
  )
    .trim()
    .toLowerCase();
  preferredSubtitleLang = String(
    resolved?.preferences?.subtitleLang || preferredSubtitleLang || "",
  ).trim();
  preferredSubtitleLang = normalizeSubtitlePreference(preferredSubtitleLang);
  selectedSourceHash = normalizedResolvedSourceHash;
  applyPreferredSourceAudioSync(selectedSourceHash);
  if (!isProvisionalManualSourceSwitch) {
    persistSourceHashInUrl();
    if (resumeTime > 1) {
      persistContinueWatchingEntry(resumeTime);
      syncContinueWatchingEntryToServer(resumeTime);
    }
  }

  if (resolvedTrackPreferenceAudio && resolvedTrackPreferenceAudio !== "auto") {
    preferredAudioLang = resolvedTrackPreferenceAudio;
    if (!isProvisionalManualSourceSwitch) {
      persistAudioLangPreference(preferredAudioLang);
    }
  }
  const subtitleStreamPreferenceBeforeResolve =
    getStoredSubtitleStreamPreferenceForCurrentPlayback();
  applyStoredSubtitleSelectionPreference();
  const shouldPersistSubtitleStreamPreference = Boolean(
    subtitleStreamPreferenceBeforeResolve.mode !== "unset" ||
    selectedSubtitleStreamIndex >= 0 ||
    preferredSubtitleLang === "off",
  );
  if (!isProvisionalManualSourceSwitch) {
    persistSubtitleLangPreference(preferredSubtitleLang);
    if (shouldPersistSubtitleStreamPreference) {
      persistSubtitleStreamPreference(selectedSubtitleStreamIndex);
    }
  }

  rebuildTrackOptionButtons();
  const addedResolvedSourceOption = Boolean(
    !availablePlaybackSources.some(
      (option) => option.sourceHash === selectedSourceHash,
    ) &&
      selectedSourceHash,
  );
  if (addedResolvedSourceOption) {
    availablePlaybackSources = [
      {
        sourceHash: selectedSourceHash,
        primary: String(resolved?.filename || "Current source"),
        filename: String(resolved?.filename || ""),
        provider: "Current",
        qualityLabel: "",
        container: "",
        seeders: 0,
        size: "",
        releaseGroup: "",
      },
      ...availablePlaybackSources,
    ];
  }
  const shouldFollowResolvedSource = Boolean(
    !isProvisionalManualSourceSwitch &&
      previousSelectedSourceHash !== selectedSourceHash &&
      !sourceControl?.classList.contains("is-open"),
  );
  if (shouldFollowResolvedSource) {
    activeSourceTypeTab = "";
  }
  if (shouldFollowResolvedSource || addedResolvedSourceOption) {
    renderSourceOptionButtons();
  } else {
    syncSourceSelectionState();
    renderSelectedSourceDetails();
  }
  const nativePreferredSource = String(resolved?.playableUrl || "").trim();
  const preferredBrowserSource = buildPreferredBrowserPlaybackSource(
    nativePreferredSource,
    activeTrackSourceInput,
    selectedAudioStreamIndex,
    selectedSubtitleStreamIndex,
  );
  const shouldSkipRemuxFallback =
    preferredBrowserSource &&
    preferredBrowserSource !== nativePreferredSource &&
    shouldAvoidRemuxFallbackForHls();
  const normalizeRemuxFallback = buildResolvedRemuxVariantSource({
    ...resolved,
    playableUrl: preferredBrowserSource,
    fallbackUrls: [nativePreferredSource, ...(resolved?.fallbackUrls || [])],
  }, {
    sourceHash: normalizedResolvedSourceHash,
    audioSyncMs: preferredAudioSyncMs,
    remuxVideoMode: "normalize",
    parseTranscodeSource,
    buildSoftwareDecodeUrl,
  });
  const resolvedFallbackUrls = buildOrderedRemuxFallbacks({
    normalizeSource: normalizeRemuxFallback,
    nativePreferredSource,
    fallbackUrls: resolved?.fallbackUrls,
    skipRemuxFallback: shouldSkipRemuxFallback,
    parseTranscodeSource,
  });
  setTmdbSourceQueue(preferredBrowserSource, resolvedFallbackUrls);
  if (isProvisionalManualSourceSwitch) {
    manualSourceSwitch.setCommitData(manualSourceSwitchRequest, {
      persistSubtitleStreamPreference: shouldPersistSubtitleStreamPreference,
      resolved,
    });
  } else {
    void queueGallerySaveIfRequested(resolved);
  }
  const preferredSource =
    tmdbSourceQueue[0] || preferredBrowserSource || nativePreferredSource;
  const explicitStartSeconds = normalizeResumeStartSeconds(startSeconds);
  setVideoSource(preferredSource, {
    startSeconds: explicitStartSeconds || getInitialPlaybackStartSeconds(),
    resetInitialResume: explicitStartSeconds <= 0,
    autoplay,
  });
  markManualSourceSwitchPlaybackRequested(normalizedResolvedSourceHash);
  applySubtitleTrackByStreamIndex(selectedSubtitleStreamIndex);
  syncAudioState();
  hideResolver();
  const runtimeSeconds = Number(resolved.metadata?.runtimeSeconds || 0);
  expectedDurationSeconds =
    Number.isFinite(runtimeSeconds) && runtimeSeconds > 0 ? runtimeSeconds : 0;
  syncDurationText();

  if (isTmdbTvPlayback && resolved.metadata?.displayTitle) {
    const resolvedEpisodeNumber = Number(
      resolved?.metadata?.episodeNumber || episodeNumber,
    );
    const safeEpisodeNumber =
      Number.isFinite(resolvedEpisodeNumber) && resolvedEpisodeNumber > 0
        ? Math.floor(resolvedEpisodeNumber)
        : episodeNumber;
    const resolvedEpisodeTitle = String(
      resolved?.metadata?.episodeTitle || activeSeriesEpisode?.title || "",
    ).trim();
    setEpisodeLabel(
      resolved.metadata.displayTitle,
      getSeriesEpisodeLabel(
        Math.max(0, safeEpisodeNumber - 1),
        resolvedEpisodeTitle,
        activeSeries,
        safeEpisodeNumber,
      ),
    );
  } else if (resolved.metadata?.displayTitle) {
    const releaseYear = String(resolved.metadata.displayYear || "").trim();
    setEpisodeLabel(
      resolved.metadata.displayTitle,
      releaseYear ? `(${releaseYear})` : "",
    );
  }

  scheduleDeferredMediaTrackEnrichment(resolved);

  if (autoplay) {
    await tryPlay();
  }
  if (
    playbackRequestToken &&
    playbackRequestToken !== tmdbPlaybackRequestToken
  ) {
    return { nativeLaunched: false, resolved, stale: true };
  }
  if (!isProvisionalManualSourceSwitch) {
    startLocalCacheUpgradeWatch(resolved);
  }
  return { nativeLaunched: false, resolved };
}

async function resolveTmdbSourcesAndPlay({
  allowContainerFallback = true,
  allowSourceFallback = true,
  applyPlayback = true,
  playbackRequestToken = 0,
  requiredSourceHash = "",
  requestSourceHash = "",
  resolveTimeoutMs = undefined,
  skipExternalEmbed = tmdbSkipExternalEmbed,
  refreshResolve = false,
  startSeconds = 0,
} = {}) {
  const activePlaybackRequestToken = applyPlayback
    ? playbackRequestToken || ++tmdbPlaybackRequestToken
    : playbackRequestToken;
  if (applyPlayback) {
    stopLocalCacheUpgradeWatch();
    localCacheUpgradeWatch.setHasUpgraded(false);
  }
  if (isTmdbResolvedPlayback) {
    await loadUserRealDebridPlaybackSettings();
    const clearedDisabledTorrentState = clearDisabledTorrentPlaybackState();
    if (clearedDisabledTorrentState || !shouldAllowTorrentResolveFallback()) {
      skipExternalEmbed = false;
    }
  }
  if (!skipExternalEmbed) {
    tmdbSkipExternalEmbed = false;
  }
  preferredResolverProvider = resolveTorrentRequestProvider({
    currentProvider: preferredResolverProvider,
    skipExternalEmbed,
    realDebridActive: isUserRealDebridPlaybackEnabled(),
    localTorrentEnabled: userLocalTorrentEnabled,
  });
  if (!availablePlaybackSources.length) {
    void fetchTmdbSourceOptionsViaBackend();
  }

  const normalizedRequiredSourceHash = normalizeSourceHash(requiredSourceHash);
  const normalizedRequestSourceHash = normalizeSourceHash(requestSourceHash);
  let effectiveResolveTimeoutMs = resolveTimeoutMs;
  if (
    !Number.isFinite(Number(effectiveResolveTimeoutMs)) &&
    (skipExternalEmbed ||
      preferredResolverProvider === "local-torrent" ||
      preferredResolverProvider === "real-debrid")
  ) {
    effectiveResolveTimeoutMs = getTmdbTorrentResolveTimeoutMs();
  }
  const resolveAttempt = await runResolveWithSupersession({
    resolve: () =>
      isTmdbTvPlayback
        ? resolveTmdbTvEpisodeViaBackend(
            tmdbId,
            seasonNumber,
            episodeNumber,
            {
              allowContainerFallback,
              allowSourceFallback,
              requestSourceHash: normalizedRequestSourceHash,
              resolveTimeoutMs: effectiveResolveTimeoutMs,
              skipExternalEmbed,
              refreshResolve,
            },
          )
        : resolveTmdbMovieViaBackend(tmdbId, {
            allowSourceFallback,
            requestSourceHash: normalizedRequestSourceHash,
            resolveTimeoutMs: effectiveResolveTimeoutMs,
            skipExternalEmbed,
            refreshResolve,
          }),
    isSuperseded: () =>
      applyPlayback &&
      (activePlaybackRequestToken !== tmdbPlaybackRequestToken ||
        isManualSourceSwitchPending()),
  });
  if (resolveAttempt.stale) {
    return {
      nativeLaunched: false,
      resolved: null,
      resolvedSourceHash: "",
      stale: true,
    };
  }
  const resolved = resolveAttempt.value;
  const resolvedSourceHash = normalizeSourceHash(
    resolved?.sourceHash || normalizedRequestSourceHash || selectedSourceHash,
  );
  if (
    normalizedRequiredSourceHash &&
    resolvedSourceHash !== normalizedRequiredSourceHash
  ) {
    throw new Error(
      "Selected source is unavailable right now. Try another source.",
    );
  }
  if (!applyPlayback) {
    return { nativeLaunched: false, resolved, resolvedSourceHash };
  }
  if (activePlaybackRequestToken !== tmdbPlaybackRequestToken) {
    return {
      nativeLaunched: false,
      resolved,
      resolvedSourceHash,
      stale: true,
    };
  }
  return applyResolvedTmdbPlayback(resolved, {
    resolvedSourceHash,
    startSeconds,
    playbackRequestToken: activePlaybackRequestToken,
  });
}

// A single source can expose several mirror URLs (e.g. LordFlix's Phoenix/Rio/
// Ativa servers) under one menu entry; `tmdbSourceQueue` holds them in priority
// order. While unused mirrors remain, recovery is an in-source hop, not a switch
// to a different source.
function hasQueuedTmdbSourceFallback() {
  return (
    isTmdbResolvedPlayback && tmdbSourceAttemptIndex < tmdbSourceQueue.length
  );
}

function attemptTmdbRecovery(message, { failureMessage = "" } = {}) {
  if (
    !isTmdbResolvedPlayback ||
    isRecoveringTmdbStream ||
    isManualSourceSwitchPending()
  ) {
    return false;
  }

  const resumeAt = Math.max(0, Math.floor(getEffectiveCurrentTime()));
  stopLocalCacheUpgradeWatch();
  isRecoveringTmdbStream = true;
  showResolver(message || "Switching source...");

  // Hopping between mirrors of the current source is not leaving it, so keep the
  // selected source hash (and its menu tick) and just advance the queue. Only
  // demote/clear the selection when no mirrors remain and we fall through to
  // re-resolving a different source.
  if (hasQueuedTmdbSourceFallback()) {
    void tryNextTmdbSource().finally(() => {
      isRecoveringTmdbStream = false;
    });
    return true;
  }

  demoteCurrentExternalEmbedSourceForRecovery(
    failureMessage || message || "External HLS playback failed.",
  );

  if (
    shouldAllowTorrentResolveFallback() &&
    tmdbResolveRetries < maxTmdbResolveRetries
  ) {
    tmdbResolveRetries += 1;
    tmdbSkipExternalEmbed = true;
    preferredResolverProvider = pickTorrentResolverProvider({
      currentProvider: preferredResolverProvider,
      realDebridActive: isUserRealDebridPlaybackEnabled(),
      localTorrentEnabled: userLocalTorrentEnabled,
    });
    showResolver(
      `Trying torrent fallback (${tmdbResolveRetries}/${maxTmdbResolveRetries})...`,
    );
    const invalidateCurrentSession = reportCurrentTmdbPlaybackFailure(
      failureMessage || message || "Playback failed.",
      "playback_error",
      { includeSourceHash: false, dedupe: false },
    );
    void invalidateCurrentSession
      .then(() =>
        // Force a fresh resolve on recovery so a stale/dead cached upstream URL is
        // evicted server-side rather than re-served.
        resolveTmdbSourcesAndPlay({
          startSeconds: resumeAt,
          refreshResolve: true,
          skipExternalEmbed: true,
          resolveTimeoutMs: getTmdbTorrentResolveTimeoutMs(),
        }),
      )
      .catch((error) => {
        console.error("Failed to refresh TMDB playback source:", error);
        const fallbackMessage =
          error?.message || "Resolved stream could not be played. Try again.";
        showResolverError(fallbackMessage);
      })
      .finally(() => {
        isRecoveringTmdbStream = false;
      });
    return true;
  }

  isRecoveringTmdbStream = false;
  return false;
}

function setEpisodeLabel(currentTitle, currentEpisode) {
  if (!episodeLabel) {
    return;
  }
  const formattedTitle = String(currentTitle || "").trim();
  const formattedEpisode = String(currentEpisode || "").trim();
  episodeLabel.textContent = "";

  if (!formattedTitle) {
    return;
  }

  const strong = document.createElement("b");
  strong.textContent = formattedTitle;
  episodeLabel.appendChild(strong);

  if (formattedEpisode) {
    const shouldUseHyphenSeparator =
      !/^e\d+\b/i.test(formattedEpisode) &&
      !/^[-–—]/.test(formattedEpisode);
    episodeLabel.append(
      shouldUseHyphenSeparator
        ? ` - ${formattedEpisode}`
        : ` ${formattedEpisode}`,
    );
  }
}

// shouldHideSeriesEpisodePrefix, normalizeCourseEpisodeDisplayTitle,
// getSeriesEpisodeLabel — imported from ./src-ui/player/episodes.js

function isEpisodeListPlayback() {
  return Boolean(
    activeSeries &&
      Array.isArray(seriesEpisodes) &&
      seriesEpisodes.length > 0 &&
      (isSeriesPlayback || isTmdbTvPlayback),
  );
}

function seriesRequiresLocalEpisodeSources(seriesEntry = activeSeries) {
  return Boolean(seriesEntry?.requiresLocalEpisodeSources);
}

function isSeriesEpisodePlayable(episodeEntry, seriesEntry = activeSeries) {
  if (!episodeEntry) {
    return false;
  }
  if (!seriesRequiresLocalEpisodeSources(seriesEntry)) {
    return true;
  }
  return Boolean(String(episodeEntry?.src || "").trim());
}

function getSeriesEpisodeSeasonNumber(episodeEntry) {
  const parsed = Number(episodeEntry?.seasonNumber || 1);
  if (!Number.isFinite(parsed)) {
    return 1;
  }
  return Math.max(1, Math.floor(parsed));
}

function getSeriesEpisodeOrdinalNumber(episodeEntry, index) {
  const parsed = Number(episodeEntry?.episodeNumber || index + 1);
  if (!Number.isFinite(parsed)) {
    return index + 1;
  }
  return Math.max(1, Math.floor(parsed));
}

function getSeriesSeasonLabel(seasonNumber, seriesEntry = activeSeries) {
  const seasonLabel =
    String(seriesEntry?.contentKind || "")
      .trim()
      .toLowerCase() === "course"
      ? "Module"
      : "Season";
  return `${seasonLabel} ${Math.max(1, Math.floor(Number(seasonNumber) || 1))}`;
}

function getSeriesSeasonGroups() {
  const groupsBySeason = new Map();
  const episodes = Array.isArray(seriesEpisodes) ? seriesEpisodes : [];
  episodes.forEach((episodeEntry, index) => {
    const season = getSeriesEpisodeSeasonNumber(episodeEntry);
    if (!groupsBySeason.has(season)) {
      groupsBySeason.set(season, {
        seasonNumber: season,
        firstEpisodeIndex: index,
        episodes: [],
      });
    }
    groupsBySeason.get(season).episodes.push({ episodeEntry, index });
  });
  return Array.from(groupsBySeason.values()).sort(
    (left, right) => left.seasonNumber - right.seasonNumber,
  );
}

function getActiveSeriesEpisodeSeasonNumber() {
  return getSeriesEpisodeSeasonNumber(
    activeSeriesEpisode || seriesEpisodes[seriesEpisodeIndex] || seriesEpisodes[0],
  );
}

function ensureSelectedEpisodesSeason(groups = getSeriesSeasonGroups()) {
  if (!groups.length) {
    selectedEpisodesSeasonNumber = 1;
    return selectedEpisodesSeasonNumber;
  }

  const hasSelectedSeason = groups.some(
    (group) => group.seasonNumber === selectedEpisodesSeasonNumber,
  );
  if (!hasSelectedSeason) {
    const activeSeasonNumber = getActiveSeriesEpisodeSeasonNumber();
    const activeGroup = groups.find(
      (group) => group.seasonNumber === activeSeasonNumber,
    );
    selectedEpisodesSeasonNumber =
      activeGroup?.seasonNumber || groups[0].seasonNumber;
  }
  return selectedEpisodesSeasonNumber;
}

function setEpisodesMenuHeader({ overline = "Episodes", title = "Episodes", showBack = false } = {}) {
  if (episodesOverline) {
    episodesOverline.textContent = overline;
  }
  if (episodesPopoverTitle) {
    episodesPopoverTitle.textContent = title;
  }
  if (episodesBackToSeasons) {
    episodesBackToSeasons.hidden = !showBack;
  }
}

function buildSeriesEpisodeIdentityKey(season, episode) {
  return `s${Math.max(1, Math.floor(Number(season) || 1))}e${Math.max(1, Math.floor(Number(episode) || 1))}`;
}

function isFallbackEpisodeThumbnail(thumbValue) {
  const normalized = String(thumbValue || "").trim();
  return !normalized || normalized === DEFAULT_EPISODE_THUMBNAIL;
}

function normalizeTmdbSeasonEpisode(entry = {}, fallbackSeasonNumber = 1, fallbackIndex = 0) {
  const parsedSeason = Number(entry?.seasonNumber || fallbackSeasonNumber || 1);
  const parsedEpisode = Number(entry?.episodeNumber || fallbackIndex + 1);
  const safeSeasonNumber =
    Number.isFinite(parsedSeason) && parsedSeason > 0
      ? Math.floor(parsedSeason)
      : 1;
  const safeEpisodeNumber =
    Number.isFinite(parsedEpisode) && parsedEpisode > 0
      ? Math.floor(parsedEpisode)
      : fallbackIndex + 1;
  const title =
    String(entry?.name || entry?.title || "").trim() ||
    `Episode ${safeEpisodeNumber}`;
  const thumb =
    String(entry?.stillUrl || entry?.thumb || "").trim() ||
    DEFAULT_EPISODE_THUMBNAIL;
  return {
    title,
    description: String(entry?.overview || "").trim(),
    thumb,
    src: "",
    contentKind: "series",
    seasonNumber: safeSeasonNumber,
    episodeNumber: safeEpisodeNumber,
    airDate: String(entry?.airDate || "").trim(),
    runtime: Number(entry?.runtime || 0) || 0,
  };
}

function getTmdbSeasonNumbersToFetch(details, currentSeasonNumber) {
  const currentSeason = Math.max(1, Math.floor(Number(currentSeasonNumber) || 1));
  const seasons = Array.isArray(details?.seasons)
    ? details.seasons
        .map((season) => ({
          seasonNumber: Math.max(
            0,
            Math.floor(Number(season?.season_number || 0)),
          ),
          episodeCount: Math.max(
            0,
            Math.floor(Number(season?.episode_count || 0)),
          ),
        }))
        .filter((season) => season.seasonNumber > 0 && season.episodeCount > 0)
        .sort((left, right) => left.seasonNumber - right.seasonNumber)
    : [];

  const seasonNumbers = seasons.length
    ? seasons.map((season) => season.seasonNumber)
    : [currentSeason];
  const withCurrentSeason = seasonNumbers.includes(currentSeason)
    ? seasonNumbers
    : [currentSeason, ...seasonNumbers];
  return [...new Set(withCurrentSeason)].slice(0, MAX_TMDB_EPISODE_LIST_SEASONS);
}

async function fetchTmdbSeasonEpisodes(tmdbSeriesId, season) {
  const query = new URLSearchParams({
    tmdbId: String(tmdbSeriesId || ""),
    seasonNumber: String(Math.max(1, Math.floor(Number(season) || 1))),
  });
  const payload = await requestJson(
    `/api/tmdb/tv/season?${query.toString()}`,
    {},
    25000,
  );
  const payloadSeason = Math.max(
    1,
    Math.floor(Number(payload?.seasonNumber || season || 1)),
  );
  return (Array.isArray(payload?.episodes) ? payload.episodes : [])
    .map((episodeEntry, index) =>
      normalizeTmdbSeasonEpisode(episodeEntry, payloadSeason, index),
    )
    .filter((episodeEntry) => episodeEntry.episodeNumber > 0);
}

async function hydrateTmdbTvEpisodeCatalog() {
  if (!isTmdbTvPlayback || isSeriesPlayback || !tmdbId) {
    return false;
  }

  const currentSeason = Math.max(1, Math.floor(Number(seasonNumber) || 1));
  const currentEpisode = Math.max(1, Math.floor(Number(episodeNumber) || 1));
  let details = null;
  try {
    const query = new URLSearchParams({ tmdbId, mediaType: "tv" });
    details = await requestJson(
      `/api/tmdb/details?${query.toString()}`,
      {},
      25000,
    );
  } catch {
    details = null;
  }

  const seasonNumbers = getTmdbSeasonNumbersToFetch(details, currentSeason);
  const seasonPayloads = await Promise.all(
    seasonNumbers.map((season) =>
      fetchTmdbSeasonEpisodes(tmdbId, season).catch(() => []),
    ),
  );
  const episodes = seasonPayloads
    .flat()
    .sort((left, right) => {
      const seasonDelta =
        Number(left?.seasonNumber || 1) - Number(right?.seasonNumber || 1);
      if (seasonDelta !== 0) {
        return seasonDelta;
      }
      return Number(left?.episodeNumber || 1) - Number(right?.episodeNumber || 1);
    })
    .slice(0, MAX_TMDB_EPISODE_LIST_EPISODES);

  if (!episodes.length) {
    return false;
  }

  const matchedIndex = episodes.findIndex(
    (episodeEntry) =>
      Number(episodeEntry?.seasonNumber || 1) === currentSeason &&
      Number(episodeEntry?.episodeNumber || 1) === currentEpisode,
  );
  const selectedIndex = matchedIndex >= 0 ? matchedIndex : 0;
  const selectedEpisode = episodes[selectedIndex] || episodes[0];
  const detailsTitle = String(details?.name || details?.title || "").trim();
  const detailsDate = String(
    details?.first_air_date || details?.release_date || "",
  ).trim();

  activeSeries = {
    id: `tmdb-tv-${tmdbId}`,
    title: detailsTitle || title || "Series",
    tmdbId,
    year: detailsDate ? detailsDate.slice(0, 4) : year,
    contentKind: "series",
    preferredContainer,
    requiresLocalEpisodeSources: false,
    episodes,
  };
  seriesEpisodes = episodes;
  seriesEpisodeIndex = selectedIndex;
  activeSeriesEpisode = selectedEpisode;
  title = activeSeries.title;
  rawTitle = title;
  seasonNumber = Math.max(
    1,
    Math.floor(Number(selectedEpisode?.seasonNumber || currentSeason)),
  );
  episodeNumber = Math.max(
    1,
    Math.floor(Number(selectedEpisode?.episodeNumber || currentEpisode)),
  );
  episode = getSeriesEpisodeLabel(
    selectedIndex,
    selectedEpisode?.title || "",
    activeSeries,
    episodeNumber,
  );
  rawEpisode = episode;
  year = activeSeries.year || year;
  hasHydratedSeriesEpisodeThumbs = true;
  return true;
}

async function fetchSeriesEpisodeStillMap() {
  const seriesTmdbId = String(activeSeries?.tmdbId || "").trim();
  if (!seriesTmdbId || !seriesEpisodes.length) {
    return new Map();
  }

  const uniqueSeasons = [
    ...new Set(
      seriesEpisodes.map((episodeEntry) =>
        getSeriesEpisodeSeasonNumber(episodeEntry),
      ),
    ),
  ];
  if (!uniqueSeasons.length) {
    return new Map();
  }

  const seasonPayloads = await Promise.all(
    uniqueSeasons.map(async (season) => {
      const query = new URLSearchParams({
        tmdbId: seriesTmdbId,
        seasonNumber: String(season),
      });
      try {
        return await requestJson(
          `/api/tmdb/tv/season?${query.toString()}`,
          {},
          25000,
        );
      } catch {
        return null;
      }
    }),
  );

  const stillMap = new Map();
  seasonPayloads.forEach((payload) => {
    const imageBase = String(payload?.imageBase || "").trim();
    const episodes = Array.isArray(payload?.episodes) ? payload.episodes : [];
    episodes.forEach((episode) => {
      const season = Math.max(
        1,
        Math.floor(Number(episode?.seasonNumber || payload?.seasonNumber || 1)),
      );
      const episodeNumber = Math.max(
        1,
        Math.floor(Number(episode?.episodeNumber || 0)),
      );
      if (!episodeNumber) {
        return;
      }
      const stillPath = String(episode?.stillPath || "").trim();
      const stillUrl =
        String(episode?.stillUrl || "").trim() ||
        (stillPath && imageBase ? `${imageBase}/w780${stillPath}` : "");
      if (!stillUrl) {
        return;
      }
      stillMap.set(
        buildSeriesEpisodeIdentityKey(season, episodeNumber),
        stillUrl,
      );
    });
  });

  return stillMap;
}

async function hydrateSeriesEpisodeThumbnails() {
  if (!isEpisodeListPlayback()) {
    return;
  }
  if (hasHydratedSeriesEpisodeThumbs) {
    return;
  }
  if (seriesEpisodeThumbHydrationTask) {
    return;
  }

  seriesEpisodeThumbHydrationTask = (async () => {
    const stillMap = await fetchSeriesEpisodeStillMap();
    if (!stillMap.size) {
      return;
    }

    let hasChanges = false;
    seriesEpisodes.forEach((episodeEntry, index) => {
      if (!episodeEntry || !isFallbackEpisodeThumbnail(episodeEntry.thumb)) {
        return;
      }

      const season = getSeriesEpisodeSeasonNumber(episodeEntry);
      const episodeNumber = getSeriesEpisodeOrdinalNumber(episodeEntry, index);
      const stillUrl = stillMap.get(
        buildSeriesEpisodeIdentityKey(season, episodeNumber),
      );
      if (!stillUrl || stillUrl === episodeEntry.thumb) {
        return;
      }

      episodeEntry.thumb = stillUrl;
      hasChanges = true;
    });

    if (hasChanges) {
      renderSeriesEpisodePreview();
    }
  })()
    .catch(() => {
      // Ignore thumbnail hydration failures and keep static fallbacks.
    })
    .finally(() => {
      hasHydratedSeriesEpisodeThumbs = true;
      seriesEpisodeThumbHydrationTask = null;
    });
}

function navigateToSeriesEpisode(nextIndex) {
  if (!isEpisodeListPlayback()) {
    return;
  }

  const parsedIndex = Number(nextIndex);
  if (!Number.isFinite(parsedIndex)) {
    return;
  }

  const safeIndex = Math.max(
    0,
    Math.min(seriesEpisodes.length - 1, Math.floor(parsedIndex)),
  );
  if (safeIndex === seriesEpisodeIndex) {
    closeEpisodesPopover();
    return;
  }

  const targetEpisode = seriesEpisodes[safeIndex];
  if (!targetEpisode) {
    return;
  }
  if (!isSeriesEpisodePlayable(targetEpisode)) {
    showResolver("This episode is unavailable until its MP4 source is added.", {
      showStatus: true,
      isError: true,
    });
    window.clearTimeout(unavailableEpisodeResolverHideTimeout);
    unavailableEpisodeResolverHideTimeout = window.setTimeout(() => {
      hideResolver();
    }, 2200);
    closeEpisodesPopover();
    return;
  }

  persistResumeTime(true);

  const nextParams = new URLSearchParams();
  nextParams.set("title", String(activeSeries.title || title || "Title"));
  nextParams.set(
    "episode",
    getSeriesEpisodeLabel(
      safeIndex,
      targetEpisode.title,
      activeSeries,
      Math.max(1, Math.floor(Number(targetEpisode?.episodeNumber || safeIndex + 1))),
    ),
  );
  nextParams.set("mediaType", "tv");
  if (isSeriesPlayback && activeSeries.id) {
    nextParams.set("seriesId", activeSeries.id);
    nextParams.set("episodeIndex", String(safeIndex));
  } else {
    nextParams.set("episodeIndex", String(safeIndex));
  }
  if (activeSeries.tmdbId) {
    nextParams.set("tmdbId", String(activeSeries.tmdbId));
  }
  if (activeSeries.year) {
    nextParams.set("year", String(activeSeries.year));
  }
  const targetSeasonNumber = Math.max(
    1,
    Math.floor(Number(targetEpisode?.seasonNumber || seasonNumber)),
  );
  const targetEpisodeNumber = Math.max(
    1,
    Math.floor(Number(targetEpisode?.episodeNumber || safeIndex + 1)),
  );
  nextParams.set("seasonNumber", String(targetSeasonNumber));
  nextParams.set("episodeNumber", String(targetEpisodeNumber));
  const nextPreferredContainer = String(
    activeSeries?.preferredContainer || preferredContainer || "",
  )
    .trim()
    .toLowerCase();
  if (
    nextPreferredContainer === "mp4" ||
    nextPreferredContainer === "mkv"
  ) {
    nextParams.set("preferredContainer", nextPreferredContainer);
  }
  if (preferredAudioLang && preferredAudioLang !== "auto") {
    nextParams.set("audioLang", preferredAudioLang);
  }
  if (shouldIncludePreferredQualityInUrl(preferredQuality)) {
    nextParams.set("quality", preferredQuality);
  }
  const returnTo = getExplicitPlayerReturnPath();
  if (returnTo) {
    nextParams.set("returnTo", returnTo);
  }

  const _seriesSlug = slugify(activeSeries?.title || title);
  const _episodePath = buildWatchUrl(nextParams);
  if (_seriesSlug) {
    saveWatchParams(_seriesSlug, nextParams.toString(), {
      seriesId: activeSeries?.id || requestedSeriesId,
      tmdbId,
    });
  }
  window.location.href = _episodePath;
}

function getSeriesEpisodeSourceIdentity(index) {
  const seriesId = String(activeSeries?.id || "").trim().toLowerCase();
  const safeIndex = Math.max(0, Math.floor(Number(index) || 0));
  return seriesId ? `series:${seriesId}:episode:${safeIndex}` : "";
}

function getStoredSeriesEpisodeResumeSeconds(index) {
  const episodeSourceIdentity = getSeriesEpisodeSourceIdentity(index);
  if (!episodeSourceIdentity) {
    return 0;
  }

  try {
    const storedValue = Number(
      localStorage.getItem(`streamarena-resume:${episodeSourceIdentity}`),
    );
    return Number.isFinite(storedValue) && storedValue > 0 ? storedValue : 0;
  } catch {
    return 0;
  }
}

function getSeriesEpisodeProgressRatio(index) {
  if (!Number.isFinite(Number(index))) {
    return 0;
  }

  const durationSeconds = Number(getDisplayDurationSeconds());
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 0;
  }

  const safeIndex = Math.max(0, Math.floor(Number(index) || 0));
  const progressSeconds =
    safeIndex === seriesEpisodeIndex
      ? Math.max(0, getEffectiveCurrentTime())
      : getStoredSeriesEpisodeResumeSeconds(safeIndex);

  if (!Number.isFinite(progressSeconds) || progressSeconds <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(1, progressSeconds / durationSeconds));
}

function syncEpisodeProgressIndicators() {
  if (!episodesList || !episodesControl?.classList.contains("is-open")) {
    return;
  }

  episodesList
    .querySelectorAll(".episode-preview-item[data-episode-index]")
    .forEach((item) => {
      const progress = item.querySelector(".episode-preview-progress");
      if (!(progress instanceof HTMLProgressElement)) {
        return;
      }

      const ratio = getSeriesEpisodeProgressRatio(
        Number(item.dataset.episodeIndex || 0),
      );
      progress.value = Math.round(ratio * 1000) / 10;
    });
}

function renderSeriesEpisodePreview() {
  if (!episodesList) {
    return;
  }

  episodesList.innerHTML = "";
  episodesList.classList.remove("is-season-list", "is-season-episodes");
  if (!hasSeriesEpisodeControls || !activeSeries) {
    setEpisodesMenuHeader();
    return;
  }

  const seasonGroups = getSeriesSeasonGroups();
  const selectedSeason = ensureSelectedEpisodesSeason(seasonGroups);
  const hasMultipleSeasons = seasonGroups.length > 1;

  if (episodesMenuMode === "seasons" && hasMultipleSeasons) {
    setEpisodesMenuHeader({
      overline: "Seasons",
      title: activeSeries.title || "Series",
      showBack: false,
    });
    episodesList.classList.add("is-season-list");

    const activeSeasonNumber = getActiveSeriesEpisodeSeasonNumber();
    const fragment = document.createDocumentFragment();
    seasonGroups.forEach((group) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "episode-season-item";
      item.dataset.seasonNumber = String(group.seasonNumber);
      item.setAttribute("role", "listitem");
      item.setAttribute(
        "aria-label",
        `${getSeriesSeasonLabel(group.seasonNumber)} (${group.episodes.length} episode${group.episodes.length === 1 ? "" : "s"})`,
      );
      if (group.seasonNumber === selectedSeason) {
        item.classList.add("is-selected");
        item.setAttribute("aria-current", "true");
      }
      if (group.seasonNumber === activeSeasonNumber) {
        item.classList.add("is-current-season");
      }

      const check = document.createElement("span");
      check.className = "episode-season-check";
      check.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4.5 12.5 5 5L19.5 7.5" fill="none" stroke-linecap="round" stroke-linejoin="round"></path></svg>';

      const body = document.createElement("span");
      body.className = "episode-season-body";

      const titleEl = document.createElement("span");
      titleEl.className = "episode-season-title";
      titleEl.textContent = getSeriesSeasonLabel(group.seasonNumber);

      const meta = document.createElement("span");
      meta.className = "episode-season-meta";
      meta.textContent = `${group.episodes.length} episode${group.episodes.length === 1 ? "" : "s"}`;

      body.append(titleEl, meta);
      item.append(check, body);
      fragment.appendChild(item);
    });
    episodesList.appendChild(fragment);
    return;
  }

  episodesMenuMode = "episodes";
  const selectedGroup =
    seasonGroups.find((group) => group.seasonNumber === selectedSeason) ||
    seasonGroups[0];
  const selectedEpisodePairs = selectedGroup?.episodes || [];
  const activeSeasonNumber = getActiveSeriesEpisodeSeasonNumber();
  const previewEpisodeIndex =
    selectedSeason === activeSeasonNumber && seriesEpisodeIndex >= 0
      ? seriesEpisodeIndex
      : selectedEpisodePairs[0]?.index;

  setEpisodesMenuHeader({
    overline: hasMultipleSeasons ? "Episodes" : activeSeries.title || "Episodes",
    title: hasMultipleSeasons
      ? getSeriesSeasonLabel(selectedSeason)
      : activeSeries.title || "Episodes",
    showBack: hasMultipleSeasons,
  });
  episodesList.classList.add("is-season-episodes");

  selectedEpisodePairs.forEach(({ episodeEntry, index }) => {
    const isPlayable = isSeriesEpisodePlayable(episodeEntry);
    const isCurrentEpisode = index === seriesEpisodeIndex;
    const isPreviewedEpisode = index === previewEpisodeIndex;
    const itemEpisodeNumber = getSeriesEpisodeOrdinalNumber(episodeEntry, index);
    const item = document.createElement("button");
    item.type = "button";
    item.className = "episode-preview-item";
    if (isPreviewedEpisode) {
      item.classList.add("is-previewed");
    }
    if (!isPlayable) {
      item.classList.add("is-unavailable");
      item.disabled = true;
    }
    item.dataset.episodeIndex = String(index);
    item.setAttribute("role", "listitem");
    item.setAttribute(
      "aria-label",
      isPlayable
        ? `Episode ${itemEpisodeNumber}: ${episodeEntry.title}`
        : `Episode ${itemEpisodeNumber}: ${episodeEntry.title} (Unavailable)`,
    );
    if (isCurrentEpisode) {
      item.classList.add("is-active");
      item.setAttribute("aria-current", "true");
    }

    const number = document.createElement("p");
    number.className = "episode-preview-number";
    number.textContent = String(itemEpisodeNumber);

    const main = document.createElement("div");
    main.className = "episode-preview-main";

    const heading = document.createElement("p");
    heading.className = "episode-preview-title";
    heading.textContent = isPlayable
      ? episodeEntry.title
      : `${episodeEntry.title} (Unavailable)`;
    main.appendChild(heading);

    let thumb = null;
    if (isPreviewedEpisode) {
      thumb = document.createElement("img");
      thumb.className = "episode-preview-thumb";
      const thumbUrl = String(episodeEntry.thumb || DEFAULT_EPISODE_THUMBNAIL);
      thumb.src = thumbUrl.startsWith("/") || thumbUrl.startsWith("http") ? thumbUrl : `/${thumbUrl}`;
      thumb.alt = `Episode ${index + 1} preview`;
      thumb.loading = "lazy";
    }

    const description = document.createElement("p");
    description.className = "episode-preview-desc";
    if (isPreviewedEpisode) {
      description.textContent = isPlayable
        ? String(episodeEntry.description || "")
        : "Unavailable until MP4 source is added.";
    }

    const progress = document.createElement("progress");
    progress.className = "episode-preview-progress";
    progress.max = 100;
    progress.value = 0;
    progress.setAttribute("aria-hidden", "true");

    if (thumb) {
      item.append(number, main, thumb, description, progress);
    } else {
      item.append(number, main, description, progress);
    }
    episodesList.appendChild(item);
  });
  syncEpisodeProgressIndicators();
}

function openEpisodesPopover({ sticky = false, auto = false } = {}) {
  if (!episodesControl || !hasSeriesEpisodeControls || isResolvingSource()) {
    return;
  }

  closeLiveStreamPopover(false);
  closeSourcePopover(false);
  closeHlsQualityPopover(false);
  closeSpeedPopover(false);
  closeAudioPopover();
  window.clearTimeout(episodesPopoverCloseTimeout);
  const wasAlreadyOpen = episodesControl.classList.contains("is-open");
  episodesControl.classList.add("is-open");
  toggleEpisodes?.setAttribute("aria-expanded", "true");
  if (sticky) {
    episodesPopoverSticky = true;
  }
  if (auto) {
    markPopoverAutoOpened(episodesControl);
  }
  if (!wasAlreadyOpen) {
    episodesMenuMode = "episodes";
    selectedEpisodesSeasonNumber = getActiveSeriesEpisodeSeasonNumber();
    renderSeriesEpisodePreview();
  }

  // Auto-scroll to the currently active episode only on first open
  if (!wasAlreadyOpen) {
    const activeItem = episodesList?.querySelector(".episode-preview-item.is-active");
    if (activeItem) {
      activeItem.scrollIntoView({ block: "nearest", behavior: "instant" });
    }
  }
}

function closeEpisodesPopover(withDelay = false) {
  if (!episodesControl) {
    return;
  }

  window.clearTimeout(episodesPopoverCloseTimeout);

  const close = ({ respectInteractivity = true } = {}) => {
    if (respectInteractivity && episodesPopoverSticky) {
      return;
    }
    if (respectInteractivity && episodesControl.matches(":hover, :focus-within")) {
      return;
    }
    episodesPopoverSticky = false;
    clearPopoverAutoOpen(episodesControl);
    episodesControl.classList.remove("is-open");
    toggleEpisodes?.setAttribute("aria-expanded", "false");
  };

  if (!withDelay) {
    close({ respectInteractivity: false });
    return;
  }

  episodesPopoverCloseTimeout = window.setTimeout(close, 140);
}

function syncSeriesControls() {
  const shouldShowControls = hasSeriesEpisodeControls;
  const nextEpisodeEntry =
    shouldShowControls &&
    seriesEpisodeIndex >= 0 &&
    seriesEpisodeIndex < seriesEpisodes.length - 1
      ? seriesEpisodes[seriesEpisodeIndex + 1]
      : null;
  const hasNextEpisode = Boolean(
    nextEpisodeEntry && isSeriesEpisodePlayable(nextEpisodeEntry),
  );
  const nextTitle = String(nextEpisodeEntry?.title || "").trim();

  if (nextEpisode) {
    nextEpisode.hidden = !shouldShowControls;
    nextEpisode.disabled = !hasNextEpisode;
    nextEpisode.setAttribute(
      "aria-label",
      hasNextEpisode
        ? `Next episode (${nextTitle})`
        : nextEpisodeEntry
          ? `Next episode (${nextTitle}) unavailable`
          : "Next episode unavailable",
    );
  }

  if (episodesControl) {
    episodesControl.hidden = !shouldShowControls;
  if (!shouldShowControls) {
      episodesControl.classList.remove("is-open");
      toggleEpisodes?.setAttribute("aria-expanded", "false");
    }
  }

  if (toggleEpisodes && shouldShowControls) {
    const activeSeasonNumber = getActiveSeriesEpisodeSeasonNumber();
    const seasonGroups = getSeriesSeasonGroups();
    const seasonSuffix =
      seasonGroups.length > 1 ? `, ${getSeriesSeasonLabel(activeSeasonNumber)}` : "";
    toggleEpisodes.setAttribute(
      "aria-label",
      `Episodes (${seriesEpisodeIndex + 1} of ${seriesEpisodes.length}${seasonSuffix})`,
    );
  }
}

// ─── Auto-play next episode ───

function getNextPlayableEpisode() {
  if (!isEpisodeListPlayback()) {
    return null;
  }
  const nextIndex = seriesEpisodeIndex + 1;
  if (nextIndex >= seriesEpisodes.length) {
    return null;
  }
  const nextEp = seriesEpisodes[nextIndex];
  if (!nextEp || !isSeriesEpisodePlayable(nextEp)) {
    return null;
  }
  return { episode: nextEp, index: nextIndex };
}

// Tracks which next-episode resolve we've already warmed so the prefetch fires at
// most once per upcoming episode.
let prefetchedNextEpisodeKey = "";

// Fire-and-forget warm-up of the next episode's resolve while the auto-play card is
// showing. The next episode is a full page reload that re-resolves from cold; by
// warming the server-side provider-health + upstream TLS/session state ahead of
// time (the benchmark showed this alone makes the next resolve ~3x faster), the
// reload's own resolve lands warm. Discards the result and swallows errors — this
// only nudges server state and never touches the current playback. Skipped for
// non-TMDB (uploaded) series, which don't use the backend resolver.
function prefetchNextEpisodeResolve(next) {
  if (!next || !isTmdbResolvedPlayback || !isTmdbTvPlayback) {
    return;
  }
  const nextTmdbId = String(activeSeries?.tmdbId || tmdbId || "").trim();
  if (!nextTmdbId) {
    return;
  }
  const nextSeason = Math.max(
    1,
    Math.floor(Number(next.episode?.seasonNumber || seasonNumber || 1)),
  );
  const nextEpisode = Math.max(
    1,
    Math.floor(Number(next.episode?.episodeNumber || next.index + 1)),
  );
  const prefetchKey = `${nextTmdbId}:${nextSeason}:${nextEpisode}`;
  if (prefetchKey === prefetchedNextEpisodeKey) {
    return;
  }
  prefetchedNextEpisodeKey = prefetchKey;
  const query = new URLSearchParams({
    tmdbId: nextTmdbId,
    title: String(activeSeries?.title || title || "Title"),
    seasonNumber: String(nextSeason),
    episodeNumber: String(nextEpisode),
    audioLang: "auto",
    quality: "auto",
    resolverProvider: "auto",
  });
  if (activeSeries?.year) {
    query.set("year", String(activeSeries.year));
  }
  try {
    void fetch(`/api/resolve/tv?${query.toString()}`, {
      credentials: "include",
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Ignore — the warm-up is best-effort.
  }
}

function showAutoPlayCard() {
  const next = getNextPlayableEpisode();
  if (!next || !autoPlayOverlay || autoPlayCancelled) {
    return;
  }
  prefetchNextEpisodeResolve(next);

  const nextLabel = getSeriesEpisodeLabel(
    next.index,
    next.episode.title,
    activeSeries,
    next.episode.episodeNumber,
  );
  const rawThumb = next.episode.thumb || DEFAULT_EPISODE_THUMBNAIL;
  const thumbSrc = rawThumb.startsWith("/") || rawThumb.startsWith("http") ? rawThumb : `/${rawThumb}`;

  if (autoPlayThumb) {
    autoPlayThumb.src = thumbSrc;
    autoPlayThumb.alt = nextLabel;
  }
  if (autoPlayTitle) {
    autoPlayTitle.textContent = activeSeries.title || "Next Episode";
  }
  if (autoPlayEpLabel) {
    autoPlayEpLabel.textContent = nextLabel;
  }
  if (autoPlayCountdownText) {
    autoPlayCountdownText.textContent = "";
  }
  if (autoPlayProgressRing) {
    autoPlayProgressRing.setAttribute("stroke-dashoffset", "0");
  }

  autoPlayOverlay.hidden = false;
  autoPlayOverlayVisible = true;
}

function startAutoPlayCountdown() {
  const next = getNextPlayableEpisode();
  if (!next || !autoPlayOverlay || autoPlayCancelled) {
    return;
  }

  if (!autoPlayOverlayVisible) {
    showAutoPlayCard();
  }
  if (!autoPlayOverlayVisible) {
    return;
  }

  autoPlayOverlay.classList.add("is-countdown");
  autoPlayCountdownSeconds = AUTO_PLAY_COUNTDOWN_DURATION;

  const circumference = 2 * Math.PI * 20;
  if (autoPlayProgressRing) {
    autoPlayProgressRing.setAttribute("stroke-dasharray", `${circumference}`);
    autoPlayProgressRing.setAttribute("stroke-dashoffset", "0");
  }

  function tick() {
    if (autoPlayCountdownSeconds <= 0) {
      clearInterval(autoPlayCountdownInterval);
      autoPlayCountdownInterval = null;
      navigateToSeriesEpisode(next.index);
      return;
    }
    if (autoPlayCountdownText) {
      autoPlayCountdownText.textContent = String(autoPlayCountdownSeconds);
    }
    if (autoPlayProgressRing) {
      const progress = 1 - autoPlayCountdownSeconds / AUTO_PLAY_COUNTDOWN_DURATION;
      autoPlayProgressRing.setAttribute("stroke-dashoffset", String(circumference * progress));
    }
    autoPlayCountdownSeconds--;
  }

  tick();
  autoPlayCountdownInterval = window.setInterval(tick, 1000);
}

function hideAutoPlayOverlay() {
  if (autoPlayCountdownInterval) {
    clearInterval(autoPlayCountdownInterval);
    autoPlayCountdownInterval = null;
  }
  autoPlayCountdownSeconds = 0;
  autoPlayOverlayVisible = false;
  if (autoPlayOverlay) {
    autoPlayOverlay.hidden = true;
    autoPlayOverlay.classList.remove("is-countdown");
  }
}

function cancelAutoPlay() {
  autoPlayCancelled = true;
  hideAutoPlayOverlay();
}

// Deferred to onMount (needs refs):
// setEpisodeLabel, renderSeriesEpisodePreview, syncSeriesControls, hydrateSeriesEpisodeThumbnails

function formatTime(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "00:00";
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function syncPlayState() {
  const isPaused = isLiveIframePlaybackActive()
    ? liveIframePlaybackClock.isPaused()
    : video.paused;
  togglePlay.classList.toggle("paused", isPaused);
  togglePlay.setAttribute("aria-label", isPaused ? "Play" : "Pause");
}

function clampPlayerVolume(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 1;
  }
  return Math.max(0, Math.min(1, numericValue));
}

function syncVolumeSliderState() {
  if (!volumeSlider) {
    return;
  }

  const currentVolume = clampPlayerVolume(video.volume);
  const isMuted = video.muted || currentVolume <= 0.001;
  const visibleVolume = isMuted ? 0 : currentVolume;

  if (visibleVolume > 0) {
    lastAudibleVolume = visibleVolume;
  }

  const volumePercent = Math.round(visibleVolume * 100);
  volumeSlider.value = String(volumePercent);
  setRuntimeStyleRule(".volume-slider", {
    background: `linear-gradient(to right, rgba(255, 255, 255, 0.96) 0%, rgba(255, 255, 255, 0.96) ${volumePercent}%, rgba(255, 255, 255, 0.28) ${volumePercent}%, rgba(255, 255, 255, 0.28) 100%)`,
  });
}

function syncMuteState() {
  const muted = video.muted || video.volume === 0;
  toggleMutePlayer.classList.toggle("muted", muted);
  toggleMutePlayer.setAttribute("aria-label", muted ? "Unmute" : "Mute");
  syncVolumeSliderState();
}

function enableAudiblePlaybackByDefault() {
  lastAudibleVolume = 1;
  if (!video) {
    return;
  }
  video.volume = 1;
  video.muted = false;
  syncMuteState();
}

function setPlayerVolume(nextVolume) {
  const clampedVolume = clampPlayerVolume(nextVolume);
  const isMuted = clampedVolume <= 0.001;

  if (!isMuted) {
    lastAudibleVolume = clampedVolume;
  }

  video.volume = clampedVolume;
  video.muted = isMuted;
  syncMuteState();
}

function togglePlayerMute() {
  const isMuted = video.muted || clampPlayerVolume(video.volume) <= 0.001;

  if (isMuted) {
    video.muted = false;
    setPlayerVolume(lastAudibleVolume > 0 ? lastAudibleVolume : 1);
    return;
  }

  lastAudibleVolume = Math.max(clampPlayerVolume(video.volume), 0.1);
  setPlayerVolume(0);
}

function syncSpeedState() {
  const speedLabel = `${video.playbackRate}x`;
  const accessibleLabel = `Playback speed (${speedLabel})`;
  toggleSpeed.setAttribute("aria-label", accessibleLabel);

  speedOptions.forEach((option) => {
    const optionRate = Number(option.dataset.rate);
    const isSelected = optionRate === video.playbackRate;
    option.setAttribute("aria-selected", isSelected ? "true" : "false");
  });
}

function getSelectedLiveStreamOption() {
  return getSelectedLiveStreamOptionFromState(
    liveStreamOptions,
    selectedLiveStreamId,
  );
}

function shouldShowLiveStreamControls() {
  return shouldShowLiveStreamControlsForState(isLivePlayback, liveStreamOptions);
}

function syncLiveStreamControls() {
  syncLiveStreamControlsDom({
    liveStreamControl,
    toggleLiveStream,
    liveStreamMenu,
    liveStreamOptionsContainer,
    liveStreamOptions,
    selectedLiveStreamId,
    isLivePlayback,
  });
}

function renderLiveStreamOptions() {
  renderLiveStreamOptionsDom(
    liveStreamOptionsContainer,
    liveStreamOptions,
    selectedLiveStreamId,
    {
      getStatus: getLiveStreamOptionStatus,
    },
  );
  syncLiveStreamControls();
}

function getLiveStreamCacheEventSlug() {
  if (!isLivePlayback) {
    return "";
  }
  const eventLabel = [
    sourceIdentity,
    title,
    episode,
    liveEmbedResolver,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(":");
  return slugify(eventLabel) || "stream";
}

function isLiveStreamRecentlyFailed(streamOption, now = Date.now()) {
  return liveStreamCache.isRecentlyFailed(streamOption, now);
}

function getLiveStreamOptionStatus(streamOption) {
  return liveStreamCache.getOptionStatus(streamOption);
}

function rememberLiveStreamFailure(streamOption, reason = "") {
  if (liveStreamCache.rememberFailure(streamOption, reason)) {
    renderLiveStreamOptions();
  }
}

function clearLiveStreamFailure(streamOption) {
  if (liveStreamCache.clearFailure(streamOption)) {
    renderLiveStreamOptions();
  }
}

function getPreferredRankedLiveStreamOption() {
  return liveStreamCache.getPreferredRankedOption();
}

function getRememberedWorkingLiveStreamOption(now = Date.now()) {
  return liveStreamCache.getRememberedWorkingOption(now);
}

function rememberLiveStreamSuccess(
  streamOption = getSelectedLiveStreamOption(),
  reason = "",
) {
  if (!isLivePlayback || liveStreamOptions.length <= 1) {
    return;
  }
  liveFallbackRetry.reset();
  if (liveStreamCache.rememberSuccess(streamOption, reason)) {
    renderLiveStreamOptions();
  }
}

function prepareLiveFailureCacheForCurrentEvent() {
  liveStreamCache.prepareForCurrentEvent();
}

function selectRememberedWorkingLiveStreamIfNeeded() {
  if (!isLivePlayback || liveStreamOptions.length <= 1) {
    return false;
  }
  const rememberedOption =
    getRememberedWorkingLiveStreamOption() ||
    getPreferredRankedLiveStreamOption();
  if (!rememberedOption || isLiveStreamRecentlyFailed(rememberedOption)) {
    return false;
  }
  const selectedOption = getSelectedLiveStreamOption();
  if (
    selectedOption?.id === rememberedOption.id &&
    normalizePlaybackSourceValue(selectedOption?.source) ===
      normalizePlaybackSourceValue(rememberedOption.source)
  ) {
    return false;
  }
  selectedLiveStreamId = rememberedOption.id;
  setExplicitPlaybackSourceState(rememberedOption.source);
  persistLiveStreamSelectionInUrl();
  return true;
}

function selectFirstFreshLiveStreamIfNeeded() {
  if (!isLivePlayback || liveStreamOptions.length <= 1) {
    return false;
  }
  const selectedOption = getSelectedLiveStreamOption();
  if (!selectedOption || !isLiveStreamRecentlyFailed(selectedOption)) {
    return false;
  }
  const nextOption =
    getOrderedLiveFallbackOptions({ includeCachedFailures: false })[0] || null;
  if (!nextOption) {
    return false;
  }
  selectedLiveStreamId = nextOption.id;
  setExplicitPlaybackSourceState(nextOption.source);
  persistLiveStreamSelectionInUrl();
  return true;
}

function persistLiveStreamSelectionInUrl() {
  if (!isLivePlayback) {
    return;
  }

  try {
    if (src) {
      params.set("src", src);
    }
    params.set("live", "1");
    if (selectedLiveStreamId) {
      params.set("liveStreamId", selectedLiveStreamId);
    }
    if (liveStreamOptions.length > 0) {
      params.set("liveStreams", JSON.stringify(liveStreamOptions));
    }
    if (shouldResolveLiveEmbedSource) {
      params.set("liveEmbed", "1");
    } else {
      params.delete("liveEmbed");
    }
    if (liveEmbedResolver) {
      params.set("liveResolver", liveEmbedResolver);
    }
    replaceReproducibleWatchUrl();
  } catch {
    // URL syncing is diagnostic/bookmarking only; playback should continue.
  }
}

function resetLiveStreamPlaybackState() {
  expectedDurationSeconds = 0;
  resumeTime = 0;
  lastPersistedResumeTime = 0;
  lastPersistedResumeAt = 0;
  availableAudioTracks = [];
  availableSubtitleTracks = [];
  selectedAudioStreamIndex = -1;
  selectedSubtitleStreamIndex = -1;
  activeTrackSourceInput = "";
  clearSubtitleTrack();
  clearLiveVisualHealthWatch({ resetSamples: true });
  clearLiveStartupHealthWatch({ resetRequest: true });
  hideAllSubtitleTracks();
  rebuildTrackOptionButtons();
}

function getLiveEmbedFallbackSources(source) {
  const normalizedSource = normalizePlaybackSourceValue(source);
  const seenSources = new Set([normalizedSource]);
  const selectedOption =
    liveStreamOptions.find(
      (option) => normalizePlaybackSourceValue(option?.source) === normalizedSource,
    ) ||
    liveStreamOptions.find((option) => option.id === selectedLiveStreamId) ||
    {};
  const selectedProvider = normalizeLiveStreamPreferenceProvider(selectedOption);
  const sameProviderSources = [];
  const otherProviderSources = [];

  liveStreamOptions.forEach((option) => {
    const candidateSource = normalizePlaybackSourceValue(option?.source);
    if (!candidateSource || seenSources.has(candidateSource)) {
      return;
    }
    seenSources.add(candidateSource);
    const candidateProvider = normalizeLiveStreamPreferenceProvider(option);
    if (selectedProvider && candidateProvider === selectedProvider) {
      sameProviderSources.push(candidateSource);
    } else {
      otherProviderSources.push(candidateSource);
    }
  });

  return [...sameProviderSources, ...otherProviderSources]
    .slice(0, LIVE_EMBED_FALLBACK_SOURCE_LIMIT);
}

async function resolveLivePlaybackSource(source, { preflight = false } = {}) {
  const normalizedSource = normalizePlaybackSourceValue(source);
  if (!normalizedSource) {
    throw new Error("Missing live stream source.");
  }
  if (parseLiveIframePlaybackSource(normalizedSource)) {
    return normalizedSource;
  }
  if (!shouldResolveLiveEmbedSource) {
    return getLivePlaybackSource(normalizedSource, isLivePlayback);
  }
  if (isHlsPlaybackSource(normalizedSource)) {
    return getLivePlaybackSource(normalizedSource, true);
  }

  const query = new URLSearchParams({ url: normalizedSource });
  const fallbackSources = getLiveEmbedFallbackSources(normalizedSource);
  if (fallbackSources.length > 0) {
    query.set("fallbackUrls", JSON.stringify(fallbackSources));
    // First-watch only: resolve the candidates concurrently so a dead primary
    // doesn't gate the working source behind it (the backend re-orders to it).
    if (preflight) {
      query.set("preflight", "1");
    }
  }
  const payload = await requestJson(
    `/api/${liveEmbedResolver}/stream?${query.toString()}`,
    {},
    30000,
  );
  const playbackUrl = normalizePlaybackSourceValue(
    payload?.playbackUrl || payload?.streamUrl || "",
  );
  const playbackType = String(payload?.playbackType || "")
    .trim()
    .toLowerCase();
  if (playbackType === "iframe" || playbackType === "embed") {
    throw new Error("Live stream resolver returned an embed instead of HLS.");
  }
  if (playbackType && playbackType !== "hls") {
    throw new Error("Live stream playback type is not supported.");
  }
  if (!isHlsPlaybackSource(playbackUrl)) {
    throw new Error("Could not resolve this live stream to HLS.");
  }
  const resolvedSource = normalizePlaybackSourceValue(payload?.source || normalizedSource);
  if (resolvedSource && resolvedSource !== normalizedSource) {
    const resolvedOption = liveStreamOptions.find(
      (option) => normalizePlaybackSourceValue(option?.source) === resolvedSource,
    );
    if (resolvedOption) {
      selectedLiveStreamId = resolvedOption.id;
      setExplicitPlaybackSourceState(resolvedOption.source);
      syncLiveStreamControls();
      persistLiveStreamSelectionInUrl();
    }
  }
  if (!playbackUrl) {
    throw new Error("Could not resolve this live stream.");
  }
  const playerPageReferer = normalizeBrowserBoundLiveHlsReferer(
    payload?.playerPage || resolvedSource || normalizedSource,
  );
  activeLiveHlsReferer = playerPageReferer;
  return getLivePlaybackSource(playbackUrl, true, {
    referer: playbackUrl.includes("/api/live/hls.m3u8") ? "" : playerPageReferer,
  });
}

function isPlaybackBlockedByPolicy(error) {
  return String(error?.name || "").toLowerCase() === "notallowederror";
}

function resetLiveAutoFallbackAttempts() {
  liveAutoFallbackAttemptedStreamIds = new Set();
}

function getOrderedLiveFallbackOptions({ includeCachedFailures = false } = {}) {
  if (liveStreamOptions.length <= 1) {
    return [];
  }

  const selectedIndex = liveStreamOptions.findIndex(
    (option) => option.id === selectedLiveStreamId,
  );
  const startIndex = selectedIndex >= 0 ? selectedIndex + 1 : 0;
  const ordered = [
    ...liveStreamOptions.slice(startIndex),
    ...liveStreamOptions.slice(0, Math.max(0, startIndex)),
  ].filter(
    (option) =>
      option?.source &&
      option.id !== selectedLiveStreamId &&
      !liveAutoFallbackAttemptedStreamIds.has(option.id) &&
      (includeCachedFailures || !isLiveStreamRecentlyFailed(option)),
  );

  // Prefer a source we've already confirmed working for this event.
  const working = getRememberedWorkingLiveStreamOption();
  const workingIndex = working
    ? ordered.findIndex((option) => option.id === working.id)
    : -1;
  if (workingIndex > 0) {
    ordered.unshift(ordered.splice(workingIndex, 1)[0]);
  }
  return ordered;
}

async function switchToLiveStreamOption(
  nextStream,
  {
    autoFallback = false,
    reasonMessage = "Loading live stream...",
    wasPaused = video?.paused,
  } = {},
) {
  const previousStreamId = selectedLiveStreamId;
  const previousSource = src;

  selectedLiveStreamId = nextStream.id;
  setExplicitPlaybackSourceState(nextStream.source);
  persistLiveStreamSelectionInUrl();
  resetLiveStreamPlaybackState();
  syncLiveStreamControls();
  showResolver(reasonMessage, { showStatus: autoFallback });

  try {
    const playbackSource = await resolveLivePlaybackSource(nextStream.source);
    setVideoSource(playbackSource);
    persistLiveStreamSelectionInUrl();
    hideResolver();
    if (!wasPaused) {
      await tryPlay();
    }
    syncPlayState();
    syncDurationText();
    closeLiveStreamPopover();
    return true;
  } catch (error) {
    selectedLiveStreamId = previousStreamId;
    setExplicitPlaybackSourceState(previousSource);
    persistLiveStreamSelectionInUrl();
    syncLiveStreamControls();
    syncPlayState();
    syncDurationText();
    if (autoFallback) {
      throw error;
    }
    showResolverError(error, "Unable to load this live stream.");
    closeLiveStreamPopover();
    return false;
  }
}

async function attemptAutomaticLiveStreamFallback(
  message = "Live stream looks blank. Trying another source...",
) {
  if (
    !isLivePlayback ||
    liveAutoFallbackInFlight ||
    liveStreamOptions.length <= 1
  ) {
    return false;
  }

  const currentStream = getSelectedLiveStreamOption();
  if (currentStream?.id) {
    liveAutoFallbackAttemptedStreamIds.add(currentStream.id);
    rememberLiveStreamFailure(currentStream, message);
  }

  liveAutoFallbackInFlight = true;
  clearLiveVisualHealthWatch({ resetSamples: true });
  clearLiveStartupHealthWatch({ resetRequest: true });
  let recovered = false;
  // Fresh sources first, then retry recently-failed ones (often transient) before giving up.
  const nextOption = () => getOrderedLiveFallbackOptions()[0] || getOrderedLiveFallbackOptions({ includeCachedFailures: true })[0] || null;
  try {
    let nextStream = nextOption();
    while (nextStream) {
      try {
        showResolver(message, { showStatus: true });
        await switchToLiveStreamOption(nextStream, {
          autoFallback: true,
          reasonMessage: message,
          wasPaused: false,
        });
        recovered = true;
        return true;
      } catch {
        liveAutoFallbackAttemptedStreamIds.add(nextStream.id);
        rememberLiveStreamFailure(nextStream, message);
        nextStream = nextOption();
      }
    }
  } finally {
    liveAutoFallbackInFlight = false;
    if (recovered) {
      startLiveVisualHealthWatch();
      armLiveStartupHealthWatch();
    }
  }

  scheduleLiveFallbackRetry(message);
  return false;
}

function scheduleLiveFallbackRetry(message) {
  const queued = liveFallbackRetry.schedule(
    () => {
      if (!isLivePlayback || video.paused || document.visibilityState === "hidden") {
        return;
      }
      // Give every source (including recently-failed ones) a fresh chance.
      resetLiveAutoFallbackAttempts();
      void attemptAutomaticLiveStreamFallback(message);
    },
    () => {
      showResolverError(
        "No alternate live streams worked for this event.",
        "No alternate live streams worked for this event.",
        { showRetry: true },
      );
    },
  );
  if (queued) {
    showResolver("Still searching for a working source…", { showStatus: true });
  }
}

function openLiveStreamPopover() {
  if (!liveStreamControl || !shouldShowLiveStreamControls() || isResolvingSource()) {
    return;
  }

  closeEpisodesPopover(false);
  closeSourcePopover(false);
  closeHlsQualityPopover(false);
  closeAudioPopover();
  closeSpeedPopover(false);
  window.clearTimeout(liveStreamPopoverCloseTimeout);
  showControls();
  clearControlsHideTimer();
  liveStreamControl.classList.add("is-open");
  toggleLiveStream?.setAttribute("aria-expanded", "true");
}

function closeLiveStreamPopover(withDelay = false) {
  if (!liveStreamControl) {
    return;
  }

  window.clearTimeout(liveStreamPopoverCloseTimeout);

  const close = () => {
    if (liveStreamControl.matches(":hover, :focus-within")) {
      return;
    }
    liveStreamControl.classList.remove("is-open");
    toggleLiveStream?.setAttribute("aria-expanded", "false");
  };

  if (!withDelay) {
    close();
    return;
  }

  liveStreamPopoverCloseTimeout = window.setTimeout(close, 140);
}

function openSourcePopover() {
  if (!sourceControl || !shouldShowTmdbSourceControls()) {
    return;
  }

  closeLiveStreamPopover(false);
  closeEpisodesPopover(false);
  closeHlsQualityPopover(false);
  closeAudioPopover();
  closeSpeedPopover(false);
  window.clearTimeout(sourcePopoverCloseTimeout);
  // Re-open on the tab that matches the currently playing source instead of
  // whatever tab the user last browsed while the menu was open.
  activeSourceTypeTab = "";
  if (!availablePlaybackSources.length && !isFetchingPlaybackSources) {
    void fetchTmdbSourceOptionsViaBackend();
  } else {
    // Resetting the tab is stateful; rebuild the filtered rows immediately so
    // the DOM follows the playing source rather than the previously browsed tab.
    renderSourceOptionButtons();
  }
  showControls();
  clearControlsHideTimer();
  sourceControl.classList.add("is-open");
  toggleSource?.setAttribute("aria-expanded", "true");
  syncTmdbSourceControls();
}

function toggleSourcePopoverFromControl() {
  if (!sourceControl) {
    return;
  }

  if (sourceControl.classList.contains("is-open")) {
    closeSourcePopover(false, { force: true });
    return;
  }

  openSourcePopover();
}

function closeSourcePopover(withDelay = false, { force = false } = {}) {
  if (!sourceControl) {
    return;
  }

  // Keep the Server menu open while a row is resolving so the inline spinner
  // stays visible next to the chosen source.
  if (!force && pendingSourceSwitchHash) {
    return;
  }

  window.clearTimeout(sourcePopoverCloseTimeout);

  const close = () => {
    if (!force && pendingSourceSwitchHash) {
      return;
    }
    if (!force && sourceControl.matches(":hover, :focus-within")) {
      return;
    }
    sourceControl.classList.remove("is-open");
    toggleSource?.setAttribute("aria-expanded", "false");
  };

  if (!withDelay) {
    close();
    return;
  }

  sourcePopoverCloseTimeout = window.setTimeout(close, 140);
}

async function switchLiveStream(streamId) {
  const nextStream =
    liveStreamOptions.find((option) => option.id === streamId) || null;
  if (!nextStream || !nextStream.source || nextStream.id === selectedLiveStreamId) {
    closeLiveStreamPopover();
    return;
  }

  resetLiveAutoFallbackAttempts();
  clearLiveStreamFailure(nextStream);
  await switchToLiveStreamOption(nextStream, {
    reasonMessage: "Loading live stream...",
    wasPaused: video.paused,
  });
}

function syncAudioState() {
  syncAudioSubtitleControlVisibility();

  const selectedAudioTrack = getSelectedEmbeddedAudioTrack();
  const selectedAudioLabel = selectedAudioTrack
    ? getAudioTrackDisplayLabel(selectedAudioTrack)
    : availableAudioTracks.length === 0
      ? getUnknownAudioTrackDisplayLabel()
      : preferredAudioLang === "auto"
      ? "Auto"
      : getLanguageDisplayLabel(preferredAudioLang);
  const selectedSubtitleTrack =
    selectedSubtitleStreamIndex >= 0
      ? availableSubtitleTracks.find(
          (track) => Number(track?.streamIndex) === selectedSubtitleStreamIndex,
        )
      : null;
  const selectedSubtitleLabel =
    selectedSubtitleStreamIndex >= 0
      ? getSubtitleTrackDisplayLabel(selectedSubtitleTrack) ||
        getLanguageDisplayLabel(preferredSubtitleLang)
      : "Off";
  const syncHint = preferredAudioSyncMs
    ? `, A/V ${preferredAudioSyncMs > 0 ? "+" : ""}${preferredAudioSyncMs}ms`
    : "";
  const controlLabel = `Audio and subtitles (audio: ${selectedAudioLabel}, subtitles: ${selectedSubtitleLabel}${syncHint})`;
  toggleAudio?.setAttribute("aria-label", controlLabel);
  toggleAudio?.setAttribute("title", controlLabel);
  audioMenu?.setAttribute("aria-label", `Audio and subtitles (${selectedAudioLabel})`);

  if (audioStatusBadge) {
    audioStatusBadge.hidden = true;
    audioStatusBadge.textContent = "";
  }

  audioOptions.forEach((option) => {
    if (option.dataset.optionType === "audio-track") {
      const streamIndex = Number(option.dataset.streamIndex || -1);
      option.setAttribute(
        "aria-selected",
        streamIndex === selectedAudioStreamIndex ? "true" : "false",
      );
      return;
    }
    if (option.dataset.optionType === "audio-lang") {
      option.setAttribute(
        "aria-selected",
        option.dataset.lang === preferredAudioLang ? "true" : "false",
      );
      return;
    }
    if (option.dataset.optionType === "default-audio") {
      option.setAttribute("aria-selected", "true");
    }
  });

  subtitleOptions.forEach((option) => {
    const streamIndex = Number(option.dataset.subtitleStream || -1);
    const isOffOption = streamIndex < 0;
    const isSelected = isOffOption
      ? selectedSubtitleStreamIndex < 0
      : streamIndex === selectedSubtitleStreamIndex;
    option.setAttribute("aria-selected", isSelected ? "true" : "false");
  });

  if (subtitleSyncValue) {
    subtitleSyncValue.textContent = subtitleOffset.getLabel();
  }
  if (subtitleSyncReset) {
    subtitleSyncReset.hidden = subtitleOffset.getOffsetMs() === 0;
  }

  syncSourceSelectionState();
  renderSelectedSourceDetails();
  syncTmdbSourceControls();
}

function getCurrentAudioSyncSourceHash() {
  return normalizeSourceHash(selectedSourceHash || "");
}

async function adjustSourceAudioSync(deltaMs = 0) {
  if (
    !isTranscodeSourceActive() ||
    !activeTranscodeInput
  ) {
    return;
  }

  const normalizedDelta = normalizeAudioSyncMs(deltaMs);
  if (normalizedDelta === 0) {
    return;
  }

  const nextAudioSync = normalizeAudioSyncMs(
    preferredAudioSyncMs + normalizedDelta,
  );
  if (nextAudioSync === preferredAudioSyncMs) {
    return;
  }

  preferredAudioSyncMs = nextAudioSync;
  const sourceHash = getCurrentAudioSyncSourceHash();
  if (sourceHash) {
    persistSourceAudioSyncMs(sourceHash, preferredAudioSyncMs);
  }

  const resumeFrom = getEffectiveCurrentTime();
  const wasPaused = video.paused;
  showResolver(
    sourceHash
      ? `Audio sync ${preferredAudioSyncMs > 0 ? "+" : ""}${preferredAudioSyncMs}ms (saved for this source).`
      : `Audio sync ${preferredAudioSyncMs > 0 ? "+" : ""}${preferredAudioSyncMs}ms.`,
    { showStatus: true },
  );
  const restartAt = resumeFrom > 1 ? resumeFrom : 0;
  setVideoSource(
    buildSoftwareDecodeUrl(
      activeTranscodeInput,
      restartAt,
      selectedAudioStreamIndex,
      preferredAudioSyncMs,
      selectedSubtitleStreamIndex,
      sourceHash,
    ),
  );
  applySubtitleTrackByStreamIndex(selectedSubtitleStreamIndex);
  if (!wasPaused) {
    await tryPlay();
  }
  hideResolver();
  syncAudioState();
}

function refreshSubtitleOffsetApplication() {
  // Force the overlay to re-pick the active cue at the new offset, and shift
  // any native cues to match. Covers the paused case, where the RAF loop is
  // stopped and would not otherwise re-render.
  invalidateRenderedCue();
  subtitleOffset.applyToNativeTracks(video.textTracks);
  renderCustomSubtitleOverlay();
  syncAudioState();
}

function adjustSubtitleOffset(deltaMs = 0) {
  if (subtitleOffset.adjust(deltaMs, selectedSourceHash)) {
    refreshSubtitleOffsetApplication();
  }
}

function resetSubtitleOffset() {
  if (subtitleOffset.reset(selectedSourceHash)) {
    refreshSubtitleOffsetApplication();
  }
}

function getTimelineDurationSeconds() {
  const duration = Number(video.duration);
  if (Number.isFinite(duration) && duration > 0) {
    knownDurationSeconds = Math.max(knownDurationSeconds, duration);
  }
  return knownDurationSeconds;
}

function getDisplayDurationSeconds() {
  if (Number.isFinite(expectedDurationSeconds) && expectedDurationSeconds > 0) {
    return expectedDurationSeconds;
  }
  return getTimelineDurationSeconds();
}

function getSeekScaleDurationSeconds() {
  if (isLivePlayback) {
    const liveWindow = getLiveSeekableWindow();
    if (liveWindow?.duration > 0) {
      return liveWindow.duration;
    }
  }

  const displayDuration = getDisplayDurationSeconds();
  if (Number.isFinite(displayDuration) && displayDuration > 0) {
    return displayDuration;
  }
  return getTimelineDurationSeconds();
}

function getLiveBufferedSeekValue(liveWindow = getLiveSeekableWindow()) {
  if (!liveWindow || !video.buffered?.length) {
    return liveEdgePinned ? Number(seekBar.max) || 1000 : null;
  }

  const current = clampLiveSeekTargetSeconds(getEffectiveCurrentTime());
  let bufferedEnd = current;

  for (let index = 0; index < video.buffered.length; index += 1) {
    try {
      const start = Number(video.buffered.start(index));
      const end = Number(video.buffered.end(index));
      const containsCurrent = current >= start - 0.25 && current <= end + 0.25;
      if (containsCurrent) {
        bufferedEnd = Math.max(bufferedEnd, end);
      }
    } catch {
      // Ignore browser ranges that disappear during live playlist refresh.
    }
  }

  const max = Number(seekBar.max) || 1000;
  const clampedBufferedEnd = Math.max(
    liveWindow.start,
    Math.min(liveWindow.end, bufferedEnd),
  );
  return Math.round(
    ((clampedBufferedEnd - liveWindow.start) / liveWindow.duration) * max,
  );
}

function getBufferedSeekValue(totalDurationSeconds) {
  if (isLivePlayback) {
    return getLiveBufferedSeekValue();
  }

  if (
    !Number.isFinite(totalDurationSeconds) ||
    totalDurationSeconds <= 0 ||
    !video.buffered?.length
  ) {
    return null;
  }

  const current = Math.max(0, getEffectiveCurrentTime());
  let bufferedEnd = current;

  for (let index = 0; index < video.buffered.length; index += 1) {
    const start = video.buffered.start(index) + transcodeBaseOffsetSeconds;
    const end = video.buffered.end(index) + transcodeBaseOffsetSeconds;
    const containsCurrent = current >= start - 0.25 && current <= end + 0.25;
    if (containsCurrent) {
      bufferedEnd = Math.max(bufferedEnd, end);
    }
  }

  const clampedBuffered = Math.min(
    totalDurationSeconds,
    Math.max(current, bufferedEnd),
  );
  const max = Number(seekBar.max) || 1000;
  return Math.round((clampedBuffered / totalDurationSeconds) * max);
}

function paintSeekProgress(progressValue, bufferedValue = null) {
  const max = Number(seekBar.max) || 1000;
  const clamped = Math.max(0, Math.min(max, Number(progressValue) || 0));
  const bufferedClamped = Math.max(
    clamped,
    Math.min(
      max,
      Number.isFinite(Number(bufferedValue)) ? Number(bufferedValue) : clamped,
    ),
  );
  if (seekPlayedProgress) seekPlayedProgress.value = clamped;
  if (seekBufferedProgress) seekBufferedProgress.value = bufferedClamped;
}

function syncDurationText(elapsedSeconds = getEffectiveCurrentTime()) {
  if (isLivePlayback) {
    durationText.classList.add("is-live");
    durationText.setAttribute("aria-label", "Live stream");
    durationText.textContent = "LIVE";
    return;
  }

  durationText.classList.remove("is-live");
  durationText.setAttribute("aria-label", "Time remaining");
  const safeElapsedSeconds = Number(elapsedSeconds);
  const displayDurationSeconds = getDisplayDurationSeconds();
  const clampedElapsedSeconds = Math.max(
    0,
    Math.min(
      Number.isFinite(displayDurationSeconds) && displayDurationSeconds > 0
        ? displayDurationSeconds
        : Number.POSITIVE_INFINITY,
      Number.isFinite(safeElapsedSeconds) ? safeElapsedSeconds : 0,
    ),
  );
  const remainingSeconds =
    Number.isFinite(displayDurationSeconds) && displayDurationSeconds > 0
      ? Math.max(0, displayDurationSeconds - clampedElapsedSeconds)
      : 0;
  durationText.textContent = formatTime(remainingSeconds);
}

function openSpeedPopover({ auto = false } = {}) {
  if (!speedControl) {
    return;
  }

  closeLiveStreamPopover(false);
  closeSourcePopover(false);
  closeEpisodesPopover(false);
  closeHlsQualityPopover(false);
  window.clearTimeout(speedPopoverCloseTimeout);
  speedControl.classList.add("is-open");
  toggleSpeed.setAttribute("aria-expanded", "true");
  if (auto) {
    markPopoverAutoOpened(speedControl);
  }
}

function closeSpeedPopover(withDelay = true) {
  if (!speedControl) {
    return;
  }

  window.clearTimeout(speedPopoverCloseTimeout);

  const close = () => {
    if (speedControl.matches(":hover, :focus-within")) {
      return;
    }

    speedControl.classList.remove("is-open");
    clearPopoverAutoOpen(speedControl);
    toggleSpeed.setAttribute("aria-expanded", "false");
  };

  if (!withDelay) {
    close();
    return;
  }

  speedPopoverCloseTimeout = window.setTimeout(close, 140);
}

function openHlsQualityPopover({ auto = false } = {}) {
  if (!hlsQualityControl || !hlsQualityControls.shouldShowControl() || isResolvingSource()) {
    return;
  }

  closeLiveStreamPopover(false);
  closeSourcePopover(false);
  closeEpisodesPopover(false);
  closeAudioPopover();
  closeSpeedPopover(false);
  window.clearTimeout(hlsQualityPopoverCloseTimeout);
  hlsQualityControls.renderOptions();
  showControls();
  clearControlsHideTimer();
  hlsQualityControl.classList.add("is-open");
  toggleHlsQuality?.setAttribute("aria-expanded", "true");
  if (auto) {
    markPopoverAutoOpened(hlsQualityControl);
  }
}

function closeHlsQualityPopover(withDelay = false, { force = false } = {}) {
  if (!hlsQualityControl) {
    return;
  }

  window.clearTimeout(hlsQualityPopoverCloseTimeout);

  const close = () => {
    if (!force && hlsQualityControl.matches(":hover, :focus-within")) {
      return;
    }
    hlsQualityControl.classList.remove("is-open");
    clearPopoverAutoOpen(hlsQualityControl);
    toggleHlsQuality?.setAttribute("aria-expanded", "false");
  };

  if (!withDelay) {
    close();
    return;
  }

  hlsQualityPopoverCloseTimeout = window.setTimeout(close, 140);
}

function openAudioPopover({ auto = false } = {}) {
  if (!audioControl || !shouldShowAudioSubtitleControl()) {
    return;
  }

  if (
    resolverOverlay &&
    !resolverOverlay.hidden &&
    resolverOverlay.classList.contains("is-error")
  ) {
    hideResolver();
  }

  if (isResolvingSource()) {
    return;
  }

  closeLiveStreamPopover(false);
  closeSourcePopover(false);
  closeEpisodesPopover(false);
  closeHlsQualityPopover(false);
  window.clearTimeout(audioPopoverCloseTimeout);
  if (isTmdbResolvedPlayback && !availablePlaybackSources.length) {
    void fetchTmdbSourceOptionsViaBackend();
  }
  syncSourcePanelVisibility();
  audioControl.classList.add("is-open");
  playerShell?.classList.add("audio-popover-open");
  toggleAudio?.setAttribute("aria-expanded", "true");
  if (auto) {
    markPopoverAutoOpened(audioControl);
  }
}

function closeAudioPopover(withDelay = false, { force = false } = {}) {
  if (!audioControl) {
    return;
  }

  window.clearTimeout(audioPopoverCloseTimeout);

  const close = () => {
    if (!force && audioControl.matches(":hover, :focus-within")) {
      return;
    }

    audioControl.classList.remove("is-open");
    clearPopoverAutoOpen(audioControl);
    playerShell?.classList.remove("audio-popover-open");
    toggleAudio?.setAttribute("aria-expanded", "false");
  };

  if (!withDelay) {
    close();
    return;
  }

  audioPopoverCloseTimeout = window.setTimeout(close, 140);
}

function clearStreamStallRecovery() {
  window.clearTimeout(streamStallRecoveryTimeout);
  streamStallRecoveryTimeout = null;
}

function scheduleStreamStallRecovery(
  message = "Playback stalled. Retrying from here...",
) {
  if ((!isTmdbResolvedPlayback && !isLivePlayback) || video.paused) {
    return;
  }

  const checkpointTime = getEffectiveCurrentTime();
  clearStreamStallRecovery();

  streamStallRecoveryTimeout = window.setTimeout(() => {
    if ((!isTmdbResolvedPlayback && !isLivePlayback) || video.paused) {
      return;
    }

    const nowTime = getEffectiveCurrentTime();
    if (nowTime > checkpointTime + 0.8 || video.readyState >= 3) {
      return;
    }

    if (isLivePlayback) {
      void attemptAutomaticLiveStreamFallback(
        "Live stream stalled. Trying another source...",
      );
      return;
    }

    schedulePlaybackRecovery(
      isBrowserOffline() ? "offline" : "buffering",
      message,
    );
  }, playbackRecoveryStallDelayMs);
}

function resetAudioDecodeWatchState() {
  audioDecodeWatchState = null;
}

function clearAudioDecodeWatch() {
  if (audioDecodeWatchInterval !== null) {
    window.clearInterval(audioDecodeWatchInterval);
    audioDecodeWatchInterval = null;
  }
  audioDecodeWatchState = null;
  audioDecodeRecoveryInFlight = false;
}

function getMediaDecodeCounter(name) {
  const value = Number(video?.[name]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function shouldExpectAudioForCurrentSource() {
  return (
    availableAudioTracks.length > 0 ||
    selectedAudioStreamIndex >= 0 ||
    activeAudioStreamIndex >= 0
  );
}

function getCurrentAudioRecoverySourceKey() {
  const source = String(
    video.currentSrc ||
      video.getAttribute("src") ||
      lastRequestedPlaybackSource ||
      lastRequestedAbsolutePlaybackSource ||
      "",
  ).trim();
  const input =
    activeTrackSourceInput ||
    activeTranscodeInput ||
    extractPlaybackSourceInput(source) ||
    source;
  const audioStreamIndex =
    activeAudioStreamIndex >= 0 ? activeAudioStreamIndex : selectedAudioStreamIndex;
  return [
    input,
    `audio:${Number.isFinite(audioStreamIndex) ? audioStreamIndex : -1}`,
    `source:${normalizeSourceHash(selectedSourceHash)}`,
  ].join("|");
}

function syncAudioDecodeRecoverySourceKey() {
  const sourceKey = getCurrentAudioRecoverySourceKey();
  if (sourceKey && sourceKey !== audioDecodeRecoverySourceKey) {
    audioDecodeRecoverySourceKey = sourceKey;
    audioDecodeRecoveryAttempts = 0;
  }
  return sourceKey;
}

function shouldWatchAudioDecodeProgress() {
  if (
    !video ||
    !hasActiveSource() ||
    video.paused ||
    video.ended ||
    video.seeking ||
    video.readyState < 2 ||
    isResolvingSource() ||
    video.muted ||
    clampPlayerVolume(video.volume) <= 0.001 ||
    !shouldExpectAudioForCurrentSource()
  ) {
    return false;
  }

  const now = performance.now();
  if (
    now - lastPlaybackSourceSetAt < audioDecodeGraceAfterSourceChangeMs ||
    now - lastPlaybackSeekAt < audioDecodeGraceAfterSeekMs
  ) {
    return false;
  }

  return getMediaDecodeCounter("webkitAudioDecodedByteCount") !== null;
}

function recoverSilentAudioPlayback() {
  const now = performance.now();
  const sourceKey = syncAudioDecodeRecoverySourceKey();
  if (
    !sourceKey ||
    audioDecodeRecoveryInFlight ||
    audioDecodeRecoveryAttempts >= audioDecodeRecoveryMaxAttempts ||
    now - lastAudioDecodeRecoveryAt < audioDecodeRecoveryCooldownMs
  ) {
    return false;
  }

  audioDecodeRecoveryInFlight = true;
  audioDecodeRecoveryAttempts += 1;
  lastAudioDecodeRecoveryAt = now;
  resetAudioDecodeWatchState();

  if (isTmdbResolvedPlayback && attemptTmdbRecovery("Switching source...")) {
    audioDecodeRecoveryInFlight = false;
    return true;
  }

  showResolver("Audio stalled. Reconnecting stream...", {
    isRecovery: true,
    showStatus: true,
    title: "Restoring audio",
    detail: "Restarting the media pipeline from your current position.",
    countdown: "",
    showRetry: true,
    showAlternate: isTmdbResolvedPlayback,
  });

  const retried = retryCurrentPlaybackFromSavedPosition();
  if (!retried) {
    schedulePlaybackRecovery("buffering", "Audio stalled. Retrying playback...", {
      delayMs: 0,
    });
  }

  window.clearTimeout(audioDecodeRecoveryResetTimeout);
  audioDecodeRecoveryResetTimeout = window.setTimeout(() => {
    audioDecodeRecoveryInFlight = false;
  }, audioDecodeGraceAfterSourceChangeMs);
  return true;
}

function checkAudioDecodeProgress() {
  if (!shouldWatchAudioDecodeProgress()) {
    resetAudioDecodeWatchState();
    return;
  }

  const now = performance.now();
  const sourceKey = syncAudioDecodeRecoverySourceKey();
  const audioBytes = getMediaDecodeCounter("webkitAudioDecodedByteCount");
  if (!sourceKey || audioBytes === null) {
    resetAudioDecodeWatchState();
    return;
  }

  const currentTime = getEffectiveCurrentTime();
  const videoBytes = getMediaDecodeCounter("webkitVideoDecodedByteCount");
  const previous = audioDecodeWatchState;
  if (
    !previous ||
    previous.sourceKey !== sourceKey ||
    audioBytes < previous.audioBytes ||
    currentTime < previous.currentTime - 0.5
  ) {
    audioDecodeWatchState = {
      sourceKey,
      audioBytes,
      videoBytes,
      currentTime,
      lastAudioAdvanceAt: now,
      lastAudioAdvanceCurrentTime: currentTime,
    };
    return;
  }

  const audioAdvanced = audioBytes > previous.audioBytes;
  const videoAdvanced =
    currentTime > previous.currentTime + 0.7 ||
    (videoBytes !== null &&
      previous.videoBytes !== null &&
      videoBytes > previous.videoBytes);

  audioDecodeWatchState = {
    sourceKey,
    audioBytes,
    videoBytes,
    currentTime,
    lastAudioAdvanceAt: audioAdvanced ? now : previous.lastAudioAdvanceAt,
    lastAudioAdvanceCurrentTime: audioAdvanced
      ? currentTime
      : previous.lastAudioAdvanceCurrentTime,
  };

  if (audioAdvanced || !videoAdvanced) {
    return;
  }

  const stalledForMs = now - previous.lastAudioAdvanceAt;
  const videoAdvancedSeconds =
    currentTime - previous.lastAudioAdvanceCurrentTime;
  if (
    stalledForMs >= audioDecodeStallGraceMs &&
    videoAdvancedSeconds >= audioDecodeVideoAdvanceThresholdSeconds
  ) {
    recoverSilentAudioPlayback();
  }
}

function startAudioDecodeWatch() {
  if (audioDecodeWatchInterval !== null) {
    return;
  }
  audioDecodeWatchInterval = window.setInterval(
    checkAudioDecodeProgress,
    audioDecodeWatchIntervalMs,
  );
}

function clearControlsHideTimer() {
  window.clearTimeout(controlsHideTimeout);
}

function clearSingleClickPlaybackToggle() {
  if (singleClickPlaybackToggleTimeout !== null) {
    window.clearTimeout(singleClickPlaybackToggleTimeout);
    singleClickPlaybackToggleTimeout = null;
  }
}

function markPopoverAutoOpened(control) {
  if (control instanceof Element) {
    popoverAutoOpenedAt.set(control, performance.now());
  }
}

function consumeRecentPopoverAutoOpen(control) {
  if (!(control instanceof Element)) {
    return false;
  }
  const openedAt = popoverAutoOpenedAt.get(control);
  popoverAutoOpenedAt.delete(control);
  return (
    Number.isFinite(openedAt) &&
    performance.now() - openedAt <= popoverAutoOpenGraceMs
  );
}

function clearPopoverAutoOpen(control) {
  if (control instanceof Element) {
    popoverAutoOpenedAt.delete(control);
  }
}

function renderSourceOptionsWhenStable() {
  renderSourceOptionButtons();
  syncAudioState();
}

function hideControls() {
  if (video.paused && !isLiveIframePlaybackActive()) {
    return;
  }

  closeSpeedPopover(false);
  closeLiveStreamPopover(false);
  closeSourcePopover(false);
  closeEpisodesPopover(false);
  closeAudioPopover();
  playerShell.classList.add("controls-hidden");
}

function showControls() {
  playerShell.classList.remove("controls-hidden");
}

function scheduleControlsHide() {
  clearControlsHideTimer();
  if ((video.paused && !isLiveIframePlaybackActive()) || isResolvingSource()) {
    return;
  }

  controlsHideTimeout = window.setTimeout(hideControls, controlsHideDelayMs);
}

function handleUserActivity() {
  showControls();
  scheduleControlsHide();
}

function syncLiveSeekState() {
  syncDurationText();

  if (isDraggingSeek) {
    return;
  }

  const liveWindow = getLiveSeekableWindow();
  const max = Number(seekBar.max) || 1000;
  if (!liveWindow?.duration) {
    seekBar.value = liveEdgePinned ? String(max) : seekBar.value;
    paintSeekProgress(seekBar.value, liveEdgePinned ? max : null);
    return;
  }

  const liveEdgeTarget = getLiveEdgeTargetSeconds(liveWindow);
  const current = clampLiveSeekTargetSeconds(getEffectiveCurrentTime());
  if (
    !liveEdgePinned &&
    Number.isFinite(liveEdgeTarget) &&
    shouldPinLiveEdgeFromTarget(current, liveEdgeTarget)
  ) {
    liveEdgePinned = true;
  }

  const displayedCurrent = liveEdgePinned
    ? liveWindow.end
    : clampLiveSeekTargetSeconds(getEffectiveCurrentTime());
  const seekValue = liveEdgePinned
    ? max
    : Math.round(
        ((displayedCurrent - liveWindow.start) / liveWindow.duration) * max,
      );
  seekBar.value = String(Math.max(0, Math.min(max, seekValue)));
  paintSeekProgress(
    seekBar.value,
    liveEdgePinned ? max : getLiveBufferedSeekValue(liveWindow),
  );
}

function syncSeekState() {
  if (isLivePlayback) {
    syncLiveSeekState();
    return;
  }

  const seekScaleDurationSeconds = getSeekScaleDurationSeconds();
  if (isDraggingSeek) {
    if (seekScaleDurationSeconds > 0) {
      syncDurationText(
        (Number(seekBar.value) / 1000) * seekScaleDurationSeconds,
      );
    } else {
      syncDurationText();
    }
    return;
  }

  syncDurationText();
  if (seekScaleDurationSeconds <= 0) {
    return;
  }

  const effectiveCurrent = getEffectiveCurrentTime();
  const seekValue = Math.round(
    (effectiveCurrent / seekScaleDurationSeconds) * 1000,
  );
  seekBar.value = Math.max(0, Math.min(1000, seekValue));
  paintSeekProgress(
    seekBar.value,
    getBufferedSeekValue(seekScaleDurationSeconds),
  );
  syncEpisodeProgressIndicators();
}

function persistResumeTime(force = false) {
  if (isLivePlayback) {
    maybeRecordLiveWatch();
    return;
  }

  const effectiveCurrentTime = Math.max(0, getEffectiveCurrentTime());
  if (!Number.isFinite(effectiveCurrentTime)) {
    return;
  }

  if (shouldHoldProgressSaveForInitialResume(effectiveCurrentTime)) {
    if (!applyInitialResumeIfReady()) {
      scheduleInitialResumeRetry();
    }
    return;
  }

  const seekScaleDurationSeconds = getSeekScaleDurationSeconds();
  const isIframeProgressEstimate = isLiveIframePlaybackActive();
  const isNearEnd =
    !isIframeProgressEstimate &&
    Number.isFinite(seekScaleDurationSeconds) &&
    seekScaleDurationSeconds > 0 &&
    effectiveCurrentTime >=
      Math.max(
        0,
        seekScaleDurationSeconds - RESUME_CLEAR_AT_END_THRESHOLD_SECONDS,
      );

  try {
    if (isNearEnd) {
      localStorage.removeItem(resumeStorageKey);
      removeContinueWatchingEntry();
      fetchUserApi("/api/user/watch-progress", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: replaySafeMutationBody({ sourceIdentity }),
        keepalive: Boolean(force),
      }).catch(() => {});
      resumeTime = 0;
      lastPersistedResumeTime = 0;
      lastPersistedResumeAt = 0;
      syncEpisodeProgressIndicators();
      return;
    }

    if (effectiveCurrentTime < 1) {
      return;
    }

    const now = Date.now();
    if (!force) {
      if (now - lastPersistedResumeAt < RESUME_SAVE_MIN_INTERVAL_MS) {
        return;
      }
      if (
        Math.abs(effectiveCurrentTime - lastPersistedResumeTime) <
        RESUME_SAVE_MIN_DELTA_SECONDS
      ) {
        return;
      }
    }

    const cappedResumeTime =
      isIframeProgressEstimate &&
      Number.isFinite(seekScaleDurationSeconds) &&
      seekScaleDurationSeconds > RESUME_CLEAR_AT_END_THRESHOLD_SECONDS + 1
        ? Math.min(
            effectiveCurrentTime,
            Math.max(1, seekScaleDurationSeconds - RESUME_CLEAR_AT_END_THRESHOLD_SECONDS),
          )
        : effectiveCurrentTime;
    const nextResumeTime = Number(cappedResumeTime.toFixed(2));
    localStorage.setItem(resumeStorageKey, String(nextResumeTime));
    persistContinueWatchingEntry(nextResumeTime);
    resumeTime = nextResumeTime;
    lastPersistedResumeTime = nextResumeTime;
    lastPersistedResumeAt = now;
    syncEpisodeProgressIndicators();

    // Sync watch progress to server in background
    fetchUserApi("/api/user/watch-progress", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: replaySafeMutationBody({ sourceIdentity, resumeSeconds: nextResumeTime }),
      keepalive: Boolean(force),
    }).catch(() => {});

    syncContinueWatchingEntryToServer(nextResumeTime, {
      keepalive: Boolean(force),
    });
  } catch {
    // Ignore storage access issues.
  }
}

async function tryPlay() {
  if (isLiveIframePlaybackActive()) {
    liveIframePlaybackClock.play();
    syncPlayState();
    return;
  }

  const attributeSource = video.getAttribute("src") || "";
  const fallbackRequestedSource =
    lastRequestedAbsolutePlaybackSource ||
    (lastRequestedPlaybackSource
      ? new URL(lastRequestedPlaybackSource, window.location.origin).toString()
      : "");
  const restoreSource =
    !attributeSource && fallbackRequestedSource
      ? fallbackRequestedSource
      : video.currentSrc || attributeSource || fallbackRequestedSource;
  const hasStoppedOrEndedSource =
    Boolean(restoreSource) &&
    (!hasActiveSource() ||
      video.ended ||
      video.networkState === 0);

  if (
    restoreSource &&
    !hasActiveSource() &&
    shouldUseHlsJsForSource(restoreSource)
  ) {
    const absoluteRestoreSource = new URL(
      restoreSource,
      window.location.origin,
    ).toString();
    if (
      !hlsPlaybackController.isActive() &&
      !hlsPlaybackController.isPendingSource(absoluteRestoreSource)
    ) {
      setVideoSource(restoreSource, { resetInitialResume: false });
    }
    armLiveStartupHealthWatch();
    syncPlayState();
    return;
  }

  if (hasStoppedOrEndedSource) {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.setAttribute("src", restoreSource);
    video.load();
  }

  if (!hasActiveSource()) {
    return;
  }

  armLiveStartupHealthWatch();
  try {
    await video.play();
  } catch (error) {
    if (isLivePlayback && isPlaybackBlockedByPolicy(error)) {
      clearLiveStartupHealthWatch({ resetRequest: true });
    }
    syncPlayState();
    if (isManualSourceSwitchPending() && !isPlaybackBlockedByPolicy(error)) {
      throw error;
    }
  }
}

async function togglePlayback() {
  if (!hasRecoverablePlaybackSource() || isResolvingSource()) {
    return;
  }

  const isIframePlayback = isLiveIframePlaybackActive();
  const isPaused = isIframePlayback
    ? liveIframePlaybackClock.isPaused()
    : video.paused;
  if (isPaused) {
    await tryPlay();
  } else if (isIframePlayback) {
    liveIframePlaybackClock.pause();
  } else {
    video.pause();
  }

  syncPlayState();
}

function seekToAbsoluteTime(
  targetSeconds,
  { showLoading = false, isInitialResume = false } = {},
) {
  let clampedTarget = Math.max(0, Number(targetSeconds) || 0);
  if (isLivePlayback) {
    clampedTarget = clampLiveSeekTargetSeconds(clampedTarget);
    if (!isInitialResume) {
      updateLiveEdgePinFromTarget(clampedTarget);
    }
  }
  lastPlaybackSeekAt = performance.now();
  resetAudioDecodeWatchState();
  if (!isInitialResume) {
    markInitialResumeHandled();
  }
  if (showLoading) {
    showSeekLoadingIndicator();
  }
  if (!isTranscodeSourceActive()) {
    if (isLivePlayback) {
      video.currentTime = clampedTarget;
      return;
    }
    if (Number.isFinite(video.duration) && video.duration > 0) {
      video.currentTime = Math.min(video.duration, clampedTarget);
    } else {
      video.currentTime = clampedTarget;
    }
    return;
  }

  if (!activeTranscodeInput) {
    return;
  }

  const shouldResumePlayback = !video.paused;
  setVideoSource(
    buildSoftwareDecodeUrl(
      activeTranscodeInput,
      clampedTarget,
      activeAudioStreamIndex,
      activeAudioSyncMs || preferredAudioSyncMs,
      selectedSubtitleStreamIndex,
    ),
    { resetInitialResume: false },
  );
  if (shouldResumePlayback) {
    void tryPlay();
  }
}

function getSeekRatioFromPointerEvent(event) {
  if (!seekBar || !event) {
    return null;
  }
  const rect = seekBar.getBoundingClientRect();
  const clientX = Number(event.clientX);
  if (!Number.isFinite(clientX) || rect.width <= 0) {
    return null;
  }
  return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
}

function setPendingSeekRatio(ratio) {
  const seekScaleDurationSeconds = getSeekScaleDurationSeconds();
  if (
    !Number.isFinite(ratio) ||
    seekScaleDurationSeconds <= 0 ||
    !hasActiveSource() ||
    isResolvingSource()
  ) {
    return false;
  }

  const clampedRatio = Math.max(0, Math.min(1, ratio));
  seekBar.value = String(Math.round(clampedRatio * 1000));
  syncDurationText(clampedRatio * seekScaleDurationSeconds);
  paintSeekProgress(
    seekBar.value,
    getBufferedSeekValue(seekScaleDurationSeconds),
  );

  if (isTranscodeSourceActive()) {
    pendingTranscodeSeekRatio = clampedRatio;
  } else {
    pendingStandardSeekRatio = clampedRatio;
  }
  return true;
}

function isBrowserOffline() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function clearPlaybackRecoveryTimers() {
  if (playbackRecoveryTimeout !== null) {
    window.clearTimeout(playbackRecoveryTimeout);
    playbackRecoveryTimeout = null;
  }
  if (playbackRecoveryCountdownInterval !== null) {
    window.clearInterval(playbackRecoveryCountdownInterval);
    playbackRecoveryCountdownInterval = null;
  }
}

function clearPlaybackRecovery({ hideOverlay = true } = {}) {
  clearPlaybackRecoveryTimers();
  playbackRecoveryMode = "";
  playbackRecoveryAttemptCount = 0;
  playbackRecoverySequence += 1;
  pendingRecoverySeekSeconds = null;
  if (
    hideOverlay &&
    resolverOverlay &&
    resolverOverlay.classList.contains("is-recovery")
  ) {
    hideResolver();
  }
}

function getPlaybackRecoveryCopy(mode) {
  if (mode === "offline") {
    return {
      title: "No connection",
      message: "You appear to be offline. Playback will resume when the connection returns.",
    };
  }
  if (mode === "server") {
    return {
      title: "Server unavailable",
      message: "Your server is not responding. Retrying automatically...",
    };
  }
  return {
    title: "Connection is slow",
    message: "Playback stalled. Retrying the stream from here...",
  };
}

function getPlaybackRecoveryDelayMs(mode) {
  if (mode === "offline" || mode === "server") {
    return 5000;
  }
  return Math.min(
    playbackRecoveryMaxDelayMs,
    playbackRecoveryInitialDelayMs + playbackRecoveryAttemptCount * 2000,
  );
}

function updatePlaybackRecoveryCountdown(deadlineMs) {
  if (!resolverCountdown) {
    return;
  }
  const remainingSeconds = Math.max(
    1,
    Math.ceil((deadlineMs - Date.now()) / 1000),
  );
  resolverCountdown.textContent = `Retrying in ${remainingSeconds}s`;
  resolverCountdown.hidden = false;
}

function showPlaybackRecoveryOverlay(mode, message, delayMs) {
  const copy = getPlaybackRecoveryCopy(mode);
  const canTryAlternate = isTmdbResolvedPlayback && mode !== "offline";
  const detail =
    mode === "offline"
      ? "Keep this screen open. We will reconnect automatically."
      : "Your position is saved for this retry.";
  showResolver(message || copy.message, {
    isRecovery: true,
    showStatus: true,
    title: copy.title,
    detail,
    countdown: `Retrying in ${Math.max(1, Math.ceil(delayMs / 1000))}s`,
    showRetry: true,
    showAlternate: canTryAlternate,
  });
}

function shouldUseQuietTmdbRecovery(mode) {
  return isTmdbResolvedPlayback && mode === "buffering";
}

function schedulePlaybackRecovery(
  mode,
  message = "",
  { delayMs = null, resetAttempts = false } = {},
) {
  // A manually selected source is still establishing (resolving, fetching its
  // playlist, or buffering a far-seek segment on a cold transcode). Buffering is not a
  // startup failure, so don't roll back to the previous source here: the restore
  // watchdog reverts only after sustained no-progress, and a genuine media/HLS error
  // reverts via the error path (handlePlaybackErrorRecovery).
  if (isManualSourceSwitchPending()) {
    return true;
  }

  if (!playerShell && !hasRecoverablePlaybackSource() && !isTmdbResolvedPlayback) {
    return false;
  }

  const normalizedMode = mode || (isBrowserOffline() ? "offline" : "buffering");
  if (resetAttempts || playbackRecoveryMode !== normalizedMode) {
    playbackRecoveryAttemptCount = 0;
  }
  playbackRecoveryMode = normalizedMode;
  const effectiveDelayMs =
    shouldUseQuietTmdbRecovery(normalizedMode)
      ? 0
      : delayMs === null
        ? getPlaybackRecoveryDelayMs(normalizedMode)
        : delayMs;
  const sequence = (playbackRecoverySequence += 1);
  const deadlineMs = Date.now() + effectiveDelayMs;

  clearPlaybackRecoveryTimers();
  if (shouldUseQuietTmdbRecovery(normalizedMode)) {
    showResolver(message || "Switching source...");
    playbackRecoveryTimeout = window.setTimeout(() => {
      if (sequence !== playbackRecoverySequence) {
        return;
      }
      void runPlaybackRecoveryAttempt(sequence, normalizedMode);
    }, effectiveDelayMs);
    return true;
  }

  showPlaybackRecoveryOverlay(normalizedMode, message, effectiveDelayMs);
  updatePlaybackRecoveryCountdown(deadlineMs);
  playbackRecoveryCountdownInterval = window.setInterval(() => {
    if (sequence !== playbackRecoverySequence) {
      return;
    }
    updatePlaybackRecoveryCountdown(deadlineMs);
  }, 250);
  playbackRecoveryTimeout = window.setTimeout(() => {
    if (sequence !== playbackRecoverySequence) {
      return;
    }
    void runPlaybackRecoveryAttempt(sequence, normalizedMode);
  }, effectiveDelayMs);
  return true;
}

async function checkPlaybackServerHealth() {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => {
    controller.abort();
  }, playbackRecoveryServerTimeoutMs);
  try {
    const response = await fetch("/api/health", {
      cache: "no-store",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function applyPendingRecoverySeek() {
  if (pendingRecoverySeekSeconds === null || isTranscodeSourceActive()) {
    return;
  }
  const targetSeconds = Math.max(0, Number(pendingRecoverySeekSeconds) || 0);
  if (targetSeconds <= 1 || !hasActiveSource()) {
    pendingRecoverySeekSeconds = null;
    return;
  }
  try {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      video.currentTime = Math.min(video.duration - 0.25, targetSeconds);
    } else {
      video.currentTime = targetSeconds;
    }
    pendingRecoverySeekSeconds = null;
  } catch {
    // Try again on the next metadata/canplay event.
  }
}

function retryCurrentPlaybackFromSavedPosition() {
  const requestedSource =
    lastRequestedPlaybackSource ||
    lastRequestedAbsolutePlaybackSource ||
    video.currentSrc ||
    video.getAttribute("src") ||
    "";
  if (!requestedSource) {
    return false;
  }

  const resumeAt = Math.max(0, Math.floor(getEffectiveCurrentTime()));
  if (isTranscodeSourceActive() && activeTranscodeInput) {
    setVideoSource(
      buildSoftwareDecodeUrl(
        activeTranscodeInput,
        resumeAt,
        activeAudioStreamIndex,
        activeAudioSyncMs || preferredAudioSyncMs,
        selectedSubtitleStreamIndex,
      ),
      { resetInitialResume: false },
    );
  } else {
    pendingRecoverySeekSeconds = resumeAt;
    setVideoSource(requestedSource, { resetInitialResume: false });
  }
  void tryPlay();
  return true;
}

async function runPlaybackRecoveryAttempt(sequence, mode) {
  clearPlaybackRecoveryTimers();
  if (sequence !== playbackRecoverySequence) {
    return;
  }
  playbackRecoveryAttemptCount += 1;

  if (isBrowserOffline()) {
    schedulePlaybackRecovery("offline", "", { delayMs: 5000 });
    return;
  }

  if (shouldUseQuietTmdbRecovery(mode)) {
    showResolver("Switching source...");
    if (attemptTmdbRecovery("Switching source...")) {
      clearPlaybackRecovery({ hideOverlay: false });
      return;
    }
    if (retryCurrentPlaybackFromSavedPosition()) {
      showResolver("Reconnecting stream...");
      return;
    }
    showResolverError("Unable to resume this stream. Try another source.");
    return;
  }

  showResolver("Checking connection...", {
    isRecovery: true,
    showStatus: true,
    title: "Reconnecting",
    detail: "Checking your server before resuming playback.",
    countdown: "",
    showRetry: true,
    showAlternate: isTmdbResolvedPlayback && mode !== "offline",
  });

  const serverHealthy = await checkPlaybackServerHealth();
  if (sequence !== playbackRecoverySequence) {
    return;
  }
  if (!serverHealthy) {
    schedulePlaybackRecovery("server", "", { delayMs: 5000 });
    return;
  }

  if (
    mode === "buffering" &&
    playbackRecoveryAttemptCount >= 3 &&
    attemptTmdbRecovery("Trying another source...")
  ) {
    clearPlaybackRecovery({ hideOverlay: false });
    return;
  }

  if (retryCurrentPlaybackFromSavedPosition()) {
    showResolver("Reconnecting stream...", {
      isRecovery: true,
      showStatus: true,
      title: "Resuming",
      detail: "Trying again from your current position.",
      countdown: "",
      showRetry: true,
      showAlternate: isTmdbResolvedPlayback,
    });
    return;
  }

  if (attemptTmdbRecovery("Trying another source...")) {
    clearPlaybackRecovery({ hideOverlay: false });
    return;
  }

  showResolverError("Unable to resume this stream. Try again.");
}

function retryPlaybackRecoveryNow() {
  const mode = playbackRecoveryMode || (isBrowserOffline() ? "offline" : "buffering");
  const sequence = (playbackRecoverySequence += 1);
  clearPlaybackRecoveryTimers();
  void runPlaybackRecoveryAttempt(sequence, mode);
}

function pickResolverAlternateSourceHash({
  allowPreviouslyFailedFallback = true,
} = {}) {
  return pickResolverAlternateSourceHashFromRouting({
    availablePlaybackSources,
    resolverFailedSourceHashes,
    selectedSourceHash,
    allowPreviouslyFailedFallback,
  });
}

async function resolveTmdbFromResolverAction({
  sourceHash = "",
  isAlternate = false,
  suppressErrorUi = false,
} = {}) {
  if (!isTmdbResolvedPlayback) {
    retryPlaybackRecoveryNow();
    return false;
  }

  const normalizedSourceHash = normalizeSourceHash(sourceHash);
  const previousSourceHash = selectedSourceHash;
  const previousSourceSelectionPinned = sourceSelectionPinned;
  if (normalizedSourceHash) {
    selectedSourceHash = normalizedSourceHash;
    sourceSelectionPinned = true;
    applyPreferredSourceAudioSync(selectedSourceHash);
    persistSourceHashInUrl();
    syncAudioState();
  }

  tmdbResolveRetries = 0;
  const resumeFrom = getEffectiveCurrentTime();
  if (!suppressErrorUi) {
    showResolver(isAlternate ? "Trying another source..." : "Loading video...");
  }
  try {
    await resolveTmdbSourcesAndPlay({
      allowSourceFallback: !normalizedSourceHash,
      requiredSourceHash: normalizedSourceHash,
      startSeconds: resumeFrom,
    });
    return true;
  } catch (error) {
    if (normalizedSourceHash) {
      resolverFailedSourceHashes.add(normalizedSourceHash);
      selectedSourceHash = previousSourceHash;
      sourceSelectionPinned = previousSourceSelectionPinned;
      applyPreferredSourceAudioSync(selectedSourceHash);
      persistSourceHashInUrl();
      syncAudioState();
    }
    if (!suppressErrorUi) {
      console.error(
        isAlternate
          ? "Failed to switch TMDB playback source:"
          : "Failed to retry TMDB playback:",
        error,
      );
      showResolverError(
        error,
        isAlternate ? "Unable to start that source." : "Unable to resolve this stream.",
        { clearVideoSource: true },
      );
    }
    throw error;
  }
}

async function resolveAlternateTmdbSourceFromResolverError() {
  if (!availablePlaybackSources.length) {
    showResolver("Loading alternate sources...", { showStatus: true });
    await fetchTmdbSourceOptionsViaBackend();
  }

  const nextSourceHash = pickResolverAlternateSourceHash();
  if (!nextSourceHash) {
    showResolverError(
      "No alternate sources are available for this title.",
      "No alternate sources are available for this title.",
      {
        showRetry: false,
        showAlternate: false,
      },
    );
    return;
  }

  await resolveTmdbFromResolverAction({
    sourceHash: nextSourceHash,
    isAlternate: true,
  });
}

function retryResolverActionNow() {
  if (isTmdbResolvedPlayback) {
    void resolveTmdbFromResolverAction();
    return;
  }
  retryPlaybackRecoveryNow();
}

function tryAlternatePlaybackSourceNow() {
  if (
    isTmdbResolvedPlayback &&
    resolverOverlay &&
    resolverOverlay.classList.contains("is-error")
  ) {
    void resolveAlternateTmdbSourceFromResolverError().catch((error) => {
      console.error("Failed to load alternate TMDB source:", error);
      showResolverError(error, "Unable to load another source.", {
        clearVideoSource: true,
      });
    });
    return;
  }

  clearPlaybackRecovery({ hideOverlay: false });
  if (attemptTmdbRecovery("Trying another source...")) {
    return;
  }
  retryPlaybackRecoveryNow();
}

async function handlePlaybackErrorRecovery(message) {
  const fallbackMessage =
    String(message || "").trim() || "Resolved stream could not be played.";
  const manualSwitchRequest = manualSourceSwitch.getPending();
  if (manualSwitchRequest?.armed && !manualSwitchRequest.failureStarted) {
    return failPendingManualSourceSwitch(fallbackMessage);
  }
  if (manualSwitchRequest) {
    return true;
  }
  if (isBrowserOffline()) {
    schedulePlaybackRecovery("offline", "", { resetAttempts: true });
    return true;
  }

  const serverHealthy = await checkPlaybackServerHealth();
  if (!serverHealthy) {
    schedulePlaybackRecovery("server", "", { resetAttempts: true });
    return true;
  }

  if (
    attemptTmdbRecovery("Trying alternate source...", {
      failureMessage: fallbackMessage,
    })
  ) {
    return true;
  }

  showResolverError(fallbackMessage);
  return false;
}

function isSourceFallbackResolveError(error) {
  const status = Number(error?.status || 0);
  if (status === 424) {
    return true;
  }

  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("real-debrid blocked this source") ||
    message.includes("selected external hls source is unavailable") ||
    message.includes("external hls sources are unavailable") ||
    message.includes("all stream candidates failed")
  );
}

function getGallerySavePlayableCandidates(resolvedPayload = {}) {
  const rawCandidates = [
    resolvedPayload?.playableUrl,
    ...(Array.isArray(resolvedPayload?.fallbackUrls)
      ? resolvedPayload.fallbackUrls
      : []),
  ];
  return rawCandidates
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);
}

function buildGallerySavePayloadTemplate(
  resolvedPayload = {},
  { sourceOption = null } = {},
) {
  const metadata =
    resolvedPayload?.metadata && typeof resolvedPayload.metadata === "object"
      ? resolvedPayload.metadata
      : {};
  const optionName = sourceOption
    ? getSourceDisplayName(sourceOption)
    : "Stream source";
  return {
    tmdbId: String(metadata?.tmdbId || tmdbId || "").trim(),
    mediaType: String(metadata?.mediaType || mediaType || "movie")
      .trim()
      .toLowerCase(),
    title: String(metadata?.displayTitle || title || "").trim(),
    year: String(metadata?.displayYear || year || "").trim(),
    seasonNumber: Math.max(
      1,
      Math.floor(Number(metadata?.seasonNumber || seasonNumber || 1)),
    ),
    episodeNumber: Math.max(
      1,
      Math.floor(Number(metadata?.episodeNumber || episodeNumber || 1)),
    ),
    episodeTitle: String(metadata?.episodeTitle || "").trim(),
    thumb: String(thumbParam || "").trim(),
    description: "",
    filename: String(
      resolvedPayload?.filename || sourceOption?.filename || optionName,
    ).trim(),
  };
}

function isGalleryPlayableCandidateError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("playableurl") ||
    message.includes("real-debrid") ||
    message.includes("invalid")
  );
}

async function queueGallerySaveFromResolvedPayload(
  resolvedPayload = {},
  { sourceOption = null } = {},
) {
  const playableCandidates = getGallerySavePlayableCandidates(resolvedPayload);
  if (!playableCandidates.length) {
    throw new Error("Unable to resolve this source for download.");
  }

  const payloadTemplate = buildGallerySavePayloadTemplate(resolvedPayload, {
    sourceOption,
  });
  let lastCandidateError = null;
  for (const playableUrl of playableCandidates) {
    try {
      await requestJson("/api/gallery/save-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payloadTemplate,
          playableUrl,
        }),
      });
      return;
    } catch (error) {
      lastCandidateError = error;
      if (!isGalleryPlayableCandidateError(error)) {
        throw error;
      }
    }
  }

  if (lastCandidateError) {
    throw lastCandidateError;
  }
  throw new Error("Unable to queue this source for gallery save.");
}

async function queueGallerySaveIfRequested(resolvedPayload = {}) {
  if (!shouldSaveToGallery || hasQueuedGallerySave || !isTmdbResolvedPlayback) {
    return;
  }

  hasQueuedGallerySave = true;
  try {
    await queueGallerySaveFromResolvedPayload(resolvedPayload);
  } catch (error) {
    hasQueuedGallerySave = false;
    console.error("Failed to queue gallery save:", error);
  }
}

async function resolveTmdbMovieViaBackend(
  tmdbMovieId,
  {
    allowSourceFallback = true,
    requestSourceHash = "",
    resolveTimeoutMs = undefined,
    skipExternalEmbed = false,
    refreshResolve = false,
  } = {},
) {
  const buildQuery = ({
    sourceHash = "",
    sessionKey = "",
    includeSourceFilters = true,
    audioLang = preferredAudioLang,
    quality = preferredQuality,
    skipExternalEmbed: skipEmbed = skipExternalEmbed,
  } = {}) => {
    const query = new URLSearchParams({
      tmdbId: tmdbMovieId,
      title,
      year,
      audioLang,
      quality,
      resolverProvider: preferredResolverProvider,
    });
    if (skipEmbed) {
      query.set("skipExternalEmbed", "1");
    }
    if (refreshResolve) {
      query.set("refreshResolve", "1");
    }
    if (preferredSubtitleLang) {
      query.set("subtitleLang", preferredSubtitleLang);
    }
    if (sourceHash) {
      query.set("sourceHash", sourceHash);
    }
    if (sessionKey) {
      query.set("sessionKey", sessionKey);
    }
    if (includeSourceFilters) {
      if (preferredSourceMinSeeders > 0) {
        query.set("minSeeders", String(preferredSourceMinSeeders));
      }
      if (
        preferredSourceFormats.length > 0 &&
        preferredSourceFormats.length < supportedSourceFormats.length
      ) {
        query.set("allowedFormats", preferredSourceFormats.join(","));
      }
      query.set("sourceLang", preferredSourceLanguage);
      query.set("sourceAudioProfile", preferredSourceAudioProfile);
    }
    return query;
  };

  const requestedSourceHash = normalizeSourceHash(requestSourceHash);
  const requestTimeoutMs = normalizeRequestTimeoutMs(resolveTimeoutMs);
  const pinnedSourceHash = requestedSourceHash || getPinnedSourceHashForRequests();
  const pinnedSessionKey = requestedSourceHash ? "" : getPinnedSessionKeyForRequests();
  let lastError = null;
  try {
    return await requestResolveJson(
      `/api/resolve/movie?${buildQuery({
        sourceHash: pinnedSourceHash,
        sessionKey: pinnedSessionKey,
        includeSourceFilters: !pinnedSourceHash,
      }).toString()}`,
      requestTimeoutMs,
    );
  } catch (error) {
    if (isResolveAbortError(error)) {
      throw error;
    }
    lastError = error;
    if (allowSourceFallback && pinnedSourceHash) {
      const skipEmbedFallback =
        shouldAllowTorrentResolveFallback() &&
        (skipExternalEmbed || isSourceFallbackResolveError(error));
      try {
        return await requestResolveJson(
          `/api/resolve/movie?${buildQuery({
            skipExternalEmbed: skipEmbedFallback,
          }).toString()}`,
          requestTimeoutMs,
        );
      } catch (fallbackError) {
        if (isResolveAbortError(fallbackError)) {
          throw fallbackError;
        }
        lastError = fallbackError;
      }
    }
  }

  if (
    allowSourceFallback &&
    (isTransientResolveError(lastError) || isSourceFallbackResolveError(lastError))
  ) {
    return requestResolveJson(
      `/api/resolve/movie?${buildQuery({
        includeSourceFilters: false,
        audioLang: "auto",
        quality: shouldPreferMobileLightTmdbSources()
          ? preferredQuality
          : DEFAULT_STREAM_QUALITY_PREFERENCE,
        skipExternalEmbed: shouldAllowTorrentResolveFallback(),
      }).toString()}`,
      requestTimeoutMs,
    );
  }

  throw lastError;
}

async function resolveTmdbTvEpisodeViaBackend(
  tmdbSeriesId,
  season,
  episodeOrdinal,
  {
    allowContainerFallback = true,
    allowSourceFallback = true,
    requestSourceHash = "",
    resolveTimeoutMs = undefined,
    skipExternalEmbed = false,
    refreshResolve = false,
  } = {},
) {
  const buildQuery = (
    containerPreference = "",
    sourceHash = "",
    {
      sessionKey = "",
      includeSourceFilters = true,
      audioLang = preferredAudioLang,
      quality = preferredQuality,
      skipExternalEmbed: skipEmbed = skipExternalEmbed,
    } = {},
  ) => {
    const query = new URLSearchParams({
      tmdbId: tmdbSeriesId,
      title,
      year,
      seasonNumber: String(Math.max(1, Math.floor(Number(season) || 1))),
      episodeNumber: String(
        Math.max(1, Math.floor(Number(episodeOrdinal) || 1)),
      ),
      audioLang,
      quality,
      resolverProvider: preferredResolverProvider,
    });
    if (skipEmbed) {
      query.set("skipExternalEmbed", "1");
    }
    if (refreshResolve) {
      query.set("refreshResolve", "1");
    }
    if (preferredSubtitleLang) {
      query.set("subtitleLang", preferredSubtitleLang);
    }
    if (containerPreference) {
      query.set("preferredContainer", containerPreference);
    }
    if (sourceHash) {
      query.set("sourceHash", sourceHash);
    }
    if (sessionKey) {
      query.set("sessionKey", sessionKey);
    }
    if (includeSourceFilters) {
      if (preferredSourceMinSeeders > 0) {
        query.set("minSeeders", String(preferredSourceMinSeeders));
      }
      if (
        preferredSourceFormats.length > 0 &&
        preferredSourceFormats.length < supportedSourceFormats.length
      ) {
        query.set("allowedFormats", preferredSourceFormats.join(","));
      }
      query.set("sourceLang", preferredSourceLanguage);
      query.set("sourceAudioProfile", preferredSourceAudioProfile);
    }
    return query;
  };

  const requestedSourceHash = normalizeSourceHash(requestSourceHash);
  const requestTimeoutMs = normalizeRequestTimeoutMs(resolveTimeoutMs);
  const pinnedSourceHash = requestedSourceHash || getPinnedSourceHashForRequests();
  const pinnedSessionKey = requestedSourceHash ? "" : getPinnedSessionKeyForRequests();
  try {
    return await requestResolveJson(
      `/api/resolve/tv?${buildQuery(preferredContainer, pinnedSourceHash, {
        sessionKey: pinnedSessionKey,
        includeSourceFilters: !pinnedSourceHash,
      }).toString()}`,
      requestTimeoutMs,
    );
  } catch (error) {
    if (isResolveAbortError(error)) {
      throw error;
    }
    let lastError = error;
    const fallbackAttempts = [];
    const seen = new Set([`${preferredContainer}::${pinnedSourceHash}`]);
    const skipEmbedFallback =
      shouldAllowTorrentResolveFallback() &&
      (skipExternalEmbed || isSourceFallbackResolveError(error));

    const pushFallback = (
      containerPreference,
      sourceHashPreference,
      sessionKeyPreference = "",
    ) => {
      const key = `${containerPreference}::${sourceHashPreference}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      fallbackAttempts.push([containerPreference, sourceHashPreference, sessionKeyPreference]);
    };

    if (allowContainerFallback && preferredContainer) {
      pushFallback("", pinnedSourceHash, pinnedSessionKey);
    }
    if (allowSourceFallback && pinnedSourceHash) {
      pushFallback(preferredContainer, "");
    }
    if (
      allowContainerFallback &&
      allowSourceFallback &&
      preferredContainer &&
      pinnedSourceHash
    ) {
      pushFallback("", "");
    }

    for (const [fallbackContainer, fallbackSource, fallbackSessionKey] of fallbackAttempts) {
      try {
        return await requestResolveJson(
          `/api/resolve/tv?${buildQuery(fallbackContainer, fallbackSource, {
            sessionKey: fallbackSessionKey,
            includeSourceFilters: !fallbackSource,
            skipExternalEmbed: skipEmbedFallback,
          }).toString()}`,
          requestTimeoutMs,
        );
      } catch (fallbackError) {
        if (isResolveAbortError(fallbackError)) {
          throw fallbackError;
        }
        lastError = fallbackError;
      }
    }

    if (
      allowSourceFallback &&
      (isTransientResolveError(lastError) || isSourceFallbackResolveError(lastError))
    ) {
      return requestResolveJson(
        `/api/resolve/tv?${buildQuery("", "", {
          includeSourceFilters: false,
          audioLang: "auto",
          quality: shouldPreferMobileLightTmdbSources()
            ? preferredQuality
            : DEFAULT_STREAM_QUALITY_PREFERENCE,
          skipExternalEmbed: shouldAllowTorrentResolveFallback(),
        }).toString()}`,
        requestTimeoutMs,
      );
    }

    throw lastError;
  }
}

async function fetchTmdbSourceOptionsViaBackend({
  realDebridCacheRefresh = false,
  expectedRequestKey = "",
} = {}) {
  if (!isTmdbResolvedPlayback || !tmdbId) {
    availablePlaybackSources = [];
    isFetchingPlaybackSources = false;
    renderSourceOptionsWhenStable();
    return;
  }
  await loadUserRealDebridPlaybackSettings();
  clearDisabledTorrentPlaybackState();
  const pinnedSourceHash = getPinnedSourceHashForRequests();
  const query = buildTmdbSourceDiscoveryQuery({
    tmdbId, title, year, pinnedSourceHash,
    mediaType: isTmdbTvPlayback ? "tv" : "movie",
    audioLang: preferredAudioLang, quality: preferredQuality,
    resolverProvider: preferredResolverProvider,
    resultLimit: Math.max(preferredSourceResultsLimit, SOURCE_FETCH_BATCH_LIMIT),
    seasonNumber, episodeNumber, preferredContainer,
    minSeeders: preferredSourceMinSeeders,
    preferredSourceFormats, supportedSourceFormats,
    sourceLanguage: preferredSourceLanguage,
    sourceAudioProfile: preferredSourceAudioProfile,
  });
  const requestKey = query.toString();
  if (!realDebridSourceRefresh.prepareRequest({
    requestKey,
    refreshRequest: realDebridCacheRefresh,
    expectedRequestKey,
  })) {
    return;
  }

  isFetchingPlaybackSources = true;
  const requestToken = ++playbackSourcesRequestToken;
  renderSourceOptionsWhenStable();
  try {
    const payload = await requestJson(
      `/api/resolve/sources?${query.toString()}`,
      {},
      45000,
    );
    if (requestToken !== playbackSourcesRequestToken) {
      return;
    }
    const options = Array.isArray(payload?.sources) ? payload.sources : [];
    const previousSelectedSourceOption =
      getCurrentResolvedSourceOptionFallback(selectedSourceHash);
    const nextPlaybackSources = options
      .map((item) => ({
        ...item,
        sourceHash: normalizeSourceHash(
          item?.sourceHash || item?.infoHash || "",
        ),
      }))
      .filter((item) => Boolean(item.sourceHash));

    if (
      selectedSourceHash &&
      !nextPlaybackSources.some(
        (item) => item.sourceHash === selectedSourceHash,
      )
    ) {
      if (previousSelectedSourceOption) {
        nextPlaybackSources.unshift(previousSelectedSourceOption);
      } else if (!realDebridCacheRefresh) {
        selectedSourceHash = "";
        sourceSelectionPinned = false;
        applyPreferredSourceAudioSync(selectedSourceHash);
        persistSourceHashInUrl();
      }
    }
    availablePlaybackSources = sortSourcesBySeeders(nextPlaybackSources, {
      preferContainer: getSourceListPreferredContainer(),
    });
    realDebridSourceRefresh.observeSources({
      requestKey,
      refreshRequest: realDebridCacheRefresh,
      sources: nextPlaybackSources,
    });
    isFetchingPlaybackSources = false;
    // The unpinned playback resolve owns initial source choice. This endpoint
    // only enriches the menu; starting a second preferred resolve here can
    // discard a valid first result and leave the player without an owner.
    renderSourceOptionsWhenStable();
  } catch {
    if (requestToken !== playbackSourcesRequestToken) {
      return;
    }
    if (realDebridCacheRefresh) {
      realDebridSourceRefresh.observeSources({
        requestKey,
        refreshRequest: true,
        sources: availablePlaybackSources,
      });
      isFetchingPlaybackSources = false;
      renderSourceOptionsWhenStable();
      return;
    }
    realDebridSourceRefresh.cancelPending();
    availablePlaybackSources = [];
    isFetchingPlaybackSources = false;
    renderSourceOptionsWhenStable();
  }
}

function buildReproduciblePlaybackParams() {
  const nextParams = new URLSearchParams(params);
  const normalizedTitle = String(title || params.get("title") || "Title").trim();
  if (normalizedTitle) {
    nextParams.set("title", normalizedTitle);
  }
  const normalizedEpisode = String(episode || params.get("episode") || "").trim();
  if (normalizedEpisode) {
    nextParams.set("episode", normalizedEpisode);
  } else {
    nextParams.delete("episode");
  }

  if (src) {
    nextParams.set("src", src);
  } else {
    nextParams.delete("src");
  }
  if (tmdbId) {
    nextParams.set("tmdbId", tmdbId);
  } else {
    nextParams.delete("tmdbId");
  }
  if (mediaType === "movie" || mediaType === "tv") {
    nextParams.set("mediaType", mediaType);
  } else {
    nextParams.delete("mediaType");
  }
  if (year) {
    nextParams.set("year", year);
  } else {
    nextParams.delete("year");
  }

  if (mediaType === "tv" || isEpisodeListPlayback()) {
    nextParams.set("seasonNumber", String(Math.max(1, Math.floor(Number(seasonNumber) || 1))));
    nextParams.set("episodeNumber", String(Math.max(1, Math.floor(Number(episodeNumber) || 1))));
    if (Number.isFinite(Number(seriesEpisodeIndex)) && seriesEpisodeIndex >= 0) {
      nextParams.set("episodeIndex", String(Math.floor(Number(seriesEpisodeIndex))));
    }
    const resolvedSeriesId = String(activeSeries?.id || requestedSeriesId || "").trim();
    if (resolvedSeriesId) {
      nextParams.set("seriesId", resolvedSeriesId);
    }
  } else {
    nextParams.delete("seasonNumber");
    nextParams.delete("episodeNumber");
    nextParams.delete("episodeIndex");
    nextParams.delete("seriesId");
  }

  const normalizedSourceHash = normalizeSourceHash(selectedSourceHash);
  if (sourceSelectionPinned && normalizedSourceHash) {
    nextParams.set("sourceHash", normalizedSourceHash);
  } else {
    nextParams.delete("sourceHash");
  }
  nextParams.delete("sessionKey");
  nextParams.delete("audioSyncMs");

  if (preferredAudioLang && preferredAudioLang !== "auto") {
    nextParams.set("audioLang", preferredAudioLang);
  } else {
    nextParams.delete("audioLang");
  }
  if (shouldIncludePreferredQualityInUrl(preferredQuality)) {
    nextParams.set("quality", preferredQuality);
  } else {
    nextParams.delete("quality");
  }
  if (preferredContainer === "mp4" || preferredContainer === "mkv") {
    nextParams.set("preferredContainer", preferredContainer);
  } else {
    nextParams.delete("preferredContainer");
  }

  return nextParams;
}

// Address-bar URL once playback identity is settled. TMDB catalog titles get
// the short shareable path; the full reproducible params live in storage so a
// warm reload restores audio/quality/pinned-source/returnTo even though the
// URL no longer carries them. Everything else keeps the reproducible query.
// The catalogued live channel id behind the current playback, if any — from the
// short URL we arrived on, else reverse-mapped from the active stream source so
// even an old long live URL canonicalizes to /watch/live/<id>.
function getLiveCanonicalChannelId() {
  if (_watchPath?.kind === "live" && _watchPath.channelId) {
    return _watchPath.channelId;
  }
  if (isLivePlayback) {
    return findLiveChannelIdBySource(src) || "";
  }
  return "";
}

function buildCanonicalWatchUrl(nextParams) {
  if (isTmdbResolvedPlayback && tmdbId && (mediaType === "movie" || mediaType === "tv")) {
    return buildTmdbWatchPath({
      mediaType,
      tmdbId,
      title,
      seasonNumber:
        mediaType === "tv" ? Math.max(1, Math.floor(Number(seasonNumber) || 1)) : null,
      episodeNumber:
        mediaType === "tv" ? Math.max(1, Math.floor(Number(episodeNumber) || 1)) : null,
    });
  }
  const liveChannelId = getLiveCanonicalChannelId();
  if (liveChannelId) {
    return buildLiveWatchPath(liveChannelId);
  }
  return buildWatchUrl(nextParams);
}

function replaceReproducibleWatchUrl() {
  try {
    const nextParams = buildReproduciblePlaybackParams();
    for (const key of Array.from(params.keys())) {
      params.delete(key);
    }
    for (const [key, value] of nextParams.entries()) {
      params.set(key, value);
    }
    const canonicalUrl = buildCanonicalWatchUrl(nextParams);
    if (canonicalUrl.startsWith("/watch/")) {
      const isLiveCanonical = canonicalUrl.startsWith("/watch/live/");
      // Storage key matches the URL's own slug so a warm reload finds it.
      const slug = isLiveCanonical
        ? canonicalUrl.slice("/watch/live/".length)
        : slugify(title);
      // Don't canonicalize to a placeholder slug (e.g. /…/untitled) before the
      // TMDB title lands; a later pass rewrites it once the title resolves.
      if (!slug || (!isLiveCanonical && tmdbTitleIsMissing(title))) {
        return;
      }
      // Persist the reproducible params so a reload of the short path restores
      // full playback state (audio/quality/variant/pinned source) from storage.
      saveWatchParams(slug, nextParams.toString(), {
        tmdbId,
        seriesId: activeSeries?.id || requestedSeriesId || "",
      });
    }
    window.history.replaceState(null, "", canonicalUrl);
  } catch {
    // Cosmetic only; playback should keep going if history updates are blocked.
  }
}

function persistAudioLangInUrl() {
  replaceReproducibleWatchUrl();
}

function persistQualityInUrl() {
  replaceReproducibleWatchUrl();
}

function persistSourceHashInUrl() {
  replaceReproducibleWatchUrl();
}

function cleanUrlIfNeeded() {
  replaceReproducibleWatchUrl();
}

function findLocalMoviePlaybackEntry(libraryPayload) {
  const movies = Array.isArray(libraryPayload?.movies) ? libraryPayload.movies : [];
  const normalizedTmdbId = String(tmdbId || "").trim();
  const normalizedTitleSlug = slugify(title);
  const normalizedYear = String(year || "").trim();
  return (
    movies.find((movie) => {
      const localSrc = String(movie?.src || "").trim();
      if (!localSrc) {
        return false;
      }
      const movieTmdbId = String(movie?.tmdbId || "").trim();
      if (normalizedTmdbId && movieTmdbId && normalizedTmdbId === movieTmdbId) {
        return true;
      }
      const movieTitleSlug = slugify(movie?.title || "");
      const movieYear = String(movie?.year || "").trim();
      return Boolean(
        normalizedTitleSlug &&
          movieTitleSlug &&
          normalizedTitleSlug === movieTitleSlug &&
          (!normalizedYear || !movieYear || normalizedYear === movieYear),
      );
    }) || null
  );
}

function applyLocalMoviePlaybackEntry(localMovie) {
  const localSrc = normalizePlaybackSourceValue(localMovie?.src || "");
  if (!localSrc) {
    return false;
  }
  const currentSrc = normalizePlaybackSourceValue(src || "");
  if (currentSrc === localSrc && hasExplicitSource) {
    return false;
  }

  params.set("src", localSrc);
  if (localMovie?.title && !params.has("title")) {
    params.set("title", String(localMovie.title).trim());
  }
  if (localMovie?.tmdbId && !params.has("tmdbId")) {
    params.set("tmdbId", String(localMovie.tmdbId).trim());
  }
  if (localMovie?.year && !params.has("year")) {
    params.set("year", String(localMovie.year).trim());
  }
  if (localMovie?.thumb && !params.has("thumb")) {
    params.set("thumb", String(localMovie.thumb).trim());
  }
  if (!params.has("mediaType")) {
    params.set("mediaType", "movie");
  }

  rawSourceParam = localSrc;
  normalizedRawSourceParam = localSrc;
  src = localSrc;
  hasExplicitSource = true;
  isExplicitLocalUploadSource = computeIsExplicitLocalUploadSource();
  title = String(localMovie?.title || title || "").trim() || title;
  tmdbId = String(localMovie?.tmdbId || tmdbId || "").trim();
  mediaType = "movie";
  year = String(localMovie?.year || year || "").trim();
  isTmdbMoviePlayback = false;
  isTmdbTvPlayback = false;
  isTmdbResolvedPlayback = false;
  return true;
}

async function preferLocalMoviePlaybackSourceFromLibrary() {
  if (isLivePlayback || isSeriesPlayback) {
    return false;
  }
  const normalizedMediaType = String(mediaType || "").trim().toLowerCase();
  if (normalizedMediaType && normalizedMediaType !== "movie") {
    return false;
  }
  if (!tmdbId && !title) {
    return false;
  }

  try {
    const response = await fetch("/api/library", { cache: "no-store" });
    if (!response.ok) {
      return false;
    }
    const libraryPayload = await response.json();
    const localMovie = findLocalMoviePlaybackEntry(libraryPayload);
    return applyLocalMoviePlaybackEntry(localMovie);
  } catch {
    return false;
  }
}

// Rebuild live playback state from a catalog fallback entry (title, source,
// artwork, stream variants) and re-derive the source vars that depend on it.
function applyLiveChannelFallback(liveMatch) {
  if (!params.has("title")) params.set("title", liveMatch.title);
  if (!params.has("src")) params.set("src", liveMatch.source);
  if (!params.has("thumb") && liveMatch.thumb) params.set("thumb", liveMatch.thumb);
  if (!params.has("episode")) params.set("episode", "Live");
  params.set("live", "1");
  if (!params.has("liveStreamId")) {
    params.set("liveStreamId", liveMatch.defaultStreamId || "default");
  }
  if (!params.has("liveStreams")) {
    params.set("liveStreams", JSON.stringify(liveMatch.streams || []));
  }
  if (liveMatch.liveEmbed && !params.has("liveEmbed")) {
    params.set("liveEmbed", "1");
  }
  if (liveMatch.liveResolver && !params.has("liveResolver")) {
    params.set("liveResolver", liveMatch.liveResolver);
  }
  rawSourceParam = String(params.get("src") || "").trim();
  normalizedRawSourceParam = normalizePlaybackSourceValue(rawSourceParam);
  refreshLiveStreamStateFromParams(params);
  src = normalizedRawSourceParam;
  hasExplicitSource = Boolean(src);
  isExplicitLocalUploadSource = computeIsExplicitLocalUploadSource();
  title = params.get("title") || title;
  episode = params.get("episode") || episode;
}

async function initPlaybackSource() {
  // Ensure local series library is loaded before resolving playback
  await _seriesLibraryReady;

  // ─── Cold short live URL: rebuild stream set from the channel catalog ───
  if (_needsLiveResolve && _watchPath) {
    const _liveMatch = LIVE_CHANNEL_PLAYBACK_FALLBACKS[_watchPath.channelId] || null;
    if (_liveMatch) {
      applyLiveChannelFallback(_liveMatch);
    }
  }

  // ─── Cold short tmdb URL: hydrate title/year/poster from TMDB ───
  if (_needsTmdbResolve && _watchPath) {
    try {
      const _detailQuery = new URLSearchParams({
        tmdbId: _watchPath.tmdbId,
        mediaType: _watchPath.mediaType,
      });
      const _details = await requestJson(
        `/api/tmdb/details?${_detailQuery.toString()}`,
        {},
        25000,
      );
      // TMDB is authoritative for a cold short URL: overwrite rather than
      // fill-if-absent, since an early reproducible-URL pass can seed a
      // placeholder "Untitled" title into params before this runs.
      const _resolvedTitle = String(_details?.title || _details?.name || "").trim();
      if (_resolvedTitle) {
        params.set("title", _resolvedTitle);
      }
      const _releaseDate = String(
        _details?.release_date || _details?.first_air_date || "",
      ).trim();
      if (_releaseDate.length >= 4) {
        params.set("year", _releaseDate.slice(0, 4));
      }
      const _posterPath = String(
        _details?.poster_path || _details?.backdrop_path || "",
      ).trim();
      if (_posterPath) {
        params.set("thumb", `https://image.tmdb.org/t/p/w1280${_posterPath}`);
        thumbParam = params.get("thumb");
      }
    } catch {
      // Best-effort; playback can still resolve from the tmdbId alone.
    }
  }

  // ─── Clean URL slug resolution (on refresh with no query params) ───
  if (_needsSlugResolve && _watchPath) {
    try {
      const _libResp = await fetch("/api/library");
      if (_libResp.ok) {
        const _lib = await _libResp.json();
        const _slug = _watchPath.slug;
        const _movies = Array.isArray(_lib?.movies) ? _lib.movies : [];
        const _allSeries = Array.isArray(_lib?.series) ? _lib.series : [];
        const _movieMatch = _movies.find((m) => slugify(m.title) === _slug);
        const _librarySeriesMatch = _allSeries.find((s) => slugify(s.title) === _slug);
        const _staticSeriesLookup = findSeriesEntryBySlug(_slug, SERIES_LIBRARY);
        const _seriesMatch = _librarySeriesMatch || (_staticSeriesLookup
          ? { id: _staticSeriesLookup.id, ..._staticSeriesLookup.entry }
          : null);
        const _liveMatch = LIVE_CHANNEL_PLAYBACK_FALLBACKS[_slug] || null;
        if (_liveMatch) {
          applyLiveChannelFallback(_liveMatch);
        } else if (_movieMatch) {
          if (!params.has("title")) params.set("title", _movieMatch.title);
          if (!params.has("src") && _movieMatch.src) params.set("src", _movieMatch.src);
          if (!params.has("tmdbId") && _movieMatch.tmdbId) params.set("tmdbId", _movieMatch.tmdbId);
          if (!params.has("year") && _movieMatch.year) params.set("year", _movieMatch.year);
          if (!params.has("thumb") && _movieMatch.thumb) params.set("thumb", _movieMatch.thumb);
          if (!params.has("mediaType")) params.set("mediaType", "movie");
          // Re-derive source variables from updated params
          rawSourceParam = String(params.get("src") || "").trim();
          normalizedRawSourceParam = normalizePlaybackSourceValue(rawSourceParam);
          src = normalizedRawSourceParam;
          hasExplicitSource = Boolean(src);
          isExplicitLocalUploadSource = computeIsExplicitLocalUploadSource();
          title = params.get("title") || title;
          tmdbId = String(params.get("tmdbId") || "").trim();
          mediaType = String(params.get("mediaType") || "").trim().toLowerCase();
          year = String(params.get("year") || "").trim();
          isTmdbMoviePlayback = Boolean(!hasExplicitSource && tmdbId && mediaType === "movie");
          isTmdbTvPlayback = Boolean(!hasExplicitSource && tmdbId && mediaType === "tv");
          isTmdbResolvedPlayback = Boolean(isTmdbMoviePlayback || isTmdbTvPlayback);
        } else if (_seriesMatch) {
          if (!params.has("title")) params.set("title", _seriesMatch.title);
          if (!params.has("seriesId")) params.set("seriesId", _seriesMatch.id);
          if (!params.has("mediaType")) params.set("mediaType", "tv");
          if (!params.has("episodeIndex")) params.set("episodeIndex", _watchPath.episodeIndex || "0");
          if (!params.has("tmdbId") && _seriesMatch.tmdbId) params.set("tmdbId", _seriesMatch.tmdbId);
          if (!params.has("year") && _seriesMatch.year) params.set("year", _seriesMatch.year);
          // Re-derive series resolution variables from updated params
          mediaTypeParam = String(params.get("mediaType") || "").trim().toLowerCase();
          isExplicitTvPlayback = mediaTypeParam === "tv";
          requestedSeriesId = String(params.get("seriesId") || "").trim().toLowerCase();
          hasRequestedEpisodeIndexParam = params.has("episodeIndex");
          requestedEpisodeIndex = Number(params.get("episodeIndex") || 0);
          title = params.get("title") || title;
        }
      }
    } catch { /* slug resolution is best-effort */ }
  }

  _resolved = resolveSeriesMatch();
  explicitSeriesPlayback = _resolved.explicit;
  inferredSeriesPlayback = _resolved.inferred;
  activeSeriesMatch = _resolved.match;
  activeSeries = _resolved.series;
  seriesEpisodes = _resolved.episodes;
  seriesEpisodeIndex = _resolved.epIndex;
  activeSeriesEpisode = _resolved.ep;
  isSeriesPlayback = _resolved.isSeries;
  hasSeriesEpisodeControls =
    isSeriesPlayback && Boolean(activeSeries && seriesEpisodes.length > 1);
  normalizedSeriesSourceParam = _resolved.normSrc;
  src = isSeriesPlayback
    ? normalizedSeriesSourceParam || normalizedRawSourceParam
    : normalizedRawSourceParam;
  rawTitle = isSeriesPlayback
    ? String(activeSeries?.title || "")
    : params.get("title") || "Untitled";
  rawEpisode = isSeriesPlayback
    ? getSeriesEpisodeLabel(
        seriesEpisodeIndex,
        activeSeriesEpisode?.title || "",
        activeSeries,
        Number(activeSeriesEpisode?.episodeNumber || seriesEpisodeIndex + 1),
      )
    : normalizeLiveEpisodeLabel(params.get("episode") || "");
  title = rawTitle;
  episode = rawEpisode;
  tmdbId = String(activeSeries?.tmdbId || params.get("tmdbId") || "").trim();
  mediaType = isSeriesPlayback ? "tv" : mediaTypeParam;
  year = String(activeSeries?.year || params.get("year") || "").trim();
  seasonNumber = isSeriesPlayback
    ? Math.max(1, Math.floor(Number(activeSeriesEpisode?.seasonNumber || 1)))
    : Number.isFinite(fallbackSeasonNumber)
      ? Math.max(1, Math.floor(fallbackSeasonNumber))
      : 1;
  episodeNumber = isSeriesPlayback
    ? Math.max(
        1,
        Math.floor(
          Number(activeSeriesEpisode?.episodeNumber || seriesEpisodeIndex + 1),
        ),
      )
    : Number.isFinite(fallbackEpisodeNumber)
      ? Math.max(1, Math.floor(fallbackEpisodeNumber))
      : 1;
  preferredContainerParam = String(
    activeSeries?.preferredContainer || params.get("preferredContainer") || "",
  ).trim().toLowerCase();
  preferredContainer =
    preferredContainerParam === "mp4" || preferredContainerParam === "mkv"
      ? preferredContainerParam
      : "";
  hasExplicitSource = Boolean(src);
  isExplicitLocalUploadSource = computeIsExplicitLocalUploadSource();
  isTmdbMoviePlayback = Boolean(!hasExplicitSource && tmdbId && mediaType === "movie");
  isTmdbTvPlayback = Boolean(!hasExplicitSource && tmdbId && mediaType === "tv");
  isTmdbResolvedPlayback = Boolean(isTmdbMoviePlayback || isTmdbTvPlayback);
  applyMobileLightTmdbDefaults();
  await preferLocalMoviePlaybackSourceFromLibrary();
  if (isTmdbTvPlayback && !isSeriesPlayback) {
    await hydrateTmdbTvEpisodeCatalog();
    hasSeriesEpisodeControls =
      isEpisodeListPlayback() && Boolean(seriesEpisodes.length > 1);
  }
  // Playback identity is settled; reveal identity-gated controls together
  // instead of letting each pop in as resolution/playback progresses.
  setEpisodeLabel(title, episode);
  syncSeriesControls();
  syncTmdbSourceControls();
  if (_isCleanUrl && _watchPath?.slug && params.toString()) {
    saveWatchParams(_watchPath.slug, params.toString(), {
      tmdbId,
      seriesId: requestedSeriesId || activeSeries?.id || "",
    });
  }
  sourceIdentity = isSeriesPlayback
    ? `series:${activeSeries.id}:episode:${seriesEpisodeIndex}`
    : isLivePlayback
      ? `live:${slugify(title) || "stream"}`
    : src ||
      (isTmdbResolvedPlayback
        ? `tmdb:${mediaType}:${tmdbId}${isTmdbTvPlayback ? `:s${seasonNumber}:e${episodeNumber}` : ""}`
        : `watch:${slugify(title) || "untitled"}`);
  prepareLiveFailureCacheForCurrentEvent();
  selectRememberedWorkingLiveStreamIfNeeded();
  selectFirstFreshLiveStreamIfNeeded();
  resumeStorageKey = `streamarena-resume:${sourceIdentity}`;
  // The RD-settings and continue-watching round-trips are independent of each
  // other, but were previously awaited back-to-back — a full serialized RTT
  // added to every cold open. Start both in flight now and await each only
  // where its result is actually consumed: RD settings before the torrent-pin
  // decisions just below, the continue-watching entry before the resume
  // position is settled further down.
  const userRealDebridSettingsReady = isTmdbResolvedPlayback
    ? loadUserRealDebridPlaybackSettings()
    : null;
  // Self-contained ~5s timeout + catch so a slow or failed endpoint degrades
  // to the localStorage resume path (exactly like the old inline try/catch)
  // instead of stalling playback start — and so a rejection that lands while
  // the RD await is still pending can't surface as an unhandled rejection.
  const serverContinueWatchingFetch = isTmdbResolvedPlayback
    ? (async () => {
        const abortController = new AbortController();
        const abortTimer = setTimeout(() => abortController.abort(), 5000);
        try {
          const res = await fetchUserApi("/api/user/continue-watching", {
            signal: abortController.signal,
          });
          return res.ok ? await res.json() : null;
        } catch {
          return null;
        } finally {
          clearTimeout(abortTimer);
        }
      })()
    : null;
  if (userRealDebridSettingsReady) {
    await userRealDebridSettingsReady;
  }
  applyRememberedTmdbSourcePin();
  clearDisabledTorrentPlaybackState();

  // Re-read resume time with the (possibly updated) storage key.
  try {
    const storedResume = Number(localStorage.getItem(resumeStorageKey));
    if (Number.isFinite(storedResume) && storedResume > 0) {
      resumeTime = storedResume;
      lastPersistedResumeTime = storedResume;
    }
  } catch {}
  if (serverContinueWatchingFetch) {
    try {
      const data = await serverContinueWatchingFetch;
      const entry = (data?.entries || []).find(
        (e) => e.sourceIdentity === sourceIdentity,
      );
      if (entry) {
        rememberServerContinueWatchingEntry(entry);
        applyRememberedTmdbSourcePin({ force: true });
        clearDisabledTorrentPlaybackState();
        if (
          !(resumeTime > 1) &&
          Number.isFinite(entry.resumeSeconds) &&
          entry.resumeSeconds > 1
        ) {
          resumeTime = entry.resumeSeconds;
          lastPersistedResumeTime = entry.resumeSeconds;
          resetInitialResumeApplication();
          try {
            localStorage.setItem(resumeStorageKey, String(entry.resumeSeconds));
          } catch {}
        }
      }
    } catch {}
  }

  // If localStorage still has no resume, try the lighter progress endpoint.
  if (!(resumeTime > 1)) {
    try {
      const res = await fetchUserApi("/api/user/watch-progress");
      if (res.ok) {
        const data = await res.json();
        const entry = (data?.entries || []).find(
          (e) => e.sourceIdentity === sourceIdentity,
        );
        if (entry && Number.isFinite(entry.resumeSeconds) && entry.resumeSeconds > 1) {
          resumeTime = entry.resumeSeconds;
          lastPersistedResumeTime = entry.resumeSeconds;
          resetInitialResumeApplication();
          try {
            localStorage.setItem(resumeStorageKey, String(entry.resumeSeconds));
          } catch {}
        }
      }
    } catch {}
  }
  if (resumeTime > 1) {
    persistContinueWatchingEntry(resumeTime);
  }

  resetInitialResumeApplication();
  pendingTranscodeSeekRatio = null;
  availableAudioTracks = [];
  availableSubtitleTracks = [];
  selectedAudioStreamIndex = -1;
  selectedSubtitleStreamIndex = -1;
  activeTrackSourceInput = "";
  clearSubtitleTrack();
  hideAllSubtitleTracks();
  renderLiveStreamOptions();
  syncLiveStreamControls();
  rebuildTrackOptionButtons();

  if (hasExplicitSource) {
    expectedDurationSeconds = 0;
    hideResolver();
    if (isLivePlayback) {
      syncDurationText();
      resetLiveAutoFallbackAttempts();
      availableAudioTracks = [];
      availableSubtitleTracks = [];
      selectedAudioStreamIndex = -1;
      selectedSubtitleStreamIndex = -1;
      activeTrackSourceInput = "";
      clearSubtitleTrack();
      hideAllSubtitleTracks();
      rebuildTrackOptionButtons();
      showResolver("Loading live stream...");
      try {
        const playbackSource = await resolveLivePlaybackSource(src, {
          preflight: true,
        });
        setVideoSource(playbackSource);
        hideResolver();
        await tryPlay();
      } catch (error) {
        if (liveStreamOptions.length > 1) {
          const recovered = await attemptAutomaticLiveStreamFallback(
            "Live stream failed. Trying another source...",
          );
          if (recovered) {
            cleanUrlIfNeeded();
            return;
          }
        } else {
          showResolverError(error, "Unable to resolve this stream.");
        }
        cleanUrlIfNeeded();
        return;
      }
      cleanUrlIfNeeded();
      return;
    }

    await resolveExplicitSourceTrackSelection(src);
    const subtitleStreamPreferenceBeforeResolve =
      getStoredSubtitleStreamPreferenceForCurrentPlayback();
    applyStoredSubtitleSelectionPreference();
    persistSubtitleLangPreference(preferredSubtitleLang);
    if (
      subtitleStreamPreferenceBeforeResolve.mode !== "unset" ||
      selectedSubtitleStreamIndex >= 0 ||
      preferredSubtitleLang === "off"
    ) {
      persistSubtitleStreamPreference(selectedSubtitleStreamIndex);
    }
    rebuildTrackOptionButtons();
    const localUploadSource = isExplicitLocalUploadSource;
    const selectedSubtitleTrack = getSubtitleTrackByStreamIndex(
      selectedSubtitleStreamIndex,
    );
    const shouldUseNativeSubtitleTrack = shouldUseNativeEmbeddedSubtitleTrack(
      selectedSubtitleTrack,
    );
    const shouldForceAudioRemux =
      !benchmarkModeEnabled && shouldForceRemuxForEmbeddedAudio();
    const shouldUseRemux =
      shouldUseSoftwareDecode(src) ||
      shouldForceAudioRemux ||
      (!localUploadSource && selectedAudioStreamIndex >= 0) ||
      shouldUseNativeSubtitleTrack;
    const remuxSubtitleStreamIndex = shouldUseNativeSubtitleTrack
      ? selectedSubtitleStreamIndex
      : -1;
    const remuxSource = shouldUseRemux
      ? buildSoftwareDecodeUrl(
          src,
          0,
          selectedAudioStreamIndex,
          preferredAudioSyncMs,
          remuxSubtitleStreamIndex,
        )
      : src;
    const nextSource = shouldUseRemux
      ? buildPreferredBrowserPlaybackSource(
          remuxSource,
          src,
          selectedAudioStreamIndex,
          remuxSubtitleStreamIndex,
        )
      : src;
    if (nextSource === src && !(await localLibraryPlaybackSourceExists(src))) {
      showResolverError(
        "This local video file is missing from the library.",
        "Unable to load this title.",
        {
          clearVideoSource: true,
          showRetry: false,
          showAlternate: false,
        },
      );
      cleanUrlIfNeeded();
      return;
    }
    setVideoSource(nextSource, { startSeconds: getInitialPlaybackStartSeconds() });
    applySubtitleTrackByStreamIndex(selectedSubtitleStreamIndex);
    await tryPlay();
    cleanUrlIfNeeded();
    return;
  }

  if (
    isSeriesPlayback &&
    seriesRequiresLocalEpisodeSources() &&
    !hasExplicitSource
  ) {
    expectedDurationSeconds = 0;
    video.removeAttribute("src");
    video.load();
    showResolver("This episode is unavailable until its MP4 source is added.", {
      showStatus: true,
      isError: true,
    });
    return;
  }

  if (!isTmdbResolvedPlayback) {
    expectedDurationSeconds = 0;
    if (!src) {
      video.removeAttribute("src");
      video.load();
      showResolver(
        "Unable to load this title. Open it again from the home screen or check that the video is in your library.",
        { showStatus: true, isError: true },
      );
      return;
    }
    if (!(await localLibraryPlaybackSourceExists(src))) {
      showResolverError(
        "This local video file is missing from the library.",
        "Unable to load this title.",
        {
          clearVideoSource: true,
          showRetry: false,
          showAlternate: false,
        },
      );
      return;
    }
    setVideoSource(src, { startSeconds: getInitialPlaybackStartSeconds() });
    hideResolver();
    await tryPlay();
    return;
  }

  try {
    showResolver("Loading video...");
    await resolveTmdbSourcesAndPlay();
  } catch (error) {
    console.error("Failed to resolve TMDB playback:", error);
    showResolverError(error, "Unable to resolve this stream.", {
      clearVideoSource: true,
    });
  }

  cleanUrlIfNeeded();
}

  // ─── Speed option refs (collected after mount) ───
  function collectSpeedOptionRefs() {
    if (playerShell) {
      speedOptions = Array.from(playerShell.querySelectorAll(".speed-option"));
    }
  }

  // ─── Global event handler references for cleanup ───
  let _handleKeydownRef;
  function handleGlobalKeydown(e) { if (_handleKeydownRef) _handleKeydownRef(e); }
  function handleGlobalMousemove() { handleUserActivity(); }
  function handleGlobalBeforeunload() {
    clearSingleClickPlaybackToggle();
  hideSeekLoadingIndicator();
  clearControlsHideTimer();
  clearStreamStallRecovery();
  clearLiveVisualHealthWatch({ resetSamples: true });
  clearLiveStartupHealthWatch({ resetRequest: true });
  clearPlaybackRecovery();
  persistResumeTime(true);
}
  function handleDocumentVisibilityChange() {
    if (document.visibilityState === "hidden") {
      handleGlobalBeforeunload();
      liveIframePlaybackClock.suspend();
      return;
    }
    liveIframePlaybackClock.resume();
    startLiveVisualHealthWatch();
  }

  function animateSeekTurn(control, direction) {
    if (!control) {
      return;
    }

    const className =
      direction === "backward" ? "is-turning-backward" : "is-turning-forward";
    control.classList.remove("is-turning-backward", "is-turning-forward");
    void control.offsetWidth;
    control.classList.add(className);
  }

  function clearSeekTurnAnimation(control) {
    control?.classList.remove("is-turning-backward", "is-turning-forward");
  }

  function seekByJumpSeconds(direction) {
    if (!hasActiveSource() || isResolvingSource()) {
      return;
    }

    if (direction === "backward") {
      animateSeekTurn(rewind10, "backward");
      seekToAbsoluteTime(getEffectiveCurrentTime() - SEEK_JUMP_SECONDS);
      return;
    }

    animateSeekTurn(forward10, "forward");
    seekToAbsoluteTime(getEffectiveCurrentTime() + SEEK_JUMP_SECONDS);
  }

  onMount(() => {
    collectSpeedOptionRefs();
    startAudioDecodeWatch();
    const _deferLabel = _needsSlugResolve || _needsTmdbResolve || _needsLiveResolve;
    setEpisodeLabel(_deferLabel ? "" : title, _deferLabel ? "" : episode);

    resumeFlushIntervalId = window.setInterval(() => {
      persistResumeTime(false);
    }, RESUME_FLUSH_INTERVAL_MS);

    // Benchmark API (needs video ref)
    if (benchmarkModeEnabled) {
      playbackBenchmark = createPlaybackBenchmarkApi({
        video,
        getEffectiveCurrentTime,
        getDisplayDurationSeconds,
        extractPlaybackSourceInput,
        tryPlay,
        seekToAbsoluteTime,
        buildSoftwareDecodeUrl,
        buildHlsPlaybackUrl,
        setVideoSource,
        getPreferredRemuxVideoMode: () => preferredRemuxVideoMode,
        getPreferredAudioSyncMs: () => preferredAudioSyncMs,
      });
      window.__STREAMARENA_PLAYBACK_BENCHMARK__ = playbackBenchmark;
    }

    // Deferred to after initPlaybackSource resolves (needs series library)

enableAudiblePlaybackByDefault();

trackListener(goBack, "click", () => {
  navigateBackFromPlayer();
});

trackListener(togglePlay, "click", togglePlayback);

trackListener(rewind10, "click", () => {
  seekByJumpSeconds("backward");
});

trackListener(forward10, "click", () => {
  seekByJumpSeconds("forward");
});

[rewind10, forward10].forEach((seekControl) => {
  trackListener(seekControl, "animationend", (event) => {
    if (String(event.animationName || "").startsWith("seek-turn-")) {
      clearSeekTurnAnimation(seekControl);
    }
  });
});

trackListener(toggleMutePlayer, "click", () => {
  if (isResolvingSource()) {
    return;
  }

  togglePlayerMute();
});

if (volumeSlider) {
  trackListener(volumeSlider, "input", () => {
    if (isResolvingSource()) {
      return;
    }

    setPlayerVolume(Number(volumeSlider.value) / 100);
    showControls();
    clearControlsHideTimer();
  });

  trackListener(volumeSlider, "change", () => {
    scheduleControlsHide();
  });
}

if (volumeControl) {
  trackListener(volumeControl, "mouseenter", () => {
    showControls();
    clearControlsHideTimer();
  });

  trackListener(volumeControl, "mouseleave", () => {
    scheduleControlsHide();
  });

  trackListener(volumeControl, "focusin", () => {
    showControls();
    clearControlsHideTimer();
  });

  trackListener(volumeControl, "focusout", () => {
    window.setTimeout(() => {
      if (!volumeControl.matches(":hover, :focus-within")) {
        scheduleControlsHide();
      }
    }, 0);
  });
}

attachFullscreenControl({
  getContext: getFullscreenContext,
  trackListener,
  onLayoutChange: refreshActiveSubtitlePlacement,
});

if (nextEpisode) {
  trackListener(nextEpisode, "click", () => {
    if (!hasSeriesEpisodeControls || isResolvingSource()) {
      return;
    }
    navigateToSeriesEpisode(seriesEpisodeIndex + 1);
  });
}

// Auto-play overlay buttons.
if (autoPlayBtn) {
  trackListener(autoPlayBtn, "click", () => {
    const next = getNextPlayableEpisode();
    if (next) {
      hideAutoPlayOverlay();
      navigateToSeriesEpisode(next.index);
    }
  });
}
if (autoPlayCancel) {
  trackListener(autoPlayCancel, "click", () => {
    cancelAutoPlay();
  });
}

if (resolverRetryButton) {
  trackListener(resolverRetryButton, "click", () => {
    retryResolverActionNow();
  });
}
if (resolverAlternateButton) {
  trackListener(resolverAlternateButton, "click", () => {
    tryAlternatePlaybackSourceNow();
  });
}

trackListener(window, "offline", () => {
  schedulePlaybackRecovery("offline", "", { resetAttempts: true });
});
trackListener(window, "online", () => {
  if (playbackRecoveryMode === "offline" || playbackRecoveryMode === "server") {
    retryPlaybackRecoveryNow();
  }
});

trackListener(toggleSpeed, "click", (event) => {
  event.preventDefault();
  if (!speedControl || isResolvingSource()) {
    return;
  }

  const shouldOpen =
    !speedControl.classList.contains("is-open") ||
    consumeRecentPopoverAutoOpen(speedControl);
  if (shouldOpen) {
    openSpeedPopover();
  } else {
    closeSpeedPopover(false);
  }
});

if (toggleHlsQuality) {
  trackListener(toggleHlsQuality, "click", (event) => {
    event.preventDefault();
    if (!hlsQualityControl || !hlsQualityControls.shouldShowControl() || isResolvingSource()) {
      return;
    }

    const shouldOpen =
      !hlsQualityControl.classList.contains("is-open") ||
      consumeRecentPopoverAutoOpen(hlsQualityControl);
    if (shouldOpen) {
      openHlsQualityPopover();
    } else {
      closeHlsQualityPopover(false, { force: true });
    }
  });
}

if (toggleEpisodes) {
  trackListener(toggleEpisodes, "click", (event) => {
    event.preventDefault();
    if (!episodesControl || isResolvingSource()) {
      return;
    }

    const shouldOpen =
      !episodesControl.classList.contains("is-open") ||
      consumeRecentPopoverAutoOpen(episodesControl);
    if (shouldOpen) {
      openEpisodesPopover({ sticky: true });
    } else {
      closeEpisodesPopover();
    }
  });
}

if (episodesBackToSeasons) {
  trackListener(episodesBackToSeasons, "click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!hasSeriesEpisodeControls || isResolvingSource()) {
      return;
    }
    episodesMenuMode = "seasons";
    renderSeriesEpisodePreview();
  });
}

if (toggleLiveStream) {
  trackListener(toggleLiveStream, "click", (event) => {
    event.preventDefault();
    if (!liveStreamControl || isResolvingSource()) {
      return;
    }

    openLiveStreamPopover();
  });
}

if (toggleSource) {
  trackListener(toggleSource, "pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    sourceTogglePointerDownAt = Date.now();
    toggleSourcePopoverFromControl();
  });
  trackListener(toggleSource, "click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (Date.now() - sourceTogglePointerDownAt < 500) {
      return;
    }
    toggleSourcePopoverFromControl();
  });
}

if (toggleAudio) {
  trackListener(toggleAudio, "click", (event) => {
    event.preventDefault();
    if (!audioControl || !shouldShowAudioSubtitleControl() || isResolvingSource()) {
      return;
    }

    const shouldOpen =
      !audioControl.classList.contains("is-open") ||
      consumeRecentPopoverAutoOpen(audioControl);
    if (shouldOpen) {
      openAudioPopover();
    } else {
      closeAudioPopover();
    }
  });
}

if (speedControl) {
  trackListener(speedControl, "mouseenter", () =>
    openSpeedPopover({ auto: true }),
  );
  trackListener(speedControl, "mouseleave", () => closeSpeedPopover(true));
  trackListener(speedControl, "focusin", () =>
    openSpeedPopover({ auto: true }),
  );
  trackListener(speedControl, "focusout", () => closeSpeedPopover(true));
}

if (hlsQualityControl) {
  trackListener(hlsQualityControl, "mouseenter", () => {
    if (isResolvingSource()) {
      return;
    }
    openHlsQualityPopover({ auto: true });
  });
  trackListener(hlsQualityControl, "mouseleave", () =>
    closeHlsQualityPopover(true),
  );
  trackListener(hlsQualityControl, "focusin", () => {
    if (isResolvingSource()) {
      return;
    }
    openHlsQualityPopover({ auto: true });
  });
  trackListener(hlsQualityControl, "focusout", (event) => {
    if (!(event.target instanceof Node)) {
      closeHlsQualityPopover(true);
      return;
    }

    if (
      event.relatedTarget instanceof Node &&
      hlsQualityControl.contains(event.relatedTarget)
    ) {
      return;
    }
    closeHlsQualityPopover(true);
  });
}

if (episodesControl) {
  trackListener(episodesControl, "mouseenter", () =>
    openEpisodesPopover({ auto: true }),
  );
  trackListener(episodesControl, "mouseleave", () =>
    closeEpisodesPopover(true),
  );
  trackListener(episodesControl, "focusin", () =>
    openEpisodesPopover({ auto: true }),
  );
  trackListener(episodesControl, "focusout", () =>
    closeEpisodesPopover(true),
  );
}

if (liveStreamControl) {
  trackListener(liveStreamControl, "mouseenter", () => {
    if (isResolvingSource()) {
      return;
    }
    openLiveStreamPopover();
  });
  trackListener(liveStreamControl, "mouseleave", () =>
    closeLiveStreamPopover(true),
  );
  trackListener(liveStreamControl, "focusin", () => {
    if (isResolvingSource()) {
      return;
    }
    openLiveStreamPopover();
  });
  trackListener(liveStreamControl, "focusout", (event) => {
    if (!(event.target instanceof Node)) {
      closeLiveStreamPopover(true);
      return;
    }

    if (
      event.relatedTarget instanceof Node &&
      liveStreamControl.contains(event.relatedTarget)
    ) {
      return;
    }
    closeLiveStreamPopover(true);
  });
}

if (sourceControl) {
  trackListener(sourceControl, "mouseleave", () =>
    closeSourcePopover(true),
  );
  trackListener(sourceControl, "focusout", (event) => {
    if (!(event.target instanceof Node)) {
      closeSourcePopover(true);
      return;
    }

    if (
      event.relatedTarget instanceof Node &&
      sourceControl.contains(event.relatedTarget)
    ) {
      return;
    }
    closeSourcePopover(true);
  });
}

if (audioControl) {
  trackListener(audioControl, "mouseenter", () => {
    if (isResolvingSource()) {
      return;
    }
    openAudioPopover({ auto: true });
  });
  trackListener(audioControl, "mouseleave", () => closeAudioPopover(true));
  trackListener(audioControl, "focusin", () => {
    if (isResolvingSource()) {
      return;
    }
    openAudioPopover({ auto: true });
  });
  trackListener(audioControl, "focusout", (event) => {
    if (!(event.target instanceof Node)) {
      closeAudioPopover(true);
      return;
    }

    if (
      event.relatedTarget instanceof Node &&
      audioControl.contains(event.relatedTarget)
    ) {
      return;
    }
    closeAudioPopover(true);
  });
}

speedOptions.forEach((option) => {
  trackListener(option, "click", () => {
    if (isResolvingSource()) {
      return;
    }

    const selectedRate = Number(option.dataset.rate);
    if (!Number.isFinite(selectedRate)) {
      return;
    }

    video.playbackRate = selectedRate;
    syncSpeedState();
    closeSpeedPopover(false);
    try {
      localStorage.setItem(speedStorageKey, String(selectedRate));
      fetchUserApi("/api/user/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [speedStorageKey]: String(selectedRate) }),
      }).catch(() => {});
    } catch {}
  });
});

if (episodesList) trackListener(episodesList, "click", (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }

  const seasonOption = event.target.closest(".episode-season-item");
  if (seasonOption) {
    const nextSeasonNumber = Number(seasonOption.dataset.seasonNumber || 0);
    if (Number.isFinite(nextSeasonNumber) && nextSeasonNumber > 0) {
      selectedEpisodesSeasonNumber = Math.floor(nextSeasonNumber);
      episodesMenuMode = "episodes";
      renderSeriesEpisodePreview();
      const firstPreviewedEpisode = episodesList.querySelector(
        ".episode-preview-item.is-previewed",
      );
      firstPreviewedEpisode?.scrollIntoView({ block: "nearest", behavior: "instant" });
    }
    return;
  }

  const option = event.target.closest(".episode-preview-item");
  if (!option) {
    return;
  }

  const nextIndex = Number(option.dataset.episodeIndex || -1);
  if (!Number.isFinite(nextIndex)) {
    return;
  }

  navigateToSeriesEpisode(nextIndex);
});

if (audioOptionsContainer) trackListener(audioOptionsContainer, "click", async (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }

  const option = event.target.closest(".audio-option");
  if (!option || option.disabled) {
    return;
  }

  const optionType = String(option.dataset.optionType || "");
  if (optionType !== "audio-lang" && optionType !== "audio-track") {
    return;
  }

  if (optionType === "audio-lang") {
    const nextLang = String(option.dataset.lang || "auto").toLowerCase();
    if (!supportedAudioLangs.has(nextLang) || nextLang === preferredAudioLang) {
      closeAudioPopover();
      return;
    }

    preferredAudioLang = nextLang;
    resolvedTrackPreferenceAudio = nextLang;
    selectedAudioStreamIndex = -1;
    persistAudioLangPreference(preferredAudioLang);
    void persistTrackPreferencesOnServer({
      audioLang: preferredAudioLang,
    });
    syncAudioState();
    persistAudioLangInUrl();
    closeAudioPopover();

    if (!isTmdbResolvedPlayback) {
      return;
    }

    const resumeFrom = getEffectiveCurrentTime();
    tmdbResolveRetries = 0;
    showResolver("Switching audio language...");
    try {
      const result = await resolveTmdbSourcesAndPlay();
      if (result?.nativeLaunched || result?.stale) {
        return;
      }
      if (resumeFrom > 1) {
        seekToAbsoluteTime(resumeFrom);
      }
    } catch (error) {
      console.error("Failed to switch audio language:", error);
      showResolverError(error, "Unable to switch language.");
    }
    return;
  }

  const streamIndex = Number(option.dataset.streamIndex || -1);
  const trackLang = String(option.dataset.trackLanguage || "").toLowerCase();
  if (
    !Number.isFinite(streamIndex) ||
    streamIndex < 0 ||
    streamIndex === selectedAudioStreamIndex
  ) {
    closeAudioPopover();
    return;
  }

  selectedAudioStreamIndex = streamIndex;
  if (trackLang) {
    preferredAudioLang = trackLang;
    resolvedTrackPreferenceAudio = trackLang;
    persistAudioLangPreference(preferredAudioLang);
    persistAudioLangInUrl();
  }
  void persistTrackPreferencesOnServer({
    audioLang: trackLang || preferredAudioLang,
  });
  syncAudioState();
  closeAudioPopover();

  if (!activeTrackSourceInput) {
    return;
  }

  const resumeFrom = getEffectiveCurrentTime();
  const wasPaused = isLiveIframePlaybackActive() ? liveIframePlaybackClock.isPaused() : video.paused;
  const selectedSubtitleTrack = getSubtitleTrackByStreamIndex(
    selectedSubtitleStreamIndex,
  );
  const shouldKeepEmbeddedSubtitle = shouldUseNativeEmbeddedSubtitleTrack(
    selectedSubtitleTrack,
  );
  const shouldUseRemuxForAudioSwitch =
    shouldUseSoftwareDecode(activeTrackSourceInput) ||
    shouldForceRemuxForEmbeddedAudio() ||
    shouldKeepEmbeddedSubtitle;
  const restartAt = resumeFrom > 1 ? resumeFrom : 0;
  showResolver("Switching audio track...");
  if (shouldUseRemuxForAudioSwitch) {
    setVideoSource(
      buildSoftwareDecodeUrl(
        activeTrackSourceInput,
        restartAt,
        selectedAudioStreamIndex,
        activeAudioSyncMs || preferredAudioSyncMs,
        selectedSubtitleStreamIndex,
      ),
    );
  } else {
    setVideoSource(
      buildHlsPlaybackUrl(activeTrackSourceInput, selectedAudioStreamIndex, -1),
    );
  }
  applySubtitleTrackByStreamIndex(selectedSubtitleStreamIndex);
  hideResolver();
  if (!wasPaused) {
    await tryPlay();
  }
  if (resumeFrom > 1 && !shouldUseRemuxForAudioSwitch) {
    seekToAbsoluteTime(resumeFrom);
  }
});

if (subtitleOptionsContainer) trackListener(subtitleOptionsContainer, "click", async (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }

  const option = event.target.closest(".subtitle-option");
  if (!option || option.disabled) {
    return;
  }

  const streamIndex = Number(option.dataset.subtitleStream || -1);
  if (!Number.isFinite(streamIndex)) {
    return;
  }

  if (
    streamIndex === selectedSubtitleStreamIndex ||
    (streamIndex < 0 && selectedSubtitleStreamIndex < 0)
  ) {
    closeAudioPopover();
    return;
  }

  selectedSubtitleStreamIndex = streamIndex >= 0 ? streamIndex : -1;
  preferredSubtitleLang =
    selectedSubtitleStreamIndex >= 0
      ? String(option.dataset.subtitleLang || "")
      : "off";
  preferredSubtitleLang = normalizeSubtitlePreference(preferredSubtitleLang);
  persistSubtitleLangPreference(preferredSubtitleLang);
  persistSubtitleStreamPreference(selectedSubtitleStreamIndex);
  void persistTrackPreferencesOnServer({
    subtitleLang: preferredSubtitleLang,
  });

  applySubtitleTrackByStreamIndex(selectedSubtitleStreamIndex);

  syncAudioState();
  closeAudioPopover();
});

if (subtitleSyncEarlier) {
  trackListener(subtitleSyncEarlier, "click", () => {
    adjustSubtitleOffset(-SUBTITLE_OFFSET_STEP_MS);
  });
}
if (subtitleSyncLater) {
  trackListener(subtitleSyncLater, "click", () => {
    adjustSubtitleOffset(SUBTITLE_OFFSET_STEP_MS);
  });
}
if (subtitleSyncReset) {
  trackListener(subtitleSyncReset, "click", () => {
    resetSubtitleOffset();
  });
}

async function handleSourceOptionSelection(nextSourceHash) {
  const normalizedNextSourceHash = normalizeSourceHash(nextSourceHash);

  if (!normalizedNextSourceHash) {
    syncSourceSelectionState();
    renderSelectedSourceDetails();
    closeSourcePopover(false, { force: true });
    return;
  }

  if (
    normalizedNextSourceHash === selectedSourceHash &&
    !pendingSourceSwitchHash
  ) {
    syncSourceSelectionState();
    renderSelectedSourceDetails();
    closeSourcePopover(false, { force: true });
    return;
  }

  if (!isTmdbResolvedPlayback) {
    selectedSourceHash = normalizedNextSourceHash;
    sourceSelectionPinned = true;
    applyPreferredSourceAudioSync(selectedSourceHash);
    persistSourceHashInUrl();
    syncAudioState();
    return;
  }

  const nextSourceOption = getSourceOptionByHash(normalizedNextSourceHash);
  const switchingToEmbed = Boolean(
    nextSourceOption && isSourceOptionEmbed(nextSourceOption),
  );
  const sourceSwitchTimeouts = getManualSourceSwitchTimeouts({
    isEmbed: switchingToEmbed,
    localTorrentEnabled: userLocalTorrentEnabled,
    realDebridConfigured: isUserRealDebridPlaybackEnabled(),
    resolverProvider: preferredResolverProvider,
  });
  const resumeFrom = getEffectiveCurrentTime();
  const wasPaused = isLiveIframePlaybackActive() ? liveIframePlaybackClock.isPaused() : video.paused;
  const previousPreferredResolverProvider = preferredResolverProvider;
  const sourceSwitchRequest = manualSourceSwitch.begin({
    targetSourceHash: normalizedNextSourceHash,
    startupTimeoutMs: sourceSwitchTimeouts.startupTimeoutMs,
    baseline: captureManualSourceSwitchBaseline({
      resumeSeconds: resumeFrom,
      wasPaused,
    }),
  });
  await requestResolveJson.cancelActive();
  if (!manualSourceSwitch.isCurrent(sourceSwitchRequest)) {
    return;
  }
  preferredResolverProvider = pickTorrentResolverProvider({
    currentProvider: preferredResolverProvider,
    isEmbed: switchingToEmbed,
    realDebridActive: isUserRealDebridPlaybackEnabled(),
    localTorrentEnabled: userLocalTorrentEnabled,
  });
  const keepCurrentPlaybackWhileResolving =
    !switchingToEmbed && (
      isUserRealDebridPlaybackEnabled() || userLocalTorrentEnabled
    );
  const playbackRequestToken = ++tmdbPlaybackRequestToken;
  stopLocalCacheUpgradeWatch();
  localCacheUpgradeWatch.setHasUpgraded(false);
  sourceSelectionPinned = true;
  setPendingSourceSwitchHash(normalizedNextSourceHash);
  applyPreferredSourceAudioSync(normalizedNextSourceHash);
  syncAudioState();
  renderSelectedSourceDetails();
  if (sourceOptionDetails instanceof HTMLElement && keepCurrentPlaybackWhileResolving) {
    sourceOptionDetails.hidden = false;
    sourceOptionDetails.textContent = isUserRealDebridPlaybackEnabled()
      ? "Preparing Real-Debrid source — current stream keeps playing."
      : "Preparing torrent — current stream keeps playing.";
  }
  tmdbResolveRetries = 0;
  closeAudioPopover(false, { force: true });
  // Keep Server menu open with an understated row spinner (no full overlay).
  // With local torrent, HLS/embed stays on screen until the torrent has a playable URL.
  if (sourceControl && !sourceControl.classList.contains("is-open")) {
    openSourcePopover();
  }
  try {
    const result = await resolveTmdbSourcesAndPlay({
      allowSourceFallback: false,
      applyPlayback: false,
      requiredSourceHash: normalizedNextSourceHash,
      requestSourceHash: normalizedNextSourceHash,
      resolveTimeoutMs: sourceSwitchTimeouts.resolveTimeoutMs,
      skipExternalEmbed: keepCurrentPlaybackWhileResolving,
      startSeconds: resumeFrom,
    });
    if (
      !manualSourceSwitch.isCurrent(sourceSwitchRequest) ||
      playbackRequestToken !== tmdbPlaybackRequestToken
    ) {
      return;
    }
    if (result?.nativeLaunched) {
      selectedSourceHash = normalizedNextSourceHash;
      setPendingSourceSwitchHash("");
      manualSourceSwitch.clear();
      persistSourceHashInUrl();
      closeSourcePopover(false, { force: true });
      return;
    }
    sourceSelectionPinned = true;
    selectedSourceHash = normalizedNextSourceHash;
    syncSourceSelectionState();
    manualSourceSwitch.arm(sourceSwitchRequest);
    const applied = await applyResolvedTmdbPlayback(result.resolved, {
      resolvedSourceHash: result.resolvedSourceHash || normalizedNextSourceHash,
      startSeconds: resumeFrom,
      playbackRequestToken,
      manualSourceSwitchRequest: sourceSwitchRequest,
      autoplay: !wasPaused,
    });
    if (applied?.stale) {
      if (
        manualSourceSwitch.isCurrent(sourceSwitchRequest) &&
        !sourceSwitchRequest.failureStarted
      ) {
        manualSourceSwitch.clear();
      }
      return;
    }
    if (
      !manualSourceSwitch.isCurrent(sourceSwitchRequest) &&
      sourceSwitchRequest.phase !== "completed"
    ) {
      return;
    }
    if (applied?.nativeLaunched) {
      if (manualSourceSwitch.isCurrent(sourceSwitchRequest)) {
        manualSourceSwitch.clear();
        commitManualSourceSwitchPlayback(sourceSwitchRequest.commitData);
      }
      setPendingSourceSwitchHash("");
      closeSourcePopover(false, { force: true });
      return;
    }
    if (resumeFrom > 1 && !isTranscodeSourceActive()) {
      seekToAbsoluteTime(resumeFrom);
    }
    if (
      manualSourceSwitch.isCurrent(sourceSwitchRequest) &&
      (video.readyState >= 2 || isLiveIframePlaybackActive())
    ) {
      completeManualSourceSwitchIfActive();
    }
    // Otherwise leave the row spinner up until startup completes or rolls back.
  } catch (error) {
    if (
      error?.name === "AbortError" &&
      !manualSourceSwitch.isCurrent(sourceSwitchRequest)
    ) {
      return;
    }
    const message = error?.message || "Unable to switch source.";
    if (manualSourceSwitch.isCurrent(sourceSwitchRequest)) {
      await manualSourceSwitch.fail(sourceSwitchRequest, message);
    } else if (sourceSwitchRequest?.baseline) {
      await rollbackManualSourceSwitchPlayback(sourceSwitchRequest.baseline, {
        reason: message,
        request: sourceSwitchRequest,
      });
      setPendingSourceSwitchHash("");
    } else {
      preferredResolverProvider = previousPreferredResolverProvider;
      setPendingSourceSwitchHash("");
    }
    syncSourceSelectionState();
    renderSelectedSourceDetails();
    // Stay on the stream that was already playing — do not hunt a new HLS.
    if (sourceOptionDetails instanceof HTMLElement) {
      sourceOptionDetails.hidden = false;
      sourceOptionDetails.textContent =
        "Couldn't start that source — kept your current stream.";
    }
  } finally {
    manualSourceSwitch.finish(sourceSwitchRequest);
  }
}

if (audioTabSubtitles) trackListener(audioTabSubtitles, "click", () => {
  if (isResolvingSource()) {
    return;
  }
  setActiveAudioTab("subtitles");
});

if (audioTabSources) trackListener(audioTabSources, "click", () => {
  if (isResolvingSource() || !isTmdbResolvedPlayback) {
    return;
  }

  if (!availablePlaybackSources.length) {
    void fetchTmdbSourceOptionsViaBackend();
  }
  setActiveAudioTab("sources");
});

[audioTabSubtitles, audioTabSources].forEach((tabButton) => {
  if (!tabButton) return;
  trackListener(tabButton, "keydown", (event) => {
    if (!(event instanceof KeyboardEvent)) {
      return;
    }
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
      return;
    }

    event.preventDefault();
    if (
      event.key === "ArrowRight" &&
      audioTabSources &&
      !audioTabSources.hidden &&
      !audioTabSources.disabled
    ) {
      setActiveAudioTab("sources");
      audioTabSources.focus({ preventScroll: true });
      return;
    }
    setActiveAudioTab("subtitles");
    audioTabSubtitles?.focus({ preventScroll: true });
  });
});

if (sourceMenu) trackListener(sourceMenu, "click", (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }

  const sourceTab = event.target.closest("[data-source-tab]");
  if (sourceTab instanceof HTMLButtonElement) {
    activeSourceTypeTab = String(sourceTab.dataset.sourceTab || "");
    renderSourceOptionButtons();
    sourceTab.focus({ preventScroll: true });
    return;
  }

  const downloadButton = event.target.closest(".source-option-download");
  if (downloadButton instanceof HTMLButtonElement) {
    event.preventDefault(); event.stopPropagation();
    void sourceDownload.download(downloadButton.dataset.sourceHash || "");
    return;
  }

  const sourceOption = event.target.closest(".source-option");
  if (!(sourceOption instanceof HTMLButtonElement)) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  void handleSourceOptionSelection(sourceOption.dataset.sourceHash || "");
});

if (liveStreamOptionsContainer) {
  trackListener(liveStreamOptionsContainer, "click", (event) => {
    if (!(event.target instanceof Element)) {
      return;
    }
    const option = event.target.closest(".live-stream-option");
    if (!(option instanceof HTMLButtonElement)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void switchLiveStream(option.dataset.streamId || "");
  });
}

if (hlsQualityOptionsContainer) {
  trackListener(hlsQualityOptionsContainer, "click", (event) => {
    if (!(event.target instanceof Element)) {
      return;
    }
    const option = event.target.closest(".hls-quality-option");
    if (!(option instanceof HTMLButtonElement)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    hlsQualityControls.selectLevel(option.dataset.levelIndex || "auto");
    closeHlsQualityPopover(false, { force: true });
  });
}

trackListener(document, "pointerdown", (event) => {
  if (!speedControl) {
    return;
  }

  if (speedControl.contains(event.target)) {
    return;
  }

  closeSpeedPopover(false);
});

trackListener(document, "pointerdown", (event) => {
  if (!episodesControl) {
    return;
  }

  if (episodesControl.contains(event.target)) {
    return;
  }

  closeEpisodesPopover();
});

trackListener(document, "pointerdown", (event) => {
  if (!liveStreamControl) {
    return;
  }

  if (liveStreamControl.contains(event.target)) {
    return;
  }

  closeLiveStreamPopover();
});

trackListener(document, "pointerdown", (event) => {
  if (!hlsQualityControl) {
    return;
  }

  if (hlsQualityControl.contains(event.target)) {
    return;
  }

  closeHlsQualityPopover(false, { force: true });
});

trackListener(document, "pointerdown", (event) => {
  if (!sourceControl) {
    return;
  }

  if (sourceControl.contains(event.target)) {
    return;
  }

  closeSourcePopover();
});

trackListener(document, "pointerdown", (event) => {
  if (!audioControl) {
    return;
  }

  if (audioControl.contains(event.target)) {
    return;
  }

  closeAudioPopover();
});

trackListener(video, "ratechange", () => {
  syncSpeedState();
});

const seekInteractions = attachSeekInteractions({
  clampLiveSeekTargetSeconds,
  clearPendingSeekRatios: () => {
    pendingTranscodeSeekRatio = null;
    pendingStandardSeekRatio = null;
  },
  formatTime,
  getBufferedSeekValue,
  getLastRequestedAbsolutePlaybackSource: () => lastRequestedAbsolutePlaybackSource,
  getLastRequestedPlaybackSource: () => lastRequestedPlaybackSource,
  getLiveSeekableWindow,
  getPendingStandardSeekRatio: () => pendingStandardSeekRatio,
  getPendingTranscodeSeekRatio: () => pendingTranscodeSeekRatio,
  getSeekRatioFromPointerEvent,
  getSeekScaleDurationSeconds,
  getSeekTargetSecondsFromRatio,
  hasActiveSource,
  isDraggingSeek: () => isDraggingSeek,
  isHlsPlaybackSource,
  isLivePlayback: () => isLivePlayback,
  isResolvingSource,
  isTranscodeSourceActive,
  liveEdgePinRatio: LIVE_EDGE_PIN_RATIO,
  liveEdgeRejoinToleranceSeconds: LIVE_EDGE_REJOIN_TOLERANCE_SECONDS,
  paintSeekProgress,
  parseLiveIframePlaybackSource,
  seekBar,
  seekPreview,
  seekPreviewCanvas,
  seekPreviewTime,
  seekToAbsoluteTime,
  setDraggingSeek: (value) => {
    isDraggingSeek = Boolean(value);
  },
  setPendingSeekRatio,
  shouldUseHlsJsForSource,
  syncDurationText,
  trackListener,
  video,
});
closeSeekPreviewVideo = seekInteractions.closeSeekPreviewVideo;

trackListener(video, "loadedmetadata", () => {
  // Reapply saved playback speed (browser resets to 1x on new source)
  const restoredSpeed = Number(localStorage.getItem(speedStorageKey));
  if (Number.isFinite(restoredSpeed) && playbackRates.includes(restoredSpeed)) {
    video.playbackRate = restoredSpeed;
  }
  syncSpeedState();
  restoreSelectedSubtitleTrackAfterSourceChange();
  syncSubtitleTrackVisibility();
  refreshActiveSubtitlePlacement();
  renderCustomSubtitleOverlay();
  window.clearTimeout(subtitleRestoreAfterSourceChangeTimeout);
  subtitleRestoreAfterSourceChangeTimeout = window.setTimeout(() => {
    restoreSelectedSubtitleTrackAfterSourceChange();
    syncSubtitleTrackVisibility();
    refreshActiveSubtitlePlacement();
    renderCustomSubtitleOverlay();
  }, 200);
  const seekScaleDurationSeconds = getSeekScaleDurationSeconds();
  if (!applyInitialResumeIfReady()) {
    scheduleInitialResumeRetry();
  }

  if (seekScaleDurationSeconds > 0) {
    syncDurationText();
  }
  syncSeekState();
  paintSeekProgress(
    seekBar.value,
    getBufferedSeekValue(seekScaleDurationSeconds),
  );
});
if (
  video.textTracks &&
  typeof video.textTracks.addEventListener === "function"
) {
  trackListener(video.textTracks, "addtrack", () => {
    syncSubtitleTrackVisibility();
    refreshActiveSubtitlePlacement();
  });
}
trackListener(window, "resize", refreshActiveSubtitlePlacement);
trackListener(video, "timeupdate", syncSeekState);
trackListener(video, "loadedmetadata", applyPendingRecoverySeek);
trackListener(video, "play", startSubtitleRafLoop);
trackListener(video, "playing", startSubtitleRafLoop);
trackListener(video, "pause", stopSubtitleRafLoop);
trackListener(video, "ended", stopSubtitleRafLoop);
trackListener(video, "seeking", () => {
  lastPlaybackSeekAt = performance.now();
  resetAudioDecodeWatchState();
  invalidateRenderedCue();
  renderCustomSubtitleOverlay();
});
trackListener(video, "progress", syncSeekState);
trackListener(video, "durationchange", syncSeekState);
trackListener(video, "waiting", () => {
  scheduleStreamStallRecovery();
});
trackListener(video, "stalled", () => {
  scheduleStreamStallRecovery();
});
trackListener(video, "seeked", () => {
  renderCustomSubtitleOverlay();
  if (video.paused || video.readyState >= 2) {
    hideSeekLoadingIndicator();
  }
});
trackListener(video, "loadeddata", () => {
  // Decodable data for the freshly selected source confirms the switch even when a
  // far seek means playback hasn't started yet — without this the restore watchdog
  // could still roll back a source that actually loaded fine.
  completeManualSourceSwitchIfActive();
});
trackListener(video, "canplay", () => {
  completeManualSourceSwitchIfActive();
  applyPendingRecoverySeek();
  clearPlaybackRecovery();
  clearStreamStallRecovery();
  clearLiveStartupHealthWatch({ resetRequest: true });
  rememberLiveStreamSuccess(getSelectedLiveStreamOption(), "canplay");
  hideSeekLoadingIndicator();
  startLiveVisualHealthWatch();
  if (!applyInitialResumeIfReady()) {
    scheduleInitialResumeRetry();
  }
});
trackListener(video, "playing", () => {
  completeManualSourceSwitchIfActive();
  clearPlaybackRecovery();
  clearStreamStallRecovery();
  clearLiveStartupHealthWatch({ resetRequest: true });
  rememberLiveStreamSuccess(getSelectedLiveStreamOption(), "playing");
  hideStaleLiveResolverWhilePlayingForState({ isLivePlayback, resolverOverlay, liveAutoFallbackInFlight, hideResolver });
  hideSeekLoadingIndicator();
  startLiveVisualHealthWatch();
  if (!applyInitialResumeIfReady()) {
    scheduleInitialResumeRetry();
  }
});
trackListener(video, "timeupdate", () => {
  if (getEffectiveCurrentTime() > 0.5) {
    completeManualSourceSwitchIfActive();
    clearPlaybackRecovery();
    clearStreamStallRecovery();
    clearLiveStartupHealthWatch({ resetRequest: true });
    rememberLiveStreamSuccess(getSelectedLiveStreamOption(), "timeupdate");
    hideStaleLiveResolverWhilePlayingForState({ isLivePlayback, resolverOverlay, liveAutoFallbackInFlight, hideResolver });
  }
  if (!applyInitialResumeIfReady()) {
    scheduleInitialResumeRetry();
  }
  persistResumeTime(false);

  // Auto-play: show the "next episode" card near the end.
  if (hasSeriesEpisodeControls && !autoPlayCancelled && !autoPlayOverlayVisible) {
    const duration = getDisplayDurationSeconds();
    const current = getEffectiveCurrentTime();
    if (
      Number.isFinite(duration) &&
      duration > AUTO_PLAY_SHOW_BEFORE_END_SECONDS + 5 &&
      current >= duration - AUTO_PLAY_SHOW_BEFORE_END_SECONDS
    ) {
      showAutoPlayCard();
    }
  }
  // Hide the card if user seeks back well before the end.
  if (autoPlayOverlayVisible && !video.ended) {
    const duration = getDisplayDurationSeconds();
    const current = getEffectiveCurrentTime();
    if (
      Number.isFinite(duration) &&
      current < duration - AUTO_PLAY_SHOW_BEFORE_END_SECONDS - 5
    ) {
      hideAutoPlayOverlay();
      autoPlayCancelled = false; // allow re-trigger if they reach end again
    }
  }
});
trackListener(video, "play", syncPlayState);
trackListener(video, "play", () => {
  scheduleStreamStallRecovery();
  showControls();
  scheduleControlsHide();
});
trackListener(video, "pause", syncPlayState);
trackListener(video, "pause", () => {
  clearControlsHideTimer();
  showControls();
});
trackListener(video, "pause", () => {
  clearStreamStallRecovery();
  liveFallbackRetry.cancel();
  clearLiveVisualHealthWatch({ resetSamples: true });
  if (!isStartupArmed() || hasLivePlaybackStarted()) {
    clearLiveStartupHealthWatch({ resetRequest: true });
  }
  persistResumeTime(true);
});
trackListener(video, "ended", () => {
  clearLiveVisualHealthWatch({ resetSamples: true });
  clearLiveStartupHealthWatch({ resetRequest: true });
  clearControlsHideTimer();
  showControls();

  const expectedDuration = getDisplayDurationSeconds();
  const effectiveCurrent = getEffectiveCurrentTime();
  const endedTooEarly =
    isTmdbResolvedPlayback &&
    Number.isFinite(expectedDuration) &&
    expectedDuration > 120 &&
    effectiveCurrent < expectedDuration - 45;

  if (endedTooEarly) {
    const message = "Stream ended early, trying another source...";
    const recovered = attemptTmdbRecovery(message);
    if (recovered) {
      return;
    }
    reportCurrentTmdbPlaybackFailure(message, "ended_early");
  }

  try {
    localStorage.removeItem(resumeStorageKey);
    removeContinueWatchingEntry();
  } catch {
    // Ignore storage access issues.
  }
  fetchUserApi("/api/user/watch-progress", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: replaySafeMutationBody({ sourceIdentity }),
  }).catch(() => {});
  resumeTime = 0;
  lastPersistedResumeTime = 0;
  lastPersistedResumeAt = 0;

  // Auto-play: start countdown to next episode.
  if (hasSeriesEpisodeControls && !autoPlayCancelled && getNextPlayableEpisode()) {
    startAutoPlayCountdown();
  }
});
trackListener(video, "volumechange", syncMuteState);
trackListener(video, "canplay", () => {
  if (isTmdbResolvedPlayback) {
    hideResolver();
  }
});
trackListener(video, "error", () => {
  clearLiveVisualHealthWatch({ resetSamples: true });
  clearLiveStartupHealthWatch({ resetRequest: true });
  if (isLiveIframePlaybackActive()) {
    return;
  }

  hideSeekLoadingIndicator();

  const mediaError = video.error;
  const message =
    mediaError?.message || "Resolved stream could not be played. Try again.";

  if (isLivePlayback && liveStreamOptions.length > 1) {
    void attemptAutomaticLiveStreamFallback(
      "Live stream failed. Trying another source...",
    ).then((recovered) => {
      if (!recovered) {
        showResolverError(message, "Live stream failed.");
      }
    });
    return;
  }

  void handlePlaybackErrorRecovery(message).then((recovered) => {
    if (!recovered && isTmdbResolvedPlayback) {
      reportCurrentTmdbPlaybackFailure(message);
    }
  });
});

function isInteractiveTarget(target) {
  if (!target || !(target instanceof Element)) {
    return false;
  }

  return Boolean(
    target.closest("button, input, textarea, select, [contenteditable='true']"),
  );
}

function shouldSurfaceTapOnlyRevealControls(event) {
  if (event?.pointerType === "touch" || event?.pointerType === "pen") {
    return true;
  }

  if (event?.sourceCapabilities?.firesTouchEvents) {
    return true;
  }

  return Boolean(
    window.matchMedia?.("(max-width: 920px), (hover: none) and (pointer: coarse)")
      ?.matches,
  );
}

trackListener(playerShell, "click", (event) => {
  showControls();
  scheduleControlsHide();
  playerShell.focus();
  clearSingleClickPlaybackToggle();
  if (isInteractiveTarget(event.target)) {
    return;
  }

  if (shouldSurfaceTapOnlyRevealControls(event)) {
    return;
  }

  singleClickPlaybackToggleTimeout = window.setTimeout(() => {
    singleClickPlaybackToggleTimeout = null;
    void togglePlayback();
  }, singleClickToggleDelayMs);
});

trackListener(playerShell, "dblclick", (event) => {
  if (isInteractiveTarget(event.target)) {
    return;
  }
  event.preventDefault();
  clearSingleClickPlaybackToggle();
  void togglePlayerFullscreenMode(getFullscreenContext());
});

trackListener(playerShell, "mousemove", handleUserActivity);
trackListener(playerShell, "touchstart", handleUserActivity, {
  passive: true,
});
trackListener(playerShell, "pointerdown", handleUserActivity);

async function handleKeydown(event) {
  handleUserActivity();

  if (event.key === " " || event.key === "Spacebar" || event.code === "Space") {
    if (isInteractiveTarget(event.target) || isResolvingSource()) {
      return;
    }

    if (event.repeat) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    await togglePlayback();
    return;
  }

  if (event.key === "ArrowLeft") {
    if (isInteractiveTarget(event.target)) {
      return;
    }
    seekByJumpSeconds("backward");
  }

  if (event.key === "ArrowRight") {
    if (isInteractiveTarget(event.target)) {
      return;
    }
    seekByJumpSeconds("forward");
  }

  if (event.key.toLowerCase() === "m") {
    if (isInteractiveTarget(event.target)) {
      return;
    }
    if (isResolvingSource()) {
      return;
    }

    togglePlayerMute();
  }

  if (event.key.toLowerCase() === "f") {
    if (isInteractiveTarget(event.target)) {
      return;
    }
    await togglePlayerFullscreenMode(getFullscreenContext());
  }

  if (event.key === "[" || event.key === "]") {
    if (isInteractiveTarget(event.target) || isResolvingSource()) {
      return;
    }
    if (!hasActiveSource() || !isTranscodeSourceActive()) {
      return;
    }
    event.preventDefault();
    await adjustSourceAudioSync(
      event.key === "[" ? AUDIO_SYNC_STEP_MS : -AUDIO_SYNC_STEP_MS,
    );
    return;
  }

  if (event.key === "Escape" && !isFullscreenActive(getFullscreenContext())) {
    if (liveStreamControl?.classList.contains("is-open")) {
      closeLiveStreamPopover();
      return;
    }

    if (sourceControl?.classList.contains("is-open")) {
      closeSourcePopover(false, { force: true });
      return;
    }

    if (hlsQualityControl?.classList.contains("is-open")) {
      closeHlsQualityPopover(false, { force: true });
      return;
    }

    if (audioControl?.classList.contains("is-open")) {
      closeAudioPopover();
      return;
    }

    if (episodesControl?.classList.contains("is-open")) {
      closeEpisodesPopover();
      return;
    }

    if (speedControl?.classList.contains("is-open")) {
      closeSpeedPopover(false);
      return;
    }
    navigateBackFromPlayer();
  }
}
_handleKeydownRef = handleKeydown;

trackListener(window, "keydown", handleKeydown, { capture: true });
trackListener(window, "storage", (event) => {
  if (!event.key || event.key === SUBTITLE_COLOR_PREF_KEY) {
    applySubtitleCueColor(event.newValue);
  }

  if (event.key === DEFAULT_AUDIO_LANGUAGE_PREF_KEY && !hasAudioLangParam) {
    const storedMovieAudioLang = isTmdbMoviePlayback
      ? getStoredAudioLangForTmdbMovie(tmdbId)
      : "auto";
    if (!isTmdbMoviePlayback || storedMovieAudioLang === "auto") {
      preferredAudioLang = getStoredDefaultAudioLanguage();
      syncAudioState();
    }
  }
});
    syncMuteState();
    syncPlayState();
    // Restore saved playback speed
    const savedSpeed = Number(localStorage.getItem(speedStorageKey));
    if (Number.isFinite(savedSpeed) && playbackRates.includes(savedSpeed)) {
      video.playbackRate = savedSpeed;
    }
    syncSpeedState();
    renderLiveStreamOptions();
    syncLiveStreamControls();
    hlsQualityControls.renderOptions();
    hlsQualityControls.syncControls();
    syncSourcePanelVisibility();
    rebuildTrackOptionButtons();
    syncAudioState();
    applySubtitleCueColor();
    stripAudioSyncFromPageUrl();
    if (
      isTmdbResolvedPlayback &&
      !hasAudioLangParam &&
      preferredAudioLang !== "auto"
    ) {
      persistAudioLangInUrl();
    }
    if (
      isTmdbResolvedPlayback &&
      !hasQualityParam &&
      shouldIncludePreferredQualityInUrl(preferredQuality)
    ) {
      persistQualityInUrl();
    }
    showControls();
    paintSeekProgress(seekBar.value);
    syncDurationText();
    scheduleControlsHide();
    initPlaybackSource().then(() => {
      setEpisodeLabel(title, episode);
      renderSeriesEpisodePreview();
      syncSeriesControls();
      void hydrateSeriesEpisodeThumbnails();
    });

    playerShell.focus();

    // Global listeners
    trackListener(document, "keydown", handleGlobalKeydown);
    trackListener(document, "mousemove", handleGlobalMousemove);
    trackListener(window, "beforeunload", handleGlobalBeforeunload);
    trackListener(window, "pagehide", handleGlobalBeforeunload);
    trackListener(document, "visibilitychange", handleDocumentVisibilityChange);
  });

  onCleanup(() => {
    void requestResolveJson.dispose();
    deferredMediaTracks.dispose();
    _cleanups.forEach(fn => fn());
    _cleanups.length = 0;
    manualSourceSwitch.dispose();
    if (resumeFlushIntervalId) {
      window.clearInterval(resumeFlushIntervalId);
      resumeFlushIntervalId = 0;
    }
    clearInitialResumeRetry();
    window.clearTimeout(unavailableEpisodeResolverHideTimeout);
    window.clearTimeout(audioDecodeRecoveryResetTimeout);
    window.clearTimeout(subtitleRestoreAfterSourceChangeTimeout);
    if (window.__STREAMARENA_PLAYBACK_BENCHMARK__) {
      delete window.__STREAMARENA_PLAYBACK_BENCHMARK__;
    }
    clearControlsHideTimer();
    clearSingleClickPlaybackToggle();
    clearStreamStallRecovery();
    clearLiveVisualHealthWatch({ resetSamples: true });
    clearLiveStartupHealthWatch({ resetRequest: true });
    clearPlaybackRecovery();
    clearAudioDecodeWatch();
    localCacheUpgradeWatch.dispose();
    clearSeekLoadingTimeout();
    closeSeekPreviewVideo();
    hlsPlaybackController.destroy();
    stopSubtitleRafLoop();
    if (speedPopoverCloseTimeout) clearTimeout(speedPopoverCloseTimeout);
    if (hlsQualityPopoverCloseTimeout) clearTimeout(hlsQualityPopoverCloseTimeout);
    if (liveStreamPopoverCloseTimeout) clearTimeout(liveStreamPopoverCloseTimeout);
    if (episodesPopoverCloseTimeout) clearTimeout(episodesPopoverCloseTimeout);
    if (audioPopoverCloseTimeout) clearTimeout(audioPopoverCloseTimeout);
    if (sourcePopoverCloseTimeout) clearTimeout(sourcePopoverCloseTimeout);
    realDebridSourceRefresh.dispose();
    if (autoPlayCountdownInterval) clearInterval(autoPlayCountdownInterval);
  });


  return renderPlayerShell({
    defaultEpisodeThumbnail: DEFAULT_EPISODE_THUMBNAIL,
    refs: {
      audioControl: (el) => { audioControl = el; },
      audioMenu: (el) => { audioMenu = el; },
      audioOptionsContainer: (el) => { audioOptionsContainer = el; },
      audioStatusBadge: (el) => { audioStatusBadge = el; },
      audioTabSubtitles: (el) => { audioTabSubtitles = el; },
      autoPlayBtn: (el) => { autoPlayBtn = el; },
      autoPlayCancel: (el) => { autoPlayCancel = el; },
      autoPlayCountdownText: (el) => { autoPlayCountdownText = el; },
      autoPlayEpLabel: (el) => { autoPlayEpLabel = el; },
      autoPlayOverlay: (el) => { autoPlayOverlay = el; },
      autoPlayProgressRing: (el) => { autoPlayProgressRing = el; },
      autoPlayThumb: (el) => { autoPlayThumb = el; },
      autoPlayTitle: (el) => { autoPlayTitle = el; },
      durationText: (el) => { durationText = el; },
      episodeLabel: (el) => { episodeLabel = el; },
      episodesBackToSeasons: (el) => { episodesBackToSeasons = el; },
      episodesControl: (el) => { episodesControl = el; },
      episodesList: (el) => { episodesList = el; },
      episodesOverline: (el) => { episodesOverline = el; },
      episodesPopoverTitle: (el) => { episodesPopoverTitle = el; },
      forward10: (el) => { forward10 = el; },
      goBack: (el) => { goBack = el; },
      hlsQualityControl: (el) => { hlsQualityControl = el; },
      hlsQualityMenu: (el) => { hlsQualityMenu = el; },
      hlsQualityOptionsContainer: (el) => { hlsQualityOptionsContainer = el; },
      liveStreamControl: (el) => { liveStreamControl = el; },
      liveStreamMenu: (el) => { liveStreamMenu = el; },
      liveStreamOptionsContainer: (el) => { liveStreamOptionsContainer = el; },
      nextEpisode: (el) => { nextEpisode = el; },
      playerShell: (el) => { playerShell = el; },
      resolverAlternateButton: (el) => { resolverAlternateButton = el; },
      resolverCountdown: (el) => { resolverCountdown = el; },
      resolverDetail: (el) => { resolverDetail = el; },
      resolverLoader: (el) => { resolverLoader = el; },
      resolverOverlay: (el) => { resolverOverlay = el; },
      resolverRetryButton: (el) => { resolverRetryButton = el; },
      resolverStatus: (el) => { resolverStatus = el; },
      resolverTitle: (el) => { resolverTitle = el; },
      rewind10: (el) => { rewind10 = el; },
      seekBar: (el) => { seekBar = el; },
      seekBufferedProgress: (el) => { seekBufferedProgress = el; },
      seekPlayedProgress: (el) => { seekPlayedProgress = el; },
      seekLoadingOverlay: (el) => { seekLoadingOverlay = el; },
      seekPreview: (el) => { seekPreview = el; },
      seekPreviewCanvas: (el) => { seekPreviewCanvas = el; },
      seekPreviewTime: (el) => { seekPreviewTime = el; },
      sourceControl: (el) => { sourceControl = el; },
      sourceMenu: (el) => { sourceMenu = el; },
      sourceOptionsContainer: (el) => { sourceOptionsContainer = el; },
      speedControl: (el) => { speedControl = el; },
      subtitleOptionsContainer: (el) => { subtitleOptionsContainer = el; },
      subtitleOverlay: (el) => { subtitleOverlay = el; },
      subtitlePanel: (el) => { subtitlePanel = el; },
      subtitleSyncEarlier: (el) => { subtitleSyncEarlier = el; },
      subtitleSyncLater: (el) => { subtitleSyncLater = el; },
      subtitleSyncReset: (el) => { subtitleSyncReset = el; },
      subtitleSyncValue: (el) => { subtitleSyncValue = el; },
      toggleAudio: (el) => { toggleAudio = el; },
      toggleEpisodes: (el) => { toggleEpisodes = el; },
      toggleFullscreen: (el) => { toggleFullscreen = el; },
      toggleHlsQuality: (el) => { toggleHlsQuality = el; },
      toggleLiveStream: (el) => { toggleLiveStream = el; },
      toggleMutePlayer: (el) => { toggleMutePlayer = el; },
      togglePlay: (el) => { togglePlay = el; },
      toggleSource: (el) => { toggleSource = el; },
      toggleSpeed: (el) => { toggleSpeed = el; },
      video: (el) => { video = el; },
      volumeControl: (el) => { volumeControl = el; },
      volumeSlider: (el) => { volumeSlider = el; },
    },
  });
}

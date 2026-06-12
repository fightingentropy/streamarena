import { onMount, onCleanup } from "solid-js";
import { parseWebVttCues } from "../player/subtitles.js";
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
  normalizeSourceHash,
  getSourceDisplayName,
  getSourceDisplayHint,
  getSourceDisplayMeta,
  isSourceOptionEmbed,
  sortSourcesBySeeders,
  isBrowserSafeAudioCodec,
} from "../player/sources.js";
import {
  readContinueWatchingMetaMap,
} from "../shared.js";
import {
  supportedAudioLangs,
  DEFAULT_STREAM_QUALITY_PREFERENCE,
  DEFAULT_AUDIO_LANGUAGE_PREF_KEY,
  SUBTITLE_COLOR_PREF_KEY,
  normalizeDefaultAudioLanguage,
} from "../lib/preferences.js";
import { LIVE_CHANNEL_PLAYBACK_FALLBACKS } from "../lib/live-channels.js";
import {
  deriveLiveStreamStateFromParams,
  getLivePlaybackSource,
  getSelectedLiveStreamOption as getSelectedLiveStreamOptionFromState,
  normalizeBrowserBoundLiveHlsReferer,
  normalizePlaybackSourceValue,
  renderLiveStreamOptions as renderLiveStreamOptionsDom,
  shouldShowLiveStreamControls as shouldShowLiveStreamControlsForState,
  syncLiveStreamControls as syncLiveStreamControlsDom,
  SOURCE_OPTION_ICON_SVG,
} from "../player/live-streams.js";
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
  createRemuxRouting,
  normalizeAudioSyncMs,
} from "../player/remux-routing.js";
import { normalizeResumeStartSeconds, withRemuxResumeStart } from "../player/resume-start.js";
import {
  attachFullscreenControl,
  isFullscreenActive,
  toggleFullscreenMode as togglePlayerFullscreenMode,
} from "../player/fullscreen.js";
import { setRuntimeStyleRule } from "../lib/runtime-styles.js";
import { renderPlayerShell } from "../player/player-shell-template.jsx";
import {
  buildWatchUrl,
  findSeriesEntryBySlug,
  loadWatchParams,
  normalizeInternalReturnToPath,
  saveWatchParams,
  slugifyTitle,
} from "../lib/watch-params.js";

export default function PlayerPage() {
  // ─── Ref declarations (replacing document.getElementById) ───
  let video, goBack, seekBar, seekPreview, seekPreviewCanvas, seekPreviewTime;
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
  let sourcePanel, sourceOptionsContainer, sourceOptionDetails, episodeLabel;
  let subtitleOverlay, resolverOverlay, resolverStatus, resolverLoader;
  let resolverTitle, resolverDetail, resolverCountdown;
  let resolverRetryButton, resolverAlternateButton;
  let seekLoadingOverlay, playerShell, liveEmbedFrame;
  let speedOptions = [];
  let closeSeekPreviewVideo = () => {};

const playbackRates = [0.5, 0.75, 1, 1.25, 1.5, 2];
const controlsHideDelayMs = 3000;
const popoverAutoOpenGraceMs = 650;
const singleClickToggleDelayMs = 220;
const seekLoadingTimeoutMs = 9000;
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
const LIVE_EDGE_PIN_RATIO = 0.985;
const LIVE_EDGE_PLAYBACK_OFFSET_SECONDS = 0.5;
const LIVE_EDGE_REJOIN_TOLERANCE_SECONDS = 2.5;
const LIVE_EMBED_FALLBACK_SOURCE_LIMIT = 5;
const LIVE_IFRAME_SOURCE_PREFIX = "live-iframe:";
const LIVE_IFRAME_ALLOW_POLICY = "autoplay; fullscreen; picture-in-picture; encrypted-media";
const LIVE_VISUAL_HEALTH_GRACE_MS = 12000;
const LIVE_VISUAL_HEALTH_INTERVAL_MS = 2000;
const LIVE_VISUAL_HEALTH_SAMPLE_WIDTH = 32;
const LIVE_VISUAL_HEALTH_SAMPLE_HEIGHT = 18;
const LIVE_VISUAL_HEALTH_MAX_BLANK_SAMPLES = 4;
const LIVE_VISUAL_HEALTH_MAX_AVG_LUMA = 8;
const LIVE_VISUAL_HEALTH_MIN_BRIGHT_PIXEL_RATIO = 0.012;
const LIVE_STARTUP_HEALTH_TIMEOUT_MS = 12000;
const LIVE_FAILED_STREAM_CACHE_TTL_MS = 5 * 60 * 1000;
const LIVE_FAILED_STREAM_CACHE_STORAGE_PREFIX = "netflix-live-failed-streams:";
const LIVE_WORKING_STREAM_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const LIVE_WORKING_STREAM_CACHE_STORAGE_PREFIX = "netflix-live-working-stream:";
const LIVE_SOURCE_PREFERENCE_STORAGE_KEY = "netflix-live-source-preferences";
const LIVE_SOURCE_PREFERENCE_TTL_MS = 24 * 60 * 60 * 1000;
const MANUAL_SOURCE_SWITCH_TIMEOUT_MS = 6000;

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
let seekLoadingTimeout = null;
let unavailableEpisodeResolverHideTimeout = null;
let audioDecodeRecoveryResetTimeout = null;
let subtitleRestoreAfterSourceChangeTimeout = null;
let tmdbSourceQueue = [];
let tmdbSourceAttemptIndex = 0;
let pendingManualSourceSwitchRestore = null;
let pendingManualSourceSwitchTimeout = null;
let tmdbSkipExternalEmbed = false;
let tmdbResolveRetries = 0;
let tmdbPlaybackRequestToken = 0;
let manualSourceSwitchRequestToken = 0;
let activeManualSourceSwitchRequestToken = 0;
let userRealDebridSettingsLoaded = false;
let userRealDebridConfigured = false;
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
let hasAppliedInitialResume = false;
let initialResumeRetryTimeout = 0;
let initialResumeAttemptCount = 0;
let initialResumeApplyDeadline = 0;
let pendingTranscodeSeekRatio = null;
let pendingStandardSeekRatio = null;
let activeTrackSourceInput = "";
let selectedAudioStreamIndex = -1;
let selectedSubtitleStreamIndex = -1;
let availableAudioTracks = [];
let availableSubtitleTracks = [];
let availablePlaybackSources = [];
let isFetchingPlaybackSources = false;
let playbackSourcesRequestToken = 0;
let resolverFailedSourceHashes = new Set();
let subtitleTrackElement = null;
let customSubtitleCues = [];
let customSubtitleCueCursor = 0;
let customSubtitleLoadToken = 0;
let subtitleRafId = 0;
let lastRenderedSubtitleCueIndex = -1;
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
let liveIframePlaybackBaseSeconds = 0;
let liveIframePlaybackStartedAtMs = 0;
let liveVisualHealthInterval = null;
let liveVisualHealthCanvas = null;
let liveVisualBlankSampleCount = 0;
let liveStartupHealthTimeout = null;
let liveStartupWatchArmed = false;
let liveAutoFallbackInFlight = false;
let liveAutoFallbackAttemptedStreamIds = new Set();
let liveFailedStreamCacheKey = "";
let liveFailedStreamStatuses = new Map();
let liveWorkingStreamCacheKey = "";
let liveWorkingStreamEntry = null;
let liveSourcePreferenceEntries = null;

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
  getSelectedAudioStreamIndex: () => selectedAudioStreamIndex,
  getSelectedSubtitleStreamIndex: () => selectedSubtitleStreamIndex,
  getPreferredSourceLanguage: () => preferredSourceLanguage,
  getPreferredContainer: () => preferredContainer,
  getPreferredSourceFormats: () => preferredSourceFormats,
  getPreferredResolverProvider: () => preferredResolverProvider,
  getSupportedSourceFormatSet: () => supportedSourceFormatSet,
  shouldPreferMobileLightTmdbSources: () => shouldPreferMobileLightTmdbSources(),
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
  getPreferredDefaultSourceHash,
} = playbackRouting;

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
});

// ─── Watch URL support: reproducible /watch?... plus legacy /watch/<slug> ───
function slugify(text) {
  return slugifyTitle(text);
}
function parseWatchPath() {
  const path = window.location.pathname;
  const match = path.match(/^\/watch(?:\/([^/]+))?(?:\/(\d+))?$/);
  if (!match) return null;
  return { slug: match[1] || "", episodeIndex: match[2] };
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
    _sessionParams = new URLSearchParams(_stored);
  }
}
const params = _sessionParams || new URLSearchParams(window.location.search);
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
const _needsSlugResolve = _isCleanUrl && _watchPath.slug && !_sessionParams;

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
const thumbParam = String(params.get("thumb") || "").trim();
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
const AUDIO_LANG_PREF_KEY_PREFIX = "netflix-audio-lang:movie:";
const SUBTITLE_LANG_PREF_KEY_PREFIX = "netflix-subtitle-lang:movie:";
const SUBTITLE_STREAM_PREF_KEY_PREFIX = "netflix-subtitle-stream:movie:";
const TV_SUBTITLE_LANG_PREF_KEY_PREFIX = "netflix-subtitle-lang:tv:";
const TV_SUBTITLE_STREAM_PREF_KEY_PREFIX = "netflix-subtitle-stream:tv:";
const LOCAL_SUBTITLE_LANG_PREF_KEY_PREFIX = "netflix-subtitle-lang:local:";
const LOCAL_SUBTITLE_STREAM_PREF_KEY_PREFIX = "netflix-subtitle-stream:local:";
const SOURCE_AUDIO_SYNC_PREF_KEY_PREFIX = "netflix-source-audio-sync:";
const DEFAULT_SOURCE_RESULTS_LIMIT = 5;
const SOURCE_FETCH_BATCH_LIMIT = 20;
const supportedQualityPreferences = new Set(["auto", "2160p", "1080p", "720p"]);
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
const INITIAL_RESUME_RETRY_MS = 250;
const INITIAL_RESUME_MAX_ATTEMPTS = 120;
const INITIAL_RESUME_APPLY_WINDOW_MS = 30000;
const INITIAL_RESUME_TOLERANCE_SECONDS = 2;
const RESUME_CLEAR_AT_END_THRESHOLD_SECONDS = 8;
const LOCAL_CACHE_UPGRADE_POLL_MS = 20_000;
const LOCAL_CACHE_UPGRADE_INITIAL_DELAY_MS = 8_000;
const CONTINUE_WATCHING_META_KEY = "netflix-continue-watching-meta";
const SUBTITLE_LINE_FROM_BOTTOM = -4;
const SUBTITLE_FALLBACK_LINE_PERCENT = 80;
const SUBTITLE_CUE_SIZE_PERCENT = 88;
const SUBTITLE_CUE_POSITION_PERCENT = 50;
const SUBTITLE_MATTE_LINE_LIFT_PERCENT = 8;
const SUBTITLE_MATTE_MIN_HEIGHT_PX = 18;
const SUBTITLE_MATTE_TOP_PADDING_PX = 6;
const SUBTITLE_MATTE_BOTTOM_PADDING_PX = 14;
const SUBTITLE_MATTE_BOTTOM_TARGET_OFFSET_PX = 82;
const SUBTITLE_MATTE_TOP_GUARD_RATIO = 0.35;
const subtitleLanguageNames = {
  off: "Off",
  un: "English",
  und: "English",
  en: "English",
  fr: "French",
  es: "Spanish",
  de: "German",
  it: "Italian",
  no: "Norwegian",
  pt: "Portuguese",
  uk: "Ukrainian",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  el: "Greek",
  sq: "Albanian",
  tr: "Turkish",
  ru: "Russian",
  ar: "Arabic",
  pl: "Polish",
  nl: "Dutch",
  ro: "Romanian",
};

// Benchmark API is deferred to onMount (needs video ref)
let playbackBenchmark = null;

let selectedSourceHash = normalizeSourceHash(sourceHashParam);
let currentTmdbPlaybackSessionKey = "";
let currentTmdbResolverProvider = "";
let currentTmdbResolvedFilename = "";
let currentTmdbSelectedFile = "";
let localCacheUpgradePollTimer = 0;
let localCacheUpgradeInitialTimer = 0;
let hasUpgradedToLocalCache = false;
let localCacheUpgradeInFlight = false;
let sourceSelectionPinned = Boolean(selectedSourceHash);
let automaticTmdbAlternateRecoveryInFlight = false;

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

function getAudioLangPreferenceStorageKey(movieTmdbId) {
  return `${AUDIO_LANG_PREF_KEY_PREFIX}${String(movieTmdbId || "").trim()}`;
}


function getStoredDefaultAudioLanguage() {
  try {
    return normalizeDefaultAudioLanguage(
      localStorage.getItem(DEFAULT_AUDIO_LANGUAGE_PREF_KEY),
    );
  } catch {
    return "en";
  }
}

function normalizePreferredQuality(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return DEFAULT_STREAM_QUALITY_PREFERENCE;
  if (normalized === "4k" || normalized === "uhd") return "2160p";
  if (normalized === "2160") return "2160p";
  if (normalized === "1080") return "1080p";
  if (normalized === "720") return "720p";
  if (supportedQualityPreferences.has(normalized)) {
    return normalized;
  }
  return DEFAULT_STREAM_QUALITY_PREFERENCE;
}

function shouldIncludePreferredQualityInUrl(value) {
  return Boolean(
    value &&
    value !== "auto" &&
    value !== DEFAULT_STREAM_QUALITY_PREFERENCE,
  );
}

function isRecognizedAudioLang(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "auto" || /^[a-z]{2}$/.test(normalized);
}

function normalizeSubtitlePreference(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw || raw === "auto") {
    return "";
  }
  if (raw === "off" || raw === "none" || raw === "disabled") {
    return "off";
  }
  if (/^[a-z]{2}$/.test(raw)) {
    return raw;
  }
  return raw.slice(0, 2);
}

function getSubtitleLangPreferenceStorageKey(movieTmdbId) {
  return `${SUBTITLE_LANG_PREF_KEY_PREFIX}${String(movieTmdbId || "").trim()}`;
}

function getSubtitleStreamPreferenceStorageKey(movieTmdbId) {
  return `${SUBTITLE_STREAM_PREF_KEY_PREFIX}${String(movieTmdbId || "").trim()}`;
}

function getTvSubtitlePreferenceKey() {
  const safeTmdbId = String(tmdbId || "").trim();
  if (!safeTmdbId) {
    return "";
  }
  const safeSeason = Math.max(1, Math.floor(Number(seasonNumber) || 1));
  const safeEpisode = Math.max(1, Math.floor(Number(episodeNumber) || 1));
  return `${safeTmdbId}:s${safeSeason}:e${safeEpisode}`;
}

function getTvSubtitleLangPreferenceStorageKey(tvKey) {
  return `${TV_SUBTITLE_LANG_PREF_KEY_PREFIX}${String(tvKey || "").trim()}`;
}

function getTvSubtitleStreamPreferenceStorageKey(tvKey) {
  return `${TV_SUBTITLE_STREAM_PREF_KEY_PREFIX}${String(tvKey || "").trim()}`;
}

function getLocalSubtitlePreferenceSourceKey() {
  if (!isExplicitLocalUploadSource) {
    return "";
  }
  if (isSeriesPlayback && activeSeries?.id) {
    return `series:${String(activeSeries.id).trim().toLowerCase()}:episode:${Math.max(0, Math.floor(Number(seriesEpisodeIndex) || 0))}`;
  }
  return String(src || "").trim();
}

function getLocalSubtitleLangPreferenceStorageKey(sourceKey) {
  return `${LOCAL_SUBTITLE_LANG_PREF_KEY_PREFIX}${String(sourceKey || "").trim()}`;
}

function getLocalSubtitleStreamPreferenceStorageKey(sourceKey) {
  return `${LOCAL_SUBTITLE_STREAM_PREF_KEY_PREFIX}${String(sourceKey || "").trim()}`;
}

function getSubtitlePreferenceStorageTarget() {
  if (isTmdbMoviePlayback && tmdbId) {
    return { scope: "movie", key: String(tmdbId || "").trim() };
  }

  if (isTmdbTvPlayback && tmdbId) {
    const tvKey = getTvSubtitlePreferenceKey();
    if (tvKey) {
      return { scope: "tv", key: tvKey };
    }
  }

  const localSourceKey = getLocalSubtitlePreferenceSourceKey();
  if (localSourceKey) {
    return { scope: "local", key: localSourceKey };
  }

  return null;
}

function getSubtitleLangPreferenceStorageKeyForTarget(target) {
  if (!target?.key) {
    return "";
  }
  if (target.scope === "movie") {
    return getSubtitleLangPreferenceStorageKey(target.key);
  }
  if (target.scope === "tv") {
    return getTvSubtitleLangPreferenceStorageKey(target.key);
  }
  return getLocalSubtitleLangPreferenceStorageKey(target.key);
}

function getSubtitleStreamPreferenceStorageKeyForTarget(target) {
  if (!target?.key) {
    return "";
  }
  if (target.scope === "movie") {
    return getSubtitleStreamPreferenceStorageKey(target.key);
  }
  if (target.scope === "tv") {
    return getTvSubtitleStreamPreferenceStorageKey(target.key);
  }
  return getLocalSubtitleStreamPreferenceStorageKey(target.key);
}

function getStoredSubtitleStreamPreferenceForTarget(target) {
  if (!target?.key) {
    return { mode: "unset", streamIndex: -1 };
  }
  const key = getSubtitleStreamPreferenceStorageKeyForTarget(target);
  if (!key) {
    return { mode: "unset", streamIndex: -1 };
  }

  try {
    const raw = String(localStorage.getItem(key) || "")
      .trim()
      .toLowerCase();
    if (!raw) {
      return { mode: "unset", streamIndex: -1 };
    }
    if (raw === "off" || raw === "-1") {
      return { mode: "off", streamIndex: -1 };
    }
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return { mode: "on", streamIndex: parsed };
    }
  } catch {
    // Ignore storage access issues.
  }

  return { mode: "unset", streamIndex: -1 };
}

function getStoredSubtitleLangForTarget(target) {
  if (!target?.key) {
    return "";
  }
  const key = getSubtitleLangPreferenceStorageKeyForTarget(target);
  if (!key) {
    return "";
  }

  try {
    return normalizeSubtitlePreference(localStorage.getItem(key));
  } catch {
    // Ignore storage access issues.
  }
  return "";
}

function getStoredSubtitleStreamPreferenceForTmdbMovie(movieTmdbId) {
  const normalizedTmdbId = String(movieTmdbId || "").trim();
  if (!normalizedTmdbId) {
    return { mode: "unset", streamIndex: -1 };
  }
  return getStoredSubtitleStreamPreferenceForTarget({
    scope: "movie",
    key: normalizedTmdbId,
  });
}

function getStoredSubtitleStreamPreferenceForCurrentPlayback() {
  const target = getSubtitlePreferenceStorageTarget();
  return getStoredSubtitleStreamPreferenceForTarget(target);
}

function getStoredSubtitleLangForTmdbMovie(movieTmdbId) {
  const normalizedTmdbId = String(movieTmdbId || "").trim();
  if (!normalizedTmdbId) {
    return "";
  }
  return getStoredSubtitleLangForTarget({
    scope: "movie",
    key: normalizedTmdbId,
  });
}

function getStoredSubtitleLangForCurrentPlayback() {
  const target = getSubtitlePreferenceStorageTarget();
  return getStoredSubtitleLangForTarget(target);
}

function persistSubtitleLangPreference(lang) {
  const target = getSubtitlePreferenceStorageTarget();
  if (!target?.key) {
    return;
  }

  const normalizedLang = normalizeSubtitlePreference(lang);
  const key = getSubtitleLangPreferenceStorageKeyForTarget(target);
  if (!key) {
    return;
  }
  try {
    if (!normalizedLang) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, normalizedLang);
  } catch {
    // Ignore storage access issues.
  }
}

function persistSubtitleStreamPreference(streamIndex) {
  const target = getSubtitlePreferenceStorageTarget();
  if (!target?.key) {
    return;
  }

  const key = getSubtitleStreamPreferenceStorageKeyForTarget(target);
  if (!key) {
    return;
  }
  const normalizedStreamIndex = Number.isInteger(Number(streamIndex))
    ? Number(streamIndex)
    : -1;
  try {
    if (normalizedStreamIndex < 0) {
      localStorage.setItem(key, "off");
      return;
    }
    localStorage.setItem(key, String(normalizedStreamIndex));
  } catch {
    // Ignore storage access issues.
  }
}

function getStoredAudioLangForTmdbMovie(movieTmdbId) {
  const normalizedTmdbId = String(movieTmdbId || "").trim();
  if (!normalizedTmdbId) {
    return "auto";
  }

  try {
    const raw = String(
      localStorage.getItem(
        getAudioLangPreferenceStorageKey(normalizedTmdbId),
      ) || "",
    )
      .trim()
      .toLowerCase();
    if (isRecognizedAudioLang(raw)) {
      return raw;
    }
  } catch {
    // Ignore storage access issues.
  }

  return "auto";
}

function persistAudioLangPreference(lang) {
  if (!isTmdbMoviePlayback || !tmdbId) {
    return;
  }

  const normalizedLang = isRecognizedAudioLang(String(lang || "").toLowerCase())
    ? String(lang).toLowerCase()
    : "auto";
  const key = getAudioLangPreferenceStorageKey(tmdbId);

  try {
    if (normalizedLang === "auto") {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, normalizedLang);
  } catch {
    // Ignore storage access issues.
  }
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
let resumeStorageKey = `netflix-resume:${sourceIdentity}`;
const speedStorageKey = "netflix-playback-speed";
let resumeTime = 0;
let lastPersistedResumeTime = 0;
let lastPersistedResumeAt = 0;
let resumeFlushIntervalId = 0;

function emptyRememberedTmdbSourceState() { return { sourceHash: "", sessionKey: "", resolverProvider: "", sourceInput: "", filename: "" }; }

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

function normalizeRememberedResolverProvider(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "real-debrid" || normalized === "local-torrent" || normalized === "external-embed") {
    return normalized;
  }
  return "";
}

function isTorrentResolverProvider(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "real-debrid" || normalized === "local-torrent";
}

function isTorrentResolverProviderEnabledForPlayback(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!isTorrentResolverProvider(normalized)) {
    return true;
  }
  if (!userRealDebridSettingsLoaded || !userRealDebridConfigured) {
    return false;
  }
  return normalized !== "local-torrent" || userLocalTorrentEnabled;
}

async function loadUserRealDebridPlaybackSettings() {
  if (!isTmdbResolvedPlayback) {
    return;
  }
  if (userRealDebridSettingsPromise) {
    await userRealDebridSettingsPromise;
    return;
  }
  userRealDebridSettingsPromise = fetch("/api/user/real-debrid", {
    cache: "no-store",
  })
    .then(async (response) => (response.ok ? response.json() : {}))
    .then((payload) => {
      userRealDebridConfigured = Boolean(payload?.configured);
      userLocalTorrentEnabled = Boolean(payload?.localTorrentEnabled);
    })
    .catch(() => {
      userRealDebridConfigured = false;
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
  return Boolean(userRealDebridSettingsLoaded && userRealDebridConfigured);
}

function isRememberedIframeOnlyExternalEmbed(remembered) {
  if (remembered?.resolverProvider !== "external-embed") {
    return false;
  }
  const sourceText = `${remembered.sourceInput || ""} ${remembered.filename || ""}`
    .trim()
    .toLowerCase();
  if (!sourceText || sourceText.includes("iframe") || sourceText.includes("live-iframe:")) {
    return true;
  }
  return !(
    sourceText.includes("player.videasy.net") ||
    sourceText.includes("vidlink.pro")
  );
}

function shouldIgnoreRememberedTmdbSourcePinForIframeFirst(remembered) {
  const hasRememberedPin = Boolean(
    normalizeSourceHash(selectedSourceHash) ||
      remembered.sourceHash ||
      remembered.sessionKey ||
      remembered.resolverProvider,
  );
  if (!hasRememberedPin || hasDirectSourceHashParam) {
    return false;
  }
  if (isRememberedIframeOnlyExternalEmbed(remembered)) {
    return true;
  }
  if (isTorrentResolverProvider(remembered.resolverProvider)) {
    return !isTorrentResolverProviderEnabledForPlayback(remembered.resolverProvider);
  }
  if (remembered.resolverProvider === "external-embed") {
    return false;
  }
  if (
    isTorrentResolverProvider(preferredResolverProvider) &&
    isTorrentResolverProviderEnabledForPlayback(preferredResolverProvider)
  ) {
    return false;
  }
  return true;
}

function getRememberedContinueWatchingSourceState() {
  const normalizedSource = String(sourceIdentity || "").trim();
  if (!normalizedSource) {
    return emptyRememberedTmdbSourceState();
  }
  try {
    const metaMap = readContinueWatchingMetaMap();
    const entry = metaMap?.[normalizedSource];
    if (!entry || typeof entry !== "object") {
      return emptyRememberedTmdbSourceState();
    }
    return {
      sourceHash: normalizeSourceHash(entry.sourceHash || ""),
      sessionKey: String(entry.sessionKey || "").trim(),
      resolverProvider: normalizeRememberedResolverProvider(entry.resolverProvider),
      sourceInput: String(entry.sourceInput || "").trim(),
      filename: String(entry.filename || "").trim(),
    };
  } catch {
    return emptyRememberedTmdbSourceState();
  }
}

function rememberServerContinueWatchingEntry(entry) {
  const normalizedSource = String(sourceIdentity || "").trim();
  const sourceFromEntry = String(entry?.sourceIdentity || "").trim();
  if (!normalizedSource || sourceFromEntry !== normalizedSource) {
    return false;
  }

  try {
    const metaMap = readContinueWatchingMetaMap();
    const existing =
      metaMap?.[normalizedSource] && typeof metaMap[normalizedSource] === "object"
        ? metaMap[normalizedSource]
        : {};
    const nextEntry = {
      ...existing,
      ...entry,
      sourceIdentity: normalizedSource,
      sourceHash: normalizeSourceHash(
        Object.prototype.hasOwnProperty.call(entry, "sourceHash")
          ? entry.sourceHash
          : existing.sourceHash || "",
      ),
      sessionKey: String(
        Object.prototype.hasOwnProperty.call(entry, "sessionKey")
          ? entry.sessionKey
          : existing.sessionKey || "",
      ).trim(),
      resolverProvider: normalizeRememberedResolverProvider(
        Object.prototype.hasOwnProperty.call(entry, "resolverProvider")
          ? entry.resolverProvider
          : existing.resolverProvider,
      ),
      sourceInput: String(
        Object.prototype.hasOwnProperty.call(entry, "sourceInput")
          ? entry.sourceInput
          : existing.sourceInput || "",
      ).trim(),
      filename: String(
        Object.prototype.hasOwnProperty.call(entry, "filename")
          ? entry.filename
          : existing.filename || "",
      ).trim(),
      resumeSeconds: Number(entry.resumeSeconds || existing.resumeSeconds || 0),
      updatedAt: Number(entry.updatedAt || existing.updatedAt || Date.now()),
    };
    metaMap[normalizedSource] = nextEntry;
    localStorage.setItem(CONTINUE_WATCHING_META_KEY, JSON.stringify(metaMap));
    return true;
  } catch {
    return false;
  }
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
  fetch("/api/user/watch-progress")
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

function parseTmdbTvSourceIdentity(value) {
  const match = /^tmdb:tv:(\d+)(?::s(\d+):e(\d+))?$/i.exec(
    String(value || "").trim(),
  );
  return match
    ? {
        tmdbId: String(match[1] || "").trim(),
        seasonNumber: Number(match[2] || 0) || 0,
        episodeNumber: Number(match[3] || 0) || 0,
      }
    : { tmdbId: "", seasonNumber: 0, episodeNumber: 0 };
}

function getContinueWatchingSeriesKey(sourceValue, metadata = {}) {
  const seriesId = String(metadata?.seriesId || "")
    .trim()
    .toLowerCase();
  if (seriesId) {
    return `series:${seriesId}`;
  }
  const tmdbId = String(metadata?.tmdbId || "").trim();
  const mediaType = String(metadata?.mediaType || "")
    .trim()
    .toLowerCase();
  if (mediaType === "tv" && tmdbId) {
    return `tmdb:tv:${tmdbId}`;
  }
  const parsedTmdbSource = parseTmdbTvSourceIdentity(sourceValue);
  if (parsedTmdbSource.tmdbId) {
    return `tmdb:tv:${parsedTmdbSource.tmdbId}`;
  }
  const seriesMatch = /^series:([^:]+):episode:\d+$/i.exec(
    String(sourceValue || "").trim(),
  );
  return seriesMatch
    ? `series:${String(seriesMatch[1] || "").trim().toLowerCase()}`
    : "";
}

function persistContinueWatchingEntry(resumeSeconds) {
  const normalizedSource = String(sourceIdentity || "").trim();
  if (
    !normalizedSource ||
    !Number.isFinite(resumeSeconds) ||
    resumeSeconds < 1
  ) {
    return;
  }

  try {
    const metadata = getCanonicalContinueWatchingMetadata();
    const metaMap = readContinueWatchingMetaMap();
    const nextSeriesKey = getContinueWatchingSeriesKey(
      normalizedSource,
      metadata,
    );
    if (nextSeriesKey) {
      Object.keys(metaMap).forEach((storedSource) => {
        if (
          storedSource !== normalizedSource &&
          getContinueWatchingSeriesKey(storedSource, metaMap[storedSource]) ===
            nextSeriesKey
        ) {
          delete metaMap[storedSource];
        }
      });
    }
    metaMap[normalizedSource] = {
      sourceIdentity: normalizedSource,
      title: metadata.title,
      episode: metadata.episode,
      src: metadata.src,
      tmdbId: metadata.tmdbId,
      mediaType: metadata.mediaType,
      seriesId: metadata.seriesId,
      episodeIndex: metadata.episodeIndex,
      seasonNumber: metadata.seasonNumber,
      episodeNumber: metadata.episodeNumber,
      year: metadata.year,
      thumb: metadata.thumb,
      sourceHash: metadata.sourceHash,
      sessionKey: metadata.sessionKey,
      resolverProvider: metadata.resolverProvider,
      sourceInput: metadata.sourceInput,
      filename: metadata.filename,
      resumeSeconds: Number(resumeSeconds),
      updatedAt: Date.now(),
    };
    localStorage.setItem(CONTINUE_WATCHING_META_KEY, JSON.stringify(metaMap));
  } catch {
    // Ignore storage access issues.
  }
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
  fetch("/api/user/continue-watching", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceIdentity: normalizedSource,
      resumeSeconds,
      ...metadata,
      updatedAt: Date.now(),
    }),
    keepalive,
  }).catch(() => {});
}

function removeContinueWatchingEntry() {
  const normalizedSource = String(sourceIdentity || "").trim();
  if (!normalizedSource) {
    return;
  }

  try {
    const metaMap = readContinueWatchingMetaMap();
    if (metaMap && typeof metaMap === "object") {
      delete metaMap[normalizedSource];
      const hasEntries = Object.keys(metaMap).length > 0;
      if (hasEntries) {
        localStorage.setItem(
          CONTINUE_WATCHING_META_KEY,
          JSON.stringify(metaMap),
        );
      } else {
        localStorage.removeItem(CONTINUE_WATCHING_META_KEY);
      }
    }
  } catch {
    // Ignore storage access issues.
  }

  // Sync deletion to server in background
  fetch("/api/user/continue-watching", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceIdentity: normalizedSource }),
  }).catch(() => {});
}

function hasInitialResumeTarget() {
  return Number.isFinite(resumeTime) && resumeTime > 1;
}

function getInitialPlaybackStartSeconds() { return hasInitialResumeTarget() ? normalizeResumeStartSeconds(resumeTime) : 0; }

function clearInitialResumeRetry() {
  if (initialResumeRetryTimeout) {
    window.clearTimeout(initialResumeRetryTimeout);
    initialResumeRetryTimeout = 0;
  }
}

function resetInitialResumeApplication() {
  clearInitialResumeRetry();
  initialResumeAttemptCount = 0;
  hasAppliedInitialResume = false;
  initialResumeApplyDeadline = hasInitialResumeTarget()
    ? Date.now() + INITIAL_RESUME_APPLY_WINDOW_MS
    : 0;
}

function markInitialResumeHandled() {
  clearInitialResumeRetry();
  initialResumeAttemptCount = 0;
  hasAppliedInitialResume = true;
  initialResumeApplyDeadline = 0;
}

function isCurrentTimeAtInitialResumeTarget() {
  if (!hasInitialResumeTarget()) {
    return true;
  }
  const current = getEffectiveCurrentTime();
  return (
    Number.isFinite(current) &&
    current >= resumeTime - INITIAL_RESUME_TOLERANCE_SECONDS
  );
}

function shouldHoldProgressSaveForInitialResume(effectiveCurrentTime) {
  return (
    hasInitialResumeTarget() &&
    initialResumeApplyDeadline > 0 &&
    Date.now() <= initialResumeApplyDeadline &&
    Number.isFinite(effectiveCurrentTime) &&
    effectiveCurrentTime < resumeTime - INITIAL_RESUME_TOLERANCE_SECONDS
  );
}

function applyInitialResumeIfReady() {
  if (!hasInitialResumeTarget()) {
    hasAppliedInitialResume = true;
    return true;
  }

  if (hasAppliedInitialResume && isCurrentTimeAtInitialResumeTarget()) {
    return true;
  }

  if (
    hasAppliedInitialResume &&
    initialResumeApplyDeadline > 0 &&
    Date.now() <= initialResumeApplyDeadline &&
    !isCurrentTimeAtInitialResumeTarget()
  ) {
    hasAppliedInitialResume = false;
  }

  if (hasAppliedInitialResume) {
    return true;
  }

  const seekScaleDurationSeconds = getSeekScaleDurationSeconds();
  if (
    !Number.isFinite(seekScaleDurationSeconds) ||
    seekScaleDurationSeconds <= 0 ||
    resumeTime >= seekScaleDurationSeconds - RESUME_CLEAR_AT_END_THRESHOLD_SECONDS
  ) {
    return false;
  }

  try {
    if (isTranscodeSourceActive()) {
      const relativeResume = resumeTime - transcodeBaseOffsetSeconds;
      if (
        relativeResume >= 0 &&
        Number.isFinite(video.duration) &&
        relativeResume < video.duration - 3
      ) {
        video.currentTime = relativeResume;
      } else {
        seekToAbsoluteTime(resumeTime, { isInitialResume: true });
      }
    } else {
      const timelineDurationSeconds = getTimelineDurationSeconds();
      if (
        !Number.isFinite(timelineDurationSeconds) ||
        timelineDurationSeconds <= 0 ||
        resumeTime >= timelineDurationSeconds - RESUME_CLEAR_AT_END_THRESHOLD_SECONDS
      ) {
        return false;
      }
      video.currentTime = resumeTime;
    }

    hasAppliedInitialResume = true;
    clearInitialResumeRetry();
    syncSeekState();
    return true;
  } catch {
    return false;
  }
}

function scheduleInitialResumeRetry() {
  if (
    hasAppliedInitialResume ||
    !hasInitialResumeTarget() ||
    initialResumeRetryTimeout ||
    initialResumeAttemptCount >= INITIAL_RESUME_MAX_ATTEMPTS
  ) {
    return;
  }

  initialResumeAttemptCount += 1;
  initialResumeRetryTimeout = window.setTimeout(() => {
    initialResumeRetryTimeout = 0;
    if (!applyInitialResumeIfReady()) {
      scheduleInitialResumeRetry();
    }
  }, INITIAL_RESUME_RETRY_MS);
}

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

function isResolvingSource() {
  return Boolean(
    resolverOverlay &&
    !resolverOverlay.hidden &&
    !resolverOverlay.classList.contains("is-error"),
  );
}

function clearSeekLoadingTimeout() {
  if (seekLoadingTimeout !== null) {
    window.clearTimeout(seekLoadingTimeout);
    seekLoadingTimeout = null;
  }
}

function showSeekLoadingIndicator() {
  if (!seekLoadingOverlay || isResolvingSource()) {
    return;
  }
  seekLoadingOverlay.hidden = false;
  clearSeekLoadingTimeout();
  seekLoadingTimeout = window.setTimeout(() => {
    seekLoadingTimeout = null;
    hideSeekLoadingIndicator();
  }, seekLoadingTimeoutMs);
}

function hideSeekLoadingIndicator() {
  if (!seekLoadingOverlay) {
    return;
  }
  clearSeekLoadingTimeout();
  seekLoadingOverlay.hidden = true;
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
  if (hasExplicitSource && !showStatus && !isError) {
    hideResolver();
    return;
  }

  if (!resolverOverlay) {
    return;
  }

  const shouldShowStatus = showStatus || isError || isRecovery;
  if (resolverStatus) {
    resolverStatus.textContent =
      String(message || "").trim() || "Unable to load this video.";
    resolverStatus.hidden = !shouldShowStatus;
  }
  if (resolverTitle) {
    resolverTitle.textContent = String(title || "").trim();
    resolverTitle.hidden = !isRecovery || !resolverTitle.textContent;
  }
  if (resolverDetail) {
    resolverDetail.textContent = String(detail || "").trim();
    resolverDetail.hidden = !isRecovery || !resolverDetail.textContent;
  }
  if (resolverCountdown) {
    resolverCountdown.textContent = String(countdown || "").trim();
    resolverCountdown.hidden = !isRecovery || !resolverCountdown.textContent;
  }
  const shouldShowRetry = (isRecovery || isError) && showRetry;
  const shouldShowAlternate = (isRecovery || isError) && showAlternate;
  if (resolverRetryButton) {
    resolverRetryButton.hidden = !shouldShowRetry;
  }
  if (resolverAlternateButton) {
    resolverAlternateButton.hidden = !shouldShowAlternate;
  }
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

function hideResolver() {
  if (!resolverOverlay) {
    return;
  }

  resolverOverlay.hidden = true;
  resolverOverlay.classList.remove("is-error");
  resolverOverlay.classList.remove("is-recovery");
  resolverOverlay.classList.remove("has-status");
  resolverOverlay.classList.remove("has-actions");
  if (resolverLoader) {
    resolverLoader.hidden = false;
  }
  if (resolverStatus) {
    resolverStatus.hidden = true;
  }
  if (resolverTitle) {
    resolverTitle.hidden = true;
  }
  if (resolverDetail) {
    resolverDetail.hidden = true;
  }
  if (resolverCountdown) {
    resolverCountdown.hidden = true;
  }
  if (resolverRetryButton) {
    resolverRetryButton.hidden = true;
  }
  if (resolverAlternateButton) {
    resolverAlternateButton.hidden = true;
  }
  if (isLiveIframePlaybackActive()) {
    scheduleControlsHide();
  }
}

function normalizeResolverFailureMessage(
  errorOrMessage,
  fallbackMessage = "Unable to resolve this stream.",
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

function getLanguageDisplayLabel(langCode) {
  const normalized = String(langCode || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return "Unknown";
  }
  if (normalized in subtitleLanguageNames) {
    return subtitleLanguageNames[normalized];
  }
  return normalized.toUpperCase();
}

function isGenericSubtitleLabel(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  if (!normalized) {
    return true;
  }
  return (
    normalized === "subtitlehandler" ||
    normalized === "subtitles" ||
    normalized === "subtitle" ||
    normalized === "texthandler" ||
    normalized === "text"
  );
}

function getSubtitleTrackSourceLabel(track) {
  if (!track?.isExternal) {
    return "";
  }

  const vttUrl = String(track?.vttUrl || "").trim();
  if (vttUrl.includes("/api/subtitles.opensubtitles.vtt")) {
    return "OpenSubtitles";
  }
  if (vttUrl.includes("/api/subtitles.vtt")) {
    return "Local file";
  }
  if (vttUrl.includes("/api/subtitles.external.vtt")) {
    return "External";
  }
  return "External";
}

function getSubtitleTrackDisplayLabel(track) {
  return getLanguageDisplayLabel(track?.language || "en");
}

function getSubtitleTrackDisplayParts(track) {
  const languageLabel = getLanguageDisplayLabel(track?.language || "en");
  const primary = languageLabel;
  const secondaryParts = [];
  if (isLikelyForcedSubtitleTrack(track)) {
    secondaryParts.push("Forced");
  }
  return {
    primary,
    secondary: secondaryParts.join(" • "),
  };
}

function isGenericAudioLabel(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  if (!normalized) {
    return true;
  }
  return (
    normalized === "soundhandler" ||
    normalized === "audiohandler" ||
    normalized === "stereomix" ||
    normalized === "audio" ||
    normalized === "track"
  );
}

function formatAudioChannelLabel(channels) {
  const safeChannels = Number(channels);
  if (!Number.isFinite(safeChannels) || safeChannels <= 0) {
    return "";
  }
  if (safeChannels === 1) {
    return "Mono";
  }
  if (safeChannels === 2) {
    return "Stereo";
  }
  if (safeChannels === 6) {
    return "5.1";
  }
  if (safeChannels === 8) {
    return "7.1";
  }
  return `${Math.floor(safeChannels)}ch`;
}

function getAudioTrackDisplayLabel(track) {
  const { primary } = getAudioTrackDisplayParts(track);
  return primary;
}

function getAudioTrackDisplayParts(track) {
  const languageLabel = getLanguageDisplayLabel(track?.language || "und");
  return {
    primary: languageLabel,
    secondary: "",
  };
}

function getAudioTrackBadgeLabel(track) {
  const languageCode = String(track?.language || "")
    .trim()
    .toUpperCase();
  if (/^[A-Z]{2,3}$/.test(languageCode)) {
    return languageCode.slice(0, 3);
  }
  const languageLabel = getLanguageDisplayLabel(track?.language || "und");
  return languageLabel.slice(0, 2).toUpperCase();
}

function getUnknownAudioTrackDisplayLabel() {
  return "Default";
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

// parseVttTimestampToSeconds, decodeSubtitleHtmlEntities, isVttTimingLine,
// parseWebVttCues — imported from ./src-ui/player/subtitles.js

function setCustomSubtitleText(value) {
  if (!subtitleOverlay) {
    return;
  }
  const normalized = String(value || "").replace(/\r/g, "").trim();
  if (!normalized) {
    subtitleOverlay.hidden = true;
    subtitleOverlay.textContent = "";
    return;
  }

  subtitleOverlay.hidden = false;
  subtitleOverlay.textContent = "";
  let lines = normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 2) {
    lines = [lines.slice(0, -1).join(" "), lines[lines.length - 1]];
  }
  lines.forEach((line, lineIndex) => {
    const span = document.createElement("span");
    span.textContent = line;
    subtitleOverlay.appendChild(span);
    if (lineIndex < lines.length - 1) {
      subtitleOverlay.appendChild(document.createElement("br"));
    }
  });
}

function clearCustomSubtitleOverlay({ invalidateToken = false } = {}) {
  if (invalidateToken) {
    customSubtitleLoadToken += 1;
  }
  customSubtitleCues = [];
  customSubtitleCueCursor = 0;
  lastRenderedSubtitleCueIndex = -1;
  setCustomSubtitleText("");
}

function startSubtitleRafLoop() {
  if (subtitleRafId) return;
  function tick() {
    renderCustomSubtitleOverlay();
    subtitleRafId = requestAnimationFrame(tick);
  }
  subtitleRafId = requestAnimationFrame(tick);
}

function stopSubtitleRafLoop() {
  if (subtitleRafId) {
    cancelAnimationFrame(subtitleRafId);
    subtitleRafId = 0;
  }
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

function findSubtitleCueAtTime(cues, timeSeconds) {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const cue = cues[mid];
    if (timeSeconds < cue.startSeconds) {
      hi = mid - 1;
    } else if (timeSeconds > cue.endSeconds) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
}

function renderCustomSubtitleOverlay() {
  if (!subtitleOverlay || selectedSubtitleStreamIndex < 0) {
    if (lastRenderedSubtitleCueIndex !== -1) {
      lastRenderedSubtitleCueIndex = -1;
      setCustomSubtitleText("");
    }
    return;
  }
  if (!customSubtitleCues.length) {
    if (lastRenderedSubtitleCueIndex !== -1) {
      lastRenderedSubtitleCueIndex = -1;
      setCustomSubtitleText("");
    }
    return;
  }

  const currentTimeSeconds = Number(getEffectiveCurrentTime() || 0);
  if (!Number.isFinite(currentTimeSeconds) || currentTimeSeconds < 0) {
    return;
  }

  // Fast path: check if cursor still matches.
  let cueIndex =
    customSubtitleCueCursor >= 0 &&
    customSubtitleCueCursor < customSubtitleCues.length
      ? customSubtitleCueCursor
      : -1;
  if (
    cueIndex >= 0 &&
    currentTimeSeconds >= customSubtitleCues[cueIndex].startSeconds &&
    currentTimeSeconds <= customSubtitleCues[cueIndex].endSeconds
  ) {
    if (lastRenderedSubtitleCueIndex !== cueIndex) {
      lastRenderedSubtitleCueIndex = cueIndex;
      setCustomSubtitleText(customSubtitleCues[cueIndex].text);
    }
    return;
  }

  // Check next cue (common sequential advance).
  const nextIndex = (customSubtitleCueCursor || 0) + 1;
  if (
    nextIndex < customSubtitleCues.length &&
    currentTimeSeconds >= customSubtitleCues[nextIndex].startSeconds &&
    currentTimeSeconds <= customSubtitleCues[nextIndex].endSeconds
  ) {
    customSubtitleCueCursor = nextIndex;
    if (lastRenderedSubtitleCueIndex !== nextIndex) {
      lastRenderedSubtitleCueIndex = nextIndex;
      setCustomSubtitleText(customSubtitleCues[nextIndex].text);
    }
    return;
  }

  // Binary search for arbitrary position (seek, skip, etc.).
  cueIndex = findSubtitleCueAtTime(customSubtitleCues, currentTimeSeconds);
  if (cueIndex >= 0) {
    customSubtitleCueCursor = cueIndex;
    if (lastRenderedSubtitleCueIndex !== cueIndex) {
      lastRenderedSubtitleCueIndex = cueIndex;
      setCustomSubtitleText(customSubtitleCues[cueIndex].text);
    }
    return;
  }

  if (lastRenderedSubtitleCueIndex !== -1) {
    lastRenderedSubtitleCueIndex = -1;
    setCustomSubtitleText("");
  }
}

async function loadCustomSubtitleFromTrack(track) {
  const vttUrl = String(track?.vttUrl || "").trim();
  if (!vttUrl) {
    clearCustomSubtitleOverlay({ invalidateToken: true });
    return false;
  }

  const requestToken = customSubtitleLoadToken + 1;
  customSubtitleLoadToken = requestToken;
  customSubtitleCues = [];
  customSubtitleCueCursor = 0;
  setCustomSubtitleText("");
  if (subtitleOverlay) {
    subtitleOverlay.lang = String(track?.language || "en").trim() || "en";
  }

  try {
    const requestUrl = `${vttUrl}${vttUrl.includes("?") ? "&" : "?"}ts=${Date.now()}`;
    const response = await fetch(requestUrl, { cache: "no-store" });
    if (!response.ok) {
      return false;
    }
    const rawVtt = await response.text();
    if (requestToken !== customSubtitleLoadToken) {
      return false;
    }
    customSubtitleCues = parseWebVttCues(rawVtt);
    customSubtitleCueCursor = 0;
    lastRenderedSubtitleCueIndex = -1;
    renderCustomSubtitleOverlay();
    if (!video.paused && !video.ended) {
      startSubtitleRafLoop();
    }
    return customSubtitleCues.length > 0;
  } catch {
    if (requestToken === customSubtitleLoadToken) {
      clearCustomSubtitleOverlay();
    }
    return false;
  }
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
  if (!sourceOptionDetails) {
    return;
  }
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
  const optionButtons = Array.from(
    sourceOptionsContainer.querySelectorAll(".source-option"),
  );
  optionButtons.forEach((optionButton) => {
    const optionHash = normalizeSourceHash(
      optionButton.dataset.sourceHash || "",
    );
    optionButton.setAttribute(
      "aria-selected",
      optionHash && normalizedHash && optionHash === normalizedHash
        ? "true"
        : "false",
    );
  });
}

function renderSourceOptionButtons() {
  if (!(sourceOptionsContainer instanceof HTMLElement)) {
    return;
  }

  sourceOptionsContainer.innerHTML = "";

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
  const displayedSources = [];
  const fragment = document.createDocumentFragment();
  const rankedSources = sortSourcesBySeeders(availablePlaybackSources, {
    preferContainer: getSourceListPreferredContainer(),
  });
  const sourceDisplayLimit = Math.max(
    preferredSourceResultsLimit,
    rankedSources.filter((option) => isSourceOptionEmbed(option)).length,
  );
  const selectedSourceIndex = rankedSources.findIndex(
    (option) =>
      normalizeSourceHash(option?.sourceHash || option?.infoHash || "") ===
      normalizeSourceHash(selectedSourceHash),
  );
  if (selectedSourceIndex > 0) {
    const [selectedSource] = rankedSources.splice(selectedSourceIndex, 1);
    rankedSources.unshift(selectedSource);
  }
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

    const sourceOptionButton = document.createElement("button");
    sourceOptionButton.className = "audio-option source-option";
    sourceOptionButton.type = "button";
    sourceOptionButton.setAttribute("role", "option");
    sourceOptionButton.dataset.sourceHash = sourceHash;
    sourceOptionButton.setAttribute(
      "aria-selected",
      sourceHash === selectedSourceHash ? "true" : "false",
    );

    const iconBadge = document.createElement("span");
    iconBadge.className = "source-option-icon";
    iconBadge.setAttribute("aria-hidden", "true");
    iconBadge.innerHTML = SOURCE_OPTION_ICON_SVG;

    const textWrap = document.createElement("span");
    textWrap.className = "source-option-text";

    const nameLine = document.createElement("span");
    nameLine.className = "source-option-name";
    nameLine.textContent = getSourceDisplayName(option);
    textWrap.appendChild(nameLine);

    const hintText = getSourceDisplayHint(option);
    const metaText = getSourceDisplayMeta(option);

    if (hintText) {
      const hintLine = document.createElement("span");
      hintLine.className = "source-option-hint";
      hintLine.textContent = hintText;
      textWrap.appendChild(hintLine);
    }

    if (metaText) {
      const metaLine = document.createElement("span");
      metaLine.className = "source-option-meta";
      metaLine.textContent = metaText;
      textWrap.appendChild(metaLine);
    }

    sourceOptionButton.append(iconBadge, textWrap);
    fragment.appendChild(sourceOptionButton);
    displayedSources.push(option);
  }

  sourceOptionsContainer.appendChild(fragment);
  if (!seenHashes.size) {
    const emptyState = document.createElement("p");
    emptyState.className = "source-option-empty";
    emptyState.textContent = "No alternate sources available yet.";
    sourceOptionsContainer.appendChild(emptyState);
    if (sourceOptionDetails) {
      sourceOptionDetails.hidden = true;
      sourceOptionDetails.textContent = "";
    }
    return;
  }

  const preferredDefaultSourceHash =
    getPreferredDefaultSourceHash(displayedSources);
  const normalizedSelectedSourceHash = normalizeSourceHash(selectedSourceHash);
  const hasSelectedInOptions =
    normalizedSelectedSourceHash &&
    seenHashes.has(normalizedSelectedSourceHash);
  if (sourceSelectionPinned && !hasSelectedInOptions) {
    sourceSelectionPinned = false;
  }
  if (
    preferredDefaultSourceHash &&
    (!normalizedSelectedSourceHash || !hasSelectedInOptions)
  ) {
    selectedSourceHash = preferredDefaultSourceHash;
    applyPreferredSourceAudioSync(selectedSourceHash);
    persistSourceHashInUrl();
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
  if (!isTmdbResolvedPlayback || hasUpgradedToLocalCache) {
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

function stopLocalCacheUpgradeWatch() {
  if (localCacheUpgradePollTimer) {
    window.clearInterval(localCacheUpgradePollTimer);
    localCacheUpgradePollTimer = 0;
  }
  if (localCacheUpgradeInitialTimer) {
    window.clearTimeout(localCacheUpgradeInitialTimer);
    localCacheUpgradeInitialTimer = 0;
  }
}

function startLocalCacheUpgradeWatch(resolved) {
  stopLocalCacheUpgradeWatch();
  hasUpgradedToLocalCache = false;
  if (!shouldWatchForLocalCacheUpgrade(resolved)) {
    return;
  }
  localCacheUpgradeInitialTimer = window.setTimeout(() => {
    localCacheUpgradeInitialTimer = 0;
    void pollLocalCacheUpgrade();
  }, LOCAL_CACHE_UPGRADE_INITIAL_DELAY_MS);
  localCacheUpgradePollTimer = window.setInterval(() => {
    void pollLocalCacheUpgrade();
  }, LOCAL_CACHE_UPGRADE_POLL_MS);
}

async function pollLocalCacheUpgrade() {
  if (
    localCacheUpgradeInFlight ||
    hasUpgradedToLocalCache ||
    !isTmdbResolvedPlayback ||
    isResolvingSource() ||
    isRecoveringTmdbStream ||
    !selectedSourceHash
  ) {
    return;
  }
  const activeSource = String(
    lastRequestedPlaybackSource || video.currentSrc || "",
  ).trim();
  if (!activeSource || isLocalPlaybackSource(activeSource)) {
    stopLocalCacheUpgradeWatch();
    return;
  }
  localCacheUpgradeInFlight = true;
  try {
    const payload = await requestJson(buildLocalCacheUpgradeUrl(), {}, 8000);
    if (!payload?.ready || !payload?.playableUrl) {
      return;
    }
    await upgradePlaybackToLocalCache(payload);
  } catch {
    // Best effort; keep streaming from the current remote source.
  } finally {
    localCacheUpgradeInFlight = false;
  }
}

async function upgradePlaybackToLocalCache(payload) {
  if (hasUpgradedToLocalCache) {
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

  hasUpgradedToLocalCache = true;
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
  const viewportWidth = Number(video.clientWidth || 0);
  const viewportHeight = Number(video.clientHeight || 0);
  const mediaWidth = Number(video.videoWidth || 0);
  const mediaHeight = Number(video.videoHeight || 0);
  if (
    viewportWidth <= 0 ||
    viewportHeight <= 0 ||
    mediaWidth <= 0 ||
    mediaHeight <= 0
  ) {
    return null;
  }

  const scale = Math.min(
    viewportWidth / mediaWidth,
    viewportHeight / mediaHeight,
  );
  if (!Number.isFinite(scale) || scale <= 0) {
    return null;
  }
  const renderedHeight = mediaHeight * scale;
  const matteHeight = Math.max(0, (viewportHeight - renderedHeight) / 2);
  if (
    !Number.isFinite(matteHeight) ||
    matteHeight < SUBTITLE_MATTE_MIN_HEIGHT_PX
  ) {
    return null;
  }

  const bottomMatteTop = viewportHeight - matteHeight;
  const matteTopBoundary = bottomMatteTop + SUBTITLE_MATTE_TOP_PADDING_PX;
  const matteBottomBoundary = viewportHeight - SUBTITLE_MATTE_BOTTOM_PADDING_PX;
  if (matteBottomBoundary <= matteTopBoundary) {
    return null;
  }

  const guardedTopTarget =
    matteTopBoundary + matteHeight * SUBTITLE_MATTE_TOP_GUARD_RATIO;
  const preferredBottomTarget =
    viewportHeight - SUBTITLE_MATTE_BOTTOM_TARGET_OFFSET_PX;
  const targetY = Math.min(
    matteBottomBoundary,
    Math.max(
      matteTopBoundary,
      Math.max(guardedTopTarget, preferredBottomTarget),
    ),
  );
  const linePercent = (targetY / viewportHeight) * 100;
  return Math.max(0, Math.min(100, Number(linePercent.toFixed(2))));
}

function nudgeSubtitleTrackPlacementUp(textTrack) {
  if (!textTrack || !textTrack.cues) {
    return;
  }
  const matteCenteredLinePercent = computeSubtitleLinePercentInBottomMatte();
  const resolvedLinePercent =
    matteCenteredLinePercent !== null
      ? Math.max(
          0,
          Math.min(100, matteCenteredLinePercent - SUBTITLE_MATTE_LINE_LIFT_PERCENT),
        )
      : SUBTITLE_FALLBACK_LINE_PERCENT;

  Array.from(textTrack.cues).forEach((cue) => {
    if (!cue) {
      return;
    }

    try {
      if ("snapToLines" in cue) {
        cue.snapToLines = false;
      }
      if ("line" in cue) {
        cue.line = Number(resolvedLinePercent.toFixed(2));
      } else {
        cue.line = SUBTITLE_LINE_FROM_BOTTOM;
      }
      if ("position" in cue) {
        cue.position = SUBTITLE_CUE_POSITION_PERCENT;
      }
      if ("size" in cue) {
        cue.size = SUBTITLE_CUE_SIZE_PERCENT;
      }
      if ("align" in cue) {
        cue.align = "center";
      }
    } catch {
      // Ignore cue positioning failures for unsupported cue types.
    }
  });
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

function isLikelyForcedSubtitleTrack(track) {
  const labelText = String(track?.label || "").toLowerCase();
  const titleText = String(track?.title || "").toLowerCase();
  const combined = `${labelText} ${titleText}`;
  return (
    combined.includes("forced") ||
    combined.includes("foreign") ||
    combined.includes("sign")
  );
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

function applySubtitleTrackByStreamIndex(streamIndex) {
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
  if (
    shouldUseNativeEmbeddedSubtitleTrack(selectedTrack) &&
    hasLoadedNativeSubtitleTrack(selectedTrack)
  ) {
    ensureNativeSubtitleTrackVisible();
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

function getLiveIframePlaybackClockSeconds(nowMs = performance.now()) {
  const baseSeconds = Math.max(0, Number(liveIframePlaybackBaseSeconds) || 0);
  const startedAtMs = Number(liveIframePlaybackStartedAtMs) || 0;
  if (startedAtMs <= 0) {
    return baseSeconds;
  }
  return baseSeconds + Math.max(0, (nowMs - startedAtMs) / 1000);
}

function startLiveIframeProgressClock(startSeconds = 0) {
  liveIframePlaybackBaseSeconds = normalizeResumeStartSeconds(startSeconds);
  liveIframePlaybackStartedAtMs = performance.now();
}

function pauseLiveIframeProgressClock() {
  if (liveIframePlaybackStartedAtMs <= 0) {
    return;
  }
  liveIframePlaybackBaseSeconds = getLiveIframePlaybackClockSeconds();
  liveIframePlaybackStartedAtMs = 0;
}

function resumeLiveIframeProgressClock() {
  if (!isLiveIframePlaybackActive() || liveIframePlaybackStartedAtMs > 0) {
    return;
  }
  liveIframePlaybackStartedAtMs = performance.now();
}

function resetLiveIframeProgressClock() {
  liveIframePlaybackBaseSeconds = 0;
  liveIframePlaybackStartedAtMs = 0;
}

function getEffectiveCurrentTime() {
  if (isLiveIframePlaybackActive()) {
    return getLiveIframePlaybackClockSeconds();
  }
  if (isTranscodeSourceActive()) {
    return transcodeBaseOffsetSeconds + (Number(video.currentTime) || 0);
  }
  return Number(video.currentTime) || 0;
}

function getLiveSeekableWindow() {
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

function getLiveEdgeTargetSeconds(liveWindow = getLiveSeekableWindow()) {
  if (!liveWindow) {
    return null;
  }
  return Math.max(
    liveWindow.start,
    liveWindow.end - LIVE_EDGE_PLAYBACK_OFFSET_SECONDS,
  );
}

function clampLiveSeekTargetSeconds(targetSeconds) {
  const target = Number(targetSeconds);
  if (!Number.isFinite(target)) {
    return 0;
  }

  const liveWindow = getLiveSeekableWindow();
  if (!liveWindow) {
    return Math.max(0, target);
  }

  return Math.max(liveWindow.start, Math.min(liveWindow.end, target));
}

function getSeekTargetSecondsFromRatio(ratio, fallbackDurationSeconds) {
  const clampedRatio = Math.max(0, Math.min(1, Number(ratio) || 0));
  if (isLivePlayback) {
    const liveWindow = getLiveSeekableWindow();
    if (liveWindow) {
      const liveEdgeTarget = getLiveEdgeTargetSeconds(liveWindow);
      if (
        clampedRatio >= LIVE_EDGE_PIN_RATIO &&
        Number.isFinite(liveEdgeTarget)
      ) {
        return liveEdgeTarget;
      }
      return liveWindow.start + clampedRatio * liveWindow.duration;
    }
  }

  const duration = Number(fallbackDurationSeconds);
  return clampedRatio * (Number.isFinite(duration) && duration > 0 ? duration : 0);
}

function updateLiveEdgePinFromTarget(targetSeconds) {
  if (!isLivePlayback) {
    liveEdgePinned = false;
    return;
  }

  const liveEdgeTarget = getLiveEdgeTargetSeconds();
  if (!Number.isFinite(liveEdgeTarget)) {
    liveEdgePinned = true;
    return;
  }

  liveEdgePinned =
    Number(targetSeconds) >= liveEdgeTarget - LIVE_EDGE_REJOIN_TOLERANCE_SECONDS;
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

function handleLiveIframePlaybackError() {
  if (!isTmdbResolvedPlayback || !isLiveIframePlaybackActive()) {
    return;
  }
  if (tmdbSourceAttemptIndex < tmdbSourceQueue.length) {
    void tryNextTmdbSource();
    return;
  }
  attemptTmdbRecovery("Embed unavailable. Trying another source...");
}

function clearLiveIframePlayback() {
  if (liveEmbedFrame) {
    liveEmbedFrame.hidden = true;
    liveEmbedFrame.removeAttribute("src");
  }
  resetLiveIframeProgressClock();
  playerShell?.classList.remove("live-iframe-active");
}

function hardenLiveEmbedFrame() {
  if (!liveEmbedFrame) {
    return;
  }
  liveEmbedFrame.setAttribute("allow", LIVE_IFRAME_ALLOW_POLICY);
  liveEmbedFrame.removeAttribute("sandbox");
  liveEmbedFrame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
}

function setLiveIframePlaybackSource(embedUrl, encodedSource, { startSeconds = null } = {}) {
  const hasExplicitStartSeconds =
    startSeconds !== null && startSeconds !== undefined;
  const nextStartSeconds = hasExplicitStartSeconds
    ? normalizeResumeStartSeconds(startSeconds)
    : getLiveIframePlaybackClockSeconds();
  lastRequestedPlaybackSource = encodedSource;
  lastRequestedAbsolutePlaybackSource = embedUrl;
  lastPlaybackSourceSetAt = performance.now();
  startLiveIframeProgressClock(nextStartSeconds);
  liveEdgePinned = true;
  resetAudioDecodeWatchState();
  clearStreamStallRecovery();
  clearSubtitleTrack();
  hlsPlaybackController.destroy();
  activeTranscodeInput = "";
  transcodeBaseOffsetSeconds = 0;
  activeAudioStreamIndex = -1;
  activeAudioSyncMs = 0;
  activeTrackSourceInput = "";
  knownDurationSeconds = 0;
  clearLiveVisualHealthWatch({ resetSamples: true });
  clearLiveStartupHealthWatch({ resetRequest: true });
  if (video.src) {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
  if (liveEmbedFrame) {
    hardenLiveEmbedFrame();
    liveEmbedFrame.src = embedUrl;
    liveEmbedFrame.hidden = false;
  }
  playerShell?.classList.add("live-iframe-active");
  syncDurationText();
  showControls();
  scheduleControlsHide();
}

function isLiveIframePlaybackActive() {
  return Boolean(
    parseLiveIframePlaybackSource(lastRequestedPlaybackSource) ||
      (liveEmbedFrame && !liveEmbedFrame.hidden && liveEmbedFrame.src),
  );
}

function setVideoSource(nextSource, { resetInitialResume = true, startSeconds = 0 } = {}) {
  if (!nextSource) {
    return;
  }
  const requestedStartSeconds = normalizeResumeStartSeconds(startSeconds);
  const iframeSource = parseLiveIframePlaybackSource(nextSource);
  if (iframeSource) {
    activeLiveHlsReferer = "";
    setLiveIframePlaybackSource(iframeSource, nextSource, {
      startSeconds: requestedStartSeconds,
    });
    return;
  }
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
    if (
      isTmdbResolvedPlayback &&
      transcodeMeta.sourceHash &&
      transcodeMeta.sourceHash !== selectedSourceHash
    ) {
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
      if (isCurrentTmdbExternalEmbedSource()) {
        // Let queued embed fallbacks run before escalating to torrent resolution.
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
      handleHlsPlaybackFailure,
    });
    startLiveVisualHealthWatch();
    armLiveStartupHealthWatch();
    return;
  }

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

function createManualSourceSwitchRestoreState({
  targetSourceHash = "",
  resumeSeconds = 0,
  wasPaused = true,
} = {}) {
  return {
    targetSourceHash: normalizeSourceHash(targetSourceHash),
    targetPlaybackSource: "",
    targetAbsolutePlaybackSource: "",
    restorePlaybackSource: getManualSourceSwitchRestoreSource(),
    restoreResumeSeconds: Math.max(0, Number(resumeSeconds) || 0),
    restoreWasPaused: Boolean(wasPaused),
    selectedSourceHash,
    sourceSelectionPinned,
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
    preferredSubtitleLang,
    tmdbSourceQueue: [...tmdbSourceQueue],
    tmdbSourceAttemptIndex,
  };
}

function clearManualSourceSwitchRestore() {
  if (pendingManualSourceSwitchTimeout) {
    window.clearTimeout(pendingManualSourceSwitchTimeout);
    pendingManualSourceSwitchTimeout = null;
  }
  pendingManualSourceSwitchRestore = null;
}

function armManualSourceSwitchRestoreTimeout(restoreState) {
  clearManualSourceSwitchRestore();
  pendingManualSourceSwitchRestore = restoreState;
  pendingManualSourceSwitchTimeout = window.setTimeout(() => {
    if (pendingManualSourceSwitchRestore === restoreState) {
      void restoreManualSourceSwitchPlayback("Source startup timed out.");
    }
  }, MANUAL_SOURCE_SWITCH_TIMEOUT_MS);
}

function isManualSourceSwitchPending() {
  return Boolean(
    activeManualSourceSwitchRequestToken || pendingManualSourceSwitchRestore,
  );
}

function isManualSourceSwitchRequestActive() {
  return Boolean(activeManualSourceSwitchRequestToken);
}

function finishManualSourceSwitchRequest(requestToken) {
  if (activeManualSourceSwitchRequestToken === requestToken) {
    activeManualSourceSwitchRequestToken = 0;
  }
}

function markManualSourceSwitchPlaybackRequested(sourceHash = "") {
  const restoreState = pendingManualSourceSwitchRestore;
  if (!restoreState) {
    return;
  }
  const normalizedSourceHash = normalizeSourceHash(sourceHash);
  if (
    normalizedSourceHash &&
    restoreState.targetSourceHash &&
    normalizedSourceHash !== restoreState.targetSourceHash
  ) {
    return;
  }
  restoreState.targetPlaybackSource = String(lastRequestedPlaybackSource || "").trim();
  restoreState.targetAbsolutePlaybackSource = String(
    lastRequestedAbsolutePlaybackSource || "",
  ).trim();
}

function completeManualSourceSwitchIfActive() {
  const restoreState = pendingManualSourceSwitchRestore;
  if (!restoreState) {
    return false;
  }
  if (!restoreState.targetPlaybackSource && !restoreState.targetAbsolutePlaybackSource) {
    return false;
  }
  const activeSource = String(
    lastRequestedAbsolutePlaybackSource ||
      video?.currentSrc ||
      video?.getAttribute?.("src") ||
      "",
  ).trim();
  if (
    restoreState.targetAbsolutePlaybackSource &&
    activeSource &&
    activeSource !== restoreState.targetAbsolutePlaybackSource
  ) {
    return false;
  }
  clearManualSourceSwitchRestore();
  return true;
}

async function restoreManualSourceSwitchPlayback(message = "") {
  const restoreState = pendingManualSourceSwitchRestore;
  if (!restoreState) {
    return false;
  }
  clearManualSourceSwitchRestore();

  if (restoreState.targetSourceHash) {
    resolverFailedSourceHashes.add(restoreState.targetSourceHash);
  }

  selectedSourceHash = restoreState.selectedSourceHash;
  sourceSelectionPinned = restoreState.sourceSelectionPinned;
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
  preferredSubtitleLang = restoreState.preferredSubtitleLang;
  tmdbSourceQueue = [...restoreState.tmdbSourceQueue];
  tmdbSourceAttemptIndex = restoreState.tmdbSourceAttemptIndex;

  applyPreferredSourceAudioSync(selectedSourceHash);
  persistSourceHashInUrl();
  rebuildTrackOptionButtons();
  syncAudioState();
  syncSourceSelectionState();
  renderSelectedSourceDetails();
  hideSeekLoadingIndicator();
  hideResolver();

  const restoreSource = String(restoreState.restorePlaybackSource || "").trim();
  if (restoreSource) {
    setVideoSource(restoreSource, {
      startSeconds: restoreState.restoreResumeSeconds,
      resetInitialResume: false,
    });
    applySubtitleTrackByStreamIndex(selectedSubtitleStreamIndex);
    if (restoreState.restoreWasPaused) {
      video.pause();
    } else {
      await tryPlay();
    }
    if (restoreState.restoreResumeSeconds > 1) {
      seekToAbsoluteTime(restoreState.restoreResumeSeconds);
    }
  }

  console.warn(
    "Source switch failed; restored previous stream.",
    String(message || "").trim(),
  );
  return true;
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
  { resolvedSourceHash = "", startSeconds = 0, playbackRequestToken = 0 } = {},
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
  persistSourceHashInUrl();
  if (resumeTime > 1) {
    persistContinueWatchingEntry(resumeTime);
    syncContinueWatchingEntryToServer(resumeTime);
  }

  if (resolvedTrackPreferenceAudio && resolvedTrackPreferenceAudio !== "auto") {
    preferredAudioLang = resolvedTrackPreferenceAudio;
    persistAudioLangPreference(preferredAudioLang);
  }
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
  if (
    !availablePlaybackSources.some(
      (option) => option.sourceHash === selectedSourceHash,
    ) &&
    selectedSourceHash
  ) {
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
    renderSourceOptionButtons();
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
  setTmdbSourceQueue(
    preferredBrowserSource,
    preferredBrowserSource &&
      preferredBrowserSource !== nativePreferredSource
      ? [
          ...(shouldSkipRemuxFallback ? [] : [nativePreferredSource]),
          ...(resolved?.fallbackUrls || []).filter(
            (url) =>
              !shouldSkipRemuxFallback ||
              !String(url || "").includes("/api/remux"),
          ),
        ]
      : resolved.fallbackUrls,
  );
  void queueGallerySaveIfRequested(resolved);
  const preferredSource =
    tmdbSourceQueue[0] || preferredBrowserSource || nativePreferredSource;
  const explicitStartSeconds = normalizeResumeStartSeconds(startSeconds);
  setVideoSource(preferredSource, {
    startSeconds: explicitStartSeconds || getInitialPlaybackStartSeconds(),
    resetInitialResume: explicitStartSeconds <= 0,
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

  await tryPlay();
  startLocalCacheUpgradeWatch(resolved);
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
    hasUpgradedToLocalCache = false;
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
  if (!availablePlaybackSources.length) {
    void fetchTmdbSourceOptionsViaBackend();
  }

  const normalizedRequiredSourceHash = normalizeSourceHash(requiredSourceHash);
  const normalizedRequestSourceHash = normalizeSourceHash(requestSourceHash);
  const resolved = isTmdbTvPlayback
    ? await resolveTmdbTvEpisodeViaBackend(
        tmdbId,
        seasonNumber,
        episodeNumber,
        {
          allowContainerFallback,
          allowSourceFallback,
          requestSourceHash: normalizedRequestSourceHash,
          resolveTimeoutMs,
          skipExternalEmbed,
          refreshResolve,
        },
      )
    : await resolveTmdbMovieViaBackend(tmdbId, {
        allowSourceFallback,
        requestSourceHash: normalizedRequestSourceHash,
        resolveTimeoutMs,
        skipExternalEmbed,
        refreshResolve,
      });
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

function attemptTmdbRecovery(message, { failureMessage = "" } = {}) {
  if (
    !isTmdbResolvedPlayback ||
    isRecoveringTmdbStream ||
    isManualSourceSwitchRequestActive()
  ) {
    return false;
  }

  const resumeAt = Math.max(0, Math.floor(getEffectiveCurrentTime()));
  stopLocalCacheUpgradeWatch();
  isRecoveringTmdbStream = true;
  showResolver(message || "Switching source...");
  demoteCurrentExternalEmbedSourceForRecovery(
    failureMessage || message || "External HLS playback failed.",
  );

  if (tmdbSourceAttemptIndex < tmdbSourceQueue.length) {
    void tryNextTmdbSource().finally(() => {
      isRecoveringTmdbStream = false;
    });
    return true;
  }

  if (
    shouldAllowTorrentResolveFallback() &&
    tmdbResolveRetries < maxTmdbResolveRetries
  ) {
    tmdbResolveRetries += 1;
    tmdbSkipExternalEmbed = true;
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
        resolveTmdbSourcesAndPlay({ startSeconds: resumeAt, refreshResolve: true }),
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
      localStorage.getItem(`netflix-resume:${episodeSourceIdentity}`),
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
  togglePlay.classList.toggle("paused", video.paused);
  togglePlay.setAttribute("aria-label", video.paused ? "Play" : "Pause");
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
    background: `linear-gradient(to right, #ff1408 0%, #ff1408 ${volumePercent}%, rgba(255, 255, 255, 0.08) ${volumePercent}%, rgba(255, 255, 255, 0.08) 100%)`,
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

function getLiveFailureCacheStorageKey() {
  const eventSlug = getLiveStreamCacheEventSlug();
  return eventSlug ? `${LIVE_FAILED_STREAM_CACHE_STORAGE_PREFIX}${eventSlug}` : "";
}

function getLiveWorkingCacheStorageKey() {
  const eventSlug = getLiveStreamCacheEventSlug();
  return eventSlug ? `${LIVE_WORKING_STREAM_CACHE_STORAGE_PREFIX}${eventSlug}` : "";
}

function getLiveStreamFailureEntry(streamOption, now = Date.now()) {
  const streamId = String(streamOption?.id || "").trim();
  if (!streamId) {
    return null;
  }
  const entry = liveFailedStreamStatuses.get(streamId) || null;
  if (!entry || Number(entry.expiresAt || 0) <= now) {
    return null;
  }
  const optionSource = normalizePlaybackSourceValue(streamOption?.source);
  if (entry.source && optionSource && entry.source !== optionSource) {
    return null;
  }
  return entry;
}

function isLiveStreamRecentlyFailed(streamOption, now = Date.now()) {
  return Boolean(getLiveStreamFailureEntry(streamOption, now));
}

function getLiveStreamOptionStatus(streamOption) {
  const entry = getLiveStreamFailureEntry(streamOption);
  if (!entry) {
    return null;
  }
  return {
    state: "skipped",
    label: "Skipped",
    detail: "Recently failed. Select it manually to retry.",
  };
}

function pruneLiveFailureCache(now = Date.now()) {
  let changed = false;
  const validSourcesById = new Map(
    liveStreamOptions.map((option) => [
      option.id,
      normalizePlaybackSourceValue(option.source),
    ]),
  );
  liveFailedStreamStatuses.forEach((entry, streamId) => {
    const validSource = validSourcesById.get(streamId);
    if (
      !entry ||
      Number(entry.expiresAt || 0) <= now ||
      (validSource && entry.source && entry.source !== validSource)
    ) {
      liveFailedStreamStatuses.delete(streamId);
      changed = true;
    }
  });
  return changed;
}

function persistLiveFailureCache() {
  const cacheKey = liveFailedStreamCacheKey || getLiveFailureCacheStorageKey();
  if (!cacheKey) {
    return;
  }
  try {
    pruneLiveFailureCache();
    const entries = Array.from(liveFailedStreamStatuses.entries()).map(
      ([streamId, entry]) => ({
        streamId,
        source: entry.source,
        expiresAt: entry.expiresAt,
        reason: entry.reason || "",
      }),
    );
    if (!entries.length) {
      localStorage.removeItem(cacheKey);
      return;
    }
    localStorage.setItem(cacheKey, JSON.stringify(entries));
  } catch {
    // Skipped-source caching is a convenience only.
  }
}

function loadLiveFailureCacheForCurrentEvent() {
  const cacheKey = getLiveFailureCacheStorageKey();
  if (!cacheKey || cacheKey === liveFailedStreamCacheKey) {
    pruneLiveFailureCache();
    return;
  }

  liveFailedStreamCacheKey = cacheKey;
  liveFailedStreamStatuses = new Map();

  try {
    const parsed = JSON.parse(localStorage.getItem(cacheKey) || "[]");
    const entries = Array.isArray(parsed) ? parsed : [];
    const now = Date.now();
    entries.forEach((entry) => {
      const streamId = String(entry?.streamId || "").trim();
      const expiresAt = Number(entry?.expiresAt || 0);
      if (!streamId || expiresAt <= now) {
        return;
      }
      liveFailedStreamStatuses.set(streamId, {
        source: normalizePlaybackSourceValue(entry?.source),
        expiresAt,
        reason: String(entry?.reason || "").trim(),
      });
    });
    if (pruneLiveFailureCache(now)) {
      persistLiveFailureCache();
    }
  } catch {
    liveFailedStreamStatuses = new Map();
  }
}

function rememberLiveStreamFailure(streamOption, reason = "") {
  const streamId = String(streamOption?.id || "").trim();
  const source = normalizePlaybackSourceValue(streamOption?.source);
  if (!streamId || !source) {
    return;
  }
  if (!liveFailedStreamCacheKey) {
    loadLiveFailureCacheForCurrentEvent();
  }
  clearLiveStreamSuccess(streamOption);
  recordLiveSourcePreference(streamOption, -2);
  liveFailedStreamStatuses.set(streamId, {
    source,
    expiresAt: Date.now() + LIVE_FAILED_STREAM_CACHE_TTL_MS,
    reason: String(reason || "").trim(),
  });
  persistLiveFailureCache();
  renderLiveStreamOptions();
}

function clearLiveStreamFailure(streamOption) {
  const streamId = String(streamOption?.id || "").trim();
  if (!streamId) {
    return;
  }
  if (liveFailedStreamStatuses.delete(streamId)) {
    persistLiveFailureCache();
    renderLiveStreamOptions();
  }
}

function normalizeLiveStreamPreferenceProvider(streamOption = {}) {
  const explicitProvider = String(streamOption?.provider || "")
    .trim()
    .toLowerCase();
  if (explicitProvider) {
    return explicitProvider;
  }
  try {
    const host = new URL(
      normalizePlaybackSourceValue(streamOption?.source),
      window.location.origin,
    ).hostname.toLowerCase();
    if (host.includes("streamed.pk")) {
      return "streamed";
    }
    if (
      host === "ntvs.cx" ||
      host === "www.ntvs.cx" ||
      host === "ntv.cx" ||
      host === "www.ntv.cx" ||
      host === "embed.st" ||
      host === "www.embed.st"
    ) {
      return "ntvs";
    }
    if (
      host.includes("matchstream") ||
      host.endsWith(".st") ||
      host.endsWith(".to") ||
      host.endsWith(".link")
    ) {
      return "matchstream";
    }
  } catch {
    // Provider inference is best effort.
  }
  return "live";
}

function getLiveStreamSourceHost(streamOption = {}) {
  try {
    return new URL(
      normalizePlaybackSourceValue(streamOption?.source),
      window.location.origin,
    ).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function getLiveStreamLabelSlot(streamOption = {}) {
  const label = String(streamOption?.label || "").trim();
  const match = /#\s*(\d+)\s*$/i.exec(label);
  return match ? match[1] : "";
}

function getLiveSourcePreferenceKeys(streamOption = {}) {
  const source = normalizePlaybackSourceValue(streamOption?.source);
  const provider = normalizeLiveStreamPreferenceProvider(streamOption);
  const host = getLiveStreamSourceHost(streamOption);
  const slot = getLiveStreamLabelSlot(streamOption);
  const keys = [];
  if (source) {
    keys.push(`source:${source}`);
  }
  if (provider && host) {
    keys.push(`host:${provider}:${host}`);
  }
  if (provider && slot) {
    keys.push(`slot:${provider}:${slot}`);
  }
  return keys;
}

function loadLiveSourcePreferenceEntries() {
  if (liveSourcePreferenceEntries instanceof Map) {
    return liveSourcePreferenceEntries;
  }

  liveSourcePreferenceEntries = new Map();
  try {
    const parsed = JSON.parse(
      localStorage.getItem(LIVE_SOURCE_PREFERENCE_STORAGE_KEY) || "[]",
    );
    const entries = Array.isArray(parsed) ? parsed : [];
    const now = Date.now();
    entries.forEach((entry) => {
      const key = String(entry?.key || "").trim();
      const expiresAt = Number(entry?.expiresAt || 0);
      if (!key || expiresAt <= now) {
        return;
      }
      liveSourcePreferenceEntries.set(key, {
        score: Number(entry?.score || 0),
        expiresAt,
        lastSuccessAt: Number(entry?.lastSuccessAt || 0),
        lastFailureAt: Number(entry?.lastFailureAt || 0),
      });
    });
  } catch {
    liveSourcePreferenceEntries = new Map();
  }
  return liveSourcePreferenceEntries;
}

function persistLiveSourcePreferenceEntries() {
  const entries = loadLiveSourcePreferenceEntries();
  const now = Date.now();
  try {
    const payload = Array.from(entries.entries())
      .filter(([, entry]) => Number(entry?.expiresAt || 0) > now)
      .map(([key, entry]) => ({
        key,
        score: Math.max(-12, Math.min(12, Number(entry?.score || 0))),
        expiresAt: Number(entry?.expiresAt || 0),
        lastSuccessAt: Number(entry?.lastSuccessAt || 0),
        lastFailureAt: Number(entry?.lastFailureAt || 0),
      }));
    if (!payload.length) {
      localStorage.removeItem(LIVE_SOURCE_PREFERENCE_STORAGE_KEY);
      return;
    }
    localStorage.setItem(
      LIVE_SOURCE_PREFERENCE_STORAGE_KEY,
      JSON.stringify(payload),
    );
  } catch {
    // Live-source preference storage is best effort.
  }
}

function recordLiveSourcePreference(streamOption, delta) {
  if (!streamOption?.source) {
    return;
  }

  const keys = getLiveSourcePreferenceKeys(streamOption);
  if (!keys.length) {
    return;
  }

  const entries = loadLiveSourcePreferenceEntries();
  const now = Date.now();
  const scoreDelta = Number(delta || 0);
  keys.forEach((key) => {
    const existing = entries.get(key) || {};
    const nextScore = Math.max(
      -12,
      Math.min(12, Number(existing.score || 0) + scoreDelta),
    );
    entries.set(key, {
      score: nextScore,
      expiresAt: now + LIVE_SOURCE_PREFERENCE_TTL_MS,
      lastSuccessAt:
        scoreDelta > 0 ? now : Number(existing.lastSuccessAt || 0),
      lastFailureAt:
        scoreDelta < 0 ? now : Number(existing.lastFailureAt || 0),
    });
  });
  persistLiveSourcePreferenceEntries();
}

function getLiveSourcePreferenceScore(streamOption) {
  const entries = loadLiveSourcePreferenceEntries();
  const now = Date.now();
  return getLiveSourcePreferenceKeys(streamOption).reduce((score, key) => {
    const entry = entries.get(key);
    if (!entry || Number(entry.expiresAt || 0) <= now) {
      return score;
    }
    return score + Number(entry.score || 0);
  }, 0);
}

function getPreferredRankedLiveStreamOption() {
  if (!isLivePlayback || liveStreamOptions.length <= 1) {
    return null;
  }

  return liveStreamOptions
    .map((option, index) => ({
      option,
      index,
      score: getLiveSourcePreferenceScore(option),
    }))
    .filter(
      (entry) =>
        entry.option?.source &&
        entry.score > 0 &&
        !isLiveStreamRecentlyFailed(entry.option),
    )
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.index - right.index;
    })[0]?.option || null;
}

function liveStreamEntryMatchesOption(entry, streamOption) {
  const entryStreamId = String(entry?.streamId || "").trim();
  const streamId = String(streamOption?.id || "").trim();
  if (!entryStreamId || !streamId || entryStreamId !== streamId) {
    return false;
  }
  const entrySource = normalizePlaybackSourceValue(entry?.source);
  const optionSource = normalizePlaybackSourceValue(streamOption?.source);
  return !entrySource || !optionSource || entrySource === optionSource;
}

function getRememberedWorkingLiveStreamOption(now = Date.now()) {
  const entry = liveWorkingStreamEntry || null;
  if (!entry || Number(entry.expiresAt || 0) <= now) {
    return null;
  }

  const entrySource = normalizePlaybackSourceValue(entry.source);
  return (
    liveStreamOptions.find((option) => liveStreamEntryMatchesOption(entry, option)) ||
    liveStreamOptions.find(
      (option) =>
        entrySource && normalizePlaybackSourceValue(option?.source) === entrySource,
    ) ||
    null
  );
}

function pruneLiveWorkingCache(now = Date.now()) {
  if (!liveWorkingStreamEntry) {
    return false;
  }
  const rememberedOption = getRememberedWorkingLiveStreamOption(now);
  if (
    !rememberedOption ||
    Number(liveWorkingStreamEntry.expiresAt || 0) <= now ||
    isLiveStreamRecentlyFailed(rememberedOption, now)
  ) {
    liveWorkingStreamEntry = null;
    return true;
  }
  return false;
}

function persistLiveWorkingCache() {
  const cacheKey = liveWorkingStreamCacheKey || getLiveWorkingCacheStorageKey();
  if (!cacheKey) {
    return;
  }
  try {
    pruneLiveWorkingCache();
    if (!liveWorkingStreamEntry) {
      localStorage.removeItem(cacheKey);
      return;
    }
    localStorage.setItem(cacheKey, JSON.stringify(liveWorkingStreamEntry));
  } catch {
    // Working-stream caching is a convenience only.
  }
}

function loadLiveWorkingCacheForCurrentEvent() {
  const cacheKey = getLiveWorkingCacheStorageKey();
  if (!cacheKey || cacheKey === liveWorkingStreamCacheKey) {
    if (pruneLiveWorkingCache()) {
      persistLiveWorkingCache();
    }
    return;
  }

  liveWorkingStreamCacheKey = cacheKey;
  liveWorkingStreamEntry = null;

  try {
    const parsed = JSON.parse(localStorage.getItem(cacheKey) || "null");
    const streamId = String(parsed?.streamId || "").trim();
    const source = normalizePlaybackSourceValue(parsed?.source);
    const expiresAt = Number(parsed?.expiresAt || 0);
    if (streamId && source && expiresAt > Date.now()) {
      liveWorkingStreamEntry = {
        streamId,
        source,
        expiresAt,
        confirmedAt: Number(parsed?.confirmedAt || 0),
        reason: String(parsed?.reason || "").trim(),
      };
    }
    if (pruneLiveWorkingCache()) {
      persistLiveWorkingCache();
    }
  } catch {
    liveWorkingStreamEntry = null;
  }
}

function clearLiveStreamSuccess(streamOption) {
  if (
    !liveWorkingStreamEntry ||
    !liveStreamEntryMatchesOption(liveWorkingStreamEntry, streamOption)
  ) {
    return;
  }
  liveWorkingStreamEntry = null;
  persistLiveWorkingCache();
}

function rememberLiveStreamSuccess(
  streamOption = getSelectedLiveStreamOption(),
  reason = "",
) {
  if (!isLivePlayback || liveStreamOptions.length <= 1) {
    return;
  }
  const streamId = String(streamOption?.id || "").trim();
  const source = normalizePlaybackSourceValue(streamOption?.source);
  if (!streamId || !source) {
    return;
  }
  recordLiveSourcePreference(streamOption, 3);
  if (!liveWorkingStreamCacheKey) {
    loadLiveWorkingCacheForCurrentEvent();
  }

  const now = Date.now();
  const existing = liveWorkingStreamEntry || null;
  const sameEntry =
    existing &&
    String(existing.streamId || "").trim() === streamId &&
    normalizePlaybackSourceValue(existing.source) === source;
  const failureRemoved =
    Boolean(getLiveStreamFailureEntry(streamOption, now)) &&
    liveFailedStreamStatuses.delete(streamId);
  if (failureRemoved) {
    persistLiveFailureCache();
  }

  if (
    sameEntry &&
    Number(existing.expiresAt || 0) >
      now + LIVE_WORKING_STREAM_CACHE_TTL_MS / 2
  ) {
    if (failureRemoved) {
      renderLiveStreamOptions();
    }
    return;
  }

  liveWorkingStreamEntry = {
    streamId,
    source,
    expiresAt: now + LIVE_WORKING_STREAM_CACHE_TTL_MS,
    confirmedAt: now,
    reason: String(reason || "").trim(),
  };
  persistLiveWorkingCache();
  if (failureRemoved) {
    renderLiveStreamOptions();
  }
}

function prepareLiveFailureCacheForCurrentEvent() {
  if (!isLivePlayback) {
    liveFailedStreamCacheKey = "";
    liveFailedStreamStatuses = new Map();
    liveWorkingStreamCacheKey = "";
    liveWorkingStreamEntry = null;
    return;
  }
  loadLiveFailureCacheForCurrentEvent();
  pruneLiveFailureCache();
  loadLiveWorkingCacheForCurrentEvent();
  pruneLiveWorkingCache();
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

function parseLiveIframePlaybackSource(source) {
  const value = String(source || "").trim();
  if (!value.startsWith(LIVE_IFRAME_SOURCE_PREFIX)) {
    return "";
  }
  try {
    const payload = decodeURIComponent(value.slice(LIVE_IFRAME_SOURCE_PREFIX.length));
    if (/^https?:\/\//i.test(payload)) {
      return payload;
    }
    if (payload.startsWith("/")) {
      return payload;
    }
    return "";
  } catch {
    return "";
  }
}

async function resolveLivePlaybackSource(source) {
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

function clearLiveVisualHealthWatch({ resetSamples = false } = {}) {
  if (liveVisualHealthInterval !== null) {
    window.clearInterval(liveVisualHealthInterval);
    liveVisualHealthInterval = null;
  }
  if (resetSamples) {
    liveVisualBlankSampleCount = 0;
  }
}

function clearLiveStartupHealthWatch({ resetRequest = false } = {}) {
  if (liveStartupHealthTimeout !== null) {
    window.clearTimeout(liveStartupHealthTimeout);
    liveStartupHealthTimeout = null;
  }
  if (resetRequest) {
    liveStartupWatchArmed = false;
  }
}

function shouldWatchLiveStartupHealth() {
  return Boolean(
    isLivePlayback &&
      !liveAutoFallbackInFlight &&
      liveStreamOptions.length > 1 &&
      !isLiveIframePlaybackActive() &&
      hasRecoverablePlaybackSource(),
  );
}

function hasLivePlaybackStarted() {
  return Boolean(
    video.readyState >= 2 ||
      video.videoWidth > 0 ||
      video.videoHeight > 0 ||
      getEffectiveCurrentTime() > 0.25,
  );
}

function checkLiveStartupHealth(expectedSource, expectedStreamId) {
  liveStartupHealthTimeout = null;

  if (
    !liveStartupWatchArmed ||
    !shouldWatchLiveStartupHealth() ||
    document.visibilityState === "hidden"
  ) {
    return;
  }

  const currentSource =
    lastRequestedAbsolutePlaybackSource ||
    lastRequestedPlaybackSource ||
    video.currentSrc ||
    video.getAttribute("src") ||
    "";
  if (expectedSource && currentSource && currentSource !== expectedSource) {
    return;
  }
  if (
    expectedStreamId &&
    selectedLiveStreamId &&
    selectedLiveStreamId !== expectedStreamId
  ) {
    return;
  }

  if (hasLivePlaybackStarted()) {
    clearLiveStartupHealthWatch({ resetRequest: true });
    return;
  }

  const elapsedSinceSourceSet = performance.now() - lastPlaybackSourceSetAt;
  if (elapsedSinceSourceSet < LIVE_STARTUP_HEALTH_TIMEOUT_MS) {
    scheduleLiveStartupHealthWatch();
    return;
  }

  void attemptAutomaticLiveStreamFallback(
    "Live stream did not start. Trying another source...",
  );
}

function scheduleLiveStartupHealthWatch() {
  if (!liveStartupWatchArmed || !shouldWatchLiveStartupHealth()) {
    return;
  }

  clearLiveStartupHealthWatch();
  const elapsedSinceSourceSet = performance.now() - lastPlaybackSourceSetAt;
  const delayMs = Math.max(
    0,
    LIVE_STARTUP_HEALTH_TIMEOUT_MS - elapsedSinceSourceSet,
  );
  const expectedSource =
    lastRequestedAbsolutePlaybackSource ||
    lastRequestedPlaybackSource ||
    video.currentSrc ||
    video.getAttribute("src") ||
    "";
  const expectedStreamId = selectedLiveStreamId;
  liveStartupHealthTimeout = window.setTimeout(
    () => checkLiveStartupHealth(expectedSource, expectedStreamId),
    delayMs,
  );
}

function armLiveStartupHealthWatch() {
  if (!shouldWatchLiveStartupHealth()) {
    return;
  }
  liveStartupWatchArmed = true;
  scheduleLiveStartupHealthWatch();
}

function isPlaybackBlockedByPolicy(error) {
  return String(error?.name || "").toLowerCase() === "notallowederror";
}

function resetLiveAutoFallbackAttempts() {
  liveAutoFallbackAttemptedStreamIds = new Set();
}

function getLiveVisualHealthCanvasContext() {
  if (!liveVisualHealthCanvas) {
    liveVisualHealthCanvas = document.createElement("canvas");
    liveVisualHealthCanvas.width = LIVE_VISUAL_HEALTH_SAMPLE_WIDTH;
    liveVisualHealthCanvas.height = LIVE_VISUAL_HEALTH_SAMPLE_HEIGHT;
  }
  return liveVisualHealthCanvas.getContext("2d", {
    willReadFrequently: true,
  });
}

function sampleLiveVideoBlankness() {
  if (
    !video ||
    video.videoWidth <= 0 ||
    video.videoHeight <= 0 ||
    isLiveIframePlaybackActive()
  ) {
    return null;
  }

  const context = getLiveVisualHealthCanvasContext();
  if (!context) {
    return null;
  }

  try {
    context.drawImage(
      video,
      0,
      0,
      LIVE_VISUAL_HEALTH_SAMPLE_WIDTH,
      LIVE_VISUAL_HEALTH_SAMPLE_HEIGHT,
    );
    const { data } = context.getImageData(
      0,
      0,
      LIVE_VISUAL_HEALTH_SAMPLE_WIDTH,
      LIVE_VISUAL_HEALTH_SAMPLE_HEIGHT,
    );
    const pixels = data.length / 4;
    if (pixels <= 0) {
      return null;
    }

    let totalLuma = 0;
    let brightPixels = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      const luma =
        data[offset] * 0.2126 +
        data[offset + 1] * 0.7152 +
        data[offset + 2] * 0.0722;
      totalLuma += luma;
      if (luma > LIVE_VISUAL_HEALTH_MAX_AVG_LUMA * 2) {
        brightPixels += 1;
      }
    }

    const avgLuma = totalLuma / pixels;
    const brightPixelRatio = brightPixels / pixels;
    return {
      avgLuma,
      brightPixelRatio,
      isBlank:
        avgLuma <= LIVE_VISUAL_HEALTH_MAX_AVG_LUMA &&
        brightPixelRatio <= LIVE_VISUAL_HEALTH_MIN_BRIGHT_PIXEL_RATIO,
    };
  } catch {
    return null;
  }
}

function getOrderedLiveFallbackOptions({ includeCachedFailures = false } = {}) {
  if (liveStreamOptions.length <= 1) {
    return [];
  }

  const selectedIndex = liveStreamOptions.findIndex(
    (option) => option.id === selectedLiveStreamId,
  );
  const startIndex = selectedIndex >= 0 ? selectedIndex + 1 : 0;
  return [
    ...liveStreamOptions.slice(startIndex),
    ...liveStreamOptions.slice(0, Math.max(0, startIndex)),
  ].filter(
    (option) =>
      option?.source &&
      option.id !== selectedLiveStreamId &&
      !liveAutoFallbackAttemptedStreamIds.has(option.id) &&
      (includeCachedFailures || !isLiveStreamRecentlyFailed(option)),
  );
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
  try {
    let nextStream = getOrderedLiveFallbackOptions()[0] || null;
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
        nextStream = getOrderedLiveFallbackOptions()[0] || null;
      }
    }
  } finally {
    liveAutoFallbackInFlight = false;
    if (recovered) {
      startLiveVisualHealthWatch();
      armLiveStartupHealthWatch();
    }
  }

  showResolverError(
    "No alternate live streams worked for this event.",
    "No alternate live streams worked for this event.",
    { showRetry: true },
  );
  return false;
}

function checkLiveVisualHealth() {
  if (
    !isLivePlayback ||
    liveAutoFallbackInFlight ||
    liveStreamOptions.length <= 1 ||
    document.visibilityState === "hidden" ||
    isLiveIframePlaybackActive() ||
    video.paused ||
    !hasActiveSource() ||
    performance.now() - lastPlaybackSourceSetAt < LIVE_VISUAL_HEALTH_GRACE_MS
  ) {
    liveVisualBlankSampleCount = 0;
    return;
  }

  const sample = sampleLiveVideoBlankness();
  if (!sample) {
    return;
  }

  if (!sample.isBlank) {
    liveVisualBlankSampleCount = 0;
    return;
  }

  liveVisualBlankSampleCount += 1;
  if (liveVisualBlankSampleCount < LIVE_VISUAL_HEALTH_MAX_BLANK_SAMPLES) {
    return;
  }

  liveVisualBlankSampleCount = 0;
  void attemptAutomaticLiveStreamFallback();
}

function startLiveVisualHealthWatch() {
  if (
    !isLivePlayback ||
    isLiveIframePlaybackActive() ||
    liveStreamOptions.length <= 1
  ) {
    return;
  }
  if (liveVisualHealthInterval !== null) {
    return;
  }
  liveVisualHealthInterval = window.setInterval(
    checkLiveVisualHealth,
    LIVE_VISUAL_HEALTH_INTERVAL_MS,
  );
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
  if (!availablePlaybackSources.length && !isFetchingPlaybackSources) {
    void fetchTmdbSourceOptionsViaBackend();
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

  window.clearTimeout(sourcePopoverCloseTimeout);

  const close = () => {
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
  const playedPercent = (clamped / max) * 100;
  const bufferedPercent = (bufferedClamped / max) * 100;
  setRuntimeStyleRule(".seek-bar", {
    background: `linear-gradient(to right, var(--ui-accent) 0%, var(--ui-accent) ${playedPercent}%, var(--ui-buffered) ${playedPercent}%, var(--ui-buffered) ${bufferedPercent}%, var(--ui-line) ${bufferedPercent}%, var(--ui-line) 100%)`,
  });
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
    current >= liveEdgeTarget - LIVE_EDGE_REJOIN_TOLERANCE_SECONDS
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
      fetch("/api/user/watch-progress", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceIdentity }),
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
    fetch("/api/user/watch-progress", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceIdentity, resumeSeconds: nextResumeTime }),
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
  }
}

async function togglePlayback() {
  if (!hasRecoverablePlaybackSource() || isResolvingSource()) {
    return;
  }

  if (video.paused) {
    await tryPlay();
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
  if (pendingManualSourceSwitchRestore) {
    void restoreManualSourceSwitchPlayback(
      message || "Selected source could not start.",
    );
    return true;
  }

  if (isManualSourceSwitchRequestActive()) {
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

async function attemptAutomaticAlternateTmdbSource(message) {
  if (!isTmdbResolvedPlayback || automaticTmdbAlternateRecoveryInFlight) {
    return false;
  }

  automaticTmdbAlternateRecoveryInFlight = true;
  try {
    const failedSourceHash = normalizeSourceHash(selectedSourceHash);
    if (failedSourceHash) {
      resolverFailedSourceHashes.add(failedSourceHash);
      await reportCurrentTmdbPlaybackFailure(
        message || "Playback failed.",
        "playback_error",
      );
    }

    if (!availablePlaybackSources.length) {
      showResolver("Loading alternate sources...", { showStatus: true });
      await fetchTmdbSourceOptionsViaBackend();
    }

    const maxAlternateAttempts = Math.min(
      6,
      Math.max(1, availablePlaybackSources.length),
    );
    for (let attempt = 0; attempt < maxAlternateAttempts; attempt += 1) {
      const nextSourceHash = pickResolverAlternateSourceHash({
        allowPreviouslyFailedFallback: false,
      });
      if (!nextSourceHash) {
        break;
      }

      if (attempt === 0) {
        showResolver("Trying another source...");
      }

      try {
        await resolveTmdbFromResolverAction({
          sourceHash: nextSourceHash,
          isAlternate: true,
          suppressErrorUi: true,
        });
        return true;
      } catch {
        // Keep trying the next ranked alternate source.
      }
    }

    return false;
  } finally {
    automaticTmdbAlternateRecoveryInFlight = false;
  }
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
  if (pendingManualSourceSwitchRestore) {
    return restoreManualSourceSwitchPlayback(fallbackMessage);
  }
  if (isManualSourceSwitchRequestActive()) {
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

  if (await attemptAutomaticAlternateTmdbSource(fallbackMessage)) {
    return true;
  }

  showResolverError(fallbackMessage);
  return false;
}

function isTransientResolveError(error) {
  const status = Number(error?.status || 0);
  if (status === 502 || status === 503 || status === 504) {
    return true;
  }

  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("bad gateway") ||
    message.includes("request timed out") ||
    message.includes("real-debrid request timed out") ||
    message.includes("torrentio request failed") ||
    message.includes("selected external hls source is unavailable") ||
    message.includes("external hls sources are unavailable") ||
    message.includes("failed to fetch")
  );
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

async function requestResolveJson(
  url,
  timeoutMs = preferredResolverProvider === "real-debrid" ? 95000 : 50000,
) {
  const retryDelays =
    preferredResolverProvider === "real-debrid" ? [900, 1800] : [];
  let lastError = null;

  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      return await requestJson(url, {}, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt >= retryDelays.length || !isTransientResolveError(error)) {
        throw error;
      }
      await sleep(retryDelays[attempt]);
    }
  }

  throw lastError || new Error("Unable to resolve this stream.");
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

async function resolveExplicitSourceTrackSelection(sourceInput) {
  activeTrackSourceInput = String(sourceInput || "").trim();
  if (!activeTrackSourceInput) {
    expectedDurationSeconds = 0;
    availableAudioTracks = [];
    availableSubtitleTracks = [];
    selectedAudioStreamIndex = -1;
    selectedSubtitleStreamIndex = -1;
    rebuildTrackOptionButtons();
    return;
  }

  const query = new URLSearchParams({ input: activeTrackSourceInput });
  if (title) {
    query.set("title", title);
  }
  if (year) {
    query.set("year", year);
  }
  if (
    supportedAudioLangs.has(preferredAudioLang) &&
    preferredAudioLang !== "auto"
  ) {
    query.set("audioLang", preferredAudioLang);
  }
  if (preferredSubtitleLang && preferredSubtitleLang !== "off") {
    query.set("subtitleLang", preferredSubtitleLang);
  }

  try {
    const payload = await requestJson(`/api/media/tracks?${query.toString()}`);
    const nextExpectedDurationSeconds = Number(payload?.tracks?.durationSeconds);
    expectedDurationSeconds =
      Number.isFinite(nextExpectedDurationSeconds) &&
      nextExpectedDurationSeconds > 0
        ? Math.floor(nextExpectedDurationSeconds)
        : 0;
    availableAudioTracks = Array.isArray(payload?.tracks?.audioTracks)
      ? payload.tracks.audioTracks
      : [];
    availableSubtitleTracks = Array.isArray(payload?.tracks?.subtitleTracks)
      ? payload.tracks.subtitleTracks
      : [];

    const nextAudioStreamIndex = Number(payload?.selectedAudioStreamIndex);
    selectedAudioStreamIndex =
      Number.isFinite(nextAudioStreamIndex) && nextAudioStreamIndex >= 0
        ? Math.floor(nextAudioStreamIndex)
        : -1;

    const nextSubtitleStreamIndex = Number(
      payload?.selectedSubtitleStreamIndex,
    );
    selectedSubtitleStreamIndex =
      Number.isFinite(nextSubtitleStreamIndex) && nextSubtitleStreamIndex >= 0
        ? Math.floor(nextSubtitleStreamIndex)
        : -1;
  } catch {
    // Track probing is best effort for explicit sources.
    expectedDurationSeconds = 0;
    availableAudioTracks = [];
    availableSubtitleTracks = [];
    selectedAudioStreamIndex = -1;
    selectedSubtitleStreamIndex = -1;
  }

  rebuildTrackOptionButtons();
  syncAudioState();
  syncDurationText();
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

async function fetchTmdbSourceOptionsViaBackend() {
  if (!isTmdbResolvedPlayback || !tmdbId) {
    availablePlaybackSources = [];
    isFetchingPlaybackSources = false;
    renderSourceOptionsWhenStable();
    return;
  }
  await loadUserRealDebridPlaybackSettings();
  clearDisabledTorrentPlaybackState();
  const query = new URLSearchParams({
    tmdbId,
    mediaType: isTmdbTvPlayback ? "tv" : "movie",
    title,
    year,
    audioLang: preferredAudioLang,
    quality: preferredQuality,
    resolverProvider: preferredResolverProvider,
    limit: String(
      Math.max(preferredSourceResultsLimit, SOURCE_FETCH_BATCH_LIMIT),
    ),
  });
  if (isTmdbTvPlayback) {
    query.set("seasonNumber", String(seasonNumber));
    query.set("episodeNumber", String(episodeNumber));
    if (preferredContainer) {
      query.set("preferredContainer", preferredContainer);
    }
  }
  const pinnedSourceHash = getPinnedSourceHashForRequests();
  if (pinnedSourceHash) {
    query.set("sourceHash", pinnedSourceHash);
  }
  if (!pinnedSourceHash) {
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
      } else {
        selectedSourceHash = "";
        sourceSelectionPinned = false;
        applyPreferredSourceAudioSync(selectedSourceHash);
        persistSourceHashInUrl();
      }
    }
    availablePlaybackSources = sortSourcesBySeeders(nextPlaybackSources, {
      preferContainer: getSourceListPreferredContainer(),
    });
    isFetchingPlaybackSources = false;
    renderSourceOptionsWhenStable();
  } catch {
    if (requestToken !== playbackSourcesRequestToken) {
      return;
    }
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

function replaceReproducibleWatchUrl() {
  try {
    const nextParams = buildReproduciblePlaybackParams();
    for (const key of Array.from(params.keys())) {
      params.delete(key);
    }
    for (const [key, value] of nextParams.entries()) {
      params.set(key, value);
    }
    window.history.replaceState(null, "", buildWatchUrl(nextParams));
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

async function initPlaybackSource() {
  // Ensure local series library is loaded before resolving playback
  await _seriesLibraryReady;

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
          if (!params.has("title")) params.set("title", _liveMatch.title);
          if (!params.has("src")) params.set("src", _liveMatch.source);
          if (!params.has("thumb") && _liveMatch.thumb) params.set("thumb", _liveMatch.thumb);
          if (!params.has("episode")) params.set("episode", "Live");
          params.set("live", "1");
          if (!params.has("liveStreamId")) {
            params.set("liveStreamId", _liveMatch.defaultStreamId || "default");
          }
          if (!params.has("liveStreams")) {
            params.set("liveStreams", JSON.stringify(_liveMatch.streams || []));
          }
          if (_liveMatch.liveEmbed && !params.has("liveEmbed")) {
            params.set("liveEmbed", "1");
          }
          if (_liveMatch.liveResolver && !params.has("liveResolver")) {
            params.set("liveResolver", _liveMatch.liveResolver);
          }
          rawSourceParam = String(params.get("src") || "").trim();
          normalizedRawSourceParam = normalizePlaybackSourceValue(rawSourceParam);
          refreshLiveStreamStateFromParams(params);
          src = normalizedRawSourceParam;
          hasExplicitSource = Boolean(src);
          isExplicitLocalUploadSource = computeIsExplicitLocalUploadSource();
          title = params.get("title") || title;
          episode = params.get("episode") || episode;
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
  resumeStorageKey = `netflix-resume:${sourceIdentity}`;
  if (isTmdbResolvedPlayback) {
    await loadUserRealDebridPlaybackSettings();
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
  if (isTmdbResolvedPlayback) {
    try {
      const res = await fetch("/api/user/continue-watching");
      if (res.ok) {
        const data = await res.json();
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
      }
    } catch {}
  }

  // If localStorage still has no resume, try the lighter progress endpoint.
  if (!(resumeTime > 1)) {
    try {
      const res = await fetch("/api/user/watch-progress");
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
        const playbackSource = await resolveLivePlaybackSource(src);
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
      pauseLiveIframeProgressClock();
      return;
    }
    resumeLiveIframeProgressClock();
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
    setEpisodeLabel(_needsSlugResolve ? "" : title, _needsSlugResolve ? "" : episode);

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
      window.__NETFLIX_PLAYBACK_BENCHMARK__ = playbackBenchmark;
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
      fetch("/api/user/preferences", {
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
  const wasPaused = video.paused;
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

async function handleSourceOptionSelection(nextSourceHash) {
  const normalizedNextSourceHash = normalizeSourceHash(nextSourceHash);

  if (!normalizedNextSourceHash) {
    syncSourceSelectionState();
    renderSelectedSourceDetails();
    closeSourcePopover(false, { force: true });
    return;
  }

  if (normalizedNextSourceHash === selectedSourceHash) {
    syncSourceSelectionState();
    renderSelectedSourceDetails();
    closeSourcePopover(false, { force: true });
    return;
  }

  const sourceSwitchRequestToken = ++manualSourceSwitchRequestToken;
  const previousSourceHash = selectedSourceHash;
  const previousSourceSelectionPinned = sourceSelectionPinned;
  activeManualSourceSwitchRequestToken = sourceSwitchRequestToken;
  clearManualSourceSwitchRestore();

  if (!isTmdbResolvedPlayback) {
    selectedSourceHash = normalizedNextSourceHash;
    sourceSelectionPinned = true;
    applyPreferredSourceAudioSync(selectedSourceHash);
    persistSourceHashInUrl();
    syncAudioState();
    finishManualSourceSwitchRequest(sourceSwitchRequestToken);
    return;
  }

  const resumeFrom = getEffectiveCurrentTime();
  const wasPaused = video.paused;
  const playbackRequestToken = ++tmdbPlaybackRequestToken;
  const restoreState = createManualSourceSwitchRestoreState({
    targetSourceHash: normalizedNextSourceHash,
    resumeSeconds: resumeFrom,
    wasPaused,
  });
  selectedSourceHash = normalizedNextSourceHash;
  sourceSelectionPinned = true;
  applyPreferredSourceAudioSync(selectedSourceHash);
  persistSourceHashInUrl();
  syncAudioState();
  syncSourceSelectionState();
  renderSelectedSourceDetails();
  tmdbResolveRetries = 0;
  closeAudioPopover(false, { force: true });
  closeSourcePopover(false, { force: true });
  showResolver("Checking source...");
  try {
    const result = await resolveTmdbSourcesAndPlay({
      allowSourceFallback: false,
      applyPlayback: false,
      requiredSourceHash: normalizedNextSourceHash,
      requestSourceHash: normalizedNextSourceHash,
      resolveTimeoutMs: MANUAL_SOURCE_SWITCH_TIMEOUT_MS,
      startSeconds: resumeFrom,
    });
    if (
      sourceSwitchRequestToken !== manualSourceSwitchRequestToken ||
      playbackRequestToken !== tmdbPlaybackRequestToken
    ) {
      return;
    }
    if (result?.nativeLaunched) {
      return;
    }
    sourceSelectionPinned = true;
    armManualSourceSwitchRestoreTimeout(restoreState);
    showResolver("Switching source...");
    const applied = await applyResolvedTmdbPlayback(result.resolved, {
      resolvedSourceHash: result.resolvedSourceHash || normalizedNextSourceHash,
      startSeconds: resumeFrom,
      playbackRequestToken,
    });
    if (applied?.stale) {
      if (pendingManualSourceSwitchRestore === restoreState) {
        clearManualSourceSwitchRestore();
      }
      return;
    }
    if (pendingManualSourceSwitchRestore !== restoreState) {
      return;
    }
    if (applied?.nativeLaunched) {
      clearManualSourceSwitchRestore();
      return;
    }
    if (!wasPaused) {
      await tryPlay();
    }
    if (pendingManualSourceSwitchRestore !== restoreState) {
      return;
    }
    if (resumeFrom > 1) {
      seekToAbsoluteTime(resumeFrom);
    }
    if (video.readyState >= 2 || getEffectiveCurrentTime() > 0.5) {
      completeManualSourceSwitchIfActive();
    }
  } catch (error) {
    if (pendingManualSourceSwitchRestore === restoreState) {
      await restoreManualSourceSwitchPlayback(
        error?.message || "Unable to switch source.",
      );
      return;
    }
    if (sourceSwitchRequestToken !== manualSourceSwitchRequestToken) {
      resolverFailedSourceHashes.add(normalizedNextSourceHash);
      return;
    }
    resolverFailedSourceHashes.add(normalizedNextSourceHash);
    selectedSourceHash = previousSourceHash;
    sourceSelectionPinned = previousSourceSelectionPinned;
    applyPreferredSourceAudioSync(selectedSourceHash);
    persistSourceHashInUrl();
    syncAudioState();
    syncSourceSelectionState();
    renderSelectedSourceDetails();
    hideSeekLoadingIndicator();
    hideResolver();
    console.warn("Unable to switch source.", error);
  } finally {
    finishManualSourceSwitchRequest(sourceSwitchRequestToken);
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

if (sourceOptionsContainer) trackListener(sourceOptionsContainer, "click", (event) => {
  if (!(event.target instanceof Element)) {
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
  lastRenderedSubtitleCueIndex = -1;
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
  clearLiveVisualHealthWatch({ resetSamples: true });
  if (!liveStartupWatchArmed || hasLivePlaybackStarted()) {
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
  fetch("/api/user/watch-progress", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceIdentity }),
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
    _cleanups.forEach(fn => fn());
    _cleanups.length = 0;
    if (resumeFlushIntervalId) {
      window.clearInterval(resumeFlushIntervalId);
      resumeFlushIntervalId = 0;
    }
    clearInitialResumeRetry();
    window.clearTimeout(unavailableEpisodeResolverHideTimeout);
    window.clearTimeout(audioDecodeRecoveryResetTimeout);
    window.clearTimeout(subtitleRestoreAfterSourceChangeTimeout);
    if (window.__NETFLIX_PLAYBACK_BENCHMARK__) {
      delete window.__NETFLIX_PLAYBACK_BENCHMARK__;
    }
    clearControlsHideTimer();
    clearSingleClickPlaybackToggle();
    clearStreamStallRecovery();
    clearLiveVisualHealthWatch({ resetSamples: true });
    clearLiveStartupHealthWatch({ resetRequest: true });
    clearPlaybackRecovery();
    clearAudioDecodeWatch();
    stopLocalCacheUpgradeWatch();
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
    if (autoPlayCountdownInterval) clearInterval(autoPlayCountdownInterval);
    if (seekLoadingTimeout) clearTimeout(seekLoadingTimeout);
  });


  return renderPlayerShell({
    defaultEpisodeThumbnail: DEFAULT_EPISODE_THUMBNAIL,
    handleLiveIframePlaybackError,
    liveIframeAllowPolicy: LIVE_IFRAME_ALLOW_POLICY,
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
      liveEmbedFrame: (el) => {
        liveEmbedFrame = el;
        hardenLiveEmbedFrame();
      },
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

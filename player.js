const video = document.getElementById("playerVideo");
const goBack = document.getElementById("goBack");
const seekBar = document.getElementById("seekBar");
const durationText = document.getElementById("durationText");
const togglePlay = document.getElementById("togglePlay");
const rewind10 = document.getElementById("rewind10");
const forward10 = document.getElementById("forward10");
const volumeControl = document.getElementById("volumeControl");
const volumeSlider = document.getElementById("volumeSlider");
const toggleMutePlayer = document.getElementById("toggleMutePlayer");
const toggleFullscreen = document.getElementById("toggleFullscreen");
const toggleSpeed = document.getElementById("toggleSpeed");
const speedControl = document.getElementById("speedControl");
const speedOptions = Array.from(document.querySelectorAll(".speed-option"));
const nextEpisode = document.getElementById("nextEpisode");
const toggleEpisodes = document.getElementById("toggleEpisodes");
const episodesControl = document.getElementById("episodesControl");
const episodesList = document.getElementById("episodesList");
const episodesPopoverTitle = document.getElementById("episodesPopoverTitle");
const toggleAudio = document.getElementById("toggleAudio");
const audioControl = document.getElementById("audioControl");
const audioMenu = document.getElementById("audioMenu");
const audioOptionsContainer = document.getElementById("audioOptions");
const subtitleOptionsContainer = document.getElementById("subtitleOptions");
const audioStatusBadge = document.getElementById("audioStatusBadge");
const subtitlePanel = document.getElementById("subtitlePanel");
const audioTabSubtitles = document.getElementById("audioTabSubtitles");
const audioTabSources = document.getElementById("audioTabSources");
const sourcePanel = document.getElementById("sourcePanel");
const sourceOptionsContainer = document.getElementById("sourceOptions");
const sourceOptionDetails = document.getElementById("sourceOptionDetails");
const episodeLabel = document.getElementById("episodeLabel");
const subtitleOverlay = document.getElementById("subtitleOverlay");
const resolverOverlay = document.getElementById("resolverOverlay");
const resolverStatus = document.getElementById("resolverStatus");
const resolverLoader = document.getElementById("resolverLoader");
const seekLoadingOverlay = document.getElementById("seekLoadingOverlay");
const playerShell = document.querySelector(".player-shell");

const playbackRates = [0.5, 0.75, 1, 1.25, 1.5];
const controlsHideDelayMs = 3000;
const singleClickToggleDelayMs = 220;
const seekLoadingTimeoutMs = 9000;

let isDraggingSeek = false;
let speedPopoverCloseTimeout = null;
let episodesPopoverCloseTimeout = null;
let audioPopoverCloseTimeout = null;
let streamStallRecoveryTimeout = null;
let controlsHideTimeout = null;
let singleClickPlaybackToggleTimeout = null;
let seekLoadingTimeout = null;
let tmdbSourceQueue = [];
let tmdbSourceAttemptIndex = 0;
let tmdbResolveRetries = 0;
let knownDurationSeconds = 0;
let expectedDurationSeconds = 0;
const maxTmdbResolveRetries = 2;
let isRecoveringTmdbStream = false;
let activeTranscodeInput = "";
let activeAudioStreamIndex = -1;
let activeAudioSyncMs = 0;
let transcodeBaseOffsetSeconds = 0;
let hasAppliedInitialResume = false;
let pendingTranscodeSeekRatio = null;
let pendingStandardSeekRatio = null;
let hlsInstance = null;
let activeTrackSourceInput = "";
let selectedAudioStreamIndex = -1;
let selectedSubtitleStreamIndex = -1;
let availableAudioTracks = [];
let availableSubtitleTracks = [];
let availablePlaybackSources = [];
let subtitleTrackElement = null;
let customSubtitleCues = [];
let customSubtitleCueCursor = 0;
let customSubtitleLoadToken = 0;
let resolvedTrackPreferenceAudio = "auto";
let preferredSubtitleLang = "";
let audioOptions = [];
let subtitleOptions = [];
let nativePlaybackLaunched = false;
let activeAudioTab = "subtitles";
let seriesEpisodeThumbHydrationTask = null;
let hasHydratedSeriesEpisodeThumbs = false;
let hasQueuedGallerySave = false;
let lastAudibleVolume = 1;
const sourceSaveStateByHash = new Map();
const sourceSaveResetTimeoutByHash = new Map();

const params = new URLSearchParams(window.location.search);
const benchmarkModeEnabled = new Set(["1", "true", "yes", "on"]).has(
  String(params.get("benchmark") || "")
    .trim()
    .toLowerCase(),
);
const DEFAULT_TRAILER_SOURCE =
  "assets/videos/jeffrey-epstein-filthy-rich-official-trailer-netflix.mp4";
const DEFAULT_EPISODE_THUMBNAIL = "assets/images/thumbnail.jpg";
const JEFFREY_EPSTEIN_EPISODE_1_SOURCE =
  "assets/videos/jeffrey-epstein-filthy-rich-s01e01-2160p-hevc.mp4";
const STATIC_SERIES_LIBRARY = {
  "jeffrey-epstein-filthy-rich": {
    id: "jeffrey-epstein-filthy-rich",
    title: "Jeffrey Epstein: Filthy Rich",
    tmdbId: "103506",
    year: "2020",
    preferredContainer: "mp4",
    requiresLocalEpisodeSources: true,
    episodes: [
      {
        title: "Hunting Grounds",
        description:
          'Survivors recount how Epstein abused, manipulated and silenced them as he ran a so-called molestation "pyramid scheme" out of his Palm Beach mansion.',
        thumb: "assets/images/jeffrey-epstein-s01e01-thumb.jpg",
        src: JEFFREY_EPSTEIN_EPISODE_1_SOURCE,
        seasonNumber: 1,
        episodeNumber: 1,
      },
      {
        title: "Follow the Money",
        description:
          "The survivors and journalists retrace how Epstein built influence, money and legal insulation for years.",
        thumb: "assets/images/thumbnail.jpg",
        seasonNumber: 1,
        episodeNumber: 2,
      },
      {
        title: "The Island",
        description:
          "Victims and insiders detail what happened at Epstein's private island and who enabled access.",
        thumb: "assets/images/thumbnail.jpg",
        seasonNumber: 1,
        episodeNumber: 3,
      },
      {
        title: "Finding Their Voice",
        description:
          "Women who were silenced for years step forward publicly and push for accountability.",
        thumb: "assets/images/thumbnail.jpg",
        seasonNumber: 1,
        episodeNumber: 4,
      },
    ],
  },
  "breaking-bad": {
    id: "breaking-bad",
    title: "Breaking Bad",
    tmdbId: "1396",
    year: "2008",
    episodes: [
      {
        title: "Pilot",
        description:
          "A chemistry teacher facing a life-changing diagnosis is pushed toward a dangerous new plan.",
        thumb: "assets/images/thumbnail.jpg",
        seasonNumber: 1,
        episodeNumber: 1,
      },
      {
        title: "Cat's in the Bag...",
        description:
          "Walt and Jesse scramble to cover their tracks while pressure builds at home and at work.",
        thumb: "assets/images/thumbnail.jpg",
        seasonNumber: 1,
        episodeNumber: 2,
      },
      {
        title: "...And the Bag's in the River",
        description:
          "A difficult decision tests Walt's limits as Jesse struggles with the fallout.",
        thumb: "assets/images/thumbnail.jpg",
        seasonNumber: 1,
        episodeNumber: 3,
      },
      {
        title: "Cancer Man",
        description:
          "Family tension grows as Walt keeps secrets and Jesse tries to steady his life.",
        thumb: "assets/images/thumbnail.jpg",
        seasonNumber: 1,
        episodeNumber: 4,
      },
      {
        title: "Gray Matter",
        description:
          "A job offer from Walt's past creates a conflict between pride, money and survival.",
        thumb: "assets/images/thumbnail.jpg",
        seasonNumber: 1,
        episodeNumber: 5,
      },
      {
        title: "Crazy Handful of Nothin'",
        description:
          "Walt adopts a new identity to send a message while family and law pressure increase.",
        thumb: "assets/images/thumbnail.jpg",
        seasonNumber: 1,
        episodeNumber: 6,
      },
      {
        title: "A No-Rough-Stuff-Type Deal",
        description:
          "A risky theft and a bigger distribution push leave Walt and Jesse in over their heads.",
        thumb: "assets/images/thumbnail.jpg",
        seasonNumber: 1,
        episodeNumber: 7,
      },
    ],
  },
};

function normalizeSeriesContentKind(value, fallback = "series") {
  return String(value || fallback || "")
    .trim()
    .toLowerCase() === "course"
    ? "course"
    : "series";
}

function cloneSeriesEpisode(entry = {}) {
  const contentKind = normalizeSeriesContentKind(entry?.contentKind);
  return {
    title: String(entry?.title || "").trim(),
    description: String(entry?.description || "").trim(),
    thumb: String(entry?.thumb || "").trim() || DEFAULT_EPISODE_THUMBNAIL,
    src: String(entry?.src || "").trim(),
    contentKind,
    seasonNumber: Math.max(1, Math.floor(Number(entry?.seasonNumber || 1))),
    episodeNumber: Math.max(1, Math.floor(Number(entry?.episodeNumber || 1))),
  };
}

function mergeSeriesLibraries(staticLibrary = {}, localLibrary = {}) {
  const merged = {};
  const staticEntries = Object.entries(staticLibrary || {});
  const staticTmdbToSeriesId = new Map();

  staticEntries.forEach(([seriesId, series]) => {
    const tmdbId = String(series?.tmdbId || "").trim();
    const seriesContentKind = normalizeSeriesContentKind(series?.contentKind);
    if (tmdbId) {
      staticTmdbToSeriesId.set(tmdbId, seriesId);
    }
    merged[seriesId] = {
      ...series,
      contentKind: seriesContentKind,
      episodes: Array.isArray(series?.episodes)
        ? series.episodes.map((episode) =>
            cloneSeriesEpisode({
              ...episode,
              contentKind:
                episode?.contentKind || seriesContentKind || "series",
            }),
          )
        : [],
    };
  });

  const localEntries = Object.values(localLibrary || {});
  localEntries.forEach((series) => {
    const localTmdbId = String(series?.tmdbId || "").trim();
    const localSeriesContentKind = normalizeSeriesContentKind(
      series?.contentKind,
      /\bcourse\b/i.test(String(series?.id || "").trim()) ? "course" : "series",
    );
    const localId = String(series?.id || "")
      .trim()
      .toLowerCase();
    const mappedStaticId =
      localTmdbId && staticTmdbToSeriesId.has(localTmdbId)
        ? staticTmdbToSeriesId.get(localTmdbId)
        : "";
    const targetId = mappedStaticId || localId;
    if (!targetId) {
      return;
    }

    if (!merged[targetId]) {
      merged[targetId] = {
        id: targetId,
        title: String(series?.title || "Series").trim() || "Series",
        tmdbId: localTmdbId,
        year: String(series?.year || "").trim(),
        contentKind: localSeriesContentKind,
        preferredContainer: "mp4",
        requiresLocalEpisodeSources: true,
        episodes: [],
      };
    }

    const targetSeries = merged[targetId];
    const targetEpisodes = Array.isArray(targetSeries.episodes)
      ? targetSeries.episodes
      : [];
    const localEpisodes = Array.isArray(series?.episodes)
      ? series.episodes
      : [];

    localEpisodes.forEach((episode) => {
      const nextEpisode = cloneSeriesEpisode({
        ...episode,
        contentKind:
          episode?.contentKind ||
          targetSeries.contentKind ||
          localSeriesContentKind,
      });
      if (!nextEpisode.src) {
        return;
      }
      const existingIndex = targetEpisodes.findIndex(
        (entry) =>
          Number(entry?.seasonNumber || 1) === nextEpisode.seasonNumber &&
          Number(entry?.episodeNumber || 1) === nextEpisode.episodeNumber,
      );

      if (existingIndex >= 0) {
        targetEpisodes[existingIndex] = {
          ...targetEpisodes[existingIndex],
          src: nextEpisode.src,
          contentKind: nextEpisode.contentKind,
          thumb:
            String(nextEpisode.thumb || "").trim() ||
            String(targetEpisodes[existingIndex]?.thumb || "").trim() ||
            DEFAULT_EPISODE_THUMBNAIL,
          title:
            String(targetEpisodes[existingIndex]?.title || "").trim() ||
            nextEpisode.title,
          description:
            String(targetEpisodes[existingIndex]?.description || "").trim() ||
            nextEpisode.description,
        };
      } else {
        targetEpisodes.push(nextEpisode);
      }
    });

    targetEpisodes.sort((left, right) => {
      const seasonDelta =
        Number(left?.seasonNumber || 1) - Number(right?.seasonNumber || 1);
      if (seasonDelta !== 0) {
        return seasonDelta;
      }
      return (
        Number(left?.episodeNumber || 1) - Number(right?.episodeNumber || 1)
      );
    });

    targetSeries.episodes = targetEpisodes;
    targetSeries.contentKind = normalizeSeriesContentKind(
      targetSeries.contentKind || localSeriesContentKind,
      localSeriesContentKind,
    );
    targetSeries.requiresLocalEpisodeSources =
      Boolean(targetSeries.requiresLocalEpisodeSources) ||
      Boolean(series?.requiresLocalEpisodeSources);
    if (!String(targetSeries.tmdbId || "").trim() && localTmdbId) {
      targetSeries.tmdbId = localTmdbId;
    }
  });

  return merged;
}

function normalizeLocalSeriesLibrary(payload) {
  const list = Array.isArray(payload?.series) ? payload.series : [];
  const nextLibrary = {};

  list.forEach((entry) => {
    const id = String(entry?.id || "")
      .trim()
      .toLowerCase();
    const title = String(entry?.title || "").trim();
    if (!id || !title) {
      return;
    }
    const contentKind = normalizeSeriesContentKind(
      entry?.contentKind,
      /\bcourse\b/i.test(`${id} ${title}`.trim()) ? "course" : "series",
    );
    const episodes = Array.isArray(entry?.episodes)
      ? entry.episodes
          .map((episode, index) => {
            const src = String(episode?.src || "").trim();
            if (!src) {
              return null;
            }
            const seasonNumber = Number(episode?.seasonNumber || 1);
            const episodeNumber = Number(episode?.episodeNumber || index + 1);
            const episodeContentKind = normalizeSeriesContentKind(
              episode?.contentKind,
              contentKind,
            );
            const fallbackTitlePrefix =
              episodeContentKind === "course" ? "Lesson" : "Episode";
            return {
              title:
                String(episode?.title || "").trim() ||
                `${fallbackTitlePrefix} ${index + 1}`,
              description: String(episode?.description || "").trim(),
              thumb:
                String(episode?.thumb || "").trim() ||
                DEFAULT_EPISODE_THUMBNAIL,
              src,
              contentKind: episodeContentKind,
              seasonNumber:
                Number.isFinite(seasonNumber) && seasonNumber > 0
                  ? Math.floor(seasonNumber)
                  : 1,
              episodeNumber:
                Number.isFinite(episodeNumber) && episodeNumber > 0
                  ? Math.floor(episodeNumber)
                  : index + 1,
            };
          })
          .filter(Boolean)
      : [];
    if (!episodes.length) {
      return;
    }
    episodes.sort((left, right) => {
      const seasonDelta = left.seasonNumber - right.seasonNumber;
      if (seasonDelta !== 0) {
        return seasonDelta;
      }
      return left.episodeNumber - right.episodeNumber;
    });

    nextLibrary[id] = {
      id,
      title,
      contentKind,
      tmdbId: /^\d+$/.test(String(entry?.tmdbId || "").trim())
        ? String(entry.tmdbId).trim()
        : "",
      year: String(entry?.year || "").trim(),
      preferredContainer: "mp4",
      requiresLocalEpisodeSources: true,
      episodes,
    };
  });

  return nextLibrary;
}

async function fetchLocalSeriesLibrary() {
  try {
    const response = await fetch("/api/library");
    if (!response.ok) {
      return {};
    }
    const payload = await response.json().catch(() => null);
    return normalizeLocalSeriesLibrary(payload || {});
  } catch {
    return {};
  }
}

const SERIES_LIBRARY = Object.freeze({
  ...mergeSeriesLibraries(
    STATIC_SERIES_LIBRARY,
    await fetchLocalSeriesLibrary(),
  ),
});
const rawSourceParam = String(params.get("src") || "").trim();
const normalizedRawSourceParam = rawSourceParam.startsWith("assets/")
  ? `/${rawSourceParam}`
  : rawSourceParam;

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

const mediaTypeParam = String(params.get("mediaType") || "")
  .trim()
  .toLowerCase();
const isExplicitTvPlayback = mediaTypeParam === "tv";
const requestedSeriesId = String(params.get("seriesId") || "")
  .trim()
  .toLowerCase();
const hasRequestedEpisodeIndexParam = params.has("episodeIndex");
const requestedEpisodeIndex = Number(params.get("episodeIndex") || 0);
const explicitSeriesPlayback =
  isExplicitTvPlayback &&
  Object.prototype.hasOwnProperty.call(SERIES_LIBRARY, requestedSeriesId)
    ? {
        seriesId: requestedSeriesId,
        series: SERIES_LIBRARY[requestedSeriesId],
        episodeIndex: 0,
      }
    : null;
const inferredSeriesPlayback = inferSeriesPlaybackFromSource(
  normalizedRawSourceParam,
);
const activeSeriesMatch = explicitSeriesPlayback || inferredSeriesPlayback;
const activeSeries = activeSeriesMatch?.series || null;
const seriesEpisodes = Array.isArray(activeSeries?.episodes)
  ? activeSeries.episodes
  : [];
const selectedSeriesEpisodeIndex = hasRequestedEpisodeIndexParam
  ? requestedEpisodeIndex
  : Number(activeSeriesMatch?.episodeIndex || 0);
const seriesEpisodeIndex = seriesEpisodes.length
  ? Math.max(
      0,
      Math.min(
        seriesEpisodes.length - 1,
        Number.isFinite(selectedSeriesEpisodeIndex)
          ? Math.floor(selectedSeriesEpisodeIndex)
          : 0,
      ),
    )
  : -1;
const activeSeriesEpisode =
  seriesEpisodeIndex >= 0 ? seriesEpisodes[seriesEpisodeIndex] : null;
const isSeriesPlayback = Boolean(
  activeSeriesEpisode && (isExplicitTvPlayback || inferredSeriesPlayback),
);
const hasSeriesEpisodeControls =
  isSeriesPlayback && Boolean(activeSeries && seriesEpisodes.length > 1);
const rawSeriesSourceParam = String(activeSeriesEpisode?.src || "").trim();
const normalizedSeriesSourceParam = rawSeriesSourceParam.startsWith("assets/")
  ? `/${rawSeriesSourceParam}`
  : rawSeriesSourceParam;
const thumbParam = String(params.get("thumb") || "").trim();
const src = isSeriesPlayback
  ? normalizedSeriesSourceParam || normalizedRawSourceParam
  : normalizedRawSourceParam;
const fallbackSeasonNumber = Number(
  params.get("seasonNumber") || params.get("season") || 1,
);
const fallbackEpisodeNumber = Number(
  params.get("episodeNumber") || params.get("episodeOrdinal") || 1,
);
const rawTitle = isSeriesPlayback
  ? String(activeSeries.title || "")
  : params.get("title") || "Jeffrey Epstein: Filthy Rich";
const rawEpisode = isSeriesPlayback
  ? getSeriesEpisodeLabel(
      seriesEpisodeIndex,
      activeSeriesEpisode?.title || "",
      activeSeries,
      Number(activeSeriesEpisode?.episodeNumber || seriesEpisodeIndex + 1),
    )
  : params.get("episode") || "";
const title = rawTitle;
const episode = rawEpisode;
const tmdbId = String(
  activeSeries?.tmdbId || params.get("tmdbId") || "",
).trim();
const mediaType = isSeriesPlayback ? "tv" : mediaTypeParam;
const year = String(activeSeries?.year || params.get("year") || "").trim();
const seasonNumber = isSeriesPlayback
  ? Math.max(1, Math.floor(Number(activeSeriesEpisode?.seasonNumber || 1)))
  : Number.isFinite(fallbackSeasonNumber)
    ? Math.max(1, Math.floor(fallbackSeasonNumber))
    : 1;
const episodeNumber = isSeriesPlayback
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
const preferredContainerParam = String(
  activeSeries?.preferredContainer || params.get("preferredContainer") || "",
)
  .trim()
  .toLowerCase();
const preferredContainer =
  preferredContainerParam === "mp4" || preferredContainerParam === "mkv"
    ? preferredContainerParam
    : "";
const hasSubtitleLangParam = params.has("subtitleLang");
const subtitleLangParam = (params.get("subtitleLang") || "")
  .trim()
  .toLowerCase();
const sourceHashParam = (params.get("sourceHash") || "").trim().toLowerCase();
const saveToGalleryParam = (params.get("saveToGallery") || "")
  .trim()
  .toLowerCase();
const shouldSaveToGallery = new Set(["1", "true", "yes", "on"]).has(
  saveToGalleryParam,
);
const hasExplicitSource = Boolean(src);
const isExplicitLocalUploadSource = Boolean(
  hasExplicitSource &&
  (() => {
    const normalizedSource = String(src || "")
      .trim()
      .toLowerCase();
    return (
      normalizedSource.startsWith("/media/") ||
      normalizedSource.includes("/media/") ||
      normalizedSource.startsWith("/videos/") ||
      normalizedSource.startsWith("videos/") ||
      normalizedSource.includes("/videos/") ||
      normalizedSource.startsWith("assets/videos/") ||
      normalizedSource.includes("/assets/videos/")
    );
  })(),
);
const isTmdbMoviePlayback = Boolean(
  !hasExplicitSource && tmdbId && mediaType === "movie",
);
const isTmdbTvPlayback = Boolean(
  !hasExplicitSource && tmdbId && mediaType === "tv",
);
const isTmdbResolvedPlayback = Boolean(isTmdbMoviePlayback || isTmdbTvPlayback);
const supportedAudioLangs = new Set([
  "auto",
  "en",
  "fr",
  "es",
  "de",
  "it",
  "pt",
  "ja",
  "ko",
  "zh",
  "nl",
  "ro",
]);
const AUDIO_LANG_PREF_KEY_PREFIX = "netflix-audio-lang:movie:";
const SUBTITLE_LANG_PREF_KEY_PREFIX = "netflix-subtitle-lang:movie:";
const SUBTITLE_STREAM_PREF_KEY_PREFIX = "netflix-subtitle-stream:movie:";
const LOCAL_SUBTITLE_LANG_PREF_KEY_PREFIX = "netflix-subtitle-lang:local:";
const LOCAL_SUBTITLE_STREAM_PREF_KEY_PREFIX = "netflix-subtitle-stream:local:";
const STREAM_QUALITY_PREF_KEY = "netflix-stream-quality-pref";
const SOURCE_MIN_SEEDERS_PREF_KEY = "netflix-source-filter-min-seeders";
const SOURCE_LANGUAGE_PREF_KEY = "netflix-source-filter-language";
const SOURCE_AUDIO_PROFILE_PREF_KEY = "netflix-source-filter-audio-profile";
const DEFAULT_AUDIO_LANGUAGE_PREF_KEY = "netflix-default-audio-lang";
const SOURCE_AUDIO_SYNC_PREF_KEY_PREFIX = "netflix-source-audio-sync:";
const NATIVE_PLAYBACK_MODE_PREF_KEY = "netflix-native-playback-mode";
const REMUX_VIDEO_MODE_PREF_KEY = "netflix-remux-video-mode";
const SUBTITLE_COLOR_PREF_KEY = "netflix-subtitle-color-pref";
const DEFAULT_SUBTITLE_COLOR = "#b8bcc3";
const DEFAULT_STREAM_QUALITY_PREFERENCE = "1080p";
const DEFAULT_SOURCE_RESULTS_LIMIT = 5;
const SOURCE_FETCH_BATCH_LIMIT = 20;
const supportedQualityPreferences = new Set(["auto", "2160p", "1080p", "720p"]);
const supportedSourceFormats = ["mp4"];
const supportedSourceFormatSet = new Set(supportedSourceFormats);
const supportedSourceLanguages = new Set([
  "en",
  "any",
  "fr",
  "es",
  "de",
  "it",
  "pt",
]);
const supportedSourceAudioProfiles = new Set(["single", "any"]);
const SOURCE_LANGUAGE_TOKENS = {
  en: ["english", " eng ", "en audio", "dubbed english", " dual audio eng"],
  fr: ["french", " fran", "vf", "vff", " fra "],
  es: ["spanish", "espanol", "castellano", " spa ", " esp "],
  de: ["german", " deutsch", " ger ", " deu "],
  it: ["italian", " italiano", " ita "],
  pt: ["portuguese", " portugues", " por ", " pt-br ", " brazilian "],
};
const AUDIO_SYNC_MIN_MS = -2500;
const AUDIO_SYNC_MAX_MS = 2500;
const AUDIO_SYNC_STEP_MS = 50;
const RESUME_SAVE_MIN_INTERVAL_MS = 3000;
const RESUME_SAVE_MIN_DELTA_SECONDS = 1.5;
const RESUME_CLEAR_AT_END_THRESHOLD_SECONDS = 8;
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
};

const playbackBenchmark = benchmarkModeEnabled
  ? createPlaybackBenchmarkApi()
  : null;

if (playbackBenchmark) {
  window.__NETFLIX_PLAYBACK_BENCHMARK__ = playbackBenchmark;
}

let selectedSourceHash = normalizeSourceHash(sourceHashParam);
let sourceSelectionPinned = false;

function getPinnedSourceHashForRequests() {
  if (!sourceSelectionPinned) {
    return "";
  }
  return normalizeSourceHash(selectedSourceHash);
}

function getAudioLangPreferenceStorageKey(movieTmdbId) {
  return `${AUDIO_LANG_PREF_KEY_PREFIX}${String(movieTmdbId || "").trim()}`;
}

function normalizeDefaultAudioLanguage(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (
    !normalized ||
    normalized === "en" ||
    normalized === "eng" ||
    normalized === "english"
  ) {
    return "en";
  }
  if (
    normalized === "auto" ||
    normalized === "default" ||
    normalized === "source" ||
    normalized === "original"
  ) {
    return "auto";
  }
  if (supportedAudioLangs.has(normalized)) {
    return normalized;
  }
  return "en";
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

function getStoredPreferredQuality() {
  try {
    return normalizePreferredQuality(
      localStorage.getItem(STREAM_QUALITY_PREF_KEY),
    );
  } catch {
    return DEFAULT_STREAM_QUALITY_PREFERENCE;
  }
}

function normalizeSourceMinSeeders(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.min(50000, Math.floor(parsed)));
}

function normalizeSourceLanguage(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (
    !normalized ||
    normalized === "en" ||
    normalized === "eng" ||
    normalized === "english"
  ) {
    return "en";
  }
  if (
    normalized === "any" ||
    normalized === "all" ||
    normalized === "auto" ||
    normalized === "*"
  ) {
    return "any";
  }
  if (supportedSourceLanguages.has(normalized)) {
    return normalized;
  }
  return "en";
}

function getStoredSourceMinSeeders() {
  try {
    return normalizeSourceMinSeeders(
      localStorage.getItem(SOURCE_MIN_SEEDERS_PREF_KEY),
    );
  } catch {
    return 0;
  }
}

function getStoredSourceLanguage() {
  try {
    return normalizeSourceLanguage(
      localStorage.getItem(SOURCE_LANGUAGE_PREF_KEY),
    );
  } catch {
    return "en";
  }
}

function normalizeSourceAudioProfile(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (
    !normalized ||
    normalized === "single" ||
    normalized === "single-audio" ||
    normalized === "single_audio" ||
    normalized === "singleaudio" ||
    normalized === "preferred"
  ) {
    return "single";
  }
  if (
    normalized === "any" ||
    normalized === "multi" ||
    normalized === "multi-audio" ||
    normalized === "multi_audio" ||
    normalized === "multiaudio" ||
    normalized === "all"
  ) {
    return "any";
  }
  if (supportedSourceAudioProfiles.has(normalized)) {
    return normalized;
  }
  return "single";
}

function getStoredSourceAudioProfile() {
  try {
    return normalizeSourceAudioProfile(
      localStorage.getItem(SOURCE_AUDIO_PROFILE_PREF_KEY),
    );
  } catch {
    return "single";
  }
}

function normalizeSubtitleColor(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(raw)) {
    return raw;
  }
  if (/^#[0-9a-f]{3}$/.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
  }
  return DEFAULT_SUBTITLE_COLOR;
}

function getStoredSubtitleColorPreference() {
  try {
    return normalizeSubtitleColor(
      localStorage.getItem(SUBTITLE_COLOR_PREF_KEY),
    );
  } catch {
    return DEFAULT_SUBTITLE_COLOR;
  }
}

function applySubtitleCueColor(
  colorValue = getStoredSubtitleColorPreference(),
) {
  const normalizedColor = normalizeSubtitleColor(colorValue);
  let styleElement = document.getElementById("subtitleCueColorStyle");
  if (!(styleElement instanceof HTMLStyleElement)) {
    styleElement = document.createElement("style");
    styleElement.id = "subtitleCueColorStyle";
    document.head.appendChild(styleElement);
  }

  styleElement.textContent = `
    #playerVideo::cue {
      color: ${normalizedColor};
      background: transparent !important;
      background-color: transparent !important;
      box-shadow: none !important;
      outline: none !important;
      text-shadow: none !important;
    }
    #playerVideo::cue(*) {
      background: transparent !important;
      background-color: transparent !important;
      text-shadow: none !important;
    }
    #playerVideo::-webkit-media-text-track-display,
    #playerVideo::-webkit-media-text-track-container,
    #playerVideo::-webkit-media-text-track-background,
    #playerVideo::-webkit-media-text-track-region,
    #playerVideo::-webkit-media-text-track-display-backdrop,
    #playerVideo::cue-region {
      background: transparent !important;
      background-color: transparent !important;
    }
    #playerVideo::-webkit-media-text-track-cue {
      background: transparent !important;
      background-color: transparent !important;
      text-shadow: none !important;
    }
  `;
}

function normalizeAudioSyncMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  const clamped = Math.max(
    AUDIO_SYNC_MIN_MS,
    Math.min(AUDIO_SYNC_MAX_MS, Math.round(parsed)),
  );
  return clamped;
}

function normalizeNativePlaybackMode(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (
    !normalized ||
    normalized === "auto" ||
    normalized === "on" ||
    normalized === "1" ||
    normalized === "enabled"
  ) {
    return "auto";
  }
  if (
    normalized === "off" ||
    normalized === "0" ||
    normalized === "disabled" ||
    normalized === "browser"
  ) {
    return "off";
  }
  return "auto";
}

function getStoredNativePlaybackMode() {
  try {
    return normalizeNativePlaybackMode(
      localStorage.getItem(NATIVE_PLAYBACK_MODE_PREF_KEY),
    );
  } catch {
    return "auto";
  }
}

function normalizeRemuxVideoMode(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized || normalized === "auto" || normalized === "default") {
    return "auto";
  }
  if (
    normalized === "copy" ||
    normalized === "passthrough" ||
    normalized === "direct" ||
    normalized === "streamcopy"
  ) {
    return "copy";
  }
  if (
    normalized === "normalize" ||
    normalized === "transcode" ||
    normalized === "aggressive" ||
    normalized === "rebuild"
  ) {
    return "normalize";
  }
  return "auto";
}

function getStoredRemuxVideoMode() {
  try {
    return normalizeRemuxVideoMode(
      localStorage.getItem(REMUX_VIDEO_MODE_PREF_KEY),
    );
  } catch {
    return "auto";
  }
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
  return target.scope === "movie"
    ? getSubtitleLangPreferenceStorageKey(target.key)
    : getLocalSubtitleLangPreferenceStorageKey(target.key);
}

function getSubtitleStreamPreferenceStorageKeyForTarget(target) {
  if (!target?.key) {
    return "";
  }
  return target.scope === "movie"
    ? getSubtitleStreamPreferenceStorageKey(target.key)
    : getLocalSubtitleStreamPreferenceStorageKey(target.key);
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
if (isTmdbMoviePlayback && !hasQualityParam) {
  preferredQuality = getStoredPreferredQuality();
}
let preferredSourceMinSeeders = getStoredSourceMinSeeders();
let preferredSourceResultsLimit = DEFAULT_SOURCE_RESULTS_LIMIT;
let preferredSourceFormats = [...supportedSourceFormats];
let preferredSourceLanguage = getStoredSourceLanguage();
let preferredSourceAudioProfile = getStoredSourceAudioProfile();
let preferredAudioSyncMs = 0;
let preferredNativePlaybackMode = getStoredNativePlaybackMode();
let preferredRemuxVideoMode = getStoredRemuxVideoMode();
preferredSubtitleLang = normalizeSubtitlePreference(subtitleLangParam);
if ((isTmdbMoviePlayback || isExplicitLocalUploadSource) && !hasSubtitleLangParam) {
  preferredSubtitleLang =
    getStoredSubtitleLangForCurrentPlayback() || preferredSubtitleLang;
}
if ((isTmdbMoviePlayback || isExplicitLocalUploadSource) && hasSubtitleLangParam) {
  persistSubtitleLangPreference(preferredSubtitleLang);
}
applyPreferredSourceAudioSync(selectedSourceHash);
const sourceIdentity = isSeriesPlayback
  ? `series:${activeSeries.id}:episode:${seriesEpisodeIndex}`
  : src ||
    (isTmdbResolvedPlayback
      ? `tmdb:${mediaType}:${tmdbId}${isTmdbTvPlayback ? `:s${seasonNumber}:e${episodeNumber}` : ""}`
      : DEFAULT_TRAILER_SOURCE);
const resumeStorageKey = `netflix-resume:${sourceIdentity}`;
let resumeTime = 0;
let lastPersistedResumeTime = 0;
let lastPersistedResumeAt = 0;
try {
  const storedResume = Number(localStorage.getItem(resumeStorageKey));
  if (Number.isFinite(storedResume) && storedResume > 0) {
    resumeTime = storedResume;
    lastPersistedResumeTime = storedResume;
  }
} catch {
  // Ignore storage access issues.
}

function readContinueWatchingMetaMap() {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(CONTINUE_WATCHING_META_KEY) || "{}",
    );
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function getCanonicalContinueWatchingMetadata() {
  return {
    title: String(title || "Title"),
    episode: String(episode || "Now Playing"),
    src: String(src || ""),
    tmdbId: String(tmdbId || ""),
    mediaType: String(mediaType || ""),
    seriesId: isSeriesPlayback ? String(activeSeries.id || "") : "",
    episodeIndex: isSeriesPlayback ? seriesEpisodeIndex : -1,
    year: String(year || ""),
    thumb: isSeriesPlayback
      ? String(activeSeriesEpisode?.thumb || DEFAULT_EPISODE_THUMBNAIL)
      : thumbParam,
  };
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
    metaMap[normalizedSource] = {
      sourceIdentity: normalizedSource,
      title: metadata.title,
      episode: metadata.episode,
      src: metadata.src,
      tmdbId: metadata.tmdbId,
      mediaType: metadata.mediaType,
      seriesId: metadata.seriesId,
      episodeIndex: metadata.episodeIndex,
      year: metadata.year,
      thumb: metadata.thumb,
      resumeSeconds: Number(resumeSeconds),
      updatedAt: Date.now(),
    };
    localStorage.setItem(CONTINUE_WATCHING_META_KEY, JSON.stringify(metaMap));
  } catch {
    // Ignore storage access issues.
  }
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
}

if (resumeTime > 1) {
  persistContinueWatchingEntry(resumeTime);
}

function stripAudioSyncFromPageUrl() {
  const nextParams = new URLSearchParams(window.location.search);
  if (!nextParams.has("audioSyncMs")) {
    return;
  }
  nextParams.delete("audioSyncMs");
  const nextQuery = nextParams.toString();
  const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`;
  window.history.replaceState(null, "", nextUrl);
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

function showResolver(message, { isError = false, showStatus = isError } = {}) {
  if (hasExplicitSource && !showStatus && !isError) {
    hideResolver();
    return;
  }

  if (!resolverOverlay) {
    return;
  }

  if (resolverStatus) {
    resolverStatus.textContent =
      String(message || "").trim() || "Unable to load this video.";
    resolverStatus.hidden = !showStatus;
  }
  if (resolverLoader) {
    resolverLoader.hidden = showStatus || isError;
  }
  hideSeekLoadingIndicator();
  resolverOverlay.hidden = false;
  resolverOverlay.classList.toggle("is-error", isError);
}

function hideResolver() {
  if (!resolverOverlay) {
    return;
  }

  resolverOverlay.hidden = true;
  resolverOverlay.classList.remove("is-error");
  if (resolverLoader) {
    resolverLoader.hidden = false;
  }
  if (resolverStatus) {
    resolverStatus.hidden = true;
  }
}

function hasActiveSource() {
  return Boolean(video.currentSrc || video.getAttribute("src"));
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
  const languageLabel = getLanguageDisplayLabel(track?.language || "en");
  const preferredLabel = String(track?.label || track?.title || "").trim();
  if (track?.isExternal) {
    const titleLabel = String(track?.title || "").trim();
    const sourceLabel = isGenericSubtitleLabel(preferredLabel)
      ? `${languageLabel} (${getSubtitleTrackSourceLabel(track) || "External"})`
      : preferredLabel;
    if (!isGenericSubtitleLabel(titleLabel)) {
      return `${titleLabel} - ${sourceLabel}`;
    }
    return sourceLabel;
  }
  if (isGenericSubtitleLabel(preferredLabel)) {
    return languageLabel;
  }
  return preferredLabel || languageLabel;
}

function getSubtitleTrackDisplayParts(track) {
  const languageLabel = getLanguageDisplayLabel(track?.language || "en");
  const preferredLabel = String(track?.label || "").trim();
  const titleLabel = String(track?.title || "").trim();
  const isExternalTrack = Boolean(track?.isExternal);
  const sourceLabel = getSubtitleTrackSourceLabel(track);

  let primary = languageLabel;
  if (isExternalTrack) {
    if (!isGenericSubtitleLabel(titleLabel)) {
      primary = titleLabel;
    } else if (!isGenericSubtitleLabel(preferredLabel)) {
      primary = preferredLabel;
    }
  } else if (!isGenericSubtitleLabel(preferredLabel)) {
    primary = preferredLabel;
  }

  const secondaryParts = [];
  if (primary !== languageLabel) {
    secondaryParts.push(languageLabel);
  }
  if (isExternalTrack && sourceLabel) {
    secondaryParts.push(sourceLabel);
  }
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
  const preferredLabel = String(track?.title || track?.label || "").trim();
  const primary = isGenericAudioLabel(preferredLabel)
    ? languageLabel
    : `${languageLabel} - ${preferredLabel}`;
  const secondaryParts = [];
  const channelLabel = formatAudioChannelLabel(track?.channels);
  if (channelLabel) {
    secondaryParts.push(channelLabel);
  }
  const codecLabel = String(track?.codec || "")
    .trim()
    .toUpperCase();
  if (codecLabel) {
    secondaryParts.push(codecLabel);
  }
  if (track?.isDefault) {
    secondaryParts.push("Default");
  }
  return {
    primary,
    secondary: secondaryParts.join(" • "),
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

function parseVttTimestampToSeconds(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^((\d{1,2}):)?(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) {
    return NaN;
  }

  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);
  const milliseconds = Number((match[5] || "0").padEnd(3, "0"));
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds) ||
    !Number.isFinite(milliseconds)
  ) {
    return NaN;
  }

  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

function decodeSubtitleHtmlEntities(value) {
  const text = String(value || "");
  if (!text || !text.includes("&")) {
    return text;
  }
  const textarea = document.createElement("textarea");
  textarea.innerHTML = text;
  return textarea.value;
}

function isVttTimingLine(value) {
  return String(value || "").trim().includes("-->");
}

function parseWebVttCues(rawText) {
  const normalized = String(rawText || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (!normalized.trim()) {
    return [];
  }

  const lines = normalized.split("\n");
  const cues = [];
  let index = 0;
  while (index < lines.length) {
    const line = String(lines[index] || "");
    const trimmed = line.trim();

    if (!trimmed || /^WEBVTT\b/i.test(trimmed)) {
      index += 1;
      continue;
    }

    if (/^STYLE\b/i.test(trimmed) || /^NOTE\b/i.test(trimmed)) {
      index += 1;
      while (index < lines.length) {
        const blockLine = String(lines[index] || "");
        const blockTrimmed = blockLine.trim();
        if (!blockTrimmed) {
          break;
        }
        const nextTrimmed = String(lines[index + 1] || "").trim();
        if (
          isVttTimingLine(blockTrimmed) ||
          (nextTrimmed && isVttTimingLine(nextTrimmed))
        ) {
          break;
        }
        index += 1;
      }
      continue;
    }

    if (/^REGION\b/i.test(trimmed) || /^X-TIMESTAMP-MAP=/i.test(trimmed)) {
      index += 1;
      continue;
    }

    let timingLine = trimmed;
    if (!isVttTimingLine(timingLine)) {
      const nextLine = String(lines[index + 1] || "").trim();
      if (isVttTimingLine(nextLine)) {
        index += 1;
        timingLine = nextLine;
      } else {
        index += 1;
        continue;
      }
    }

    const [startPart, endPart] = timingLine
      .split("-->", 2)
      .map((part) => String(part || "").trim());
    const startToken = startPart.split(/\s+/)[0];
    const endToken = endPart.split(/\s+/)[0];
    const startSeconds = parseVttTimestampToSeconds(startToken);
    const endSeconds = parseVttTimestampToSeconds(endToken);
    index += 1;

    const cueLines = [];
    while (index < lines.length && String(lines[index] || "").trim()) {
      cueLines.push(String(lines[index] || ""));
      index += 1;
    }

    const rawCueText = cueLines.join("\n");
    const cueText = decodeSubtitleHtmlEntities(
      rawCueText
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/?[^>]+>/g, "")
        .replace(/\u200b/g, ""),
    ).trim();
    if (
      !cueText ||
      !Number.isFinite(startSeconds) ||
      !Number.isFinite(endSeconds) ||
      endSeconds <= startSeconds
    ) {
      continue;
    }

    cues.push({ startSeconds, endSeconds, text: cueText });
  }

  return cues;
}

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
  setCustomSubtitleText("");
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

function renderCustomSubtitleOverlay() {
  if (!subtitleOverlay || selectedSubtitleStreamIndex < 0) {
    setCustomSubtitleText("");
    return;
  }
  if (!customSubtitleCues.length) {
    setCustomSubtitleText("");
    return;
  }

  const currentTimeSeconds = Number(getEffectiveCurrentTime() || 0);
  if (!Number.isFinite(currentTimeSeconds) || currentTimeSeconds < 0) {
    return;
  }

  let cueIndex =
    customSubtitleCueCursor >= 0 &&
    customSubtitleCueCursor < customSubtitleCues.length
      ? customSubtitleCueCursor
      : 0;
  const activeCue =
    customSubtitleCues[cueIndex] &&
    currentTimeSeconds >= customSubtitleCues[cueIndex].startSeconds &&
    currentTimeSeconds <= customSubtitleCues[cueIndex].endSeconds
      ? customSubtitleCues[cueIndex]
      : null;

  if (activeCue) {
    setCustomSubtitleText(activeCue.text);
    return;
  }

  cueIndex = customSubtitleCues.findIndex(
    (cue) =>
      currentTimeSeconds >= cue.startSeconds &&
      currentTimeSeconds <= cue.endSeconds,
  );
  if (cueIndex >= 0) {
    customSubtitleCueCursor = cueIndex;
    setCustomSubtitleText(customSubtitleCues[cueIndex].text);
    return;
  }

  setCustomSubtitleText("");
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
    renderCustomSubtitleOverlay();
    return customSubtitleCues.length > 0;
  } catch {
    if (requestToken === customSubtitleLoadToken) {
      clearCustomSubtitleOverlay();
    }
    return false;
  }
}

function normalizeSourceHash(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return /^[a-f0-9]{40}$/.test(normalized) ? normalized : "";
}

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

function getSourceDisplayName(option = {}) {
  const primary = String(option.primary || "").trim();
  if (primary) {
    return primary;
  }

  const fallback = String(option.filename || "").trim();
  if (fallback) {
    return fallback;
  }

  return "Stream source";
}

function getSourceDisplayHint(option = {}) {
  const hintParts = [];
  const provider = String(option.provider || "").trim();
  const quality = String(option.qualityLabel || "").trim();
  const container = String(option.container || "")
    .trim()
    .toUpperCase();

  if (provider) {
    hintParts.push(provider);
  }
  if (quality) {
    hintParts.push(quality);
  }
  if (container) {
    hintParts.push(container);
  }

  return hintParts.join(" • ");
}

function getSourceDisplayMeta(option = {}) {
  const meta = [];
  const seeders = Number.isFinite(Number(option.seeders))
    ? Math.max(0, Math.floor(Number(option.seeders)))
    : 0;
  const size = String(option.size || "").trim();
  const releaseGroup = String(option.releaseGroup || "").trim();

  if (Number.isFinite(seeders) && seeders > 0) {
    meta.push(`👤 ${seeders}`);
  }
  if (size) {
    meta.push(`💾 ${size}`);
  }
  if (releaseGroup) {
    meta.push(`⚙ ${releaseGroup}`);
  }

  return meta.join(" ");
}

function isSourceOptionLikelyContainer(option = {}, container = "") {
  const safeContainer = String(container || "")
    .trim()
    .toLowerCase();
  if (!safeContainer) {
    return false;
  }
  const explicitContainer = String(option?.container || "")
    .trim()
    .toLowerCase();
  if (explicitContainer) {
    return explicitContainer === safeContainer;
  }

  const sourceText = [
    option?.filename,
    option?.primary,
    option?.title,
    option?.name,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!sourceText) {
    return false;
  }
  if (safeContainer === "mkv") {
    return /\.mkv\b/.test(sourceText);
  }
  if (safeContainer === "mp4") {
    return /\.mp4\b/.test(sourceText);
  }
  return false;
}

function sortSourcesBySeeders(sources = [], { preferContainer = "" } = {}) {
  const normalizedPreferredContainer = String(preferContainer || "")
    .trim()
    .toLowerCase();
  return [...sources].sort((left, right) => {
    if (normalizedPreferredContainer) {
      const rightPreferred = isSourceOptionLikelyContainer(
        right,
        normalizedPreferredContainer,
      );
      const leftPreferred = isSourceOptionLikelyContainer(
        left,
        normalizedPreferredContainer,
      );
      if (rightPreferred !== leftPreferred) {
        return Number(rightPreferred) - Number(leftPreferred);
      }
    }

    const rightSeeders = Number.isFinite(Number(right?.seeders))
      ? Math.max(0, Math.floor(Number(right.seeders)))
      : 0;
    const leftSeeders = Number.isFinite(Number(left?.seeders))
      ? Math.max(0, Math.floor(Number(left.seeders)))
      : 0;
    if (rightSeeders !== leftSeeders) {
      return rightSeeders - leftSeeders;
    }
    return getSourceDisplayName(left).localeCompare(
      getSourceDisplayName(right),
      undefined,
      { sensitivity: "base" },
    );
  });
}

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

function getSourceSaveState(sourceHash = "") {
  const normalizedHash = normalizeSourceHash(sourceHash);
  if (!normalizedHash) {
    return "idle";
  }
  return sourceSaveStateByHash.get(normalizedHash) || "idle";
}

function applySourceSaveButtonState(button, state = "idle") {
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }

  if (state === "saving") {
    button.textContent = "Saving...";
    button.disabled = true;
  } else if (state === "saved") {
    button.textContent = "Saved";
    button.disabled = true;
  } else if (state === "error") {
    button.textContent = "Retry";
    button.disabled = false;
  } else {
    button.textContent = "Save";
    button.disabled = false;
  }
  button.dataset.saveState = state;
}

function syncSourceSaveButtonsForHash(sourceHash = "") {
  if (!(sourceOptionsContainer instanceof HTMLElement)) {
    return;
  }
  const normalizedHash = normalizeSourceHash(sourceHash);
  if (!normalizedHash) {
    return;
  }
  const nextState = getSourceSaveState(normalizedHash);
  const saveButtons = Array.from(
    sourceOptionsContainer.querySelectorAll(
      `.source-save-button[data-source-hash="${normalizedHash}"]`,
    ),
  );
  saveButtons.forEach((saveButton) => {
    applySourceSaveButtonState(saveButton, nextState);
  });
}

function setSourceSaveState(sourceHash = "", state = "idle") {
  const normalizedHash = normalizeSourceHash(sourceHash);
  if (!normalizedHash) {
    return;
  }
  if (state !== "error") {
    const existingTimeout = sourceSaveResetTimeoutByHash.get(normalizedHash);
    if (existingTimeout) {
      window.clearTimeout(existingTimeout);
      sourceSaveResetTimeoutByHash.delete(normalizedHash);
    }
  }
  if (state === "idle") {
    sourceSaveStateByHash.delete(normalizedHash);
  } else {
    sourceSaveStateByHash.set(normalizedHash, state);
  }
  syncSourceSaveButtonsForHash(normalizedHash);
}

function scheduleSourceSaveRetryReset(sourceHash = "", delayMs = 2200) {
  const normalizedHash = normalizeSourceHash(sourceHash);
  if (!normalizedHash) {
    return;
  }
  const existingTimeout = sourceSaveResetTimeoutByHash.get(normalizedHash);
  if (existingTimeout) {
    window.clearTimeout(existingTimeout);
  }
  const timeoutId = window.setTimeout(() => {
    sourceSaveResetTimeoutByHash.delete(normalizedHash);
    if (getSourceSaveState(normalizedHash) === "error") {
      setSourceSaveState(normalizedHash, "idle");
    }
  }, Math.max(800, Number(delayMs) || 2200));
  sourceSaveResetTimeoutByHash.set(normalizedHash, timeoutId);
}

function parseSourceOptionVerticalResolution(option = {}) {
  const labelMatch = String(option?.qualityLabel || "")
    .toLowerCase()
    .match(/(\d{3,4})p/);
  if (labelMatch) {
    const parsed = Number(labelMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  const text = [
    option?.filename,
    option?.primary,
    option?.title,
    option?.name,
    option?.qualityLabel,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!text) {
    return 0;
  }
  if (/\b(2160p|4k|uhd)\b/.test(text)) return 2160;
  if (/\b1080p\b/.test(text)) return 1080;
  if (/\b720p\b/.test(text)) return 720;
  if (/\b480p\b/.test(text)) return 480;
  return 0;
}

function getDetectedSourceOptionLanguages(option = {}) {
  const text = ` ${[
    option?.filename,
    option?.primary,
    option?.title,
    option?.name,
    option?.provider,
    option?.releaseGroup,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")} `;

  const matched = new Set();
  if (!text.trim()) {
    return matched;
  }

  Object.entries(SOURCE_LANGUAGE_TOKENS).forEach(([lang, tokens]) => {
    if (
      tokens.some((token) => {
        const normalizedToken = String(token || "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim()
          .replace(/\s+/g, " ");
        if (!normalizedToken) {
          return false;
        }
        return text.includes(` ${normalizedToken} `);
      })
    ) {
      matched.add(lang);
    }
  });

  return matched;
}

function scoreSourceOptionLanguageForDefault(
  option = {},
  preferredLanguage = preferredSourceLanguage,
) {
  const normalizedPreferred = normalizeSourceLanguage(preferredLanguage);
  if (normalizedPreferred === "any") {
    return 0;
  }

  const detected = getDetectedSourceOptionLanguages(option);
  if (detected.has(normalizedPreferred)) {
    return detected.size === 1 ? 4 : 2;
  }
  if (detected.size === 0 && normalizedPreferred === "en") {
    return 1;
  }
  return -5;
}

function compareSourceOptionsForDefault(left = {}, right = {}) {
  const leftLangScore = scoreSourceOptionLanguageForDefault(left);
  const rightLangScore = scoreSourceOptionLanguageForDefault(right);
  if (leftLangScore !== rightLangScore) {
    return rightLangScore - leftLangScore;
  }

  const leftResolution = parseSourceOptionVerticalResolution(left);
  const rightResolution = parseSourceOptionVerticalResolution(right);
  if (leftResolution !== rightResolution) {
    return rightResolution - leftResolution;
  }

  const leftSeeders = Number.isFinite(Number(left?.seeders))
    ? Math.max(0, Math.floor(Number(left.seeders)))
    : 0;
  const rightSeeders = Number.isFinite(Number(right?.seeders))
    ? Math.max(0, Math.floor(Number(right.seeders)))
    : 0;
  if (leftSeeders !== rightSeeders) {
    return rightSeeders - leftSeeders;
  }

  return getSourceDisplayName(left).localeCompare(
    getSourceDisplayName(right),
    undefined,
    { sensitivity: "base" },
  );
}

function getSourceListPreferredContainer() {
  if (preferredContainer) {
    return preferredContainer;
  }
  if (preferredSourceFormats.length === 1) {
    return preferredSourceFormats[0];
  }
  return "";
}

function getDefaultSourceContainerPreference() {
  const explicitPreference = getSourceListPreferredContainer();
  if (explicitPreference) {
    return explicitPreference;
  }
  return supportedSourceFormatSet.has("mp4") ? "mp4" : "";
}

function getPreferredDefaultSourceHash(options = []) {
  const preferredContainerOption =
    [...options]
      .filter((option) =>
        isSourceOptionLikelyContainer(
          option,
          getDefaultSourceContainerPreference(),
        ),
      )
      .sort(compareSourceOptionsForDefault)[0] || null;
  const defaultOption = preferredContainerOption || options[0] || null;
  return normalizeSourceHash(
    defaultOption?.sourceHash || defaultOption?.infoHash || "",
  );
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

function syncSourcePanelVisibility() {
  const sourceTabVisible = isTmdbResolvedPlayback;
  if (!sourceTabVisible && activeAudioTab === "sources") {
    activeAudioTab = "subtitles";
  }

  if (audioTabSources) {
    const isSourcesActive = activeAudioTab === "sources" && sourceTabVisible;
    audioTabSources.hidden = !sourceTabVisible;
    audioTabSources.disabled = !sourceTabVisible;
    audioTabSources.classList.toggle("is-active", isSourcesActive);
    audioTabSources.setAttribute(
      "aria-selected",
      isSourcesActive ? "true" : "false",
    );
    audioTabSources.tabIndex = isSourcesActive ? 0 : -1;
  }

  if (audioTabSubtitles) {
    const isSubtitlesActive =
      activeAudioTab === "subtitles" || !sourceTabVisible;
    audioTabSubtitles.classList.toggle("is-active", isSubtitlesActive);
    audioTabSubtitles.setAttribute(
      "aria-selected",
      isSubtitlesActive ? "true" : "false",
    );
    audioTabSubtitles.tabIndex = isSubtitlesActive ? 0 : -1;
  }

  if (subtitlePanel) {
    subtitlePanel.hidden = activeAudioTab !== "subtitles" && sourceTabVisible;
  }

  if (sourcePanel) {
    sourcePanel.hidden = !sourceTabVisible || activeAudioTab !== "sources";
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
    emptyState.textContent = "No alternate sources available yet.";
    sourceOptionsContainer.appendChild(emptyState);
    if (sourceOptionDetails) {
      sourceOptionDetails.hidden = true;
      sourceOptionDetails.textContent = "";
    }
    return;
  }

  const seenHashes = new Set();
  const displayedSources = [];
  const fragment = document.createDocumentFragment();
  const rankedSources = sortSourcesBySeeders(availablePlaybackSources, {
    preferContainer: getSourceListPreferredContainer(),
  });
  for (const option of rankedSources) {
    if (seenHashes.size >= preferredSourceResultsLimit) {
      break;
    }
    const sourceHash = normalizeSourceHash(
      option?.sourceHash || option?.infoHash || "",
    );
    if (!sourceHash || seenHashes.has(sourceHash)) {
      continue;
    }
    seenHashes.add(sourceHash);

    const sourceOptionRow = document.createElement("div");
    sourceOptionRow.className = "source-option-row";

    const sourceOptionButton = document.createElement("button");
    sourceOptionButton.className = "audio-option source-option";
    sourceOptionButton.type = "button";
    sourceOptionButton.setAttribute("role", "option");
    sourceOptionButton.dataset.sourceHash = sourceHash;
    sourceOptionButton.setAttribute(
      "aria-selected",
      sourceHash === selectedSourceHash ? "true" : "false",
    );

    const nameLine = document.createElement("span");
    nameLine.className = "source-option-name";
    nameLine.textContent = getSourceDisplayName(option);

    const hintText = getSourceDisplayHint(option);
    const metaText = getSourceDisplayMeta(option);

    if (hintText) {
      const hintLine = document.createElement("span");
      hintLine.className = "source-option-hint";
      hintLine.textContent = hintText;
      sourceOptionButton.appendChild(hintLine);
    }

    if (metaText) {
      const metaLine = document.createElement("span");
      metaLine.className = "source-option-meta";
      metaLine.textContent = metaText;
      sourceOptionButton.appendChild(metaLine);
    }

    sourceOptionButton.prepend(nameLine);
    sourceOptionRow.appendChild(sourceOptionButton);

    const sourceSaveButton = document.createElement("button");
    sourceSaveButton.className = "source-save-button";
    sourceSaveButton.type = "button";
    sourceSaveButton.dataset.sourceHash = sourceHash;
    sourceSaveButton.setAttribute(
      "aria-label",
      `Save ${getSourceDisplayName(option)} to gallery`,
    );
    applySourceSaveButtonState(sourceSaveButton, getSourceSaveState(sourceHash));
    sourceOptionRow.appendChild(sourceSaveButton);

    fragment.appendChild(sourceOptionRow);
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
    (!sourceSelectionPinned || !hasSelectedInOptions)
  ) {
    selectedSourceHash = preferredDefaultSourceHash;
    applyPreferredSourceAudioSync(selectedSourceHash);
    persistSourceHashInUrl();
  }

  syncSourceSelectionState();
  renderSelectedSourceDetails();
}

function parseHlsMasterSource(source) {
  if (!source) {
    return null;
  }

  try {
    const url = new URL(source, window.location.origin);
    if (url.pathname !== "/api/hls/master.m3u8") {
      return null;
    }
    const input = url.searchParams.get("input");
    if (!input) {
      return null;
    }

    const rawAudio = Number(url.searchParams.get("audioStream") || -1);
    const rawSubtitle = Number(url.searchParams.get("subtitleStream") || -1);
    return {
      input,
      audioStreamIndex: Number.isFinite(rawAudio) ? rawAudio : -1,
      subtitleStreamIndex: Number.isFinite(rawSubtitle) ? rawSubtitle : -1,
    };
  } catch {
    return null;
  }
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

function buildHlsPlaybackUrl(
  input,
  audioStreamIndex = -1,
  subtitleStreamIndex = -1,
) {
  const query = new URLSearchParams({ input: String(input || "") });
  if (Number.isFinite(audioStreamIndex) && audioStreamIndex >= 0) {
    query.set("audioStream", String(Math.floor(audioStreamIndex)));
  }
  if (shouldMapSubtitleStreamIndex(subtitleStreamIndex)) {
    query.set("subtitleStream", String(Math.floor(subtitleStreamIndex)));
  }
  return `/api/hls/master.m3u8?${query.toString()}`;
}

function extractPlaybackSourceInput(source) {
  if (!source) {
    return "";
  }
  const transcodeMeta = parseTranscodeSource(source);
  if (transcodeMeta?.input) {
    return transcodeMeta.input;
  }
  const hlsMeta = parseHlsMasterSource(source);
  if (hlsMeta?.input) {
    return hlsMeta.input;
  }
  return String(source || "").trim();
}

function shouldPreferBrowserHlsPlayback(
  source,
  subtitleStreamIndex = selectedSubtitleStreamIndex,
) {
  if (!window.Hls?.isSupported?.()) {
    return false;
  }
  const sourceInput = extractPlaybackSourceInput(source).toLowerCase();
  if (
    !sourceInput ||
    ![".mkv", ".mk3d", ".webm", ".avi", ".wmv", ".ts"].some((needle) =>
      sourceInput.includes(needle),
    )
  ) {
    return false;
  }
  const selectedSubtitleTrack = getSubtitleTrackByStreamIndex(subtitleStreamIndex);
  if (shouldUseNativeEmbeddedSubtitleTrack(selectedSubtitleTrack)) {
    return false;
  }

  const normalizedText = sourceInput
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (!normalizedText) {
    return false;
  }

  if (/\b(remux|bdremux|bluray remux|bdrip x264|bluray x264|avc)\b/.test(normalizedText)) {
    return false;
  }

  return /\b(hevc|x265|h265|10bit|hdr|dolby vision|dv)\b/.test(normalizedText);
}

function buildPreferredBrowserPlaybackSource(
  source,
  sourceInput = "",
  audioStreamIndex = selectedAudioStreamIndex,
  subtitleStreamIndex = selectedSubtitleStreamIndex,
) {
  const normalizedSource = String(source || "").trim();
  if (!normalizedSource) {
    return "";
  }
  const normalizedSourceInput = String(
    sourceInput || extractPlaybackSourceInput(normalizedSource),
  ).trim();
  if (
    !normalizedSourceInput ||
    !shouldPreferBrowserHlsPlayback(normalizedSourceInput, subtitleStreamIndex)
  ) {
    return normalizedSource;
  }
  return buildHlsPlaybackUrl(normalizedSourceInput, audioStreamIndex, -1);
}

function destroyHlsInstance() {
  if (!hlsInstance) {
    return;
  }

  try {
    hlsInstance.destroy();
  } catch {
    // Ignore HLS teardown errors.
  }
  hlsInstance = null;
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
  const hasTrack = Boolean(track);
  if (!hasTrack || track.isExternal || !track.isTextBased) {
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
  if (!isTmdbMoviePlayback || !tmdbId) {
    return;
  }

  const payload = { tmdbId };
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
  } else {
    ["auto", "en", "fr", "es", "de"].forEach((lang) => {
      const button = document.createElement("button");
      button.className = "audio-option";
      button.type = "button";
      button.setAttribute("role", "option");
      button.dataset.lang = lang;
      button.dataset.optionType = "audio-lang";
      button.textContent = getLanguageDisplayLabel(lang);
      button.setAttribute(
        "aria-selected",
        lang === preferredAudioLang ? "true" : "false",
      );
      audioOptionsContainer.appendChild(button);
    });
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
}

function shouldUseSoftwareDecode(source) {
  const value = String(source || "").toLowerCase();
  return (
    value.includes(".mkv") ||
    value.includes(".avi") ||
    value.includes(".wmv") ||
    value.includes(".ts") ||
    value.includes(".m3u8")
  );
}

const browserSafeAudioCodecSet = new Set([
  "aac",
  "mp3",
  "mp2",
  "opus",
  "vorbis",
  "flac",
  "alac",
]);
const browserUnsafeAudioCodecPrefixes = [
  "ac3",
  "eac3",
  "dts",
  "dca",
  "truehd",
  "mlp",
  "pcm_",
  "wma",
];

function isBrowserSafeAudioCodec(codec) {
  const normalized = String(codec || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return false;
  }
  if (browserSafeAudioCodecSet.has(normalized)) {
    return true;
  }
  return !browserUnsafeAudioCodecPrefixes.some((prefix) =>
    normalized.startsWith(prefix),
  );
}

function getDefaultEmbeddedAudioTrack() {
  return (
    availableAudioTracks.find((track) => Boolean(track?.isDefault)) ||
    availableAudioTracks[0] ||
    null
  );
}

function getSelectedEmbeddedAudioTrack() {
  if (selectedAudioStreamIndex >= 0) {
    return (
      availableAudioTracks.find(
        (track) => Number(track?.streamIndex) === selectedAudioStreamIndex,
      ) || null
    );
  }
  return getDefaultEmbeddedAudioTrack();
}

function shouldForceRemuxForEmbeddedAudio() {
  const selectedTrack = getSelectedEmbeddedAudioTrack();
  if (!selectedTrack) {
    return false;
  }

  if (!isBrowserSafeAudioCodec(selectedTrack.codec)) {
    return true;
  }

  const defaultTrack = getDefaultEmbeddedAudioTrack();
  if (!defaultTrack) {
    return false;
  }

  return Number(selectedTrack.streamIndex) !== Number(defaultTrack.streamIndex);
}

function withPreferredAudioSyncForRemuxSource(
  source,
  audioSyncMs = preferredAudioSyncMs,
  remuxVideoMode = preferredRemuxVideoMode,
) {
  try {
    const url = new URL(source, window.location.origin);
    if (url.pathname !== "/api/remux") {
      return source;
    }
    const normalizedSync = normalizeAudioSyncMs(audioSyncMs);
    if (normalizedSync === 0) {
      url.searchParams.delete("audioSyncMs");
    } else {
      url.searchParams.set("audioSyncMs", String(normalizedSync));
    }
    const normalizedSourceHash = normalizeSourceHash(selectedSourceHash);
    if (normalizedSourceHash) {
      url.searchParams.set("sourceHash", normalizedSourceHash);
    } else {
      url.searchParams.delete("sourceHash");
    }
    url.searchParams.set("videoMode", normalizeRemuxVideoMode(remuxVideoMode));
    return `${url.pathname}?${url.searchParams.toString()}`;
  } catch {
    return source;
  }
}

function buildSoftwareDecodeUrl(
  source,
  startSeconds = 0,
  audioStreamIndex = -1,
  audioSyncMs = preferredAudioSyncMs,
  subtitleStreamIndex = selectedSubtitleStreamIndex,
  sourceHash = selectedSourceHash,
  remuxVideoMode = preferredRemuxVideoMode,
) {
  const params = new URLSearchParams({ input: String(source || "") });
  if (Number.isFinite(startSeconds) && startSeconds > 0) {
    params.set("start", String(Math.floor(startSeconds)));
  }
  if (Number.isFinite(audioStreamIndex) && audioStreamIndex >= 0) {
    params.set("audioStream", String(Math.floor(audioStreamIndex)));
  }
  if (shouldMapSubtitleStreamIndex(subtitleStreamIndex)) {
    params.set("subtitleStream", String(Math.floor(subtitleStreamIndex)));
  }
  const normalizedSync = normalizeAudioSyncMs(audioSyncMs);
  if (normalizedSync !== 0) {
    params.set("audioSyncMs", String(normalizedSync));
  }
  const normalizedSourceHash = normalizeSourceHash(sourceHash);
  if (normalizedSourceHash) {
    params.set("sourceHash", normalizedSourceHash);
  }
  params.set("videoMode", normalizeRemuxVideoMode(remuxVideoMode));
  return `/api/remux?${params.toString()}`;
}

function parseTranscodeSource(source) {
  if (!source) {
    return null;
  }

  try {
    const url = new URL(source, window.location.origin);
    if (url.pathname !== "/api/remux") {
      return null;
    }

    const input = url.searchParams.get("input");
    if (!input) {
      return null;
    }

    const rawStart = Number(url.searchParams.get("start") || 0);
    const startSeconds =
      Number.isFinite(rawStart) && rawStart > 0 ? rawStart : 0;
    const rawAudioStreamIndex = Number(
      url.searchParams.get("audioStream") || -1,
    );
    const audioStreamIndex =
      Number.isFinite(rawAudioStreamIndex) && rawAudioStreamIndex >= 0
        ? Math.floor(rawAudioStreamIndex)
        : -1;
    const rawSubtitleStreamIndex = Number(
      url.searchParams.get("subtitleStream") || -1,
    );
    const subtitleStreamIndex =
      Number.isFinite(rawSubtitleStreamIndex) && rawSubtitleStreamIndex >= 0
        ? Math.floor(rawSubtitleStreamIndex)
        : -1;
    const rawAudioSyncMs = Number(url.searchParams.get("audioSyncMs") || 0);
    const audioSyncMs = normalizeAudioSyncMs(rawAudioSyncMs);
    const sourceHash = normalizeSourceHash(
      url.searchParams.get("sourceHash") || "",
    );
    const remuxVideoMode = normalizeRemuxVideoMode(
      url.searchParams.get("videoMode") || "auto",
    );
    return {
      input,
      startSeconds,
      audioStreamIndex,
      subtitleStreamIndex,
      audioSyncMs,
      sourceHash,
      remuxVideoMode,
    };
  } catch {
    return null;
  }
}

function isTranscodeSourceActive() {
  return Boolean(activeTranscodeInput);
}

function getEffectiveCurrentTime() {
  if (isTranscodeSourceActive()) {
    return transcodeBaseOffsetSeconds + (Number(video.currentTime) || 0);
  }
  return Number(video.currentTime) || 0;
}

function setVideoSource(nextSource) {
  if (!nextSource) {
    return;
  }
  const sourceWithAudioSync = withPreferredAudioSyncForRemuxSource(
    nextSource,
    preferredAudioSyncMs,
  );

  clearStreamStallRecovery();
  destroyHlsInstance();
  clearSubtitleTrack();

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
  const absoluteSource = new URL(
    sourceWithAudioSync,
    window.location.origin,
  ).toString();
  if (playbackBenchmark) {
    playbackBenchmark._recordSourceChange(absoluteSource);
  }
  const isHlsSource = absoluteSource.includes("/api/hls/master.m3u8");
  if (isHlsSource && window.Hls?.isSupported?.()) {
    const hlsSourceMeta = parseHlsMasterSource(sourceWithAudioSync);
    hlsInstance = new window.Hls({
      enableWorker: true,
      lowLatencyMode: false,
    });
    hlsInstance.loadSource(absoluteSource);
    hlsInstance.attachMedia(video);
    hlsInstance.on(window.Hls.Events.ERROR, (_, event) => {
      if (!event?.fatal) {
        if (event?.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
          try {
            hlsInstance?.startLoad();
          } catch {
            // Ignore HLS restart errors.
          }
          scheduleStreamStallRecovery(
            "Network stalled, trying another source...",
          );
        } else if (event?.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
          try {
            hlsInstance?.recoverMediaError();
          } catch {
            // Ignore HLS media recovery errors.
          }
        }
        return;
      }
      try {
        hlsInstance?.destroy();
      } catch {
        // Ignore HLS teardown errors.
      }
      hlsInstance = null;

      // Native playback of m3u8 is unreliable in Chromium; fallback to server remux.
      if (hlsSourceMeta?.input) {
        const resumeAt = Math.max(0, Math.floor(getEffectiveCurrentTime()));
        const remuxFallback = buildSoftwareDecodeUrl(
          hlsSourceMeta.input,
          resumeAt,
          hlsSourceMeta.audioStreamIndex,
          preferredAudioSyncMs,
          hlsSourceMeta.subtitleStreamIndex,
        );
        video.setAttribute(
          "src",
          new URL(remuxFallback, window.location.origin).toString(),
        );
      } else {
        video.setAttribute("src", absoluteSource);
      }
      video.load();
      void tryPlay();
      scheduleStreamStallRecovery("Stream stalled, trying another source...");
    });
    return;
  }

  if (isHlsSource) {
    const hlsMeta = parseHlsMasterSource(sourceWithAudioSync);
    if (hlsMeta?.input) {
      const remuxFallback = buildSoftwareDecodeUrl(
        hlsMeta.input,
        0,
        hlsMeta.audioStreamIndex,
        preferredAudioSyncMs,
        hlsMeta.subtitleStreamIndex,
      );
      video.setAttribute(
        "src",
        new URL(remuxFallback, window.location.origin).toString(),
      );
      video.load();
      scheduleStreamStallRecovery("Stream stalled, trying another source...");
      return;
    }
  }

  video.setAttribute("src", absoluteSource);
  video.load();
  scheduleStreamStallRecovery("Stream stalled, trying another source...");
}

function shouldAttemptNativePlayback(source) {
  if (preferredNativePlaybackMode === "off" || nativePlaybackLaunched) {
    return false;
  }
  try {
    const url = new URL(String(source || ""), window.location.origin);
    return url.pathname === "/api/remux";
  } catch {
    return false;
  }
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

function tearDownBrowserPlaybackForNative() {
  clearStreamStallRecovery();
  destroyHlsInstance();
  clearSubtitleTrack();
  try {
    video.pause();
  } catch {
    // Ignore pause errors.
  }
  video.removeAttribute("src");
  video.load();
}

async function tryLaunchNativePlayback(source, startSeconds = 0) {
  if (!shouldAttemptNativePlayback(source)) {
    return false;
  }
  const sourceUrl = withPreferredAudioSyncForRemuxSource(
    source,
    preferredAudioSyncMs,
  );
  const safeStartSeconds =
    Number.isFinite(startSeconds) && startSeconds > 0
      ? Math.floor(startSeconds)
      : 0;
  const payload = {
    sourceUrl,
    subtitleUrl: getActiveSubtitleVttUrl(),
    title,
    episode,
    startSeconds: safeStartSeconds,
    audioSyncMs: preferredAudioSyncMs,
    sourceHash: selectedSourceHash,
  };
  try {
    const response = await requestJson(
      "/api/native/play",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      12000,
    );
    if (!response?.launched) {
      return false;
    }

    nativePlaybackLaunched = true;
    tearDownBrowserPlaybackForNative();
    if (!hasExplicitSource) {
      showResolver("Playing in mpv (native player).", { showStatus: true });
    }
    return true;
  } catch {
    return false;
  }
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

async function tryNextTmdbSource() {
  if (
    !isTmdbResolvedPlayback ||
    tmdbSourceAttemptIndex >= tmdbSourceQueue.length
  ) {
    return false;
  }

  const nextSource = tmdbSourceQueue[tmdbSourceAttemptIndex];
  tmdbSourceAttemptIndex += 1;
  showResolver(
    `Trying alternate source (${tmdbSourceAttemptIndex}/${tmdbSourceQueue.length})...`,
  );
  setVideoSource(nextSource);
  await tryPlay();
  return true;
}

function buildNativePlaybackFallbackSource() {
  const sourceInput = String(
    activeTrackSourceInput ||
      activeTranscodeInput ||
      extractPlaybackSourceInput(video.currentSrc || video.getAttribute("src") || ""),
  ).trim();
  if (!sourceInput) {
    return "";
  }

  return buildSoftwareDecodeUrl(
    sourceInput,
    0,
    selectedAudioStreamIndex,
    activeAudioSyncMs || preferredAudioSyncMs,
    selectedSubtitleStreamIndex,
    selectedSourceHash,
  );
}

function applyStoredSubtitleSelectionPreference() {
  if (hasSubtitleLangParam) {
    return;
  }

  if (!(isTmdbMoviePlayback || isExplicitLocalUploadSource)) {
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

async function resolveTmdbSourcesAndPlay({
  allowContainerFallback = true,
  allowSourceFallback = true,
  requiredSourceHash = "",
} = {}) {
  if (!availablePlaybackSources.length) {
    void fetchTmdbSourceOptionsViaBackend();
  }

  const normalizedRequiredSourceHash = normalizeSourceHash(requiredSourceHash);
  const resolved = isTmdbTvPlayback
    ? await resolveTmdbTvEpisodeViaBackend(
        tmdbId,
        seasonNumber,
        episodeNumber,
        {
          allowContainerFallback,
          allowSourceFallback,
        },
      )
    : await resolveTmdbMovieViaBackend(tmdbId, {
        allowSourceFallback,
      });
  const resolvedSourceHash = normalizeSourceHash(
    resolved?.sourceHash || selectedSourceHash,
  );
  if (
    normalizedRequiredSourceHash &&
    resolvedSourceHash !== normalizedRequiredSourceHash
  ) {
    throw new Error(
      "Selected source is unavailable right now. Try another source.",
    );
  }
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
  selectedSourceHash = resolvedSourceHash;
  applyPreferredSourceAudioSync(selectedSourceHash);
  persistSourceHashInUrl();

  if (resolvedTrackPreferenceAudio && resolvedTrackPreferenceAudio !== "auto") {
    preferredAudioLang = resolvedTrackPreferenceAudio;
    persistAudioLangPreference(preferredAudioLang);
  }
  const subtitleStreamPreferenceBeforeResolve =
    getStoredSubtitleStreamPreferenceForTmdbMovie(tmdbId);
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
  setTmdbSourceQueue(
    preferredBrowserSource,
    preferredBrowserSource &&
      preferredBrowserSource !== nativePreferredSource
      ? [nativePreferredSource, ...(resolved?.fallbackUrls || [])]
      : resolved.fallbackUrls,
  );
  void queueGallerySaveIfRequested(resolved);
  const preferredSource =
    tmdbSourceQueue[0] || preferredBrowserSource || nativePreferredSource;
  setVideoSource(preferredSource);
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
  return { nativeLaunched: false, resolved };
}

function attemptTmdbRecovery(message) {
  if (!isTmdbResolvedPlayback || isRecoveringTmdbStream) {
    return false;
  }

  isRecoveringTmdbStream = true;
  showResolver(message);

  if (tmdbSourceAttemptIndex < tmdbSourceQueue.length) {
    void tryNextTmdbSource().finally(() => {
      isRecoveringTmdbStream = false;
    });
    return true;
  }

  if (tmdbResolveRetries < maxTmdbResolveRetries) {
    tmdbResolveRetries += 1;
    showResolver(
      `Refreshing source (${tmdbResolveRetries}/${maxTmdbResolveRetries})...`,
    );
    void resolveTmdbSourcesAndPlay()
      .catch((error) => {
        console.error("Failed to refresh TMDB playback source:", error);
        const fallbackMessage =
          error?.message || "Resolved stream could not be played. Try again.";
        showResolver(fallbackMessage, { isError: true });
      })
      .finally(() => {
        isRecoveringTmdbStream = false;
      });
    return true;
  }

  const nativeFallbackSource = buildNativePlaybackFallbackSource();
  if (nativeFallbackSource) {
    const resumeFrom = getEffectiveCurrentTime();
    showResolver("Browser playback failed, trying mpv fallback...");
    void tryLaunchNativePlayback(nativeFallbackSource, resumeFrom)
      .then((launched) => {
        if (!launched) {
          showResolver("Resolved stream could not be played. Try again.", {
            isError: true,
          });
        }
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
  const formattedEpisode = String(currentEpisode || "").trim();
  episodeLabel.textContent = "";

  const strong = document.createElement("b");
  strong.textContent = currentTitle;
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

function shouldHideSeriesEpisodePrefix(seriesEntry = activeSeries) {
  const seriesTitle = String(seriesEntry?.title || "").trim();
  const seriesId = String(seriesEntry?.id || "").trim();
  const contentKind = String(
    seriesEntry?.contentKind || seriesEntry?.episodes?.[0]?.contentKind || "",
  )
    .trim()
    .toLowerCase();
  const firstEpisodeTitle = String(seriesEntry?.episodes?.[0]?.title || "").trim();
  return (
    contentKind === "course" ||
    /\bcourse\b/i.test(seriesTitle) ||
    /\bcourse\b/i.test(seriesId) ||
    /\b(webinar|lesson|module|class)\b/i.test(firstEpisodeTitle)
  );
}

function normalizeCourseEpisodeDisplayTitle(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  return raw
    .replace(/^webinar-\s*electrics\s*webinar\s*(\d+)\s*-\s*/i, "Webinar $1 - ")
    .replace(/\s+by\s+access\s+training\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getSeriesEpisodeLabel(
  index,
  episodeTitle,
  seriesEntry = activeSeries,
  episodeNumber = index + 1,
) {
  const safeEpisodeNumber =
    Number.isFinite(Number(episodeNumber)) && Number(episodeNumber) > 0
      ? Math.floor(Number(episodeNumber))
      : index + 1;
  const safeTitle = String(episodeTitle || "").trim();
  const isCourseEntry = shouldHideSeriesEpisodePrefix(seriesEntry);
  if (isCourseEntry) {
    const normalizedCourseTitle = normalizeCourseEpisodeDisplayTitle(safeTitle);
    return normalizedCourseTitle || `Lesson ${safeEpisodeNumber}`;
  }
  return safeTitle
    ? `E${safeEpisodeNumber} ${safeTitle}`
    : `E${safeEpisodeNumber}`;
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

function buildSeriesEpisodeIdentityKey(season, episode) {
  return `s${Math.max(1, Math.floor(Number(season) || 1))}e${Math.max(1, Math.floor(Number(episode) || 1))}`;
}

function isFallbackEpisodeThumbnail(thumbValue) {
  const normalized = String(thumbValue || "").trim();
  return !normalized || normalized === DEFAULT_EPISODE_THUMBNAIL;
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
  if (!isSeriesPlayback || !activeSeries || !seriesEpisodes.length) {
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
  if (!isSeriesPlayback || !activeSeries || !seriesEpisodes.length) {
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
    window.setTimeout(() => {
      hideResolver();
    }, 2200);
    closeEpisodesPopover();
    return;
  }

  persistResumeTime(true);

  const nextParams = new URLSearchParams(window.location.search);
  nextParams.set("seriesId", activeSeries.id);
  nextParams.set("episodeIndex", String(safeIndex));
  nextParams.set("title", String(activeSeries.title || title || "Title"));
  nextParams.set(
    "episode",
    getSeriesEpisodeLabel(safeIndex, targetEpisode.title),
  );
  nextParams.delete("src");
  nextParams.set("mediaType", "tv");
  if (activeSeries.tmdbId) {
    nextParams.set("tmdbId", String(activeSeries.tmdbId));
  } else {
    nextParams.delete("tmdbId");
  }
  if (activeSeries.year) {
    nextParams.set("year", String(activeSeries.year));
  } else {
    nextParams.delete("year");
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
  } else {
    nextParams.delete("preferredContainer");
  }
  nextParams.delete("sourceHash");

  const nextQuery = nextParams.toString();
  const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`;
  window.location.href = nextUrl;
}

function renderSeriesEpisodePreview() {
  if (!episodesList) {
    return;
  }

  episodesList.innerHTML = "";
  if (!hasSeriesEpisodeControls || !activeSeries) {
    return;
  }

  if (episodesPopoverTitle) {
    episodesPopoverTitle.textContent = activeSeries.title;
  }

  seriesEpisodes.forEach((episodeEntry, index) => {
    const isPlayable = isSeriesEpisodePlayable(episodeEntry);
    const item = document.createElement("button");
    item.type = "button";
    item.className = "episode-preview-item";
    if (!isPlayable) {
      item.classList.add("is-unavailable");
      item.disabled = true;
    }
    item.dataset.episodeIndex = String(index);
    item.setAttribute("role", "listitem");
    item.setAttribute(
      "aria-label",
      isPlayable
        ? `Episode ${index + 1}: ${episodeEntry.title}`
        : `Episode ${index + 1}: ${episodeEntry.title} (Unavailable)`,
    );
    if (index === seriesEpisodeIndex) {
      item.classList.add("is-active");
      item.setAttribute("aria-current", "true");
    }

    const number = document.createElement("p");
    number.className = "episode-preview-number";
    number.textContent = String(index + 1);

    const main = document.createElement("div");
    main.className = "episode-preview-main";

    const heading = document.createElement("p");
    heading.className = "episode-preview-title";
    heading.textContent = isPlayable
      ? episodeEntry.title
      : `${episodeEntry.title} (Unavailable)`;
    main.appendChild(heading);

    const thumb = document.createElement("img");
    thumb.className = "episode-preview-thumb";
    thumb.src = String(episodeEntry.thumb || DEFAULT_EPISODE_THUMBNAIL);
    thumb.alt = `Episode ${index + 1} preview`;
    thumb.loading = "lazy";
    main.appendChild(thumb);

    const description = document.createElement("p");
    description.className = "episode-preview-desc";
    description.textContent = isPlayable
      ? String(episodeEntry.description || "")
      : "Unavailable until MP4 source is added.";

    item.append(number, main, description);
    episodesList.appendChild(item);
  });
}

function openEpisodesPopover() {
  if (!episodesControl || !hasSeriesEpisodeControls || isResolvingSource()) {
    return;
  }

  closeSpeedPopover(false);
  closeAudioPopover();
  window.clearTimeout(episodesPopoverCloseTimeout);
  episodesControl.classList.add("is-open");
  toggleEpisodes?.setAttribute("aria-expanded", "true");
}

function closeEpisodesPopover(withDelay = false) {
  if (!episodesControl) {
    return;
  }

  window.clearTimeout(episodesPopoverCloseTimeout);

  const close = () => {
    if (episodesControl.matches(":hover, :focus-within")) {
      return;
    }
    episodesControl.classList.remove("is-open");
    toggleEpisodes?.setAttribute("aria-expanded", "false");
  };

  if (!withDelay) {
    close();
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
    toggleEpisodes.setAttribute(
      "aria-label",
      `Episodes (${seriesEpisodeIndex + 1} of ${seriesEpisodes.length})`,
    );
  }
}

setEpisodeLabel(title, episode);
renderSeriesEpisodePreview();
syncSeriesControls();
void hydrateSeriesEpisodeThumbnails();

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
  volumeSlider.style.setProperty("--volume-percent", `${volumePercent}%`);
}

function syncMuteState() {
  const muted = video.muted || video.volume === 0;
  toggleMutePlayer.classList.toggle("muted", muted);
  toggleMutePlayer.setAttribute("aria-label", muted ? "Unmute" : "Mute");
  syncVolumeSliderState();
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

function syncAudioState() {
  const selectedAudioTrack = getSelectedEmbeddedAudioTrack();
  const selectedAudioLabel = selectedAudioTrack
    ? getAudioTrackDisplayLabel(selectedAudioTrack)
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
    const shouldShowBadge = availableAudioTracks.length > 1;
    audioStatusBadge.hidden = !shouldShowBadge;
    audioStatusBadge.textContent = shouldShowBadge
      ? getAudioTrackBadgeLabel(selectedAudioTrack)
      : "";
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
}

function getCurrentAudioSyncSourceHash() {
  return normalizeSourceHash(selectedSourceHash || "");
}

async function adjustSourceAudioSync(deltaMs = 0) {
  if (
    nativePlaybackLaunched ||
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
  setVideoSource(
    buildSoftwareDecodeUrl(
      activeTranscodeInput,
      0,
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
  if (resumeFrom > 1) {
    seekToAbsoluteTime(resumeFrom);
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
  const displayDuration = getDisplayDurationSeconds();
  if (Number.isFinite(displayDuration) && displayDuration > 0) {
    return displayDuration;
  }
  return getTimelineDurationSeconds();
}

function getBufferedSeekValue(totalDurationSeconds) {
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
  seekBar.style.background = `linear-gradient(to right, var(--ui-accent) 0%, var(--ui-accent) ${playedPercent}%, var(--ui-buffered) ${playedPercent}%, var(--ui-buffered) ${bufferedPercent}%, var(--ui-line) ${bufferedPercent}%, var(--ui-line) 100%)`;
}

function syncDurationText(elapsedSeconds = getEffectiveCurrentTime()) {
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

function openSpeedPopover() {
  if (!speedControl) {
    return;
  }

  closeEpisodesPopover(false);
  window.clearTimeout(speedPopoverCloseTimeout);
  speedControl.classList.add("is-open");
  toggleSpeed.setAttribute("aria-expanded", "true");
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
    toggleSpeed.setAttribute("aria-expanded", "false");
  };

  if (!withDelay) {
    close();
    return;
  }

  speedPopoverCloseTimeout = window.setTimeout(close, 140);
}

function openAudioPopover() {
  if (!audioControl) {
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

  closeEpisodesPopover(false);
  window.clearTimeout(audioPopoverCloseTimeout);
  if (isTmdbResolvedPlayback && !availablePlaybackSources.length) {
    void fetchTmdbSourceOptionsViaBackend();
  }
  syncSourcePanelVisibility();
  audioControl.classList.add("is-open");
  playerShell?.classList.add("audio-popover-open");
  toggleAudio?.setAttribute("aria-expanded", "true");
}

function closeAudioPopover(withDelay = false) {
  if (!audioControl) {
    return;
  }

  window.clearTimeout(audioPopoverCloseTimeout);

  const close = () => {
    if (audioControl.matches(":hover, :focus-within")) {
      return;
    }

    audioControl.classList.remove("is-open");
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
  message = "Stream stalled, trying another source...",
) {
  if (!isTmdbResolvedPlayback || video.paused) {
    return;
  }

  const checkpointTime = getEffectiveCurrentTime();
  clearStreamStallRecovery();

  streamStallRecoveryTimeout = window.setTimeout(() => {
    if (!isTmdbResolvedPlayback || video.paused) {
      return;
    }

    const nowTime = getEffectiveCurrentTime();
    if (nowTime > checkpointTime + 0.8 || video.readyState >= 3) {
      return;
    }

    attemptTmdbRecovery(message);
  }, 8000);
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

function renderSourceOptionsWhenStable() {
  renderSourceOptionButtons();
  syncAudioState();
}

function hideControls() {
  if (video.paused) {
    return;
  }

  closeSpeedPopover(false);
  closeEpisodesPopover(false);
  closeAudioPopover();
  playerShell.classList.add("controls-hidden");
}

function showControls() {
  playerShell.classList.remove("controls-hidden");
}

function scheduleControlsHide() {
  clearControlsHideTimer();
  if (video.paused || isResolvingSource()) {
    return;
  }

  controlsHideTimeout = window.setTimeout(hideControls, controlsHideDelayMs);
}

function handleUserActivity() {
  showControls();
  scheduleControlsHide();
}

function syncSeekState() {
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
}

function persistResumeTime(force = false) {
  const effectiveCurrentTime = Math.max(0, getEffectiveCurrentTime());
  if (!Number.isFinite(effectiveCurrentTime)) {
    return;
  }

  const seekScaleDurationSeconds = getSeekScaleDurationSeconds();
  const isNearEnd =
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
      resumeTime = 0;
      lastPersistedResumeTime = 0;
      lastPersistedResumeAt = 0;
      return;
    }

    if (effectiveCurrentTime < 1) {
      if (force) {
        localStorage.removeItem(resumeStorageKey);
        removeContinueWatchingEntry();
        resumeTime = 0;
        lastPersistedResumeTime = 0;
        lastPersistedResumeAt = 0;
      }
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

    const nextResumeTime = Number(effectiveCurrentTime.toFixed(2));
    localStorage.setItem(resumeStorageKey, String(nextResumeTime));
    persistContinueWatchingEntry(nextResumeTime);
    resumeTime = nextResumeTime;
    lastPersistedResumeTime = nextResumeTime;
    lastPersistedResumeAt = now;
  } catch {
    // Ignore storage access issues.
  }
}

async function tryPlay() {
  if (!hasActiveSource()) {
    return;
  }

  try {
    await video.play();
  } catch (error) {
    syncPlayState();
  }
}

async function togglePlayback() {
  if (!hasActiveSource() || isResolvingSource()) {
    return;
  }

  if (video.paused) {
    await tryPlay();
  } else {
    video.pause();
  }

  syncPlayState();
}

function seekToAbsoluteTime(targetSeconds, { showLoading = false } = {}) {
  const clampedTarget = Math.max(0, Number(targetSeconds) || 0);
  if (showLoading) {
    showSeekLoadingIndicator();
  }
  if (!isTranscodeSourceActive()) {
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
  );
  if (shouldResumePlayback) {
    void tryPlay();
  }
}

async function requestJson(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      controller.abort();
      reject(new Error("Request timed out."));
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      fetch(url, {
        ...options,
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);

    if (response.status === 204) {
      return null;
    }

    const rawText = await response.text();
    let payload = null;

    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = { message: rawText };
      }
    }

    if (!response.ok) {
      const message =
        payload?.error ||
        payload?.message ||
        `Request failed (${response.status})`;
      throw new Error(message);
    }

    return payload;
  } catch (error) {
    if (error.name === "AbortError" || error.message === "Request timed out.") {
      throw new Error("Request timed out.");
    }
    throw error;
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  }
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
  { allowSourceFallback = true } = {},
) {
  const query = new URLSearchParams({
    tmdbId: tmdbMovieId,
    title,
    year,
    audioLang: preferredAudioLang,
    quality: preferredQuality,
  });
  if (preferredSubtitleLang) {
    query.set("subtitleLang", preferredSubtitleLang);
  }
  const pinnedSourceHash = getPinnedSourceHashForRequests();
  if (pinnedSourceHash) {
    query.set("sourceHash", pinnedSourceHash);
  }
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

  try {
    return await requestJson(
      `/api/resolve/movie?${query.toString()}`,
      {},
      95000,
    );
  } catch (error) {
    if (!allowSourceFallback || !pinnedSourceHash) {
      throw error;
    }
    query.delete("sourceHash");
    return requestJson(`/api/resolve/movie?${query.toString()}`, {}, 95000);
  }
}

async function resolveTmdbTvEpisodeViaBackend(
  tmdbSeriesId,
  season,
  episodeOrdinal,
  { allowContainerFallback = true, allowSourceFallback = true } = {},
) {
  const buildQuery = (containerPreference = "", sourceHash = "") => {
    const query = new URLSearchParams({
      tmdbId: tmdbSeriesId,
      title,
      year,
      seasonNumber: String(Math.max(1, Math.floor(Number(season) || 1))),
      episodeNumber: String(
        Math.max(1, Math.floor(Number(episodeOrdinal) || 1)),
      ),
      audioLang: preferredAudioLang,
      quality: preferredQuality,
    });
    if (preferredSubtitleLang) {
      query.set("subtitleLang", preferredSubtitleLang);
    }
    if (containerPreference) {
      query.set("preferredContainer", containerPreference);
    }
    if (sourceHash) {
      query.set("sourceHash", sourceHash);
    }
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
    return query;
  };

  const pinnedSourceHash = getPinnedSourceHashForRequests();
  try {
    return await requestJson(
      `/api/resolve/tv?${buildQuery(preferredContainer, pinnedSourceHash).toString()}`,
      {},
      95000,
    );
  } catch (error) {
    let lastError = error;
    const fallbackAttempts = [];
    const seen = new Set([`${preferredContainer}::${pinnedSourceHash}`]);

    const pushFallback = (containerPreference, sourceHashPreference) => {
      const key = `${containerPreference}::${sourceHashPreference}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      fallbackAttempts.push([containerPreference, sourceHashPreference]);
    };

    if (allowContainerFallback && preferredContainer) {
      pushFallback("", pinnedSourceHash);
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

    for (const [fallbackContainer, fallbackSource] of fallbackAttempts) {
      try {
        return await requestJson(
          `/api/resolve/tv?${buildQuery(fallbackContainer, fallbackSource).toString()}`,
          {},
          95000,
        );
      } catch (fallbackError) {
        lastError = fallbackError;
      }
    }

    throw lastError;
  }
}

async function resolveTmdbSourceForGallerySave(sourceHash = "") {
  const normalizedSourceHash = normalizeSourceHash(sourceHash);
  if (!normalizedSourceHash || !isTmdbResolvedPlayback || !tmdbId) {
    throw new Error("Unable to save this source right now.");
  }

  const query = new URLSearchParams({
    tmdbId,
    title,
    year,
    audioLang: preferredAudioLang,
    quality: preferredQuality,
    sourceHash: normalizedSourceHash,
  });
  if (preferredSubtitleLang) {
    query.set("subtitleLang", preferredSubtitleLang);
  }
  if (isTmdbTvPlayback) {
    query.set("seasonNumber", String(Math.max(1, Math.floor(seasonNumber || 1))));
    query.set(
      "episodeNumber",
      String(Math.max(1, Math.floor(episodeNumber || 1))),
    );
    if (preferredContainer) {
      query.set("preferredContainer", preferredContainer);
    }
  }
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

  const endpoint = isTmdbTvPlayback ? "/api/resolve/tv" : "/api/resolve/movie";
  const resolved = await requestJson(`${endpoint}?${query.toString()}`, {}, 95000);
  const resolvedSourceHash = normalizeSourceHash(resolved?.sourceHash || "");
  if (resolvedSourceHash !== normalizedSourceHash) {
    throw new Error("Selected source is unavailable right now. Try another source.");
  }
  return resolved;
}

async function fetchTmdbSourceOptionsViaBackend() {
  if (!isTmdbResolvedPlayback || !tmdbId) {
    availablePlaybackSources = [];
    renderSourceOptionsWhenStable();
    return;
  }

  const query = new URLSearchParams({
    tmdbId,
    mediaType: isTmdbTvPlayback ? "tv" : "movie",
    title,
    year,
    audioLang: preferredAudioLang,
    quality: preferredQuality,
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

  try {
    const payload = await requestJson(
      `/api/resolve/sources?${query.toString()}`,
      {},
      45000,
    );
    const options = Array.isArray(payload?.sources) ? payload.sources : [];
    availablePlaybackSources = sortSourcesBySeeders(
      options
        .map((item) => ({
          ...item,
          sourceHash: normalizeSourceHash(
            item?.sourceHash || item?.infoHash || "",
          ),
        }))
        .filter((item) => Boolean(item.sourceHash)),
      {
        preferContainer: getSourceListPreferredContainer(),
      },
    );

    if (
      selectedSourceHash &&
      !availablePlaybackSources.some(
        (item) => item.sourceHash === selectedSourceHash,
      )
    ) {
      selectedSourceHash = "";
      sourceSelectionPinned = false;
      applyPreferredSourceAudioSync(selectedSourceHash);
      persistSourceHashInUrl();
    }
    renderSourceOptionsWhenStable();
  } catch {
    availablePlaybackSources = [];
    renderSourceOptionsWhenStable();
  }
}

function persistAudioLangInUrl() {
  const nextParams = new URLSearchParams(window.location.search);
  if (preferredAudioLang === "auto") {
    nextParams.delete("audioLang");
  } else {
    nextParams.set("audioLang", preferredAudioLang);
  }

  const nextQuery = nextParams.toString();
  const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`;
  window.history.replaceState(null, "", nextUrl);
}

function persistQualityInUrl() {
  const nextParams = new URLSearchParams(window.location.search);
  if (preferredQuality === DEFAULT_STREAM_QUALITY_PREFERENCE) {
    nextParams.delete("quality");
  } else {
    nextParams.set("quality", preferredQuality);
  }

  const nextQuery = nextParams.toString();
  const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`;
  window.history.replaceState(null, "", nextUrl);
}

function persistSourceHashInUrl() {
  const nextParams = new URLSearchParams(window.location.search);
  if (sourceSelectionPinned && selectedSourceHash) {
    nextParams.set("sourceHash", selectedSourceHash);
  } else {
    nextParams.delete("sourceHash");
  }

  const nextQuery = nextParams.toString();
  const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`;
  window.history.replaceState(null, "", nextUrl);
}

goBack.addEventListener("click", () => {
  persistResumeTime(true);
  if (isSeriesPlayback) {
    window.location.href = "index.html";
    return;
  }

  if (window.history.length > 1) {
    window.history.back();
    return;
  }

  window.location.href = "index.html";
});

togglePlay.addEventListener("click", togglePlayback);

rewind10.addEventListener("click", () => {
  if (!hasActiveSource() || isResolvingSource()) {
    return;
  }

  seekToAbsoluteTime(getEffectiveCurrentTime() - 10);
});

forward10.addEventListener("click", () => {
  if (!hasActiveSource() || isResolvingSource()) {
    return;
  }

  seekToAbsoluteTime(getEffectiveCurrentTime() + 10);
});

toggleMutePlayer.addEventListener("click", () => {
  if (isResolvingSource()) {
    return;
  }

  togglePlayerMute();
});

volumeSlider?.addEventListener("input", () => {
  if (isResolvingSource()) {
    return;
  }

  setPlayerVolume(Number(volumeSlider.value) / 100);
  showControls();
  clearControlsHideTimer();
});

volumeSlider?.addEventListener("change", () => {
  scheduleControlsHide();
});

volumeControl?.addEventListener("mouseenter", () => {
  showControls();
  clearControlsHideTimer();
});

volumeControl?.addEventListener("mouseleave", () => {
  scheduleControlsHide();
});

volumeControl?.addEventListener("focusin", () => {
  showControls();
  clearControlsHideTimer();
});

volumeControl?.addEventListener("focusout", () => {
  window.setTimeout(() => {
    if (!volumeControl.matches(":hover, :focus-within")) {
      scheduleControlsHide();
    }
  }, 0);
});

async function toggleFullscreenMode() {
  if (!document.fullscreenElement) {
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      // Ignore fullscreen errors in restricted environments.
    }
    return;
  }

  try {
    await document.exitFullscreen();
  } catch {
    // Ignore fullscreen errors in restricted environments.
  }
}

toggleFullscreen.addEventListener("click", async () => {
  await toggleFullscreenMode();
});

nextEpisode?.addEventListener("click", () => {
  if (!hasSeriesEpisodeControls || isResolvingSource()) {
    return;
  }
  navigateToSeriesEpisode(seriesEpisodeIndex + 1);
});

toggleSpeed.addEventListener("click", (event) => {
  event.preventDefault();
  if (!speedControl || isResolvingSource()) {
    return;
  }

  const shouldOpen = !speedControl.classList.contains("is-open");
  if (shouldOpen) {
    openSpeedPopover();
  } else {
    closeSpeedPopover(false);
  }
});

toggleEpisodes?.addEventListener("click", (event) => {
  event.preventDefault();
  if (!episodesControl || isResolvingSource()) {
    return;
  }

  const shouldOpen = !episodesControl.classList.contains("is-open");
  if (shouldOpen) {
    openEpisodesPopover();
  } else {
    closeEpisodesPopover();
  }
});

toggleAudio?.addEventListener("click", (event) => {
  event.preventDefault();
  if (!audioControl || isResolvingSource()) {
    return;
  }

  const shouldOpen = !audioControl.classList.contains("is-open");
  if (shouldOpen) {
    openAudioPopover();
  } else {
    closeAudioPopover();
  }
});

if (speedControl) {
  speedControl.addEventListener("mouseenter", openSpeedPopover);
  speedControl.addEventListener("mouseleave", () => closeSpeedPopover(true));
  speedControl.addEventListener("focusin", openSpeedPopover);
  speedControl.addEventListener("focusout", () => closeSpeedPopover(true));
}

if (episodesControl) {
  episodesControl.addEventListener("mouseenter", openEpisodesPopover);
  episodesControl.addEventListener("mouseleave", () =>
    closeEpisodesPopover(true),
  );
  episodesControl.addEventListener("focusin", openEpisodesPopover);
  episodesControl.addEventListener("focusout", () =>
    closeEpisodesPopover(true),
  );
}

if (audioControl) {
  audioControl.addEventListener("mouseenter", () => {
    if (isResolvingSource()) {
      return;
    }
    openAudioPopover();
  });
  audioControl.addEventListener("mouseleave", () => closeAudioPopover(true));
  audioControl.addEventListener("focusin", () => {
    if (isResolvingSource()) {
      return;
    }
    openAudioPopover();
  });
  audioControl.addEventListener("focusout", (event) => {
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
  option.addEventListener("click", () => {
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
  });
});

episodesList?.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) {
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

audioOptionsContainer?.addEventListener("click", async (event) => {
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
      if (result?.nativeLaunched) {
        return;
      }
      if (resumeFrom > 1) {
        seekToAbsoluteTime(resumeFrom);
      }
    } catch (error) {
      console.error("Failed to switch audio language:", error);
      showResolver(error?.message || "Unable to switch language.", {
        isError: true,
      });
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
  showResolver("Switching audio track...");
  if (shouldUseRemuxForAudioSwitch) {
    setVideoSource(
      buildSoftwareDecodeUrl(
        activeTrackSourceInput,
        0,
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
  if (resumeFrom > 1) {
    seekToAbsoluteTime(resumeFrom);
  }
});

subtitleOptionsContainer?.addEventListener("click", async (event) => {
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

  if (isResolvingSource()) {
    return;
  }

  if (!normalizedNextSourceHash) {
    syncSourceSelectionState();
    renderSelectedSourceDetails();
    return;
  }

  if (normalizedNextSourceHash === selectedSourceHash) {
    syncSourceSelectionState();
    renderSelectedSourceDetails();
    return;
  }

  const previousSourceHash = selectedSourceHash;
  const previousSourceSelectionPinned = sourceSelectionPinned;
  selectedSourceHash = normalizedNextSourceHash;
  sourceSelectionPinned = true;
  applyPreferredSourceAudioSync(selectedSourceHash);
  persistSourceHashInUrl();
  syncAudioState();

  if (!isTmdbResolvedPlayback) {
    return;
  }

  const resumeFrom = getEffectiveCurrentTime();
  const wasPaused = video.paused;
  tmdbResolveRetries = 0;
  showResolver("Switching source...");
  try {
    const result = await resolveTmdbSourcesAndPlay({
      allowSourceFallback: false,
      requiredSourceHash: normalizedNextSourceHash,
    });
    if (result?.nativeLaunched) {
      return;
    }
    if (!wasPaused) {
      await tryPlay();
    }
    if (resumeFrom > 1) {
      seekToAbsoluteTime(resumeFrom);
    }
  } catch (error) {
    selectedSourceHash = previousSourceHash;
    sourceSelectionPinned = previousSourceSelectionPinned;
    applyPreferredSourceAudioSync(selectedSourceHash);
    persistSourceHashInUrl();
    syncAudioState();
    const fallbackMessage = error?.message || "Unable to switch source.";
    showResolver(fallbackMessage, { isError: true });
  }
}

async function handleSourceOptionSaveRequest(nextSourceHash) {
  const normalizedNextSourceHash = normalizeSourceHash(nextSourceHash);
  if (!normalizedNextSourceHash || !isTmdbResolvedPlayback || isResolvingSource()) {
    return;
  }

  const existingState = getSourceSaveState(normalizedNextSourceHash);
  if (existingState === "saving" || existingState === "saved") {
    return;
  }

  setSourceSaveState(normalizedNextSourceHash, "saving");
  try {
    const resolved = await resolveTmdbSourceForGallerySave(normalizedNextSourceHash);
    await queueGallerySaveFromResolvedPayload(resolved, {
      sourceOption: getSourceOptionByHash(normalizedNextSourceHash),
    });
    setSourceSaveState(normalizedNextSourceHash, "saved");
  } catch (error) {
    console.error("Failed to queue gallery save for source:", error);
    setSourceSaveState(normalizedNextSourceHash, "error");
    scheduleSourceSaveRetryReset(normalizedNextSourceHash);
  }
}

audioTabSubtitles?.addEventListener("click", () => {
  if (isResolvingSource()) {
    return;
  }
  setActiveAudioTab("subtitles");
});

audioTabSources?.addEventListener("click", () => {
  if (isResolvingSource() || !isTmdbResolvedPlayback) {
    return;
  }

  if (!availablePlaybackSources.length) {
    void fetchTmdbSourceOptionsViaBackend();
  }
  setActiveAudioTab("sources");
});

[audioTabSubtitles, audioTabSources].forEach((tabButton) => {
  tabButton?.addEventListener("keydown", (event) => {
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

sourceOptionsContainer?.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }

  const sourceSaveButton = event.target.closest(".source-save-button");
  if (sourceSaveButton instanceof HTMLButtonElement) {
    event.preventDefault();
    event.stopPropagation();
    void handleSourceOptionSaveRequest(sourceSaveButton.dataset.sourceHash || "");
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

document.addEventListener("pointerdown", (event) => {
  if (!speedControl) {
    return;
  }

  if (speedControl.contains(event.target)) {
    return;
  }

  closeSpeedPopover(false);
});

document.addEventListener("pointerdown", (event) => {
  if (!episodesControl) {
    return;
  }

  if (episodesControl.contains(event.target)) {
    return;
  }

  closeEpisodesPopover();
});

document.addEventListener("pointerdown", (event) => {
  if (!audioControl) {
    return;
  }

  if (audioControl.contains(event.target)) {
    return;
  }

  closeAudioPopover();
});

video.addEventListener("ratechange", () => {
  if (!playbackRates.includes(video.playbackRate)) {
    const nearestRate = playbackRates.reduce((closest, rate) => {
      return Math.abs(rate - video.playbackRate) <
        Math.abs(closest - video.playbackRate)
        ? rate
        : closest;
    }, playbackRates[0]);
    video.playbackRate = nearestRate;
  }
  syncSpeedState();
});

seekBar.addEventListener("pointerdown", () => {
  isDraggingSeek = true;
  pendingStandardSeekRatio = null;
});

function handleSeekPointerUp() {
  if (!isDraggingSeek) {
    return;
  }
  isDraggingSeek = false;
  const seekScaleDurationSeconds = getSeekScaleDurationSeconds();
  if (seekScaleDurationSeconds <= 0) {
    pendingTranscodeSeekRatio = null;
    pendingStandardSeekRatio = null;
    return;
  }

  if (pendingTranscodeSeekRatio !== null && isTranscodeSourceActive()) {
    seekToAbsoluteTime(pendingTranscodeSeekRatio * seekScaleDurationSeconds, {
      showLoading: true,
    });
  } else if (pendingStandardSeekRatio !== null && !isTranscodeSourceActive()) {
    seekToAbsoluteTime(pendingStandardSeekRatio * seekScaleDurationSeconds, {
      showLoading: true,
    });
  }

  pendingTranscodeSeekRatio = null;
  pendingStandardSeekRatio = null;
}

seekBar.addEventListener("pointerup", handleSeekPointerUp);
seekBar.addEventListener("pointercancel", handleSeekPointerUp);
document.addEventListener("pointerup", handleSeekPointerUp);

seekBar.addEventListener("input", () => {
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
    pendingTranscodeSeekRatio = ratio;
    paintSeekProgress(
      seekBar.value,
      getBufferedSeekValue(seekScaleDurationSeconds),
    );
    return;
  }

  paintSeekProgress(
    seekBar.value,
    getBufferedSeekValue(seekScaleDurationSeconds),
  );
  if (isDraggingSeek) {
    pendingStandardSeekRatio = ratio;
    return;
  }
  seekToAbsoluteTime(ratio * seekScaleDurationSeconds, { showLoading: true });
});

video.addEventListener("loadedmetadata", () => {
  restoreSelectedSubtitleTrackAfterSourceChange();
  syncSubtitleTrackVisibility();
  refreshActiveSubtitlePlacement();
  renderCustomSubtitleOverlay();
  window.setTimeout(() => {
    restoreSelectedSubtitleTrackAfterSourceChange();
    syncSubtitleTrackVisibility();
    refreshActiveSubtitlePlacement();
    renderCustomSubtitleOverlay();
  }, 200);
  const timelineDurationSeconds = getTimelineDurationSeconds();
  const seekScaleDurationSeconds = getSeekScaleDurationSeconds();
  if (
    !hasAppliedInitialResume &&
    Number.isFinite(resumeTime) &&
    resumeTime > 1 &&
    resumeTime < seekScaleDurationSeconds - 8
  ) {
    if (isTranscodeSourceActive()) {
      const relativeResume = resumeTime - transcodeBaseOffsetSeconds;
      if (
        relativeResume >= 0 &&
        Number.isFinite(video.duration) &&
        relativeResume < video.duration - 3
      ) {
        video.currentTime = relativeResume;
      } else {
        seekToAbsoluteTime(resumeTime);
      }
    } else if (resumeTime < timelineDurationSeconds - 8) {
      video.currentTime = resumeTime;
    }
    hasAppliedInitialResume = true;
  }
  if (!hasAppliedInitialResume) {
    hasAppliedInitialResume = true;
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
  video.textTracks.addEventListener("addtrack", () => {
    syncSubtitleTrackVisibility();
    refreshActiveSubtitlePlacement();
  });
}
window.addEventListener("resize", refreshActiveSubtitlePlacement);
document.addEventListener("fullscreenchange", refreshActiveSubtitlePlacement);

video.addEventListener("timeupdate", syncSeekState);
video.addEventListener("timeupdate", renderCustomSubtitleOverlay);
video.addEventListener("seeking", renderCustomSubtitleOverlay);
video.addEventListener("progress", syncSeekState);
video.addEventListener("durationchange", syncSeekState);
video.addEventListener("waiting", () => {
  scheduleStreamStallRecovery("Stream stalled, trying another source...");
});
video.addEventListener("stalled", () => {
  scheduleStreamStallRecovery("Stream stalled, trying another source...");
});
video.addEventListener("seeked", () => {
  renderCustomSubtitleOverlay();
  if (video.paused || video.readyState >= 2) {
    hideSeekLoadingIndicator();
  }
});
video.addEventListener("canplay", () => {
  clearStreamStallRecovery();
  hideSeekLoadingIndicator();
});
video.addEventListener("playing", () => {
  clearStreamStallRecovery();
  hideSeekLoadingIndicator();
});
video.addEventListener("timeupdate", () => {
  if (getEffectiveCurrentTime() > 0.5) {
    clearStreamStallRecovery();
  }
  persistResumeTime(false);
});
video.addEventListener("play", syncPlayState);
video.addEventListener("play", () => {
  scheduleStreamStallRecovery("Stream stalled, trying another source...");
  showControls();
  scheduleControlsHide();
});
video.addEventListener("pause", syncPlayState);
video.addEventListener("pause", () => {
  clearControlsHideTimer();
  showControls();
});
video.addEventListener("pause", () => {
  clearStreamStallRecovery();
  persistResumeTime(true);
});
video.addEventListener("ended", () => {
  const expectedDuration = getDisplayDurationSeconds();
  const effectiveCurrent = getEffectiveCurrentTime();
  const endedTooEarly =
    isTmdbResolvedPlayback &&
    Number.isFinite(expectedDuration) &&
    expectedDuration > 120 &&
    effectiveCurrent < expectedDuration - 45;

  if (endedTooEarly) {
    const recovered = attemptTmdbRecovery(
      "Stream ended early, trying another source...",
    );
    if (recovered) {
      return;
    }
  }

  try {
    localStorage.removeItem(resumeStorageKey);
    removeContinueWatchingEntry();
  } catch {
    // Ignore storage access issues.
  }
  resumeTime = 0;
  lastPersistedResumeTime = 0;
  lastPersistedResumeAt = 0;
});
video.addEventListener("volumechange", syncMuteState);
video.addEventListener("canplay", () => {
  if (isTmdbResolvedPlayback) {
    hideResolver();
  }
});
video.addEventListener("error", () => {
  hideSeekLoadingIndicator();
  if (!isTmdbResolvedPlayback) {
    return;
  }

  const mediaError = video.error;
  const message =
    mediaError?.message || "Resolved stream could not be played. Try again.";

  if (attemptTmdbRecovery("Trying alternate source...")) {
    return;
  }

  showResolver(message, { isError: true });
});

function isInteractiveTarget(target) {
  if (!target || !(target instanceof Element)) {
    return false;
  }

  return Boolean(
    target.closest("button, input, textarea, select, [contenteditable='true']"),
  );
}

playerShell.addEventListener("click", (event) => {
  showControls();
  scheduleControlsHide();
  playerShell.focus();
  if (isInteractiveTarget(event.target)) {
    return;
  }

  clearSingleClickPlaybackToggle();
  singleClickPlaybackToggleTimeout = window.setTimeout(() => {
    singleClickPlaybackToggleTimeout = null;
    void togglePlayback();
  }, singleClickToggleDelayMs);
});

playerShell.addEventListener("dblclick", (event) => {
  if (isInteractiveTarget(event.target)) {
    return;
  }
  event.preventDefault();
  clearSingleClickPlaybackToggle();
  void toggleFullscreenMode();
});

playerShell.addEventListener("mousemove", handleUserActivity);
playerShell.addEventListener("touchstart", handleUserActivity, {
  passive: true,
});
playerShell.addEventListener("pointerdown", handleUserActivity);

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
    if (hasActiveSource() && !isResolvingSource()) {
      seekToAbsoluteTime(getEffectiveCurrentTime() - 10);
    }
  }

  if (event.key === "ArrowRight") {
    if (isInteractiveTarget(event.target)) {
      return;
    }
    if (!hasActiveSource() || isResolvingSource()) {
      return;
    }

    seekToAbsoluteTime(getEffectiveCurrentTime() + 10);
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
    await toggleFullscreenMode();
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

  if (event.key === "Escape" && !document.fullscreenElement) {
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
    persistResumeTime(true);
    window.location.href = "index.html";
  }
}

window.addEventListener("keydown", handleKeydown, { capture: true });
window.addEventListener("storage", (event) => {
  if (!event.key || event.key === SUBTITLE_COLOR_PREF_KEY) {
    applySubtitleCueColor(event.newValue);
  }

  if (
    event.key === SOURCE_MIN_SEEDERS_PREF_KEY ||
    event.key === SOURCE_LANGUAGE_PREF_KEY ||
    event.key === SOURCE_AUDIO_PROFILE_PREF_KEY
  ) {
    preferredSourceMinSeeders = getStoredSourceMinSeeders();
    preferredSourceLanguage = getStoredSourceLanguage();
    preferredSourceAudioProfile = getStoredSourceAudioProfile();
    if (isTmdbResolvedPlayback && audioControl?.classList.contains("is-open")) {
      void fetchTmdbSourceOptionsViaBackend();
    }
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

  if (event.key === NATIVE_PLAYBACK_MODE_PREF_KEY) {
    preferredNativePlaybackMode = getStoredNativePlaybackMode();
  }

  if (event.key === REMUX_VIDEO_MODE_PREF_KEY) {
    preferredRemuxVideoMode = getStoredRemuxVideoMode();
  }
});
window.addEventListener("beforeunload", () => {
  clearSingleClickPlaybackToggle();
  hideSeekLoadingIndicator();
  clearControlsHideTimer();
  clearStreamStallRecovery();
  persistResumeTime(true);
  destroyHlsInstance();
});

function createPlaybackBenchmarkApi() {
  const benchmarkOriginMs = performance.now();
  const benchmarkState = {
    counters: {
      loadedmetadata: 0,
      canplay: 0,
      playing: 0,
      waiting: 0,
      stalled: 0,
      error: 0,
      play: 0,
      pause: 0,
      seeking: 0,
      seeked: 0,
      ended: 0,
      timeupdate: 0,
    },
    timings: {
      firstLoadedMetadataMs: null,
      firstCanPlayMs: null,
      firstPlayingMs: null,
      firstTimeUpdateMs: null,
      firstVideoFrameMs: null,
      lastVideoFrameMs: null,
      lastSourceSetMs: null,
    },
    frameStats: {
      callbackCount: 0,
      processingDurationSampleCount: 0,
      processingDurationTotalMs: 0,
      maxProcessingDurationMs: 0,
      frameIntervalSampleCount: 0,
      frameIntervalTotalMs: 0,
      maxFrameIntervalMs: 0,
      maxPresentedFramesDelta: 0,
      lastFrameNowMs: null,
      lastPresentedFrames: null,
    },
    events: [],
    sourceHistory: [],
    frameCallbackArmed: false,
  };
  const loggedEvents = new Set([
    "sourcechange",
    "loadedmetadata",
    "canplay",
    "playing",
    "waiting",
    "stalled",
    "error",
    "play",
    "pause",
    "seeking",
    "seeked",
    "ended",
  ]);

  function benchmarkNowMs() {
    return performance.now() - benchmarkOriginMs;
  }

  function roundBenchmarkNumber(value, digits = 2) {
    return Number.isFinite(value)
      ? Number(Number(value).toFixed(digits))
      : null;
  }

  function rememberFirstBenchmarkTiming(key) {
    if (benchmarkState.timings[key] === null) {
      benchmarkState.timings[key] = roundBenchmarkNumber(benchmarkNowMs(), 1);
    }
  }

  function getBenchmarkCurrentSource() {
    return String(video.currentSrc || video.getAttribute("src") || "").trim();
  }

  function inferBenchmarkPlaybackMode(source = getBenchmarkCurrentSource()) {
    const normalized = String(source || "").toLowerCase();
    if (normalized.includes("/api/hls/master.m3u8")) {
      return "hls";
    }
    if (normalized.includes("/api/remux")) {
      return "remux";
    }
    return "direct";
  }

  function pushBenchmarkEvent(type, details = {}) {
    if (!loggedEvents.has(type)) {
      return;
    }
    benchmarkState.events.push({
      type,
      atMs: roundBenchmarkNumber(benchmarkNowMs(), 1),
      currentTime: roundBenchmarkNumber(getEffectiveCurrentTime(), 3),
      readyState: Number(video.readyState || 0),
      paused: Boolean(video.paused),
      seeking: Boolean(video.seeking),
      mode: inferBenchmarkPlaybackMode(),
      ...details,
    });
    if (benchmarkState.events.length > 120) {
      benchmarkState.events.shift();
    }
  }

  function readBenchmarkVideoQuality() {
    if (typeof video.getVideoPlaybackQuality !== "function") {
      return null;
    }

    try {
      const quality = video.getVideoPlaybackQuality();
      return {
        droppedVideoFrames: Number(quality?.droppedVideoFrames || 0),
        totalVideoFrames: Number(quality?.totalVideoFrames || 0),
        corruptedVideoFrames: Number(quality?.corruptedVideoFrames || 0),
        creationTime: Number(quality?.creationTime || 0),
      };
    } catch {
      return null;
    }
  }

  function summarizeBenchmarkResources() {
    const totals = {
      requestCount: 0,
      transferSize: 0,
      encodedBodySize: 0,
      decodedBodySize: 0,
      durationMs: 0,
    };

    const entries = performance.getEntriesByType("resource");
    entries.forEach((entry) => {
      const name = String(entry?.name || "");
      let pathname = "";
      try {
        pathname = new URL(name, window.location.origin).pathname;
      } catch {
        pathname = name;
      }

      const isPlaybackEntry =
        pathname.startsWith("/assets/videos/") ||
        pathname.startsWith("/media/") ||
        pathname.startsWith("/videos/") ||
        pathname === "/api/remux" ||
        pathname === "/api/hls/master.m3u8" ||
        pathname === "/api/hls/segment.ts";

      if (!isPlaybackEntry) {
        return;
      }

      totals.requestCount += 1;
      totals.transferSize += Number(entry?.transferSize || 0);
      totals.encodedBodySize += Number(entry?.encodedBodySize || 0);
      totals.decodedBodySize += Number(entry?.decodedBodySize || 0);
      totals.durationMs += Number(entry?.duration || 0);
    });

    return {
      requestCount: totals.requestCount,
      transferSize: Math.max(0, Math.round(totals.transferSize)),
      encodedBodySize: Math.max(0, Math.round(totals.encodedBodySize)),
      decodedBodySize: Math.max(0, Math.round(totals.decodedBodySize)),
      durationMs: roundBenchmarkNumber(totals.durationMs, 1),
    };
  }

  function getBenchmarkSnapshot() {
    const frameStats = benchmarkState.frameStats;
    const quality = readBenchmarkVideoQuality();
    const effectiveDurationSeconds = (() => {
      if (typeof getDisplayDurationSeconds === "function") {
        const displayDuration = Number(getDisplayDurationSeconds());
        if (Number.isFinite(displayDuration) && displayDuration > 0) {
          return roundBenchmarkNumber(displayDuration, 3);
        }
      }
      const fallbackDuration = Number(video.duration);
      return Number.isFinite(fallbackDuration)
        ? roundBenchmarkNumber(fallbackDuration, 3)
        : null;
    })();

    return {
      benchmarkMode: true,
      capturedAtMs: roundBenchmarkNumber(benchmarkNowMs(), 1),
      currentTime: roundBenchmarkNumber(getEffectiveCurrentTime(), 3),
      rawCurrentTime: roundBenchmarkNumber(Number(video.currentTime || 0), 3),
      durationSeconds: effectiveDurationSeconds,
      playbackRate: roundBenchmarkNumber(Number(video.playbackRate || 1), 3),
      readyState: Number(video.readyState || 0),
      networkState: Number(video.networkState || 0),
      paused: Boolean(video.paused),
      ended: Boolean(video.ended),
      seeking: Boolean(video.seeking),
      muted: Boolean(video.muted),
      volume: roundBenchmarkNumber(Number(video.volume || 0), 3),
      source: {
        currentSource: getBenchmarkCurrentSource(),
        input: extractPlaybackSourceInput(getBenchmarkCurrentSource()),
        mode: inferBenchmarkPlaybackMode(),
      },
      videoMetrics: {
        clientWidth: Number(video.clientWidth || 0),
        clientHeight: Number(video.clientHeight || 0),
        videoWidth: Number(video.videoWidth || 0),
        videoHeight: Number(video.videoHeight || 0),
      },
      timings: { ...benchmarkState.timings },
      counters: { ...benchmarkState.counters },
      quality,
      frameStats: {
        callbackCount: benchmarkState.frameStats.callbackCount,
        processingDurationSampleCount:
          frameStats.processingDurationSampleCount,
        meanProcessingDurationMs:
          frameStats.processingDurationSampleCount > 0
            ? roundBenchmarkNumber(
                frameStats.processingDurationTotalMs /
                  frameStats.processingDurationSampleCount,
                3,
              )
            : null,
        maxProcessingDurationMs: roundBenchmarkNumber(
          frameStats.maxProcessingDurationMs,
          3,
        ),
        frameIntervalSampleCount: frameStats.frameIntervalSampleCount,
        meanFrameIntervalMs:
          frameStats.frameIntervalSampleCount > 0
            ? roundBenchmarkNumber(
                frameStats.frameIntervalTotalMs /
                  frameStats.frameIntervalSampleCount,
                3,
              )
            : null,
        maxFrameIntervalMs: roundBenchmarkNumber(
          frameStats.maxFrameIntervalMs,
          3,
        ),
        estimatedFrameRateFps:
          frameStats.frameIntervalSampleCount > 0 &&
          frameStats.frameIntervalTotalMs > 0
            ? roundBenchmarkNumber(
                1000 /
                  (frameStats.frameIntervalTotalMs /
                    frameStats.frameIntervalSampleCount),
                3,
              )
            : null,
        maxPresentedFramesDelta: frameStats.maxPresentedFramesDelta,
      },
      resources: summarizeBenchmarkResources(),
      events: benchmarkState.events.slice(),
      sourceHistory: benchmarkState.sourceHistory.slice(),
    };
  }

  async function waitForBenchmarkCondition(
    predicate,
    {
      timeoutMs = 30_000,
      pollIntervalMs = 50,
      errorMessage = "Benchmark condition timed out.",
    } = {},
  ) {
    const startedAt = performance.now();

    return new Promise((resolve, reject) => {
      function step() {
        let result = null;
        try {
          result = predicate();
        } catch (error) {
          reject(error);
          return;
        }

        if (result) {
          resolve(result === true ? getBenchmarkSnapshot() : result);
          return;
        }

        if (performance.now() - startedAt >= timeoutMs) {
          reject(new Error(errorMessage));
          return;
        }

        window.setTimeout(step, pollIntervalMs);
      }

      step();
    });
  }

  function armBenchmarkFrameCallback() {
    if (
      benchmarkState.frameCallbackArmed ||
      typeof video.requestVideoFrameCallback !== "function"
    ) {
      return;
    }

    benchmarkState.frameCallbackArmed = true;
    video.requestVideoFrameCallback((now, metadata) => {
      benchmarkState.frameCallbackArmed = false;
      benchmarkState.frameStats.callbackCount += 1;
      rememberFirstBenchmarkTiming("firstVideoFrameMs");
      benchmarkState.timings.lastVideoFrameMs = roundBenchmarkNumber(
        benchmarkNowMs(),
        1,
      );

      const processingDurationMs =
        Number(metadata?.processingDuration || 0) * 1000;
      if (Number.isFinite(processingDurationMs) && processingDurationMs >= 0) {
        benchmarkState.frameStats.processingDurationSampleCount += 1;
        benchmarkState.frameStats.processingDurationTotalMs +=
          processingDurationMs;
        benchmarkState.frameStats.maxProcessingDurationMs = Math.max(
          benchmarkState.frameStats.maxProcessingDurationMs,
          processingDurationMs,
        );
      }

      if (Number.isFinite(benchmarkState.frameStats.lastFrameNowMs)) {
        const frameIntervalMs = now - benchmarkState.frameStats.lastFrameNowMs;
        if (Number.isFinite(frameIntervalMs) && frameIntervalMs >= 0) {
          benchmarkState.frameStats.frameIntervalSampleCount += 1;
          benchmarkState.frameStats.frameIntervalTotalMs += frameIntervalMs;
          benchmarkState.frameStats.maxFrameIntervalMs = Math.max(
            benchmarkState.frameStats.maxFrameIntervalMs,
            frameIntervalMs,
          );
        }
      }
      benchmarkState.frameStats.lastFrameNowMs = now;

      const presentedFrames = Number(metadata?.presentedFrames || 0);
      if (
        Number.isFinite(presentedFrames) &&
        Number.isFinite(benchmarkState.frameStats.lastPresentedFrames)
      ) {
        benchmarkState.frameStats.maxPresentedFramesDelta = Math.max(
          benchmarkState.frameStats.maxPresentedFramesDelta,
          Math.max(
            0,
            presentedFrames - benchmarkState.frameStats.lastPresentedFrames,
          ),
        );
      }
      if (Number.isFinite(presentedFrames) && presentedFrames >= 0) {
        benchmarkState.frameStats.lastPresentedFrames = presentedFrames;
      }

      if (!video.ended) {
        armBenchmarkFrameCallback();
      }
    });
  }

  function recordBenchmarkVideoEvent(type) {
    if (Object.hasOwn(benchmarkState.counters, type)) {
      benchmarkState.counters[type] += 1;
    }

    if (type === "loadedmetadata") {
      rememberFirstBenchmarkTiming("firstLoadedMetadataMs");
      armBenchmarkFrameCallback();
    } else if (type === "canplay") {
      rememberFirstBenchmarkTiming("firstCanPlayMs");
      armBenchmarkFrameCallback();
    } else if (type === "playing") {
      rememberFirstBenchmarkTiming("firstPlayingMs");
      armBenchmarkFrameCallback();
    } else if (type === "timeupdate") {
      rememberFirstBenchmarkTiming("firstTimeUpdateMs");
    }

    if (type === "error") {
      pushBenchmarkEvent(type, {
        mediaErrorCode: Number(video.error?.code || 0) || null,
        mediaErrorMessage: String(video.error?.message || "").trim() || null,
      });
      return;
    }

    pushBenchmarkEvent(type);
  }

  [
    "loadedmetadata",
    "canplay",
    "playing",
    "waiting",
    "stalled",
    "error",
    "play",
    "pause",
    "seeking",
    "seeked",
    "ended",
    "timeupdate",
  ].forEach((eventName) => {
    video.addEventListener(eventName, () => recordBenchmarkVideoEvent(eventName));
  });

  return {
    getSnapshot: getBenchmarkSnapshot,
    play: async () => {
      await tryPlay();
      return getBenchmarkSnapshot();
    },
    pause: () => {
      video.pause();
      return getBenchmarkSnapshot();
    },
    waitForPlayback: async ({
      timeoutMs = 30_000,
      minCurrentTime = 1.25,
    } = {}) => {
      return waitForBenchmarkCondition(
        () => {
          const snapshot = getBenchmarkSnapshot();
          if (!snapshot.source.currentSource) {
            return null;
          }
          const hasStarted =
            snapshot.timings.firstPlayingMs !== null ||
            snapshot.timings.firstVideoFrameMs !== null;
          if (
            hasStarted &&
            snapshot.readyState >= 2 &&
            snapshot.currentTime >= minCurrentTime
          ) {
            return snapshot;
          }
          return null;
        },
        {
          timeoutMs,
          errorMessage: `Playback did not advance past ${minCurrentTime}s in time.`,
        },
      );
    },
    measurePauseResume: async ({
      pauseDurationMs = 500,
      playbackAdvanceSeconds = 0.35,
      timeoutMs = 15_000,
    } = {}) => {
      const baselineCurrentTime = getEffectiveCurrentTime();
      const pauseStartedAt = performance.now();
      video.pause();
      await waitForBenchmarkCondition(() => video.paused, {
        timeoutMs,
        errorMessage: "Pause did not settle in time.",
      });
      const pauseSettledMs = performance.now() - pauseStartedAt;

      if (pauseDurationMs > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, pauseDurationMs));
      }

      const resumeStartedAt = performance.now();
      await tryPlay();
      const targetTime = baselineCurrentTime + Math.max(0.05, playbackAdvanceSeconds);
      await waitForBenchmarkCondition(
        () => {
          if (video.paused || video.readyState < 2) {
            return null;
          }
          return getEffectiveCurrentTime() >= targetTime
            ? getBenchmarkSnapshot()
            : null;
        },
        {
          timeoutMs,
          errorMessage: "Playback did not resume cleanly in time.",
        },
      );

      return {
        baselineCurrentTime: roundBenchmarkNumber(baselineCurrentTime, 3),
        pauseSettledMs: roundBenchmarkNumber(pauseSettledMs, 2),
        resumeLatencyMs: roundBenchmarkNumber(
          performance.now() - resumeStartedAt,
          2,
        ),
        endCurrentTime: roundBenchmarkNumber(getEffectiveCurrentTime(), 3),
        snapshot: getBenchmarkSnapshot(),
      };
    },
    measureSeek: async ({
      targetSeconds = 0,
      playbackAdvanceSeconds = 0.35,
      timeoutMs = 20_000,
      showLoading = true,
    } = {}) => {
      const baselineCurrentTime = getEffectiveCurrentTime();
      const safeTargetSeconds = Math.max(0, Number(targetSeconds) || 0);
      const seekStartedAt = performance.now();
      seekToAbsoluteTime(safeTargetSeconds, { showLoading });

      await waitForBenchmarkCondition(
        () => {
          if (video.seeking || video.readyState < 2) {
            return null;
          }
          const effectiveCurrentTime = getEffectiveCurrentTime();
          const nearTarget = Math.abs(effectiveCurrentTime - safeTargetSeconds) <= 1;
          const advancedPastTarget =
            effectiveCurrentTime >=
            safeTargetSeconds + Math.max(0.05, playbackAdvanceSeconds);
          return nearTarget || advancedPastTarget
            ? getBenchmarkSnapshot()
            : null;
        },
        {
          timeoutMs,
          errorMessage: `Seek to ${safeTargetSeconds}s did not settle in time.`,
        },
      );

      const endCurrentTime = getEffectiveCurrentTime();
      return {
        baselineCurrentTime: roundBenchmarkNumber(baselineCurrentTime, 3),
        targetSeconds: roundBenchmarkNumber(safeTargetSeconds, 3),
        seekLatencyMs: roundBenchmarkNumber(
          performance.now() - seekStartedAt,
          2,
        ),
        endCurrentTime: roundBenchmarkNumber(endCurrentTime, 3),
        absoluteErrorSeconds: roundBenchmarkNumber(
          Math.abs(endCurrentTime - safeTargetSeconds),
          3,
        ),
        snapshot: getBenchmarkSnapshot(),
      };
    },
    setStrategy: async ({
      mode = "direct",
      input = "",
      startSeconds = 0,
      audioStreamIndex = -1,
      subtitleStreamIndex = -1,
      videoMode = preferredRemuxVideoMode,
    } = {}) => {
      const safeInput = String(input || "").trim();
      if (!safeInput) {
        throw new Error("Benchmark strategy input is required.");
      }

      let nextSource = safeInput;
      if (mode === "remux") {
        nextSource = buildSoftwareDecodeUrl(
          safeInput,
          startSeconds,
          audioStreamIndex,
          preferredAudioSyncMs,
          subtitleStreamIndex,
          videoMode,
        );
      } else if (mode === "hls") {
        nextSource = buildHlsPlaybackUrl(
          safeInput,
          audioStreamIndex,
          subtitleStreamIndex,
        );
      } else if (mode === "direct") {
        if (
          !safeInput.startsWith("/") &&
          !/^[a-z]+:\/\//i.test(safeInput)
        ) {
          nextSource = `/${safeInput}`;
        }
      } else {
        throw new Error(`Unsupported benchmark strategy '${mode}'.`);
      }

      setVideoSource(nextSource);
      await tryPlay();
      return getBenchmarkSnapshot();
    },
    _recordSourceChange: (source) => {
      const atMs = roundBenchmarkNumber(benchmarkNowMs(), 1);
      benchmarkState.timings.lastSourceSetMs = atMs;
      benchmarkState.sourceHistory.push({
        atMs,
        mode: inferBenchmarkPlaybackMode(source),
        source,
      });
      if (benchmarkState.sourceHistory.length > 24) {
        benchmarkState.sourceHistory.shift();
      }
      pushBenchmarkEvent("sourcechange", {
        source,
        mode: inferBenchmarkPlaybackMode(source),
      });
    },
  };
}

async function initPlaybackSource() {
  hasAppliedInitialResume = false;
  nativePlaybackLaunched = false;
  pendingTranscodeSeekRatio = null;
  availableAudioTracks = [];
  availableSubtitleTracks = [];
  selectedAudioStreamIndex = -1;
  selectedSubtitleStreamIndex = -1;
  activeTrackSourceInput = "";
  clearSubtitleTrack();
  hideAllSubtitleTracks();
  rebuildTrackOptionButtons();

  if (hasExplicitSource) {
    expectedDurationSeconds = 0;
    hideResolver();
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
    setVideoSource(nextSource);
    applySubtitleTrackByStreamIndex(selectedSubtitleStreamIndex);
    await tryPlay();
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
    setVideoSource(src || DEFAULT_TRAILER_SOURCE);
    hideResolver();
    await tryPlay();
    return;
  }

  try {
    showResolver("Loading video...");
    await resolveTmdbSourcesAndPlay();
  } catch (error) {
    console.error("Failed to resolve TMDB playback via Real-Debrid:", error);
    showResolver(error.message || "Unable to resolve this stream.", {
      isError: true,
    });
  }
}

syncMuteState();
syncPlayState();
syncSpeedState();
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
  preferredQuality !== DEFAULT_STREAM_QUALITY_PREFERENCE
) {
  persistQualityInUrl();
}
showControls();
paintSeekProgress(seekBar.value);
scheduleControlsHide();
initPlaybackSource();

playerShell.focus();

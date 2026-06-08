import {
  CONTINUE_WATCHING_META_KEY,
  readContinueWatchingMetaMap,
} from "../shared.js";
import { AUDIO_LANG_PREF_KEY_PREFIX } from "./preferences.js";

export { CONTINUE_WATCHING_META_KEY };
export const RESUME_STORAGE_PREFIX = "netflix-resume:";
export const DEFAULT_LOCAL_THUMBNAIL = "assets/images/thumbnail.jpg";

const SUBTITLE_LANG_PREF_KEY_PREFIX = "netflix-subtitle-lang:movie:";
const SUBTITLE_STREAM_PREF_KEY_PREFIX = "netflix-subtitle-stream:movie:";
const TV_SUBTITLE_LANG_PREF_KEY_PREFIX = "netflix-subtitle-lang:tv:";
const TV_SUBTITLE_STREAM_PREF_KEY_PREFIX = "netflix-subtitle-stream:tv:";
const PRIDE_PREJUDICE_SOURCE =
  "assets/videos/Pride.Prejudice.2005.2160p.4K.WEB.x265.10bit.AAC5.1-[YTS.MX].mp4";
const PRIDE_PREJUDICE_THUMBNAIL = "assets/images/pride-prejudice-thumb.jpg";

function normalizeContinueSourceHash(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export function formatRuntime(minutes) {
  if (!minutes || Number.isNaN(minutes)) return "";
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (!hours) return `${remainingMinutes}m`;
  if (!remainingMinutes) return `${hours}h`;
  return `${hours}h ${remainingMinutes}m`;
}

export function formatResumeTimestamp(totalSeconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function isLikelyLocalMediaSource(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.startsWith("/media/") ||
    normalized.includes("/media/") ||
    normalized.startsWith("/videos/") ||
    normalized.startsWith("videos/") ||
    normalized.includes("/videos/") ||
    normalized.startsWith("assets/videos/") ||
    normalized.includes("/assets/videos/")
  );
}

export function extractSeriesIdFromSourceIdentity(sourceIdentity) {
  const normalizedSource = String(sourceIdentity || "").trim();
  if (!normalizedSource) {
    return "";
  }
  const seriesMatch = /^series:([^:]+):episode:(\d+)$/i.exec(normalizedSource);
  return seriesMatch
    ? String(seriesMatch[1] || "")
        .trim()
        .toLowerCase()
    : "";
}

export function parseTmdbSourceIdentity(sourceIdentity) {
  const normalizedSource = String(sourceIdentity || "").trim();
  if (!normalizedSource.toLowerCase().startsWith("tmdb:")) {
    return { tmdbId: "", mediaType: "", seasonNumber: 0, episodeNumber: 0 };
  }
  const typedMatch = /^tmdb:(movie|tv):(\d+)(?::s(\d+):e(\d+))?$/i.exec(
    normalizedSource,
  );
  if (typedMatch) {
    return {
      mediaType: String(typedMatch[1] || "")
        .trim()
        .toLowerCase(),
      tmdbId: String(typedMatch[2] || "").trim(),
      seasonNumber: Number(typedMatch[3] || 0) || 0,
      episodeNumber: Number(typedMatch[4] || 0) || 0,
    };
  }
  return { tmdbId: "", mediaType: "", seasonNumber: 0, episodeNumber: 0 };
}

function removeResumeEntriesForSource(
  sourceIdentity,
  seriesId = "",
  parsedTmdbSource = { tmdbId: "", mediaType: "" },
) {
  const normalizedSource = String(sourceIdentity || "").trim();
  if (!normalizedSource) {
    return [];
  }
  const serverDeletes = [];
  const keysToDelete = new Set();
  keysToDelete.add(`${RESUME_STORAGE_PREFIX}${normalizedSource}`);

  const normalizedSeriesId = String(seriesId || "")
    .trim()
    .toLowerCase();
  if (normalizedSeriesId) {
    const seriesResumePrefix = `${RESUME_STORAGE_PREFIX}series:${normalizedSeriesId}:episode:`;
    const storageKeys = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key) {
        storageKeys.push(key);
      }
    }
    storageKeys.forEach((key) => {
      if (key && key.startsWith(seriesResumePrefix)) {
        keysToDelete.add(key);
      }
    });
  }

  const tmdbId = String(parsedTmdbSource?.tmdbId || "").trim();
  const mediaType = String(parsedTmdbSource?.mediaType || "")
    .trim()
    .toLowerCase();
  if (tmdbId) {
    if (mediaType === "tv") {
      const tvResumePrefix = `${RESUME_STORAGE_PREFIX}tmdb:tv:${tmdbId}`;
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (
          key &&
          (key === tvResumePrefix || key.startsWith(`${tvResumePrefix}:`))
        ) {
          keysToDelete.add(key);
        }
      }
    } else {
      keysToDelete.add(`${RESUME_STORAGE_PREFIX}tmdb:movie:${tmdbId}`);
    }
  }

  keysToDelete.forEach((key) => {
    localStorage.removeItem(key);
    const identity = key.slice(RESUME_STORAGE_PREFIX.length);
    if (identity) {
      serverDeletes.push(fetch("/api/user/watch-progress", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceIdentity: identity,
          seriesId: normalizedSeriesId,
        }),
      }).catch(() => {}));
    }
  });

  if (normalizedSeriesId) {
    serverDeletes.push(fetch("/api/user/watch-progress", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceIdentity: normalizedSource,
        seriesId: normalizedSeriesId,
      }),
    }).catch(() => {}));
  }

  return serverDeletes;
}

function removeContinueMetaEntriesForSource(
  metaMap,
  sourceIdentity,
  seriesId = "",
  parsedTmdbSource = { tmdbId: "", mediaType: "" },
) {
  if (!metaMap || typeof metaMap !== "object") {
    return;
  }
  const normalizedSource = String(sourceIdentity || "").trim();
  const normalizedSeriesId = String(seriesId || "")
    .trim()
    .toLowerCase();
  if (normalizedSeriesId) {
    Object.keys(metaMap).forEach((key) => {
      const valueSeriesId = String(metaMap[key]?.seriesId || "")
        .trim()
        .toLowerCase();
      if (
        extractSeriesIdFromSourceIdentity(key) === normalizedSeriesId ||
        valueSeriesId === normalizedSeriesId
      ) {
        delete metaMap[key];
      }
    });
  }

  const tmdbId = String(parsedTmdbSource?.tmdbId || "").trim();
  const mediaType = String(parsedTmdbSource?.mediaType || "")
    .trim()
    .toLowerCase();
  if (tmdbId) {
    Object.keys(metaMap).forEach((key) => {
      const parsed = parseTmdbSourceIdentity(key);
      if (String(parsed.tmdbId || "").trim() !== tmdbId) {
        return;
      }
      const parsedMediaType = String(parsed.mediaType || "")
        .trim()
        .toLowerCase();
      if (mediaType && parsedMediaType && parsedMediaType !== mediaType) {
        return;
      }
      delete metaMap[key];
    });
  }

  delete metaMap[normalizedSource];
}

function removeLocalTitleTrackPreferences(tmdbId, mediaType = "movie") {
  const normalizedTmdbId = String(tmdbId || "").trim();
  if (!/^\d+$/.test(normalizedTmdbId)) {
    return;
  }
  const normalizedMediaType = String(mediaType || "")
    .trim()
    .toLowerCase();
  if (normalizedMediaType === "tv") {
    // TV subtitle prefs are keyed per-episode (…:tv:<id>:s<n>:e<n>), so sweep
    // every stored key for this series rather than skipping cleanup entirely.
    const tvKeyPrefixes = [
      `${TV_SUBTITLE_LANG_PREF_KEY_PREFIX}${normalizedTmdbId}:`,
      `${TV_SUBTITLE_STREAM_PREF_KEY_PREFIX}${normalizedTmdbId}:`,
    ];
    const keysToRemove = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && tvKeyPrefixes.some((prefix) => key.startsWith(prefix))) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key));
    return;
  }
  localStorage.removeItem(`${AUDIO_LANG_PREF_KEY_PREFIX}${normalizedTmdbId}`);
  localStorage.removeItem(
    `${SUBTITLE_LANG_PREF_KEY_PREFIX}${normalizedTmdbId}`,
  );
  localStorage.removeItem(
    `${SUBTITLE_STREAM_PREF_KEY_PREFIX}${normalizedTmdbId}`,
  );
}

async function clearServerTitleMemory(tmdbId, mediaType = "movie") {
  const normalizedTmdbId = String(tmdbId || "").trim();
  const normalizedMediaType = String(mediaType || "")
    .trim()
    .toLowerCase();
  if (
    (normalizedMediaType !== "movie" && normalizedMediaType !== "tv") ||
    !/^\d+$/.test(normalizedTmdbId)
  ) {
    return;
  }
  try {
    const query = new URLSearchParams({
      tmdbId: normalizedTmdbId,
      mediaType: normalizedMediaType,
    });
    await fetch(`/api/title/preferences?${query.toString()}`, {
      method: "DELETE",
    });
  } catch {
    // Best-effort server cleanup only.
  }
}

export function inferContinueMediaType(
  sourceIdentity,
  explicitMediaType = "",
  explicitSeriesId = "",
) {
  const normalizedExplicitType = String(explicitMediaType || "")
    .trim()
    .toLowerCase();
  if (normalizedExplicitType === "movie" || normalizedExplicitType === "tv") {
    return normalizedExplicitType;
  }
  const seriesId =
    String(explicitSeriesId || "")
      .trim()
      .toLowerCase() || extractSeriesIdFromSourceIdentity(sourceIdentity);
  if (seriesId) {
    return "tv";
  }
  const parsedSource = parseTmdbSourceIdentity(sourceIdentity);
  if (parsedSource.mediaType === "movie" || parsedSource.mediaType === "tv") {
    return parsedSource.mediaType;
  }
  return "";
}

function getContinueDedupeKey(sourceIdentity, explicitSeriesId = "") {
  const normalizedSeriesId =
    String(explicitSeriesId || "")
      .trim()
      .toLowerCase() || extractSeriesIdFromSourceIdentity(sourceIdentity);
  if (normalizedSeriesId) {
    return `series:${normalizedSeriesId}`;
  }
  const parsedSource = parseTmdbSourceIdentity(sourceIdentity);
  if (parsedSource.mediaType === "tv" && parsedSource.tmdbId) {
    return `tmdb:tv:${parsedSource.tmdbId}`;
  }
  return String(sourceIdentity || "").trim();
}

function getStoredResumeSecondsForSource(sourceIdentity, fallbackResumeSeconds = 0) {
  const normalizedSource = String(sourceIdentity || "").trim();
  if (!normalizedSource) {
    return 0;
  }

  let storedResumeSeconds = 0;
  try {
    const storedValue = Number(
      localStorage.getItem(`${RESUME_STORAGE_PREFIX}${normalizedSource}`),
    );
    if (Number.isFinite(storedValue) && storedValue >= 1) {
      storedResumeSeconds = storedValue;
    }
  } catch {
    // Ignore localStorage access issues.
  }

  if (storedResumeSeconds >= 1) {
    return storedResumeSeconds;
  }

  const fallbackValue = Number(fallbackResumeSeconds);
  if (Number.isFinite(fallbackValue) && fallbackValue >= 1) {
    try {
      localStorage.setItem(
        `${RESUME_STORAGE_PREFIX}${normalizedSource}`,
        String(fallbackValue),
      );
    } catch {
      // Ignore localStorage access issues.
    }
    return fallbackValue;
  }

  return 0;
}

function normalizeLocalContinueEntry(entry) {
  const safeEntry = { ...entry };
  safeEntry.mediaType = String(safeEntry.mediaType || "")
    .trim()
    .toLowerCase();
  if (safeEntry.mediaType !== "movie" && safeEntry.mediaType !== "tv") {
    safeEntry.mediaType = "";
  }
  safeEntry.seriesId = String(safeEntry.seriesId || "").trim();
  safeEntry.episodeIndex = Number.isFinite(Number(safeEntry.episodeIndex))
    ? Math.max(0, Math.floor(Number(safeEntry.episodeIndex)))
    : -1;
  safeEntry.seasonNumber = Number.isFinite(Number(safeEntry.seasonNumber))
    ? Math.max(0, Math.floor(Number(safeEntry.seasonNumber)))
    : 0;
  safeEntry.episodeNumber = Number.isFinite(Number(safeEntry.episodeNumber))
    ? Math.max(0, Math.floor(Number(safeEntry.episodeNumber)))
    : 0;
  safeEntry.sourceHash = normalizeContinueSourceHash(safeEntry.sourceHash);
  safeEntry.sessionKey = String(safeEntry.sessionKey || "").trim();
  safeEntry.resolverProvider = String(safeEntry.resolverProvider || "").trim();
  safeEntry.sourceInput = String(safeEntry.sourceInput || "").trim();
  safeEntry.filename = String(safeEntry.filename || "").trim();
  return safeEntry;
}

function addContinueEntryToMap(entriesBySource, entry) {
  if (!(entriesBySource instanceof Map) || !entry) {
    return;
  }

  const normalizedEntry = normalizeLocalContinueEntry(entry);
  const normalizedSource = String(normalizedEntry.sourceIdentity || "").trim();
  const resumeSeconds = Number(normalizedEntry.resumeSeconds);
  if (!normalizedSource || !Number.isFinite(resumeSeconds) || resumeSeconds < 1) {
    return;
  }

  const dedupeKey = getContinueDedupeKey(
    normalizedSource,
    normalizedEntry.seriesId,
  );
  const existingEntry = entriesBySource.get(dedupeKey);
  const nextUpdatedAt = Number(normalizedEntry.updatedAt || 0);
  const existingUpdatedAt = Number(existingEntry?.updatedAt || 0);
  if (
    !existingEntry ||
    nextUpdatedAt > existingUpdatedAt ||
    (nextUpdatedAt === existingUpdatedAt &&
      resumeSeconds >= Number(existingEntry.resumeSeconds || 0))
  ) {
    entriesBySource.set(dedupeKey, normalizedEntry);
  }
}

function sortAndLimitContinueEntries(entries) {
  return Array.from(entries || [])
    .sort((left, right) => {
      if (right.updatedAt !== left.updatedAt) {
        return right.updatedAt - left.updatedAt;
      }
      return right.resumeSeconds - left.resumeSeconds;
    })
    .slice(0, 12);
}

export function mergeContinueWatchingEntries(...entryLists) {
  const entriesBySource = new Map();
  entryLists.flat().forEach((entry) => {
    addContinueEntryToMap(entriesBySource, entry);
  });
  return sortAndLimitContinueEntries(entriesBySource.values());
}

function normalizeServerContinueEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const normalizedSource = String(entry.sourceIdentity || "").trim();
  const resumeSeconds = Number(entry.resumeSeconds);
  if (!normalizedSource || !Number.isFinite(resumeSeconds) || resumeSeconds < 1) {
    return null;
  }

  const parsedTmdbSource = parseTmdbSourceIdentity(normalizedSource);
  const seriesId =
    String(entry.seriesId || "").trim() ||
    (parsedTmdbSource.mediaType === "tv" && parsedTmdbSource.tmdbId
      ? `tmdb-tv-${parsedTmdbSource.tmdbId}`
      : "") ||
    extractSeriesIdFromSourceIdentity(normalizedSource);
  return normalizeLocalContinueEntry({
    sourceIdentity: normalizedSource,
    resumeSeconds,
    updatedAt: Number(entry.updatedAt) || 0,
    title: String(entry.title || "").trim(),
    episode: String(entry.episode || "").trim(),
    src: String(entry.src || "").trim(),
    tmdbId:
      String(entry.tmdbId || "").trim() ||
      String(parsedTmdbSource.tmdbId || "").trim(),
    mediaType: inferContinueMediaType(
      normalizedSource,
      String(entry.mediaType || "").trim(),
      seriesId,
    ),
    seriesId,
    episodeIndex: Number.isFinite(Number(entry.episodeIndex))
      ? Math.max(0, Math.floor(Number(entry.episodeIndex)))
      : parsedTmdbSource.mediaType === "tv" && parsedTmdbSource.episodeNumber > 0
        ? parsedTmdbSource.episodeNumber - 1
        : -1,
    seasonNumber: Number.isFinite(Number(entry.seasonNumber))
      ? Math.max(0, Math.floor(Number(entry.seasonNumber)))
      : parsedTmdbSource.seasonNumber,
    episodeNumber: Number.isFinite(Number(entry.episodeNumber))
      ? Math.max(0, Math.floor(Number(entry.episodeNumber)))
      : parsedTmdbSource.episodeNumber,
    year: String(entry.year || "").trim(),
    thumb: String(entry.thumb || "").trim(),
    sourceHash: entry.sourceHash,
    sessionKey: entry.sessionKey,
    resolverProvider: entry.resolverProvider,
    sourceInput: entry.sourceInput,
    filename: entry.filename,
  });
}

export async function fetchServerContinueWatchingState() {
  try {
    const response = await fetch("/api/user/continue-watching");
    if (!response.ok) {
      return { ok: false, entries: [] };
    }
    const data = await response.json();
    const rawEntries = Array.isArray(data?.entries)
      ? data.entries
      : Array.isArray(data)
        ? data
        : [];
    return {
      ok: true,
      entries: rawEntries.map(normalizeServerContinueEntry).filter(Boolean),
    };
  } catch {
    return { ok: false, entries: [] };
  }
}

export async function fetchServerContinueWatchingEntries() {
  const state = await fetchServerContinueWatchingState();
  return state.entries;
}

export async function removeContinueWatchingEntry(sourceIdentity, seriesId = "") {
  const normalizedSource = String(sourceIdentity || "").trim();
  if (!normalizedSource) return;
  const normalizedSeriesId =
    String(seriesId || "")
      .trim()
      .toLowerCase() ||
    extractSeriesIdFromSourceIdentity(normalizedSource);
  const parsedTmdbSource = parseTmdbSourceIdentity(normalizedSource);
  const serverDeletes = [];

  try {
    serverDeletes.push(
      ...removeResumeEntriesForSource(
        normalizedSource,
        normalizedSeriesId,
        parsedTmdbSource,
      ),
    );

    const metaMap = readContinueWatchingMetaMap();
    if (metaMap && typeof metaMap === "object") {
      removeContinueMetaEntriesForSource(
        metaMap,
        normalizedSource,
        normalizedSeriesId,
        parsedTmdbSource,
      );

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

    removeLocalTitleTrackPreferences(
      parsedTmdbSource.tmdbId,
      parsedTmdbSource.mediaType,
    );
  } catch {
    // Ignore storage access issues.
  }

  void clearServerTitleMemory(
    parsedTmdbSource.tmdbId,
    parsedTmdbSource.mediaType,
  );

  serverDeletes.push(fetch("/api/user/continue-watching", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceIdentity: normalizedSource,
      seriesId: normalizedSeriesId,
    }),
  }).catch(() => {}));

  await Promise.allSettled(serverDeletes);
}

export function normalizeLocalAssetPathForCompare(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  return normalized.replace(/^\/+/, "");
}

export function normalizeLocalMovieDisplayTitle(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "Uploaded Movie";
  }
  const deTagged = raw
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[._]+/g, " ");
  const trimmedToYear = deTagged.split(/\b(19|20)\d{2}\b/)[0] || deTagged;
  const stripped = trimmedToYear
    .replace(
      /\b(2160p|1080p|720p|4k|web[- ]?dl|web|bluray|bdrip|bdremux|remux|x264|x265|h\.?264|h\.?265|hevc|hdr|10bit|aac(?:5\.1)?|ddp?\d\.\d|yts|mx)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  return stripped || raw;
}

export function getContinueWatchingEntries() {
  const entriesBySource = new Map();
  const metaMap = readContinueWatchingMetaMap();

  Object.entries(metaMap).forEach(([sourceIdentity, value]) => {
    const normalizedSource = String(sourceIdentity || "").trim();
    if (!normalizedSource || typeof value !== "object" || value === null) {
      return;
    }

    const resumeSeconds = getStoredResumeSecondsForSource(
      normalizedSource,
      Number(value.resumeSeconds) || 0,
    );
    if (!Number.isFinite(resumeSeconds) || resumeSeconds < 1) {
      return;
    }

    const parsedTmdbSource = parseTmdbSourceIdentity(normalizedSource);
    const tmdbSeriesId =
      parsedTmdbSource.mediaType === "tv" && parsedTmdbSource.tmdbId
        ? `tmdb-tv-${parsedTmdbSource.tmdbId}`
        : "";
    const normalizedEntry = normalizeLocalContinueEntry({
      sourceIdentity: normalizedSource,
      resumeSeconds,
      updatedAt: Number(value.updatedAt) || 0,
      title: String(value.title || "").trim(),
      episode: String(value.episode || "").trim(),
      src: String(value.src || "").trim(),
      tmdbId:
        String(value.tmdbId || "").trim() || parsedTmdbSource.tmdbId,
      mediaType: inferContinueMediaType(
        normalizedSource,
        String(value.mediaType || "").trim(),
        String(value.seriesId || "").trim(),
      ),
      seriesId: String(value.seriesId || "").trim() || tmdbSeriesId,
      episodeIndex: Number.isFinite(Number(value.episodeIndex))
        ? Math.max(0, Math.floor(Number(value.episodeIndex)))
        : parsedTmdbSource.mediaType === "tv" &&
            parsedTmdbSource.episodeNumber > 0
          ? parsedTmdbSource.episodeNumber - 1
          : -1,
      seasonNumber: Number.isFinite(Number(value.seasonNumber))
        ? Math.max(0, Math.floor(Number(value.seasonNumber)))
        : parsedTmdbSource.seasonNumber,
      episodeNumber: Number.isFinite(Number(value.episodeNumber))
        ? Math.max(0, Math.floor(Number(value.episodeNumber)))
        : parsedTmdbSource.episodeNumber,
      year: String(value.year || "").trim(),
      thumb: String(value.thumb || "").trim(),
      sourceHash: value.sourceHash,
      sessionKey: value.sessionKey,
      resolverProvider: value.resolverProvider,
      sourceInput: value.sourceInput,
      filename: value.filename,
    });
    addContinueEntryToMap(entriesBySource, normalizedEntry);
  });

  const knownSrcPaths = new Set();
  for (const entry of entriesBySource.values()) {
    const src = normalizeLocalAssetPathForCompare(entry.src || "");
    if (src) {
      knownSrcPaths.add(src);
    }
  }

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key || !key.startsWith(RESUME_STORAGE_PREFIX)) {
      continue;
    }

    const sourceIdentity = key.slice(RESUME_STORAGE_PREFIX.length).trim();
    const dedupeCandidateKey = getContinueDedupeKey(sourceIdentity);
    if (!sourceIdentity || entriesBySource.has(dedupeCandidateKey)) {
      continue;
    }

    const normalizedOrphanPath = normalizeLocalAssetPathForCompare(sourceIdentity);
    if (normalizedOrphanPath && knownSrcPaths.has(normalizedOrphanPath)) {
      continue;
    }

    const resumeSeconds = Number(localStorage.getItem(key));
    if (!Number.isFinite(resumeSeconds) || resumeSeconds < 1) {
      continue;
    }

    const parsedTmdbSource = parseTmdbSourceIdentity(sourceIdentity);
    const tmdbId = String(parsedTmdbSource.tmdbId || "").trim();
    const seriesMatch = /^series:([^:]+):episode:(\d+)$/i.exec(sourceIdentity);
    const inferredSeriesId = seriesMatch
      ? String(seriesMatch[1] || "").trim()
      : "";
    const inferredEpisodeIndex = seriesMatch ? Number(seriesMatch[2]) : -1;
    const hasLocalMediaSource = isLikelyLocalMediaSource(sourceIdentity);

    if (!tmdbId && !inferredSeriesId && !hasLocalMediaSource) {
      continue;
    }

    const normalizedEntry = normalizeLocalContinueEntry({
      sourceIdentity,
      resumeSeconds,
      updatedAt: 0,
      title: tmdbId
        ? parsedTmdbSource.mediaType === "tv"
          ? "Series"
          : "Movie"
        : hasLocalMediaSource
          ? normalizeLocalMovieDisplayTitle(sourceIdentity)
          : "Continue Watching",
      episode: "",
      src: hasLocalMediaSource ? sourceIdentity : "",
      tmdbId,
      mediaType: hasLocalMediaSource
        ? "movie"
        : inferContinueMediaType(
            sourceIdentity,
            parsedTmdbSource.mediaType,
            inferredSeriesId,
          ),
      seriesId:
        inferredSeriesId ||
        (parsedTmdbSource.mediaType === "tv" && tmdbId
          ? `tmdb-tv-${tmdbId}`
          : ""),
      episodeIndex: Number.isFinite(inferredEpisodeIndex)
        ? Math.max(0, Math.floor(inferredEpisodeIndex))
        : parsedTmdbSource.mediaType === "tv" && parsedTmdbSource.episodeNumber > 0
          ? parsedTmdbSource.episodeNumber - 1
          : -1,
      seasonNumber: parsedTmdbSource.seasonNumber,
      episodeNumber: parsedTmdbSource.episodeNumber,
      year: "",
      thumb: "",
    });
    addContinueEntryToMap(entriesBySource, normalizedEntry);
  }

  return sortAndLimitContinueEntries(entriesBySource.values());
}

export function enrichContinueEntriesWithLocalLibrary(entries, localLibrary) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  const movies = Array.isArray(localLibrary?.movies) ? localLibrary.movies : [];
  const seriesList = Array.isArray(localLibrary?.series) ? localLibrary.series : [];

  const localMoviesBySrc = new Map();
  const localMoviesByTmdb = new Map();
  movies.forEach((movie) => {
    const src = normalizeLocalAssetPathForCompare(movie?.src || "");
    if (src) {
      localMoviesBySrc.set(src, movie);
    }
    const tmdbId = String(movie?.tmdbId || "").trim();
    if (src && tmdbId) {
      localMoviesByTmdb.set(tmdbId, movie);
    }
  });

  const localSeriesById = new Map();
  seriesList.forEach((series) => {
    const id = String(series?.id || "")
      .trim()
      .toLowerCase();
    if (!id) {
      return;
    }
    localSeriesById.set(id, series);
  });

  return safeEntries.map((entry) => {
    const normalizedSeriesId = String(
      entry?.seriesId || extractSeriesIdFromSourceIdentity(entry?.sourceIdentity || ""),
    )
      .trim()
      .toLowerCase();
    if (normalizedSeriesId && localSeriesById.has(normalizedSeriesId)) {
      const series = localSeriesById.get(normalizedSeriesId);
      const episodes = Array.isArray(series?.episodes) ? series.episodes : [];
      const episodeIndex = Number.isFinite(Number(entry?.episodeIndex))
        ? Math.max(0, Math.floor(Number(entry.episodeIndex)))
        : 0;
      const episodeEntry = episodes[episodeIndex] || episodes[0] || null;
      return {
        ...entry,
        mediaType: "tv",
        seriesId: String(series?.id || entry?.seriesId || "").trim(),
        title:
          String(series?.title || "").trim() ||
          String(entry?.title || "").trim(),
        year: String(series?.year || entry?.year || "").trim(),
        src: String(episodeEntry?.src || entry?.src || "").trim(),
        thumb: String(episodeEntry?.thumb || entry?.thumb || "").trim(),
      };
    }

    const tmdbId = String(entry?.tmdbId || "").trim();
    const sourceCandidates = [
      normalizeLocalAssetPathForCompare(entry?.src || ""),
      normalizeLocalAssetPathForCompare(entry?.sourceIdentity || ""),
    ].filter(Boolean);
    const localMovieMatch =
      localMoviesByTmdb.get(tmdbId) ||
      sourceCandidates.map((candidate) => localMoviesBySrc.get(candidate)).find(Boolean);
    if (!localMovieMatch) {
      return entry;
    }

    return {
      ...entry,
      mediaType: "movie",
      title:
        String(localMovieMatch?.title || "").trim() ||
        String(entry?.title || "").trim(),
      year: String(localMovieMatch?.year || entry?.year || "").trim(),
      src: String(localMovieMatch?.src || entry?.src || "").trim(),
      thumb: String(localMovieMatch?.thumb || entry?.thumb || "").trim(),
    };
  });
}

export function getFallbackThumbnailForSource(sourceValue) {
  const normalizedSource = normalizeLocalAssetPathForCompare(sourceValue || "");
  if (!normalizedSource) {
    return "";
  }
  const normalizedPrideSource = normalizeLocalAssetPathForCompare(
    PRIDE_PREJUDICE_SOURCE,
  );
  if (
    normalizedSource === normalizedPrideSource ||
    /pride[-._ ]?prejudice/i.test(normalizedSource)
  ) {
    return PRIDE_PREJUDICE_THUMBNAIL;
  }
  return "";
}

export function normalizeArtworkPath(value, fallbackValue = DEFAULT_LOCAL_THUMBNAIL) {
  const raw = String(value || "").trim();
  const fallback = String(fallbackValue || DEFAULT_LOCAL_THUMBNAIL).trim() || DEFAULT_LOCAL_THUMBNAIL;
  const candidate = raw || fallback;
  if (!candidate) {
    return `/${DEFAULT_LOCAL_THUMBNAIL}`;
  }
  if (/^(https?:)?\/\//i.test(candidate) || candidate.startsWith("/")) {
    return candidate;
  }
  if (candidate.startsWith("assets/")) {
    return `/${candidate}`;
  }
  return candidate;
}

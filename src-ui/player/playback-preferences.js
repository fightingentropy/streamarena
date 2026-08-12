import {
  AUDIO_LANG_PREF_KEY_PREFIX,
  DEFAULT_AUDIO_LANGUAGE_PREF_KEY,
  DEFAULT_STREAM_QUALITY_PREFERENCE,
  normalizeDefaultAudioLanguage,
} from "../lib/preferences.js";

export const SUBTITLE_LANG_PREF_KEY_PREFIX = "streamarena-subtitle-lang:movie:";
export const SUBTITLE_STREAM_PREF_KEY_PREFIX = "streamarena-subtitle-stream:movie:";
export const TV_SUBTITLE_LANG_PREF_KEY_PREFIX = "streamarena-subtitle-lang:tv:";
export const TV_SUBTITLE_STREAM_PREF_KEY_PREFIX = "streamarena-subtitle-stream:tv:";
export const LOCAL_SUBTITLE_LANG_PREF_KEY_PREFIX = "streamarena-subtitle-lang:local:";
export const LOCAL_SUBTITLE_STREAM_PREF_KEY_PREFIX = "streamarena-subtitle-stream:local:";

export const supportedQualityPreferences = new Set(["auto", "2160p", "1080p", "720p"]);

export function getAudioLangPreferenceStorageKey(movieTmdbId) {
  return `${AUDIO_LANG_PREF_KEY_PREFIX}${String(movieTmdbId || "").trim()}`;
}

export function getStoredDefaultAudioLanguage() {
  try {
    return normalizeDefaultAudioLanguage(
      localStorage.getItem(DEFAULT_AUDIO_LANGUAGE_PREF_KEY),
    );
  } catch {
    return "en";
  }
}

export function normalizePreferredQuality(value) {
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

export function shouldIncludePreferredQualityInUrl(value) {
  return Boolean(
    value &&
      value !== "auto" &&
      value !== DEFAULT_STREAM_QUALITY_PREFERENCE,
  );
}

export function isRecognizedAudioLang(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "auto" || /^[a-z]{2}$/.test(normalized);
}

export function normalizeSubtitlePreference(value) {
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

export function getSubtitleLangPreferenceStorageKey(movieTmdbId) {
  return `${SUBTITLE_LANG_PREF_KEY_PREFIX}${String(movieTmdbId || "").trim()}`;
}

export function getSubtitleStreamPreferenceStorageKey(movieTmdbId) {
  return `${SUBTITLE_STREAM_PREF_KEY_PREFIX}${String(movieTmdbId || "").trim()}`;
}

export function getTvSubtitlePreferenceKey(tmdbId, seasonNumber, episodeNumber) {
  const safeTmdbId = String(tmdbId || "").trim();
  if (!safeTmdbId) {
    return "";
  }
  const safeSeason = Math.max(1, Math.floor(Number(seasonNumber) || 1));
  const safeEpisode = Math.max(1, Math.floor(Number(episodeNumber) || 1));
  return `${safeTmdbId}:s${safeSeason}:e${safeEpisode}`;
}

export function getTvSubtitleLangPreferenceStorageKey(tvKey) {
  return `${TV_SUBTITLE_LANG_PREF_KEY_PREFIX}${String(tvKey || "").trim()}`;
}

export function getTvSubtitleStreamPreferenceStorageKey(tvKey) {
  return `${TV_SUBTITLE_STREAM_PREF_KEY_PREFIX}${String(tvKey || "").trim()}`;
}

export function getLocalSubtitlePreferenceSourceKey({
  isExplicitLocalUploadSource,
  isSeriesPlayback,
  activeSeries,
  seriesEpisodeIndex,
  src,
}) {
  if (!isExplicitLocalUploadSource) {
    return "";
  }
  if (isSeriesPlayback && activeSeries?.id) {
    return `series:${String(activeSeries.id).trim().toLowerCase()}:episode:${Math.max(0, Math.floor(Number(seriesEpisodeIndex) || 0))}`;
  }
  return String(src || "").trim();
}

export function getLocalSubtitleLangPreferenceStorageKey(sourceKey) {
  return `${LOCAL_SUBTITLE_LANG_PREF_KEY_PREFIX}${String(sourceKey || "").trim()}`;
}

export function getLocalSubtitleStreamPreferenceStorageKey(sourceKey) {
  return `${LOCAL_SUBTITLE_STREAM_PREF_KEY_PREFIX}${String(sourceKey || "").trim()}`;
}

export function resolveSubtitlePreferenceStorageTarget({
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
}) {
  if (isTmdbMoviePlayback && tmdbId) {
    return { scope: "movie", key: String(tmdbId || "").trim() };
  }

  if (isTmdbTvPlayback && tmdbId) {
    const tvKey = getTvSubtitlePreferenceKey(tmdbId, seasonNumber, episodeNumber);
    if (tvKey) {
      return { scope: "tv", key: tvKey };
    }
  }

  const localSourceKey = getLocalSubtitlePreferenceSourceKey({
    isExplicitLocalUploadSource,
    isSeriesPlayback,
    activeSeries,
    seriesEpisodeIndex,
    src,
  });
  if (localSourceKey) {
    return { scope: "local", key: localSourceKey };
  }

  return null;
}

export function getSubtitleLangPreferenceStorageKeyForTarget(target) {
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

export function getSubtitleStreamPreferenceStorageKeyForTarget(target) {
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

export function getStoredSubtitleStreamPreferenceForTarget(target) {
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

export function getStoredSubtitleLangForTarget(target) {
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

export function getStoredSubtitleStreamPreferenceForTmdbMovie(movieTmdbId) {
  const normalizedTmdbId = String(movieTmdbId || "").trim();
  if (!normalizedTmdbId) {
    return { mode: "unset", streamIndex: -1 };
  }
  return getStoredSubtitleStreamPreferenceForTarget({
    scope: "movie",
    key: normalizedTmdbId,
  });
}

export function getStoredSubtitleLangForTmdbMovie(movieTmdbId) {
  const normalizedTmdbId = String(movieTmdbId || "").trim();
  if (!normalizedTmdbId) {
    return "";
  }
  return getStoredSubtitleLangForTarget({
    scope: "movie",
    key: normalizedTmdbId,
  });
}

export function persistSubtitleLangPreferenceForTarget(target, lang) {
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

export function persistSubtitleStreamPreferenceForTarget(target, streamIndex) {
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

export function getStoredAudioLangForTmdbMovie(movieTmdbId) {
  const normalizedTmdbId = String(movieTmdbId || "").trim();
  if (!normalizedTmdbId) {
    return "auto";
  }

  try {
    const raw = String(
      localStorage.getItem(getAudioLangPreferenceStorageKey(normalizedTmdbId)) ||
        "",
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

export function persistAudioLangPreference(movieTmdbId, lang) {
  const normalizedTmdbId = String(movieTmdbId || "").trim();
  if (!normalizedTmdbId) {
    return;
  }

  const normalizedLang = isRecognizedAudioLang(String(lang || "").toLowerCase())
    ? String(lang).toLowerCase()
    : "auto";
  const key = getAudioLangPreferenceStorageKey(normalizedTmdbId);

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

// ---------------------------------------------------------------------------
// Shared preference normalization helpers.
// These functions are used across settings, player, home, and new-popular pages.
// ---------------------------------------------------------------------------

import {
  STREAM_QUALITY_PREF_KEY,
  supportedStreamQualityPreferences,
} from "../shared.js";

// --- Constants ---

export const DEFAULT_STREAM_QUALITY_PREFERENCE = "1080p";
export const DEFAULT_SUBTITLE_COLOR = "#b8bcc3";

export const AUDIO_LANG_PREF_KEY_PREFIX = "netflix-audio-lang:movie:";
export const DEFAULT_AUDIO_LANGUAGE_PREF_KEY = "netflix-default-audio-lang";
export const SOURCE_MIN_SEEDERS_PREF_KEY = "netflix-source-filter-min-seeders";
export const SOURCE_AUDIO_PROFILE_PREF_KEY =
  "netflix-source-filter-audio-profile";
export const REMUX_VIDEO_MODE_PREF_KEY = "netflix-remux-video-mode";
export const SUBTITLE_COLOR_PREF_KEY = "netflix-subtitle-color-pref";

export const supportedAudioLangs = new Set([
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

export const supportedDefaultAudioLanguages = new Set([
  "auto",
  "en",
  "ja",
  "ko",
  "zh",
  "fr",
  "es",
  "de",
  "it",
  "pt",
  "nl",
  "ro",
]);

// --- Normalization functions ---

export function normalizeStreamQualityPreference(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return DEFAULT_STREAM_QUALITY_PREFERENCE;
  if (normalized === "4k" || normalized === "uhd") return "2160p";
  if (normalized === "2160") return "2160p";
  if (normalized === "1080") return "1080p";
  if (normalized === "720") return "720p";
  if (supportedStreamQualityPreferences.has(normalized)) return normalized;
  return DEFAULT_STREAM_QUALITY_PREFERENCE;
}

export function normalizeDefaultAudioLanguage(value) {
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
  if (supportedDefaultAudioLanguages.has(normalized)) {
    return normalized;
  }
  return "en";
}

export function normalizeSourceMinSeeders(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(50000, Math.floor(parsed)));
}

export function normalizeSourceAudioProfile(value) {
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
  return "single";
}

export function normalizeRemuxVideoMode(value) {
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

export function normalizeSubtitleColor(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(raw)) return raw;
  if (/^#[0-9a-f]{3}$/.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
  }
  return DEFAULT_SUBTITLE_COLOR;
}

// --- localStorage getters ---

export function getStoredStreamQualityPreference() {
  try {
    return normalizeStreamQualityPreference(
      localStorage.getItem(STREAM_QUALITY_PREF_KEY),
    );
  } catch {
    return DEFAULT_STREAM_QUALITY_PREFERENCE;
  }
}

export function getStoredAudioLangForTmdbMovie(tmdbId) {
  const normalizedTmdbId = String(tmdbId || "").trim();
  if (!normalizedTmdbId) {
    return "auto";
  }
  try {
    const raw = String(
      localStorage.getItem(
        `${AUDIO_LANG_PREF_KEY_PREFIX}${normalizedTmdbId}`,
      ) || "",
    )
      .trim()
      .toLowerCase();
    if (supportedAudioLangs.has(raw)) {
      return raw;
    }
  } catch {
    // Ignore localStorage failures.
  }
  return "auto";
}

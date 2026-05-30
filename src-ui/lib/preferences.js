// ---------------------------------------------------------------------------
// Shared preference normalization helpers.
// These functions are used across settings, player, and home pages.
// ---------------------------------------------------------------------------

// --- Constants ---

export const DEFAULT_STREAM_QUALITY_PREFERENCE = "1080p";
export const DEFAULT_SUBTITLE_COLOR = "#b8bcc3";

export const AUDIO_LANG_PREF_KEY_PREFIX = "netflix-audio-lang:movie:";
export const DEFAULT_AUDIO_LANGUAGE_PREF_KEY = "netflix-default-audio-lang";
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

/**
 * Pure presentation helpers for embedded and external media tracks.
 *
 * Keeping these decisions outside the player page makes the labels used by the
 * controls independently testable and prevents track metadata quirks from
 * leaking into playback state management.
 */

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

export function getLanguageDisplayLabel(langCode) {
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

export function isLikelyForcedSubtitleTrack(track) {
  const labelText = String(track?.label || "").toLowerCase();
  const titleText = String(track?.title || "").toLowerCase();
  const combined = `${labelText} ${titleText}`;
  return (
    combined.includes("forced") ||
    combined.includes("foreign") ||
    combined.includes("sign")
  );
}

export function getSubtitleTrackDisplayLabel(track) {
  return getLanguageDisplayLabel(track?.language || "en");
}

export function getSubtitleTrackDisplayParts(track) {
  const languageLabel = getLanguageDisplayLabel(track?.language || "en");
  const secondaryParts = [];
  if (isLikelyForcedSubtitleTrack(track)) {
    secondaryParts.push("Forced");
  }
  return {
    primary: languageLabel,
    secondary: secondaryParts.join(" • "),
  };
}

export function getAudioTrackDisplayLabel(track) {
  const { primary } = getAudioTrackDisplayParts(track);
  return primary;
}

export function getAudioTrackDisplayParts(track) {
  const languageLabel = getLanguageDisplayLabel(track?.language || "und");
  return {
    primary: languageLabel,
    secondary: "",
  };
}

export function getUnknownAudioTrackDisplayLabel() {
  return "Default";
}

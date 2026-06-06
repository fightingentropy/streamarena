import {
  DEFAULT_SUBTITLE_COLOR,
  SUBTITLE_COLOR_PREF_KEY,
  normalizeSubtitleColor,
} from "../lib/preferences.js";
import { setRuntimeStyleRule } from "../lib/runtime-styles.js";

function getStoredSubtitleColorPreference() {
  try {
    return normalizeSubtitleColor(
      localStorage.getItem(SUBTITLE_COLOR_PREF_KEY),
    );
  } catch {
    return DEFAULT_SUBTITLE_COLOR;
  }
}

export function applySubtitleCueColor(
  colorValue = getStoredSubtitleColorPreference(),
) {
  const normalizedColor = normalizeSubtitleColor(colorValue);
  const legacyStyleElement = document.getElementById("subtitleCueColorStyle");
  if (legacyStyleElement instanceof HTMLStyleElement) {
    legacyStyleElement.remove();
  }

  setRuntimeStyleRule(".custom-subtitle-overlay", { color: normalizedColor });
  setRuntimeStyleRule("#playerVideo::cue", {
    color: normalizedColor,
    background: "transparent !important",
    "background-color": "transparent !important",
    "box-shadow": "none !important",
    outline: "none !important",
    "text-shadow": "none !important",
  });
  setRuntimeStyleRule("#playerVideo::cue(*)", {
    background: "transparent !important",
    "background-color": "transparent !important",
    "text-shadow": "none !important",
  });
  [
    "#playerVideo::-webkit-media-text-track-display",
    "#playerVideo::-webkit-media-text-track-container",
    "#playerVideo::-webkit-media-text-track-background",
    "#playerVideo::-webkit-media-text-track-region",
    "#playerVideo::-webkit-media-text-track-display-backdrop",
    "#playerVideo::cue-region",
  ].forEach((selector) => {
    setRuntimeStyleRule(selector, {
      background: "transparent !important",
      "background-color": "transparent !important",
    });
  });
  setRuntimeStyleRule("#playerVideo::-webkit-media-text-track-cue", {
    background: "transparent !important",
    "background-color": "transparent !important",
    "text-shadow": "none !important",
  });
}

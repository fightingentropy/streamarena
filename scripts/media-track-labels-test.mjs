#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  getAudioTrackDisplayLabel,
  getAudioTrackDisplayParts,
  getLanguageDisplayLabel,
  getSubtitleTrackDisplayLabel,
  getSubtitleTrackDisplayParts,
  getUnknownAudioTrackDisplayLabel,
  isLikelyForcedSubtitleTrack,
  isLikelyTranslatedSubtitleTrack,
  shouldPreferResolvedTranslatedSubtitleTrack,
} from "../src-ui/player/media-track-labels.js";

const cases = [
  ["known language", () => getLanguageDisplayLabel(" EN "), "English"],
  ["unknown language", () => getLanguageDisplayLabel("fil"), "FIL"],
  ["empty language", () => getLanguageDisplayLabel(""), "Unknown"],
  ["forced subtitle by label", () => isLikelyForcedSubtitleTrack({ label: "English Forced" }), true],
  ["forced subtitle by title", () => isLikelyForcedSubtitleTrack({ title: "Foreign parts" }), true],
  ["regular subtitle", () => isLikelyForcedSubtitleTrack({ label: "English CC" }), false],
  ["translated subtitle", () => isLikelyTranslatedSubtitleTrack({ label: "English Translated" }), true],
  [
    "translated subtitle supersedes stale provider track",
    () =>
      shouldPreferResolvedTranslatedSubtitleTrack(
        { language: "en", label: "English (OpenSubtitles)" },
        { language: "en", label: "English Translated (OpenSubtitles)" },
      ),
    true,
  ],
  ["subtitle display fallback", () => getSubtitleTrackDisplayLabel({}), "English"],
  ["forced subtitle parts", () => getSubtitleTrackDisplayParts({ language: "fr", label: "Forced" }), { primary: "French", secondary: "Forced" }],
  ["translated subtitle parts", () => getSubtitleTrackDisplayParts({ language: "en", label: "English Translated (OpenSubtitles)" }), { primary: "English", secondary: "Translated dialogue" }],
  ["regular subtitle parts", () => getSubtitleTrackDisplayParts({ language: "de" }), { primary: "German", secondary: "" }],
  ["audio display label", () => getAudioTrackDisplayLabel({ language: "it" }), "Italian"],
  ["audio display parts", () => getAudioTrackDisplayParts({ language: "ja" }), { primary: "Japanese", secondary: "" }],
  ["unknown audio label", () => getUnknownAudioTrackDisplayLabel(), "Default"],
];

for (const [label, run, expected] of cases) {
  assert.deepEqual(run(), expected, label);
  console.log(`✓ ${label}`);
}

console.log(`\nAll media-track label tests passed (${cases.length} cases).`);

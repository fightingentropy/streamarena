import {
  STREAM_QUALITY_PREF_KEY,
  PROFILE_AVATAR_STYLE_PREF_KEY,
  PROFILE_AVATAR_MODE_PREF_KEY,
  PROFILE_AVATAR_IMAGE_PREF_KEY,
  LIBRARY_EDIT_MODE_PREF_KEY,
  supportedStreamQualityPreferences,
  supportedAvatarStyles,
  avatarStyleClassNames,
  normalizeAvatarStyle,
  normalizeAvatarMode,
  sanitizeAvatarImageData,
  getStoredAvatarStylePreference,
  getStoredAvatarModePreference,
  getStoredAvatarImagePreference,
  escapeHtml,
} from "./src-ui/shared.js";

const SUBTITLE_COLOR_PREF_KEY = "netflix-subtitle-color-pref";
const SOURCE_MIN_SEEDERS_PREF_KEY = "netflix-source-filter-min-seeders";
const SOURCE_LANGUAGE_PREF_KEY = "netflix-source-filter-language";
const SOURCE_AUDIO_PROFILE_PREF_KEY = "netflix-source-filter-audio-profile";
const DEFAULT_AUDIO_LANGUAGE_PREF_KEY = "netflix-default-audio-lang";
const REMUX_VIDEO_MODE_PREF_KEY = "netflix-remux-video-mode";

const DEFAULT_SUBTITLE_COLOR = "#b8bcc3";
const DEFAULT_AVATAR_STYLE = "blue";
const DEFAULT_AVATAR_MODE = "preset";
const DEFAULT_STREAM_QUALITY_PREFERENCE = "1080p";
const AVATAR_OUTPUT_SIZE_PX = 180;

const supportedDefaultAudioLanguages = [
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
];
const supportedSourceLanguages = ["en", "any", "fr", "es", "de", "it", "pt"];
const supportedSourceAudioProfiles = ["single", "any"];
const supportedAvatarChoices = new Set([...supportedAvatarStyles, "custom"]);

const qualityForm = document.getElementById("qualityForm");
const saveStatus = document.getElementById("saveStatus");
const subtitleColorInput = document.getElementById("subtitleColorInput");
const subtitleColorPreview = document.getElementById("subtitleColorPreview");
const subtitleColorReset = document.getElementById("subtitleColorReset");
const avatarStylePreview = document.getElementById("avatarStylePreview");
const avatarCustomThumb = document.getElementById("avatarCustomThumb");
const avatarImageInput = document.getElementById("avatarImageInput");
const avatarUploadHint = document.getElementById("avatarUploadHint");
const clearAllCachesBtn = document.getElementById("clearAllCachesBtn");
const cacheClearStatus = document.getElementById("cacheClearStatus");
const libraryEditModeToggle = document.getElementById("libraryEditModeToggle");
const libraryEditList = document.getElementById("libraryEditList");
const libraryEditStatus = document.getElementById("libraryEditStatus");
const sourceMinSeedersInput = document.getElementById("sourceMinSeeders");
const sourceLanguageSelect = document.getElementById("sourceLanguage");
const sourceAudioProfileSelect = document.getElementById("sourceAudioProfile");
const defaultAudioLanguageSelect = document.getElementById(
  "defaultAudioLanguage",
);

let pendingCustomAvatarImage = "";
let isClearingCaches = false;
let localLibraryState = { movies: [], series: [] };
let activeLibraryEditorKey = "";
let isSavingLibraryEdits = false;

function normalizeStreamQualityPreference(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return DEFAULT_STREAM_QUALITY_PREFERENCE;
  if (normalized === "4k" || normalized === "uhd") return "2160p";
  if (normalized === "2160") return "2160p";
  if (normalized === "1080") return "1080p";
  if (normalized === "720") return "720p";
  if (supportedStreamQualityPreferences.has(normalized)) {
    return normalized;
  }
  return DEFAULT_STREAM_QUALITY_PREFERENCE;
}

function getStoredStreamQualityPreference() {
  try {
    return normalizeStreamQualityPreference(
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
  const floored = Math.floor(parsed);
  return Math.max(0, Math.min(50000, floored));
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
  if (supportedDefaultAudioLanguages.includes(normalized)) {
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

function setSelectedDefaultAudioLanguage(value) {
  if (defaultAudioLanguageSelect) {
    defaultAudioLanguageSelect.value = normalizeDefaultAudioLanguage(value);
  }
}

function persistDefaultAudioLanguage(value) {
  const normalized = normalizeDefaultAudioLanguage(value);
  try {
    if (normalized === "en") {
      localStorage.removeItem(DEFAULT_AUDIO_LANGUAGE_PREF_KEY);
      return normalized;
    }
    localStorage.setItem(DEFAULT_AUDIO_LANGUAGE_PREF_KEY, normalized);
    return normalized;
  } catch {
    return normalized;
  }
}

function getDefaultAudioLanguageLabel(value) {
  const normalized = normalizeDefaultAudioLanguage(value);
  const labels = {
    auto: "Auto / source default",
    en: "English",
    ja: "Japanese",
    ko: "Korean",
    zh: "Chinese",
    fr: "French",
    es: "Spanish",
    de: "German",
    it: "Italian",
    pt: "Portuguese",
    nl: "Dutch",
    ro: "Romanian",
  };
  return labels[normalized] || "English";
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
  if (supportedSourceLanguages.includes(normalized)) {
    return normalized;
  }
  return "en";
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
  if (supportedSourceAudioProfiles.includes(normalized)) {
    return normalized;
  }
  return "single";
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

function setSelectedRemuxVideoMode(value) {
  const normalized = normalizeRemuxVideoMode(value);
  const input = qualityForm?.querySelector(
    `input[name="remuxVideoMode"][value="${normalized}"]`,
  );
  if (input) {
    input.checked = true;
  }
}

function persistRemuxVideoMode(value) {
  const normalized = normalizeRemuxVideoMode(value);
  try {
    if (normalized === "auto") {
      localStorage.removeItem(REMUX_VIDEO_MODE_PREF_KEY);
      return normalized;
    }
    localStorage.setItem(REMUX_VIDEO_MODE_PREF_KEY, normalized);
    return normalized;
  } catch {
    return normalized;
  }
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

function getStoredSourceAudioProfile() {
  try {
    return normalizeSourceAudioProfile(
      localStorage.getItem(SOURCE_AUDIO_PROFILE_PREF_KEY),
    );
  } catch {
    return "single";
  }
}

function setSelectedSourceFilters(
  minSeeders = 0,
  sourceLanguage = "en",
  sourceAudioProfile = "single",
) {
  const safeMinSeeders = normalizeSourceMinSeeders(minSeeders);
  const safeSourceLanguage = normalizeSourceLanguage(sourceLanguage);
  const safeSourceAudioProfile = normalizeSourceAudioProfile(sourceAudioProfile);

  if (sourceMinSeedersInput) {
    sourceMinSeedersInput.value = String(safeMinSeeders);
  }
  if (sourceLanguageSelect) {
    sourceLanguageSelect.value = safeSourceLanguage;
  }
  if (sourceAudioProfileSelect) {
    sourceAudioProfileSelect.value = safeSourceAudioProfile;
  }
}

function persistSourceMinSeeders(value) {
  const normalized = normalizeSourceMinSeeders(value);
  try {
    if (normalized <= 0) {
      localStorage.removeItem(SOURCE_MIN_SEEDERS_PREF_KEY);
      return 0;
    }
    localStorage.setItem(SOURCE_MIN_SEEDERS_PREF_KEY, String(normalized));
    return normalized;
  } catch {
    return normalized;
  }
}

function persistSourceLanguage(value) {
  const normalized = normalizeSourceLanguage(value);
  try {
    if (normalized === "en") {
      localStorage.removeItem(SOURCE_LANGUAGE_PREF_KEY);
      return normalized;
    }
    localStorage.setItem(SOURCE_LANGUAGE_PREF_KEY, normalized);
    return normalized;
  } catch {
    return normalized;
  }
}

function persistSourceAudioProfile(value) {
  const normalized = normalizeSourceAudioProfile(value);
  try {
    if (normalized === "single") {
      localStorage.removeItem(SOURCE_AUDIO_PROFILE_PREF_KEY);
      return normalized;
    }
    localStorage.setItem(SOURCE_AUDIO_PROFILE_PREF_KEY, normalized);
    return normalized;
  } catch {
    return normalized;
  }
}

function getSourceLanguageLabel(value) {
  const normalized = normalizeSourceLanguage(value);
  const labels = {
    en: "English only",
    any: "Any language",
    fr: "French",
    es: "Spanish",
    de: "German",
    it: "Italian",
    pt: "Portuguese",
  };
  return labels[normalized] || "English only";
}

function getSourceAudioProfileLabel(value) {
  const normalized = normalizeSourceAudioProfile(value);
  const labels = {
    single: "Single-audio preferred",
    any: "Multi-audio allowed",
  };
  return labels[normalized] || "Single-audio preferred";
}

function clearDeprecatedSourcePreferenceStorage() {
  const deprecatedKeys = [
    "netflix-source-filter-allowed-formats",
    "netflix-source-filter-results-limit",
  ];
  try {
    deprecatedKeys.forEach((key) => localStorage.removeItem(key));
  } catch {
    // Ignore storage access issues.
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

function setSelectedSubtitleColor(value) {
  const normalized = normalizeSubtitleColor(value);
  if (subtitleColorInput) {
    subtitleColorInput.value = normalized;
  }
  if (subtitleColorPreview) {
    subtitleColorPreview.style.color = normalized;
  }
}

function persistSubtitleColorPreference(value) {
  const normalized = normalizeSubtitleColor(value);
  try {
    if (normalized === DEFAULT_SUBTITLE_COLOR) {
      localStorage.removeItem(SUBTITLE_COLOR_PREF_KEY);
      return normalized;
    }
    localStorage.setItem(SUBTITLE_COLOR_PREF_KEY, normalized);
    return normalized;
  } catch {
    return normalized;
  }
}

function normalizeAvatarChoice(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (supportedAvatarChoices.has(normalized)) {
    return normalized;
  }
  return DEFAULT_AVATAR_STYLE;
}

function applyAvatarPreviewPreset(style) {
  if (!avatarStylePreview) {
    return;
  }

  avatarStylePreview.classList.remove("avatar-style-custom-image");
  avatarStylePreview.style.removeProperty("--avatar-image");
  avatarStylePreview.style.removeProperty("backgroundImage");
  avatarStyleClassNames.forEach((className) =>
    avatarStylePreview.classList.remove(className),
  );
  avatarStylePreview.classList.add(
    `avatar-style-${normalizeAvatarStyle(style)}`,
  );
}

function applyAvatarPreviewCustom(imageData) {
  if (!avatarStylePreview) {
    return;
  }

  avatarStyleClassNames.forEach((className) =>
    avatarStylePreview.classList.remove(className),
  );
  avatarStylePreview.classList.add("avatar-style-custom-image");
  avatarStylePreview.style.setProperty("--avatar-image", `url("${imageData}")`);
  avatarStylePreview.style.backgroundImage = `var(--avatar-image)`;
}

function applyAvatarCustomThumb(imageData) {
  if (!avatarCustomThumb) {
    return;
  }

  if (imageData) {
    avatarCustomThumb.classList.add("avatar-style-custom-image");
    avatarCustomThumb.style.setProperty(
      "--avatar-image",
      `url("${imageData}")`,
    );
    avatarCustomThumb.style.backgroundImage = "var(--avatar-image)";
    return;
  }

  avatarCustomThumb.classList.remove("avatar-style-custom-image");
  avatarCustomThumb.style.removeProperty("--avatar-image");
  avatarCustomThumb.style.removeProperty("backgroundImage");
}

function setSelectedAvatarChoice(
  choiceValue,
  customImage = pendingCustomAvatarImage,
) {
  const choice = normalizeAvatarChoice(choiceValue);
  const input = qualityForm?.querySelector(
    `input[name="avatarStyle"][value="${choice}"]`,
  );
  if (input) {
    input.checked = true;
  }

  const safeCustomImage = sanitizeAvatarImageData(customImage);
  applyAvatarCustomThumb(safeCustomImage);

  if (choice === "custom" && safeCustomImage) {
    applyAvatarPreviewCustom(safeCustomImage);
    return;
  }

  const fallbackStyle =
    choice === "custom" ? getStoredAvatarStylePreference() : choice;
  applyAvatarPreviewPreset(fallbackStyle);
}

function persistAvatarStylePreference(styleValue) {
  const style = normalizeAvatarStyle(styleValue);
  try {
    if (style === DEFAULT_AVATAR_STYLE) {
      localStorage.removeItem(PROFILE_AVATAR_STYLE_PREF_KEY);
      return style;
    }
    localStorage.setItem(PROFILE_AVATAR_STYLE_PREF_KEY, style);
    return style;
  } catch {
    return style;
  }
}

function persistAvatarModePreference(modeValue) {
  const mode = normalizeAvatarMode(modeValue);
  try {
    if (mode === DEFAULT_AVATAR_MODE) {
      localStorage.removeItem(PROFILE_AVATAR_MODE_PREF_KEY);
      return mode;
    }
    localStorage.setItem(PROFILE_AVATAR_MODE_PREF_KEY, mode);
    return mode;
  } catch {
    return mode;
  }
}

function persistAvatarImagePreference(imageData) {
  const safeImage = sanitizeAvatarImageData(imageData);
  try {
    if (!safeImage) {
      localStorage.removeItem(PROFILE_AVATAR_IMAGE_PREF_KEY);
      return "";
    }
    localStorage.setItem(PROFILE_AVATAR_IMAGE_PREF_KEY, safeImage);
    return safeImage;
  } catch {
    return "";
  }
}

function getAvatarChoiceDisplayLabel(choiceValue) {
  const choice = normalizeAvatarChoice(choiceValue);
  if (choice === "custom") {
    return "Custom image";
  }

  const labels = {
    blue: "Blue",
    crimson: "Crimson",
    emerald: "Emerald",
    violet: "Violet",
    amber: "Amber",
  };
  return labels[choice] || "Blue";
}

function setSelectedQuality(value) {
  const normalized = normalizeStreamQualityPreference(value);
  const input = qualityForm?.querySelector(
    `input[name="quality"][value="${normalized}"]`,
  );
  if (input) {
    input.checked = true;
  }
}

function persistSelectedQuality(value) {
  const normalized = normalizeStreamQualityPreference(value);
  try {
    if (normalized === DEFAULT_STREAM_QUALITY_PREFERENCE) {
      localStorage.removeItem(STREAM_QUALITY_PREF_KEY);
      return normalized;
    }
    localStorage.setItem(STREAM_QUALITY_PREF_KEY, normalized);
    return normalized;
  } catch {
    return normalized;
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Unable to read image file."));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to decode image."));
    image.src = dataUrl;
  });
}

async function convertFileToAvatarImage(file) {
  if (!file || !String(file.type || "").startsWith("image/")) {
    throw new Error("Please choose an image file.");
  }

  const dataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(dataUrl);
  const sourceWidth = Number(image.naturalWidth || image.width || 0);
  const sourceHeight = Number(image.naturalHeight || image.height || 0);
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error("Image size is invalid.");
  }

  const cropSize = Math.min(sourceWidth, sourceHeight);
  const sourceX = Math.floor((sourceWidth - cropSize) / 2);
  const sourceY = Math.floor((sourceHeight - cropSize) / 2);
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_OUTPUT_SIZE_PX;
  canvas.height = AVATAR_OUTPUT_SIZE_PX;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas context unavailable.");
  }

  context.clearRect(0, 0, AVATAR_OUTPUT_SIZE_PX, AVATAR_OUTPUT_SIZE_PX);
  context.drawImage(
    image,
    sourceX,
    sourceY,
    cropSize,
    cropSize,
    0,
    0,
    AVATAR_OUTPUT_SIZE_PX,
    AVATAR_OUTPUT_SIZE_PX,
  );

  let output = canvas.toDataURL("image/webp", 0.9);
  if (!output.startsWith("data:image/")) {
    output = canvas.toDataURL("image/png");
  }
  const safeOutput = sanitizeAvatarImageData(output);
  if (!safeOutput) {
    throw new Error("Image is too large to save.");
  }
  return safeOutput;
}

function readStoredLibraryEditMode() {
  try {
    const value = String(localStorage.getItem(LIBRARY_EDIT_MODE_PREF_KEY) || "")
      .trim()
      .toLowerCase();
    return value === "1" || value === "true" || value === "on";
  } catch {
    return false;
  }
}

function persistLibraryEditMode(value) {
  const enabled = Boolean(value);
  try {
    if (!enabled) {
      localStorage.removeItem(LIBRARY_EDIT_MODE_PREF_KEY);
      return false;
    }
    localStorage.setItem(LIBRARY_EDIT_MODE_PREF_KEY, "1");
    return true;
  } catch {
    return enabled;
  }
}

function normalizeLibraryEditorPayload(value) {
  const payload = value && typeof value === "object" ? value : {};
  const movies = Array.isArray(payload.movies)
    ? payload.movies.filter((entry) => entry && typeof entry === "object")
    : [];
  const series = Array.isArray(payload.series)
    ? payload.series.filter((entry) => entry && typeof entry === "object")
    : [];
  return { movies, series };
}

function getLibraryEditorKey(type, index) {
  return `${String(type || "").trim().toLowerCase()}:${Math.max(0, Math.floor(Number(index) || 0))}`;
}

function normalizeLibraryEntryType(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "movie" || normalized === "series") {
    return normalized;
  }
  return "";
}

const requestedLibraryEditTarget = (() => {
  const params = new URLSearchParams(window.location.search);
  const type = normalizeLibraryEntryType(
    params.get("libraryType") || params.get("type") || "",
  );
  const id = String(params.get("libraryId") || params.get("id") || "").trim();
  const src = String(params.get("librarySrc") || params.get("src") || "").trim();
  return {
    type,
    id,
    src,
    hasTarget: Boolean(type && (id || src)),
  };
})();

function findRequestedLibraryEntry() {
  if (!requestedLibraryEditTarget.hasTarget) {
    return null;
  }

  const { type, id, src } = requestedLibraryEditTarget;
  if (type === "movie") {
    const index = localLibraryState.movies.findIndex((entry) => {
      if (id && String(entry?.id || "").trim() === id) {
        return true;
      }
      if (src && String(entry?.src || "").trim() === src) {
        return true;
      }
      return false;
    });
    if (index >= 0) {
      return {
        itemType: "movie",
        itemIndex: index,
        item: localLibraryState.movies[index],
      };
    }
    return null;
  }

  const index = localLibraryState.series.findIndex((entry) => {
    if (id && String(entry?.id || "").trim() === id) {
      return true;
    }
    if (
      src &&
      Array.isArray(entry?.episodes) &&
      entry.episodes.some((episode) => String(episode?.src || "").trim() === src)
    ) {
      return true;
    }
    return false;
  });
  if (index >= 0) {
    return {
      itemType: "series",
      itemIndex: index,
      item: localLibraryState.series[index],
    };
  }
  return null;
}

function setLibraryEditStatus(message, tone = "") {
  if (!libraryEditStatus) {
    return;
  }
  libraryEditStatus.textContent = String(message || "");
  libraryEditStatus.classList.remove("status-success", "status-error");
  if (tone === "success") {
    libraryEditStatus.classList.add("status-success");
  } else if (tone === "error") {
    libraryEditStatus.classList.add("status-error");
  }
}

async function loadLibraryForEditor() {
  if (!libraryEditList) {
    return;
  }
  setLibraryEditStatus("Loading library...");
  try {
    const response = await fetch("/api/library");
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        String(payload?.error || "Could not load library entries."),
      );
    }
    localLibraryState = normalizeLibraryEditorPayload(payload || {});
    if (requestedLibraryEditTarget.hasTarget) {
      setLibraryEditStatus("Selected title loaded.");
    } else {
      setLibraryEditStatus(
        "Edit mode is enabled. Open Home and click a title edit icon.",
      );
    }
    renderLibraryEditList();
  } catch (error) {
    localLibraryState = { movies: [], series: [] };
    renderLibraryEditList();
    setLibraryEditStatus(
      error instanceof Error ? error.message : "Could not load library entries.",
      "error",
    );
  }
}

async function persistLibraryEdits(successMessage = "Library updated.") {
  if (isSavingLibraryEdits) {
    return false;
  }
  isSavingLibraryEdits = true;
  setLibraryEditStatus("Saving library updates...");
  try {
    const response = await fetch("/api/library", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(localLibraryState),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        String(payload?.error || "Failed to save library changes."),
      );
    }
    const updatedLibrary = normalizeLibraryEditorPayload(
      payload?.library || payload || {},
    );
    localLibraryState = updatedLibrary;
    renderLibraryEditList();
    setLibraryEditStatus(successMessage, "success");
    return true;
  } catch (error) {
    setLibraryEditStatus(
      error instanceof Error ? error.message : "Failed to save library changes.",
      "error",
    );
    return false;
  } finally {
    isSavingLibraryEdits = false;
  }
}

function renderMovieEditorMarkup(item = {}) {
  return `
    <div class="library-editor" data-editor-type="movie">
      <div class="library-editor-grid">
        <div class="library-editor-field">
          <label>Title</label>
          <input data-field="title" type="text" value="${escapeHtml(item.title || "")}" />
        </div>
        <div class="library-editor-field">
          <label>Year</label>
          <input data-field="year" type="text" value="${escapeHtml(item.year || "")}" />
        </div>
        <div class="library-editor-field">
          <label>TMDB ID</label>
          <input data-field="tmdbId" type="text" value="${escapeHtml(item.tmdbId || "")}" />
        </div>
        <div class="library-editor-field">
          <label>Thumbnail</label>
          <input data-field="thumb" type="text" value="${escapeHtml(item.thumb || "")}" />
        </div>
        <div class="library-editor-field library-editor-field--full">
          <label>Source Path</label>
          <input data-field="src" type="text" value="${escapeHtml(item.src || "")}" />
        </div>
        <div class="library-editor-field library-editor-field--full">
          <label>Description</label>
          <textarea data-field="description">${escapeHtml(item.description || "")}</textarea>
        </div>
      </div>
      <div class="library-editor-actions">
        <button type="button" class="library-editor-btn" data-action="save-item">Save changes</button>
        <button type="button" class="library-editor-btn" data-action="cancel-editor">Cancel</button>
        <button type="button" class="library-editor-btn library-editor-btn--danger" data-action="delete-item">Delete title</button>
      </div>
    </div>
  `;
}

function renderSeriesEditorMarkup(item = {}) {
  const contentKind =
    String(item.contentKind || "")
      .trim()
      .toLowerCase() === "course"
      ? "course"
      : "series";
  const episodes = Array.isArray(item.episodes) ? item.episodes : [];
  const episodesMarkup = episodes
    .map((episode, index) => {
      return `
        <div class="library-episode-card" data-episode-index="${index}">
          <div class="library-episode-card-head">
            <strong>Episode ${index + 1}</strong>
            <button type="button" class="library-episode-delete-btn" data-action="delete-episode" data-episode-index="${index}">Remove</button>
          </div>
          <div class="library-editor-grid">
            <div class="library-editor-field library-editor-field--full">
              <label>Episode Title</label>
              <input data-episode-field="title" type="text" value="${escapeHtml(episode.title || "")}" />
            </div>
            <div class="library-editor-field">
              <label>Season</label>
              <input data-episode-field="seasonNumber" type="number" min="1" step="1" value="${escapeHtml(episode.seasonNumber || 1)}" />
            </div>
            <div class="library-editor-field">
              <label>Episode #</label>
              <input data-episode-field="episodeNumber" type="number" min="1" step="1" value="${escapeHtml(episode.episodeNumber || index + 1)}" />
            </div>
            <div class="library-editor-field library-editor-field--full">
              <label>Source Path</label>
              <input data-episode-field="src" type="text" value="${escapeHtml(episode.src || "")}" />
            </div>
            <div class="library-editor-field library-editor-field--full">
              <label>Thumbnail</label>
              <input data-episode-field="thumb" type="text" value="${escapeHtml(episode.thumb || "")}" />
            </div>
            <div class="library-editor-field library-editor-field--full">
              <label>Description</label>
              <textarea data-episode-field="description">${escapeHtml(episode.description || "")}</textarea>
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  return `
    <div class="library-editor" data-editor-type="series">
      <div class="library-editor-grid">
        <div class="library-editor-field">
          <label>Title</label>
          <input data-field="title" type="text" value="${escapeHtml(item.title || "")}" />
        </div>
        <div class="library-editor-field">
          <label>Year</label>
          <input data-field="year" type="text" value="${escapeHtml(item.year || "")}" />
        </div>
        <div class="library-editor-field">
          <label>TMDB ID</label>
          <input data-field="tmdbId" type="text" value="${escapeHtml(item.tmdbId || "")}" />
        </div>
        <div class="library-editor-field">
          <label>Type</label>
          <select data-field="contentKind">
            <option value="series" ${contentKind === "series" ? "selected" : ""}>Series</option>
            <option value="course" ${contentKind === "course" ? "selected" : ""}>Course</option>
          </select>
        </div>
      </div>
      <div class="library-episodes-list">
        ${episodesMarkup}
      </div>
      <div class="library-editor-actions">
        <button type="button" class="library-editor-btn" data-action="add-episode">Add episode</button>
        <button type="button" class="library-editor-btn" data-action="save-item">Save changes</button>
        <button type="button" class="library-editor-btn" data-action="cancel-editor">Cancel</button>
        <button type="button" class="library-editor-btn library-editor-btn--danger" data-action="delete-item">Delete title</button>
      </div>
    </div>
  `;
}

function renderLibraryEditList() {
  if (!libraryEditList) {
    return;
  }

  const isEditModeEnabled = Boolean(libraryEditModeToggle?.checked);
  libraryEditList.classList.toggle("is-edit-mode", isEditModeEnabled);

  if (!requestedLibraryEditTarget.hasTarget) {
    libraryEditList.innerHTML = `
      <div class="library-edit-item" role="listitem">
        <p class="library-edit-item-title">No title selected for editing.</p>
        <p class="library-edit-help">Open Home, enable edit mode, then click a title’s pencil icon to edit that specific title here.</p>
      </div>
    `;
    return;
  }

  const targetEntry = findRequestedLibraryEntry();
  if (!targetEntry) {
    libraryEditList.innerHTML = `
      <div class="library-edit-item" role="listitem">
        <p class="library-edit-item-title">Selected title not found.</p>
        <p class="library-edit-help">Go back Home and choose the title again from its edit icon.</p>
      </div>
    `;
    return;
  }

  const { itemType, itemIndex, item } = targetEntry;
  const itemKey = getLibraryEditorKey(itemType, itemIndex);
  if (isEditModeEnabled && !activeLibraryEditorKey) {
    activeLibraryEditorKey = itemKey;
  }
  const isActive = isEditModeEnabled && activeLibraryEditorKey === itemKey;
  const title =
    itemType === "movie"
      ? String(item?.title || "Untitled Movie").trim() || "Untitled Movie"
      : String(item?.title || "Untitled Series").trim() || "Untitled Series";

  if (itemType === "movie") {
    const year = String(item?.year || "").trim() || "Local";
    libraryEditList.innerHTML = `
      <div class="library-edit-item" role="listitem" data-item-type="movie" data-item-index="${itemIndex}">
        <div class="library-edit-item-head">
          <div class="library-edit-item-title-wrap">
            <p class="library-edit-item-title">${escapeHtml(title)}</p>
            <div class="library-edit-item-meta">
              <span class="library-chip">Movie</span>
              <span class="library-chip">${escapeHtml(year)}</span>
            </div>
          </div>
          <button type="button" class="library-edit-icon-btn" data-action="toggle-editor" aria-label="Edit ${escapeHtml(title)}">✎</button>
        </div>
        ${isActive ? renderMovieEditorMarkup(item) : ""}
      </div>
    `;
    return;
  }

  const contentKind =
    String(item?.contentKind || "")
      .trim()
      .toLowerCase() === "course"
      ? "Course"
      : "Series";
  const episodeCount = Array.isArray(item?.episodes) ? item.episodes.length : 0;
  libraryEditList.innerHTML = `
    <div class="library-edit-item" role="listitem" data-item-type="series" data-item-index="${itemIndex}">
      <div class="library-edit-item-head">
        <div class="library-edit-item-title-wrap">
          <p class="library-edit-item-title">${escapeHtml(title)}</p>
          <div class="library-edit-item-meta">
            <span class="library-chip">${contentKind}</span>
            <span class="library-chip">${episodeCount} episode${episodeCount === 1 ? "" : "s"}</span>
          </div>
        </div>
        <button type="button" class="library-edit-icon-btn" data-action="toggle-editor" aria-label="Edit ${escapeHtml(title)}">✎</button>
      </div>
      ${isActive ? renderSeriesEditorMarkup(item) : ""}
    </div>
  `;
}

function getEditorRootFromEventTarget(target) {
  const itemNode = target?.closest?.(".library-edit-item");
  if (!itemNode) {
    return null;
  }
  const itemType = String(itemNode.dataset.itemType || "")
    .trim()
    .toLowerCase();
  const itemIndex = Number(itemNode.dataset.itemIndex || -1);
  if (
    (itemType !== "movie" && itemType !== "series") ||
    !Number.isFinite(itemIndex) ||
    itemIndex < 0
  ) {
    return null;
  }
  return { itemNode, itemType, itemIndex };
}

function readRequiredTextInput(root, selector, message) {
  const value = String(root.querySelector(selector)?.value || "").trim();
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function readIntegerInput(root, selector, fallback) {
  const value = Number(root.querySelector(selector)?.value || fallback);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function buildMovieDraftFromEditor(itemNode, currentItem) {
  const editor = itemNode.querySelector(".library-editor");
  if (!editor) {
    throw new Error("Movie editor is unavailable.");
  }
  const title = readRequiredTextInput(
    editor,
    'input[data-field="title"]',
    "Movie title is required.",
  );
  const src = readRequiredTextInput(
    editor,
    'input[data-field="src"]',
    "Movie source path is required.",
  );
  return {
    ...currentItem,
    title,
    src,
    year: String(editor.querySelector('input[data-field="year"]')?.value || "").trim(),
    tmdbId: String(editor.querySelector('input[data-field="tmdbId"]')?.value || "").trim(),
    thumb: String(editor.querySelector('input[data-field="thumb"]')?.value || "").trim(),
    description: String(editor.querySelector('textarea[data-field="description"]')?.value || "").trim(),
  };
}

function buildSeriesDraftFromEditor(itemNode, currentItem) {
  const editor = itemNode.querySelector(".library-editor");
  if (!editor) {
    throw new Error("Series editor is unavailable.");
  }
  const title = readRequiredTextInput(
    editor,
    'input[data-field="title"]',
    "Series title is required.",
  );
  const contentKind =
    String(editor.querySelector('select[data-field="contentKind"]')?.value || "")
      .trim()
      .toLowerCase() === "course"
      ? "course"
      : "series";
  const episodeNodes = Array.from(
    editor.querySelectorAll(".library-episode-card"),
  );
  if (!episodeNodes.length) {
    throw new Error("Series must include at least one episode.");
  }
  const currentEpisodes = Array.isArray(currentItem?.episodes)
    ? currentItem.episodes
    : [];
  const episodes = episodeNodes.map((episodeNode, index) => {
    const episodeTitle = readRequiredTextInput(
      episodeNode,
      'input[data-episode-field="title"]',
      `Episode ${index + 1} title is required.`,
    );
    const src = readRequiredTextInput(
      episodeNode,
      'input[data-episode-field="src"]',
      `Episode ${index + 1} source path is required.`,
    );
    return {
      ...(currentEpisodes[index] || {}),
      title: episodeTitle,
      src,
      contentKind,
      seasonNumber: readIntegerInput(
        episodeNode,
        'input[data-episode-field="seasonNumber"]',
        1,
      ),
      episodeNumber: readIntegerInput(
        episodeNode,
        'input[data-episode-field="episodeNumber"]',
        index + 1,
      ),
      thumb: String(
        episodeNode.querySelector('input[data-episode-field="thumb"]')?.value ||
          "",
      ).trim(),
      description: String(
        episodeNode.querySelector('textarea[data-episode-field="description"]')
          ?.value || "",
      ).trim(),
      uploadedAt: Number.isFinite(Number(currentEpisodes[index]?.uploadedAt))
        ? Math.floor(Number(currentEpisodes[index].uploadedAt))
        : Date.now(),
    };
  });

  return {
    ...currentItem,
    title,
    contentKind,
    tmdbId: String(editor.querySelector('input[data-field="tmdbId"]')?.value || "").trim(),
    year: String(editor.querySelector('input[data-field="year"]')?.value || "").trim(),
    episodes,
  };
}

libraryEditModeToggle?.addEventListener("change", () => {
  const enabled = persistLibraryEditMode(Boolean(libraryEditModeToggle.checked));
  libraryEditModeToggle.checked = enabled;
  if (!enabled) {
    activeLibraryEditorKey = "";
  }
  renderLibraryEditList();
  if (enabled) {
    setLibraryEditStatus("Edit mode enabled. Click the pencil icon to edit.");
  } else {
    setLibraryEditStatus("Edit mode disabled.");
  }
});

libraryEditList?.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const actionButton = target?.closest?.("[data-action]");
  if (!actionButton) {
    return;
  }
  const action = String(actionButton.dataset.action || "").trim();
  const context = getEditorRootFromEventTarget(actionButton);
  if (!context) {
    return;
  }
  const { itemType, itemIndex } = context;

  if (action === "toggle-editor") {
    if (!libraryEditModeToggle?.checked) {
      return;
    }
    const key = getLibraryEditorKey(itemType, itemIndex);
    activeLibraryEditorKey = activeLibraryEditorKey === key ? "" : key;
    renderLibraryEditList();
    return;
  }

  if (action === "cancel-editor") {
    activeLibraryEditorKey = "";
    renderLibraryEditList();
    return;
  }

  const list =
    itemType === "movie" ? localLibraryState.movies : localLibraryState.series;
  if (!Array.isArray(list) || itemIndex < 0 || itemIndex >= list.length) {
    setLibraryEditStatus("Selected title no longer exists.", "error");
    renderLibraryEditList();
    return;
  }

  if (action === "add-episode") {
    if (itemType !== "series") {
      return;
    }
    const targetSeries = list[itemIndex];
    const episodes = Array.isArray(targetSeries.episodes)
      ? [...targetSeries.episodes]
      : [];
    const nextIndex = episodes.length + 1;
    const contentKind =
      String(targetSeries.contentKind || "")
        .trim()
        .toLowerCase() === "course"
        ? "course"
        : "series";
    episodes.push({
      title: contentKind === "course" ? `Lesson ${nextIndex}` : `Episode ${nextIndex}`,
      description: "",
      thumb: "assets/images/thumbnail.jpg",
      src: "",
      contentKind,
      seasonNumber: 1,
      episodeNumber: nextIndex,
      uploadedAt: Date.now(),
    });
    list[itemIndex] = {
      ...targetSeries,
      contentKind,
      episodes,
    };
    activeLibraryEditorKey = getLibraryEditorKey("series", itemIndex);
    renderLibraryEditList();
    return;
  }

  if (action === "delete-episode") {
    if (itemType !== "series") {
      return;
    }
    const targetSeries = list[itemIndex];
    const episodes = Array.isArray(targetSeries.episodes)
      ? [...targetSeries.episodes]
      : [];
    const episodeIndex = Number(actionButton.dataset.episodeIndex || -1);
    if (
      !Number.isFinite(episodeIndex) ||
      episodeIndex < 0 ||
      episodeIndex >= episodes.length
    ) {
      return;
    }
    episodes.splice(episodeIndex, 1);
    list[itemIndex] = {
      ...targetSeries,
      episodes,
    };
    activeLibraryEditorKey = getLibraryEditorKey("series", itemIndex);
    renderLibraryEditList();
    return;
  }

  if (action === "delete-item") {
    const title = String(list[itemIndex]?.title || "this title").trim();
    const shouldDelete = window.confirm(
      `Delete "${title}" from the library?`,
    );
    if (!shouldDelete) {
      return;
    }
    list.splice(itemIndex, 1);
    activeLibraryEditorKey = "";
    renderLibraryEditList();
    await persistLibraryEdits(`Deleted "${title}".`);
    return;
  }

  if (action === "save-item") {
    try {
      const currentItem = list[itemIndex];
      const nextItem =
        itemType === "movie"
          ? buildMovieDraftFromEditor(context.itemNode, currentItem)
          : buildSeriesDraftFromEditor(context.itemNode, currentItem);
      list[itemIndex] = nextItem;
      renderLibraryEditList();
      await persistLibraryEdits(`Updated "${String(nextItem.title || "title").trim()}".`);
      activeLibraryEditorKey = getLibraryEditorKey(itemType, itemIndex);
      renderLibraryEditList();
    } catch (error) {
      setLibraryEditStatus(
        error instanceof Error ? error.message : "Failed to save title edits.",
        "error",
      );
    }
  }
});

function setCacheClearStatus(message, tone = "") {
  if (!cacheClearStatus) {
    return;
  }
  cacheClearStatus.textContent = String(message || "");
  cacheClearStatus.classList.remove("status-success", "status-error");
  if (tone === "success") {
    cacheClearStatus.classList.add("status-success");
  } else if (tone === "error") {
    cacheClearStatus.classList.add("status-error");
  }
}

qualityForm?.addEventListener("submit", (event) => {
  event.preventDefault();

  const formData = new FormData(qualityForm);
  const selectedQuality = normalizeStreamQualityPreference(
    formData.get("quality") || "auto",
  );
  const selectedAvatarChoice = normalizeAvatarChoice(
    formData.get("avatarStyle") || DEFAULT_AVATAR_STYLE,
  );
  const selectedSourceMinSeeders = normalizeSourceMinSeeders(
    formData.get("sourceMinSeeders") || 0,
  );
  const selectedSourceLanguage = normalizeSourceLanguage(
    formData.get("sourceLanguage") || "en",
  );
  const selectedSourceAudioProfile = normalizeSourceAudioProfile(
    formData.get("sourceAudioProfile") || "single",
  );
  const selectedDefaultAudioLanguage = normalizeDefaultAudioLanguage(
    formData.get("defaultAudioLanguage") || "en",
  );
  const selectedRemuxVideoMode = normalizeRemuxVideoMode(
    formData.get("remuxVideoMode") || "auto",
  );

  const savedQuality = persistSelectedQuality(selectedQuality);
  const savedSubtitleColor = persistSubtitleColorPreference(
    subtitleColorInput?.value,
  );
  setSelectedQuality(savedQuality);
  setSelectedSubtitleColor(savedSubtitleColor);

  let savedAvatarChoiceLabel = "";
  if (selectedAvatarChoice === "custom") {
    const customImage = sanitizeAvatarImageData(
      pendingCustomAvatarImage || getStoredAvatarImagePreference(),
    );
    if (!customImage) {
      if (saveStatus) {
        saveStatus.textContent =
          "Choose an image first for custom profile icon.";
      }
      return;
    }

    persistAvatarModePreference("custom");
    persistAvatarImagePreference(customImage);
    setSelectedAvatarChoice("custom", customImage);
    savedAvatarChoiceLabel = "Custom image";
  } else {
    const savedStyle = persistAvatarStylePreference(selectedAvatarChoice);
    persistAvatarModePreference("preset");
    persistAvatarImagePreference("");
    setSelectedAvatarChoice(savedStyle, "");
    savedAvatarChoiceLabel = getAvatarChoiceDisplayLabel(savedStyle);
  }

  const savedSourceMinSeeders = persistSourceMinSeeders(
    selectedSourceMinSeeders,
  );
  const savedSourceLanguage = persistSourceLanguage(selectedSourceLanguage);
  const savedSourceAudioProfile = persistSourceAudioProfile(
    selectedSourceAudioProfile,
  );
  const savedDefaultAudioLanguage = persistDefaultAudioLanguage(
    selectedDefaultAudioLanguage,
  );
  const savedRemuxVideoMode = persistRemuxVideoMode(selectedRemuxVideoMode);
  setSelectedSourceFilters(
    savedSourceMinSeeders,
    savedSourceLanguage,
    savedSourceAudioProfile,
  );
  setSelectedDefaultAudioLanguage(savedDefaultAudioLanguage);
  setSelectedRemuxVideoMode(savedRemuxVideoMode);

  if (saveStatus) {
    const qualityLabel = savedQuality === "auto" ? "Auto" : savedQuality;
    const sourceLanguageLabel = getSourceLanguageLabel(savedSourceLanguage);
    const sourceAudioProfileLabel =
      getSourceAudioProfileLabel(savedSourceAudioProfile);
    const defaultAudioLanguageLabel =
      getDefaultAudioLanguageLabel(savedDefaultAudioLanguage);
    saveStatus.textContent =
      `Settings saved. ${qualityLabel} default, ${defaultAudioLanguageLabel} audio, MP4 torrent playback, ${sourceLanguageLabel}, ${sourceAudioProfileLabel}, profile icon ${savedAvatarChoiceLabel}.`;
  }
});

clearDeprecatedSourcePreferenceStorage();
setSelectedQuality(getStoredStreamQualityPreference());
setSelectedSubtitleColor(getStoredSubtitleColorPreference());
setSelectedDefaultAudioLanguage(getStoredDefaultAudioLanguage());
setSelectedSourceFilters(
  getStoredSourceMinSeeders(),
  getStoredSourceLanguage(),
  getStoredSourceAudioProfile(),
);
setSelectedRemuxVideoMode(getStoredRemuxVideoMode());

const storedAvatarStyle = getStoredAvatarStylePreference();
const storedAvatarMode = getStoredAvatarModePreference();
const storedAvatarImage = getStoredAvatarImagePreference();
pendingCustomAvatarImage = storedAvatarImage;
setSelectedAvatarChoice(
  storedAvatarMode === "custom" && storedAvatarImage
    ? "custom"
    : storedAvatarStyle,
  storedAvatarImage,
);

if (libraryEditModeToggle) {
  libraryEditModeToggle.checked = readStoredLibraryEditMode();
}
renderLibraryEditList();
void loadLibraryForEditor();

subtitleColorInput?.addEventListener("input", () => {
  setSelectedSubtitleColor(subtitleColorInput.value);
});

subtitleColorReset?.addEventListener("click", () => {
  setSelectedSubtitleColor(DEFAULT_SUBTITLE_COLOR);
});

qualityForm?.querySelectorAll('input[name="avatarStyle"]').forEach((input) => {
  input.addEventListener("change", () => {
    const nextChoice = normalizeAvatarChoice(input.value);
    setSelectedAvatarChoice(nextChoice);
  });
});

avatarImageInput?.addEventListener("change", async () => {
  const file = avatarImageInput.files?.[0];
  if (!file) {
    return;
  }

  if (avatarUploadHint) {
    avatarUploadHint.textContent = "Processing image...";
  }

  try {
    const preparedImage = await convertFileToAvatarImage(file);
    pendingCustomAvatarImage = preparedImage;
    setSelectedAvatarChoice("custom", preparedImage);
    if (avatarUploadHint) {
      avatarUploadHint.textContent = "Image ready. Save Settings to apply.";
    }
  } catch (error) {
    if (avatarUploadHint) {
      avatarUploadHint.textContent =
        error instanceof Error ? error.message : "Failed to load image.";
    }
  } finally {
    avatarImageInput.value = "";
  }
});

clearAllCachesBtn?.addEventListener("click", async () => {
  if (isClearingCaches) {
    return;
  }

  const shouldProceed = window.confirm(
    "Clear all server caches for every title?",
  );
  if (!shouldProceed) {
    return;
  }

  isClearingCaches = true;
  clearAllCachesBtn.disabled = true;
  setCacheClearStatus("Clearing caches...");

  try {
    const response = await fetch(`/api/debug/cache?clear=1&t=${Date.now()}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
      },
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorMessage =
        payload?.error ||
        payload?.message ||
        `Request failed (${response.status})`;
      throw new Error(errorMessage);
    }

    const persistent = payload?.caches?.persistentDb || {};
    const sourceCount = Number(persistent.resolvedStreamSize || 0);
    const tmdbCount = Number(persistent.tmdbResponseSize || 0);
    setCacheClearStatus(
      `Done. Server cache cleared (sources ${sourceCount}, TMDB ${tmdbCount}).`,
      "success",
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to clear cache.";
    setCacheClearStatus(message, "error");
  } finally {
    isClearingCaches = false;
    clearAllCachesBtn.disabled = false;
  }
});

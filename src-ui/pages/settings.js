import html from "solid-js/html";
import { createSignal, onCleanup } from "solid-js";
import UploadSection from "../components/upload-section.js";
import {
  STREAM_QUALITY_PREF_KEY,
  PROFILE_AVATAR_STYLE_PREF_KEY,
  PROFILE_AVATAR_MODE_PREF_KEY,
  PROFILE_AVATAR_IMAGE_PREF_KEY,
  supportedAvatarStyles,
  normalizeAvatarStyle,
  normalizeAvatarMode,
  sanitizeAvatarImageData,
  getStoredAvatarStylePreference,
  getStoredAvatarModePreference,
  getStoredAvatarImagePreference,
} from "../shared.js";
import {
  SUBTITLE_COLOR_PREF_KEY,
  SOURCE_MIN_SEEDERS_PREF_KEY,
  SOURCE_AUDIO_PROFILE_PREF_KEY,
  RESOLVER_PROVIDER_PREF_KEY,
  DEFAULT_AUDIO_LANGUAGE_PREF_KEY,
  REMUX_VIDEO_MODE_PREF_KEY,
  DEFAULT_SUBTITLE_COLOR,
  DEFAULT_STREAM_QUALITY_PREFERENCE,
  normalizeStreamQualityPreference,
  normalizeSourceMinSeeders,
  normalizeDefaultAudioLanguage,
  normalizeSourceAudioProfile,
  normalizeResolverProviderPreference,
  normalizeRemuxVideoMode,
  normalizeSubtitleColor,
  getStoredStreamQualityPreference,
  getStoredResolverProviderPreference,
} from "../lib/preferences.js";

// ─── Preference key constants ───────────────────────────────────────────────
const SOURCE_LANGUAGE_PREF_KEY = "netflix-source-filter-language";

// ─── Defaults ───────────────────────────────────────────────────────────────
const DEFAULT_AVATAR_STYLE = "blue";
const DEFAULT_AVATAR_MODE = "preset";
const AVATAR_OUTPUT_SIZE_PX = 180;

// ─── Supported value sets ───────────────────────────────────────────────────
const supportedSourceLanguages = ["en", "any", "fr", "es", "de", "it", "pt"];
const supportedAvatarChoices = new Set([...supportedAvatarStyles, "custom"]);

// ─── Normalization helpers ──────────────────────────────────────────────────

function normalizeSourceLanguage(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === "en" || normalized === "eng" || normalized === "english") return "en";
  if (normalized === "any" || normalized === "all" || normalized === "auto" || normalized === "*") return "any";
  if (supportedSourceLanguages.includes(normalized)) return normalized;
  return "en";
}

function normalizeAvatarChoice(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (supportedAvatarChoices.has(normalized)) return normalized;
  return DEFAULT_AVATAR_STYLE;
}

function labelFromMap(value, labels, fallback) {
  return labels[String(value || "").trim().toLowerCase()] || fallback;
}

function getQualityLabel(value) {
  return labelFromMap(value, {
    auto: "Auto",
    "2160p": "4K (2160p)",
    "1080p": "Full HD (1080p)",
    "720p": "HD (720p)",
  }, "Full HD (1080p)");
}

function getLanguageLabel(value) {
  return labelFromMap(value, {
    auto: "Auto",
    any: "Any",
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
  }, "English");
}

function getAudioProfileLabel(value) {
  return labelFromMap(value, {
    single: "Single audio",
    any: "Multi / dubbed",
  }, "Single audio");
}

function getResolverProviderLabel(value) {
  return labelFromMap(value, {
    "real-debrid": "Real-Debrid",
    "local-torrent": "Local torrent (experimental)",
  }, "Real-Debrid");
}

function getRemuxVideoModeLabel(value) {
  return labelFromMap(value, {
    auto: "Auto",
    copy: "Copy video",
    normalize: "Normalize video",
  }, "Auto");
}

function getAvatarChoiceLabel(value) {
  return labelFromMap(value, {
    blue: "Blue",
    crimson: "Crimson",
    emerald: "Emerald",
    violet: "Violet",
    amber: "Amber",
    custom: "Custom",
  }, "Blue");
}

// ─── localStorage getters ───────────────────────────────────────────────────

function getStoredSubtitleColorPreference() {
  try { return normalizeSubtitleColor(localStorage.getItem(SUBTITLE_COLOR_PREF_KEY)); }
  catch { return DEFAULT_SUBTITLE_COLOR; }
}

function getStoredDefaultAudioLanguage() {
  try { return normalizeDefaultAudioLanguage(localStorage.getItem(DEFAULT_AUDIO_LANGUAGE_PREF_KEY)); }
  catch { return "en"; }
}

function getStoredSourceMinSeeders() {
  try { return normalizeSourceMinSeeders(localStorage.getItem(SOURCE_MIN_SEEDERS_PREF_KEY)); }
  catch { return 0; }
}

function getStoredSourceLanguage() {
  try { return normalizeSourceLanguage(localStorage.getItem(SOURCE_LANGUAGE_PREF_KEY)); }
  catch { return "en"; }
}

function getStoredSourceAudioProfile() {
  try { return normalizeSourceAudioProfile(localStorage.getItem(SOURCE_AUDIO_PROFILE_PREF_KEY)); }
  catch { return "single"; }
}

function getStoredResolverProvider() {
  return getStoredResolverProviderPreference();
}

function getStoredRemuxVideoMode() {
  try { return normalizeRemuxVideoMode(localStorage.getItem(REMUX_VIDEO_MODE_PREF_KEY)); }
  catch { return "auto"; }
}

// ─── Persist helpers (localStorage + server sync) ───────────────────────────

function persistSelectedQuality(value) {
  const normalized = normalizeStreamQualityPreference(value);
  try {
    if (normalized === DEFAULT_STREAM_QUALITY_PREFERENCE) localStorage.removeItem(STREAM_QUALITY_PREF_KEY);
    else localStorage.setItem(STREAM_QUALITY_PREF_KEY, normalized);
  } catch {}
  fetch("/api/user/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [STREAM_QUALITY_PREF_KEY]: normalized }),
  }).catch(() => {});
  return normalized;
}

function persistSubtitleColorPreference(value) {
  const normalized = normalizeSubtitleColor(value);
  try {
    if (normalized === DEFAULT_SUBTITLE_COLOR) localStorage.removeItem(SUBTITLE_COLOR_PREF_KEY);
    else localStorage.setItem(SUBTITLE_COLOR_PREF_KEY, normalized);
  } catch {}
  fetch("/api/user/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [SUBTITLE_COLOR_PREF_KEY]: normalized }),
  }).catch(() => {});
  return normalized;
}

function persistDefaultAudioLanguage(value) {
  const normalized = normalizeDefaultAudioLanguage(value);
  try {
    if (normalized === "en") localStorage.removeItem(DEFAULT_AUDIO_LANGUAGE_PREF_KEY);
    else localStorage.setItem(DEFAULT_AUDIO_LANGUAGE_PREF_KEY, normalized);
  } catch {}
  fetch("/api/user/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [DEFAULT_AUDIO_LANGUAGE_PREF_KEY]: normalized }),
  }).catch(() => {});
  return normalized;
}

function persistSourceMinSeeders(value) {
  const normalized = normalizeSourceMinSeeders(value);
  try {
    if (normalized <= 0) localStorage.removeItem(SOURCE_MIN_SEEDERS_PREF_KEY);
    else localStorage.setItem(SOURCE_MIN_SEEDERS_PREF_KEY, String(normalized));
  } catch {}
  fetch("/api/user/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [SOURCE_MIN_SEEDERS_PREF_KEY]: String(normalized) }),
  }).catch(() => {});
  return normalized;
}

function persistSourceLanguage(value) {
  const normalized = normalizeSourceLanguage(value);
  try {
    if (normalized === "en") localStorage.removeItem(SOURCE_LANGUAGE_PREF_KEY);
    else localStorage.setItem(SOURCE_LANGUAGE_PREF_KEY, normalized);
  } catch {}
  fetch("/api/user/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [SOURCE_LANGUAGE_PREF_KEY]: normalized }),
  }).catch(() => {});
  return normalized;
}

function persistSourceAudioProfile(value) {
  const normalized = normalizeSourceAudioProfile(value);
  try {
    if (normalized === "single") localStorage.removeItem(SOURCE_AUDIO_PROFILE_PREF_KEY);
    else localStorage.setItem(SOURCE_AUDIO_PROFILE_PREF_KEY, normalized);
  } catch {}
  fetch("/api/user/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [SOURCE_AUDIO_PROFILE_PREF_KEY]: normalized }),
  }).catch(() => {});
  return normalized;
}

function persistResolverProvider(value) {
  const normalized = normalizeResolverProviderPreference(value);
  try {
    if (normalized === "real-debrid") localStorage.removeItem(RESOLVER_PROVIDER_PREF_KEY);
    else localStorage.setItem(RESOLVER_PROVIDER_PREF_KEY, normalized);
  } catch {}
  fetch("/api/user/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [RESOLVER_PROVIDER_PREF_KEY]: normalized }),
  }).catch(() => {});
  return normalized;
}

function persistRemuxVideoMode(value) {
  const normalized = normalizeRemuxVideoMode(value);
  try {
    if (normalized === "auto") localStorage.removeItem(REMUX_VIDEO_MODE_PREF_KEY);
    else localStorage.setItem(REMUX_VIDEO_MODE_PREF_KEY, normalized);
  } catch {}
  fetch("/api/user/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [REMUX_VIDEO_MODE_PREF_KEY]: normalized }),
  }).catch(() => {});
  return normalized;
}

function persistAvatarStylePreference(styleValue) {
  const style = normalizeAvatarStyle(styleValue);
  try {
    if (style === DEFAULT_AVATAR_STYLE) localStorage.removeItem(PROFILE_AVATAR_STYLE_PREF_KEY);
    else localStorage.setItem(PROFILE_AVATAR_STYLE_PREF_KEY, style);
  } catch {}
  fetch("/api/user/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [PROFILE_AVATAR_STYLE_PREF_KEY]: style }),
  }).catch(() => {});
  return style;
}

function persistAvatarModePreference(modeValue) {
  const mode = normalizeAvatarMode(modeValue);
  try {
    if (mode === DEFAULT_AVATAR_MODE) localStorage.removeItem(PROFILE_AVATAR_MODE_PREF_KEY);
    else localStorage.setItem(PROFILE_AVATAR_MODE_PREF_KEY, mode);
  } catch {}
  fetch("/api/user/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [PROFILE_AVATAR_MODE_PREF_KEY]: mode }),
  }).catch(() => {});
  return mode;
}

function persistAvatarImagePreference(imageData) {
  const safeImage = sanitizeAvatarImageData(imageData);
  try {
    if (!safeImage) localStorage.removeItem(PROFILE_AVATAR_IMAGE_PREF_KEY);
    else localStorage.setItem(PROFILE_AVATAR_IMAGE_PREF_KEY, safeImage);
  } catch {}
  fetch("/api/user/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [PROFILE_AVATAR_IMAGE_PREF_KEY]: safeImage || "" }),
  }).catch(() => {});
  return safeImage || "";
}

// ─── Image processing ───────────────────────────────────────────────────────

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
    image, sourceX, sourceY, cropSize, cropSize,
    0, 0, AVATAR_OUTPUT_SIZE_PX, AVATAR_OUTPUT_SIZE_PX,
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

// ─── Deprecation cleanup ────────────────────────────────────────────────────

function clearDeprecatedSourcePreferenceStorage() {
  const deprecatedKeys = [
    "netflix-source-filter-allowed-formats",
    "netflix-source-filter-results-limit",
  ];
  try { deprecatedKeys.forEach((key) => localStorage.removeItem(key)); }
  catch {}
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function SettingsPage() {
  // ── Reactive state ──────────────────────────────────────────────────────
  const [selectedQuality, setSelectedQuality] = createSignal(getStoredStreamQualityPreference());
  const [subtitleColor, setSubtitleColor] = createSignal(getStoredSubtitleColorPreference());
  const [defaultAudioLang, setDefaultAudioLang] = createSignal(getStoredDefaultAudioLanguage());
  const [sourceMinSeeders, setSourceMinSeeders] = createSignal(getStoredSourceMinSeeders());
  const [sourceLang, setSourceLang] = createSignal(getStoredSourceLanguage());
  const [sourceAudioProfile, setSourceAudioProfile] = createSignal(getStoredSourceAudioProfile());
  const [resolverProvider, setResolverProvider] = createSignal(getStoredResolverProvider());
  const [remuxVideoMode, setRemuxVideoMode] = createSignal(getStoredRemuxVideoMode());

  // Avatar state
  const storedAvatarStyle = getStoredAvatarStylePreference();
  const storedAvatarMode = getStoredAvatarModePreference();
  const storedAvatarImage = getStoredAvatarImagePreference();
  const initialAvatarChoice = (storedAvatarMode === "custom" && storedAvatarImage) ? "custom" : storedAvatarStyle;

  const [avatarChoice, setAvatarChoice] = createSignal(initialAvatarChoice);
  const [pendingCustomImage, setPendingCustomImage] = createSignal(storedAvatarImage);
  const [avatarUploadHint, setAvatarUploadHint] = createSignal("");

  // Cache clearing state
  const [isClearingCaches, setIsClearingCaches] = createSignal(false);
  const [cacheClearStatus, setCacheClearStatus] = createSignal("");
  const [cacheClearTone, setCacheClearTone] = createSignal("");

  // Toast state
  const [toastMessage, setToastMessage] = createSignal("");
  const [toastVisible, setToastVisible] = createSignal(false);
  let toastTimeout = 0;

  // Refs for imperative DOM access
  let avatarImageInputRef;
  let avatarPreviewRef;
  let avatarCustomThumbRef;

  // ── Init ────────────────────────────────────────────────────────────────
  clearDeprecatedSourcePreferenceStorage();

  // ── Toast ───────────────────────────────────────────────────────────────
  function showToast(message) {
    setToastMessage(message);
    setToastVisible(false);
    // Force a tick so the class removal takes effect before re-adding
    requestAnimationFrame(() => {
      setToastVisible(true);
    });
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => setToastVisible(false), 2500);
  }

  onCleanup(() => clearTimeout(toastTimeout));

  // ── Avatar preview helpers ──────────────────────────────────────────────

  function computeAvatarPreviewClass() {
    const choice = avatarChoice();
    const customImg = pendingCustomImage();
    if (choice === "custom" && sanitizeAvatarImageData(customImg)) {
      return "avatar-style-preview avatar-style-custom-image";
    }
    const style = choice === "custom" ? getStoredAvatarStylePreference() : normalizeAvatarStyle(choice);
    return `avatar-style-preview avatar-style-${style}`;
  }

  function computeAvatarPreviewStyle() {
    const choice = avatarChoice();
    const customImg = sanitizeAvatarImageData(pendingCustomImage());
    if (choice === "custom" && customImg) {
      return `--avatar-image: url("${customImg}"); background-image: var(--avatar-image)`;
    }
    return "";
  }

  function computeCustomThumbClass() {
    const customImg = sanitizeAvatarImageData(pendingCustomImage());
    if (customImg) {
      return "avatar-style-swatch avatar-style-custom-thumb avatar-style-custom-image";
    }
    return "avatar-style-swatch avatar-style-custom-thumb";
  }

  function computeCustomThumbStyle() {
    const customImg = sanitizeAvatarImageData(pendingCustomImage());
    if (customImg) {
      return `--avatar-image: url("${customImg}"); background-image: var(--avatar-image)`;
    }
    return "";
  }

  // ── Event handlers ──────────────────────────────────────────────────────

  function handleQualityChange(value) {
    setSelectedQuality(normalizeStreamQualityPreference(value));
  }

  function handleSubtitleColorInput(e) {
    setSubtitleColor(normalizeSubtitleColor(e.target.value));
  }

  function handleSubtitleColorReset() {
    setSubtitleColor(DEFAULT_SUBTITLE_COLOR);
  }

  function handleDefaultAudioLangChange(e) {
    setDefaultAudioLang(normalizeDefaultAudioLanguage(e.target.value));
  }

  function handleSourceMinSeedersChange(e) {
    setSourceMinSeeders(normalizeSourceMinSeeders(e.target.value));
  }

  function handleSourceLangChange(e) {
    setSourceLang(normalizeSourceLanguage(e.target.value));
  }

  function handleSourceAudioProfileChange(e) {
    setSourceAudioProfile(normalizeSourceAudioProfile(e.target.value));
  }

  function handleResolverProviderChange(value) {
    setResolverProvider(normalizeResolverProviderPreference(value));
  }

  function handleRemuxVideoModeChange(value) {
    setRemuxVideoMode(normalizeRemuxVideoMode(value));
  }

  function handleAvatarChoiceChange(value) {
    const nextChoice = normalizeAvatarChoice(value);
    setAvatarChoice(nextChoice);
  }

  async function handleAvatarImageChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    setAvatarUploadHint("Processing image...");

    try {
      const preparedImage = await convertFileToAvatarImage(file);
      setPendingCustomImage(preparedImage);
      setAvatarChoice("custom");
      setAvatarUploadHint("Image ready. Save Settings to apply.");
    } catch (error) {
      setAvatarUploadHint(error instanceof Error ? error.message : "Failed to load image.");
    } finally {
      if (avatarImageInputRef) avatarImageInputRef.value = "";
    }
  }

  function handleFormSubmit(e) {
    e.preventDefault();

    const savedQuality = persistSelectedQuality(selectedQuality());
    setSelectedQuality(savedQuality);

    const savedSubtitleColor = persistSubtitleColorPreference(subtitleColor());
    setSubtitleColor(savedSubtitleColor);

    const currentAvatarChoice = normalizeAvatarChoice(avatarChoice());

    if (currentAvatarChoice === "custom") {
      const customImage = sanitizeAvatarImageData(
        pendingCustomImage() || getStoredAvatarImagePreference(),
      );
      if (!customImage) {
        showToast("Choose an image first");
        return;
      }
      persistAvatarModePreference("custom");
      persistAvatarImagePreference(customImage);
      setPendingCustomImage(customImage);
      setAvatarChoice("custom");
    } else {
      const savedStyle = persistAvatarStylePreference(currentAvatarChoice);
      persistAvatarModePreference("preset");
      persistAvatarImagePreference("");
      setAvatarChoice(savedStyle);
      setPendingCustomImage("");
    }

    const savedMinSeeders = persistSourceMinSeeders(sourceMinSeeders());
    setSourceMinSeeders(savedMinSeeders);

    const savedSourceLang = persistSourceLanguage(sourceLang());
    setSourceLang(savedSourceLang);

    const savedSourceAudioProfile = persistSourceAudioProfile(sourceAudioProfile());
    setSourceAudioProfile(savedSourceAudioProfile);

    const savedResolverProvider = persistResolverProvider(resolverProvider());
    setResolverProvider(savedResolverProvider);

    const savedDefaultAudioLang = persistDefaultAudioLanguage(defaultAudioLang());
    setDefaultAudioLang(savedDefaultAudioLang);

    const savedRemuxVideoMode = persistRemuxVideoMode(remuxVideoMode());
    setRemuxVideoMode(savedRemuxVideoMode);

    showToast("Settings saved");
  }

  async function handleClearAllCaches() {
    if (isClearingCaches()) return;

    const shouldProceed = window.confirm("Clear all server caches for every title?");
    if (!shouldProceed) return;

    setIsClearingCaches(true);
    setCacheClearStatus("Clearing caches...");
    setCacheClearTone("");

    try {
      const response = await fetch(`/api/debug/cache?clear=1&t=${Date.now()}`, {
        method: "POST",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errorMessage = payload?.error || payload?.message || `Request failed (${response.status})`;
        throw new Error(errorMessage);
      }

      const persistent = payload?.caches?.persistentDb || {};
      const sourceCount = Number(persistent.resolvedStreamSize || 0);
      const tmdbCount = Number(persistent.tmdbResponseSize || 0);
      setCacheClearStatus(`Done. Server cache cleared (sources ${sourceCount}, TMDB ${tmdbCount}).`);
      setCacheClearTone("success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to clear cache.";
      setCacheClearStatus(message);
      setCacheClearTone("error");
    } finally {
      setIsClearingCaches(false);
    }
  }

  // ── Template ────────────────────────────────────────────────────────────

  return html`<div data-solid-page-root="" style="display: contents">
    <div
      class=${() => "toast" + (toastVisible() ? " toast--visible" : "")}
      id="settingsToast"
    >${() => toastMessage()}</div>

    <header class="settings-topbar">
      <a class="settings-wordmark-link" href="/" aria-label="Back to browse">
        <img
          src="assets/icons/netflix-logo-clean.png"
          alt="Netflix"
          class="settings-wordmark"
        />
      </a>
      <a class="settings-profile-control" href="/" aria-label="Back to browse">
        <span
          class=${() => `${computeAvatarPreviewClass()} settings-topbar-avatar`}
          style=${computeAvatarPreviewStyle}
          aria-hidden="true"
        ></span>
        <span class="settings-profile-caret" aria-hidden="true"></span>
      </a>
    </header>

    <main class="settings-shell">
      <aside class="settings-side-nav" aria-label="Settings navigation">
        <a class="settings-back-link" href="/">
          <span class="settings-back-arrow" aria-hidden="true"></span>
          <span>Back to Browse</span>
        </a>
        <nav class="settings-nav-list">
          <a class="settings-nav-item is-active" href="#playbackSection" aria-current="page">
            <span class="settings-nav-glyph settings-nav-glyph--playback" aria-hidden="true"></span>
            <span>Playback</span>
          </a>
          <a class="settings-nav-item" href="#sourcesSection">
            <span class="settings-nav-glyph settings-nav-glyph--sources" aria-hidden="true"></span>
            <span>Sources</span>
          </a>
          <a class="settings-nav-item" href="#profileSection">
            <span class="settings-nav-glyph settings-nav-glyph--profile" aria-hidden="true"></span>
            <span>Profile</span>
          </a>
          <a class="settings-nav-item" href="#uploadSection">
            <span class="settings-nav-glyph settings-nav-glyph--upload" aria-hidden="true"></span>
            <span>Uploads</span>
          </a>
          <a class="settings-nav-item" href="#maintenanceSection">
            <span class="settings-nav-glyph settings-nav-glyph--maintenance" aria-hidden="true"></span>
            <span>Maintenance</span>
          </a>
        </nav>
      </aside>

      <section class="settings-content" aria-labelledby="settingsPageTitle">
        <div class="settings-notice">
          <div class="settings-notice-copy">
            <span>Local profile</span>
            <strong>Playback and library preferences for this browser</strong>
          </div>
          <span
            class=${() => `${computeAvatarPreviewClass()} settings-notice-avatar`}
            style=${computeAvatarPreviewStyle}
            aria-hidden="true"
          ></span>
          <span class="settings-row-chevron" aria-hidden="true"></span>
        </div>

        <form class="quality-form" onSubmit=${handleFormSubmit}>
          <div class="settings-page-heading">
            <h1 id="settingsPageTitle">Settings</h1>
            <p>Media preferences</p>
          </div>

          <section
            class="settings-section-block"
            id="playbackSection"
            aria-labelledby="playbackTitle"
          >
            <h2 id="playbackTitle" class="settings-section-title">
              Playback
            </h2>
            <div class="settings-list-card">
              <section class="settings-list-row">
                <span class="settings-row-icon settings-row-icon--quality" aria-hidden="true"></span>
                <div class="settings-row-copy">
                  <h3>Playback quality</h3>
                  <p>${() => getQualityLabel(selectedQuality())}</p>
                </div>
                <div
                  class="settings-row-control settings-segmented-control quality-choice-group"
                  role="radiogroup"
                  aria-label="Playback quality"
                >
                  <label class="quality-option">
                    <input
                      type="radio"
                      name="quality"
                      value="auto"
                      checked=${() => selectedQuality() === "auto"}
                      onChange=${() => handleQualityChange("auto")}
                    />
                    <span>Auto</span>
                  </label>
                  <label class="quality-option">
                    <input
                      type="radio"
                      name="quality"
                      value="2160p"
                      checked=${() => selectedQuality() === "2160p"}
                      onChange=${() => handleQualityChange("2160p")}
                    />
                    <span>4K</span>
                  </label>
                  <label class="quality-option">
                    <input
                      type="radio"
                      name="quality"
                      value="1080p"
                      checked=${() => selectedQuality() === "1080p"}
                      onChange=${() => handleQualityChange("1080p")}
                    />
                    <span>1080p</span>
                  </label>
                </div>
                <span class="settings-row-chevron" aria-hidden="true"></span>
              </section>

              <section class="settings-list-row">
                <span class="settings-row-icon settings-row-icon--audio" aria-hidden="true"></span>
                <div class="settings-row-copy">
                  <h3>Default audio</h3>
                  <p>${() => getLanguageLabel(defaultAudioLang())}</p>
                </div>
                <label class="settings-row-control source-language-filter" for="defaultAudioLanguage">
                  <span class="source-filter-label">Language</span>
                  <select
                    id="defaultAudioLanguage"
                    name="defaultAudioLanguage"
                    onChange=${handleDefaultAudioLangChange}
                  >
                    <option value="en" selected=${() => defaultAudioLang() === "en"}>English</option>
                    <option value="auto" selected=${() => defaultAudioLang() === "auto"}>Auto</option>
                    <option value="ja" selected=${() => defaultAudioLang() === "ja"}>Japanese</option>
                    <option value="ko" selected=${() => defaultAudioLang() === "ko"}>Korean</option>
                    <option value="zh" selected=${() => defaultAudioLang() === "zh"}>Chinese</option>
                    <option value="fr" selected=${() => defaultAudioLang() === "fr"}>French</option>
                    <option value="es" selected=${() => defaultAudioLang() === "es"}>Spanish</option>
                    <option value="de" selected=${() => defaultAudioLang() === "de"}>German</option>
                    <option value="it" selected=${() => defaultAudioLang() === "it"}>Italian</option>
                    <option value="pt" selected=${() => defaultAudioLang() === "pt"}>Portuguese</option>
                    <option value="nl" selected=${() => defaultAudioLang() === "nl"}>Dutch</option>
                    <option value="ro" selected=${() => defaultAudioLang() === "ro"}>Romanian</option>
                  </select>
                </label>
                <span class="settings-row-chevron" aria-hidden="true"></span>
              </section>
            </div>
          </section>

          <section
            class="settings-section-block"
            id="sourcesSection"
            aria-labelledby="sourcesTitle"
          >
            <h2 id="sourcesTitle" class="settings-section-title">
              Sources
            </h2>
            <div class="settings-list-card">
              <section class="settings-list-row">
                <span class="settings-row-icon settings-row-icon--sources" aria-hidden="true"></span>
                <div class="settings-row-copy">
                  <h3>Resolver provider</h3>
                  <p>${() => getResolverProviderLabel(resolverProvider())}</p>
                </div>
                <div
                  class="settings-row-control settings-segmented-control resolver-provider-options"
                  role="radiogroup"
                  aria-label="Resolver provider"
                >
                  <label class="remux-mode-option">
                    <input
                      type="radio"
                      name="resolverProvider"
                      value="real-debrid"
                      checked=${() => resolverProvider() === "real-debrid"}
                      onChange=${() => handleResolverProviderChange("real-debrid")}
                    />
                    <span>Real-Debrid</span>
                  </label>
                  <label class="remux-mode-option">
                    <input
                      type="radio"
                      name="resolverProvider"
                      value="local-torrent"
                      checked=${() => resolverProvider() === "local-torrent"}
                      onChange=${() => handleResolverProviderChange("local-torrent")}
                    />
                    <span>Local torrent (experimental)</span>
                  </label>
                </div>
                <span class="settings-row-chevron" aria-hidden="true"></span>
              </section>

              <section class="settings-list-row settings-list-row--stacked">
                <span class="settings-row-icon settings-row-icon--sources" aria-hidden="true"></span>
                <div class="settings-row-copy">
                  <h3>Source defaults</h3>
                  <p>${() => `${sourceMinSeeders()} min seeds, ${getLanguageLabel(sourceLang())}, ${getAudioProfileLabel(sourceAudioProfile())}`}</p>
                </div>
                <div class="settings-row-control source-filter-stack">
                  <label class="source-min-seeds" for="sourceMinSeeders">
                    <span class="source-filter-label">Min seeds</span>
                    <input
                      id="sourceMinSeeders"
                      name="sourceMinSeeders"
                      type="number"
                      min="0"
                      max="50000"
                      step="1"
                      value=${() => String(sourceMinSeeders())}
                      onChange=${handleSourceMinSeedersChange}
                    />
                  </label>

                  <label class="source-language-filter" for="sourceLanguage">
                    <span class="source-filter-label">Language</span>
                    <select
                      id="sourceLanguage"
                      name="sourceLanguage"
                      onChange=${handleSourceLangChange}
                    >
                      <option value="en" selected=${() => sourceLang() === "en"}>English</option>
                      <option value="any" selected=${() => sourceLang() === "any"}>Any</option>
                      <option value="fr" selected=${() => sourceLang() === "fr"}>French</option>
                      <option value="es" selected=${() => sourceLang() === "es"}>Spanish</option>
                      <option value="de" selected=${() => sourceLang() === "de"}>German</option>
                      <option value="it" selected=${() => sourceLang() === "it"}>Italian</option>
                      <option value="pt" selected=${() => sourceLang() === "pt"}>Portuguese</option>
                    </select>
                  </label>

                  <label class="source-language-filter" for="sourceAudioProfile">
                    <span class="source-filter-label">Audio mix</span>
                    <select
                      id="sourceAudioProfile"
                      name="sourceAudioProfile"
                      onChange=${handleSourceAudioProfileChange}
                    >
                      <option value="single" selected=${() => sourceAudioProfile() === "single"}>Single audio</option>
                      <option value="any" selected=${() => sourceAudioProfile() === "any"}>Multi / dubbed</option>
                    </select>
                  </label>
                </div>
                <span class="settings-row-chevron" aria-hidden="true"></span>
              </section>

              <section class="settings-list-row">
                <span class="settings-row-icon settings-row-icon--remux" aria-hidden="true"></span>
                <div class="settings-row-copy">
                  <h3>Remux video mode</h3>
                  <p>${() => getRemuxVideoModeLabel(remuxVideoMode())}</p>
                </div>
                <div
                  class="settings-row-control settings-segmented-control remux-mode-options"
                  role="radiogroup"
                  aria-label="Remux video mode"
                >
                  <label class="remux-mode-option">
                    <input
                      type="radio"
                      name="remuxVideoMode"
                      value="auto"
                      checked=${() => remuxVideoMode() === "auto"}
                      onChange=${() => handleRemuxVideoModeChange("auto")}
                    />
                    <span>Auto</span>
                  </label>
                  <label class="remux-mode-option">
                    <input
                      type="radio"
                      name="remuxVideoMode"
                      value="copy"
                      checked=${() => remuxVideoMode() === "copy"}
                      onChange=${() => handleRemuxVideoModeChange("copy")}
                    />
                    <span>Copy</span>
                  </label>
                  <label class="remux-mode-option">
                    <input
                      type="radio"
                      name="remuxVideoMode"
                      value="normalize"
                      checked=${() => remuxVideoMode() === "normalize"}
                      onChange=${() => handleRemuxVideoModeChange("normalize")}
                    />
                    <span>Normalize</span>
                  </label>
                </div>
                <span class="settings-row-chevron" aria-hidden="true"></span>
              </section>
            </div>
          </section>

          <section
            class="settings-section-block"
            id="profileSection"
            aria-labelledby="profileTitle"
          >
            <h2 id="profileTitle" class="settings-section-title">
              Profile
            </h2>
            <div class="settings-list-card">
              <section class="settings-list-row">
                <span class="settings-row-icon settings-row-icon--subtitles" aria-hidden="true"></span>
                <div class="settings-row-copy">
                  <h3>Subtitles</h3>
                  <p>${() => subtitleColor()}</p>
                </div>
                <div class="settings-row-control subtitle-color-controls">
                  <label class="subtitle-color-picker-label" for="subtitleColorInput">Color</label>
                  <input
                    id="subtitleColorInput"
                    name="subtitleColor"
                    type="color"
                    value=${() => subtitleColor()}
                    onInput=${handleSubtitleColorInput}
                  />
                  <button
                    class="subtitle-color-reset-btn"
                    type="button"
                    onClick=${handleSubtitleColorReset}
                  >
                    Reset
                  </button>
                  <p class="subtitle-color-preview" style=${() => `color: ${subtitleColor()}`}>
                    Sample subtitle text
                  </p>
                </div>
                <span class="settings-row-chevron" aria-hidden="true"></span>
              </section>

              <section class="settings-list-row settings-list-row--avatar">
                <span class="settings-row-icon settings-row-icon--avatar" aria-hidden="true"></span>
                <div class="settings-row-copy">
                  <h3>Avatar</h3>
                  <p>${() => getAvatarChoiceLabel(avatarChoice())}</p>
                </div>
                <div class="settings-row-control avatar-settings-panel">
                  <div class="avatar-style-preview-wrap">
                    <div
                      ref=${(el) => { avatarPreviewRef = el; }}
                      class=${computeAvatarPreviewClass}
                      style=${computeAvatarPreviewStyle}
                      aria-hidden="true"
                    ></div>
                  </div>

                  <div
                    class="avatar-style-options"
                    role="radiogroup"
                    aria-label="Profile icon style"
                  >
                    <label class="avatar-style-option">
                      <input
                        type="radio"
                        name="avatarStyle"
                        value="blue"
                        checked=${() => avatarChoice() === "blue"}
                        onChange=${() => handleAvatarChoiceChange("blue")}
                      />
                      <span class="avatar-style-swatch avatar-style-blue" aria-hidden="true"></span>
                      <span>Blue</span>
                    </label>
                    <label class="avatar-style-option">
                      <input
                        type="radio"
                        name="avatarStyle"
                        value="crimson"
                        checked=${() => avatarChoice() === "crimson"}
                        onChange=${() => handleAvatarChoiceChange("crimson")}
                      />
                      <span class="avatar-style-swatch avatar-style-crimson" aria-hidden="true"></span>
                      <span>Crimson</span>
                    </label>
                    <label class="avatar-style-option">
                      <input
                        type="radio"
                        name="avatarStyle"
                        value="emerald"
                        checked=${() => avatarChoice() === "emerald"}
                        onChange=${() => handleAvatarChoiceChange("emerald")}
                      />
                      <span class="avatar-style-swatch avatar-style-emerald" aria-hidden="true"></span>
                      <span>Emerald</span>
                    </label>
                    <label class="avatar-style-option">
                      <input
                        type="radio"
                        name="avatarStyle"
                        value="violet"
                        checked=${() => avatarChoice() === "violet"}
                        onChange=${() => handleAvatarChoiceChange("violet")}
                      />
                      <span class="avatar-style-swatch avatar-style-violet" aria-hidden="true"></span>
                      <span>Violet</span>
                    </label>
                    <label class="avatar-style-option">
                      <input
                        type="radio"
                        name="avatarStyle"
                        value="amber"
                        checked=${() => avatarChoice() === "amber"}
                        onChange=${() => handleAvatarChoiceChange("amber")}
                      />
                      <span class="avatar-style-swatch avatar-style-amber" aria-hidden="true"></span>
                      <span>Amber</span>
                    </label>
                    <label class="avatar-style-option avatar-style-option--custom">
                      <input
                        type="radio"
                        name="avatarStyle"
                        value="custom"
                        checked=${() => avatarChoice() === "custom"}
                        onChange=${() => handleAvatarChoiceChange("custom")}
                      />
                      <span
                        ref=${(el) => { avatarCustomThumbRef = el; }}
                        class=${computeCustomThumbClass}
                        style=${computeCustomThumbStyle}
                        aria-hidden="true"
                      ></span>
                      <span>Custom</span>
                    </label>
                  </div>

                  <div class="avatar-upload-controls">
                    <label class="avatar-upload-btn" for="avatarImageInput">Upload image</label>
                    <input
                      id="avatarImageInput"
                      type="file"
                      accept="image/*"
                      ref=${(el) => { avatarImageInputRef = el; }}
                      onChange=${handleAvatarImageChange}
                    />
                    <span class="avatar-upload-hint">
                      ${() => avatarUploadHint()}
                    </span>
                  </div>
                </div>
                <span class="settings-row-chevron" aria-hidden="true"></span>
              </section>
            </div>
          </section>

          <div class="settings-actions">
            <button class="save-btn" type="submit">
              Save Settings
            </button>
            <p
              class="save-status"
              role="status"
              aria-live="polite"
            ></p>
          </div>
        </form>

        <section
          class="settings-section-block settings-section-block--upload"
          id="uploadSection"
          aria-labelledby="uploadSectionTitle"
        >
          <h2 id="uploadSectionTitle" class="settings-section-title">
            Uploads
          </h2>
          ${UploadSection}
        </section>

        <section
          class="settings-section-block"
          id="maintenanceSection"
          aria-labelledby="maintenanceTitle"
        >
          <h2 id="maintenanceTitle" class="settings-section-title">
            Maintenance
          </h2>
          <div class="settings-list-card">
            <section class="settings-list-row">
              <span class="settings-row-icon settings-row-icon--cache" aria-hidden="true"></span>
              <div class="settings-row-copy">
                <h3>Cache</h3>
                <p>${() => cacheClearStatus() || "Server metadata and source cache"}</p>
              </div>
              <div class="settings-row-control maintenance-inline">
                <button
                  class="clear-cache-btn"
                  type="button"
                  disabled=${() => isClearingCaches()}
                  onClick=${handleClearAllCaches}
                >
                  Clear All Caches
                </button>
                <p
                  class=${() => {
                    let cls = "cache-clear-status";
                    const tone = cacheClearTone();
                    if (tone === "success") cls += " status-success";
                    else if (tone === "error") cls += " status-error";
                    return cls;
                  }}
                  role="status"
                  aria-live="polite"
                >${() => cacheClearStatus()}</p>
              </div>
              <span class="settings-row-chevron" aria-hidden="true"></span>
            </section>
          </div>
        </section>
      </section>
    </main>
  </div>`;
}

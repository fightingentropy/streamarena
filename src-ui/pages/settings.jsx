import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import {
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
  DEFAULT_AUDIO_LANGUAGE_PREF_KEY,
  DEFAULT_SUBTITLE_COLOR,
  normalizeDefaultAudioLanguage,
  normalizeSubtitleColor,
} from "../lib/preferences.js";
import { setRuntimeStyleRule } from "../lib/runtime-styles.js";
import { handleAuthFailureResponse } from "../lib/auth.js";

// ─── Defaults ───────────────────────────────────────────────────────────────
const DEFAULT_AVATAR_STYLE = "blue";
const DEFAULT_AVATAR_MODE = "preset";
const AVATAR_OUTPUT_SIZE_PX = 180;

// ─── Supported value sets ───────────────────────────────────────────────────
const supportedAvatarChoices = new Set([...supportedAvatarStyles, "custom"]);

// ─── Normalization helpers ──────────────────────────────────────────────────

function normalizeAvatarChoice(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (supportedAvatarChoices.has(normalized)) return normalized;
  return DEFAULT_AVATAR_STYLE;
}

function labelFromMap(value, labels, fallback) {
  return labels[String(value || "").trim().toLowerCase()] || fallback;
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

function getRealDebridStatusLabel(configured, maskedKey, loadState) {
  if (loadState === "loading") return "Loading…";
  if (loadState === "error") return "Unavailable";
  if (!configured) return "Off";
  return maskedKey ? `On (${maskedKey})` : "On";
}

function getLocalTorrentStatusLabel(enabled, loadState) {
  if (loadState === "loading") return "Loading…";
  if (loadState === "error") return "Unavailable";
  return enabled ? "On" : "Off";
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

// ─── Persist helpers (localStorage + server sync) ───────────────────────────

let onPreferenceSyncError = null;

export function setPreferenceSyncErrorHandler(handler) {
  onPreferenceSyncError = typeof handler === "function" ? handler : null;
}

function syncPreferenceToServer(payload) {
  fetch("/api/user/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then((res) => {
      if (handleAuthFailureResponse(res)) return;
      if (!res.ok) throw new Error(`Preference sync failed: ${res.status}`);
    })
    .catch((error) => {
      // Don't claim success when the server is out of sync — surface it.
      console.warn("Failed to sync preference to server", error);
      onPreferenceSyncError?.(error);
    });
}

function persistSubtitleColorPreference(value) {
  const normalized = normalizeSubtitleColor(value);
  try {
    if (normalized === DEFAULT_SUBTITLE_COLOR) localStorage.removeItem(SUBTITLE_COLOR_PREF_KEY);
    else localStorage.setItem(SUBTITLE_COLOR_PREF_KEY, normalized);
  } catch {}
  syncPreferenceToServer({ [SUBTITLE_COLOR_PREF_KEY]: normalized });
  return normalized;
}

function persistDefaultAudioLanguage(value) {
  const normalized = normalizeDefaultAudioLanguage(value);
  try {
    if (normalized === "en") localStorage.removeItem(DEFAULT_AUDIO_LANGUAGE_PREF_KEY);
    else localStorage.setItem(DEFAULT_AUDIO_LANGUAGE_PREF_KEY, normalized);
  } catch {}
  syncPreferenceToServer({ [DEFAULT_AUDIO_LANGUAGE_PREF_KEY]: normalized });
  return normalized;
}

function persistAvatarStylePreference(styleValue) {
  const style = normalizeAvatarStyle(styleValue);
  try {
    if (style === DEFAULT_AVATAR_STYLE) localStorage.removeItem(PROFILE_AVATAR_STYLE_PREF_KEY);
    else localStorage.setItem(PROFILE_AVATAR_STYLE_PREF_KEY, style);
  } catch {}
  syncPreferenceToServer({ [PROFILE_AVATAR_STYLE_PREF_KEY]: style });
  return style;
}

function persistAvatarModePreference(modeValue) {
  const mode = normalizeAvatarMode(modeValue);
  try {
    if (mode === DEFAULT_AVATAR_MODE) localStorage.removeItem(PROFILE_AVATAR_MODE_PREF_KEY);
    else localStorage.setItem(PROFILE_AVATAR_MODE_PREF_KEY, mode);
  } catch {}
  syncPreferenceToServer({ [PROFILE_AVATAR_MODE_PREF_KEY]: mode });
  return mode;
}

function persistAvatarImagePreference(imageData) {
  const safeImage = sanitizeAvatarImageData(imageData);
  try {
    if (!safeImage) localStorage.removeItem(PROFILE_AVATAR_IMAGE_PREF_KEY);
    else localStorage.setItem(PROFILE_AVATAR_IMAGE_PREF_KEY, safeImage);
  } catch {}
  syncPreferenceToServer({ [PROFILE_AVATAR_IMAGE_PREF_KEY]: safeImage || "" });
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
    "streamarena-stream-quality-pref",
    "streamarena-source-filter-allowed-formats",
    "streamarena-source-filter-results-limit",
    "streamarena-source-filter-min-seeders",
    "streamarena-source-filter-language",
    "streamarena-source-filter-audio-profile",
    "streamarena-resolver-provider",
    "streamarena-remux-video-mode",
  ];
  try { deprecatedKeys.forEach((key) => localStorage.removeItem(key)); }
  catch {}
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function SettingsPage() {
  // ── Reactive state ──────────────────────────────────────────────────────
  const [subtitleColor, setSubtitleColor] = createSignal(getStoredSubtitleColorPreference());
  const [defaultAudioLang, setDefaultAudioLang] = createSignal(getStoredDefaultAudioLanguage());
  const [realDebridConfigured, setRealDebridConfigured] = createSignal(false);
  const [realDebridMaskedApiKey, setRealDebridMaskedApiKey] = createSignal("");
  const [realDebridApiKeyInput, setRealDebridApiKeyInput] = createSignal("");
  const [localTorrentEnabled, setLocalTorrentEnabled] = createSignal(false);
  const [realDebridStatus, setRealDebridStatus] = createSignal("");
  const [realDebridLoadState, setRealDebridLoadState] = createSignal("loading");
  const [realDebridApiKeyDirty, setRealDebridApiKeyDirty] = createSignal(false);
  const [localTorrentDirty, setLocalTorrentDirty] = createSignal(false);

  // Avatar state
  const storedAvatarStyle = getStoredAvatarStylePreference();
  const storedAvatarMode = getStoredAvatarModePreference();
  const storedAvatarImage = getStoredAvatarImagePreference();
  const initialAvatarChoice = (storedAvatarMode === "custom" && storedAvatarImage) ? "custom" : storedAvatarStyle;

  const [avatarChoice, setAvatarChoice] = createSignal(initialAvatarChoice);
  const [pendingCustomImage, setPendingCustomImage] = createSignal(storedAvatarImage);
  const [avatarUploadHint, setAvatarUploadHint] = createSignal("");

  // Toast state
  const [toastMessage, setToastMessage] = createSignal("");
  const [toastVisible, setToastVisible] = createSignal(false);
  let toastTimeout = 0;

  // Refs for imperative DOM access
  let avatarImageInputRef;
  createEffect(() => {
    setRuntimeStyleRule(".subtitle-color-preview", {
      color: normalizeSubtitleColor(subtitleColor()),
    });
  });

  // ── Init ────────────────────────────────────────────────────────────────
  clearDeprecatedSourcePreferenceStorage();
  onMount(() => {
    void loadRealDebridSetting();
  });

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

  function computeAvatarPreviewImageSrc() {
    return avatarChoice() === "custom"
      ? sanitizeAvatarImageData(pendingCustomImage())
      : "";
  }

  function computeCustomThumbClass() {
    const customImg = sanitizeAvatarImageData(pendingCustomImage());
    if (customImg) {
      return "avatar-style-swatch avatar-style-custom-thumb avatar-style-custom-image";
    }
    return "avatar-style-swatch avatar-style-custom-thumb";
  }

  function computeCustomThumbImageSrc() {
    return sanitizeAvatarImageData(pendingCustomImage());
  }

  // ── Event handlers ──────────────────────────────────────────────────────

  function handleSubtitleColorInput(e) {
    setSubtitleColor(normalizeSubtitleColor(e.target.value));
  }

  function handleSubtitleColorReset() {
    setSubtitleColor(DEFAULT_SUBTITLE_COLOR);
  }

  function handleDefaultAudioLangChange(e) {
    setDefaultAudioLang(normalizeDefaultAudioLanguage(e.target.value));
  }

  function handleRealDebridApiKeyInput(e) {
    const nextValue = String(e.target.value || "");
    setRealDebridApiKeyInput(nextValue);
    setRealDebridApiKeyDirty(Boolean(nextValue.trim()));
  }

  function canToggleLocalTorrentCache() {
    return realDebridLoadState() !== "loading";
  }

  function handleLocalTorrentEnabledChange(e) {
    const nextEnabled = canToggleLocalTorrentCache() && Boolean(e.target.checked);
    if (nextEnabled !== localTorrentEnabled()) {
      setLocalTorrentDirty(true);
    }
    setLocalTorrentEnabled(nextEnabled);
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

  async function loadRealDebridSetting() {
    setRealDebridLoadState("loading");
    setRealDebridStatus("Loading…");
    try {
      const response = await fetch("/api/user/torrent-settings", { cache: "no-store" });
      if (handleAuthFailureResponse(response)) return;
      if (!response.ok) {
        throw new Error(`Unable to load Real-Debrid settings (${response.status}).`);
      }
      const payload = await response.json();
      setRealDebridConfigured(Boolean(payload?.configured));
      setRealDebridMaskedApiKey(String(payload?.maskedApiKey || ""));
      if (!localTorrentDirty()) {
        setLocalTorrentEnabled(Boolean(payload?.localTorrentEnabled));
      }
      setRealDebridLoadState("loaded");
      setRealDebridStatus("");
    } catch (error) {
      setRealDebridLoadState("error");
      setRealDebridStatus(
        error instanceof Error ? error.message : "Unable to load Real-Debrid settings.",
      );
    }
  }

  async function saveRealDebridSettings() {
    const shouldSaveApiKey = realDebridApiKeyDirty();
    const shouldSaveLocalTorrent = localTorrentDirty();
    if (!shouldSaveApiKey && !shouldSaveLocalTorrent) {
      return false;
    }

    const apiKey = String(realDebridApiKeyInput() || "").trim();
    const body = {};
    if (shouldSaveApiKey && apiKey) body.apiKey = apiKey;
    if (shouldSaveLocalTorrent) body.localTorrentEnabled = localTorrentEnabled();
    if (Object.keys(body).length === 0) {
      return false;
    }

    setRealDebridStatus("Saving...");
    const response = await fetch("/api/user/torrent-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (handleAuthFailureResponse(response)) {
      throw new Error("Your session expired. Please sign in again.");
    }
    if (!response.ok) {
      throw new Error(payload?.error || payload?.message || "Unable to save Real-Debrid key.");
    }
    setRealDebridConfigured(Boolean(payload?.configured));
    setRealDebridMaskedApiKey(String(payload?.maskedApiKey || ""));
    setLocalTorrentEnabled(Boolean(payload?.localTorrentEnabled));
    setRealDebridApiKeyInput("");
    setRealDebridApiKeyDirty(false);
    setLocalTorrentDirty(false);
    setRealDebridLoadState("loaded");
    setRealDebridStatus("Saved");
    return true;
  }

  async function handleClearRealDebridApiKey() {
    setRealDebridStatus("Clearing...");
    try {
      const response = await fetch("/api/user/torrent-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "" }),
      });
      const payload = await response.json().catch(() => ({}));
      if (handleAuthFailureResponse(response)) {
        throw new Error("Your session expired. Please sign in again.");
      }
      if (!response.ok) {
        throw new Error(payload?.error || payload?.message || "Unable to clear Real-Debrid key.");
      }
      setRealDebridConfigured(false);
      setRealDebridMaskedApiKey("");
      setRealDebridApiKeyInput("");
      setRealDebridApiKeyDirty(false);
      setLocalTorrentDirty(false);
      setRealDebridLoadState("loaded");
      setRealDebridStatus("Cleared");
      showToast("Real-Debrid key cleared");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to clear Real-Debrid key.";
      setRealDebridStatus(message);
      showToast(message);
    }
  }

  async function handleFormSubmit(e) {
    e.preventDefault();

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

    const savedDefaultAudioLang = persistDefaultAudioLanguage(defaultAudioLang());
    setDefaultAudioLang(savedDefaultAudioLang);

    try {
      await saveRealDebridSettings();
      showToast("Settings saved");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to save Settings.";
      setRealDebridStatus(message);
      showToast(message);
    }
  }

  // ── Template ────────────────────────────────────────────────────────────

  return <><div data-solid-page-root="" class="solid-page-root">
    <div
      class={"toast" + (toastVisible() ? " toast--visible" : "")}
      id="settingsToast"
    >{toastMessage()}</div>

    <header class="settings-topbar">
      <a class="settings-wordmark-link" href="/" aria-label="Back to browse">
        <span class="brand-wordmark settings-wordmark">StreamArena</span>
      </a>
      <a class="settings-profile-control" href="/" aria-label="Back to browse">
        <span
          class={`${computeAvatarPreviewClass()} settings-topbar-avatar`}
          aria-hidden="true"
        >
          {computeAvatarPreviewImageSrc() ? (
            <img class="avatar-custom-image-media" src={computeAvatarPreviewImageSrc()} alt="" />
          ) : null}
        </span>
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
          <a class="settings-nav-item" href="#profileSection">
            <span class="settings-nav-glyph settings-nav-glyph--profile" aria-hidden="true"></span>
            <span>Profile</span>
          </a>
        </nav>
      </aside>

      <section class="settings-content" aria-labelledby="settingsPageTitle">
        <form class="settings-form" onSubmit={handleFormSubmit}>
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
                <span class="settings-row-icon settings-row-icon--audio" aria-hidden="true"></span>
                <div class="settings-row-copy">
                  <h3>Default audio</h3>
                  <p>{getLanguageLabel(defaultAudioLang())}</p>
                </div>
                <label class="settings-row-control settings-select-field" for="defaultAudioLanguage">
                  <span class="settings-field-label">Language</span>
                  <select
                    id="defaultAudioLanguage"
                    name="defaultAudioLanguage"
                    onChange={handleDefaultAudioLangChange}
                  >
                    <option value="en" selected={defaultAudioLang() === "en"}>English</option>
                    <option value="auto" selected={defaultAudioLang() === "auto"}>Auto</option>
                    <option value="ja" selected={defaultAudioLang() === "ja"}>Japanese</option>
                    <option value="ko" selected={defaultAudioLang() === "ko"}>Korean</option>
                    <option value="zh" selected={defaultAudioLang() === "zh"}>Chinese</option>
                    <option value="fr" selected={defaultAudioLang() === "fr"}>French</option>
                    <option value="es" selected={defaultAudioLang() === "es"}>Spanish</option>
                    <option value="de" selected={defaultAudioLang() === "de"}>German</option>
                    <option value="it" selected={defaultAudioLang() === "it"}>Italian</option>
                    <option value="pt" selected={defaultAudioLang() === "pt"}>Portuguese</option>
                    <option value="nl" selected={defaultAudioLang() === "nl"}>Dutch</option>
                    <option value="ro" selected={defaultAudioLang() === "ro"}>Romanian</option>
                  </select>
                </label>
                <span class="settings-row-chevron" aria-hidden="true"></span>
              </section>

              <section class="settings-list-row settings-list-row--debrid">
                <span class="settings-row-icon settings-row-icon--debrid" aria-hidden="true"></span>
                <div class="settings-row-copy">
                  <h3>Real-Debrid</h3>
                  <p>{getRealDebridStatusLabel(
                    realDebridConfigured(),
                    realDebridMaskedApiKey(),
                    realDebridLoadState(),
                  )}</p>
                </div>
                <div class="settings-row-control real-debrid-controls">
                  <label class="settings-text-field" for="realDebridApiKey">
                    <span class="settings-field-label">API token</span>
                    <input
                      id="realDebridApiKey"
                      name="realDebridApiKey"
                      type="password"
                      autocomplete="off"
                      spellcheck="false"
                      value={realDebridApiKeyInput()}
                      placeholder={realDebridConfigured() ? "Leave blank to keep current token" : "Paste token"}
                      onInput={handleRealDebridApiKeyInput}
                    />
                  </label>
                  <button
                    class="real-debrid-clear-btn"
                    type="button"
                    hidden={!realDebridConfigured()}
                    onClick={handleClearRealDebridApiKey}
                  >
                    Clear
                  </button>
                  <p class="real-debrid-status" role="status" aria-live="polite">
                    {realDebridStatus()}
                  </p>
                </div>
                <span class="settings-row-chevron" aria-hidden="true"></span>
              </section>

              <section class="settings-list-row settings-list-row--debrid">
                <span class="settings-row-icon settings-row-icon--torrent" aria-hidden="true"></span>
                <div class="settings-row-copy">
                  <h3>Torrent streaming</h3>
                  <p>{getLocalTorrentStatusLabel(localTorrentEnabled(), realDebridLoadState())}</p>
                </div>
                <div class="settings-row-control local-torrent-controls">
                  <label
                    class={"settings-toggle-control" + (canToggleLocalTorrentCache() ? "" : " is-disabled")}
                    for="localTorrentEnabled"
                  >
                    <input
                      id="localTorrentEnabled"
                      name="localTorrentEnabled"
                      type="checkbox"
                      role="switch"
                      checked={localTorrentEnabled()}
                      disabled={!canToggleLocalTorrentCache()}
                      onChange={handleLocalTorrentEnabledChange}
                    />
                    <span class="settings-toggle-track" aria-hidden="true">
                      <span class="settings-toggle-thumb"></span>
                    </span>
                    <span class="settings-toggle-label">Enabled</span>
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
                  <p>{subtitleColor()}</p>
                </div>
                <div class="settings-row-control subtitle-color-controls">
                  <label class="subtitle-color-picker-label" for="subtitleColorInput">Color</label>
                  <input
                    id="subtitleColorInput"
                    name="subtitleColor"
                    type="color"
                    value={subtitleColor()}
                    onInput={handleSubtitleColorInput}
                  />
                  <button
                    class="subtitle-color-reset-btn"
                    type="button"
                    onClick={handleSubtitleColorReset}
                  >
                    Reset
                  </button>
                  <p class="subtitle-color-preview">
                    Sample subtitle text
                  </p>
                </div>
                <span class="settings-row-chevron" aria-hidden="true"></span>
              </section>

              <section class="settings-list-row settings-list-row--avatar">
                <span class="settings-row-icon settings-row-icon--avatar" aria-hidden="true"></span>
                <div class="settings-row-copy">
                  <h3>Avatar</h3>
                  <p>{getAvatarChoiceLabel(avatarChoice())}</p>
                </div>
                <div class="settings-row-control avatar-settings-panel">
                  <div class="avatar-style-preview-wrap">
                    <div
                      class={computeAvatarPreviewClass}
                      aria-hidden="true"
                    >
                      {computeAvatarPreviewImageSrc() ? (
                        <img class="avatar-custom-image-media" src={computeAvatarPreviewImageSrc()} alt="" />
                      ) : null}
                    </div>
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
                        checked={avatarChoice() === "blue"}
                        onChange={() => handleAvatarChoiceChange("blue")}
                      />
                      <span class="avatar-style-swatch avatar-style-blue" aria-hidden="true"></span>
                      <span>Blue</span>
                    </label>
                    <label class="avatar-style-option">
                      <input
                        type="radio"
                        name="avatarStyle"
                        value="crimson"
                        checked={avatarChoice() === "crimson"}
                        onChange={() => handleAvatarChoiceChange("crimson")}
                      />
                      <span class="avatar-style-swatch avatar-style-crimson" aria-hidden="true"></span>
                      <span>Crimson</span>
                    </label>
                    <label class="avatar-style-option">
                      <input
                        type="radio"
                        name="avatarStyle"
                        value="emerald"
                        checked={avatarChoice() === "emerald"}
                        onChange={() => handleAvatarChoiceChange("emerald")}
                      />
                      <span class="avatar-style-swatch avatar-style-emerald" aria-hidden="true"></span>
                      <span>Emerald</span>
                    </label>
                    <label class="avatar-style-option">
                      <input
                        type="radio"
                        name="avatarStyle"
                        value="violet"
                        checked={avatarChoice() === "violet"}
                        onChange={() => handleAvatarChoiceChange("violet")}
                      />
                      <span class="avatar-style-swatch avatar-style-violet" aria-hidden="true"></span>
                      <span>Violet</span>
                    </label>
                    <label class="avatar-style-option">
                      <input
                        type="radio"
                        name="avatarStyle"
                        value="amber"
                        checked={avatarChoice() === "amber"}
                        onChange={() => handleAvatarChoiceChange("amber")}
                      />
                      <span class="avatar-style-swatch avatar-style-amber" aria-hidden="true"></span>
                      <span>Amber</span>
                    </label>
                    <label class="avatar-style-option avatar-style-option--custom">
                      <input
                        type="radio"
                        name="avatarStyle"
                        value="custom"
                        checked={avatarChoice() === "custom"}
                        onChange={() => handleAvatarChoiceChange("custom")}
                      />
                      <span
                        class={computeCustomThumbClass}
                        aria-hidden="true"
                      >
                        {computeCustomThumbImageSrc() ? (
                          <img class="avatar-custom-image-media" src={computeCustomThumbImageSrc()} alt="" />
                        ) : null}
                      </span>
                      <span>Custom</span>
                    </label>
                  </div>

                  <div class="avatar-upload-controls">
                    <label class="avatar-upload-btn" for="avatarImageInput">Upload image</label>
                    <input
                      id="avatarImageInput"
                      type="file"
                      accept="image/*"
                      ref={(el) => { avatarImageInputRef = el; }}
                      onChange={handleAvatarImageChange}
                    />
                    <span class="avatar-upload-hint">
                      {avatarUploadHint()}
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
      </section>
    </main>
  </div></>;
}

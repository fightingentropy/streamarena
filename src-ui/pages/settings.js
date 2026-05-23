import html from "solid-js/html";
import { createSignal, onCleanup } from "solid-js";
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
  DEFAULT_AUDIO_LANGUAGE_PREF_KEY,
  DEFAULT_SUBTITLE_COLOR,
  DEFAULT_STREAM_QUALITY_PREFERENCE,
  normalizeStreamQualityPreference,
  normalizeDefaultAudioLanguage,
  normalizeSubtitleColor,
  getStoredStreamQualityPreference,
} from "../lib/preferences.js";

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
    "netflix-source-filter-min-seeders",
    "netflix-source-filter-language",
    "netflix-source-filter-audio-profile",
    "netflix-resolver-provider",
    "netflix-remux-video-mode",
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

    const savedDefaultAudioLang = persistDefaultAudioLanguage(defaultAudioLang());
    setDefaultAudioLang(savedDefaultAudioLang);

    showToast("Settings saved");
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
          <a class="settings-nav-item" href="#profileSection">
            <span class="settings-nav-glyph settings-nav-glyph--profile" aria-hidden="true"></span>
            <span>Profile</span>
          </a>
        </nav>
      </aside>

      <section class="settings-content" aria-labelledby="settingsPageTitle">
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
                <label class="settings-row-control settings-select-field" for="defaultAudioLanguage">
                  <span class="settings-field-label">Language</span>
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
      </section>
    </main>
  </div>`;
}

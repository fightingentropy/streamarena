// ---------------------------------------------------------------------------
// Shared constants and utility functions used across multiple page scripts.
// ---------------------------------------------------------------------------

// --- Preference key constants ---
export const STREAM_QUALITY_PREF_KEY = "netflix-stream-quality-pref";
export const PROFILE_AVATAR_STYLE_PREF_KEY = "netflix-profile-avatar-style";
export const PROFILE_AVATAR_MODE_PREF_KEY = "netflix-profile-avatar-mode";
export const PROFILE_AVATAR_IMAGE_PREF_KEY = "netflix-profile-avatar-image";
export const LIBRARY_EDIT_MODE_PREF_KEY = "netflix-library-edit-mode";

// --- Stream quality ---
export const supportedStreamQualityPreferences = new Set([
  "auto",
  "2160p",
  "1080p",
  "720p",
]);

// --- Avatar styles ---
export const supportedAvatarStyles = new Set([
  "blue",
  "crimson",
  "emerald",
  "violet",
  "amber",
]);
export const avatarStyleClassNames = Array.from(supportedAvatarStyles).map(
  (style) => `avatar-style-${style}`,
);

export function normalizeAvatarStyle(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (supportedAvatarStyles.has(normalized)) {
    return normalized;
  }
  return "blue";
}

export function normalizeAvatarMode(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "custom" ? "custom" : "preset";
}

export function sanitizeAvatarImageData(value) {
  const raw = String(value || "").trim();
  if (!raw.startsWith("data:image/")) {
    return "";
  }
  if (raw.length > 2_000_000) {
    return "";
  }
  return raw;
}

export function getStoredAvatarStylePreference() {
  try {
    return normalizeAvatarStyle(
      localStorage.getItem(PROFILE_AVATAR_STYLE_PREF_KEY),
    );
  } catch {
    return "blue";
  }
}

export function getStoredAvatarModePreference() {
  try {
    return normalizeAvatarMode(
      localStorage.getItem(PROFILE_AVATAR_MODE_PREF_KEY),
    );
  } catch {
    return "preset";
  }
}

export function getStoredAvatarImagePreference() {
  try {
    return sanitizeAvatarImageData(
      localStorage.getItem(PROFILE_AVATAR_IMAGE_PREF_KEY),
    );
  } catch {
    return "";
  }
}

// --- TMDB ---
export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

// --- Continue-watching metadata ---
const CONTINUE_WATCHING_META_KEY = "netflix-continue-watching-meta";

export function readContinueWatchingMetaMap() {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(CONTINUE_WATCHING_META_KEY) || "{}",
    );
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// --- HTML escaping ---
export function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

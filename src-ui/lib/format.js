// ---------------------------------------------------------------------------
// Shared formatting and file-related utility functions.
// Used by upload page and upload-section component.
// ---------------------------------------------------------------------------

export function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let unitIndex = -1;
  let scaled = bytes;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[unitIndex]}`;
}

export function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
}

export function normalizeFileExtension(name) {
  const value = String(name || "")
    .toLowerCase()
    .trim();
  if (value.endsWith(".mp4")) return ".mp4";
  if (value.endsWith(".mkv")) return ".mkv";
  return "";
}

export function detectCompatibilityInfoFromFilename(fileName) {
  const tokens = String(fileName || "")
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
  const tokenSet = new Set(tokens);
  const reasons = [];
  let canOfferAudioTranscode = false;

  if (
    tokenSet.has("dts") ||
    tokenSet.has("dtshd") ||
    tokenSet.has("dtsma") ||
    tokenSet.has("dca")
  ) {
    reasons.push("Audio codec(s) 'dts' are likely not Chrome-compatible.");
    canOfferAudioTranscode = true;
  }

  return { warning: reasons.join(" "), canOfferAudioTranscode };
}

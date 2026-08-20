export const LIVE_IFRAME_SOURCE_PREFIX = "live-iframe:";

// Direct third-party iframe playback is disabled. A future provider must be
// reviewed and added explicitly here before a `live-iframe:` source can load.
// Keeping the allowlist empty makes legacy catalogue entries and user-crafted
// query parameters fail closed. The player contains no iframe adoption path;
// this parser remains only so old saved inputs are classified as unsupported.
const TRUSTED_LIVE_IFRAME_ORIGINS = new Set([]);

export function parseLiveIframePlaybackSource(source, baseOrigin = globalThis.location?.origin) {
  const value = String(source || "").trim();
  if (!value.startsWith(LIVE_IFRAME_SOURCE_PREFIX) || !baseOrigin) {
    return "";
  }

  try {
    const payload = decodeURIComponent(value.slice(LIVE_IFRAME_SOURCE_PREFIX.length));
    const url = new URL(payload, baseOrigin);
    if (url.protocol !== "https:" || !TRUSTED_LIVE_IFRAME_ORIGINS.has(url.origin)) {
      return "";
    }
    return url.toString();
  } catch {
    return "";
  }
}

/**
 * Canonical HLS playback-source detection shared across player modules.
 */

/**
 * @param {string} source
 * @param {string} [origin]
 * @returns {boolean}
 */
export function isHlsPlaybackSource(
  source,
  origin = typeof window !== "undefined" ? window.location.origin : "http://localhost",
) {
  if (!source) {
    return false;
  }

  try {
    const absoluteSource = new URL(source, origin).toString();
    return (
      absoluteSource.includes("/api/hls/master.m3u8") ||
      absoluteSource.includes("/api/live/hls.m3u8") ||
      absoluteSource.toLowerCase().includes(".m3u8")
    );
  } catch {
    return String(source || "").toLowerCase().includes(".m3u8");
  }
}

/**
 * @param {string} source
 * @param {{
 *   hasNativeHlsPlaybackSupport: () => boolean,
 *   hasHlsJsPlaybackSupport: () => boolean,
 *   origin?: string,
 * }} capabilities
 * @returns {boolean}
 */
export function shouldUseHlsJsForPlayback(source, capabilities) {
  const origin =
    capabilities.origin ||
    (typeof window !== "undefined" ? window.location.origin : "http://localhost");
  return (
    isHlsPlaybackSource(source, origin) &&
    !capabilities.hasNativeHlsPlaybackSupport() &&
    capabilities.hasHlsJsPlaybackSupport()
  );
}

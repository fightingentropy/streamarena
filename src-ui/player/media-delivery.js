function parsePublicHlsRoute(value, origin) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim(), origin);
    if (url.pathname !== "/api/live/hls.m3u8" ||
        !["https:", "http:"].includes(url.protocol) ||
        url.username || url.password || url.searchParams.has("privateSession") ||
        url.searchParams.get("externalEmbed") !== "1" ||
        !url.searchParams.get("input") || !url.searchParams.get("expires") ||
        !(url.searchParams.get("sig") || url.searchParams.get("sigV2"))) return null;
    return url;
  } catch {
    return null;
  }
}

// directMediaUrls is an additive web opt-in. Leave legacy payload fields intact
// for installed native clients and keep every fallback on the same provider.
export function buildMediaDeliveryQueue(primary, fallbacks = [], directMediaUrls = [], {
  origin = typeof window !== "undefined" ? window.location.origin : "http://localhost",
} = {}) {
  const legacy = [primary, ...(Array.isArray(fallbacks) ? fallbacks : [])]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim());
  const primaryRoute = parsePublicHlsRoute(primary, origin);
  const direct = (Array.isArray(directMediaUrls) ? directMediaUrls : []).slice(0, 8)
    .filter((value) => {
      if (!primaryRoute || typeof value !== "string" || !/^https:\/\//i.test(value.trim())) return false;
      const route = parsePublicHlsRoute(value, origin);
      return route && ["input", "referer", "expires", "sig", "sigV2"]
        .every((key) => route.searchParams.get(key) === primaryRoute.searchParams.get(key));
    })
    .map((value) => value.trim());
  const seen = new Set();
  return [...direct, ...legacy].filter((value) => {
    let key = value;
    try { key = new URL(value, origin).href; } catch { /* Preserve legacy URL handling. */ }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

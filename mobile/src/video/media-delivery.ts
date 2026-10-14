import { API_ORIGIN } from "@/lib/config";

function publicHlsRoute(value: string): URL | null {
  try {
    const url = new URL(value, API_ORIGIN);
    if (url.pathname !== "/api/live/hls.m3u8" ||
        !["https:", "http:"].includes(url.protocol) || url.username || url.password ||
        url.searchParams.has("privateSession") || url.searchParams.get("externalEmbed") !== "1" ||
        !url.searchParams.get("input") || !url.searchParams.get("expires") ||
        !(url.searchParams.get("sig") || url.searchParams.get("sigV2"))) return null;
    return url;
  } catch {
    return null;
  }
}

// Opt in only to signed, public routes for the exact same media grant. Private
// sessions, local downloads, and older servers retain their existing delivery path.
// Do not copy cookies or turn a private API URL into a public media-host URL.
export function mediaDeliveryUrls(
  primary: string,
  fallbacks: string[] = [],
  directMediaUrls: string[] = [],
): string[] {
  const legacy = [primary, ...(Array.isArray(fallbacks) ? fallbacks : [])]
    .filter((value): value is string => typeof value === "string" && !!value.trim())
    .map((value) => value.trim());
  const primaryRoute = publicHlsRoute(primary);
  const direct = (Array.isArray(directMediaUrls) ? directMediaUrls : []).slice(0, 8)
    .filter((value) => {
      if (!primaryRoute || typeof value !== "string" || !/^https:\/\//i.test(value.trim())) return false;
      const route = publicHlsRoute(value.trim());
      return route && ["input", "referer", "expires", "sig", "sigV2"]
        .every((key) => route.searchParams.get(key) === primaryRoute.searchParams.get(key));
    })
    .map((value) => value.trim());
  const seen = new Set<string>();
  return [...direct, ...legacy].filter((value) => {
    let key = value;
    try { key = new URL(value, API_ORIGIN).href; } catch { /* Preserve legacy routing. */ }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

import type { Href } from "expo-router";

// Typed Href builders for dynamic routes (typedRoutes is on, so prefer these over
// hand-built path strings).
export function titleHref(mediaType: string, id: string | number): Href {
  return { pathname: "/title/[mediaType]/[id]", params: { mediaType, id: String(id) } };
}

export function watchHref(id: string | number, params?: Record<string, string>): Href {
  return { pathname: "/watch/[id]", params: { id: String(id), ...(params ?? {}) } };
}

// Live playback reuses the watch screen in live mode (live=1). The actual stream request
// is staged via stageLivePlayRequest(); these params only drive display (title/subtitle).
export function liveWatchHref(id: string, params?: Record<string, string>): Href {
  return { pathname: "/watch/[id]", params: { id, live: "1", ...(params ?? {}) } };
}

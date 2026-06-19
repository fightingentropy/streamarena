import { API_ORIGIN } from "@/lib/config";

// Resolve an API path against the backend origin. Absolute URLs pass through.
export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_ORIGIN}${path.startsWith("/") ? "" : "/"}${path}`;
}

// Low-level data fetch. Authenticates with the streamarena `session` cookie, which
// React Native's native networking persists in NSHTTPCookieStorage and re-attaches
// on same-origin requests. HLS playback goes through the same origin, so the cookie
// authenticates segment fetches too — no URL signing needed for VOD.
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), { credentials: "include", ...init });
}

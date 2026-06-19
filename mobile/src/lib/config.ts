import Constants from "expo-constants";

// Base origin for the streamarena backend. Everything — API data calls, HLS
// playback, downloads — goes here.
//
// Resolution order:
//   1. Dev (Metro running): derive the Mac's LAN IP from the packager host and hit
//      the local Rust server on :5173. On the iOS simulator the host is
//      127.0.0.1 (shares the loopback); on a physical device it's the Mac's LAN IP
//      (a phone can't reach 127.0.0.1). Either way the local backend is used.
//   2. `extra.apiOrigin` from app config (prod default https://streamarena.xyz).
const DEFAULT_API_ORIGIN = "https://streamarena.xyz";
const DEV_API_PORT = 5173;

const CONFIG_ORIGIN = (
  (Constants.expoConfig?.extra as { apiOrigin?: string } | undefined)?.apiOrigin || ""
).replace(/\/+$/, "");

function devOrigin(): string | null {
  if (!__DEV__) return null;
  // hostUri looks like "192.168.1.5:8081" (device) or "127.0.0.1:8081" (sim).
  const hostUri =
    Constants.expoConfig?.hostUri ||
    (Constants as unknown as { expoGoConfig?: { hostUri?: string } }).expoGoConfig?.hostUri;
  const host = hostUri?.split(":")[0]?.trim();
  if (!host) return null;
  return `http://${host}:${DEV_API_PORT}`;
}

export const API_ORIGIN: string =
  (devOrigin() || CONFIG_ORIGIN || DEFAULT_API_ORIGIN).replace(/\/+$/, "") || DEFAULT_API_ORIGIN;

// Prefix a path-relative URL with the API origin. Absolute (http(s)://, //host)
// and local (file:, data:, blob:) URLs are returned UNCHANGED so signed query
// strings and already-encoded `?input=` playback URLs survive verbatim — a
// re-encoded media URL returns 403 and playback silently fails.
export function toAbsoluteApiUrl(url: string | null | undefined): string {
  if (!url) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) return url;
  return `${API_ORIGIN}${url.startsWith("/") ? "" : "/"}${url}`;
}

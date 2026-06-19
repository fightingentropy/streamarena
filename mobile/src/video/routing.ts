import { toAbsoluteApiUrl } from "@/lib/config";
import { buildHlsMasterUrl, type ResolvedSource } from "@/lib/streamarena";
import type { VideoSource } from "./types";

// AVPlayer (react-native-video on iOS) reliably plays progressive MP4/MOV and HLS.
// It cannot play MKV/AVI/TS/WMV containers, so those are routed through the backend
// remux proxy, which repackages anything into clear MPEG-TS HLS.
const DIRECT_EXT = /\.(mp4|m4v|mov)(\?|#|$)/i;

// An already-HLS playlist: a real .m3u8, or one of the backend proxy/live endpoints
// (which return HLS regardless of extension). These play natively, no re-wrapping.
function isHlsUrl(url: string): boolean {
  return /\.m3u8(\?|#|$)/i.test(url) || /\/api\/(hls|live)\//i.test(url);
}

// Decide what URI to actually hand the <Video> element for a resolved source.
//   • Already HLS (embed/live/remux proxy) → play as-is.
//   • Clean MP4/MOV with the default audio → play the file directly (lighter on the
//     backend; no transcode).
//   • Exotic container, opaque URL, OR an explicit non-default audio stream (audio is
//     server-muxed by `&audioStream=`) → remux via /api/hls/master.m3u8.
// `audioStreamIndex` is the stream the caller wants baked in; only >=0 forces the proxy.
export function decideSource(resolved: ResolvedSource, audioStreamIndex?: number): VideoSource {
  const url = resolved.playableUrl || "";
  if (isHlsUrl(url)) return { uri: toAbsoluteApiUrl(url), isHls: true };

  const wantsServerAudio = typeof audioStreamIndex === "number" && audioStreamIndex >= 0;
  if (!wantsServerAudio && DIRECT_EXT.test(url)) {
    return { uri: toAbsoluteApiUrl(url), isHls: false };
  }
  return {
    uri: toAbsoluteApiUrl(buildHlsMasterUrl(url, wantsServerAudio ? audioStreamIndex : undefined)),
    isHls: true,
  };
}

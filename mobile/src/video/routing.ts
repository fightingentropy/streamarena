import { toAbsoluteApiUrl } from "@/lib/config";
import { buildHlsMasterUrl, type ResolvedSource } from "@/lib/streamarena";
import { getStripProxyPort, stripProxyMasterUrl } from "./strip-proxy";
import type { VideoSource } from "./types";

// The signed `/api/live/hls.m3u8` URL carries the source's referer (`&referer=`), empty
// for most embeds. Forward it to the proxy so its CDN fetches send the same Referer the
// backend relay would.
function refererOf(playableUrl: string): string {
  try {
    return new URL(toAbsoluteApiUrl(playableUrl)).searchParams.get("referer") || "";
  } catch {
    return "";
  }
}

// AVPlayer (react-native-video on iOS) reliably plays progressive MP4/MOV and HLS.
// It cannot play MKV/AVI/TS/WMV containers, so those are routed through the backend
// remux proxy, which repackages anything into clear MPEG-TS HLS.
const DIRECT_EXT = /\.(mp4|m4v|mov)(\?|#|$)/i;

// An already-HLS playlist: a real .m3u8, or the backend transcode proxy (which returns
// HLS regardless of extension). These play natively, no re-wrapping.
function isHlsUrl(url: string): boolean {
  return /\.m3u8(\?|#|$)/i.test(url) || /\/api\/hls\//i.test(url);
}

// External-embed VOD shares the live proxy URL. Its device relay handles provider
// referers and disguised segment prefixes. Live channels use a separate player path.
function isLiveProxyEmbed(url: string): boolean {
  return /\/api\/live\//i.test(url);
}

// Decide what URI to actually hand the <Video> element for a resolved source.
//   • External-embed VOD (live proxy) → the on-device strip proxy (default audio), which
//     fetches segments from the CDN and strips PNG prefixes when present.
//     Explicit audio-track picks fall back to the transcode
//     (audio is server-muxed); so does the rare case where the proxy hasn't started yet.
//   • Already HLS (real .m3u8 or the transcode proxy) → play as-is.
//   • Clean MP4/MOV with the default audio → play the file directly (lighter on the
//     backend; no transcode).
//   • Exotic container, opaque URL, OR an explicit non-default audio stream (audio is
//     server-muxed by `&audioStream=`) → remux via /api/hls/master.m3u8.
// `audioStreamIndex` is the stream the caller wants baked in; only >=0 forces the proxy.
export function decideSource(resolved: ResolvedSource, audioStreamIndex?: number): VideoSource {
  const url = resolved.playableUrl || "";
  const wantsServerAudio = typeof audioStreamIndex === "number" && audioStreamIndex >= 0;

  if (isLiveProxyEmbed(url)) {
    const port = getStripProxyPort();
    if (port && !wantsServerAudio) {
      // libVLC: AVPlayer rejects the strip-proxy stream (parses the playlist but computes
      // dur=0 and never fetches a segment); libVLC's software demuxer plays it cleanly.
      return { uri: stripProxyMasterUrl(port, toAbsoluteApiUrl(url), refererOf(url)), isHls: true, engine: "vlc" };
    }
    return {
      uri: toAbsoluteApiUrl(buildHlsMasterUrl(url, wantsServerAudio ? audioStreamIndex : undefined)),
      isHls: true,
    };
  }

  if (isHlsUrl(url)) return { uri: toAbsoluteApiUrl(url), isHls: true };

  if (!wantsServerAudio && DIRECT_EXT.test(url)) {
    return { uri: toAbsoluteApiUrl(url), isHls: false };
  }
  return {
    uri: toAbsoluteApiUrl(buildHlsMasterUrl(url, wantsServerAudio ? audioStreamIndex : undefined)),
    isHls: true,
  };
}

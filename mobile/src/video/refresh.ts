import { toAbsoluteApiUrl } from "@/lib/config";
import { buildHlsMasterUrl, type ResolvedSource } from "@/lib/streamarena";
import { decideSource } from "./routing";
import type { VideoSource } from "./types";
import { mediaDeliveryUrls } from "./media-delivery";

// Ordered in-place recovery options for a source that failed to play, tried before
// re-resolving from scratch:
//   1. each fallbackUrl the resolver already handed us (routed the same way), then
//   2. force the HLS remux proxy of the primary URL — only if we weren't already on
//      HLS — which rescues a direct file AVPlayer refuses to decode.
// When this list is exhausted the caller re-resolves with refreshResolve=1.
export function buildFallbackCandidates(resolved: ResolvedSource, audioStreamIndex = resolved.selectedAudioStreamIndex): VideoSource[] {
  const out: VideoSource[] = [];
  const primary = decideSource(resolved, audioStreamIndex);
  const seen = new Set<string>([primary.uri]);
  const push = (s: VideoSource) => {
    if (s.uri && !seen.has(s.uri)) {
      seen.add(s.uri);
      out.push(s);
    }
  };

  for (const fb of mediaDeliveryUrls(resolved.playableUrl, resolved.fallbackUrls, resolved.directMediaUrls).slice(1)) {
    push(decideSource({ ...resolved, playableUrl: fb, directMediaUrls: [] }, audioStreamIndex));
  }

  if (!primary.isHls && resolved.playableUrl) {
    push({
      uri: toAbsoluteApiUrl(buildHlsMasterUrl(resolved.playableUrl, audioStreamIndex)),
      isHls: true,
    });
  }
  return out;
}

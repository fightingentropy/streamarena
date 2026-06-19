import { toAbsoluteApiUrl } from "@/lib/config";
import type { LiveChannel } from "@/lib/live-channels";
import { resolveSportStream, resolveTwitchStream, type SportMatch } from "@/lib/live";

// One playable option for a live target. Exactly one resolution strategy is set:
//  • directUrl — a ready HLS URL (a direct channel, or an already-absolute playlist)
//  • sports    — resolve via /api/sports/stream (with the other streams as fallbacks)
//  • twitch    — resolve via /api/twitch/stream
export type LiveSourceOption = {
  id: string;
  label: string;
  quality?: string;
  directUrl?: string;
  sports?: { url: string; fallbackUrls?: string[] };
  twitch?: { channel: string };
};

// What the player needs to start a live stream. Carries multiple sources for the
// in-player switcher; the player resolves the chosen one to a concrete HLS URL.
export type LivePlayRequest = {
  id: string; // stable key (channel/match id)
  title: string;
  subtitle?: string;
  poster?: string;
  sources: LiveSourceOption[];
  initialSourceId?: string;
};

// Resolve a single option to a concrete, absolute HLS URL ready for <Video>.
export async function resolveLiveSourceUrl(opt: LiveSourceOption, signal?: AbortSignal): Promise<string> {
  if (opt.directUrl) return toAbsoluteApiUrl(opt.directUrl);
  if (opt.twitch) {
    // A failed resolve throws in getJson (backend 502) before we'd see an empty body, so
    // collapse both the throw and the empty case into one friendly message. An aborted
    // request also lands here, but the caller (loadLiveSource) checks signal.aborted first.
    const r = await resolveTwitchStream(opt.twitch.channel, signal).catch(() => null);
    if (!r?.playbackUrl) throw new Error("This Twitch channel is offline or unavailable.");
    return toAbsoluteApiUrl(r.playbackUrl);
  }
  if (opt.sports) {
    const r = await resolveSportStream(opt.sports.url, opt.sports.fallbackUrls, signal).catch(() => null);
    if (!r?.playbackUrl) throw new Error("Couldn't find a working stream for this channel.");
    return toAbsoluteApiUrl(r.playbackUrl);
  }
  throw new Error("This stream isn't playable.");
}

// Build a live request from a Live TV channel: direct channels play their streams as-is;
// resolver channels carry the resolver strategy per stream.
export function liveRequestFromChannel(channel: LiveChannel): LivePlayRequest {
  const sources: LiveSourceOption[] = channel.streams.map((s) => {
    const base = { id: s.id, label: s.label, quality: s.quality };
    if (channel.liveResolver === "twitch") return { ...base, twitch: { channel: s.source } };
    if (channel.liveResolver === "sports") return { ...base, sports: { url: s.source } };
    return { ...base, directUrl: s.source };
  });
  return {
    id: `live:${channel.id}`,
    title: channel.title,
    subtitle: channel.genre,
    sources,
    initialSourceId: channel.defaultStreamId,
  };
}

// Build a live request from a sports match: every stream becomes a source whose resolve
// races the other streams as fallbacks, so the first play already tries them all.
export function liveRequestFromMatch(match: SportMatch): LivePlayRequest {
  const allUrls = match.streams.map((s) => s.source);
  const sources: LiveSourceOption[] = match.streams.map((s, i) => ({
    id: s.id,
    label: s.label,
    quality: s.quality,
    sports: { url: s.source, fallbackUrls: allUrls.filter((_, j) => j !== i) },
  }));
  const league = match.league && match.league.toLowerCase() !== "streamed" ? match.league : "Live";
  return {
    id: `live:match:${match.id}`,
    title: match.title,
    subtitle: league,
    sources,
    initialSourceId: match.streams[0]?.id,
  };
}

// Build a live request from a Twitch channel name (free-form discovery input).
export function liveRequestFromTwitch(channel: string, label?: string): LivePlayRequest {
  const name = channel.trim().replace(/^@/, "");
  return {
    id: `live:twitch:${name.toLowerCase()}`,
    title: label || name,
    subtitle: "Twitch",
    sources: [{ id: "twitch", label: name, twitch: { channel: name } }],
    initialSourceId: "twitch",
  };
}

// Handoff: a live screen stages the request, then navigates to the watch route. The
// player pulls it on mount. Kept until the next stage so re-mounts stay safe.
let pending: LivePlayRequest | null = null;
export function stageLivePlayRequest(req: LivePlayRequest): void {
  pending = req;
}
export function takeLivePlayRequest(): LivePlayRequest | null {
  return pending;
}

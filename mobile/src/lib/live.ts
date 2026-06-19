import { getJson, useApiData } from "@/lib/api";

// ─────────────────────────── Sports schedule ───────────────────────────
// Contracts verified against src/football.rs + src/routes.rs (live, against the running
// backend): /api/{sport}/matches?source=auto and /api/sports/stream (response uses
// `playbackUrl`, a signed same-origin /api/live/hls.m3u8 proxy URL).

export type SportId =
  | "football"
  | "basketball"
  | "tennis"
  | "hockey"
  | "baseball"
  | "american-football"
  | "cricket";

export const SPORTS: { id: SportId; label: string }[] = [
  { id: "football", label: "Football" },
  { id: "basketball", label: "Basketball" },
  { id: "tennis", label: "Tennis" },
  { id: "hockey", label: "Hockey" },
  { id: "baseball", label: "Baseball" },
  { id: "american-football", label: "Am. Football" },
  { id: "cricket", label: "Cricket" },
];

export type SportStream = {
  id: string;
  label: string;
  source: string;
  provider: string;
  playbackType: string; // "hls"
  quality: string; // "HD" or a language code
};

export type SportMatchChannel = { name: string; language: string; linkCount: number };

export type SportMatch = {
  id: string;
  title: string;
  matchText?: string;
  league: string;
  sport: string;
  team1: string;
  team2: string;
  important: boolean;
  startTimestamp: number; // ms since epoch
  endsAtTimestamp: number; // ms since epoch
  durationMinutes: number;
  linkCount: number;
  channelCount: number;
  languages: string[];
  channels: SportMatchChannel[];
  streams: SportStream[];
  provider: string;
};

export type SportsSchedule = {
  source: string;
  sourceProvider: string;
  sport: string;
  fetchedAt: number;
  matches: SportMatch[];
};

const EMPTY_SCHEDULE: SportsSchedule = {
  source: "",
  sourceProvider: "",
  sport: "",
  fetchedAt: 0,
  matches: [],
};

// Live schedule read. Server-side cache is 60s for live data, so a plain mount/focus
// refetch keeps it fresh enough without client polling.
export function useSportMatches(sport: SportId, enabled = true) {
  return useApiData<SportsSchedule>(`/api/${sport}/matches?source=auto`, EMPTY_SCHEDULE, {
    enabled,
    keepPreviousData: true,
  });
}

// A resolved live stream — `playbackUrl` is a signed /api/live/hls.m3u8 proxy URL (sports)
// or an absolute HLS URL, ready to play. The signature already authorizes it.
export type ResolvedLiveStream = {
  playbackUrl: string;
  playbackType: string;
  provider?: string;
  playerPage?: string;
  resolvedFromFallback?: boolean;
  attemptedStreams?: number;
};

// Resolve one sports stream (with optional fallbacks raced concurrently via preflight).
// The backend tries each candidate (up to ~24s each) and returns the first working HLS.
export async function resolveSportStream(
  url: string,
  fallbackUrls?: string[],
  signal?: AbortSignal,
): Promise<ResolvedLiveStream> {
  const params = new URLSearchParams({ url, preflight: "1" });
  if (fallbackUrls && fallbackUrls.length) params.set("fallbackUrls", fallbackUrls.join(","));
  return getJson<ResolvedLiveStream>(`/api/sports/stream?${params.toString()}`, {
    timeoutMs: 32_000,
    signal,
  });
}

// ─────────────────────────── Twitch ───────────────────────────

export type TwitchStream = {
  source: string;
  playerPage: string;
  playbackType: string; // "hls"
  playbackUrl: string; // absolute usher.ttvnw.net signed HLS — play directly
  streamUrl: string;
};

// Resolve a Twitch channel (bare name or twitch.tv/player URL) to its live HLS playlist.
export async function resolveTwitchStream(channelOrUrl: string, signal?: AbortSignal): Promise<TwitchStream> {
  return getJson<TwitchStream>(`/api/twitch/stream?${new URLSearchParams({ url: channelOrUrl }).toString()}`, {
    timeoutMs: 32_000,
    signal,
  });
}

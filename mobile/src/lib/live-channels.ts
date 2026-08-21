import catalog from "streamarena-shared/live-channels.json";

import { apiFetch } from "@/lib/http";

export type LiveResolver = "sports" | "twitch";

export type LiveChannelStream = {
  id: string;
  label: string;
  source: string;
  quality: string;
};

export type LiveChannel = {
  id: string;
  title: string;
  source: string;
  defaultStreamId: string;
  streams: LiveChannelStream[];
  liveEmbed?: boolean;
  liveResolver?: LiveResolver;
  artworkPresentation?: "logo" | "thumbnail";
  unavailableReason?: string;
  genre: string;
  region: string;
  quality: string;
};

type CatalogChannel = {
  id: string;
  title: string;
  source: string;
  defaultStreamId: string;
  streams: LiveChannelStream[];
  liveEmbed?: boolean;
  liveResolver?: string;
  artworkPresentation?: string;
  unavailableReason?: string;
  genre: string;
  region: string;
  quality: string;
};

export const ntvCdnLiveChannelUrl = (channelSlug: string, countryCode = "us") =>
  `${catalog.ntvCdnLiveBaseUrl}/${encodeURIComponent(channelSlug)}?code=${encodeURIComponent(countryCode)}`;

function hydrateLiveChannels(channels: CatalogChannel[]): LiveChannel[] {
  return channels.map((channel) => ({
    id: channel.id,
    title: channel.title,
    source: channel.source,
    defaultStreamId: channel.defaultStreamId,
    streams: (channel.streams || []).map((stream) => ({ ...stream })),
    liveEmbed: channel.liveEmbed || undefined,
    liveResolver:
      channel.liveResolver === "sports" || channel.liveResolver === "twitch"
        ? channel.liveResolver
        : undefined,
    artworkPresentation:
      channel.artworkPresentation === "logo" || channel.artworkPresentation === "thumbnail"
        ? channel.artworkPresentation
        : undefined,
    unavailableReason: channel.unavailableReason,
    genre: channel.genre,
    region: channel.region,
    quality: channel.quality,
  }));
}

export const LIVE_CHANNELS: LiveChannel[] = hydrateLiveChannels(catalog.channels);

export function isLiveChannelPlayable(channel: LiveChannel): boolean {
  return (
    channel.streams.some((stream) => Boolean(stream.source.trim())) ||
    Boolean(channel.source.trim())
  );
}

let liveOverridesPromise: Promise<void> | null = null;

export function applyLiveChannelOverrides(overrides: unknown) {
  if (!overrides || typeof overrides !== "object") {
    return;
  }
  const entries = overrides as Record<string, unknown>;
  for (const channel of LIVE_CHANNELS) {
    for (const stream of channel.streams) {
      const next = entries[`live:${channel.id}:${stream.id}`];
      if (typeof next === "string" && next.trim()) {
        stream.source = next.trim();
      }
    }
    const defaultStream =
      channel.streams.find((stream) => stream.id === channel.defaultStreamId) ||
      channel.streams[0];
    if (defaultStream) {
      channel.source = defaultStream.source;
    }
  }
}

export function loadLiveChannelOverrides(): Promise<void> {
  if (liveOverridesPromise) {
    return liveOverridesPromise;
  }
  liveOverridesPromise = apiFetch("/api/live/channel-overrides", { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : null))
    .then((data: { overrides?: unknown } | null) => {
      applyLiveChannelOverrides(data?.overrides);
    })
    .catch(() => {
      liveOverridesPromise = null;
    });
  return liveOverridesPromise;
}

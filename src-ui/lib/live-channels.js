import catalog from "../../shared/live-channels.json" with { type: "json" };

export const BLOOMBERG_US_STREAM_URL = catalog.urls.bloombergUs;
export const BLOOMBERG_EU_STREAM_URL = catalog.urls.bloombergEu;
export const BLOOMBERG_US_PHOENIX_HD_STREAM_URL = catalog.urls.bloombergUsPhoenixHd;
export const BBC_NEWS_STREAM_URL = catalog.urls.bbcNews;
export const BBC_NEWS_ROKU_STREAM_URL = catalog.urls.bbcNewsRoku;
// Sky's own skycdp.com linear path 404s now (those paths rotate). Use the
// iptv-org-maintained Sky News feed via jmp2.uk — the same redirect service as
// BBC News above. It 302s to a fresh Samsung TV Plus token on every play, so it
// won't go stale the way a hardcoded tokenized URL would.
export const SKY_NEWS_STREAM_URL = catalog.urls.skyNews;
// ERT1's stream (bpk-tv/ERT1) became Greece-only in June 2026 — the CDN
// returns 403 "Content blocked by security policy" from non-GR IPs. ERT World
// (bpk-tv/ERTCosmos) is ERT's international feed and stays available abroad.
export const ERT_WORLD_STREAM_URL = catalog.urls.ertWorld;
export const MEGA_NEWS_STREAM_URL = catalog.urls.megaNews;
export const ANT1_STREAM_URL = catalog.urls.ant1;
export const ALPHA_TV_STREAM_URL = catalog.urls.alphaTv;
export const TOP_NEWS_STREAM_URL = catalog.urls.topNews;

export function ntvCdnLiveChannelUrl(channelSlug, countryCode = "us") {
  return `${catalog.ntvCdnLiveBaseUrl}/${encodeURIComponent(channelSlug)}?code=${encodeURIComponent(countryCode)}`;
}

export function novasportsChannelUrl(channelNumber) {
  return `${catalog.falconPlayerBaseUrl}?id=NOVASPORTS${channelNumber}`;
}

export const NOVASPORTS_STREAM_URL = novasportsChannelUrl(1);

function hydrateLiveChannels(channels) {
  return channels.map((channel) => ({
    ...channel,
    liveEmbed: Boolean(channel.liveEmbed),
    liveResolver: channel.liveResolver || "",
    artwork: channel.artwork || "",
    streams: (channel.streams || []).map((stream) => ({ ...stream })),
  }));
}

export const LIVE_CHANNELS = Object.freeze(hydrateLiveChannels(catalog.channels));

export function isLiveChannelPlayable(channel) {
  const streams = Array.isArray(channel?.streams) ? channel.streams : [];
  return (
    streams.some((stream) => String(stream?.source || "").trim()) ||
    Boolean(String(channel?.source || "").trim())
  );
}

export const LIVE_CHANNEL_PLAYBACK_FALLBACKS = Object.freeze(
  Object.fromEntries(
    LIVE_CHANNELS.map((channel) => [
      channel.id,
      {
        title: channel.title,
        source: channel.source,
        thumb: channel.artwork,
        defaultStreamId: channel.defaultStreamId || "default",
        streams: channel.streams || [],
        liveEmbed: Boolean(channel.liveEmbed),
        liveResolver: channel.liveResolver || "",
      },
    ]),
  ),
);

// Reverse-map a playback source URL back to its channel id, so an arriving
// long-form live URL (?live=1&src=…) can be canonicalized to /watch/live/<id>.
// Matches the channel's current source or any of its stream variants.
export function findLiveChannelIdBySource(source) {
  const target = String(source || "").trim();
  if (!target) {
    return "";
  }
  for (const channel of LIVE_CHANNELS) {
    if (String(channel.source || "").trim() === target) {
      return channel.id;
    }
    const streams = Array.isArray(channel.streams) ? channel.streams : [];
    if (streams.some((stream) => String(stream?.source || "").trim() === target)) {
      return channel.id;
    }
  }
  return "";
}

// ── Runtime provider overrides ──────────────────────────────────────────────
// The channel URLs above are compiled-in defaults, but the admin Providers
// dashboard can swap a stream's URL (CDN tokens rotate, geo-blocks appear)
// without a redeploy. Overrides are keyed `live:<channelId>:<streamId>` and
// applied *in place*, so every holder of the LIVE_CHANNELS /
// LIVE_CHANNEL_PLAYBACK_FALLBACKS references — which read `.source` lazily, at
// click / playback time — picks them up. The shallow Object.freeze() above
// guards structure, not the nested `.source` strings, so this is allowed.

let liveOverridesPromise = null;

export function applyLiveChannelOverrides(overrides) {
  if (!overrides || typeof overrides !== "object") {
    return;
  }
  for (const channel of LIVE_CHANNELS) {
    const streams = Array.isArray(channel.streams) ? channel.streams : [];
    for (const stream of streams) {
      const next = overrides[`live:${channel.id}:${stream.id}`];
      if (typeof next === "string" && next.trim()) {
        stream.source = next.trim();
      }
    }
    const defaultStream =
      streams.find((stream) => stream.id === channel.defaultStreamId) || streams[0];
    if (defaultStream) {
      channel.source = defaultStream.source;
    }
    const fallback = LIVE_CHANNEL_PLAYBACK_FALLBACKS[channel.id];
    if (fallback) {
      fallback.source = channel.source;
    }
  }
}

// Fetch live overrides once and apply them. Fire-and-forget from page bootstrap;
// callers don't await — defaults render immediately and the swap lands before any
// realistic click. Idempotent (the in-flight/finished promise is reused).
export function loadLiveChannelOverrides() {
  if (liveOverridesPromise) {
    return liveOverridesPromise;
  }
  liveOverridesPromise = fetch("/api/live/channel-overrides", { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => applyLiveChannelOverrides(data && data.overrides))
    .catch(() => {
      /* keep compiled defaults if overrides can't be fetched */
    });
  return liveOverridesPromise;
}

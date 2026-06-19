export const BLOOMBERG_US_STREAM_URL =
  "https://www.bloomberg.com/media-manifest/streams/us.m3u8";
export const BLOOMBERG_EU_STREAM_URL =
  "https://www.bloomberg.com/media-manifest/streams/eu.m3u8";
export const BLOOMBERG_US_PHOENIX_HD_STREAM_URL =
  "https://liveprodusphoenixeast.global.ssl.fastly.net/USPhx-HD/index.m3u8";
export const BBC_NEWS_STREAM_URL =
  "https://vs-hls-push-ww-live.akamaized.net/x=4/i=urn:bbc:pips:service:bbc_news_channel_hd/mobile_wifi_main_hd_abr_v2.m3u8";
export const BBC_NEWS_ROKU_STREAM_URL =
  "https://jmp2.uk/rok-6183f9f73a64394cf3c55690605af2a7.m3u8";
export const SKY_NEWS_STREAM_URL =
  "https://linear417-gb-hls1-prd-ak.cdn.skycdp.com/100e/Content/HLS_001_1080_30/Live/channel(skynews)/index_1080-30.m3u8";
// ERT1's stream (bpk-tv/ERT1) became Greece-only in June 2026 — the CDN
// returns 403 "Content blocked by security policy" from non-GR IPs. ERT World
// (bpk-tv/ERTCosmos) is ERT's international feed and stays available abroad.
export const ERT_WORLD_STREAM_URL =
  "https://ert-ucdn.broadpeak-aas.com/bpk-tv/ERTCosmos/default/index.m3u8";
export const MEGA_NEWS_STREAM_URL =
  "https://c98db5952cb54b358365984178fb898a.msvdn.net/live/S99841657/NU0xOarAMJ5X/playlist.m3u8";
export const ANT1_STREAM_URL =
  "https://pcdn.antennaplus.gr/live/media0/antenna-gr/HLS/index.m3u8";
export const ALPHA_TV_STREAM_URL =
  "https://alphatvlive2.siliconweb.com/alphatvlive/live_abr/playlist.m3u8";
const LIVE_CHANNEL_ARTWORK = Object.freeze({
  bloomberg: "assets/images/live-thumbs/bloomberg-tv-us.png",
  bbcNews: "assets/images/live-thumbs/bbc-news.jpg",
  skyNews: "assets/images/live-thumbs/sky-news.png",
  ert1: "assets/images/live-thumbs/ert1.jpg",
  megaNews: "assets/images/live-thumbs/mega-news.jpg",
  ant1: "assets/images/live-thumbs/ant1.svg",
  alphaTv: "assets/images/live-thumbs/alpha-tv.png",
  topNews: "assets/images/live-thumbs/top-news.jpg",
});

// ntvs.cx retired its hesgoales/"Falcon" channels in June 2026 — the
// /channel-hesgoales/NOVASPORTS-N wrapper now 302-redirects to /channels, so
// the resolver lands on the channel list and finds no embed. Point straight at
// hesgoaler.com, the upstream the wrapper used to proxy: the sports resolver
// already supports hesgoaler.com/stream.php (token POST → lovetier.bz HLS).
const NOVASPORTS_CHANNEL_BASE_URL = "https://hesgoaler.com/stream.php";

export function novasportsChannelUrl(channelNumber) {
  return `${NOVASPORTS_CHANNEL_BASE_URL}?ch=NOVASPORTS${channelNumber}`;
}

export const NOVASPORTS_STREAM_URL = novasportsChannelUrl(1);

const NOVASPORTS_LIVE_CHANNELS = Object.freeze(
  [1, 2, 3, 4, 5, 6].map((channelNumber) => {
    const source = novasportsChannelUrl(channelNumber);
    return {
      id: `novasports-${channelNumber}`,
      title: `Nova Sports ${channelNumber}`,
      source,
      defaultStreamId: "default",
      streams: [
        {
          id: "default",
          label: `Nova Sports ${channelNumber} Live`,
          source,
          quality: "Live HLS",
        },
      ],
      liveEmbed: true,
      liveResolver: "sports",
      artwork: `assets/images/live-thumbs/novasports-${channelNumber}.png`,
      genre: "Sports",
      region: "Greece",
      quality: "Live HLS",
    };
  }),
);

export const TOP_NEWS_STREAM_URL =
  "https://player.twitch.tv/?channel=topmedia_topnews&parent=top-channel.tv";

export const LIVE_CHANNELS = Object.freeze([
  {
    id: "bloomberg-tv-us",
    title: "Bloomberg TV",
    source: BLOOMBERG_US_STREAM_URL,
    defaultStreamId: "default",
    streams: [
      {
        id: "default",
        label: "Bloomberg TV US",
        source: BLOOMBERG_US_STREAM_URL,
        quality: "720p HLS",
      },
      {
        id: "europe",
        label: "Bloomberg TV+ Europe",
        source: BLOOMBERG_EU_STREAM_URL,
        quality: "720p HLS",
      },
      {
        id: "us-phoenix-hd",
        label: "Bloomberg US 1080p",
        source: BLOOMBERG_US_PHOENIX_HD_STREAM_URL,
        quality: "1080p HLS",
      },
    ],
    artwork: LIVE_CHANNEL_ARTWORK.bloomberg,
    genre: "Business",
    region: "US",
    quality: "720p HLS + 1080p option",
  },
  {
    id: "bbc-news",
    title: "BBC News",
    source: BBC_NEWS_STREAM_URL,
    defaultStreamId: "official",
    streams: [
      {
        id: "official",
        label: "Official BBC",
        source: BBC_NEWS_STREAM_URL,
        quality: "720p HLS",
      },
      {
        id: "roku-1080p",
        label: "Roku 1080p",
        source: BBC_NEWS_ROKU_STREAM_URL,
        quality: "1080p HLS",
      },
    ],
    artwork: LIVE_CHANNEL_ARTWORK.bbcNews,
    genre: "News",
    region: "UK",
    quality: "720p HLS + 1080p option",
  },
  {
    id: "sky-news",
    title: "Sky News",
    source: SKY_NEWS_STREAM_URL,
    defaultStreamId: "sky-hd",
    streams: [
      {
        id: "sky-hd",
        label: "Sky News HD",
        source: SKY_NEWS_STREAM_URL,
        quality: "1080p HLS",
      },
    ],
    artwork: LIVE_CHANNEL_ARTWORK.skyNews,
    genre: "News",
    region: "UK",
    quality: "1080p HLS",
  },
  {
    // Keeps the legacy "ert1" ids so saved /watch URLs and continue-watching
    // state keep resolving to this channel.
    id: "ert1",
    title: "ERT World",
    source: ERT_WORLD_STREAM_URL,
    defaultStreamId: "ert1-main",
    streams: [
      {
        id: "ert1-main",
        label: "ERT World HD",
        source: ERT_WORLD_STREAM_URL,
        quality: "1080p HLS",
      },
    ],
    artwork: LIVE_CHANNEL_ARTWORK.ert1,
    genre: "General",
    region: "Greece",
    quality: "1080p HLS",
  },
  {
    id: "mega-news",
    title: "MEGA News",
    source: MEGA_NEWS_STREAM_URL,
    defaultStreamId: "mega-news-main",
    streams: [
      {
        id: "mega-news-main",
        label: "MEGA News HD",
        source: MEGA_NEWS_STREAM_URL,
        quality: "720p HLS",
      },
    ],
    artwork: LIVE_CHANNEL_ARTWORK.megaNews,
    genre: "General",
    region: "Greece",
    quality: "720p HLS",
  },
  {
    id: "ant1",
    title: "ANT1",
    source: ANT1_STREAM_URL,
    defaultStreamId: "ant1-main",
    streams: [
      {
        id: "ant1-main",
        label: "ANT1 HD",
        source: ANT1_STREAM_URL,
        quality: "720p HLS",
      },
    ],
    artwork: LIVE_CHANNEL_ARTWORK.ant1,
    genre: "General",
    region: "Greece",
    quality: "720p HLS",
  },
  {
    id: "alpha-tv",
    title: "Alpha TV",
    source: ALPHA_TV_STREAM_URL,
    defaultStreamId: "alpha-main",
    streams: [
      {
        id: "alpha-main",
        label: "Alpha TV HD",
        source: ALPHA_TV_STREAM_URL,
        quality: "720p HLS",
      },
    ],
    artwork: LIVE_CHANNEL_ARTWORK.alphaTv,
    genre: "General",
    region: "Greece",
    quality: "720p HLS",
  },
  {
    id: "top-news",
    title: "Top News",
    source: TOP_NEWS_STREAM_URL,
    defaultStreamId: "top-news-live",
    streams: [
      {
        id: "top-news-live",
        label: "Top News Live",
        source: TOP_NEWS_STREAM_URL,
        quality: "Twitch HLS",
      },
    ],
    liveEmbed: true,
    liveResolver: "twitch",
    artwork: LIVE_CHANNEL_ARTWORK.topNews,
    genre: "News",
    region: "Albania",
    quality: "Live HLS",
  },
  ...NOVASPORTS_LIVE_CHANNELS,
]);

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

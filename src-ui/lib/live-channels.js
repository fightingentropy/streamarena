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
// Sky's own skycdp.com linear path 404s now (those paths rotate). Use the
// iptv-org-maintained Sky News feed via jmp2.uk — the same redirect service as
// BBC News above. It 302s to a fresh Samsung TV Plus token on every play, so it
// won't go stale the way a hardcoded tokenized URL would.
export const SKY_NEWS_STREAM_URL =
  "https://jmp2.uk/plu-55b285cd2665de274553d66f.m3u8";
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
const HESGOALER_STREAM_BASE_URL = "https://hesgoaler.com/stream.php";

function hesgoalerChannelUrl(channelCode) {
  return `${HESGOALER_STREAM_BASE_URL}?ch=${channelCode}`;
}

export function novasportsChannelUrl(channelNumber) {
  return hesgoalerChannelUrl(`NOVASPORTS${channelNumber}`);
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

// hesgoaler.com/stream.php also fronts a multi-region premium-sports lineup (UK
// Sky/TNT/Premier/Eurosport/Viaplay, France beIN/Canal+/RMC, Greece Cosmote Sport,
// Portugal Sport TV). Every channel uses the exact same token POST → lovetier.bz HLS
// path as the Nova Sports feeds above, so they all ride the existing "sports"
// resolver unchanged — only the ?ch= code differs.
function hesgoalerSportsChannel({ slug, code, title, region, genre = "Sports" }) {
  const source = hesgoalerChannelUrl(code);
  return {
    id: slug,
    title,
    source,
    defaultStreamId: "default",
    streams: [{ id: "default", label: `${title} Live`, source, quality: "Live HLS" }],
    liveEmbed: true,
    liveResolver: "sports",
    artwork: `assets/images/live-thumbs/${slug}.svg`,
    genre,
    region,
    quality: "Live HLS",
  };
}

const HESGOALER_SPORTS_CHANNELS = Object.freeze(
  [
    // United Kingdom
    { slug: "sky-sports-main-event", code: "skysportsmainevent", title: "Sky Sports Main Event", region: "UK" },
    { slug: "sky-sports-premier-league", code: "skysportspremierleague", title: "Sky Sports Premier League", region: "UK" },
    { slug: "sky-sports-football", code: "SkySportsFootballUK", title: "Sky Sports Football", region: "UK" },
    { slug: "sky-sports-action", code: "skysportsaction", title: "Sky Sports Action", region: "UK" },
    { slug: "sky-sports-f1", code: "SkySportsF1", title: "Sky Sports F1", region: "UK" },
    { slug: "sky-sports-golf", code: "skysportsgolfuk", title: "Sky Sports Golf", region: "UK" },
    { slug: "sky-sports-tennis", code: "skysportstennisuk", title: "Sky Sports Tennis", region: "UK" },
    { slug: "sky-sports-mix", code: "skysportsmixuk", title: "Sky Sports Mix", region: "UK" },
    { slug: "tnt-sports-1", code: "TNT1UK", title: "TNT Sports 1", region: "UK" },
    { slug: "tnt-sports-2", code: "tntsports2", title: "TNT Sports 2", region: "UK" },
    { slug: "tnt-sports-3", code: "tntsports3", title: "TNT Sports 3", region: "UK" },
    { slug: "tnt-sports-4", code: "tntsports4", title: "TNT Sports 4", region: "UK" },
    { slug: "premier-sports-1", code: "PREMIERSPORTS1", title: "Premier Sports 1", region: "UK" },
    { slug: "premier-sports-2", code: "PREMIERSPORTS2", title: "Premier Sports 2", region: "UK" },
    { slug: "eurosport-1", code: "Eurosport1UK", title: "Eurosport 1", region: "UK" },
    { slug: "eurosport-2", code: "Eurosport2UK", title: "Eurosport 2", region: "UK" },
    { slug: "viaplay-sports-la-liga", code: "ViaplayLaLigaUK", title: "Viaplay Sports La Liga", region: "UK" },
    { slug: "bein-sports-1-uk", code: "BEINSPORTS1UK", title: "beIN Sports 1 UK", region: "UK" },
    { slug: "itv-1", code: "ITV1", title: "ITV1", region: "UK", genre: "General" },
    { slug: "itv-2", code: "ITV2", title: "ITV2", region: "UK", genre: "General" },
    { slug: "itv-3", code: "ITV3", title: "ITV3", region: "UK", genre: "General" },
    { slug: "itv-4", code: "ITV4", title: "ITV4", region: "UK", genre: "General" },
    { slug: "lfc-tv", code: "LFCTV", title: "LFC TV", region: "UK" },
    { slug: "mutv", code: "MUTV", title: "MUTV", region: "UK" },
    // France
    { slug: "bein-sports-1", code: "BEINSPORT1FR", title: "beIN Sports 1", region: "France" },
    { slug: "bein-sports-2", code: "BEINSPORT2FR", title: "beIN Sports 2", region: "France" },
    { slug: "bein-sports-3", code: "BEINSPORT3FR", title: "beIN Sports 3", region: "France" },
    { slug: "bein-sports-max-4", code: "beINMAX4FR", title: "beIN Sports Max 4", region: "France" },
    { slug: "bein-sports-max-5", code: "beINMAX5FR", title: "beIN Sports Max 5", region: "France" },
    { slug: "bein-sports-max-6", code: "beINMAX6FR", title: "beIN Sports Max 6", region: "France" },
    { slug: "bein-sports-max-7", code: "beINMAX7FR", title: "beIN Sports Max 7", region: "France" },
    { slug: "bein-sports-max-8", code: "beINMAX8FR", title: "beIN Sports Max 8", region: "France" },
    { slug: "bein-sports-max-9", code: "beINMAX9FR", title: "beIN Sports Max 9", region: "France" },
    { slug: "canal-plus-sport", code: "CANALSPORTFR", title: "Canal+ Sport", region: "France" },
    { slug: "canal-plus-sport-360", code: "CANALS360", title: "Canal+ Sport 360", region: "France" },
    { slug: "canal-plus-foot", code: "FOOTPLUSFR", title: "Canal+ Foot", region: "France" },
    { slug: "rmc-sport-1", code: "RMCSPORT1FR", title: "RMC Sport 1", region: "France" },
    { slug: "rmc-sport-2", code: "RMCSPORT2FR", title: "RMC Sport 2", region: "France" },
    { slug: "lequipe", code: "EQUIPEFR", title: "L'Équipe", region: "France" },
    // Greece — Cosmote Sport
    { slug: "cosmote-sport-1", code: "COSMOTESPORT1", title: "Cosmote Sport 1", region: "Greece" },
    { slug: "cosmote-sport-2", code: "COSMOTESPORT2", title: "Cosmote Sport 2", region: "Greece" },
    { slug: "cosmote-sport-3", code: "COSMOTESPORT3", title: "Cosmote Sport 3", region: "Greece" },
    { slug: "cosmote-sport-4", code: "COSMOTESPORT4", title: "Cosmote Sport 4", region: "Greece" },
    { slug: "cosmote-sport-5", code: "COSMOTESPORT5", title: "Cosmote Sport 5", region: "Greece" },
    { slug: "cosmote-sport-6", code: "COSMOTESPORT6", title: "Cosmote Sport 6", region: "Greece" },
    { slug: "cosmote-sport-7", code: "COSMOTESPORT7", title: "Cosmote Sport 7", region: "Greece" },
    { slug: "cosmote-sport-8", code: "COSMOTESPORT8", title: "Cosmote Sport 8", region: "Greece" },
    { slug: "cosmote-sport-9", code: "COSMOTESPORT9", title: "Cosmote Sport 9", region: "Greece" },
    // Portugal — Sport TV
    { slug: "sport-tv-1", code: "SPT1", title: "Sport TV 1", region: "Portugal" },
    { slug: "sport-tv-2", code: "SPT2", title: "Sport TV 2", region: "Portugal" },
    { slug: "sport-tv-3", code: "SPT3", title: "Sport TV 3", region: "Portugal" },
    { slug: "sport-tv-4", code: "SPT4", title: "Sport TV 4", region: "Portugal" },
    { slug: "sport-tv-5", code: "SPT5", title: "Sport TV 5", region: "Portugal" },
    { slug: "sport-tv-6", code: "SPT6", title: "Sport TV 6", region: "Portugal" },
    { slug: "sport-tv-7", code: "SPT7", title: "Sport TV 7", region: "Portugal" },
    { slug: "benfica-tv", code: "BTV1", title: "Benfica TV", region: "Portugal" },
    { slug: "canal-11", code: "CANAL11", title: "Canal 11", region: "Portugal" },
    // Netherlands — ESPN + Ziggo Sport
    { slug: "espn-1-nl", code: "ESPN1NL", title: "ESPN 1", region: "Netherlands" },
    { slug: "espn-2-nl", code: "ESPN2NL", title: "ESPN 2", region: "Netherlands" },
    { slug: "espn-3-nl", code: "ESPN3NL", title: "ESPN 3", region: "Netherlands" },
    { slug: "espn-4-nl", code: "ESPN4NL", title: "ESPN 4", region: "Netherlands" },
    { slug: "ziggo-sport", code: "ZiggoSport", title: "Ziggo Sport", region: "Netherlands" },
    { slug: "ziggo-sport-2", code: "ZiggoSport2", title: "Ziggo Sport 2", region: "Netherlands" },
    { slug: "ziggo-sport-3", code: "ZiggoSport3", title: "Ziggo Sport 3", region: "Netherlands" },
    { slug: "ziggo-sport-4", code: "ZiggoSport4", title: "Ziggo Sport 4", region: "Netherlands" },
    { slug: "ziggo-sport-5", code: "ZiggoSport5", title: "Ziggo Sport 5", region: "Netherlands" },
    { slug: "ziggo-sport-6", code: "ZiggoSport6", title: "Ziggo Sport 6", region: "Netherlands" },
  ].map(hesgoalerSportsChannel),
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
        quality: "720p HLS",
      },
    ],
    artwork: LIVE_CHANNEL_ARTWORK.skyNews,
    genre: "News",
    region: "UK",
    quality: "720p HLS",
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
  ...HESGOALER_SPORTS_CHANNELS,
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

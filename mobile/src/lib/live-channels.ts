// Static Live TV channel catalog, ported from src-ui/lib/live-channels.js (URLs kept
// byte-for-byte). Direct-HLS channels play `source` straight; resolver channels
// (liveResolver "sports" | "twitch") resolve through the backend first. Artwork is not
// ported — the mobile grid renders generated glass tiles instead of bundling thumbs.

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
  genre: string;
  region: string;
  quality: string;
};

const BLOOMBERG_US = "https://www.bloomberg.com/media-manifest/streams/us.m3u8";
const BLOOMBERG_EU = "https://www.bloomberg.com/media-manifest/streams/eu.m3u8";
const BLOOMBERG_US_PHOENIX_HD =
  "https://liveprodusphoenixeast.global.ssl.fastly.net/USPhx-HD/index.m3u8";
const BBC_NEWS =
  "https://vs-hls-push-ww-live.akamaized.net/x=4/i=urn:bbc:pips:service:bbc_news_channel_hd/mobile_wifi_main_hd_abr_v2.m3u8";
const BBC_NEWS_ROKU = "https://jmp2.uk/rok-6183f9f73a64394cf3c55690605af2a7.m3u8";
const SKY_NEWS =
  "https://linear417-gb-hls1-prd-ak.cdn.skycdp.com/100e/Content/HLS_001_1080_30/Live/channel(skynews)/index_1080-30.m3u8";
// ERT World (international feed) — ERT1's own stream is GR-only (403 abroad) since 2026.
const ERT_WORLD = "https://ert-ucdn.broadpeak-aas.com/bpk-tv/ERTCosmos/default/index.m3u8";
const MEGA_NEWS =
  "https://c98db5952cb54b358365984178fb898a.msvdn.net/live/S99841657/NU0xOarAMJ5X/playlist.m3u8";
const ANT1 = "https://pcdn.antennaplus.gr/live/media0/antenna-gr/HLS/index.m3u8";
const ALPHA_TV = "https://alphatvlive2.siliconweb.com/alphatvlive/live_abr/playlist.m3u8";
const TOP_NEWS_TWITCH = "https://player.twitch.tv/?channel=topmedia_topnews&parent=top-channel.tv";

// Nova Sports 1–6 resolve through hesgoaler.com/stream.php (sports resolver).
const novasportsUrl = (n: number) => `https://hesgoaler.com/stream.php?ch=NOVASPORTS${n}`;
const NOVASPORTS_CHANNELS: LiveChannel[] = [1, 2, 3, 4, 5, 6].map((n) => ({
  id: `novasports-${n}`,
  title: `Nova Sports ${n}`,
  source: novasportsUrl(n),
  defaultStreamId: "default",
  streams: [{ id: "default", label: `Nova Sports ${n} Live`, source: novasportsUrl(n), quality: "Live HLS" }],
  liveEmbed: true,
  liveResolver: "sports",
  genre: "Sports",
  region: "Greece",
  quality: "Live HLS",
}));

export const LIVE_CHANNELS: LiveChannel[] = [
  {
    id: "bloomberg-tv-us",
    title: "Bloomberg TV",
    source: BLOOMBERG_US,
    defaultStreamId: "default",
    streams: [
      { id: "default", label: "Bloomberg TV US", source: BLOOMBERG_US, quality: "720p HLS" },
      { id: "europe", label: "Bloomberg TV+ Europe", source: BLOOMBERG_EU, quality: "720p HLS" },
      { id: "us-phoenix-hd", label: "Bloomberg US 1080p", source: BLOOMBERG_US_PHOENIX_HD, quality: "1080p HLS" },
    ],
    genre: "Business",
    region: "US",
    quality: "720p HLS + 1080p option",
  },
  {
    id: "bbc-news",
    title: "BBC News",
    source: BBC_NEWS,
    defaultStreamId: "official",
    streams: [
      { id: "official", label: "Official BBC", source: BBC_NEWS, quality: "720p HLS" },
      { id: "roku-1080p", label: "Roku 1080p", source: BBC_NEWS_ROKU, quality: "1080p HLS" },
    ],
    genre: "News",
    region: "UK",
    quality: "720p HLS + 1080p option",
  },
  {
    id: "sky-news",
    title: "Sky News",
    source: SKY_NEWS,
    defaultStreamId: "sky-hd",
    streams: [{ id: "sky-hd", label: "Sky News HD", source: SKY_NEWS, quality: "1080p HLS" }],
    genre: "News",
    region: "UK",
    quality: "1080p HLS",
  },
  {
    id: "ert1",
    title: "ERT World",
    source: ERT_WORLD,
    defaultStreamId: "ert1-main",
    streams: [{ id: "ert1-main", label: "ERT World HD", source: ERT_WORLD, quality: "1080p HLS" }],
    genre: "General",
    region: "Greece",
    quality: "1080p HLS",
  },
  {
    id: "mega-news",
    title: "MEGA News",
    source: MEGA_NEWS,
    defaultStreamId: "mega-news-main",
    streams: [{ id: "mega-news-main", label: "MEGA News HD", source: MEGA_NEWS, quality: "720p HLS" }],
    genre: "General",
    region: "Greece",
    quality: "720p HLS",
  },
  {
    id: "ant1",
    title: "ANT1",
    source: ANT1,
    defaultStreamId: "ant1-main",
    streams: [{ id: "ant1-main", label: "ANT1 HD", source: ANT1, quality: "720p HLS" }],
    genre: "General",
    region: "Greece",
    quality: "720p HLS",
  },
  {
    id: "alpha-tv",
    title: "Alpha TV",
    source: ALPHA_TV,
    defaultStreamId: "alpha-main",
    streams: [{ id: "alpha-main", label: "Alpha TV HD", source: ALPHA_TV, quality: "720p HLS" }],
    genre: "General",
    region: "Greece",
    quality: "720p HLS",
  },
  {
    id: "top-news",
    title: "Top News",
    source: TOP_NEWS_TWITCH,
    defaultStreamId: "top-news-live",
    streams: [{ id: "top-news-live", label: "Top News Live", source: TOP_NEWS_TWITCH, quality: "Twitch HLS" }],
    liveEmbed: true,
    liveResolver: "twitch",
    genre: "News",
    region: "Albania",
    quality: "Live HLS",
  },
  ...NOVASPORTS_CHANNELS,
];

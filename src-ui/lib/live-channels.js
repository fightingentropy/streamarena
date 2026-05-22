export const BLOOMBERG_US_STREAM_URL =
  "https://www.bloomberg.com/media-manifest/streams/us.m3u8";
export const BBC_NEWS_STREAM_URL =
  "https://vs-hls-push-ww-live.akamaized.net/x=4/i=urn:bbc:pips:service:bbc_news_channel_hd/mobile_wifi_main_hd_abr_v2.m3u8";
export const BBC_NEWS_ROKU_STREAM_URL =
  "https://jmp2.uk/rok-6183f9f73a64394cf3c55690605af2a7.m3u8";
export const SKY_NEWS_STREAM_URL =
  "https://linear417-gb-hls1-prd-ak.cdn.skycdp.com/100e/Content/HLS_001_1080_30/Live/channel(skynews)/index_1080-30.m3u8";

export const LIVE_CHANNELS = Object.freeze([
  {
    id: "bloomberg-tv-us",
    title: "Bloomberg TV US",
    source: BLOOMBERG_US_STREAM_URL,
    defaultStreamId: "default",
    streams: [
      {
        id: "default",
        label: "Bloomberg TV US",
        source: BLOOMBERG_US_STREAM_URL,
        quality: "HLS",
      },
    ],
    artwork: "assets/images/bloomberg-tv-us-live.svg",
    genre: "Business",
    region: "US",
    quality: "HLS",
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
    artwork: "assets/images/bbc-news-live.svg",
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
    artwork: "assets/images/sky-news-live.svg",
    genre: "News",
    region: "UK",
    quality: "1080p HLS",
  },
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
      },
    ]),
  ),
);

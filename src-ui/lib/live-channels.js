export const BLOOMBERG_US_STREAM_URL =
  "https://www.bloomberg.com/media-manifest/streams/us.m3u8";
export const BBC_NEWS_STREAM_URL =
  "https://vs-hls-push-ww-live.akamaized.net/x=4/i=urn:bbc:pips:service:bbc_news_channel_hd/mobile_wifi_main_hd_abr_v2.m3u8";
export const BBC_NEWS_ROKU_STREAM_URL =
  "https://jmp2.uk/rok-6183f9f73a64394cf3c55690605af2a7.m3u8";
export const SKY_NEWS_STREAM_URL =
  "https://linear417-gb-hls1-prd-ak.cdn.skycdp.com/100e/Content/HLS_001_1080_30/Live/channel(skynews)/index_1080-30.m3u8";
export const ERT1_STREAM_URL =
  "https://ert-ucdn.broadpeak-aas.com/bpk-tv/ERT1/default/index.m3u8";
export const MEGA_NEWS_STREAM_URL =
  "https://c98db5952cb54b358365984178fb898a.msvdn.net/live/S99841657/NU0xOarAMJ5X/playlist.m3u8";
export const ANT1_STREAM_URL =
  "https://pcdn.antennaplus.gr/live/media0/antenna-gr/HLS/index.m3u8";
export const ALPHA_TV_STREAM_URL =
  "https://alphatvlive2.siliconweb.com/alphatvlive/live_abr/playlist.m3u8";
const NOVASPORTS_CHANNEL_BASE_URL =
  "https://ntvs.cx/channel-hesgoales";

export function novasportsChannelUrl(channelNumber) {
  return `${NOVASPORTS_CHANNEL_BASE_URL}/NOVASPORTS-${channelNumber}`;
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
      artwork: "assets/images/novasports-live.svg",
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
  {
    id: "ert1",
    title: "ERT1",
    source: ERT1_STREAM_URL,
    defaultStreamId: "ert1-main",
    streams: [
      {
        id: "ert1-main",
        label: "ERT1 HD",
        source: ERT1_STREAM_URL,
        quality: "1080p HLS",
      },
    ],
    artwork: "assets/images/ert1-live.svg",
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
    artwork: "assets/images/mega-tv-live.svg",
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
    artwork: "assets/images/ant1-live.svg",
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
    artwork: "assets/images/alpha-tv-live.svg",
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
    artwork: "assets/images/top-news-live.svg",
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

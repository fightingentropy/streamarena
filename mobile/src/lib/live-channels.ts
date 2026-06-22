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
// Sky's skycdp.com path 404s now; use the iptv-org Sky News feed via jmp2.uk
// (same redirect service as BBC News — fresh Samsung TV Plus token per play).
const SKY_NEWS = "https://jmp2.uk/plu-55b285cd2665de274553d66f.m3u8";
// ERT World (international feed) — ERT1's own stream is GR-only (403 abroad) since 2026.
const ERT_WORLD = "https://ert-ucdn.broadpeak-aas.com/bpk-tv/ERTCosmos/default/index.m3u8";
const MEGA_NEWS =
  "https://c98db5952cb54b358365984178fb898a.msvdn.net/live/S99841657/NU0xOarAMJ5X/playlist.m3u8";
const ANT1 = "https://pcdn.antennaplus.gr/live/media0/antenna-gr/HLS/index.m3u8";
const ALPHA_TV = "https://alphatvlive2.siliconweb.com/alphatvlive/live_abr/playlist.m3u8";
const TOP_NEWS_TWITCH = "https://player.twitch.tv/?channel=topmedia_topnews&parent=top-channel.tv";

// Nova Sports 1–6 + the UK premium-sports lineup all resolve through
// hesgoaler.com/stream.php (same token POST → lovetier.bz HLS sports resolver).
const hesgoalerUrl = (code: string) => `https://hesgoaler.com/stream.php?ch=${code}`;
const novasportsUrl = (n: number) => hesgoalerUrl(`NOVASPORTS${n}`);
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

// Multi-region premium-sports lineup via hesgoaler.com/stream.php — UK (Sky/TNT/
// Premier/Eurosport/Viaplay), France (beIN/Canal+/RMC), Greece (Cosmote Sport) and
// Portugal (Sport TV). Only the ?ch= code differs from the Nova Sports feeds above.
const HESGOALER_SPORTS: LiveChannel[] = (
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
  ] as Array<{ slug: string; code: string; title: string; region: string; genre?: string }>
).map(({ slug, code, title, region, genre = "Sports" }) => ({
  id: slug,
  title,
  source: hesgoalerUrl(code),
  defaultStreamId: "default",
  streams: [{ id: "default", label: `${title} Live`, source: hesgoalerUrl(code), quality: "Live HLS" }],
  liveEmbed: true,
  liveResolver: "sports" as const,
  genre,
  region,
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
    streams: [{ id: "sky-hd", label: "Sky News HD", source: SKY_NEWS, quality: "720p HLS" }],
    genre: "News",
    region: "UK",
    quality: "720p HLS",
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
  ...HESGOALER_SPORTS,
];

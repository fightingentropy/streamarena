import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import catalog from "../shared/live-channels.json" with { type: "json" };
import {
  LIVE_CHANNELS,
  findLiveChannelIdBySource,
  ntvCdnLiveChannelUrl,
} from "../src-ui/lib/live-channels.js";

const expectedNtvChannels = [
  ["bbc-us", "BBC", "BBC America", "General", "US", 1],
  ["cnn", "CNN", "CNN", "News", "US", 1],
  ["fox-news", "FOX-News", "FOX News", "News", "US", 1],
  ["espn-2-us", "ESPN-2", "ESPN 2 (US)", "Sports", "US", 1],
  ["hbo", "HBO", "HBO", "General", "Poland · Multi-audio", 1],
  ["discovery-channel", "Discovery-Channel", "Discovery Channel", "General", "UK", 1],
  ["national-geographic", "National-Geographic", "National Geographic", "General", "UK", 1],
];
const liveChannelsViewSource = readFileSync(
  new URL("../src-ui/components/live-channels-view.jsx", import.meta.url),
  "utf8",
);

const channelIds = LIVE_CHANNELS.map((channel) => channel.id);
assert.equal(new Set(channelIds).size, channelIds.length, "live channel ids must be unique");

for (const channel of LIVE_CHANNELS) {
  const streamIds = (channel.streams || []).map((stream) => stream.id);
  assert.equal(
    new Set(streamIds).size,
    streamIds.length,
    `${channel.id} stream ids must be unique`,
  );
}

for (const [id, route, title, genre, region, streamCount] of expectedNtvChannels) {
  const source = ntvCdnLiveChannelUrl(route);
  const matches = LIVE_CHANNELS.filter((channel) => channel.id === id);
  assert.equal(matches.length, 1, `${id} must appear exactly once`);

  const [channel] = matches;
  assert.equal(channel.source, source);
  assert.equal(channel.title, title);
  assert.equal(channel.genre, genre);
  assert.equal(channel.region, region);
  assert.equal(channel.liveEmbed, true);
  assert.equal(channel.liveResolver, "sports");
  assert.equal(channel.defaultStreamId, "ntv-titan");
  assert.equal(channel.streams.length, streamCount);
  assert.equal(channel.streams[0].source, source);
  assert.equal(findLiveChannelIdBySource(source), id);
}

assert.equal(ntvCdnLiveChannelUrl("BBC"), "https://ntv.cx/channel-cdnlive/BBC?code=us");
const bbcAmerica = LIVE_CHANNELS.find((channel) => channel.id === "bbc-us");
assert.equal(bbcAmerica.streams.length, 1);
assert.equal(
  LIVE_CHANNELS.some((channel) =>
    channel.streams.some((stream) => String(stream.source || "").startsWith("live-iframe:")),
  ),
  false,
  "the built-in channel catalogue must not ship direct third-party iframe sources",
);
assert.equal(LIVE_CHANNELS.filter((channel) => channel.id === "bbc-news").length, 1);

assert.doesNotMatch(liveChannelsViewSource, /live-channel-play/);
assert.doesNotMatch(liveChannelsViewSource, /<span>Live<\/span>/);
assert.doesNotMatch(liveChannelsViewSource, /channel\.quality/);
assert.match(liveChannelsViewSource, /\{channel\.genre\} · \{channel\.region\}/);
assert.match(liveChannelsViewSource, /LIVE_CHANNEL_ARTWORK_REVISION/);
assert.match(liveChannelsViewSource, /src=\{channelArtworkUrl\(channel\.artwork\)\}/);
assert.match(liveChannelsViewSource, /channel\.artworkPresentation === "logo"/);

const authenticSportsLogoChannels = LIVE_CHANNELS.filter((channel) =>
  channel.source.includes("hesgoaler.com/stream.php"),
);
assert.equal(authenticSportsLogoChannels.length, 73);

for (const channel of authenticSportsLogoChannels) {
  const expectedPresentation = channel.id === "sport-tv-7" ? "thumbnail" : "logo";
  assert.equal(
    channel.artworkPresentation,
    expectedPresentation,
    `${channel.id} must use the correct authentic-artwork presentation`,
  );
  assert.match(channel.artwork, /\.png$/, `${channel.id} must use authentic PNG artwork`);

  const artwork = readFileSync(new URL(`../${channel.artwork}`, import.meta.url));
  assert.deepEqual(
    [...artwork.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    `${channel.id} artwork must be a valid PNG`,
  );
}

const svgArtwork = new Set(
  LIVE_CHANNELS.map((channel) => channel.artwork).filter((artwork) => artwork.endsWith(".svg")),
);
for (const artwork of svgArtwork) {
  const artworkSource = readFileSync(new URL(`../${artwork}`, import.meta.url), "utf8");
  assert.doesNotMatch(
    artworkSource,
    />\s*LIVE\s*</i,
    `${artwork} must not repeat the page's live status inside channel artwork`,
  );
}

const catalogIds = catalog.channels.map((channel) => channel.id);
assert.deepEqual(catalogIds, channelIds, "web LIVE_CHANNELS must match shared/live-channels.json");
for (const channel of catalog.channels) {
  const webChannel = LIVE_CHANNELS.find((entry) => entry.id === channel.id);
  assert.equal(webChannel.source, channel.source, `${channel.id} source must match the shared catalog`);
  assert.equal(webChannel.streams.length, channel.streams.length, `${channel.id} stream count must match`);
}

const mobileLiveChannelsSource = readFileSync(
  new URL("../mobile/src/lib/live-channels.ts", import.meta.url),
  "utf8",
);
assert.match(mobileLiveChannelsSource, /streamarena-shared\/live-channels\.json/);
assert.match(mobileLiveChannelsSource, /export function loadLiveChannelOverrides/);
assert.match(
  readFileSync(new URL("../mobile/src/app/_layout.tsx", import.meta.url), "utf8"),
  /loadLiveChannelOverrides/,
);

const bbcAmericaCatalog = catalog.channels.find((channel) => channel.id === "bbc-us");
assert.equal(
  bbcAmericaCatalog.streams.length,
  1,
  "shared catalog must not restore the removed iframe fallback",
);

console.log("Live channel catalog and card UI tests passed (7 NTV/CDNLive channels).");

import assert from "node:assert/strict";

import {
  LIVE_CHANNELS,
  findLiveChannelIdBySource,
  ntvCdnLiveChannelUrl,
} from "../src-ui/lib/live-channels.js";

const expectedNtvChannels = [
  ["bbc-us", "BBC", "BBC America", "General", "US", 2],
  ["cnn", "CNN", "CNN", "News", "US", 1],
  ["fox-news", "FOX-News", "FOX News", "News", "US", 1],
  ["espn-2-us", "ESPN-2", "ESPN 2 (US)", "Sports", "US", 1],
  ["hbo", "HBO", "HBO", "General", "Poland · Multi-audio", 1],
  ["discovery-channel", "Discovery-Channel", "Discovery Channel", "General", "UK", 1],
  ["national-geographic", "National-Geographic", "National Geographic", "General", "UK", 1],
];

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
const bbcPhoenixSource = `live-iframe:${encodeURIComponent("https://ntvs.cx/channel/305")}`;
const bbcAmerica = LIVE_CHANNELS.find((channel) => channel.id === "bbc-us");
assert.equal(bbcAmerica.streams[1].source, bbcPhoenixSource);
assert.equal(findLiveChannelIdBySource(bbcPhoenixSource), "bbc-us");
assert.equal(LIVE_CHANNELS.filter((channel) => channel.id === "bbc-news").length, 1);

console.log("Live channel catalog tests passed (7 NTV/CDNLive channels).");

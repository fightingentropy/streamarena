const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const liveChannelsSource = readFileSync(
  join(__dirname, "../src/lib/live-channels.ts"),
  "utf8",
);
const layoutSource = readFileSync(join(__dirname, "../src/app/_layout.tsx"), "utf8");
const catalog = JSON.parse(
  readFileSync(join(__dirname, "../../shared/live-channels.json"), "utf8"),
);

test("mobile live catalog is generated from the shared JSON source", () => {
  assert.match(liveChannelsSource, /from "streamarena-shared\/live-channels\.json"/);
  assert.equal(catalog.channels.length, 88);
  const bbcAmerica = catalog.channels.find((channel) => channel.id === "bbc-us");
  assert.equal(bbcAmerica.streams.length, 1);
  assert.equal(
    catalog.channels.some((channel) =>
      channel.streams.some((stream) => String(stream.source || "").startsWith("live-iframe:")),
    ),
    false,
  );
});

test("authenticated sessions load live channel URL overrides", () => {
  assert.match(liveChannelsSource, /export function loadLiveChannelOverrides/);
  assert.match(liveChannelsSource, /\/api\/live\/channel-overrides/);
  assert.match(layoutSource, /<LiveCatalogBootstrap \/>/);
  assert.match(layoutSource, /if \(status !== "authenticated"\) return;/);
  assert.match(layoutSource, /void loadLiveChannelOverrides\(\);/);
});

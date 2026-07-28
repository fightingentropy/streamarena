const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const liveScreenSource = readFileSync(
  join(__dirname, "../src/app/(tabs)/live.tsx"),
  "utf8",
);
const liveSegmentedSource = readFileSync(
  join(__dirname, "../src/components/live/LiveSegmented.tsx"),
  "utf8",
);

test("the Live screen defaults to Live TV unless Sports is explicitly requested", () => {
  assert.match(
    liveScreenSource,
    /const initial: LiveTab = params\.tab === "sports" \? "sports" : "tv";/,
  );
  assert.match(liveScreenSource, /if \(params\.tab === "sports"\) setTab\("sports"\);/);
  assert.match(
    liveScreenSource,
    /params\.tab === "tv" \|\| params\.tab === "twitch"/,
  );
});

test("the Live switcher shows Live TV to the left of Sports", () => {
  const liveTvIndex = liveSegmentedSource.indexOf('{ id: "tv", label: "Live TV" }');
  const sportsIndex = liveSegmentedSource.indexOf('{ id: "sports", label: "Sports" }');

  assert.notEqual(liveTvIndex, -1);
  assert.notEqual(sportsIndex, -1);
  assert.ok(liveTvIndex < sportsIndex);
});

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const liveScreenSource = readFileSync(
  join(__dirname, "../src/app/(tabs)/live.tsx"),
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

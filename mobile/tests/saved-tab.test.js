const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const savedScreenSource = readFileSync(
  join(__dirname, "../src/app/(tabs)/mylist.tsx"),
  "utf8",
);
const homeScreenSource = readFileSync(
  join(__dirname, "../src/app/(tabs)/index.tsx"),
  "utf8",
);

test("Continue Watching stays on Home and is not duplicated in Saved", () => {
  assert.doesNotMatch(savedScreenSource, /ContinueWatchingRail|useContinueWatching/);
  assert.match(savedScreenSource, /data=\{titles\}/);
  assert.match(homeScreenSource, /useContinueWatching\(scope\)/);
  assert.match(
    homeScreenSource,
    /<ContinueWatchingRail items=\{visibleContinue\}/,
  );
});

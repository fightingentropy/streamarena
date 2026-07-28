const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const wordmarkSource = readFileSync(
  join(__dirname, "../src/components/brand/Wordmark.tsx"),
  "utf8",
);
const signInSource = readFileSync(
  join(__dirname, "../src/app/signin.tsx"),
  "utf8",
);
const registerSource = readFileSync(
  join(__dirname, "../src/app/register.tsx"),
  "utf8",
);

test("the mobile wordmark renders an accessible arched Netflix treatment", () => {
  assert.match(
    wordmarkSource,
    /const NETFLIX_WORDMARK_VIEW_BOX = "0 0 309 83";/,
  );
  assert.match(wordmarkSource, /const NETFLIX_WORDMARK_PATH =/);
  assert.match(wordmarkSource, /M238\.626 75\.3097/);
  assert.match(wordmarkSource, /const NETFLIX_RED = "#E50914";/);
  assert.match(wordmarkSource, /preserveAspectRatio="xMinYMid meet"/);
  assert.match(wordmarkSource, /accessibilityLabel="Netflix"/);
  assert.doesNotMatch(wordmarkSource, /LETTER_HEIGHTS|AvenirNextCondensed|<Text/);
});

test("authentication screens use the shared Netflix wordmark", () => {
  for (const source of [signInSource, registerSource]) {
    assert.match(source, /<Wordmark size=\{32\}/);
    assert.doesNotMatch(source, /STREAMARENA/);
  }
});

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

function load(path, dependencies = {}) {
  const module = { exports: {} };
  const source = ts.transpileModule(readFileSync(join(__dirname, path), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(source, { exports: module.exports, module, require: (name) => {
    assert.ok(dependencies[name], `Unexpected runtime dependency: ${name}`);
    return dependencies[name];
  } });
  return module.exports;
}
const nav = load("../src/lib/nav.ts");
const { buildFeaturedPlayHref } = load("../src/lib/continue-watching.ts", { "@/lib/nav": nav });
const title = { id: "42", mediaType: "movie", title: "Featured film", year: "2020", posterPath: "/poster.jpg" };

test("Home Play opens a movie player with its actual identity and artwork", () => {
  const href = buildFeaturedPlayHref(title, []);
  assert.equal(href.pathname, "/watch/[id]");
  assert.equal(href.params.id, "42");
  assert.equal(href.params.mediaType, "movie");
  assert.equal(href.params.poster, "https://image.tmdb.org/t/p/w342/poster.jpg");
  assert.equal(href.params.sourceHash, undefined);
});

test("Home Play starts a series at its first real season and carries episode counts", () => {
  const href = buildFeaturedPlayHref({ ...title, mediaType: "tv" }, [], {
    number_of_seasons: 3,
    seasons: [{ season_number: 0, episode_count: 8 }, { season_number: 1, episode_count: 10 }],
  });
  assert.equal(href.pathname, "/watch/[id]");
  assert.equal(href.params.seasonNumber, "1");
  assert.equal(href.params.episodeNumber, "1");
  assert.equal(href.params.episodeCount, "10");
  assert.equal(href.params.seasonCount, "3");
});

test("Home Resume preserves the watched episode and selected source, matching media type", () => {
  const href = buildFeaturedPlayHref({ ...title, mediaType: "tv" }, [
    { tmdbId: "42", mediaType: "movie", sourceIdentity: "tmdb:movie:42", sourceHash: "wrong" },
    { tmdbId: "42", mediaType: "tv", sourceIdentity: "tmdb:tv:42:s2:e6", sourceHash: "chosen" },
  ], { number_of_seasons: 3 });
  assert.equal(href.pathname, "/watch/[id]");
  assert.equal(href.params.seasonNumber, "2");
  assert.equal(href.params.episodeNumber, "6");
  assert.equal(href.params.sourceHash, "chosen");
  assert.equal(href.params.seasonCount, "3");
});

test("a saved series with no episode opens the episode picker instead of restarting it", () => {
  const href = buildFeaturedPlayHref({ ...title, mediaType: "tv" }, [
    { tmdbId: "42", mediaType: "tv", sourceIdentity: "tmdb:tv:42" },
  ]);
  assert.equal(href.pathname, "/title/[mediaType]/[id]");
});

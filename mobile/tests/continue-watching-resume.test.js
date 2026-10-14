const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const test = require("node:test");
const ts = require("typescript");
const { videoHarness } = require("./helpers/video-harness");

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
const { buildResumeHref } = load("../src/lib/continue-watching.ts", { "@/lib/nav": nav });
const settled = () => new Promise((resolve) => setImmediate(resolve));

for (const mediaType of ["movie", "tv"]) {
  for (const progressFirst of [true, false]) {
    test(`${mediaType} Continue Watching re-ranks the source and resumes when ${progressFirst ? "progress" : "video"} loads first`, async () => {
      const entry = Object.freeze({
        tmdbId: "42", mediaType, title: "Resume fixture", year: "2020",
        sourceIdentity: mediaType === "tv" ? "tmdb:tv:42:s2:e6" : "tmdb:movie:42",
        // A stale display label must not override the canonical saved episode.
        episode: "S1 E1", resolverProvider: "external-embed",
        sourceHash: "old-nebula", resumeSeconds: 613.25,
      });
      const href = buildResumeHref(entry, 3);
      assert.equal(href.params.sourceHash, undefined);
      const request = {
        tmdbId: href.params.id, mediaType: href.params.mediaType,
        ...(href.params.seasonNumber ? { seasonNumber: Number(href.params.seasonNumber) } : {}),
        ...(href.params.episodeNumber ? { episodeNumber: Number(href.params.episodeNumber) } : {}),
      };
      const reads = [];
      let releaseProgress;
      const progress = new Promise((resolve) => { releaseProgress = resolve; });
      const { loadResumeSeconds } = load("../src/video/resume.ts", { "@/lib/api": {
        withAccountScope: (path, scope) => `${path}?scope=${scope}`,
        getJson: async (path) => {
          reads.push(path);
          await progress;
          return { entries: [
            { sourceIdentity: "tmdb:tv:42:s1:e1", resumeSeconds: 999 },
            entry,
          ] };
        },
      } });
      const h = videoHarness({ timer: () => 1, clearTimer() {}, services: {
        loadResumeSeconds,
        resolveTitle: async () => ({
          playableUrl: "https://media.example/current-ranking.mp4",
          sourceHash: "current-miami", resolverProvider: "external-embed",
          tracks: { audioTracks: [], subtitleTracks: [] },
        }),
      } });
      const state = h.load("state");
      const store = state.usePlayerStore;
      const seeks = [];
      const seek = (seconds) => seeks.push(seconds);
      state.registerSeek(seek);
      try {
        if (progressFirst) releaseProgress();
        await store.getState().open(request, "fixture-account", { sourceHash: href.params.sourceHash });
        await settled();
        assert.equal(h.requests.length, 1);
        assert.equal(h.requests[0].sourceHash, undefined);
        assert.equal(h.requests[0].tmdbId, "42");
        assert.equal(h.requests[0].mediaType, mediaType);
        assert.equal(h.load("identity").progressIdentity(request), entry.sourceIdentity);
        assert.equal(store.getState().selectedSourceHash, "current-miami");
        store.getState().onLoad(2400);
        if (!progressFirst) {
          assert.deepEqual(seeks, []);
          releaseProgress();
          await settled();
        }
        assert.deepEqual(seeks, [613.25]);
        assert.equal(store.getState().position, entry.resumeSeconds);
        assert.equal(store.getState().pendingSeekSeconds, entry.resumeSeconds);
        store.getState().onLoad(2400);
        assert.deepEqual(seeks, [613.25], "resume is applied only once");
        assert.deepEqual(reads, ["/api/user/continue-watching?scope=fixture-account"]);
        assert.equal(entry.sourceHash, "old-nebula", "saved metadata is not rewritten");
        assert.equal(entry.resumeSeconds, 613.25);
      } finally {
        store.getState().close();
        state.clearSeek(seek);
      }
    });
  }
}

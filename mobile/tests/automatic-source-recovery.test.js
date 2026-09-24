const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

const compiled = ts.transpileModule(
  readFileSync(join(__dirname, "../src/video/state.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } },
).outputText;

function playerStore(sources) {
  const requests = [];
  const mod = { exports: {} };
  runInNewContext(compiled, {
    module: mod, exports: mod.exports, AbortController,
    setTimeout: () => 1, clearTimeout() {},
    require: (id) => {
      if (id === "zustand") return require("zustand");
      if (id === "@/lib/streamarena") return { getCachedPreferences: () => ({}) };
      if (id === "./identity") return { progressIdentity: () => "tmdb:movie:496243" };
      if (id === "./report") return {
        reportPlaybackError() {}, stopReporting() {}, beginReporting() {},
      };
      if (id === "./tracks") return { findSelectedTextTrackIndex: () => null };
      if (id === "./resolve") return {
        async resolveAndRoute(_request, options) {
          requests.push(options.sourceHash);
          return {
            resolved: { sourceHash: options.sourceHash },
            source: { uri: "https://media.example/test.m3u8", isHls: true },
          };
        },
      };
      return {};
    },
  });
  const store = mod.exports.usePlayerStore;
  store.setState({
    request: { tmdbId: 496243, mediaType: "movie" },
    status: "loading", buffering: true, paused: false,
    selectedSourceHash: "current", sources,
  });
  return { store, requests };
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

test("automatic recovery skips manual-only and unhealthy rows without hiding them", async () => {
  const sources = [
    { sourceHash: "manual", automaticFallbackEligible: false },
    { sourceHash: "unhealthy", automaticFallbackEligible: false },
    { sourceHash: "eligible", automaticFallbackEligible: true },
  ];
  const { store, requests } = playerStore(sources);
  store.getState().onStall();
  await settled();
  assert.deepEqual(requests, ["eligible"]);
  assert.equal(store.getState().selectedSourceHash, "eligible");
  assert.equal(store.getState().sources, sources);
});

test("explicit manual source selection remains allowed", async () => {
  const { store, requests } = playerStore([
    { sourceHash: "manual", automaticFallbackEligible: false },
  ]);
  store.getState().reopenWith({ sourceHash: "manual" });
  await settled();
  assert.deepEqual(requests, ["manual"]);
  assert.equal(store.getState().selectedSourceHash, "manual");
});

test("automatic recovery preserves torrent and older-server rows without the flag", async () => {
  for (const candidate of [
    { sourceHash: "torrent", isTorrent: true },
    { sourceHash: "legacy", isTorrent: false },
  ]) {
    const { store, requests } = playerStore([candidate]);
    store.getState().onStall();
    await settled();
    assert.deepEqual(requests, [candidate.sourceHash]);
  }
});

test("exhausted automatic candidates do not fall through to a manual-only server", async () => {
  const { store, requests } = playerStore([
    { sourceHash: "current", automaticFallbackEligible: true },
    { sourceHash: "tried", automaticFallbackEligible: true },
    { sourceHash: "manual", automaticFallbackEligible: false },
  ]);
  store.setState({ triedHashes: ["tried"] });
  store.getState().onStall();
  await settled();
  assert.deepEqual(requests, []);
  assert.equal(store.getState().status, "error");
});

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

function playerStore() {
  const compiled = ts.transpileModule(
    readFileSync(join(__dirname, "../src/video/state.ts"), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } },
  ).outputText;
  const mod = { exports: {} };
  runInNewContext(compiled, {
    module: mod, exports: mod.exports, setTimeout, clearTimeout,
    require: (id) => {
      if (id === "zustand") return require("zustand");
      if (id === "./report") return { reportProgress() {} };
      return {};
    },
  });
  const store = mod.exports.usePlayerStore;
  store.setState({
    request: { tmdbId: 496243, mediaType: "movie" },
    status: "loading", buffering: true, paused: false,
  });
  return store;
}

test("advancing VOD playback clears buffering without a second playing event", () => {
  const store = playerStore();
  store.getState().setProgress(400, 7900);
  assert.equal(store.getState().buffering, true);
  store.getState().setProgress(400.5, 7900);
  assert.equal(store.getState().buffering, false);
  assert.equal(store.getState().status, "playing");

  store.getState().onBuffer(true);
  store.getState().setProgress(401, 7900);
  assert.equal(store.getState().buffering, false);
});

test("a resume position that stays frozen does not dismiss buffering", () => {
  const store = playerStore();
  store.getState().setProgress(400, 7900);
  store.getState().setProgress(400, 7900);
  assert.equal(store.getState().buffering, true);
  assert.equal(store.getState().status, "loading");
});

test("late progress does not restart paused or failed playback", () => {
  for (const status of ["paused", "error"]) {
    const store = playerStore();
    store.setState({ status, paused: status === "paused" });
    store.getState().setProgress(400, 7900);
    store.getState().setProgress(401, 7900);
    assert.equal(store.getState().status, status);
    assert.equal(store.getState().buffering, true);
  }
});

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

const compiled = ts.transpileModule(
  readFileSync(join(__dirname, "../src/store/offline.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText;

const meta = { assetId: "tmdb:movie:399106", tmdbId: "399106", mediaType: "movie", title: "Piper", exportInput: "https://source.test/movie.mp4" };
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function offlineStore() {
  let online = true;
  let cellular = false;
  const subscribers = new Set();
  const tasks = [];
  const files = new Map();
  const rows = new Map();
  const modules = {
    react: { useMemo: (fn) => fn() },
    "react-native": { AppState: { addEventListener: () => ({ remove() {} }) } },
    zustand: require("zustand"),
    "@/lib/config": { toAbsoluteApiUrl: (url) => `https://streamarena.test${url}` },
    "@/lib/streamarena": { buildExportUrl: (input) => `/api/download/export.mp4?input=${encodeURIComponent(input)}` },
    "@/lib/storage": { storage: { getItem() {}, setItem() {} } },
    "@/lib/disk-usage": { getDiskUsage: async () => ({ usedByDownloads: 0 }) },
    "@/lib/offline-paths": {
      toRelativeOfflinePath: (path) => path,
      toAbsoluteOfflinePath: (path) => path,
      relativizeSubtitlePaths: (paths) => paths,
      absolutizeSubtitlePaths: (paths) => paths,
    },
    "@/lib/offline-db": {
      dbAllRows: async () => [...rows.values()],
      dbUpsertRow: async (row) => { rows.set(row.key, row); },
      dbDeleteRow: async (key) => { rows.delete(key); },
    },
    "@/lib/connectivity": {
      getIsOnline: () => online,
      isMeteredConnection: () => cellular,
      subscribeOnline: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
    },
    "expo-file-system/legacy": {
      documentDirectory: "file:///documents/",
      FileSystemSessionType: { BACKGROUND: 0 },
      makeDirectoryAsync: async () => {},
      getInfoAsync: async (uri) => ({ exists: files.has(uri), size: files.get(uri) || 0, isDirectory: false }),
      deleteAsync: async (uri) => { files.delete(uri); },
      createDownloadResumable(url, uri, options, onProgress, resumeData) {
        const transfer = deferred();
        const cancellation = deferred();
        const task = {
          url, uri, options, resumeData,
          downloadAsync: () => transfer.promise,
          resumeAsync: () => transfer.promise,
          pauseAsync: () => { transfer.reject(new Error("Paused")); return cancellation.promise; },
          cancelAsync: () => { transfer.reject(new Error("Cancelled")); return cancellation.promise; },
          finish(bytes = 128 * 1024, status = 200) {
            files.set(uri, bytes);
            onProgress({ totalBytesWritten: bytes, totalBytesExpectedToWrite: bytes });
            transfer.resolve({ uri, status });
          },
          fail: transfer.reject,
          finishCancellation: () => cancellation.resolve({ resumeData: "unsupported-resume-data" }),
        };
        tasks.push(task);
        return task;
      },
    },
  };
  const mod = { exports: {} };
  runInNewContext(compiled, {
    module: mod, exports: mod.exports, setTimeout, clearTimeout,
    require: (id) => {
      assert.ok(modules[id], `Unexpected dependency: ${id}`);
      return modules[id];
    },
  });
  const store = mod.exports.useOfflineStore;
  store.setState({ hydrated: true });
  mod.exports.initOfflineSync();
  return {
    store, tasks, rows, offline: mod.exports,
    record: () => Object.values(store.getState().records)[0],
    network(isOnline, isCellular) {
      online = isOnline;
      cellular = isCellular;
      for (const fn of subscribers) fn(online);
    },
  };
}

for (const cellular of [false, true]) {
  test(`a complete ${cellular ? "cellular" : "Wi-Fi"} transfer becomes a local playable download`, async () => {
    const h = offlineStore();
    h.network(true, cellular);
    await h.store.getState().queueDownload(meta);
    await flush();
    assert.equal(h.tasks.length, 1);
    h.tasks[0].finish();
    await flush();
    assert.equal(h.record().status, "ready");
    assert.match(h.record().videoPath, /^file:\/\/\/documents\/offline-media\//);
    assert.equal(h.record().bytes, 128 * 1024);
    assert.equal([...h.rows.values()][0].status, "ready");
  });
}

test("Wi-Fi-only work waits on cellular and starts when cellular downloads are allowed", async () => {
  const h = offlineStore();
  h.network(true, true);
  h.store.getState().setWifiOnly(true);
  await h.store.getState().queueDownload(meta);
  await flush();
  assert.equal(h.tasks.length, 0);
  assert.equal(h.record().status, "queued");
  h.store.getState().setWifiOnly(false);
  await flush();
  assert.equal(h.tasks.length, 1);
  h.tasks[0].finish();
  await flush();
  assert.equal(h.record().status, "ready");
});

test("a Wi-Fi return during native cancellation cannot strand the queued download", async () => {
  const h = offlineStore();
  h.store.getState().setWifiOnly(true);
  await h.store.getState().queueDownload(meta);
  await flush();
  h.network(true, true);
  await flush();
  h.network(true, false);
  await flush();
  h.tasks[0].finishCancellation();
  await flush();
  assert.equal(h.tasks.length, 2);
  assert.equal(h.tasks[1].resumeData, undefined, "streamed exports do not support byte-range resume");
  h.tasks[1].finish();
  await flush();
  assert.equal(h.record().status, "ready");
});

test("an interrupted export is retried without becoming a ready partial file", async () => {
  const h = offlineStore();
  await h.store.getState().queueDownload(meta);
  await flush();
  for (let i = 0; i < 3; i++) {
    assert.equal(h.record().status, "downloading");
    h.tasks[i].fail(new Error("Response ended before the export completed"));
    await flush();
  }
  assert.equal(h.tasks.length, 3);
  assert.equal(h.record().status, "error");
  assert.equal(h.record().videoPath, undefined);
});

test("an offline queue starts on cellular when connectivity returns", async () => {
  const h = offlineStore();
  h.network(false, false);
  await h.store.getState().queueDownload(meta);
  await flush();
  assert.equal(h.tasks.length, 0);
  assert.equal(h.record().status, "queued");
  h.network(true, true);
  await flush();
  assert.equal(h.tasks.length, 1);
  h.tasks[0].finish();
  await flush();
  assert.equal(h.record().status, "ready");
});

test("an allowed Wi-Fi to cellular handoff keeps the native transfer active", async () => {
  const h = offlineStore();
  await h.store.getState().queueDownload(meta);
  await flush();
  h.network(true, true);
  await flush();
  assert.equal(h.tasks.length, 1);
  assert.equal(h.record().status, "downloading");
  h.tasks[0].finish();
  await flush();
  assert.equal(h.record().status, "ready");
});

test("a transfer that fails during an outage waits and restarts on reconnect", async () => {
  const h = offlineStore();
  await h.store.getState().queueDownload(meta);
  await flush();
  h.network(false, false);
  h.tasks[0].fail(new Error("Network connection lost"));
  await flush();
  assert.equal(h.record().status, "queued");
  assert.equal(h.record().videoPath, undefined);
  assert.equal(h.tasks.length, 1);
  h.network(true, true);
  await flush();
  assert.equal(h.tasks.length, 2);
  h.tasks[1].finish();
  await flush();
  assert.equal(h.record().status, "ready");
});

for (const mediaType of ["movie", "tv"]) {
  test(`a downloaded ${mediaType} opens locally while network resolution and resume are unavailable`, async () => {
    const h = offlineStore();
    const request = { tmdbId: "399106", mediaType, seasonNumber: 1, episodeNumber: 2, title: "Offline fixture" };
    const identityModule = { exports: {} };
    runInNewContext(ts.transpileModule(
      readFileSync(join(__dirname, "../src/video/identity.ts"), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.CommonJS } },
    ).outputText, { module: identityModule, exports: identityModule.exports });
    const assetId = identityModule.exports.progressIdentity(request);
    await h.store.getState().queueDownload({ ...meta, ...request, assetId });
    await flush();
    h.tasks[0].finish();
    await flush();
    h.network(false, false);

    let resolveCalls = 0;
    const modules = {
      zustand: require("zustand"),
      "@/lib/streamarena": {},
      "@/store/offline": h.offline,
      "./identity": identityModule.exports,
      "./live": {},
      "./live-recovery": {},
      "./refresh": {},
      "./report": { beginReporting() {}, stopReporting() {}, reportNow() {} },
      "./resolve": { resolveAndRoute: async () => { resolveCalls++; throw new Error("Network unavailable"); } },
      "./resume": { loadResumeSeconds: () => new Promise(() => {}) },
      "./tracks": {},
    };
    const playerModule = { exports: {} };
    runInNewContext(ts.transpileModule(
      readFileSync(join(__dirname, "../src/video/state.ts"), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
    ).outputText, {
      module: playerModule, exports: playerModule.exports, AbortController, setTimeout, clearTimeout,
      require: (id) => { assert.ok(modules[id], `Unexpected dependency: ${id}`); return modules[id]; },
    });
    const player = playerModule.exports.usePlayerStore;
    await player.getState().open(request, "anonymous");
    assert.equal(resolveCalls, 0);
    assert.equal(player.getState().source.uri, h.record().videoPath);
    assert.equal(player.getState().source.isHls, false);
    player.getState().onLoad(360);
    assert.equal(player.getState().status, "playing");
    assert.equal(player.getState().buffering, false);
    player.getState().close();
  });
}

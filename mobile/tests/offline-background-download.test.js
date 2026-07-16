const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const source = readFileSync(join(__dirname, "../src/store/offline.ts"), "utf8");

function sourceBetween(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("offline video transfers use the iOS background URLSession", () => {
  const pump = sourceBetween("const runPump = async () =>", "const pauseActiveDownload = async () =>");

  assert.match(
    pump,
    /createDownloadResumable\([\s\S]*sessionType:\s*FileSystem\.FileSystemSessionType\.BACKGROUND/,
  );
  assert.doesNotMatch(pump, /isForeground/);
});

test("locking or backgrounding the app does not pause an active download", () => {
  const sync = sourceBetween("export function initOfflineSync()", "// --- Offline playback seam");
  const appStateListener = sourceBetween(
    'AppState.addEventListener("change"',
    "const unsubscribeOnline = subscribeOnline",
  );

  assert.match(appStateListener, /next === "active"/);
  assert.doesNotMatch(appStateListener, /pauseActiveDownload/);
  assert.doesNotMatch(sync, /next === "background"/);
});

test("temporary outages are left to iOS while Wi-Fi-only still pauses on cellular", () => {
  const sync = sourceBetween("export function initOfflineSync()", "// --- Offline playback seam");
  const wifiSetting = sourceBetween("setWifiOnly: (enabled)", "setMaxStorageBytes: (bytes)");

  assert.match(sync, /state\.wifiOnly && isMeteredConnection\(\)/);
  assert.match(sync, /void state\.pauseActiveDownload\(\)/);
  assert.doesNotMatch(sync, /else\s+void useOfflineStore\.getState\(\)\.pauseActiveDownload/);
  assert.match(wifiSetting, /enabled && isMeteredConnection\(\)/);
  assert.match(wifiSetting, /void pauseActiveDownload\(\)/);
});

test("removing downloads cancels any matching native background task", () => {
  const removal = sourceBetween("const cancelActiveDownload = async", "const runPump = async () =>");
  const clear = sourceBetween("clearDownloads: async () =>", "refreshStorage,");

  assert.match(removal, /active\.resumable\.cancelAsync\(\)/);
  assert.match(removal, /await cancelActiveDownload\(key\)/);
  assert.match(clear, /await cancelActiveDownload\(activeKey\)/);
});

test("orphan cleanup never deletes system-managed background-session files", () => {
  const cleanup = sourceBetween(
    "async function purgeOrphanedDownloadArtifacts()",
    "// Keep the active background NSURLSession running",
  );

  assert.match(cleanup, /OFFLINE_DIR/);
  assert.doesNotMatch(cleanup, /Library\/Caches|nsurlsessiond|containerRoot/);
});

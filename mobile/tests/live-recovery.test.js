const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

const recoveryPath = join(__dirname, "../src/video/live-recovery.ts");
const compiledRecovery = ts.transpileModule(
  readFileSync(recoveryPath, "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } },
).outputText;
const recoveryModule = { exports: {} };
runInNewContext(compiledRecovery, {
  exports: recoveryModule.exports,
  module: recoveryModule,
});
const { shouldRefreshSingleLiveSource } = recoveryModule.exports;
const stateSource = readFileSync(join(__dirname, "../src/video/state.ts"), "utf8");

test("a healthy single live source gets one token refresh", () => {
  assert.equal(shouldRefreshSingleLiveSource(1, 7, false), true);
  assert.equal(shouldRefreshSingleLiveSource(1, 7, true), false);
});

test("live token refresh never loops startup failures or delays alternate sources", () => {
  assert.equal(shouldRefreshSingleLiveSource(1, 0, false), false);
  assert.equal(shouldRefreshSingleLiveSource(1, 6, false), false);
  assert.equal(shouldRefreshSingleLiveSource(2, 30, false), false);
  assert.match(stateSource, /shouldRefreshSingleLiveSource\(liveSources\.length, position, reresolved\)/);
});

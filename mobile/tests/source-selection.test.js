const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

const sourceSelectionPath = join(
  __dirname,
  "../src/components/player/source-selection.ts",
);
const compiledSourceSelection = ts.transpileModule(
  readFileSync(sourceSelectionPath, "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } },
).outputText;
const sourceSelectionModule = { exports: {} };
runInNewContext(compiledSourceSelection, {
  exports: sourceSelectionModule.exports,
  module: sourceSelectionModule,
});
const { sourceTabForActiveSource } = sourceSelectionModule.exports;

const hlsSource = {
  sourceHash: "A".repeat(40),
  isTorrent: false,
};
const torrentSource = {
  sourceHash: "b".repeat(40),
  isTorrent: true,
};
const sources = [hlsSource, torrentSource];

test("the source picker reopens on HLS when HLS is actually playing", () => {
  assert.equal(
    sourceTabForActiveSource(sources, hlsSource.sourceHash.toLowerCase()),
    "hls",
  );
});

test("the source picker reopens on Torrents when a torrent is actually playing", () => {
  assert.equal(
    sourceTabForActiveSource(sources, torrentSource.sourceHash),
    "torrents",
  );
});

test("an unknown active source safely defaults the picker to HLS", () => {
  assert.equal(sourceTabForActiveSource(sources, "missing"), "hls");
});

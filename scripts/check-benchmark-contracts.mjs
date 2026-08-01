#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const requiredScripts = ["bench:startup", "bench:resolve", "bench:load", "bench:playback"];
for (const name of requiredScripts) {
  if (!packageJson.scripts?.[name]) throw new Error(`Missing package benchmark '${name}'.`);
}

const contracts = [
  ["scripts/startup-scan-benchmark.mjs", ["--max-p95-ms", "p95Ms", "gate"]],
  ["scripts/resolver-load-benchmark.mjs", ["--max-p95-ms", "p95Ms", "gate"]],
  ["scripts/playback-load-benchmark.mjs", ["--max-p95-ms", "clients", "gate"]],
  ["scripts/playback-benchmark.mjs", ["--max-startup-ms", "settledMs", "gate"]],
];

for (const [file, tokens] of contracts) {
  const source = readFileSync(resolve(root, file), "utf8");
  for (const token of tokens) {
    if (!source.includes(token)) throw new Error(`${file} is missing benchmark contract '${token}'.`);
  }
}

console.log(`Benchmark contracts passed (${contracts.length} gated workloads).`);

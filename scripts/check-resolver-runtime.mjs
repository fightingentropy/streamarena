#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const runtimeDir = resolve(process.argv[2] || new URL(".", import.meta.url).pathname);
const loaderPath = resolve(runtimeDir, "lib/load-playwright.mjs");
const resolverEntrypoints = [
  "resolve-external-embed-hls.mjs",
  "resolve-cinejoy-hls.mjs",
  "resolve-streamed-hls.mjs",
  "resolve-matchstream-hls.mjs",
  "resolve-ntvs-hls.mjs",
  "resolve-cdnlivetv-hls.mjs",
  "fetch-browser-live-hls.mjs",
  "resolve-embed-min.mjs",
  "serve-browser-hls-session.mjs",
];

function isRegularFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

const missingFiles = [
  loaderPath,
  ...resolverEntrypoints.map((name) => resolve(runtimeDir, name)),
].filter((path) => !isRegularFile(path));

if (missingFiles.length > 0) {
  console.error("Resolver runtime bundle is incomplete:");
  for (const path of missingFiles) console.error(`  missing ${path}`);
  process.exit(1);
}

try {
  const loader = await import(pathToFileURL(loaderPath).href);
  if (typeof loader.loadPlaywright !== "function") {
    throw new TypeError("loadPlaywright export is missing");
  }
  const playwright = await loader.loadPlaywright();
  if (!playwright?.chromium || typeof playwright.chromium.executablePath !== "function") {
    throw new TypeError("Playwright Chromium API is unavailable");
  }
} catch (error) {
  console.error(`Resolver Playwright loader failed: ${error?.stack || error}`);
  process.exit(1);
}

const failures = [];
for (const name of resolverEntrypoints) {
  const entrypoint = resolve(runtimeDir, name);
  const result = spawnSync(process.execPath, [entrypoint], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.error || result.status !== 2 || !/Usage:/.test(output)) {
    failures.push({
      name,
      reason: result.error?.message || `exit=${String(result.status)}`,
      output: output.trim().slice(0, 500),
    });
  }
}

if (failures.length > 0) {
  console.error("Resolver runtime entrypoint smoke failed:");
  for (const failure of failures) {
    console.error(`  ${failure.name}: ${failure.reason}`);
    if (failure.output) console.error(`    ${failure.output.replaceAll("\n", "\n    ")}`);
  }
  process.exit(1);
}

console.log(
  `Resolver runtime bundle is complete (${resolverEntrypoints.length} entrypoints + Playwright loader).`,
);

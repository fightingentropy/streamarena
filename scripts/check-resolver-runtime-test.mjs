#!/usr/bin/env node
import assert from "node:assert/strict";
import { cp, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const checker = join(scriptsDir, "check-resolver-runtime.mjs");
const runtimeFiles = [
  "resolve-external-embed-hls.mjs",
  "resolve-streamed-hls.mjs",
  "resolve-matchstream-hls.mjs",
  "resolve-ntvs-hls.mjs",
  "resolve-cdnlivetv-hls.mjs",
  "fetch-browser-live-hls.mjs",
  "resolve-embed-min.mjs",
  "serve-browser-hls-session.mjs",
];
const projectRoot = resolve(scriptsDir, "..");

async function makeRuntimeBundle() {
  const runtimeDir = await mkdtemp(join(tmpdir(), "streamarena-resolver-runtime-"));
  await cp(join(scriptsDir, "lib"), join(runtimeDir, "lib"), { recursive: true });
  await Promise.all(
    runtimeFiles.map((name) => cp(join(scriptsDir, name), join(runtimeDir, name))),
  );
  return runtimeDir;
}

function checkBundle(runtimeDir) {
  return spawnSync(process.execPath, [checker, runtimeDir], {
    encoding: "utf8",
    env: {
      ...process.env,
      PLAYWRIGHT_NODE_MODULES: projectRoot,
    },
    timeout: 30_000,
  });
}

test("resolver deployment bundle imports every runtime entrypoint", async (t) => {
  const runtimeDir = await makeRuntimeBundle();
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));

  const result = checkBundle(runtimeDir);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /8 entrypoints \+ Playwright loader/);
});

test("resolver deployment bundle rejects a missing shared loader", async (t) => {
  const runtimeDir = await makeRuntimeBundle();
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  await unlink(join(runtimeDir, "lib/load-playwright.mjs"));

  const result = checkBundle(runtimeDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bundle is incomplete/);
  assert.match(result.stderr, /lib\/load-playwright\.mjs/);
});

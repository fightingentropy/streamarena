#!/usr/bin/env node
import assert from "node:assert/strict";
import { cp, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
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

test("shared deployed entrypoint dispatches CineJoy pins without the generic playlist probe", async (t) => {
  const runtimeDir = await makeRuntimeBundle();
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  // An extensionless result must reach Rust's manifest validator unchanged.
  await writeFile(join(runtimeDir, "lib/resolve-cinejoy-hls.mjs"), `
    export async function resolveCinejoy(watchUrl, server, timeoutMs) {
      return { playbackUrl: "https://lol.movieboxnoob.cc/content?v=test",
        referer: "https://cinejoy.to/", watchUrl, server, timeoutMs };
    }
  `);
  for (const server of ["", "NEBULA", "SOLARA"]) {
    const watchUrl = "https://cinejoy.to/watch/tv/1396/1/2";
    const result = spawnSync(process.execPath,
      [join(runtimeDir, "resolve-external-embed-hls.mjs"), watchUrl], {
        encoding: "utf8", timeout: 5000,
        env: { ...process.env, EXTERNAL_EMBED_SERVER: server,
          EXTERNAL_EMBED_HLS_RESOLVE_TIMEOUT_MS: "12345" },
      });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      playbackUrl: "https://lol.movieboxnoob.cc/content?v=test",
      referer: "https://cinejoy.to/", watchUrl,
      server: server || "LISBON", timeoutMs: 12345,
    });
  }
});

test("shared browser entrypoint closes Chromium after a navigation failure", async (t) => {
  const runtimeDir = await makeRuntimeBundle();
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  await writeFile(join(runtimeDir, "lib/load-playwright.mjs"), `
    export async function loadPlaywright() {
      return { chromium: { launch: async () => ({
        newPage: async () => ({ on() {}, route: async () => {},
          goto: async () => { throw new Error("Navigation failed."); } }),
        close: async () => console.error("Browser closed."),
      }) } };
    }
  `);
  const result = spawnSync(process.execPath,
    [join(runtimeDir, "resolve-external-embed-hls.mjs"), "https://player.videasy.to/movie/1"], {
      encoding: "utf8", timeout: 5000,
      env: { ...process.env, EXTERNAL_EMBED_SERVER: "" },
    });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Navigation failed\./);
  assert.match(result.stderr, /Browser closed\./);
});

#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

// Real player, hls.js and decoded frames; only the resolver/CDN are fixtures.
const root = resolve(new URL("..", import.meta.url).pathname);
const base = `http://127.0.0.1:${process.env.PLAYBACK_TRANSITIONS_TEST_PORT || 4187}`;
const media = await mkdtemp(join(tmpdir(), "streamarena-transitions-"));
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24",
  "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "180",
  "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-pix_fmt", "yuv420p", "-c:a", "aac",
  "-hls_time", "2", "-hls_list_size", "0", "-hls_segment_filename", join(media, "segment-%d.ts"), join(media, "main.m3u8")]);
const hashes = Object.fromEntries(["a", "b", "c", "d"].map(name => [name, name.repeat(40)]));
const server = spawn(join(root, "node_modules/.bin/vite"), ["--host", "127.0.0.1", "--port", new URL(base).port, "--strictPort"], { cwd: root, stdio: "pipe" });
let serverOutput = "";
server.stdout.on("data", chunk => { serverOutput += chunk; });
server.stderr.on("data", chunk => { serverOutput += chunk; });
let browser;
const gates = new Set();
const gate = () => { const value = Promise.withResolvers(); gates.add(value); return value; };
try {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error(serverOutput);
    try { if ((await fetch(`${base}/login.html`)).ok) break; } catch {}
    if (attempt === 79) throw new Error(serverOutput);
    await delay(100);
  }
  browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  const diagnostics = [];
  page.on("console", message => { if (message.type() === "error") diagnostics.push(message.text()); });
  page.on("requestfailed", request => diagnostics.push(`${request.url()} ${request.failure()?.errorText}`));
  page.on("pageerror", error => errors.push(error.message));
  const resolves = [];
  const requests = [];
  const resolveGates = new Map();
  const manifestGates = new Map();
  let failingSegments = 0;
  let segmentFailure = null;
  let hangingSegment = null;
  let healthGate = null;
  let healthRequests = 0;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let payload = {};
    if (path === "/api/auth/me") payload = { id: 1, email: "test@example.invalid", emailVerified: true };
    else if (path === "/api/config") payload = { playbackSessionsEnabled: false };
    else if (path === "/api/library") payload = { movies: [], series: [] };
    else if (path === "/api/user/torrent-settings") payload = { configured: false, enabled: false, localTorrentEnabled: false };
    else if (path === "/api/resolve/sources") payload = { sources: Object.entries(hashes).map(([name, hash]) => ({
      sourceHash: hash, primary: `Provider ${name}`, provider: "CineJoy", container: "hls", isTorrent: false, qualityLabel: "1080p",
    })) };
    else if (path === "/api/resolve/movie") {
      const hash = url.searchParams.get("sourceHash") || hashes.a;
      const name = Object.keys(hashes).find(key => hashes[key] === hash);
      resolves.push(name);
      await resolveGates.get(name)?.promise;
      payload = { sourceHash: hash, resolverProvider: "external-embed", playableUrl: `/fixture-media/${name}/main.m3u8`,
        fallbackUrls: [], tracks: { audioTracks: [], subtitleTracks: [] }, selectedAudioStreamIndex: -1,
        selectedSubtitleStreamIndex: -1, preferences: { subtitleLang: "off" }, metadata: { displayTitle: "Transition test", runtimeSeconds: 180 } };
    } else if (path === "/api/tmdb/details") payload = { title: "Transition test", runtime: 3 };
    else if (path.endsWith("watch-progress") || path.endsWith("continue-watching") || path.endsWith("my-list")) payload = { entries: [] };
    else if (path.startsWith("/api/health")) {
      healthRequests++;
      await healthGate?.promise;
      payload = { ok: true };
    }
    await route.fulfill({ json: payload });
  });
  await page.route("**/fixture-media/**", async route => {
    const [name, filename] = new URL(route.request().url()).pathname.split("/").slice(-2);
    requests.push({ name, filename, at: Date.now() });
    if (name === "d") return route.fulfill({ status: 404, body: "missing" });
    if (filename.endsWith("m3u8")) await manifestGates.get(name)?.promise;
    if (filename === segmentFailure && failingSegments++ < 2) return route.fulfill({ status: 503, body: "temporary failure" });
    if (filename === hangingSegment?.filename) {
      hangingSegment.count++;
      if (hangingSegment.count === 1) await hangingSegment.gate.promise;
    }
    await route.fulfill({ contentType: filename.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t", body: await readFile(join(media, filename)) });
  });
  await page.goto(`${base}/player.html?tmdbId=123&mediaType=movie&title=Transition%20test&benchmark=1`);
  const state = () => page.locator("#playerVideo").evaluate(video => ({
    time: video.currentTime, paused: video.paused, seeking: video.seeking, readyState: video.readyState,
    frames: video.getVideoPlaybackQuality().totalVideoFrames, width: video.videoWidth, error: video.error?.message,
  }));
  const waitPlaying = async target => page.waitForFunction(target => {
    const video = document.querySelector("#playerVideo");
    return video?.readyState >= 2 && !video.seeking && !video.paused && video.currentTime >= target && video.videoWidth > 0;
  }, target, { timeout: 20_000 }).catch(async error => {
    console.error(JSON.stringify({ state: await state(), resolves, requests: requests.slice(-10), errors, diagnostics,
      snapshot: await page.evaluate(() => window.__STREAMARENA_PLAYBACK_BENCHMARK__?.getSnapshot().sourceHistory),
      overlay: await page.locator(".resolver-overlay").textContent() }));
    throw error;
  });
  const seek = target => page.evaluate(target => window.__STREAMARENA_PLAYBACK_BENCHMARK__.measureSeek({ targetSeconds: target }), target).catch(async error => {
    console.error(JSON.stringify({ state: await state(), resolves, requests: requests.slice(-15), errors, diagnostics,
      snapshot: await page.evaluate(() => window.__STREAMARENA_PLAYBACK_BENCHMARK__?.getSnapshot()) }));
    throw error;
  });
  const choose = async name => {
    await page.locator("#toggleSource").evaluate(button => button.click());
    await page.locator(`.source-option[data-source-hash="${hashes[name]}"]`).evaluate(button => button.click());
  };
  const waitSelected = async name => page.waitForFunction(hash => {
    return document.querySelector(`.source-option[data-source-hash="${hash}"]`)?.getAttribute("aria-pressed") === "true" &&
      !document.querySelector('.source-option[aria-busy="true"]') &&
      document.querySelector("#playerVideo").readyState >= 2;
  }, hashes[name], { timeout: 20_000 });
  await waitPlaying(0.5);
  console.log("✓ initial HLS decoded playback");
  const resolveCount = resolves.length;
  segmentFailure = "segment-65.ts";
  const forward = await seek(130.25);
  await waitPlaying(130.5);
  assert(failingSegments >= 3, "seek must exercise and recover the failed segment requests");
  assert.equal(resolves.length, resolveCount, "a transient seek error must not re-resolve or switch providers");
  const backward = await seek(20);
  await waitPlaying(20.3);
  console.log(`✓ real HLS forward seek with two 503s (${forward.seekLatencyMs}ms), backward seek (${backward.seekLatencyMs}ms)`);

  // The first destination request never returns. The 8s watchdog should retry
  // the same HLS session once, at the seek target, without waiting 60s for XHR.
  hangingSegment = { filename: "segment-50.ts", count: 0, gate: gate() };
  const hung = await seek(100.25);
  hangingSegment.gate.resolve();
  await waitPlaying(100.5);
  assert(hangingSegment.count >= 2, "a hung seek must retry the destination segment");
  assert(hung.seekLatencyMs < 15_000, "do not wait through the entire fragment timeout budget");
  assert.equal(resolves.length, resolveCount, "a recovered seek keeps its provider");
  console.log(`✓ hung destination recovered in place (${hung.seekLatencyMs}ms)`);

  await seek(24);
  await page.locator("#playerVideo").evaluate(video => video.pause());
  const pausedAt = (await state()).time;
  const bManifest = gate();
  manifestGates.set("b", bManifest);
  await choose("b");
  await page.waitForFunction(() => document.querySelector("#playerVideo").readyState === 0);
  await choose("c");
  await waitSelected("c");
  await page.waitForFunction(() => !document.querySelector("#playerVideo").seeking);
  bManifest.resolve();
  await delay(250);
  const afterRapid = await state();
  assert(afterRapid.paused, "rapid switches preserve the confirmed paused state");
  assert(afterRapid.frames > 0 && afterRapid.width > 0, "the paused replacement must decode a frame");
  assert(Math.abs(afterRapid.time - pausedAt) < 1.1, `lost position across rapid switch: ${JSON.stringify(afterRapid)}`);
  const cSegments = requests.filter(request => request.name === "c" && request.filename.endsWith(".ts"));
  assert(Number(cSegments[0].filename.match(/segment-(\d+)/)[1]) >= 11, "replacement should load at the saved position, not zero");
  console.log("✓ rapid A → B → C while B attaches preserves position and pause; skips opening segments");

  await page.evaluate(() => window.__STREAMARENA_PLAYBACK_BENCHMARK__.play());
  const bResolve = gate();
  resolveGates.set("b", bResolve);
  await choose("b");
  await delay(2200);
  const beforeHandoff = (await state()).time;
  bResolve.resolve();
  await waitSelected("b");
  await waitPlaying(beforeHandoff - 1);
  assert((await state()).time >= beforeHandoff - 1, "slow resolve must not rewind the current stream");
  console.log("✓ slow provider resolution keeps playback moving and hands off at the current position");

  const beforeFailure = (await state()).time;
  await choose("d");
  await waitSelected("b");
  await waitPlaying(beforeFailure - 1);
  assert.equal(await page.locator(`.source-option[data-source-hash="${hashes.b}"]`).getAttribute("aria-pressed"), "true");
  assert.deepEqual(errors, [], "no stale play promises or media callback errors");
  console.log("✓ failed provider restores the confirmed stream with decoded frames and no page errors");

  // Delay the health check from B's error until C is already playing. The old
  // callback must not demote the new selection or start another resolve.
  healthGate = gate();
  const healthBefore = healthRequests;
  await page.locator("#playerVideo").evaluate(video => video.dispatchEvent(new Event("error")));
  for (let index = 0; healthRequests === healthBefore && index < 30; index++) await delay(20);
  assert(healthRequests > healthBefore);
  await choose("c");
  await waitSelected("c");
  const resolvesAfterC = resolves.length;
  healthGate.resolve();
  await delay(300);
  assert.equal(resolves.length, resolvesAfterC, "old health check must not replace C");
  await waitSelected("c");
  console.log("✓ late health response cannot undo a newer provider selection");

  // An automatic fallback is resolving while the viewer seeks and pauses the
  // old stream. Replacement playback must honor those latest user actions.
  const aResolve = gate();
  resolveGates.set("a", aResolve);
  const resolvesBeforeRecovery = resolves.length;
  await page.locator("#playerVideo").evaluate(video => video.dispatchEvent(new Event("error")));
  for (let index = 0; resolves.length === resolvesBeforeRecovery && index < 100; index++) await delay(20);
  assert.equal(resolves.at(-1), "a");
  await seek(130);
  await page.locator("#playerVideo").evaluate(video => video.pause());
  const latestSeek = (await state()).time;
  aResolve.resolve();
  await waitSelected("a");
  await page.waitForFunction(() => !document.querySelector("#playerVideo").seeking);
  const afterRecovery = await state();
  assert(afterRecovery.paused, "automatic fallback must preserve the latest pause");
  assert(Math.abs(afterRecovery.time - latestSeek) < 1, `fallback lost newer seek: ${JSON.stringify(afterRecovery)}`);
  assert(afterRecovery.frames > 0 && afterRecovery.width > 0);
  assert.deepEqual(errors, []);
  console.log("✓ automatic fallback preserves a newer seek and pause with a decoded replacement frame");
} finally {
  for (const pending of gates) pending.resolve();
  await browser?.close();
  server.kill("SIGTERM");
  await rm(media, { recursive: true, force: true });
}

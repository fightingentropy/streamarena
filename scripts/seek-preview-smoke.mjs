#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const root = resolve(new URL("..", import.meta.url).pathname);
const baseUrl = `http://127.0.0.1:${process.env.SEEK_PREVIEW_TEST_PORT || 4189}`;
const mediaDir = await mkdtemp(join(tmpdir(), "streamarena-seek-preview-"));
const clip = join(mediaDir, "clip.mp4");
execFileSync("ffmpeg", [
  "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24",
  "-t", "20", "-c:v", "libx264", "-preset", "ultrafast", "-g", "48",
  "-pix_fmt", "yuv420p", "-movflags", "+faststart", clip,
]);
execFileSync("ffmpeg", [
  "-v", "error", "-i", clip, "-c", "copy", "-hls_time", "2",
  "-hls_list_size", "0", "-hls_segment_filename", join(mediaDir, "segment-%d.ts"),
  join(mediaDir, "low.m3u8"),
]);
await writeFile(join(mediaDir, "master.m3u8"), [
  "#EXTM3U",
  '#EXT-X-STREAM-INF:BANDWIDTH=250000,RESOLUTION=320x180,CODECS="avc1.42c00c"',
  "low.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.42c00c"',
  "high.m3u8",
  "",
].join("\n"));

// Exercise the production interaction module and stylesheet with real decoded
// MP4/HLS frames, while holding media responses to reproduce a slow provider.
const fixture = `<!doctype html><html><head><link rel="stylesheet" href="/player.css">
<style>body{background:#171717}#seekBar{position:absolute;left:40px;top:300px;width:800px}
#seekPreview{bottom:auto;top:180px}#main{width:320px;height:180px}</style></head><body>
<video id="main" muted autoplay src="/seek-preview-media/clip.mp4?main"></video>
<input id="seekBar" type="range"><div id="seekPreview" class="seek-preview" hidden>
<canvas id="seekPreviewCanvas" class="seek-preview-thumb" width="160" height="90" hidden></canvas>
<span id="seekPreviewTime" class="seek-preview-time"></span></div>
<script type="module">
import { attachSeekInteractions } from '/src-ui/player/seek-interactions.js';
const byId = id => document.getElementById(id);
window.previewSource = new URLSearchParams(location.search).get('hls')
  ? location.origin + '/seek-preview-media/master.m3u8' : '';
window.previewInteractions = attachSeekInteractions({
  clampLiveSeekTargetSeconds: time => time, clearPendingSeekRatios() {},
  formatTime: time => '00:' + String(Math.floor(time)).padStart(2, '0'),
  getBufferedSeekValue: () => 0,
  getLastRequestedAbsolutePlaybackSource: () => window.previewSource,
  getLastRequestedPlaybackSource: () => window.previewSource,
  getLiveSeekableWindow: () => null, getPendingStandardSeekRatio: () => null,
  getPendingTranscodeSeekRatio: () => null, getSeekRatioFromPointerEvent: () => 0,
  getSeekScaleDurationSeconds: () => 20,
  getSeekTargetSecondsFromRatio: (ratio, duration) => ratio * duration,
  hasActiveSource: () => true, isDraggingSeek: () => false,
  isHlsPlaybackSource: source => source.includes('.m3u8'), isLivePlayback: () => false,
  isResolvingSource: () => false, isTranscodeSourceActive: () => false,
  paintSeekProgress() {}, parseLiveIframePlaybackSource: () => null,
  seekBar: byId('seekBar'), seekPreview: byId('seekPreview'),
  seekPreviewCanvas: byId('seekPreviewCanvas'), seekPreviewTime: byId('seekPreviewTime'),
  seekToAbsoluteTime() {}, setDraggingSeek() {}, setPendingSeekRatio() {},
  shouldUseHlsJsForSource: () => true, syncDurationText() {},
  trackListener: (element, name, listener) => element.addEventListener(name, listener),
  video: byId('main'),
});
window.blankFrames = 0;
function inspectFrame() {
  const canvas = byId('seekPreviewCanvas');
  if (!byId('seekPreview').hidden && !canvas.hidden) {
    const pixels = canvas.getContext('2d').getImageData(0, 0, 160, 90).data;
    if (!pixels.some((value, index) => index % 4 !== 3 && value > 20)) window.blankFrames++;
  }
  requestAnimationFrame(inspectFrame);
}
inspectFrame();
</script></body></html>`;

const server = spawn(join(root, "node_modules/.bin/vite"), [
  "--host", "127.0.0.1", "--port", new URL(baseUrl).port, "--strictPort",
], { cwd: root, stdio: "pipe" });
let serverOutput = "";
server.stdout.on("data", chunk => { serverOutput += chunk; });
server.stderr.on("data", chunk => { serverOutput += chunk; });
let browser;
try {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error(serverOutput);
    try { if ((await fetch(baseUrl)).ok) break; } catch {}
    if (attempt === 79) throw new Error(`Vite did not start: ${serverOutput}`);
    await delay(100);
  }
  browser = await chromium.launch({ headless: true });
  for (const hls of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 960, height: 600 } });
    const page = await context.newPage();
    await page.clock.install();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const requests = [];
    let gate = Promise.withResolvers();
    await page.route("**/seek-preview-fixture*", route => route.fulfill({ contentType: "text/html", body: fixture }));
    await page.route("**/seek-preview-media/**", async route => {
      const url = new URL(route.request().url());
      const filename = url.pathname.split("/").at(-1);
      // The main video has its own URL so its decoding never waits for a preview.
      if (!url.searchParams.has("main")) {
        requests.push(filename);
        await gate.promise;
      } else if (route.request().resourceType() === "media") {
        // Native previews use the same source; distinguish the already-started
        // main request from subsequent requests for the preview video.
        requests.push(filename);
        if (requests.length > 1) await gate.promise;
      }
      const body = await readFile(join(mediaDir, filename));
      const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || "");
      const contentType = filename.endsWith(".m3u8") ? "application/vnd.apple.mpegurl"
        : filename.endsWith(".ts") ? "video/mp2t" : "video/mp4";
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
        return route.fulfill({ status: 206, contentType, body: body.subarray(start, end + 1),
          headers: { "Content-Range": `bytes ${start}-${end}/${body.length}`, "Accept-Ranges": "bytes" } });
      }
      await route.fulfill({ contentType, body });
    });
    await page.goto(`${baseUrl}/seek-preview-fixture?hls=${hls ? "1" : ""}`);
    await page.waitForFunction(() => window.previewInteractions && document.querySelector('#main').currentTime > 0);
    const hover = async ratio => {
      const box = await page.locator('#seekBar').boundingBox();
      await page.mouse.move(box.x + box.width * ratio, box.y + box.height / 2);
    };
    const frame = () => page.locator('#seekPreviewCanvas').evaluate(canvas => canvas.toDataURL());
    await hover(0.4);
    await page.waitForFunction(() => document.querySelector('.seek-preview-video-probe'));
    assert.equal(await page.locator('#seekPreview').isVisible(), true, "timestamp should appear immediately");
    assert.equal(await page.locator('#seekPreviewTime').textContent(), "00:08");
    assert.equal(await page.locator('#seekPreviewCanvas').isVisible(), false, "no empty black thumbnail while decoding");
    await delay(250);
    gate.resolve();
    await page.waitForFunction(() => !document.querySelector('#seekPreviewCanvas').hidden);
    const firstFrame = await frame();
    const firstTime = await page.locator('.seek-preview-video-probe').evaluate(video => video.currentTime);
    assert(Math.abs(firstTime - 8) < 0.25, `decoded the wrong preview time: ${firstTime}`);
    if (hls) {
      const firstSegment = requests.find(name => name.endsWith('.ts'));
      assert(Number(firstSegment.match(/segment-(\d+)/)[1]) >= 3, "HLS must start near the hovered time, not at zero");
      assert(!requests.includes('high.m3u8'), "160px thumbnails should not fetch the HD rendition");
    }
    gate = Promise.withResolvers();
    // Check synchronously after requesting another time, before its decoder can
    // deliver an event. The existing thumbnail must never be cleared to black.
    const duringSeek = await page.locator('#seekBar').evaluate(bar => {
      const box = bar.getBoundingClientRect();
      bar.dispatchEvent(new PointerEvent('pointermove', { clientX: box.x + box.width * 0.8 }));
      const canvas = document.querySelector('#seekPreviewCanvas');
      return { hidden: canvas.hidden, frame: canvas.toDataURL() };
    });
    assert.equal(duringSeek.hidden, false);
    assert.equal(duringSeek.frame, firstFrame, "retain the last decoded frame while fetching another");
    gate.resolve();
    await page.waitForFunction(() => {
      const video = document.querySelector('.seek-preview-video-probe');
      return !video.seeking && Math.abs(video.currentTime - 16) < 0.25 && video.readyState >= 2;
    });
    await page.waitForFunction(first => document.querySelector('#seekPreviewCanvas').toDataURL() !== first, firstFrame);
    await page.evaluate(() => { window.retainedPreview = document.querySelector('.seek-preview-video-probe'); });
    await page.mouse.move(5, 5);
    await delay(100);
    const beforeReturn = requests.length;
    await hover(0.8);
    assert(await page.evaluate(() => window.retainedPreview === document.querySelector('.seek-preview-video-probe')),
      "briefly leaving the timeline must not recreate the preview player");
    assert.equal(await page.locator('#seekPreviewCanvas').isVisible(), true);
    await delay(250);
    assert.equal(requests.length, beforeReturn, "returning to the decoded time must not refetch media");
    assert.equal(await page.evaluate(() => window.blankFrames), 0, "a visible preview must always contain decoded pixels");
    assert(await page.locator('#main').evaluate(video => video.currentTime > 0 && !video.paused), "preview must not interrupt playback");
    await page.mouse.move(5, 5);
    await page.clock.fastForward(15_100);
    assert.equal(await page.locator('.seek-preview-video-probe').count(), 0, "release the idle decoder");
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`Seek preview smoke passed: ${hls ? "HLS" : "MP4"}, delayed loading, retargeting, rehover, idle cleanup`);
  }
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await rm(mediaDir, { recursive: true, force: true });
}

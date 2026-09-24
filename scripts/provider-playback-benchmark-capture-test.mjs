#!/usr/bin/env node
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { prepareVerifiedVideoCapture } from "./provider-playback-benchmark.mjs";

// Offline browser fixture: no provider requests, real decoding from a canvas
// stream, and a CSP that reproduces the production stylesheet rejection.
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'none\'; media-src blob:"><main><video controls muted></video><div id="controls">Fixture title and controls</div></main>');
  await page.evaluate(async () => {
    const video = document.querySelector("video");
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    setInterval(() => {
      context.fillStyle = "#456789";
      context.fillRect(0, 0, 64, 64);
    }, 30);
    video.srcObject = canvas.captureStream(30);
    await video.play();
  });
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return video.readyState >= 3 && video.currentTime > 0.1;
  });
  const stylesheetBlocked = await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = "body * { visibility:hidden !important; }";
    document.head.append(style);
    return getComputedStyle(document.querySelector("#controls")).visibility === "visible";
  });
  assert.equal(stylesheetBlocked, true, "Fixture must reproduce the CSP rejection");
  const proof = await page.evaluate(prepareVerifiedVideoCapture);
  assert.equal(proof.verified, true);
  assert.equal(proof.mediaStatePreserved, true);
  assert.equal(proof.nativeControlsHidden, true);
  assert.equal(proof.paused, true);
  assert.equal(await page.locator("#controls").isVisible(), false);
  assert.equal(await page.locator("video").isVisible(), true);
  assert.equal(await page.locator("video").evaluate((video) => video.videoWidth), 64);
  console.log("Provider benchmark CSP capture test passed.");
} finally {
  await browser.close();
}

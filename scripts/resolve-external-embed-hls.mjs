#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "playwright";

const embedUrl = String(process.argv[2] || "").trim();
const timeoutMs = Number(process.env.EXTERNAL_EMBED_HLS_RESOLVE_TIMEOUT_MS || 18000);
const rawProxy = String(
  process.env.EXTERNAL_EMBED_BROWSER_PROXY || process.env.OUTBOUND_HTTP_PROXY || "",
).trim();

function normalizeProxyServer(value) {
  if (!value) return "";
  return value.replace(/^socks5h:\/\//i, "socks5://");
}

function isSupportedEmbedUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      ((host === "player.videasy.net" &&
        (url.pathname.startsWith("/movie/") || url.pathname.startsWith("/tv/"))) ||
        ((host === "vidking.net" || host === "www.vidking.net") &&
          (url.pathname.startsWith("/embed/movie/") ||
            url.pathname.startsWith("/embed/tv/"))))
    );
  } catch {
    return false;
  }
}

function isAllowedRequestUrl(value) {
  if (value.startsWith("blob:")) return true;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      host === "videasy.net" ||
      host.endsWith(".videasy.net") ||
      host === "vidking.net" ||
      host === "www.vidking.net" ||
      host === "easy.speedsterwave.app"
    );
  } catch {
    return false;
  }
}

function isStreamPlaylistUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.hostname.toLowerCase() === "easy.speedsterwave.app" &&
      url.pathname.toLowerCase().endsWith(".m3u8")
    );
  } catch {
    return false;
  }
}

function normalizeReferer(value, fallback) {
  try {
    const url = new URL(value || fallback);
    url.hash = "";
    return url.toString();
  } catch {
    return fallback;
  }
}

if (!isSupportedEmbedUrl(embedUrl)) {
  console.error("Usage: resolve-external-embed-hls.mjs https://player.videasy.net/... | https://www.vidking.net/embed/...");
  process.exit(2);
}

let browser;
let resolvedUrl = "";
let playerPageUrl = embedUrl;

try {
  const proxyServer = normalizeProxyServer(rawProxy);
  browser = await chromium.launch({
    headless: true,
    proxy: proxyServer ? { server: proxyServer } : undefined,
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });

  page.on("popup", async (popup) => {
    await popup.close().catch(() => {});
  });

  await page.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    if (isStreamPlaylistUrl(requestUrl)) {
      resolvedUrl = requestUrl;
      await route.abort("blockedbyclient");
      return;
    }
    const resourceType = route.request().resourceType();
    if (
      resourceType === "image" ||
      resourceType === "font" ||
      (resourceType === "media" && !isStreamPlaylistUrl(requestUrl))
    ) {
      await route.abort("blockedbyclient");
      return;
    }
    if (isAllowedRequestUrl(requestUrl)) {
      await route.continue();
      return;
    }
    await route.abort("blockedbyclient");
  });

  page.on("request", (request) => {
    const requestUrl = request.url();
    if (!resolvedUrl && isStreamPlaylistUrl(requestUrl)) {
      resolvedUrl = requestUrl;
    }
  });

  page.on("response", (response) => {
    const responseUrl = response.url();
    if (!resolvedUrl && response.status() < 400 && isStreamPlaylistUrl(responseUrl)) {
      resolvedUrl = responseUrl;
    }
  });

  await page.goto(embedUrl, {
    waitUntil: "domcontentloaded",
    timeout: Math.max(5000, Math.min(timeoutMs, 30000)),
  });
  playerPageUrl = normalizeReferer(page.url(), embedUrl);

  const deadline = Date.now() + timeoutMs;
  let clicked = false;
  while (!resolvedUrl && Date.now() < deadline) {
    if (!clicked && Date.now() + 2500 < deadline) {
      await delay(2500);
      if (!resolvedUrl) {
        clicked = true;
        await page.mouse.click(640, 360).catch(() => {});
      }
      continue;
    }
    await delay(250);
  }

  if (!resolvedUrl) {
    console.error("Timed out waiting for external embed HLS playlist.");
    process.exit(1);
  }

  console.log(JSON.stringify({ playbackUrl: resolvedUrl, referer: playerPageUrl }));
} catch (error) {
  console.error(error?.message || String(error));
  process.exit(1);
} finally {
  if (browser) {
    await browser.close().catch(() => {});
  }
}

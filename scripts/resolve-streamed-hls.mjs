#!/usr/bin/env node
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    const fallbackDirs = [
      process.env.PLAYWRIGHT_NODE_MODULES,
      process.env.NETFLIX_NODE_DEPS_DIR,
      process.env.HOME ? join(process.env.HOME, ".local/share/netflix-node") : "",
    ].filter(Boolean);

    for (const dir of fallbackDirs) {
      const normalizedDir = String(dir).replace(/\/+$/, "");
      const nodeModulesDir = normalizedDir.endsWith("/node_modules")
        ? normalizedDir
        : join(normalizedDir, "node_modules");
      try {
        return await import(
          pathToFileURL(join(nodeModulesDir, "playwright", "index.mjs")).href
        );
      } catch {
        // Try the next configured module directory.
      }
    }
    throw error;
  }
}

const { chromium } = await loadPlaywright();

const embedUrl = String(process.argv[2] || "").trim();
const timeoutMs = Number(process.env.STREAMED_HLS_RESOLVE_TIMEOUT_MS || 18000);
const rawProxy =
  String(
    process.env.STREAMED_EMBED_BROWSER_PROXY ||
      process.env.SPORTS_HTTP_PROXY ||
      process.env.OUTBOUND_HTTP_PROXY ||
      "",
  )
    .trim();

function normalizeProxyServer(value) {
  if (!value) return "";
  return value.replace(/^socks5h:\/\//i, "socks5://");
}

function isSupportedEmbedUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "embedsports.top" || url.hostname === "www.embedsports.top") &&
      url.pathname.startsWith("/embed/")
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
      host === "embedsports.top" ||
      host === "www.embedsports.top" ||
      host === "cdn.jsdelivr.net" ||
      host.endsWith(".jsdelivr.net") ||
      host === "strmd.top" ||
      host.endsWith(".strmd.top")
    );
  } catch {
    return false;
  }
}

function isStreamPlaylistUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      (host === "strmd.top" || host.endsWith(".strmd.top")) &&
      url.pathname.toLowerCase().endsWith(".m3u8")
    );
  } catch {
    return false;
  }
}

if (!isSupportedEmbedUrl(embedUrl)) {
  console.error("Usage: resolve-streamed-hls.mjs https://embedsports.top/embed/...");
  process.exit(2);
}

let browser;
let resolvedUrl = "";

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

  await page.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    if (isStreamPlaylistUrl(requestUrl)) {
      resolvedUrl = requestUrl;
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
    console.error("Timed out waiting for Streamed HLS playlist.");
    process.exit(1);
  }

  console.log(JSON.stringify({ playbackUrl: resolvedUrl }));
} catch (error) {
  console.error(error?.message || String(error));
  process.exit(1);
} finally {
  if (browser) {
    await browser.close().catch(() => {});
  }
}

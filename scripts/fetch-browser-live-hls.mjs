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
      process.env.STREAMARENA_NODE_DEPS_DIR,
      process.env.HOME ? join(process.env.HOME, ".local/share/streamarena-node") : "",
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

const targetUrl = String(process.argv[2] || "").trim();
const refererUrl = String(process.argv[3] || "").trim();
const timeoutMs = Number(process.env.BROWSER_LIVE_HLS_FETCH_TIMEOUT_MS || 22000);
const rawProxy = String(
  process.env.BROWSER_LIVE_HLS_PROXY ||
    process.env.NTVS_EMBED_BROWSER_PROXY ||
    process.env.SPORTS_HTTP_PROXY ||
    process.env.OUTBOUND_HTTP_PROXY ||
    "",
).trim();

function normalizeProxyServer(value) {
  if (!value) return "";
  return value.replace(/^socks5h:\/\//i, "socks5://");
}

function isFetchableHlsUrl(value) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.pathname.toLowerCase().endsWith(".m3u8")
    );
  } catch {
    return false;
  }
}

function isAllowedRefererUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isAllowedBrowserFetchUrl(value) {
  if (value.startsWith("blob:")) return true;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      host === "embed.st" ||
      host === "www.embed.st" ||
      host === "strmd.st" ||
      host.endsWith(".strmd.st") ||
      host === "strmd.top" ||
      host.endsWith(".strmd.top")
    );
  } catch {
    return false;
  }
}

if (!isFetchableHlsUrl(targetUrl) || !isAllowedRefererUrl(refererUrl)) {
  console.error(
    "Usage: fetch-browser-live-hls.mjs https://cdn.example.com/playlist.m3u8 https://embed.st/embed/...",
  );
  process.exit(2);
}

const { chromium } = await loadPlaywright();
let browser;

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
    if (isAllowedBrowserFetchUrl(requestUrl)) {
      await route.continue();
      return;
    }
    await route.abort("blockedbyclient");
  });

  page.on("popup", (popup) => {
    popup.close().catch(() => {});
  });

  await page.goto(refererUrl, {
    waitUntil: "domcontentloaded",
    timeout: Math.max(5000, Math.min(timeoutMs, 30000)),
  });
  await delay(1200);

  const payload = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      credentials: "omit",
      mode: "cors",
    });
    const body = await response.text();
    return {
      status: response.status,
      finalUrl: response.url,
      body,
    };
  }, targetUrl);

  if (!payload || payload.status < 200 || payload.status >= 300) {
    const status = payload?.status || 0;
    console.error(`Browser live HLS fetch failed with status ${status}.`);
    process.exit(1);
  }

  if (!String(payload.body || "").trimStart().startsWith("#EXTM3U")) {
    console.error("Browser live HLS fetch did not return an HLS playlist.");
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      finalUrl: payload.finalUrl || targetUrl,
      body: payload.body,
    }),
  );
} catch (error) {
  console.error(error?.message || String(error));
  process.exit(1);
} finally {
  if (browser) {
    await browser.close().catch(() => {});
  }
}

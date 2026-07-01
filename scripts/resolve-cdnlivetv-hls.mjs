#!/usr/bin/env node
// Resolve a cdnlivetv channel player page to its tokenized HLS playlist.
//
// cdnlivetv.tv (the upstream behind streamsports99) serves each channel through a
// minimal player page at /api/v1/channels/player/?name=<channel>&code=<code>&… .
// That page computes a short-lived `secure/api/v1/<channelId>/playlist.m3u8?token=`
// URL in JS (atob + fetch), so the token can't be forged server-side; we run the
// page in a headless browser (through the sports proxy) and capture the playlist
// request it makes. The playlist + its `/stream-segment/` segments are then plain
// curl-fetchable (no browser binding), so the Rust live-HLS proxy serves them via
// the normal path with a `Referer: https://cdnlivetv.tv/` header.
//
// Emits {"playbackUrl": "https://cdnlivetv.tv/secure/.../playlist.m3u8?token=…"}.
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

const { chromium } = await loadPlaywright();

const playerUrl = String(process.argv[2] || "").trim();
const timeoutMs = Number(process.env.CDNLIVETV_HLS_RESOLVE_TIMEOUT_MS || 18000);
const rawProxy = String(
  process.env.CDNLIVETV_BROWSER_PROXY ||
    process.env.SPORTS_HTTP_PROXY ||
    process.env.OUTBOUND_HTTP_PROXY ||
    "",
).trim();

function normalizeProxyServer(value) {
  if (!value) return "";
  return value.replace(/^socks5h:\/\//i, "socks5://");
}

function isCdnlivetvHost(host) {
  const h = String(host || "").toLowerCase();
  return (
    h === "cdnlivetv.tv" ||
    h.endsWith(".cdnlivetv.tv") ||
    h === "cdn-live.tv" ||
    h.endsWith(".cdn-live.tv")
  );
}

function isSupportedPlayerUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      isCdnlivetvHost(url.hostname) &&
      url.pathname.startsWith("/api/v1/channels/player")
    );
  } catch {
    return false;
  }
}

function isStreamPlaylistUrl(value) {
  try {
    const url = new URL(value);
    return (
      isCdnlivetvHost(url.hostname) &&
      url.pathname.toLowerCase().includes("/secure/") &&
      url.pathname.toLowerCase().endsWith(".m3u8")
    );
  } catch {
    return false;
  }
}

if (!isSupportedPlayerUrl(playerUrl)) {
  console.error(
    "Usage: resolve-cdnlivetv-hls.mjs https://cdnlivetv.tv/api/v1/channels/player/?name=...",
  );
  process.exit(2);
}

let browser;
let resolvedUrl = "";
let rejectedPlaylist = "";
let rejectedPlaylistStatus = 0;

function rememberResolvedPlaylist(value, status) {
  if (resolvedUrl || !isStreamPlaylistUrl(value)) return;
  if (status >= 200 && status < 300) {
    resolvedUrl = value;
    return;
  }
  rejectedPlaylist = value;
  rejectedPlaylistStatus = status;
}

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

  page.on("response", (response) => {
    rememberResolvedPlaylist(response.url(), response.status());
  });

  await page.goto(playerUrl, {
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
    const rejectedDetail =
      rejectedPlaylist && rejectedPlaylistStatus
        ? ` Last playlist response was HTTP ${rejectedPlaylistStatus}: ${rejectedPlaylist}`
        : "";
    console.error(`Timed out waiting for a cdnlivetv HLS playlist.${rejectedDetail}`);
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

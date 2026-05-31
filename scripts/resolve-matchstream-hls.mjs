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

const sourceUrl = String(process.argv[2] || "").trim();
const timeoutMs = Number(process.env.MATCHSTREAM_HLS_RESOLVE_TIMEOUT_MS || 18000);
const rawProxy = String(
  process.env.MATCHSTREAM_BROWSER_PROXY ||
    process.env.SPORTS_HTTP_PROXY ||
    process.env.OUTBOUND_HTTP_PROXY ||
    "",
).trim();

const channelHosts = new Set(["glisco.link", "evfancy.link", "strongst.link", "l2l2.link"]);
const brightcoreHosts = new Set(["brightcoremind.com", "www.brightcoremind.com"]);
const helplessHosts = new Set(["helpless.click", "www.helpless.click"]);
const hlsRootHosts = ["zohanayaan.com", "28585519.net"];

function normalizeProxyServer(value) {
  if (!value) return "";
  return value.replace(/^socks5h:\/\//i, "socks5://");
}

function hostMatches(host, allowed) {
  return host === allowed || host.endsWith(`.${allowed}`);
}

function isSupportedChannelUrl(value) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      channelHosts.has(url.hostname.toLowerCase()) &&
      url.pathname.replace(/^\/+/, "") === "ch" &&
      Boolean(url.searchParams.get("id")?.trim())
    );
  } catch {
    return false;
  }
}

function isSupportedPlayerUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      ((brightcoreHosts.has(host) &&
        (url.pathname === "/embedb.php" || url.pathname === "/embedw.php")) ||
        (helplessHosts.has(host) && url.pathname.startsWith("/e/"))) &&
      (url.protocol === "https:" || url.protocol === "http:")
    );
  } catch {
    return false;
  }
}

function isMatchstreamHlsHost(host) {
  return hlsRootHosts.some((allowed) => hostMatches(host, allowed));
}

function isStreamPlaylistUrl(value) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      isMatchstreamHlsHost(url.hostname.toLowerCase()) &&
      url.pathname.toLowerCase().endsWith(".m3u8")
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
      channelHosts.has(host) ||
      brightcoreHosts.has(host) ||
      helplessHosts.has(host) ||
      host === "cdn.jsdelivr.net" ||
      host.endsWith(".jsdelivr.net") ||
      host === "ajax.googleapis.com" ||
      host === "maxcdn.bootstrapcdn.com" ||
      host === "code.jquery.com" ||
      isMatchstreamHlsHost(host)
    );
  } catch {
    return false;
  }
}

if (!isSupportedChannelUrl(sourceUrl)) {
  console.error("Usage: resolve-matchstream-hls.mjs https://evfancy.link/ch?id=...");
  process.exit(2);
}

let browser;
let resolvedUrl = "";
let playerPageUrl = "";

function rememberPlayerPage(value) {
  if (value && isSupportedPlayerUrl(value)) {
    playerPageUrl = value;
  }
}

function rememberPlaylist(value, frameUrl = "") {
  if (!resolvedUrl && isStreamPlaylistUrl(value)) {
    resolvedUrl = value;
    rememberPlayerPage(frameUrl);
  }
}

try {
  const proxyServer = normalizeProxyServer(rawProxy);
  const channelId = new URL(sourceUrl).searchParams.get("id") || "";
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
    const request = route.request();
    const requestUrl = request.url();
    if (isStreamPlaylistUrl(requestUrl)) {
      rememberPlaylist(requestUrl, request.frame()?.url() || "");
      await route.abort("blockedbyclient");
      return;
    }
    if (isAllowedRequestUrl(requestUrl)) {
      await route.continue();
      return;
    }
    await route.abort("blockedbyclient");
  });

  page.on("framenavigated", (frame) => rememberPlayerPage(frame.url()));

  page.on("request", (request) => {
    rememberPlaylist(request.url(), request.frame()?.url() || "");
  });

  page.on("response", (response) => {
    if (response.status() < 400) {
      rememberPlaylist(response.url(), response.request().frame()?.url() || "");
    }
  });

  await page.goto(sourceUrl, {
    waitUntil: "domcontentloaded",
    timeout: Math.max(5000, Math.min(timeoutMs, 30000)),
  });

  await page
    .evaluate((id) => {
      if (id && typeof window.loadPlayerChannel === "function") {
        window.loadPlayerChannel(id);
      }
    }, channelId)
    .catch(() => {});

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
    console.error("Timed out waiting for MatchStream HLS playlist.");
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      playbackUrl: resolvedUrl,
      playerPage: playerPageUrl || sourceUrl,
      referer: playerPageUrl || sourceUrl,
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

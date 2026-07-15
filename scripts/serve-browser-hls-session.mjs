#!/usr/bin/env node
// Keep the minimal embed.st browser context alive and relay session-bound HLS
// playlists through a loopback-only HTTP endpoint. The browser never loads the
// provider UI: it serves a blank same-origin stub, runs lock.js/WASM, and keeps
// the exact context that minted the strmd.* token.
//
// stdout emits one JSON line as soon as the relay is ready:
//   { playbackUrl, playerPage, referer, relayUrl }
// The process then remains alive while playlists are being requested. A small
// registry file lets later resolves for the same embed reuse the existing
// context instead of starting another Chromium process.

import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      const normalized = String(dir).replace(/\/+$/, "");
      const nodeModulesDir = normalized.endsWith("/node_modules")
        ? normalized
        : join(normalized, "node_modules");
      try {
        return await import(pathToFileURL(join(nodeModulesDir, "playwright", "index.mjs")).href);
      } catch {
        // Try the next configured module directory.
      }
    }
    throw error;
  }
}

const embedUrl = String(process.argv[2] || "").trim();
const resolveTimeoutMs = Math.max(
  5_000,
  Math.min(Number(process.env.EMBED_MIN_RESOLVE_TIMEOUT_MS || 15_000), 30_000),
);
const idleTimeoutMs = Math.max(
  30_000,
  Number(process.env.BROWSER_HLS_SESSION_IDLE_TIMEOUT_MS || 120_000),
);
const maxLifetimeMs = Math.max(
  idleTimeoutMs,
  Number(process.env.BROWSER_HLS_SESSION_MAX_LIFETIME_MS || 6 * 60 * 60_000),
);
const rawProxy = String(
  process.env.NTVS_EMBED_BROWSER_PROXY ||
    process.env.SPORTS_HTTP_PROXY ||
    process.env.OUTBOUND_HTTP_PROXY ||
    "",
).trim();

let embed;
try {
  embed = new URL(embedUrl);
} catch {
  console.error("Usage: serve-browser-hls-session.mjs https://embed.st/embed/<server>/<slug>/<num>");
  process.exit(2);
}
const embedHost = embed.hostname.toLowerCase();
if (!(/(^|\.)embed\.st$/.test(embedHost) && embed.pathname.startsWith("/embed/"))) {
  console.error("Unsupported embed URL.");
  process.exit(2);
}
const parts = embed.pathname.replace(/^\/embed\//, "").split("/").filter(Boolean);
if (parts.length < 3) {
  console.error("Could not parse server/slug/num from embed path.");
  process.exit(2);
}
const serverName = parts[0];
const streamNumber = parts.at(-1);
const slug = parts.slice(1, -1).join("/");
const sessionKey = createHash("sha256").update(embedUrl).digest("hex").slice(0, 32);
const registryPath = join(
  tmpdir(),
  `streamarena-browser-hls-${typeof process.getuid === "function" ? process.getuid() : "user"}-${sessionKey}.json`,
);

function isLoopbackRelayUrl(value) {
  try {
    const url = new URL(value);
    const token = url.searchParams.get("token") || "";
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      Boolean(url.port) &&
      url.pathname === "/fetch" &&
      /^[a-f0-9]{64}$/.test(token)
    );
  } catch {
    return false;
  }
}

function isAllowedPlaylistUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      (host === "strmd.st" || host.endsWith(".strmd.st")) &&
      url.pathname.toLowerCase().endsWith(".m3u8")
    );
  } catch {
    return false;
  }
}

async function reuseExistingSession() {
  let payload;
  try {
    payload = JSON.parse(await fs.readFile(registryPath, "utf8"));
  } catch {
    return false;
  }
  if (
    payload?.playerPage !== embedUrl ||
    !isAllowedPlaylistUrl(payload?.playbackUrl) ||
    !isLoopbackRelayUrl(payload?.relayUrl)
  ) {
    return false;
  }
  try {
    const healthUrl = new URL(payload.relayUrl);
    healthUrl.pathname = "/health";
    healthUrl.searchParams.delete("url");
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_500) });
    const health = response.ok ? await response.json() : null;
    if (health?.playerPage !== embedUrl || !isAllowedPlaylistUrl(health?.playbackUrl)) {
      return false;
    }
    console.log(
      JSON.stringify({
        playbackUrl: health.playbackUrl,
        playerPage: embedUrl,
        referer: embedUrl,
        relayUrl: payload.relayUrl,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

if (await reuseExistingSession()) {
  process.exit(0);
}

const { chromium } = await loadPlaywright();
const proxyServer = rawProxy ? rawProxy.replace(/^socks5h:\/\//i, "socks5://") : "";
const browser = await chromium.launch({
  headless: true,
  proxy: proxyServer ? { server: proxyServer } : undefined,
});
let context = await browser.newContext();
let page = await context.newPage();
let playbackUrl = "";
const playlistCache = new Map();

function isAllowedFullPageRequest(value) {
  if (value.startsWith("blob:")) return true;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      host === "embed.st" ||
      host === "www.embed.st" ||
      host === "cdn.jsdelivr.net" ||
      host.endsWith(".jsdelivr.net") ||
      host === "llvpn.com" ||
      host === "www.llvpn.com" ||
      host === "strmd.st" ||
      host.endsWith(".strmd.st")
    );
  } catch {
    return false;
  }
}

async function rememberPlaylistResponse(response) {
  const responseUrl = response.url();
  if (!isAllowedPlaylistUrl(responseUrl) || response.status() < 200 || response.status() >= 300) {
    return;
  }
  try {
    const body = await response.text();
    if (!body.trimStart().startsWith("#EXTM3U")) return;
    const entry = {
      status: response.status(),
      finalUrl: responseUrl,
      contentType: response.headers()["content-type"] || "application/vnd.apple.mpegurl",
      body,
      storedAt: Date.now(),
    };
    playlistCache.set(responseUrl, entry);
    // Prefer the already-selected media playlist over a master ladder. It
    // removes another session-bound child request from the client path.
    if (body.includes("#EXTINF") || !playbackUrl) playbackUrl = responseUrl;
  } catch {
    // A later response or explicit relay fetch can populate the cache.
  }
}

await page.route(embedUrl, (route) =>
  route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><html><body><div id="player" style="width:1280px;height:720px"></div></body></html>',
  }),
);
page.on("request", (request) => {
  const requestUrl = request.url();
  if (!playbackUrl && isAllowedPlaylistUrl(requestUrl)) playbackUrl = requestUrl;
});
page.on("response", (response) => void rememberPlaylistResponse(response));

const minimalAttemptTimeoutMs = Math.min(resolveTimeoutMs, 5_000);
for (let attempt = 1; attempt <= 1 && !playbackUrl; attempt += 1) {
  try {
    await page.goto(embedUrl, {
      waitUntil: "domcontentloaded",
      timeout: minimalAttemptTimeoutMs,
    });
    const captured = await page.evaluate(
      async ({ serverName, slug, streamNumber, resolveTimeoutMs }) => {
      let found = "";
      const originalFetch = window.fetch;
      window.fetch = function (input) {
        const value = String((input && input.url) || input);
        if (!found && value.includes("strmd.st") && /\.m3u8/i.test(value)) {
          found = value;
        }
        return originalFetch.apply(this, arguments);
      };
      let mod;
      try {
        mod = await import("/js/wasm/lock.js");
      } catch (error) {
        return { error: `import: ${error?.message || error}` };
      }
      try {
        const initialized = mod.default();
        if (initialized?.then) await initialized;
      } catch (error) {
        return { error: `init: ${error?.message || error}` };
      }
      try { mod.init_wasm(); } catch {}
      try { mod.init_wasm(serverName, slug, streamNumber); } catch {}
      try {
        const result = mod.set_stream(serverName, slug, streamNumber);
        if (result?.then) await result;
      } catch {
        // Expected: player setup fails after the playlist request is emitted.
      }
      const deadline = Date.now() + resolveTimeoutMs;
      while (!found && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { url: found };
      },
      { serverName, slug, streamNumber, resolveTimeoutMs: minimalAttemptTimeoutMs },
    );
    if (!playbackUrl && captured?.url) playbackUrl = captured.url;
    if (!playbackUrl && captured?.error) console.error(captured.error);
  } catch (error) {
    console.error(error?.message || String(error));
  }
}

async function fetchPlaylist(targetUrl) {
  if (!isAllowedPlaylistUrl(targetUrl)) {
    return { status: 400, finalUrl: targetUrl, contentType: "text/plain", body: "Unsupported URL." };
  }
  const cached = playlistCache.get(targetUrl);
  if (cached && (cached.body.includes("#EXT-X-ENDLIST") || Date.now() - cached.storedAt < 8_000)) {
    return cached;
  }
  try {
    const browserResult = await page.evaluate(async (target) => {
      try {
        const response = await fetch(target, {
          cache: "no-store",
          credentials: "include",
        });
        return {
          status: response.status,
          finalUrl: response.url || target,
          contentType: response.headers.get("content-type") || "application/vnd.apple.mpegurl",
          body: await response.text(),
        };
      } catch (error) {
        return {
          status: 502,
          finalUrl: target,
          contentType: "text/plain",
          body: error?.message || String(error),
        };
      }
    }, targetUrl);
    if (browserResult.status >= 200 && browserResult.status < 300) {
      playlistCache.set(targetUrl, { ...browserResult, storedAt: Date.now() });
      return browserResult;
    }
  } catch {
    // Fall through to Playwright's request client, which shares this browser
    // context's cookies but is not constrained by page-level CORS.
  }
  try {
    const response = await context.request.get(targetUrl, {
      failOnStatusCode: false,
      headers: {
        Accept: "application/vnd.apple.mpegurl, application/x-mpegURL, */*",
        Referer: embedUrl,
      },
      timeout: 15_000,
    });
    const result = {
      status: response.status(),
      finalUrl: response.url() || targetUrl,
      contentType: response.headers()["content-type"] || "application/vnd.apple.mpegurl",
      body: await response.text(),
    };
    if (result.status >= 200 && result.status < 300) {
      playlistCache.set(targetUrl, { ...result, storedAt: Date.now() });
      return result;
    }
    return cached || result;
  } catch (error) {
    return cached || {
      status: 502,
      finalUrl: targetUrl,
      contentType: "text/plain",
      body: error?.message || String(error),
    };
  }
}

let initialPlaylist =
  playbackUrl && isAllowedPlaylistUrl(playbackUrl)
    ? await fetchPlaylist(playbackUrl)
    : { status: 502, finalUrl: "", contentType: "text/plain", body: "No minimal playlist." };
if (
  initialPlaylist.status < 200 ||
  initialPlaylist.status >= 300 ||
  !initialPlaylist.body.trimStart().startsWith("#EXTM3U")
) {
  // The WASM-only fast path can mint a URL before embed.st has established the
  // page state needed to use it. Fall back inside the same hidden Chromium to
  // the real player page, while blocking every unrelated host and popup. Unlike
  // the old one-shot resolver this context remains alive for HLS polling.
  await context.close().catch(() => {});
  context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  page = await context.newPage();
  playbackUrl = "";
  playlistCache.clear();
  await page.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    if (isAllowedPlaylistUrl(requestUrl) || isAllowedFullPageRequest(requestUrl)) {
      await route.continue();
    } else {
      await route.abort("blockedbyclient");
    }
  });
  page.on("popup", (popup) => popup.close().catch(() => {}));
  page.on("response", (response) => void rememberPlaylistResponse(response));
  try {
    const fullPageTimeoutMs = Math.min(resolveTimeoutMs, 18_000);
    await page.goto(embedUrl, {
      waitUntil: "domcontentloaded",
      timeout: fullPageTimeoutMs,
    });
    const deadline = Date.now() + fullPageTimeoutMs;
    let clicked = false;
    while (Date.now() < deadline) {
      const selected = playbackUrl ? playlistCache.get(playbackUrl) : null;
      if (selected?.body.includes("#EXTINF")) break;
      if (!clicked && Date.now() + 2_500 < deadline) {
        clicked = true;
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        await page.mouse.click(640, 360).catch(() => {});
      } else {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  } catch (error) {
    console.error(error?.message || String(error));
  }
  if (playbackUrl) initialPlaylist = await fetchPlaylist(playbackUrl);
}
if (initialPlaylist.status < 200 || initialPlaylist.status >= 300 || !initialPlaylist.body.trimStart().startsWith("#EXTM3U")) {
  await browser.close().catch(() => {});
  console.error(
    `Session-bound playlist fetch failed with status ${initialPlaylist.status}: ${String(initialPlaylist.body || "").slice(0, 180)}`,
  );
  process.exit(1);
}

const token = randomBytes(32).toString("hex");
let lastActivityAt = Date.now();
let relayUrl = "";
let closing = false;
const httpServer = createServer(async (request, response) => {
  const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
  if (requestUrl.searchParams.get("token") !== token) {
    response.writeHead(404).end();
    return;
  }
  lastActivityAt = Date.now();
  if (request.method === "GET" && requestUrl.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ playbackUrl, playerPage: embedUrl }));
    return;
  }
  if (request.method !== "GET" || requestUrl.pathname !== "/fetch") {
    response.writeHead(404).end();
    return;
  }
  const targetUrl = requestUrl.searchParams.get("url") || "";
  const fetched = await fetchPlaylist(targetUrl);
  response.writeHead(fetched.status, {
    "content-type": fetched.contentType,
    "cache-control": "no-store",
    "x-streamarena-final-url": fetched.finalUrl,
  });
  response.end(fetched.body);
});

await new Promise((resolve, reject) => {
  httpServer.once("error", reject);
  httpServer.listen(0, "127.0.0.1", resolve);
});
const address = httpServer.address();
relayUrl = `http://127.0.0.1:${address.port}/fetch?token=${token}`;
const readyPayload = {
  playbackUrl,
  playerPage: embedUrl,
  referer: embedUrl,
  relayUrl,
};
const registryTemp = `${registryPath}.${process.pid}.tmp`;
await fs.writeFile(registryTemp, JSON.stringify(readyPayload), { mode: 0o600 });
await fs.rename(registryTemp, registryPath);
console.log(JSON.stringify(readyPayload));

async function closeSession(exitCode = 0) {
  if (closing) return;
  closing = true;
  clearInterval(idleTimer);
  clearTimeout(lifetimeTimer);
  await new Promise((resolve) => httpServer.close(resolve)).catch(() => {});
  await browser.close().catch(() => {});
  try {
    const current = JSON.parse(await fs.readFile(registryPath, "utf8"));
    if (current?.relayUrl === relayUrl) await fs.unlink(registryPath);
  } catch {
    // Another process may have replaced or already removed the registry.
  }
  process.exit(exitCode);
}

const idleTimer = setInterval(() => {
  if (Date.now() - lastActivityAt >= idleTimeoutMs) void closeSession(0);
}, Math.min(15_000, Math.max(5_000, Math.floor(idleTimeoutMs / 4))));
const lifetimeTimer = setTimeout(() => void closeSession(0), maxLifetimeMs);
process.on("SIGINT", () => void closeSession(0));
process.on("SIGTERM", () => void closeSession(0));

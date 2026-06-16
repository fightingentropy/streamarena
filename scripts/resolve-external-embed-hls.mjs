#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

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

async function loadSodium() {
  try {
    return await import("libsodium-wrappers");
  } catch (error) {
    const fallbackDirs = [
      process.env.STREAMARENA_NODE_DEPS_DIR,
      process.env.PLAYWRIGHT_NODE_MODULES,
      process.env.HOME ? join(process.env.HOME, ".local/share/streamarena-node") : "",
    ].filter(Boolean);

    for (const dir of fallbackDirs) {
      const normalizedDir = String(dir).replace(/\/+$/, "");
      const nodeModulesDir = normalizedDir.endsWith("/node_modules")
        ? normalizedDir
        : join(normalizedDir, "node_modules");
      try {
        return await import(
          pathToFileURL(
            join(
              nodeModulesDir,
              "libsodium-wrappers",
              "dist",
              "modules-esm",
              "libsodium-wrappers.mjs",
            ),
          ).href
        );
      } catch {
        // Try the next configured module directory.
      }
    }
    throw error;
  }
}

const embedUrl = String(process.argv[2] || "").trim();
const timeoutMs = Number(process.env.EXTERNAL_EMBED_HLS_RESOLVE_TIMEOUT_MS || 30000);
const requestedServer = normalizeExternalEmbedServer(process.env.EXTERNAL_EMBED_SERVER || "");
const rawProxy = String(
  process.env.EXTERNAL_EMBED_BROWSER_PROXY || process.env.OUTBOUND_HTTP_PROXY || "",
).trim();
const backendPlaylistUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36";
const videasyFavoriteProviderKey = "videasy-favorite-provider";
const vidlinkAssetCacheDir = join(tmpdir(), "streamarena-vidlink-native");
const configuredVidlinkAssetCacheTtlMs = Number(
  process.env.VIDLINK_NATIVE_ASSET_CACHE_TTL_MS || 2 * 60 * 60 * 1000,
);
const vidlinkAssetCacheTtlMs = Number.isFinite(configuredVidlinkAssetCacheTtlMs)
  ? Math.max(0, configuredVidlinkAssetCacheTtlMs)
  : 2 * 60 * 60 * 1000;
const videasyServerNames = new Set([
  "NEON",
  "YORU",
  "CYPHER",
  "SAGE",
  "BREACH",
  "VYSE",
  "RAZE",
]);

function normalizeExternalEmbedServer(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-z0-9_-]/gi, "")
    .toUpperCase();
}

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
      (((host === "player.videasy.net" || host === "player.videasy.to") &&
        (url.pathname.startsWith("/movie/") || url.pathname.startsWith("/tv/"))) ||
        (host === "vidlink.pro" &&
          (url.pathname.startsWith("/movie/") || url.pathname.startsWith("/tv/"))))
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
      host === "videasy.to" ||
      host.endsWith(".videasy.to") ||
      host === "vidlink.pro" ||
      host === "storm.vodvidl.site" ||
      host === "easy.speedsterwave.app" ||
      host === "easy.nightspeedster.app" ||
      host === "hello.mousedoor.com" ||
      host === "yoru.midwesteagle.com" ||
      host === "typhoontigertribe.net"
    );
  } catch {
    return false;
  }
}

function isStreamPlaylistUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      isPublicHlsHostname(url.hostname) &&
      url.pathname.toLowerCase().endsWith(".m3u8")
    );
  } catch {
    return false;
  }
}

function isPublicHlsHostname(value) {
  const host = String(value || "").trim().replace(/\.$/, "").toLowerCase();
  if (
    !host ||
    host.includes(":") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    isIpv4Hostname(host)
  ) {
    return false;
  }
  return (
    host.includes(".") &&
    !host.startsWith(".") &&
    !host.endsWith(".") &&
    !host.includes("..") &&
    /^[a-z0-9.-]+$/.test(host)
  );
}

function isIpv4Hostname(host) {
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  );
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

function videasyProviderForEmbedUrl(value) {
  if (!requestedServer || !videasyServerNames.has(requestedServer)) {
    return "";
  }
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return host === "player.videasy.net" || host === "player.videasy.to"
      ? requestedServer
      : "";
  } catch {
    return "";
  }
}

function parseVidlinkEmbedUrl(value) {
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "vidlink.pro") {
      return null;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "movie" && parts[1]) {
      return { mediaType: "movie", tmdbId: parts[1], season: "", episode: "" };
    }
    if (parts[0] === "tv" && parts[1] && parts[2] && parts[3]) {
      return { mediaType: "tv", tmdbId: parts[1], season: parts[2], episode: parts[3] };
    }
    return null;
  } catch {
    return null;
  }
}

async function waitForVidlinkToken(page, tmdbId) {
  await page
    .waitForFunction(() => typeof window.getAdv === "function", {
      timeout: Math.max(1000, Math.min(timeoutMs, 10000)),
    })
    .catch(() => {});
  return page
    .evaluate((id) => {
      if (typeof window.getAdv !== "function") return "";
      return String(window.getAdv(String(id)) || "");
    }, tmdbId)
    .catch(() => "");
}

async function fetchTextWithTimeout(value, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1000, Math.min(timeoutMs, 10000)),
  );
  try {
    const response = await fetch(value, {
      redirect: "follow",
      signal: controller.signal,
      headers,
    });
    if (!response.ok) {
      return "";
    }
    return await response.text();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBytesWithTimeout(value, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1000, Math.min(timeoutMs, 10000)),
  );
  try {
    const response = await fetch(value, {
      redirect: "follow",
      signal: controller.signal,
      headers,
    });
    if (!response.ok) {
      return null;
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readFreshCachedAsset(path, maxAgeMs) {
  if (maxAgeMs <= 0) {
    return null;
  }
  try {
    const info = await stat(path);
    if (Date.now() - info.mtimeMs > maxAgeMs) {
      return null;
    }
    return await readFile(path);
  } catch {
    return null;
  }
}

async function readVidlinkTextAsset(name, url) {
  const cachePath = join(vidlinkAssetCacheDir, name);
  const cached = await readFreshCachedAsset(cachePath, vidlinkAssetCacheTtlMs);
  if (cached) {
    return cached.toString("utf8");
  }

  const value = await fetchTextWithTimeout(url, {
    "User-Agent": backendPlaylistUserAgent,
    Accept: "application/javascript, text/javascript, */*",
    "Accept-Language": "en-US,en;q=0.9",
  });
  if (value) {
    await mkdir(vidlinkAssetCacheDir, { recursive: true }).catch(() => {});
    await writeFile(cachePath, value).catch(() => {});
  }
  return value;
}

async function readVidlinkBinaryAsset(name, url) {
  const cachePath = join(vidlinkAssetCacheDir, name);
  const cached = await readFreshCachedAsset(cachePath, vidlinkAssetCacheTtlMs);
  if (cached) {
    return new Uint8Array(cached);
  }

  const value = await fetchBytesWithTimeout(url, {
    "User-Agent": backendPlaylistUserAgent,
    Accept: "application/wasm, */*",
    "Accept-Language": "en-US,en;q=0.9",
  });
  if (value) {
    await mkdir(vidlinkAssetCacheDir, { recursive: true }).catch(() => {});
    await writeFile(cachePath, value).catch(() => {});
  }
  return value;
}

async function createVidlinkNativeTokenGenerator() {
  const sodiumModule = await loadSodium();
  const sodium = sodiumModule.default || sodiumModule;
  await sodium.ready;

  globalThis.window = globalThis;
  globalThis.sodium = sodium;

  const [runtimeScript, wasmBytes] = await Promise.all([
    readVidlinkTextAsset("script.js", "https://vidlink.pro/script.js"),
    readVidlinkBinaryAsset("fu.wasm", "https://vidlink.pro/fu.wasm"),
  ]);
  if (!runtimeScript || !wasmBytes) {
    throw new Error("VidLink native token assets could not be loaded.");
  }

  vm.runInThisContext(runtimeScript, { filename: "vidlink-script.js" });
  if (typeof globalThis.Dm !== "function") {
    throw new Error("VidLink native token runtime did not load.");
  }

  const go = new globalThis.Dm();
  const { instance } = await WebAssembly.instantiate(wasmBytes, go.importObject);
  go.run(instance).catch(() => {});

  const deadline = Date.now() + Math.max(1000, Math.min(timeoutMs, 10000));
  while (typeof globalThis.getAdv !== "function" && Date.now() < deadline) {
    await delay(20);
  }
  if (typeof globalThis.getAdv !== "function") {
    throw new Error("VidLink native token generator did not initialize.");
  }

  return (tmdbId) => String(globalThis.getAdv(String(tmdbId)) || "");
}

async function fetchVidlinkStreamInfo(apiUrl, referer) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1000, Math.min(timeoutMs, 10000)),
  );
  try {
    const response = await fetch(apiUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": backendPlaylistUserAgent,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: referer,
      },
    });
    if (!response.ok) {
      return null;
    }
    return JSON.parse(await response.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveVidlinkPlaylistNative() {
  const vidlink = parseVidlinkEmbedUrl(embedUrl);
  if (!vidlink) {
    return "";
  }

  const generateToken = await createVidlinkNativeTokenGenerator();
  const token = generateToken(vidlink.tmdbId);
  return fetchVidlinkPlaylistWithToken(vidlink, token);
}

async function fetchVidlinkPlaylistWithToken(vidlink, token) {
  if (!token) {
    return "";
  }

  const apiUrl =
    vidlink.mediaType === "tv"
      ? `https://vidlink.pro/api/b/tv/${encodeURIComponent(token)}/${encodeURIComponent(
          vidlink.season,
        )}/${encodeURIComponent(vidlink.episode)}?multiLang=0`
      : `https://vidlink.pro/api/b/movie/${encodeURIComponent(token)}?multiLang=0`;
  const streamInfo = await fetchVidlinkStreamInfo(apiUrl, embedUrl);
  const playlist = String(streamInfo?.stream?.playlist || "").trim();
  return isStreamPlaylistUrl(playlist) ? playlist : "";
}

async function resolveVidlinkPlaylistFromApi(page) {
  const vidlink = parseVidlinkEmbedUrl(embedUrl);
  if (!vidlink) {
    return "";
  }

  const token = await waitForVidlinkToken(page, vidlink.tmdbId);
  if (!token) {
    return "";
  }

  return fetchVidlinkPlaylistWithToken(vidlink, token);
}

function attachPlaylistWatchers(page, onResolved) {
  page.on("response", async (response) => {
    const responseUrl = response.url();
    if (resolvedUrl || response.status() >= 400 || !isStreamPlaylistUrl(responseUrl)) {
      return;
    }
    const playlist = await response.text().catch(() => "");
    if (playlist.trimStart().startsWith("#EXTM3U")) {
      onResolved(responseUrl);
    }
  });
}

async function resolvePlaylistFromPerformanceEntries(_page) {
  return "";
}

async function captureResolvedPlaylistFromPage(page) {
  if (resolvedUrl) return;
  const performanceUrl = await resolvePlaylistFromPerformanceEntries(page);
  if (performanceUrl) {
    resolvedUrl = performanceUrl;
  }
}

async function activateEmbeddedPlayer(page) {
  await page.mouse.click(640, 360).catch(() => {});
  await page
    .evaluate(() => {
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || 1) > 0
        );
      };
      const labelFor = (element) =>
        [
          element.textContent,
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
          element.getAttribute("class"),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
      const controls = Array.from(
        document.querySelectorAll("button,[role='button'],video"),
      ).filter(isVisible);
      const control =
        controls.find((element) =>
          /\b(play|watch|start|continue|resume)\b/.test(labelFor(element)),
        ) ||
        controls.find((element) => element.tagName.toLowerCase() === "video") ||
        null;
      control?.click?.();
      const video = document.querySelector("video");
      if (video && typeof video.play === "function") {
        video.play().catch(() => {});
      }
    })
    .catch(() => {});
}

async function validateBackendFetchablePlaylist(value, referer) {
  if (!isStreamPlaylistUrl(value)) {
    return "";
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1000, Math.min(timeoutMs, 10000)),
  );
  try {
    const response = await fetch(value, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": backendPlaylistUserAgent,
        Accept: "application/vnd.apple.mpegurl, application/x-mpegURL, */*",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: referer,
      },
    });
    if (!response.ok || !isStreamPlaylistUrl(response.url)) {
      return "";
    }
    const playlist = await response.text();
    return playlist.trimStart().startsWith("#EXTM3U") ? response.url : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function resolveWithPlaywrightBrowser() {
  const { chromium } = await loadPlaywright();
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
  const videasyProvider = videasyProviderForEmbedUrl(embedUrl);
  if (videasyProvider) {
    await page.addInitScript(
      ({ key, value }) => {
        localStorage.setItem(key, value);
      },
      { key: videasyFavoriteProviderKey, value: videasyProvider },
    );
  }

  page.on("popup", async (popup) => {
    await popup.close().catch(() => {});
  });

  await page.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    if (isStreamPlaylistUrl(requestUrl)) {
      await route.continue();
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

  attachPlaylistWatchers(page, (url) => {
    if (!resolvedUrl) resolvedUrl = url;
  });

  const response = await page.goto(embedUrl, {
    waitUntil: "domcontentloaded",
    timeout: Math.max(5000, Math.min(timeoutMs, 30000)),
  });
  if (response?.status?.() === 403) {
    throw new Error("External embed page was blocked by the provider.");
  }
  playerPageUrl = normalizeReferer(page.url(), embedUrl);

  if (!resolvedUrl) {
    const apiPlaylist = await resolveVidlinkPlaylistFromApi(page);
    if (apiPlaylist) {
      resolvedUrl = apiPlaylist;
    }
  }

  const deadline = Date.now() + timeoutMs;
  let activationAttempts = 0;
  let nextActivationAt = Date.now() + 2500;
  while (!resolvedUrl && Date.now() < deadline) {
    await captureResolvedPlaylistFromPage(page);
    if (resolvedUrl) break;
    const now = Date.now();
    if (
      activationAttempts < 5 &&
      now >= nextActivationAt &&
      now + 750 < deadline
    ) {
      activationAttempts += 1;
      await activateEmbeddedPlayer(page);
      nextActivationAt = Date.now() + 3000;
      continue;
    }
    await delay(250);
  }
}

if (!isSupportedEmbedUrl(embedUrl)) {
  console.error(
    "Usage: resolve-external-embed-hls.mjs https://player.videasy.to/... | https://player.videasy.net/... | https://vidlink.pro/...",
  );
  process.exit(2);
}

let browser;
let resolvedUrl = "";
let playerPageUrl = embedUrl;

try {
  if (parseVidlinkEmbedUrl(embedUrl)) {
    resolvedUrl = await resolveVidlinkPlaylistNative().catch(() => "");
  }

  if (!resolvedUrl) {
    await resolveWithPlaywrightBrowser();
  }

  if (!resolvedUrl) {
    console.error("Timed out waiting for external embed HLS playlist.");
    process.exit(1);
  }

  const referer = normalizeReferer(playerPageUrl, embedUrl);
  const playbackUrl = await validateBackendFetchablePlaylist(resolvedUrl, referer);
  if (!playbackUrl) {
    console.error("Resolved HLS playlist is not fetchable by the backend.");
    process.exit(1);
  }

  console.log(JSON.stringify({ playbackUrl, referer }));
} catch (error) {
  console.error(error?.message || String(error));
  process.exit(1);
} finally {
  if (browser) {
    await browser.close().catch(() => {});
  }
}

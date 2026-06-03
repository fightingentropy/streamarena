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
const timeoutMs = Number(process.env.EXTERNAL_EMBED_HLS_RESOLVE_TIMEOUT_MS || 30000);
const requestedServer = normalizeExternalEmbedServer(process.env.EXTERNAL_EMBED_SERVER || "");
const rawProxy = String(
  process.env.EXTERNAL_EMBED_BROWSER_PROXY || process.env.OUTBOUND_HTTP_PROXY || "",
).trim();
const videasyFavoriteProviderKey = "videasy-favorite-provider";
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
      ((host === "player.videasy.net" &&
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
    return url.hostname.toLowerCase() === "player.videasy.net" ? requestedServer : "";
  } catch {
    return "";
  }
}

function attachPlaylistWatchers(page, onResolved) {
  page.on("request", (request) => {
    const requestUrl = request.url();
    if (isStreamPlaylistUrl(requestUrl)) {
      onResolved(requestUrl);
    }
  });

  page.on("response", (response) => {
    const responseUrl = response.url();
    if (response.status() < 400 && isStreamPlaylistUrl(responseUrl)) {
      onResolved(responseUrl);
    }
  });
}

async function resolvePlaylistFromPerformanceEntries(page) {
  const resourceUrls = await page
    .evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter(Boolean),
    )
    .catch(() => []);
  return resourceUrls.find((url) => isStreamPlaylistUrl(url)) || "";
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

async function resolveWithPlaywrightBrowser() {
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
    "Usage: resolve-external-embed-hls.mjs https://player.videasy.net/... | https://vidlink.pro/...",
  );
  process.exit(2);
}

let browser;
let resolvedUrl = "";
let playerPageUrl = embedUrl;

try {
  await resolveWithPlaywrightBrowser();

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

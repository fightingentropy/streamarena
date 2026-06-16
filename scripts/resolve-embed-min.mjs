#!/usr/bin/env node
// Minimal-browser resolver for embed.st / embedsports.top live sources.
//
// Instead of loading the full embed page (bundle-jw.js / Clappr / SwarmCloud /
// ads, then clicking and waiting), this loads a stub page on the same origin,
// imports the site's own `lock.js`, and drives the WASM directly with the
// resolve recipe:  init -> init_wasm() -> set_stream(server, slug, num).
// `set_stream` POSTs `<origin>/fetch` (protobuf {1:server,2:slug,3:num}), the
// WASM decodes the reply and fetches the `strmd.*` playlist URL — which we
// capture. set_stream then throws on player-setup (after the URL is out); we
// ignore it. Robust to their JS-bundle rotations since it runs their real WASM.
//
// Output (stdout JSON, matching resolve-ntvs-hls.mjs):
//   {"playbackUrl": "...", "playerPage": "...", "referer": "..."}
//
// Usage: resolve-embed-min.mjs https://embed.st/embed/<server>/<slug>/<num>
import { setTimeout as delay } from "node:timers/promises";
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
const timeoutMs = Number(process.env.EMBED_MIN_RESOLVE_TIMEOUT_MS || 15000);
const rawProxy = String(
  process.env.NTVS_EMBED_BROWSER_PROXY ||
    process.env.STREAMED_EMBED_BROWSER_PROXY ||
    process.env.SPORTS_HTTP_PROXY ||
    process.env.OUTBOUND_HTTP_PROXY ||
    "",
).trim();

let url;
try {
  url = new URL(embedUrl);
} catch {
  console.error("Usage: resolve-embed-min.mjs https://embed.st/embed/<server>/<slug>/<num>");
  process.exit(2);
}
const host = url.hostname.toLowerCase();
if (!(/(^|\.)(embed\.st|embedsports\.top)$/.test(host) && url.pathname.startsWith("/embed/"))) {
  console.error("Unsupported embed URL.");
  process.exit(2);
}
const parts = url.pathname.replace(/^\/embed\//, "").split("/").filter(Boolean);
if (parts.length < 3) {
  console.error("Could not parse server/slug/num from embed path.");
  process.exit(2);
}
const server = parts[0];
const num = parts[parts.length - 1];
const slug = parts.slice(1, -1).join("/");
const strmdHost = host.endsWith("embedsports.top") ? "strmd.top" : "strmd.st";

const { chromium } = await loadPlaywright();
const proxyServer = rawProxy ? rawProxy.replace(/^socks5h:\/\//i, "socks5://") : "";
const browser = await chromium.launch({
  headless: true,
  proxy: proxyServer ? { server: proxyServer } : undefined,
});

let playbackUrl = "";
try {
  const page = await browser.newPage();
  // Serve a bare stub for the embed page so only lock.js runs (no JWPlayer/ads).
  await page.route(embedUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><head></head><body><div id="player" style="width:1280px;height:720px"></div></body></html>',
    }),
  );
  page.on("request", (request) => {
    const requestUrl = request.url();
    if (!playbackUrl && requestUrl.includes(strmdHost) && /\.m3u8/i.test(requestUrl)) {
      playbackUrl = requestUrl;
    }
  });

  await page.goto(embedUrl, {
    waitUntil: "domcontentloaded",
    timeout: Math.max(5000, Math.min(timeoutMs, 30000)),
  });

  const captured = await page.evaluate(
    async ({ server, slug, num, strmdHost, timeoutMs }) => {
      let found = "";
      const originalFetch = window.fetch;
      window.fetch = function (input) {
        const u = String((input && input.url) || input);
        if (!found && u.includes(strmdHost) && /\.m3u8/i.test(u)) found = u;
        return originalFetch.apply(this, arguments);
      };
      let mod;
      try {
        mod = await import("/js/wasm/lock.js");
      } catch (error) {
        return { error: "import: " + (error && error.message) };
      }
      try {
        const r = mod.default();
        if (r && r.then) await r;
      } catch (error) {
        return { error: "init: " + (error && error.message) };
      }
      try { mod.init_wasm(); } catch {}
      try { mod.init_wasm(server, slug, num); } catch {}
      try {
        const r = mod.set_stream(server, slug, num);
        if (r && r.then) await r;
      } catch {
        // set_stream throws on player setup AFTER emitting the URL — expected.
      }
      const deadline = Date.now() + Math.min(timeoutMs, 15000);
      while (!found && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return { url: found };
    },
    { server, slug, num, strmdHost, timeoutMs },
  );

  if (!playbackUrl && captured && captured.url) playbackUrl = captured.url;
  if (!playbackUrl && captured && captured.error) console.error("evaluate: " + captured.error);
} catch (error) {
  console.error(error && error.message ? error.message : String(error));
} finally {
  await browser.close().catch(() => {});
}

await delay(0);
if (playbackUrl) {
  console.log(JSON.stringify({ playbackUrl, playerPage: embedUrl, referer: embedUrl }));
  process.exit(0);
}
console.error("Timed out waiting for a strmd HLS playlist.");
process.exit(1);

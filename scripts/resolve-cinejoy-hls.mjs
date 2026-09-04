#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { loadPlaywright } from "./lib/load-playwright.mjs";
import {
  CINEJOY_SERVERS, isCinejoyPlaylistUrl, isCinejoySupportRequest,
  isCinejoyWatchUrl, selectCinejoyServer,
} from "./lib/cinejoy-policy.mjs";

// Let the site's own player negotiate its current API protocol. No copied keys,
// expiring playlist constants, third-party decrypt service, or media downloads.
// Filter its public server list to one requested server so automatic fallback
// cannot silently return a different source under the pinned source's identity.
export async function resolveCinejoy(watchUrl, server = "LISBON", timeoutMs = 30000, loadBrowser = loadPlaywright) {
  if (!isCinejoyWatchUrl(watchUrl) || !Object.hasOwn(CINEJOY_SERVERS, server)) {
    throw new Error("Invalid CineJoy source selection.");
  }
  if (!Number.isFinite(timeoutMs)) throw new Error("Invalid resolver timeout.");
  timeoutMs = Math.max(1000, Math.min(timeoutMs, 120000));
  const { chromium } = await loadBrowser();
  const proxy = String(process.env.EXTERNAL_EMBED_BROWSER_PROXY || process.env.OUTBOUND_HTTP_PROXY || "")
    .trim().replace(/^socks5h:\/\//i, "socks5://");
  const browser = await chromium.launch({ headless: true, timeout: timeoutMs,
    proxy: proxy ? { server: proxy } : undefined });
  let timer;
  try {
    const page = await browser.newPage({ serviceWorkers: "block" });
    const result = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("CineJoy source resolution timed out.")), timeoutMs);
      page.on("popup", popup => void popup.close().catch(() => {}));
      void page.route("**/*", async route => {
        try {
          const request = route.request();
          const url = request.url();
          if (isCinejoyPlaylistUrl(url, server)) {
            // Capture before fetching: the backend validates the manifest with
            // its own egress, then StreamArena's native HLS player handles media.
            resolve({ playbackUrl: url, referer: "https://cinejoy.to/" });
            await route.abort("blockedbyclient");
          } else if (url === "https://api.shegu.st/servers") {
            const response = await route.fetch({ timeout: timeoutMs, maxRedirects: 0 });
            if (!response.ok()) throw new Error("CineJoy server discovery failed.");
            const selected = selectCinejoyServer(await response.json(), server);
            await route.fulfill({ response, json: selected });
          } else if (isCinejoySupportRequest(url, request.resourceType(), request.method())) {
            await route.continue();
          } else {
            await route.abort("blockedbyclient");
          }
        } catch {
          reject(new Error("CineJoy source discovery failed."));
          await route.abort("blockedbyclient").catch(() => {});
        }
      }).then(() => page.goto(watchUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs }))
        .catch(() => reject(new Error("CineJoy player could not load.")));
    });
    return await result;
  } finally {
    clearTimeout(timer);
    await browser.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (!isCinejoyWatchUrl(process.argv[2])) {
    console.error("Usage: resolve-cinejoy-hls.mjs https://cinejoy.to/watch/movie/<id> | https://cinejoy.to/watch/tv/<id>/<season>/<episode>");
    process.exit(2);
  }
  try {
    const result = await resolveCinejoy(process.argv[2],
      String(process.env.EXTERNAL_EMBED_SERVER || "LISBON").trim().toUpperCase(),
      Number(process.env.EXTERNAL_EMBED_HLS_RESOLVE_TIMEOUT_MS || 30000));
    console.log(JSON.stringify(result));
  } catch {
    // Upstream errors may contain signed URLs; never write them to server logs.
    console.error("CineJoy could not resolve the selected native HLS source.");
    process.exitCode = 1;
  }
}

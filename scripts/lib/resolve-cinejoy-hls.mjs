import { CinejoyAssetCache } from "./cinejoy-asset-cache.mjs";
import { loadPlaywright } from "./load-playwright.mjs";
import {
  CINEJOY_SERVERS, isCinejoyPlaylistUrl, isCinejoySupportRequest,
  isCinejoyWatchUrl, selectCinejoyServer,
} from "./cinejoy-policy.mjs";

// Let the site's own player negotiate its current API protocol. No copied keys,
// expiring playlist constants, third-party decrypt service, or media downloads.
// Filter its public server list to one requested server so automatic fallback
// cannot silently return a different source under the pinned source's identity.
async function resolveInBrowser(browser, watchUrl, server, timeoutMs, assets) {
  if (!isCinejoyWatchUrl(watchUrl) || !Object.hasOwn(CINEJOY_SERVERS, server)) {
    throw new Error("Invalid CineJoy source selection.");
  }
  if (!Number.isFinite(timeoutMs)) throw new Error("Invalid resolver timeout.");
  timeoutMs = Math.max(1, Math.min(timeoutMs, 120000));
  let timer;
  let context;
  let finished = false;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { finished = true; reject(new Error("CineJoy source resolution timed out.")); }, timeoutMs);
  });
  const discover = async () => {
    context = await browser.newContext({ serviceWorkers: "block" });
    if (finished) { await context.close(); throw new Error("CineJoy resolution ended."); }
    const page = await context.newPage();
    if (finished) throw new Error("CineJoy resolution ended.");
    if (assets) page.on("response", response => {
      const request = response.request();
      if (response.status() !== 200 || !assets.accepts(response.url(), request.method())) return;
      if (assets.get(response.url())) return;
      const headers = response.headers();
      if (Number(headers["content-length"] || Infinity) > 512 * 1024) return;
      void response.body().then(body => assets.put(response.url(), headers, body)).catch(() => {});
    });
    const result = new Promise((resolve, reject) => {
      page.on("popup", popup => void popup.close().catch(() => {}));
      void page.route("**/*", async route => {
        try {
          const request = route.request();
          const url = request.url();
          if (isCinejoyPlaylistUrl(url, server)) {
            // Capture before fetching: the backend validates the manifest with
            // its own egress, then StreamArena's native HLS player handles media.
            resolve({ playbackUrl: url, referer: "https://cinejoy.pk/" });
            await route.abort("blockedbyclient");
          } else if (url === "https://api.wing.st/servers") {
            const response = await route.fetch({ timeout: timeoutMs, maxRedirects: 0 });
            if (!response.ok()) throw new Error("CineJoy server discovery failed.");
            const selected = selectCinejoyServer(await response.json(), server);
            await route.fulfill({ response, json: selected });
          } else if (isCinejoySupportRequest(url, request.resourceType(), request.method())) {
            const cached = assets?.accepts(url, request.method()) ? assets.get(url) : null;
            if (cached) await route.fulfill({ status: 200, headers: cached.headers, body: cached.body });
            else await route.continue();
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
    return result;
  };
  try {
    return await Promise.race([discover(), deadline]);
  } finally {
    finished = true;
    clearTimeout(timer);
    await context?.close().catch(() => {});
  }
}

function browserProxy() {
  return String(process.env.EXTERNAL_EMBED_BROWSER_PROXY || process.env.OUTBOUND_HTTP_PROXY || "")
    .trim().replace(/^socks5h:\/\//i, "socks5://");
}

// A private worker owns one browser, but every resolve gets a new context:
// cookies/storage, service workers and the selected server never leak across
// requests. The worker protocol serializes use; Rust bounds the pool to two.
export class CinejoyResolver {
  constructor(loadBrowser = loadPlaywright) {
    this.loadBrowser = loadBrowser;
    this.browser = null;
    this.assets = new CinejoyAssetCache();
    this.busy = false;
    this.closed = false;
  }
  async resolve(watchUrl, server = "LISBON", timeoutMs = 30000) {
    if (this.closed || this.busy) throw new Error("CineJoy resolver is unavailable.");
    if (!isCinejoyWatchUrl(watchUrl) || !Object.hasOwn(CINEJOY_SERVERS, server) || !Number.isFinite(timeoutMs)) {
      throw new Error("Invalid CineJoy source selection.");
    }
    this.busy = true;
    timeoutMs = Math.max(1000, Math.min(timeoutMs, 120000));
    const deadline = Date.now() + timeoutMs;
    try {
      if (!this.browser?.isConnected()) {
        const { chromium } = await this.loadBrowser();
        const proxy = browserProxy();
        const browser = await chromium.launch({ headless: true, timeout: timeoutMs,
          proxy: proxy ? { server: proxy } : undefined });
        if (this.closed) { await browser.close(); throw new Error("CineJoy resolver closed."); }
        this.browser = browser;
      }
      const remaining = deadline - Date.now();
      if (remaining < 1) throw new Error("CineJoy source resolution timed out.");
      return await resolveInBrowser(this.browser, watchUrl, server, remaining, this.assets);
    } catch (error) {
      const browser = this.browser;
      this.browser = null;
      await browser?.close().catch(() => {});
      throw error;
    } finally { this.busy = false; }
  }
  async close() {
    this.closed = true;
    const browser = this.browser;
    this.browser = null;
    await browser?.close().catch(() => {});
  }
}

// Keep the one-shot CLI compatible for operator tools and the emergency
// CINEJOY_WARM_RESOLVER=0 path.
export async function resolveCinejoy(watchUrl, server = "LISBON", timeoutMs = 30000, loadBrowser = loadPlaywright) {
  const resolver = new CinejoyResolver(loadBrowser);
  try { return await resolver.resolve(watchUrl, server, timeoutMs); }
  finally { await resolver.close(); }
}

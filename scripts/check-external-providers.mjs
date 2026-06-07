#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const RESOLVER_SCRIPT = resolve(ROOT, "scripts/resolve-external-embed-hls.mjs");
const TIMEOUT_MS = Number(process.env.PROVIDER_CHECK_TIMEOUT_MS || 35000);

const TITLES = [
  {
    label: "The Dark Knight (2008)",
    mediaType: "movie",
    tmdbId: "155",
    imdbId: "tt0468569",
    title: "The Dark Knight",
    year: "2008",
  },
  {
    label: "Inception (2010)",
    mediaType: "movie",
    tmdbId: "27205",
    imdbId: "tt1375666",
    title: "Inception",
    year: "2010",
  },
  {
    label: "Breaking Bad S01E01",
    mediaType: "tv",
    tmdbId: "1396",
    imdbId: "tt0903747",
    title: "Breaking Bad",
    year: "2008",
    seasonNumber: 1,
    episodeNumber: 1,
  },
];

const LORDFLIX_SERVERS = ["Phoenix", "Rio", "Ativa"];

function encodeQuote(value) {
  return encodeURIComponent(value).replace(/%20/g, "%20");
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, referer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36",
        Accept: "*/*",
        Referer: referer,
        Origin: referer.replace(/\/$/, ""),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function validateM3u8(url, referer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36",
        Accept: "application/vnd.apple.mpegurl, application/x-mpegURL, */*",
        ...(referer ? { Referer: referer } : {}),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    if (!text.includes("#EXTM3U")) {
      throw new Error("Not an HLS playlist");
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

function embedUrl(provider, item) {
  const { mediaType, tmdbId, seasonNumber, episodeNumber } = item;
  switch (provider) {
    case "vidlink":
      return mediaType === "tv"
        ? `https://vidlink.pro/tv/${tmdbId}/${seasonNumber}/${episodeNumber}`
        : `https://vidlink.pro/movie/${tmdbId}`;
    case "icefy":
      return mediaType === "tv"
        ? `https://streams.icefy.top/tv/${tmdbId}/${seasonNumber}/${episodeNumber}`
        : `https://streams.icefy.top/movie/${tmdbId}`;
    case "vixsrc":
      return mediaType === "tv"
        ? `https://vixsrc.to/api/tv/${tmdbId}/${seasonNumber}/${episodeNumber}`
        : `https://vixsrc.to/api/movie/${tmdbId}`;
    case "videasy":
      return mediaType === "tv"
        ? `https://player.videasy.to/tv/${tmdbId}/${seasonNumber}/${episodeNumber}?nextEpisode=true&autoplayNextEpisode=true&episodeSelector=false&overlay=true&color=ffd700`
        : `https://player.videasy.to/movie/${tmdbId}?color=ffd700`;
    default:
      return "";
  }
}

async function runPlaywrightResolver(embedUrl, server = "") {
  return new Promise((resolvePromise, rejectPromise) => {
    const env = {
      ...process.env,
      EXTERNAL_EMBED_HLS_RESOLVE_TIMEOUT_MS: String(Math.min(TIMEOUT_MS, 30000)),
    };
    if (server) {
      env.EXTERNAL_EMBED_SERVER = server;
    }
    const child = spawn("node", [RESOLVER_SCRIPT, embedUrl], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error("Playwright resolver timed out"));
    }, TIMEOUT_MS + 5000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectPromise(new Error(stderr.trim() || stdout.trim() || `exit ${code}`));
        return;
      }
      try {
        const payload = JSON.parse(stdout.trim());
        resolvePromise(payload);
      } catch {
        rejectPromise(new Error("Invalid resolver output"));
      }
    });
  });
}

async function checkIcefy(item) {
  const url = embedUrl("icefy", item);
  const referer = "https://streams.icefy.top/";
  let lastError = new Error("No stream URL");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 900 * attempt));
    }
    try {
      const payload = await fetchJson(url, { headers: { Referer: referer } });
      if (!payload.stream) {
        throw new Error("No stream URL");
      }
      await validateM3u8(payload.stream, referer);
      return payload.stream;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function checkVixsrc(item) {
  const apiUrl = embedUrl("vixsrc", item);
  const payload = await fetchJson(apiUrl, { headers: { Referer: "https://vixsrc.to/" } });
  if (!payload.src) {
    throw new Error("No embed src");
  }
  const embedPage = new URL(payload.src, "https://vixsrc.to/").toString();
  const html = await fetchText(embedPage, "https://vixsrc.to/");
  const token = html.match(/token["']\s*:\s*["']([^"']+)/)?.[1];
  const expires = html.match(/expires["']\s*:\s*["']([^"']+)/)?.[1];
  const playlist = html.match(/url\s*:\s*["']([^"']+)/)?.[1];
  if (!token || !expires || !playlist) {
    throw new Error("Missing playlist metadata");
  }
  const playlistUrl = new URL(playlist, embedPage);
  playlistUrl.searchParams.set("token", token);
  playlistUrl.searchParams.set("expires", expires);
  playlistUrl.searchParams.set("h", "1");
  await validateM3u8(playlistUrl.toString(), embedPage);
  return playlistUrl.toString();
}

async function encryptVidrockItemId(itemId) {
  const { createCipheriv } = await import("node:crypto");
  const passphrase = "x7k9mPqT2rWvY8zA5bC3nF6hJ2lK4mN9";
  const key = Buffer.from(passphrase, "utf8");
  const iv = Buffer.from(passphrase.slice(0, 16), "utf8");
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(itemId, "utf8"), cipher.final()]);
  return encrypted.toString("base64url");
}

async function checkVidrock(item) {
  const itemId =
    item.mediaType === "tv"
      ? `${item.tmdbId}_${item.seasonNumber}_${item.episodeNumber}`
      : item.tmdbId;
  const encryptedId = await encryptVidrockItemId(itemId);
  const apiUrl = `https://vidrock.net/api/${item.mediaType}/${encryptedId}`;
  const streams = await fetchJson(apiUrl, { headers: { Referer: "https://vidrock.net/" } });
  for (const stream of Object.values(streams || {})) {
    const streamUrl = stream?.url;
    if (!streamUrl) continue;
    try {
      await validateM3u8(streamUrl, "https://vidrock.net/");
      return streamUrl;
    } catch {
      // try next
    }
  }
  throw new Error("No valid HLS stream");
}

async function checkNotorrent(item) {
  const apiUrl =
    item.mediaType === "tv"
      ? `https://addon-osvh.onrender.com/stream/series/${item.imdbId}:${item.seasonNumber}:${item.episodeNumber}.json`
      : `https://addon-osvh.onrender.com/stream/movie/${item.imdbId}.json`;
  const payload = await fetchJson(apiUrl);
  for (const stream of payload.streams || []) {
    if (stream.externalUrl || !stream.url) continue;
    if (stream.url.includes("github.com") || stream.url.includes("googleusercontent")) {
      continue;
    }
    const referer =
      stream.behaviorHints?.proxyHeaders?.request?.Referer ||
      stream.behaviorHints?.headers?.Referer ||
      undefined;
    try {
      await validateM3u8(stream.url, referer);
      return stream.url;
    } catch {
      // try next
    }
  }
  throw new Error("No valid HLS stream");
}

async function checkLordflixServer(item, server) {
  const typeParam = item.mediaType === "tv" ? "series" : "movie";
  let serverUrl = `${`https://snowhouse.lordflix.club`}/?title=${encodeQuote(item.title)}&type=${typeParam}&year=${item.year}&imdb=${item.imdbId}&tmdb=${item.tmdbId}&server=${server}`;
  if (item.mediaType === "tv") {
    serverUrl += `&season=${item.seasonNumber}&episode=${item.episodeNumber}`;
  }
  const enc = await fetchJson(
    `https://enc-dec.app/api/enc-lordflix?url=${encodeQuote(serverUrl)}`,
  );
  if (enc.status !== 200 || !enc.result?.url || !enc.result?.sign) {
    throw new Error("enc-lordflix failed");
  }
  const encrypted = await fetchText(enc.result.url, "https://lordflix.org/");
  const dec = await fetchJson("https://enc-dec.app/api/dec-lordflix", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: encrypted, sign: enc.result.sign }),
  });
  const streams = dec?.result?.stream || [];
  for (const stream of streams) {
    if (stream.type === "hls" && stream.playlist) {
      await validateM3u8(stream.playlist, "https://lordflix.org/");
      return stream.playlist;
    }
  }
  throw new Error("No valid HLS stream");
}

async function checkLordflix(item) {
  let lastError = new Error("No servers responded");
  for (const server of LORDFLIX_SERVERS) {
    try {
      const playlist = await checkLordflixServer(item, server);
      return `${server}: ${playlist}`;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function checkPlaywrightProvider(provider, item, server = "") {
  const url = embedUrl(provider, item);
  const payload = await runPlaywrightResolver(url, server);
  if (!payload?.playbackUrl) {
    throw new Error("No playback URL");
  }
  const referer = payload.referer || url;
  await validateM3u8(payload.playbackUrl, referer);
  return payload.playbackUrl;
}

const PROVIDERS = [
  { id: "vidlink", label: "VidLink", run: (item) => checkPlaywrightProvider("vidlink", item) },
  { id: "icefy", label: "Icefy", run: checkIcefy },
  { id: "vidrock", label: "VidRock", run: checkVidrock },
  { id: "notorrent", label: "NoTorrent", run: checkNotorrent },
  { id: "lordflix", label: "LordFlix", run: checkLordflix },
  { id: "vixsrc", label: "VixSrc", run: checkVixsrc },
  {
    id: "videasy",
    label: "VidEasy",
    run: (item) => checkPlaywrightProvider("videasy", item),
  },
  {
    id: "videasy-neon",
    label: "VidEasy Neon",
    run: (item) => checkPlaywrightProvider("videasy", item, "NEON"),
    skipTv: false,
  },
  {
    id: "videasy-yoru",
    label: "VidEasy Yoru",
    run: (item) => checkPlaywrightProvider("videasy", item, "YORU"),
    moviesOnly: true,
  },
];

async function checkProvider(provider, item) {
  if (provider.moviesOnly && item.mediaType === "tv") {
    return { status: "skip", detail: "movies only" };
  }
  const started = Date.now();
  try {
    const playbackUrl = await provider.run(item);
    return {
      status: "ok",
      ms: Date.now() - started,
      detail: String(playbackUrl).slice(0, 120),
    };
  } catch (error) {
    return {
      status: "fail",
      ms: Date.now() - started,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  console.log("Checking external embed providers against popular titles...\n");

  const summary = {};
  for (const provider of PROVIDERS) {
    summary[provider.id] = { ok: 0, fail: 0, skip: 0 };
  }

  for (const item of TITLES) {
    console.log(`== ${item.label} ==`);
    for (const provider of PROVIDERS) {
      process.stdout.write(`  ${provider.label.padEnd(14)} `);
      const result = await checkProvider(provider, item);
      summary[provider.id][result.status] += 1;
      if (result.status === "skip") {
        console.log("SKIP (movies only)");
      } else if (result.status === "ok") {
        console.log(`OK (${result.ms}ms)`);
      } else {
        console.log(`FAIL (${result.ms}ms) - ${result.detail}`);
      }
    }
    console.log("");
  }

  console.log("Summary by provider:");
  for (const provider of PROVIDERS) {
    const stats = summary[provider.id];
    console.log(
      `  ${provider.label.padEnd(14)} ok=${stats.ok} fail=${stats.fail} skip=${stats.skip}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

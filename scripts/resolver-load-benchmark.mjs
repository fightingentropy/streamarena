#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, "..");

const DEFAULT_BASE_URL = "http://127.0.0.1:5173";
const DEFAULT_CLIENTS = 4;
const DEFAULT_WAVES = 1;
const DEFAULT_TIMEOUT_MS = 120_000;

function parseArgs(argv) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    mediaType: "auto",
    tmdbId: "",
    title: "",
    year: "",
    seasonNumber: "",
    episodeNumber: "",
    clients: DEFAULT_CLIENTS,
    waves: DEFAULT_WAVES,
    pauseMs: 0,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    audioLang: "auto",
    quality: "1080p",
    subtitleLang: "off",
    preferredContainer: "",
    sourceHash: "",
    minSeeders: "",
    allowedFormats: "",
    sourceLang: "",
    sourceAudioProfile: "",
    json: false,
    outputPath: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextValue = () => {
      index += 1;
      return argv[index];
    };

    if (arg === "--base-url") {
      options.baseUrl = String(nextValue() || "").trim();
    } else if (arg === "--media-type") {
      options.mediaType = String(nextValue() || "auto").trim().toLowerCase();
    } else if (arg === "--tmdb-id") {
      options.tmdbId = String(nextValue() || "").trim();
    } else if (arg === "--title") {
      options.title = String(nextValue() || "").trim();
    } else if (arg === "--year") {
      options.year = String(nextValue() || "").trim();
    } else if (arg === "--season" || arg === "--season-number") {
      options.seasonNumber = String(nextValue() || "").trim();
    } else if (arg === "--episode" || arg === "--episode-number") {
      options.episodeNumber = String(nextValue() || "").trim();
    } else if (arg === "--clients") {
      options.clients = Number(nextValue() || DEFAULT_CLIENTS);
    } else if (arg === "--waves") {
      options.waves = Number(nextValue() || DEFAULT_WAVES);
    } else if (arg === "--pause-ms") {
      options.pauseMs = Number(nextValue() || 0);
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(nextValue() || DEFAULT_TIMEOUT_MS);
    } else if (arg === "--audio-lang") {
      options.audioLang = String(nextValue() || "auto").trim();
    } else if (arg === "--quality") {
      options.quality = String(nextValue() || "1080p").trim();
    } else if (arg === "--subtitle-lang") {
      options.subtitleLang = String(nextValue() || "off").trim();
    } else if (arg === "--preferred-container") {
      options.preferredContainer = String(nextValue() || "").trim();
    } else if (arg === "--source-hash") {
      options.sourceHash = String(nextValue() || "").trim();
    } else if (arg === "--min-seeders") {
      options.minSeeders = String(nextValue() || "").trim();
    } else if (arg === "--allowed-formats") {
      options.allowedFormats = String(nextValue() || "").trim();
    } else if (arg === "--source-lang") {
      options.sourceLang = String(nextValue() || "").trim();
    } else if (arg === "--source-audio-profile") {
      options.sourceAudioProfile = String(nextValue() || "").trim();
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--output") {
      options.outputPath = String(nextValue() || "").trim();
    } else if (arg === "--help" || arg === "-h") {
      printHelpAndExit(0);
    } else {
      throw new Error(`Unknown argument '${arg}'.`);
    }
  }

  if (!options.baseUrl) {
    throw new Error("--base-url must not be empty.");
  }
  if (!["auto", "movie", "tv"].includes(options.mediaType)) {
    throw new Error("--media-type must be one of: auto, movie, tv.");
  }
  if (!Number.isFinite(options.clients) || options.clients <= 0) {
    throw new Error("--clients must be a positive number.");
  }
  if (!Number.isFinite(options.waves) || options.waves <= 0) {
    throw new Error("--waves must be a positive number.");
  }

  options.clients = Math.max(1, Math.floor(options.clients));
  options.waves = Math.max(1, Math.floor(options.waves));
  options.pauseMs = Math.max(0, Math.floor(options.pauseMs || 0));
  options.timeoutMs = Math.max(5_000, Math.floor(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  options.baseUrl = options.baseUrl.replace(/\/+$/g, "");

  return options;
}

function printHelpAndExit(code = 0) {
  console.log(
    [
      "Usage: bun run bench:resolve -- [options]",
      "",
      "Options:",
      "  --base-url <url>             Running backend base URL (default: http://127.0.0.1:5173)",
      "  --media-type <type>          auto | movie | tv (default: auto)",
      "  --tmdb-id <id>               Title TMDB id; defaults to first usable /api/library item",
      "  --title <title>              Fallback title passed to resolver",
      "  --year <year>                Fallback year passed to resolver",
      "  --season <n>                 TV season number",
      "  --episode <n>                TV episode number",
      "  --clients <n>                Concurrent identical resolve clients (default: 4)",
      "  --waves <n>                  Repeat waves of concurrent clients (default: 1)",
      "  --pause-ms <ms>              Pause between waves",
      "  --timeout-ms <ms>            Per-request timeout (default: 120000)",
      "  --audio-lang <lang>          Preferred audio language (default: auto)",
      "  --quality <quality>          Preferred quality (default: 1080p)",
      "  --subtitle-lang <lang>       Preferred subtitle language (default: off)",
      "  --preferred-container <fmt>  TV preferred container",
      "  --source-hash <hash>         Force a source hash",
      "  --min-seeders <n>            Source filter",
      "  --allowed-formats <list>     Source filter",
      "  --source-lang <lang>         Source filter",
      "  --source-audio-profile <p>   Source filter",
      "  --json                       Print full JSON report",
      "  --output <path>              Save full JSON report",
    ].join("\n"),
  );
  process.exit(code);
}

async function fetchWithTiming(url, { timeoutMs, label }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    return {
      label,
      ok: response.ok,
      status: response.status,
      ms: round(performance.now() - startedAt, 2),
      bytes: Buffer.byteLength(text),
      payload,
      error: response.ok ? "" : extractErrorMessage(payload, text),
    };
  } catch (error) {
    return {
      label,
      ok: false,
      status: 0,
      ms: round(performance.now() - startedAt, 2),
      bytes: 0,
      payload: null,
      error: error?.name === "AbortError" ? "timeout" : String(error?.message || error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function extractErrorMessage(payload, text) {
  return String(payload?.error || payload?.message || text || "").slice(0, 220);
}

async function fetchJson(url, timeoutMs) {
  const result = await fetchWithTiming(url, { timeoutMs, label: "json" });
  return result.ok ? result.payload : null;
}

async function resolveTarget(options) {
  if (options.tmdbId) {
    return {
      mediaType: options.mediaType === "auto" ? "movie" : options.mediaType,
      tmdbId: options.tmdbId,
      title: options.title,
      year: options.year,
      seasonNumber: options.seasonNumber || "1",
      episodeNumber: options.episodeNumber || "1",
      preferredContainer: options.preferredContainer,
    };
  }

  const library = await fetchJson(`${options.baseUrl}/api/library`, options.timeoutMs);
  if (!library) {
    throw new Error("Unable to load /api/library. Pass --tmdb-id explicitly.");
  }

  if (options.mediaType !== "tv") {
    const movie = (Array.isArray(library.movies) ? library.movies : []).find((item) =>
      String(item?.tmdbId || "").trim(),
    );
    if (movie) {
      return {
        mediaType: "movie",
        tmdbId: String(movie.tmdbId),
        title: String(movie.title || ""),
        year: String(movie.year || ""),
        seasonNumber: "1",
        episodeNumber: "1",
        preferredContainer: "",
      };
    }
  }

  const series = (Array.isArray(library.series) ? library.series : []).find((item) =>
    String(item?.tmdbId || "").trim() && Array.isArray(item?.episodes) && item.episodes.length > 0,
  );
  if (series) {
    const episode = series.episodes[0] || {};
    return {
      mediaType: "tv",
      tmdbId: String(series.tmdbId),
      title: String(series.title || ""),
      year: String(series.year || ""),
      seasonNumber: String(episode.seasonNumber || 1),
      episodeNumber: String(episode.episodeNumber || 1),
      preferredContainer: String(series.preferredContainer || options.preferredContainer || ""),
    };
  }

  throw new Error("No usable library title was found. Pass --tmdb-id explicitly.");
}

function buildResolveUrl(options, target) {
  const isTv = target.mediaType === "tv";
  const params = new URLSearchParams({
    tmdbId: target.tmdbId,
    title: target.title || "",
    year: target.year || "",
    audioLang: options.audioLang,
    quality: options.quality,
    subtitleLang: options.subtitleLang,
  });
  if (options.sourceHash) params.set("sourceHash", options.sourceHash);
  if (options.minSeeders) params.set("minSeeders", options.minSeeders);
  if (options.allowedFormats) params.set("allowedFormats", options.allowedFormats);
  if (options.sourceLang) params.set("sourceLang", options.sourceLang);
  if (options.sourceAudioProfile) params.set("sourceAudioProfile", options.sourceAudioProfile);
  if (isTv) {
    params.set("seasonNumber", target.seasonNumber || "1");
    params.set("episodeNumber", target.episodeNumber || "1");
    params.set("preferredContainer", options.preferredContainer || target.preferredContainer || "");
  }
  return `${options.baseUrl}${isTv ? "/api/resolve/tv" : "/api/resolve/movie"}?${params.toString()}`;
}

async function readHealth(baseUrl, timeoutMs) {
  const health = await fetchJson(`${baseUrl}/api/health`, timeoutMs);
  return {
    health,
    resolver: health?.resolver || null,
    streaming: health?.streaming || null,
  };
}

async function runWave(waveIndex, options, url) {
  return Promise.all(
    Array.from({ length: options.clients }, (_, clientId) =>
      fetchWithTiming(url, {
        timeoutMs: options.timeoutMs,
        label: `wave-${waveIndex}:client-${clientId}`,
      }).then((result) => ({
        ...result,
        waveIndex,
        clientId,
        playableUrl: result.payload?.playableUrl || "",
        sourceHash: result.payload?.sourceHash || "",
        filename: result.payload?.filename || "",
      })),
    ),
  );
}

function summarizeRequests(requests) {
  const successful = requests.filter((request) => request.ok);
  const failed = requests.filter((request) => !request.ok);
  const latencies = successful.map((request) => request.ms).filter(Number.isFinite);
  return {
    total: requests.length,
    successful: successful.length,
    failed: failed.length,
    minMs: percentile(latencies, 0),
    p50Ms: percentile(latencies, 0.5),
    p90Ms: percentile(latencies, 0.9),
    p95Ms: percentile(latencies, 0.95),
    maxMs: percentile(latencies, 1),
    bytes: successful.reduce((sum, request) => sum + request.bytes, 0),
    uniquePlayableUrls: new Set(successful.map((request) => request.playableUrl).filter(Boolean))
      .size,
    uniqueSourceHashes: new Set(successful.map((request) => request.sourceHash).filter(Boolean))
      .size,
    failures: failed.slice(0, 10).map((request) => ({
      label: request.label,
      status: request.status,
      ms: request.ms,
      error: request.error,
    })),
  };
}

function percentile(values, percentileValue) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rawIndex = (sorted.length - 1) * percentileValue;
  const lower = Math.floor(rawIndex);
  const upper = Math.ceil(rawIndex);
  if (lower === upper) {
    return round(sorted[lower], 2);
  }
  const weight = rawIndex - lower;
  return round(sorted[lower] * (1 - weight) + sorted[upper] * weight, 2);
}

function diffMetrics(after, before) {
  if (!after || !before) {
    return null;
  }
  const delta = {};
  for (const [key, value] of Object.entries(after)) {
    if (typeof value === "number" && typeof before[key] === "number") {
      delta[key] = value - before[key];
    }
  }
  return delta;
}

function round(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function formatMs(value) {
  return Number.isFinite(value) ? `${Math.round(value)}ms` : "n/a";
}

function printPrettyReport(report) {
  console.log(`Base URL: ${report.baseUrl}`);
  console.log(
    `Target: ${report.target.mediaType} ${report.target.title || report.target.tmdbId} (${report.target.tmdbId})`,
  );
  if (report.target.mediaType === "tv") {
    console.log(`Episode: S${report.target.seasonNumber}E${report.target.episodeNumber}`);
  }
  console.log(`Load: ${report.clients} clients x ${report.waves} wave(s)`);
  console.log(
    `Resolve: ok=${report.summary.successful}/${report.summary.total} p50=${formatMs(report.summary.p50Ms)} p95=${formatMs(report.summary.p95Ms)} max=${formatMs(report.summary.maxMs)} uniqueSources=${report.summary.uniqueSourceHashes || report.summary.uniquePlayableUrls}`,
  );
  if (report.resolverDelta) {
    console.log(
      [
        "Resolver delta:",
        `movie=${report.resolverDelta.movieRequests ?? 0}`,
        `tv=${report.resolverDelta.tvRequests ?? 0}`,
        `coalesced=${report.resolverDelta.coalescedWaits ?? 0}`,
        `active=${report.resolverAfter?.activeResolves ?? 0}`,
        `lockKeys=${report.resolverAfter?.lockKeys ?? 0}`,
      ].join(" "),
    );
  }
  if (report.summary.failures.length > 0) {
    console.log("Failures:");
    for (const failure of report.summary.failures) {
      console.log(
        `  ${failure.label} status=${failure.status} ms=${formatMs(failure.ms)} ${failure.error}`,
      );
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const target = await resolveTarget(options);
  const url = buildResolveUrl(options, target);
  const before = await readHealth(options.baseUrl, options.timeoutMs);
  const startedAt = performance.now();
  const waveResults = [];

  for (let waveIndex = 0; waveIndex < options.waves; waveIndex += 1) {
    waveResults.push(...(await runWave(waveIndex, options, url)));
    if (options.pauseMs > 0 && waveIndex < options.waves - 1) {
      await delay(options.pauseMs);
    }
  }

  const after = await readHealth(options.baseUrl, options.timeoutMs);
  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: options.baseUrl,
    target,
    clients: options.clients,
    waves: options.waves,
    durationMs: round(performance.now() - startedAt, 2),
    resolveUrl: url,
    summary: summarizeRequests(waveResults),
    resolverBefore: before.resolver,
    resolverAfter: after.resolver,
    resolverDelta: diffMetrics(after.resolver, before.resolver),
    streamingDelta: diffMetrics(after.streaming?.hls, before.streaming?.hls),
    results: waveResults,
  };

  printPrettyReport(report);

  if (options.outputPath) {
    const outputPath = resolve(ROOT_DIR, options.outputPath);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Saved JSON report to ${outputPath}`);
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  }

  if (report.summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});

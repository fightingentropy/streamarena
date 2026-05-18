#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, "..");

const DEFAULT_BASE_URL = "http://127.0.0.1:5173";
const DEFAULT_CLIENTS = 4;
const DEFAULT_SEGMENTS = 6;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PAUSE_MS = 150;
const DEFAULT_SOURCE_CANDIDATES = [
  "assets/videos/Pride.Prejudice.2005.2160p.4K.WEB.x265.10bit.AAC5.1-[YTS.MX].mp4",
  "assets/videos/jeffrey-epstein-filthy-rich-official-trailer-netflix.mp4",
];

function parseArgs(argv) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    source: "",
    clients: DEFAULT_CLIENTS,
    segments: DEFAULT_SEGMENTS,
    startIndex: 0,
    audioStream: -1,
    pattern: "staggered",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pauseMs: DEFAULT_PAUSE_MS,
    skipPlaylist: false,
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
    } else if (arg === "--source") {
      options.source = String(nextValue() || "").trim();
    } else if (arg === "--clients") {
      options.clients = Number(nextValue() || DEFAULT_CLIENTS);
    } else if (arg === "--segments") {
      options.segments = Number(nextValue() || DEFAULT_SEGMENTS);
    } else if (arg === "--start-index") {
      options.startIndex = Number(nextValue() || 0);
    } else if (arg === "--audio-stream") {
      options.audioStream = Number(nextValue() || -1);
    } else if (arg === "--pattern") {
      options.pattern = String(nextValue() || "staggered").trim().toLowerCase();
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(nextValue() || DEFAULT_TIMEOUT_MS);
    } else if (arg === "--pause-ms") {
      options.pauseMs = Number(nextValue() || DEFAULT_PAUSE_MS);
    } else if (arg === "--skip-playlist") {
      options.skipPlaylist = true;
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
  if (!Number.isFinite(options.clients) || options.clients <= 0) {
    throw new Error("--clients must be a positive number.");
  }
  if (!Number.isFinite(options.segments) || options.segments <= 0) {
    throw new Error("--segments must be a positive number.");
  }
  if (!["same", "staggered"].includes(options.pattern)) {
    throw new Error("--pattern must be one of: same, staggered.");
  }

  options.clients = Math.max(1, Math.floor(options.clients));
  options.segments = Math.max(1, Math.floor(options.segments));
  options.startIndex = Math.max(0, Math.floor(options.startIndex || 0));
  options.audioStream = Math.floor(options.audioStream || -1);
  options.timeoutMs = Math.max(1_000, Math.floor(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  options.pauseMs = Math.max(0, Math.floor(options.pauseMs || 0));
  options.baseUrl = options.baseUrl.replace(/\/+$/g, "");
  options.source = normalizeSourceInput(options.source);

  return options;
}

function printHelpAndExit(code = 0) {
  console.log(
    [
      "Usage: bun run bench:load -- [options]",
      "",
      "Options:",
      "  --base-url <url>       Running backend base URL (default: http://127.0.0.1:5173)",
      "  --source <path|url>    Repo-local asset path or remote URL to request",
      "  --clients <n>          Concurrent playback clients (default: 4)",
      "  --segments <n>         HLS segments requested by each client (default: 6)",
      "  --start-index <n>      First HLS segment index (default: 0)",
      "  --audio-stream <n>     Audio stream index passed to HLS endpoints (default: -1)",
      "  --pattern <mode>       same | staggered (default: staggered)",
      "  --pause-ms <ms>        Delay between segment requests per client (default: 150)",
      "  --timeout-ms <ms>      Per-request timeout (default: 30000)",
      "  --skip-playlist        Request segments without a playlist preflight",
      "  --json                 Print the full report JSON",
      "  --output <path>        Save the full report JSON",
    ].join("\n"),
  );
  process.exit(code);
}

function resolveDefaultSource() {
  for (const candidate of DEFAULT_SOURCE_CANDIDATES) {
    if (existsSync(resolve(ROOT_DIR, candidate))) {
      return candidate;
    }
  }
  return "assets/videos/jeffrey-epstein-filthy-rich-official-trailer-netflix.mp4";
}

function toPosixPath(value) {
  return String(value || "").replaceAll("\\", "/");
}

function normalizeSourceInput(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) {
    return resolveDefaultSource();
  }
  if (/^[a-z]+:\/\//i.test(value)) {
    return value;
  }

  const absoluteValue = resolve(ROOT_DIR, value);
  if (existsSync(absoluteValue)) {
    return toPosixPath(relative(ROOT_DIR, absoluteValue));
  }

  return toPosixPath(value).replace(/^\/+/, "");
}

function buildUrl(baseUrl, path, params) {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function playlistUrl(options) {
  return buildUrl(options.baseUrl, "/api/hls/master.m3u8", {
    input: options.source,
    audioStream: options.audioStream,
  });
}

function segmentUrl(options, segmentIndex) {
  return buildUrl(options.baseUrl, "/api/hls/segment.ts", {
    input: options.source,
    index: segmentIndex,
    audioStream: options.audioStream,
  });
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
    const body = await response.arrayBuffer();
    return {
      label,
      ok: response.ok,
      status: response.status,
      ms: round(performance.now() - startedAt, 2),
      bytes: body.byteLength,
      cacheControl: response.headers.get("cache-control") || "",
      contentLength: Number(response.headers.get("content-length") || body.byteLength) || 0,
    };
  } catch (error) {
    return {
      label,
      ok: false,
      status: 0,
      ms: round(performance.now() - startedAt, 2),
      bytes: 0,
      cacheControl: "",
      contentLength: 0,
      error: error?.name === "AbortError" ? "timeout" : String(error?.message || error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readServerSnapshot(baseUrl, timeoutMs) {
  const [config, health] = await Promise.all([
    fetchJson(`${baseUrl}/api/config`, timeoutMs),
    fetchJson(`${baseUrl}/api/health`, timeoutMs),
  ]);
  return {
    config,
    health,
    hls: health?.streaming?.hls || null,
    remux: health?.streaming?.remux || null,
  };
}

function segmentIndexForClient(options, clientId, offset) {
  if (options.pattern === "same") {
    return options.startIndex + offset;
  }
  return options.startIndex + clientId + offset;
}

async function runClient(clientId, options) {
  const playlist = options.skipPlaylist
    ? null
    : await fetchWithTiming(playlistUrl(options), {
        timeoutMs: options.timeoutMs,
        label: `client-${clientId}:playlist`,
      });
  const segments = [];

  for (let offset = 0; offset < options.segments; offset += 1) {
    const index = segmentIndexForClient(options, clientId, offset);
    const result = await fetchWithTiming(segmentUrl(options, index), {
      timeoutMs: options.timeoutMs,
      label: `client-${clientId}:segment-${index}`,
    });
    segments.push({
      ...result,
      clientId,
      index,
    });
    if (options.pauseMs > 0 && offset < options.segments - 1) {
      await delay(options.pauseMs);
    }
  }

  return {
    clientId,
    playlist,
    segments,
  };
}

function flattenSegments(clientResults) {
  return clientResults.flatMap((client) => client.segments);
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

function summarizeRequests(requests) {
  const successful = requests.filter((request) => request.ok);
  const failed = requests.filter((request) => !request.ok);
  const latencies = successful.map((request) => request.ms).filter(Number.isFinite);
  const totalBytes = successful.reduce((sum, request) => sum + (request.bytes || 0), 0);
  return {
    total: requests.length,
    successful: successful.length,
    failed: failed.length,
    totalBytes,
    minMs: percentile(latencies, 0),
    p50Ms: percentile(latencies, 0.5),
    p90Ms: percentile(latencies, 0.9),
    p95Ms: percentile(latencies, 0.95),
    maxMs: percentile(latencies, 1),
    failures: failed.slice(0, 10).map((request) => ({
      label: request.label,
      status: request.status,
      ms: request.ms,
      error: request.error || "",
    })),
  };
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

function printPrettyReport(report) {
  console.log(`Base URL: ${report.baseUrl}`);
  console.log(`Source: ${report.source}`);
  console.log(
    `Load: ${report.clients} clients x ${report.segments} segments (${report.pattern})`,
  );
  console.log(
    `Segments: ok=${report.segmentsSummary.successful}/${report.segmentsSummary.total} p50=${formatMs(report.segmentsSummary.p50Ms)} p95=${formatMs(report.segmentsSummary.p95Ms)} max=${formatMs(report.segmentsSummary.maxMs)} bytes=${formatBytes(report.segmentsSummary.totalBytes)}`,
  );
  if (report.playlistsSummary.total > 0) {
    console.log(
      `Playlists: ok=${report.playlistsSummary.successful}/${report.playlistsSummary.total} p95=${formatMs(report.playlistsSummary.p95Ms)}`,
    );
  }
  if (report.hlsDelta) {
    console.log(
      [
        "HLS delta:",
        `requests=${report.hlsDelta.segmentRequests ?? 0}`,
        `hits=${report.hlsDelta.segmentCacheHits ?? 0}`,
        `misses=${report.hlsDelta.segmentCacheMisses ?? 0}`,
        `renders=${report.hlsDelta.onDemandRenders ?? 0}`,
        `renderRejected=${report.hlsDelta.segmentRenderRejected ?? 0}`,
        `transcodes=${report.hlsDelta.transcodeStarted ?? 0}`,
      ].join(" "),
    );
  }
  if (report.segmentsSummary.failures.length > 0) {
    console.log("Failures:");
    for (const failure of report.segmentsSummary.failures) {
      console.log(
        `  ${failure.label} status=${failure.status} ms=${formatMs(failure.ms)} ${failure.error}`,
      );
    }
  }
}

function formatMs(value) {
  return Number.isFinite(value) ? `${Math.round(value)}ms` : "n/a";
}

function formatBytes(value) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  if (value >= 1024 * 1024) {
    return `${round(value / 1024 / 1024, 2)} MiB`;
  }
  if (value >= 1024) {
    return `${round(value / 1024, 2)} KiB`;
  }
  return `${value} B`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = performance.now();
  const before = await readServerSnapshot(options.baseUrl, options.timeoutMs);
  const clients = await Promise.all(
    Array.from({ length: options.clients }, (_, clientId) => runClient(clientId, options)),
  );
  const after = await readServerSnapshot(options.baseUrl, options.timeoutMs);
  const segmentRequests = flattenSegments(clients);
  const playlistRequests = clients.map((client) => client.playlist).filter(Boolean);
  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: options.baseUrl,
    source: options.source,
    clients: options.clients,
    segments: options.segments,
    pattern: options.pattern,
    durationMs: round(performance.now() - startedAt, 2),
    playlistsSummary: summarizeRequests(playlistRequests),
    segmentsSummary: summarizeRequests(segmentRequests),
    hlsBefore: before.hls,
    hlsAfter: after.hls,
    hlsDelta: diffMetrics(after.hls, before.hls),
    remuxDelta: diffMetrics(after.remux, before.remux),
    hlsLimits: before.config?.hlsLimits || null,
    clientResults: clients,
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

  if (report.segmentsSummary.failed > 0 || report.playlistsSummary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});

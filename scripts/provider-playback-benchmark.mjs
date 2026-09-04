#!/usr/bin/env node

import process from "node:process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "playwright";

const DEFAULT_BASE_URL = "http://127.0.0.1:5173";
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_STEADY_MS = 15_000;
const DEFAULT_ADVANCE_MS = 5_000;
const DEFAULT_VIEWPORT = { width: 1600, height: 900 };
const EXTERNAL_RESOLVER_PROVIDER = "external-embed";
export const PROVIDER_BENCHMARK_HEADER = "x-streamarena-provider-benchmark";
export const PROVIDER_HEALTH_RECORDING_ACK_HEADER =
  "x-streamarena-provider-health-recording";
const PROVIDER_HEALTH_RECORDING_ACK_VALUE = "suppressed";
const LIVE_HLS_WORKER_PROVIDER_KEY = "infra:live-hls-worker";
const CUSTOM_STREMIO_RELEASE_GROUP = "Custom Stremio addon";
const SOURCE_HASH_PATTERN = /^[a-f0-9]{40}$/;
const EMBEDDED_SOURCE_HASH_PATTERN = /[a-f0-9]{40}/i;
const HARD_INTEGRITY_FAILURE_CODES = new Set([
  "NO_PINNED_RESOLVE",
  "BENCHMARK_HEADER_NOT_APPLIED",
  "PROVIDER_HEALTH_SUPPRESSION_NOT_ACKNOWLEDGED",
  "PIN_MISMATCH",
  "PROVIDER_MISMATCH",
  "FALLBACK_DETECTED",
]);
const ORDER_MODES = new Set(["listed", "rotated", "reversed"]);
const PROGRESS_PATHS = [
  "/api/user/watch-progress",
  "/api/user/continue-watching",
  "/api/session/progress",
];
export const REQUIRED_BASE_PROVIDERS = Object.freeze({
  movie: Object.freeze([
    "VidEasy",
    "VidLink",
    "VidRock",
    "NoTorrent",
    "VixSrc",
    "LordFlix",
    "Icefy",
    "Meridian",
    "Gallic",
  ]),
  tv: Object.freeze([
    "VidEasy",
    "VidLink",
    "VidRock",
    "NoTorrent",
    "VixSrc",
    "LordFlix",
    "Icefy",
    "Meridian",
  ]),
});
const OPTIONAL_BASE_PROVIDERS = Object.freeze(["NebulaStreams"]);
const BASE_PROVIDER_CANONICAL = new Map(
  [...REQUIRED_BASE_PROVIDERS.movie, ...OPTIONAL_BASE_PROVIDERS].map((name) => [
    name.toLowerCase(),
    name,
  ]),
);
const NETWORK_BUCKETS = [
  "resolve",
  "liveHlsManifest",
  "liveHlsResource",
  "remux",
  "legacyHlsManifest",
  "legacyHlsResource",
  "directMedia",
];
const REMUX_SERVER_TIMING_METRICS = Object.freeze([
  "remux-queue",
  "remux-probe",
  "remux-codec-setup",
  "remux-ffmpeg-spawn",
  "remux-response",
]);

function benchmarkError(code) {
  const error = new Error(code);
  error.benchmarkCode = code;
  return error;
}

function errorCode(error, fallback = "INTERNAL_FAILURE") {
  const explicit = String(error?.benchmarkCode || "").trim();
  if (explicit) return explicit;
  const name = String(error?.name || "").toLowerCase();
  if (name.includes("timeout")) return "TIMEOUT";
  return fallback;
}

export async function runWithDeadline(
  operation,
  deadlineAtMs,
  code = "DEADLINE_EXCEEDED",
) {
  const remainingMs = Math.floor(Number(deadlineAtMs) - performance.now());
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw benchmarkError(code);
  }
  let timeoutHandle;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(benchmarkError(code)), remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function nextArg(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || String(value).startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

export function parseMovieSpec(rawValue) {
  const value = String(rawValue || "").trim();
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    throw new Error("Movie specs must be positive TMDB ids.");
  }
  return { mediaType: "movie", tmdbId: value, seasonNumber: 0, episodeNumber: 0 };
}

export function parseTvSpec(rawValue) {
  const value = String(rawValue || "").trim();
  const match = /^(\d+):(\d+):(\d+)$/.exec(value);
  if (!match || match.slice(1).some((part) => Number(part) <= 0)) {
    throw new Error("TV specs must use tmdbId:season:episode with positive numbers.");
  }
  return {
    mediaType: "tv",
    tmdbId: match[1],
    seasonNumber: Number(match[2]),
    episodeNumber: Number(match[3]),
  };
}

export function parseArgs(argv) {
  const options = {
    cdpEndpoint: String(process.env.STREAMARENA_CDP_ENDPOINT || "").trim(),
    authOrigin: String(process.env.STREAMARENA_AUTH_ORIGIN || "").trim(),
    baseUrl: String(process.env.STREAMARENA_BASE_URL || DEFAULT_BASE_URL).trim(),
    cases: [],
    trials: 1,
    order: "rotated",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    steadyMs: DEFAULT_STEADY_MS,
    advanceMs: DEFAULT_ADVANCE_MS,
    minSuccessRate: 1,
    includeVariants: false,
    outputPath: "",
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cdp-endpoint") {
      options.cdpEndpoint = String(nextArg(argv, index, arg)).trim();
      index += 1;
    } else if (arg === "--auth-origin") {
      options.authOrigin = String(nextArg(argv, index, arg)).trim();
      index += 1;
    } else if (arg === "--base-url") {
      options.baseUrl = String(nextArg(argv, index, arg)).trim();
      index += 1;
    } else if (arg === "--movie") {
      options.cases.push(parseMovieSpec(nextArg(argv, index, arg)));
      index += 1;
    } else if (arg === "--tv") {
      options.cases.push(parseTvSpec(nextArg(argv, index, arg)));
      index += 1;
    } else if (arg === "--trials") {
      options.trials = Number(nextArg(argv, index, arg));
      index += 1;
    } else if (arg === "--order") {
      options.order = String(nextArg(argv, index, arg)).trim().toLowerCase();
      index += 1;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(nextArg(argv, index, arg));
      index += 1;
    } else if (arg === "--steady-ms") {
      options.steadyMs = Number(nextArg(argv, index, arg));
      index += 1;
    } else if (arg === "--advance-ms") {
      options.advanceMs = Number(nextArg(argv, index, arg));
      index += 1;
    } else if (arg === "--min-success-rate") {
      options.minSuccessRate = Number(nextArg(argv, index, arg));
      index += 1;
    } else if (arg === "--allow-failures") {
      options.minSuccessRate = 0;
    } else if (arg === "--include-variants") {
      options.includeVariants = true;
    } else if (arg === "--base-only") {
      options.includeVariants = false;
    } else if (arg === "--output") {
      options.outputPath = String(nextArg(argv, index, arg)).trim();
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument '${arg}'.`);
    }
  }

  if (!options.help && !options.cdpEndpoint) {
    throw new Error("--cdp-endpoint is required.");
  }
  if (!options.help && options.cases.length === 0) {
    throw new Error("At least one --movie or --tv case is required.");
  }
  if (!Number.isInteger(options.trials) || options.trials < 1 || options.trials > 20) {
    throw new Error("--trials must be an integer from 1 to 20.");
  }
  if (!ORDER_MODES.has(options.order)) {
    throw new Error("--order must be listed, rotated, or reversed.");
  }
  for (const [name, value, allowZero] of [
    ["--timeout-ms", options.timeoutMs, false],
    ["--steady-ms", options.steadyMs, true],
    ["--advance-ms", options.advanceMs, false],
  ]) {
    if (!Number.isFinite(value) || value < (allowZero ? 0 : 1)) {
      throw new Error(`${name} has an invalid value.`);
    }
  }
  if (
    !Number.isFinite(options.minSuccessRate) ||
    options.minSuccessRate < 0 ||
    options.minSuccessRate > 1
  ) {
    throw new Error("--min-success-rate must be between 0 and 1.");
  }
  if (!options.help && options.authOrigin) {
    assertSameAuthOrigin(options.baseUrl, options.authOrigin);
  }
  return options;
}

export function providerBenchmarkHelpText() {
  return [
      "Usage: bun run bench:providers -- [options]",
      "",
      "Required:",
      "  --cdp-endpoint <endpoint>     Existing authenticated Chrome CDP endpoint",
      "  --movie <tmdbId>              Benchmark a movie (repeatable)",
      "  --tv <tmdbId:season:episode>  Benchmark a TV episode (repeatable)",
      "",
      "Options:",
      "  --base-url <origin>           Target StreamArena origin (default: loopback :5173)",
      "  --auth-origin <origin>        Must exactly match --base-url (defaults to target)",
      "  --trials <count>              Trials per discovered source (default: 1)",
      "  --order <mode>                listed | rotated | reversed (default: rotated)",
      "  --timeout-ms <ms>             Overall cap for each trial (default: 45000)",
      "  --steady-ms <ms>              Extra steady playback window (default: 15000)",
      "  --advance-ms <ms>             Required media-time advance (default: 5000)",
      "  --min-success-rate <0..1>     Required aggregate success rate (default: 1)",
      "  --allow-failures              Allow playback failures; coverage and safety gates still apply",
      "  --base-only                   Benchmark built-in base providers only (default)",
      "  --include-variants            Also benchmark discovered VidEasy variants",
      "  --output <path>               Write the sanitised JSON report",
      "  --json                        Print the sanitised JSON report",
    ].join("\n");
}

function printHelp() {
  console.log(providerBenchmarkHelpText());
}

export function normalizeOrigin(rawValue, code = "INVALID_ORIGIN") {
  let parsed;
  try {
    parsed = new URL(String(rawValue || "").trim());
  } catch {
    throw benchmarkError(code);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw benchmarkError(code);
  }
  if (parsed.username || parsed.password) {
    throw benchmarkError(code);
  }
  return parsed.origin;
}

export function assertSameAuthOrigin(baseValue, authValue) {
  const baseOrigin = normalizeOrigin(baseValue, "INVALID_BASE_ORIGIN");
  const authOrigin = normalizeOrigin(authValue, "INVALID_AUTH_ORIGIN");
  if (baseOrigin !== authOrigin) {
    throw benchmarkError("CROSS_ORIGIN_AUTH_FORBIDDEN");
  }
  return baseOrigin;
}

export function extractConfiguredLiveHlsWorkerOrigins(payload) {
  const matches = (Array.isArray(payload?.providers) ? payload.providers : []).filter(
    (provider) =>
      provider?.key === LIVE_HLS_WORKER_PROVIDER_KEY && provider?.custom === false,
  );
  if (matches.length !== 1) {
    throw benchmarkError("LIVE_HLS_WORKER_CONFIG_INVALID");
  }
  const rawValue = String(matches[0]?.effectiveUrl || "").trim();
  if (!rawValue) return [];
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw benchmarkError("LIVE_HLS_WORKER_CONFIG_INVALID");
  }
  if (
    !new Set(["http:", "https:"]).has(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) {
    throw benchmarkError("LIVE_HLS_WORKER_CONFIG_INVALID");
  }
  return [parsed.origin];
}

export function sanitizeProviderLabel(rawValue, fallback = "External source") {
  const value = String(rawValue || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/(?:https?|wss?):\/\/\S+/gi, "")
    .replace(/[?#].*$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return value || fallback;
}

function providerLabelForRow(row) {
  const provider = sanitizeProviderLabel(row?.provider, "External source");
  const primary = sanitizeProviderLabel(row?.primary, provider);
  if (provider === "LivNet") return primary;
  if (primary.toLowerCase() === provider.toLowerCase()) return provider;
  return sanitizeProviderLabel(`${provider} / ${primary}`);
}

export function isExternalSourceRow(row) {
  const hash = String(row?.sourceHash || row?.infoHash || "")
    .trim()
    .toLowerCase();
  return Boolean(row && row.isTorrent === false && SOURCE_HASH_PATTERN.test(hash));
}

function normalizeExternalRows(rows) {
  const seen = new Set();
  return (Array.isArray(rows) ? rows : [])
    .filter(isExternalSourceRow)
    .map((row) => {
      const hash = String(row.sourceHash || row.infoHash).trim().toLowerCase();
      if (seen.has(hash)) return null;
      seen.add(hash);
      // Display labels are admin-controlled for custom Stremio addons. Honor the
      // resolver's stable marker before canonicalizing labels so a custom addon
      // named after a built-in cannot satisfy coverage or enter a benchmark run.
      if (String(row?.releaseGroup || "").trim() === CUSTOM_STREMIO_RELEASE_GROUP) {
        return {
          hash,
          provider: "Additional provider",
          baseProvider: "",
          kind: "additional",
        };
      }
      const rawProvider = sanitizeProviderLabel(row?.provider, "External source");
      const rawPrimary = sanitizeProviderLabel(row?.primary, rawProvider);
      const canonicalProvider = BASE_PROVIDER_CANONICAL.get(
        rawProvider.toLowerCase(),
      );
      const canonicalPrimary = BASE_PROVIDER_CANONICAL.get(
        rawPrimary.toLowerCase(),
      );
      const isVidEasyVariant = Boolean(
        canonicalProvider === "VidEasy" && canonicalPrimary !== "VidEasy",
      );
      const baseProvider = isVidEasyVariant
        ? "VidEasy"
        : canonicalPrimary || canonicalProvider || "";
      return {
        hash,
        provider: providerLabelForRow(row),
        baseProvider,
        kind: isVidEasyVariant
          ? "variant"
          : baseProvider
            ? "base"
            : "additional",
      };
    })
    .filter(Boolean);
}

export function classifyExternalSourceRows(
  rows,
  { mediaType = "movie", includeVariants = false } = {},
) {
  const normalizedType = mediaType === "tv" ? "tv" : "movie";
  const required = [...REQUIRED_BASE_PROVIDERS[normalizedType]];
  const all = normalizeExternalRows(rows);
  const baseByProvider = new Map();
  const variants = [];
  const additional = [];
  for (const source of all) {
    if (source.kind === "base") {
      if (!baseByProvider.has(source.baseProvider)) {
        baseByProvider.set(source.baseProvider, source);
      }
    } else if (source.kind === "variant") {
      variants.push(source);
    } else {
      additional.push(source);
    }
  }
  const discoveredBaseProviders = [...baseByProvider.keys()];
  const missingRequiredBaseProviders = required.filter(
    (provider) => !baseByProvider.has(provider),
  );
  const selected = [
    ...required.map((provider) => baseByProvider.get(provider)).filter(Boolean),
    ...OPTIONAL_BASE_PROVIDERS.map((provider) => baseByProvider.get(provider)).filter(Boolean),
    ...(includeVariants ? variants : []),
  ];
  return {
    requiredBaseProviders: required,
    discoveredBaseProviders,
    missingRequiredBaseProviders,
    optionalBaseProviders: OPTIONAL_BASE_PROVIDERS.map((provider) => ({
      provider,
      discovered: baseByProvider.has(provider),
    })),
    variants,
    additional,
    selected,
  };
}

export function buildDiscoveryReportEntry(testCase, manifest) {
  const sources = Array.isArray(manifest?.selected) ? manifest.selected : [];
  return {
    case: caseLabel(testCase),
    mediaType: testCase.mediaType,
    requiredBaseProviders: manifest.requiredBaseProviders,
    discoveredBaseProviders: manifest.discoveredBaseProviders,
    missingRequiredBaseProviders: manifest.missingRequiredBaseProviders,
    optionalBaseProviders: manifest.optionalBaseProviders,
    variants: manifest.variants.map((source) => source.provider),
    additionalProviderCount: manifest.additional.length,
    selectedSourceCount: sources.length,
    selectedProviders: sources.map((source) => source.provider),
  };
}

function caseLabel(testCase) {
  if (testCase.mediaType === "tv") {
    return `tv:${testCase.tmdbId}:s${testCase.seasonNumber}e${testCase.episodeNumber}`;
  }
  return `movie:${testCase.tmdbId}`;
}

function sourceDiscoveryUrl(baseOrigin, testCase) {
  const url = new URL("/api/resolve/sources", baseOrigin);
  url.searchParams.set("tmdbId", testCase.tmdbId);
  url.searchParams.set("mediaType", testCase.mediaType);
  url.searchParams.set("audioLang", "auto");
  url.searchParams.set("quality", "auto");
  url.searchParams.set("resolverProvider", "fastest");
  // Current servers prepend every external row ahead of the independently
  // limited torrent rows. A deliberately high request also avoids truncating
  // providers if that server-side cap is relaxed in a later release.
  url.searchParams.set("limit", "100");
  if (testCase.mediaType === "tv") {
    url.searchParams.set("seasonNumber", String(testCase.seasonNumber));
    url.searchParams.set("episodeNumber", String(testCase.episodeNumber));
  }
  return url;
}

function playerUrl(baseOrigin, testCase, sourceHash) {
  const path =
    testCase.mediaType === "tv"
      ? `/watch/tv/${testCase.tmdbId}/s${testCase.seasonNumber}e${testCase.episodeNumber}`
      : `/watch/movie/${testCase.tmdbId}`;
  const url = new URL(path, baseOrigin);
  url.searchParams.set("sourceHash", sourceHash);
  url.searchParams.set("benchmark", "1");
  url.searchParams.set("resolverProvider", "fastest");
  url.searchParams.set("audioLang", "auto");
  url.searchParams.set("quality", "auto");
  return url;
}

export function orderSources(sources, mode, trialIndex, caseIndex = 0) {
  const ordered = [...sources];
  if (mode === "reversed") return ordered.reverse();
  if (mode !== "rotated" || ordered.length < 2) return ordered;
  const offset = (Math.max(0, trialIndex) + Math.max(0, caseIndex)) % ordered.length;
  return [...ordered.slice(offset), ...ordered.slice(0, offset)];
}

export function classifyNetworkRoute(
  rawUrl,
  resourceType = "",
  baseOrigin = "",
  liveHlsWorkerOrigins = [],
) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const pathname = url.pathname;
  const apiBucket =
    pathname === "/api/resolve/movie" ||
    pathname === "/api/resolve/tv" ||
    pathname.startsWith("/api/resolve/job/")
      ? "resolve"
      : pathname === "/api/live/hls.m3u8"
        ? "liveHlsManifest"
        : pathname === "/api/live/hls-resource"
          ? "liveHlsResource"
          : pathname === "/api/remux"
            ? "remux"
            : pathname === "/api/hls/master.m3u8"
              ? "legacyHlsManifest"
              : pathname.startsWith("/api/hls/")
                ? "legacyHlsResource"
                : null;
  if (apiBucket) {
    if (baseOrigin && url.origin === baseOrigin) return apiBucket;
    const isLiveHlsWorkerRoute =
      apiBucket === "liveHlsManifest" || apiBucket === "liveHlsResource";
    return isLiveHlsWorkerRoute &&
      new Set(liveHlsWorkerOrigins).has(url.origin)
      ? apiBucket
      : null;
  }

  const type = String(resourceType || "").toLowerCase();
  const isKnownMediaPath =
    pathname.startsWith("/media/") ||
    pathname.startsWith("/videos/") ||
    pathname.startsWith("/assets/videos/") ||
    pathname.startsWith("/api/local-torrent/stream") ||
    pathname.startsWith("/api/local-cache/stream");
  if (isKnownMediaPath && (!baseOrigin || url.origin !== baseOrigin)) return null;
  const hasMediaExtension = /\.(?:m3u8|mpd|mp4|m4s|ts|aac|mkv|webm)$/i.test(pathname);
  const crossOriginMedia = Boolean(baseOrigin && url.origin !== baseOrigin && hasMediaExtension);
  return type === "media" || isKnownMediaPath || crossOriginMedia
    ? "directMedia"
    : null;
}

export function benchmarkFetchDecision(rawUrl, pageUrl, baseOrigin, method = "GET") {
  let url;
  let page;
  try {
    page = new URL(pageUrl);
    url = new URL(rawUrl, page);
  } catch {
    return "passthrough";
  }
  if (url.origin !== baseOrigin) return "passthrough";
  const normalizedMethod = String(method || "GET").toUpperCase();
  if (PROGRESS_PATHS.includes(url.pathname)) {
    return normalizedMethod === "GET" && url.pathname !== "/api/session/progress"
      ? "empty-progress-read"
      : "block-progress-mutation";
  }
  if (url.pathname !== "/api/resolve/movie" && url.pathname !== "/api/resolve/tv") {
    return "passthrough";
  }
  const pinnedHash = String(page.searchParams.get("sourceHash") || "")
    .trim()
    .toLowerCase();
  const requestedHash = String(url.searchParams.get("sourceHash") || "")
    .trim()
    .toLowerCase();
  return SOURCE_HASH_PATTERN.test(pinnedHash) && requestedHash === pinnedHash
    ? "allow-pinned-resolve"
    : "block-unpinned-resolve";
}

export function allResolveStartsAcknowledgeHealthSuppression(resolveStarts) {
  return (
    Array.isArray(resolveStarts) &&
    resolveStarts.length > 0 &&
    resolveStarts.every(
      (entry) =>
        entry?.requestPinned === true &&
        entry?.healthRecordingAcknowledgement ===
          PROVIDER_HEALTH_RECORDING_ACK_VALUE,
    )
  );
}

export function isSameOriginResolveStart(rawUrl, baseOrigin) {
  try {
    const url = new URL(rawUrl);
    return (
      url.origin === baseOrigin &&
      (url.pathname === "/api/resolve/movie" || url.pathname === "/api/resolve/tv")
    );
  } catch {
    return false;
  }
}

function installProviderBenchmarkBrowserGuards({ baseOrigin, headerName }) {
  const state = {
    blockedMutations: 0,
    emptyProgressReads: 0,
    blockedFallbackRequests: 0,
    benchmarkResolveHeadersApplied: 0,
  };
  Object.defineProperty(globalThis, "__STREAMARENA_PROVIDER_BENCHMARK_SAFETY__", {
    value: state,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const method = init?.method || (input instanceof Request ? input.method : "GET");
    const decision = benchmarkFetchDecision(rawUrl, location.href, baseOrigin, method);
    if (decision === "empty-progress-read") {
      state.emptyProgressReads += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ entries: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (decision === "block-progress-mutation") {
      state.blockedMutations += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, disabled: true, session: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (decision === "block-unpinned-resolve") {
      state.blockedFallbackRequests += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ error: "Pinned benchmark source only." }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (decision === "allow-pinned-resolve") {
      const absoluteUrl = new URL(rawUrl, location.href).toString();
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(absoluteUrl, init);
      const headers = new Headers(request.headers);
      headers.set(headerName, "1");
      state.benchmarkResolveHeadersApplied += 1;
      return nativeFetch(new Request(request, { headers }));
    }
    return nativeFetch(input, init);
  };

  const nativeSendBeacon = navigator.sendBeacon?.bind(navigator);
  if (nativeSendBeacon) {
    navigator.sendBeacon = (rawUrl, data) => {
      const decision = benchmarkFetchDecision(rawUrl, location.href, baseOrigin, "POST");
      if (decision === "block-progress-mutation") {
        state.blockedMutations += 1;
        return true;
      }
      if (decision === "allow-pinned-resolve" || decision === "block-unpinned-resolve") {
        state.blockedFallbackRequests += 1;
        return false;
      }
      return nativeSendBeacon(rawUrl, data);
    };
  }
}

export function buildProviderBenchmarkInitScript(baseOrigin) {
  return [
    `const SOURCE_HASH_PATTERN = ${SOURCE_HASH_PATTERN.toString()};`,
    `const PROGRESS_PATHS = ${JSON.stringify(PROGRESS_PATHS)};`,
    `const benchmarkFetchDecision = ${benchmarkFetchDecision.toString()};`,
    `(${installProviderBenchmarkBrowserGuards.toString()})(${JSON.stringify({
      baseOrigin,
      headerName: PROVIDER_BENCHMARK_HEADER,
    })});`,
  ].join("\n");
}

async function installProviderBenchmarkGuards(context, baseOrigin) {
  await context.addInitScript({ content: buildProviderBenchmarkInitScript(baseOrigin) });
}

export function classifyResponseRole(
  bucket,
  mimeType = "",
  resourceType = "",
  status = 0,
) {
  const statusCode = Number(status) || 0;
  if (statusCode >= 300 && statusCode < 400) return "redirect";
  if (statusCode >= 400) return "error";
  if (bucket === "resolve") return "api";
  if (bucket === "liveHlsManifest" || bucket === "legacyHlsManifest") {
    return "manifest";
  }
  const mime = String(mimeType || "").trim().toLowerCase();
  const playlistMime =
    mime.includes("mpegurl") ||
    mime.includes("dash+xml") ||
    mime.includes("application/x-mpegurl");
  if (playlistMime) {
    return bucket === "liveHlsResource" || bucket === "legacyHlsResource"
      ? "childManifest"
      : "manifest";
  }
  if (
    bucket === "liveHlsResource" ||
    bucket === "legacyHlsResource" ||
    bucket === "remux" ||
    bucket === "directMedia" ||
    String(resourceType || "").toLowerCase() === "media"
  ) {
    // Some providers deliberately label media chunks as PNG/octet-stream, so
    // the route role is more trustworthy than a video/* MIME check here.
    return "mediaResource";
  }
  return "other";
}

export function parseRemuxServerTiming(rawValue) {
  const parts = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const character of String(rawValue || "")) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && quoted) {
      current += character;
      escaped = true;
    } else if (character === '"') {
      current += character;
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  parts.push(current);

  const allowed = new Set(REMUX_SERVER_TIMING_METRICS);
  const parsed = {};
  for (const part of parts) {
    const [rawName, ...parameters] = part.split(";");
    const name = String(rawName || "").trim().toLowerCase();
    if (!allowed.has(name)) continue;
    const durationParameter = parameters.find((parameter) =>
      /^\s*dur\s*=/i.test(parameter),
    );
    const durationMatch = /^\s*dur\s*=\s*(\d+(?:\.\d+)?)\s*$/i.exec(
      durationParameter || "",
    );
    if (!durationMatch) continue;
    const durationMs = Number(durationMatch[1]);
    if (!Number.isFinite(durationMs) || durationMs < 0) continue;
    parsed[name] = Number(durationMs.toFixed(3));
  }
  return parsed;
}

function responseHeaderValue(headers, targetName) {
  const normalizedTarget = String(targetName || "").toLowerCase();
  for (const [name, value] of Object.entries(headers || {})) {
    if (String(name).toLowerCase() === normalizedTarget) return String(value);
  }
  return "";
}

function percentile(values, percentileValue) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!finite.length) return null;
  const index = Math.max(
    0,
    Math.min(finite.length - 1, Math.ceil((percentileValue / 100) * finite.length) - 1),
  );
  return Number(finite[index].toFixed(1));
}

function median(values) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!finite.length) return null;
  const middle = Math.floor(finite.length / 2);
  const value =
    finite.length % 2 === 0
      ? (finite[middle - 1] + finite[middle]) / 2
      : finite[middle];
  return Number(value.toFixed(1));
}

function emptyNetworkBucket() {
  return {
    requestCount: 0,
    responseCount: 0,
    failedCount: 0,
    statuses: {},
    ttfbSamples: [],
    durationSamples: [],
    receivedBytes: 0,
    encodedBytes: 0,
    firstResponseAtMs: null,
    firstManifestResponseAtMs: null,
    firstChildManifestResponseAtMs: null,
    firstMediaResponseAtMs: null,
    responseRoles: {},
    serverTimingSamples: Object.fromEntries(
      REMUX_SERVER_TIMING_METRICS.map((name) => [name, []]),
    ),
  };
}

export function createNetworkCapture(
  page,
  baseOrigin,
  trialStartedEpochMs,
  liveHlsWorkerOrigins = [],
) {
  const buckets = Object.fromEntries(
    NETWORK_BUCKETS.map((bucket) => [bucket, emptyNetworkBucket()]),
  );
  const requests = new Map();
  let cdpSession;

  function cdpDeltaMs(record, eventTimestamp) {
    const eventTimestampMs = Number(eventTimestamp) * 1_000;
    if (!Number.isFinite(eventTimestampMs)) return null;
    return Math.max(0, eventTimestampMs - record.startedAtCdpMs);
  }

  function eventAtTrialMs(record, eventTimestamp) {
    const deltaMs = cdpDeltaMs(record, eventTimestamp);
    if (!Number.isFinite(deltaMs)) return null;
    return Number((record.startedAtTrialMs + deltaMs).toFixed(1));
  }

  function retainRecordBytes(record) {
    if (!record || record.bytesRetained) return;
    record.bytesRetained = true;
    const bucket = buckets[record.bucket];
    bucket.receivedBytes += Math.round(record.receivedBytes);
    bucket.encodedBytes += Math.round(record.encodedBytes);
  }

  function registerResponse(
    record,
    status,
    mimeType = "",
    headers = {},
    eventTimestamp,
  ) {
    if (!record || record.responded) return;
    record.responded = true;
    const bucket = buckets[record.bucket];
    const ttfbMs = cdpDeltaMs(record, eventTimestamp);
    const responseAtMs = eventAtTrialMs(record, eventTimestamp);
    bucket.responseCount += 1;
    const statusKey = String(Math.floor(Number(status) || 0));
    bucket.statuses[statusKey] = (bucket.statuses[statusKey] || 0) + 1;
    if (Number.isFinite(ttfbMs)) bucket.ttfbSamples.push(ttfbMs);
    if (
      Number.isFinite(responseAtMs) &&
      (bucket.firstResponseAtMs === null || responseAtMs < bucket.firstResponseAtMs)
    ) {
      bucket.firstResponseAtMs = responseAtMs;
    }
    const role = classifyResponseRole(
      record.bucket,
      mimeType,
      record.resourceType,
      status,
    );
    bucket.responseRoles[role] = (bucket.responseRoles[role] || 0) + 1;
    if (
      role === "manifest" &&
      Number.isFinite(responseAtMs) &&
      (bucket.firstManifestResponseAtMs === null ||
        responseAtMs < bucket.firstManifestResponseAtMs)
    ) {
      bucket.firstManifestResponseAtMs = responseAtMs;
    }
    if (
      role === "childManifest" &&
      Number.isFinite(responseAtMs) &&
      (bucket.firstChildManifestResponseAtMs === null ||
        responseAtMs < bucket.firstChildManifestResponseAtMs)
    ) {
      bucket.firstChildManifestResponseAtMs = responseAtMs;
    }
    if (
      role === "mediaResource" &&
      Number.isFinite(responseAtMs) &&
      (bucket.firstMediaResponseAtMs === null ||
        responseAtMs < bucket.firstMediaResponseAtMs)
    ) {
      bucket.firstMediaResponseAtMs = responseAtMs;
    }
    if (record.bucket === "remux") {
      const timings = parseRemuxServerTiming(
        responseHeaderValue(headers, "server-timing"),
      );
      for (const [name, durationMs] of Object.entries(timings)) {
        bucket.serverTimingSamples[name].push(durationMs);
      }
    }
  }

  return {
    async start() {
      cdpSession = await page.context().newCDPSession(page);
      await cdpSession.send("Network.enable");
      cdpSession.on("Network.requestWillBeSent", (event) => {
        const previous = requests.get(event.requestId);
        if (event.redirectResponse && previous) {
          registerResponse(
            previous,
            event.redirectResponse.status,
            event.redirectResponse.mimeType,
            event.redirectResponse.headers,
            event.timestamp,
          );
          const redirectDurationMs = cdpDeltaMs(previous, event.timestamp);
          if (Number.isFinite(redirectDurationMs)) {
            buckets[previous.bucket].durationSamples.push(redirectDurationMs);
          }
          retainRecordBytes(previous);
        }
        const bucket = classifyNetworkRoute(
          event.request?.url,
          event.type,
          baseOrigin,
          liveHlsWorkerOrigins,
        );
        if (!bucket) {
          requests.delete(event.requestId);
          return;
        }
        buckets[bucket].requestCount += 1;
        const startedAtCdpMs = Number(event.timestamp) * 1_000;
        const startedAtEpochMs = Number(event.wallTime) * 1_000;
        requests.set(event.requestId, {
          bucket,
          startedAtCdpMs,
          startedAtTrialMs: Number.isFinite(startedAtEpochMs)
            ? Math.max(0, startedAtEpochMs - trialStartedEpochMs)
            : 0,
          resourceType: event.type,
          responded: false,
          receivedBytes: 0,
          encodedBytes: 0,
          bytesRetained: false,
        });
      });
      cdpSession.on("Network.responseReceived", (event) => {
        registerResponse(
          requests.get(event.requestId),
          event.response?.status,
          event.response?.mimeType,
          event.response?.headers,
          event.timestamp,
        );
      });
      cdpSession.on("Network.dataReceived", (event) => {
        const record = requests.get(event.requestId);
        if (!record) return;
        record.receivedBytes += Math.max(0, Number(event.dataLength || 0));
        record.encodedBytes += Math.max(0, Number(event.encodedDataLength || 0));
      });
      cdpSession.on("Network.loadingFinished", (event) => {
        const record = requests.get(event.requestId);
        if (!record) return;
        const bucket = buckets[record.bucket];
        const durationMs = cdpDeltaMs(record, event.timestamp);
        if (Number.isFinite(durationMs)) bucket.durationSamples.push(durationMs);
        record.encodedBytes = Math.max(
          record.encodedBytes,
          Number(event.encodedDataLength || 0),
        );
        retainRecordBytes(record);
        requests.delete(event.requestId);
      });
      cdpSession.on("Network.loadingFailed", (event) => {
        const record = requests.get(event.requestId);
        if (!record) return;
        const bucket = buckets[record.bucket];
        bucket.failedCount += 1;
        const durationMs = cdpDeltaMs(record, event.timestamp);
        if (Number.isFinite(durationMs)) bucket.durationSamples.push(durationMs);
        retainRecordBytes(record);
        requests.delete(event.requestId);
      });
    },
    async finish() {
      for (const record of requests.values()) {
        retainRecordBytes(record);
      }
      if (cdpSession) {
        await cdpSession.detach().catch(() => {});
      }
      return Object.fromEntries(
        NETWORK_BUCKETS.map((name) => {
          const bucket = buckets[name];
          return [
            name,
            {
              requestCount: bucket.requestCount,
              responseCount: bucket.responseCount,
              failedCount: bucket.failedCount,
              statuses: Object.fromEntries(
                Object.entries(bucket.statuses).sort(([left], [right]) => Number(left) - Number(right)),
              ),
              ttfbMs: {
                median: median(bucket.ttfbSamples),
                p95: percentile(bucket.ttfbSamples, 95),
              },
              durationMs: {
                median: median(bucket.durationSamples),
                p95: percentile(bucket.durationSamples, 95),
              },
              firstResponseAtMs: bucket.firstResponseAtMs,
              firstManifestResponseAtMs: bucket.firstManifestResponseAtMs,
              firstChildManifestResponseAtMs:
                bucket.firstChildManifestResponseAtMs,
              firstMediaResponseAtMs: bucket.firstMediaResponseAtMs,
              responseRoles: Object.fromEntries(
                Object.entries(bucket.responseRoles).sort(([left], [right]) =>
                  left.localeCompare(right),
                ),
              ),
              serverTimingMs:
                name === "remux"
                  ? Object.fromEntries(
                      REMUX_SERVER_TIMING_METRICS.flatMap((metricName) => {
                        const samples = bucket.serverTimingSamples[metricName];
                        return samples.length
                          ? [
                              [
                                metricName,
                                {
                                  samples: samples.length,
                                  median: median(samples),
                                  p95: percentile(samples, 95),
                                },
                              ],
                            ]
                          : [];
                      }),
                    )
                  : {},
              receivedBytes: Math.max(0, bucket.receivedBytes),
              encodedBytes: Math.max(0, bucket.encodedBytes),
            },
          ];
        }),
      );
    },
  };
}

function extractResolvedIdentity(payload) {
  const candidate = payload?.result && typeof payload.result === "object"
    ? payload.result
    : payload;
  const hash = String(candidate?.sourceHash || "").trim().toLowerCase();
  const provider = String(
    candidate?.resolverProvider ||
      candidate?.metadata?.resolverProvider ||
      candidate?.session?.resolverProvider ||
      "",
  )
    .trim()
    .toLowerCase();
  return {
    hash: SOURCE_HASH_PATTERN.test(hash) ? hash : "",
    provider,
  };
}

function createResolveObserver(
  page,
  baseOrigin,
  requestedHash,
  testCase,
  trialStartedAt,
  deadline,
) {
  const observations = [];
  const parsers = [];

  function isRelevantResponse(response) {
    try {
      const url = new URL(response.url());
      return (
        url.origin === baseOrigin &&
        (url.pathname === `/api/resolve/${testCase.mediaType}` ||
          url.pathname.startsWith("/api/resolve/job/"))
      );
    } catch {
      return false;
    }
  }

  const onResponse = (response) => {
    if (!isRelevantResponse(response)) return;
    const parser = (async () => {
      let pathname = "";
      let requestHash = "";
      try {
        const url = new URL(response.url());
        pathname = url.pathname;
        if (pathname === `/api/resolve/${testCase.mediaType}`) {
          requestHash = String(url.searchParams.get("sourceHash") || "")
            .trim()
            .toLowerCase();
        }
      } catch {
        return;
      }
      const observation = {
        isResolveStart: pathname === `/api/resolve/${testCase.mediaType}`,
        requestPinned: pathname.startsWith("/api/resolve/job/") || requestHash === requestedHash,
        healthRecordingAcknowledgement: String(
          response.headers()[PROVIDER_HEALTH_RECORDING_ACK_HEADER] || "",
        ),
        status: response.status(),
        resolvedHash: "",
        resolverProvider: "",
        identityCompletedAtMs: null,
      };
      if (response.ok()) {
        try {
          const identity = extractResolvedIdentity(
            await runWithDeadline(
              () => response.json(),
              deadline,
              "RESOLVE_IDENTITY_TIMEOUT",
            ),
          );
          observation.resolvedHash = identity.hash;
          observation.resolverProvider = identity.provider;
          if (identity.hash) {
            observation.identityCompletedAtMs = Number(
              (performance.now() - trialStartedAt).toFixed(1),
            );
          }
        } catch {
          // A non-JSON/empty successful response cannot establish source identity.
        }
      }
      observations.push(observation);
    })();
    parsers.push(parser);
  };
  page.on("response", onResponse);

  return {
    async result() {
      page.off("response", onResponse);
      await Promise.allSettled([...parsers]);
      const starts = observations.filter((entry) => entry.isResolveStart);
      const identities = observations.filter((entry) => entry.resolvedHash);
      const matchingIdentities = identities.filter(
        (entry) =>
          entry.resolvedHash === requestedHash &&
          entry.resolverProvider === EXTERNAL_RESOLVER_PROVIDER,
      );
      const completionSamples = matchingIdentities
        .map((entry) => entry.identityCompletedAtMs)
        .filter(Number.isFinite);
      return {
        resolveRequestCount: starts.length,
        allResolveStartsAcknowledged:
          allResolveStartsAcknowledgeHealthSuppression(starts),
        fallbackDetected: starts.some((entry) => !entry.requestPinned),
        hashMatched: identities.some((entry) => entry.resolvedHash === requestedHash),
        hashMismatchDetected: identities.some(
          (entry) => entry.resolvedHash !== requestedHash,
        ),
        providerMatched: identities.some(
          (entry) =>
            entry.resolvedHash === requestedHash &&
            entry.resolverProvider === EXTERNAL_RESOLVER_PROVIDER,
        ),
        providerMismatchDetected: identities.some(
          (entry) =>
            entry.resolvedHash === requestedHash &&
            entry.resolverProvider !== EXTERNAL_RESOLVER_PROVIDER,
        ),
        successfulResolveResponse: observations.some(
          (entry) => entry.status >= 200 && entry.status < 300,
        ),
        resolveCompletionMs: completionSamples.length
          ? Math.min(...completionSamples)
          : null,
      };
    },
  };
}

function safeBenchmarkSnapshot(snapshot) {
  const timings = snapshot?.timings || {};
  const counters = snapshot?.counters || {};
  const quality = snapshot?.quality || {};
  const frameStats = snapshot?.frameStats || {};
  const videoMetrics = snapshot?.videoMetrics || {};
  const finiteOrNull = (value) =>
    Number.isFinite(Number(value)) ? Number(value) : null;
  const count = (value) => Math.max(0, Math.floor(Number(value) || 0));
  return {
    capturedAtMs: finiteOrNull(snapshot?.capturedAtMs),
    currentTime: finiteOrNull(snapshot?.currentTime),
    readyState: count(snapshot?.readyState),
    networkState: count(snapshot?.networkState),
    paused: Boolean(snapshot?.paused),
    playbackMode: sanitizeProviderLabel(snapshot?.source?.mode, "unknown"),
    video: {
      width: count(videoMetrics.videoWidth),
      height: count(videoMetrics.videoHeight),
      clientWidth: count(videoMetrics.clientWidth),
      clientHeight: count(videoMetrics.clientHeight),
    },
    milestones: {
      loadedMetadataMs: finiteOrNull(timings.firstLoadedMetadataMs),
      canPlayMs: finiteOrNull(timings.firstCanPlayMs),
      playingMs: finiteOrNull(timings.firstPlayingMs),
      firstTimeUpdateMs: finiteOrNull(timings.firstTimeUpdateMs),
      firstFrameMs: finiteOrNull(timings.firstVideoFrameMs),
    },
    events: {
      loadedMetadata: count(counters.loadedmetadata),
      canPlay: count(counters.canplay),
      playing: count(counters.playing),
      waiting: count(counters.waiting),
      stalled: count(counters.stalled),
      errors: count(counters.error),
    },
    frames: {
      decoded: count(quality.totalVideoFrames),
      dropped: count(quality.droppedVideoFrames),
      corrupted: count(quality.corruptedVideoFrames),
      callbacks: count(frameStats.callbackCount),
      estimatedFps: finiteOrNull(frameStats.estimatedFrameRateFps),
      maxFrameIntervalMs: finiteOrNull(frameStats.maxFrameIntervalMs),
    },
  };
}

export function alignBenchmarkMilestones(
  snapshot,
  clock,
  trialStartedEpochMs,
) {
  const capturedAtMs = Number(snapshot?.capturedAtMs);
  const pageNowMs = Number(clock?.nowMs);
  const pageTimeOriginMs = Number(clock?.timeOriginMs);
  if (
    !Number.isFinite(capturedAtMs) ||
    !Number.isFinite(pageNowMs) ||
    !Number.isFinite(pageTimeOriginMs) ||
    !Number.isFinite(Number(trialStartedEpochMs))
  ) {
    return {
      apiOriginTrialMs: null,
      loadedMetadataMs: null,
      canPlayMs: null,
      playingMs: null,
      firstTimeUpdateMs: null,
      firstFrameMs: null,
    };
  }
  // The benchmark API starts after navigation. Convert its relative timings
  // to the Node trial clock using the page's time origin and current clock.
  const apiOriginFromNavigationMs = pageNowMs - capturedAtMs;
  const navigationOriginTrialMs = pageTimeOriginMs - Number(trialStartedEpochMs);
  const apiOriginTrialMs = navigationOriginTrialMs + apiOriginFromNavigationMs;
  const aligned = (value) => {
    const number = Number(value);
    return Number.isFinite(number)
      ? Number((apiOriginTrialMs + number).toFixed(1))
      : null;
  };
  return {
    apiOriginTrialMs: Number(apiOriginTrialMs.toFixed(1)),
    loadedMetadataMs: aligned(snapshot?.milestones?.loadedMetadataMs),
    canPlayMs: aligned(snapshot?.milestones?.canPlayMs),
    playingMs: aligned(snapshot?.milestones?.playingMs),
    firstTimeUpdateMs: aligned(snapshot?.milestones?.firstTimeUpdateMs),
    firstFrameMs: aligned(snapshot?.milestones?.firstFrameMs),
  };
}

async function readPlayerState(page) {
  return page.evaluate(() => {
    const api = window.__STREAMARENA_PLAYBACK_BENCHMARK__;
    const snapshot = api?.getSnapshot?.() || null;
    const video = document.querySelector("video");
    let bufferAheadSeconds = 0;
    if (video) {
      const currentTime = Number(video.currentTime || 0);
      for (let index = 0; index < video.buffered.length; index += 1) {
        const start = Number(video.buffered.start(index));
        const end = Number(video.buffered.end(index));
        if (currentTime >= start && currentTime <= end) {
          bufferAheadSeconds = Math.max(bufferAheadSeconds, end - currentTime);
        }
      }
    }
    return {
      snapshot,
      clock: {
        timeOriginMs: Number(performance.timeOrigin),
        nowMs: Number(performance.now()),
      },
      bufferAheadSeconds: Number.isFinite(bufferAheadSeconds)
        ? Number(bufferAheadSeconds.toFixed(3))
        : 0,
      mediaErrorCode: Number(video?.error?.code || 0) || 0,
    };
  });
}

function remainingMs(deadline) {
  return Math.max(1, Math.floor(deadline - performance.now()));
}

function playerSample(rawState) {
  return {
    observedAtMs: performance.now(),
    rawState,
    snapshot: safeBenchmarkSnapshot(rawState?.snapshot),
  };
}

function hasPlayableState(sample) {
  const snapshot = sample?.snapshot;
  return Boolean(
    snapshot &&
      snapshot.readyState >= 3 &&
      !snapshot.paused &&
      snapshot.video.width > 0 &&
      snapshot.video.height > 0 &&
      snapshot.events.errors === 0 &&
      Number(sample?.rawState?.mediaErrorCode || 0) === 0,
  );
}

function pairAdvanced(previous, current) {
  const previousSnapshot = previous?.snapshot;
  const currentSnapshot = current?.snapshot;
  if (!previousSnapshot || !currentSnapshot) return false;
  const timeAdvanced =
    Number(currentSnapshot.currentTime || 0) >
    Number(previousSnapshot.currentTime || 0) + 0.001;
  const framesAdvanced =
    currentSnapshot.frames.decoded > previousSnapshot.frames.decoded ||
    currentSnapshot.frames.callbacks > previousSnapshot.frames.callbacks;
  return timeAdvanced && framesAdvanced;
}

export function summarizePlaybackWindow(startSample, endSample, sampleCount) {
  const start = startSample?.snapshot || safeBenchmarkSnapshot(null);
  const end = endSample?.snapshot || safeBenchmarkSnapshot(null);
  return {
    sampledDurationMs: Number(
      Math.max(
        0,
        Number(endSample?.observedAtMs || 0) -
          Number(startSample?.observedAtMs || 0),
      ).toFixed(1),
    ),
    mediaTimeDeltaSeconds: Number(
      Math.max(
        0,
        Number(end.currentTime || 0) - Number(start.currentTime || 0),
      ).toFixed(3),
    ),
    decodedFrameDelta: Math.max(0, end.frames.decoded - start.frames.decoded),
    frameCallbackDelta: Math.max(
      0,
      end.frames.callbacks - start.frames.callbacks,
    ),
    droppedFrameDelta: Math.max(0, end.frames.dropped - start.frames.dropped),
    waitingDelta: Math.max(0, end.events.waiting - start.events.waiting),
    stalledDelta: Math.max(0, end.events.stalled - start.events.stalled),
    sampleCount: Math.max(0, Math.floor(Number(sampleCount) || 0)),
  };
}

async function takePlayerSample(page) {
  return playerSample(await readPlayerState(page));
}

async function waitForContinuousPlayback(
  page,
  { windowMs, deadline, sampleIntervalMs = 250 },
) {
  let windowStart = null;
  let previous = null;
  let sampleCount = 0;
  while (performance.now() < deadline) {
    const current = await takePlayerSample(page);
    if (!hasPlayableState(current)) {
      windowStart = null;
      previous = null;
      sampleCount = 0;
    } else if (!windowStart) {
      windowStart = current;
      previous = current;
      sampleCount = 1;
    } else {
      const eventFree =
        current.snapshot.events.waiting ===
          windowStart.snapshot.events.waiting &&
        current.snapshot.events.stalled ===
          windowStart.snapshot.events.stalled;
      const samplingGapMs = current.observedAtMs - previous.observedAtMs;
      const sampledContinuously =
        samplingGapMs <= Math.max(1_000, sampleIntervalMs * 4) &&
        pairAdvanced(previous, current);
      if (!eventFree || !sampledContinuously) {
        windowStart = current;
        previous = current;
        sampleCount = 1;
      } else {
        previous = current;
        sampleCount += 1;
        const proof = summarizePlaybackWindow(
          windowStart,
          current,
          sampleCount,
        );
        const requiredMediaAdvance = Math.max(0.05, windowMs / 1000);
        if (
          proof.sampledDurationMs >= windowMs &&
          proof.mediaTimeDeltaSeconds >= requiredMediaAdvance &&
          (proof.decodedFrameDelta > 0 || proof.frameCallbackDelta > 0) &&
          proof.waitingDelta === 0 &&
          proof.stalledDelta === 0
        ) {
          return { endSample: current, proof };
        }
      }
    }
    const waitMs = Math.min(sampleIntervalMs, remainingMs(deadline));
    await delay(waitMs);
  }
  throw benchmarkError("CONTINUOUS_PLAYBACK_TIMEOUT");
}

async function measureSteadyPlayback(
  page,
  startSample,
  { durationMs, deadline, sampleIntervalMs = 250 },
) {
  if (durationMs === 0) {
    return {
      endSample: startSample,
      proof: {
        ...summarizePlaybackWindow(startSample, startSample, 1),
        maxNoAdvanceMs: 0,
        verified: true,
      },
    };
  }
  if (performance.now() + durationMs >= deadline) {
    throw benchmarkError("STEADY_WINDOW_TIMEOUT");
  }
  const expectedEndAt = performance.now() + durationMs;
  let previous = startSample;
  let endSample = startSample;
  let sampleCount = 1;
  let lastAdvanceAtMs = startSample.observedAtMs;
  let maxNoAdvanceMs = 0;
  while (performance.now() < expectedEndAt) {
    await delay(
      Math.min(sampleIntervalMs, expectedEndAt - performance.now()),
    );
    endSample = await takePlayerSample(page);
    sampleCount += 1;
    if (hasPlayableState(endSample) && pairAdvanced(previous, endSample)) {
      lastAdvanceAtMs = endSample.observedAtMs;
    } else {
      maxNoAdvanceMs = Math.max(
        maxNoAdvanceMs,
        endSample.observedAtMs - lastAdvanceAtMs,
      );
    }
    previous = endSample;
  }
  const proof = {
    ...summarizePlaybackWindow(startSample, endSample, sampleCount),
    maxNoAdvanceMs: Number(maxNoAdvanceMs.toFixed(1)),
    verified: false,
  };
  const minimumAdvanceSeconds = Math.max(0.05, (durationMs / 1000) * 0.8);
  proof.verified = Boolean(
    hasPlayableState(endSample) &&
      proof.mediaTimeDeltaSeconds >= minimumAdvanceSeconds &&
      (proof.decodedFrameDelta > 0 || proof.frameCallbackDelta > 0) &&
      proof.maxNoAdvanceMs <= Math.max(1_000, sampleIntervalMs * 4),
  );
  return { endSample, proof };
}

async function runTrial({
  context,
  baseOrigin,
  liveHlsWorkerOrigins,
  testCase,
  source,
  trialNumber,
  options,
  safetyStats,
}) {
  const page = await context.newPage();
  const trialStartedAt = performance.now();
  const trialStartedEpochMs = Date.now();
  const deadline = trialStartedAt + options.timeoutMs;
  const networkCapture = createNetworkCapture(
    page,
    baseOrigin,
    trialStartedEpochMs,
    liveHlsWorkerOrigins,
  );
  const resolveObserver = createResolveObserver(
    page,
    baseOrigin,
    source.hash,
    testCase,
    trialStartedAt,
    deadline,
  );
  const diagnostics = { pageErrorCount: 0, requestFailureCount: 0 };
  const navigation = { domContentLoadedMs: null, loadMs: null };
  let finalSample = null;
  let continuousProof = null;
  let steadyProof = null;
  let advanceReachedAtMs = null;
  let steadyCompletedAtMs = null;
  let trialErrorCode = "";

  page.on("pageerror", () => {
    diagnostics.pageErrorCount += 1;
  });
  page.on("requestfailed", (request) => {
    if (
      classifyNetworkRoute(
        request.url(),
        request.resourceType(),
        baseOrigin,
        liveHlsWorkerOrigins,
      )
    ) {
      diagnostics.requestFailureCount += 1;
    }
  });
  page.once("domcontentloaded", () => {
    navigation.domContentLoadedMs = Number(
      (performance.now() - trialStartedAt).toFixed(1),
    );
  });
  page.once("load", () => {
    navigation.loadMs = Number((performance.now() - trialStartedAt).toFixed(1));
  });

  await networkCapture.start();
  try {
    await page.goto(playerUrl(baseOrigin, testCase, source.hash).toString(), {
      waitUntil: "domcontentloaded",
      timeout: remainingMs(deadline),
    });
    await page.waitForFunction(
      () => Boolean(window.__STREAMARENA_PLAYBACK_BENCHMARK__?.getSnapshot),
      undefined,
      { timeout: remainingMs(deadline) },
    );
    await page.evaluate(() => {
      const video = document.querySelector("video");
      if (video) video.muted = true;
      const api = window.__STREAMARENA_PLAYBACK_BENCHMARK__;
      try {
        const playAttempt = api?.play?.();
        if (playAttempt?.catch) playAttempt.catch(() => {});
      } catch {
        // The sampled proof below reports a failed/synchronous play attempt.
      }
    });
    const continuous = await waitForContinuousPlayback(page, {
      windowMs: Math.max(DEFAULT_ADVANCE_MS, options.advanceMs),
      deadline,
    });
    advanceReachedAtMs = Number((performance.now() - trialStartedAt).toFixed(1));
    continuousProof = continuous.proof;
    const steady = await measureSteadyPlayback(page, continuous.endSample, {
      durationMs: options.steadyMs,
      deadline,
    });
    steadyCompletedAtMs = Number((performance.now() - trialStartedAt).toFixed(1));
    finalSample = steady.endSample;
    steadyProof = steady.proof;
  } catch (error) {
    trialErrorCode = errorCode(error, "PLAYBACK_TIMEOUT");
    finalSample = await readPlayerState(page)
      .then((state) => playerSample(state))
      .catch(() => null);
  }

  await page.evaluate(() => document.querySelector("video")?.pause()).catch(() => {});
  const browserSafety = await page
    .evaluate(() => ({
      blockedMutations: Number(
        window.__STREAMARENA_PROVIDER_BENCHMARK_SAFETY__?.blockedMutations || 0,
      ),
      emptyProgressReads: Number(
        window.__STREAMARENA_PROVIDER_BENCHMARK_SAFETY__?.emptyProgressReads || 0,
      ),
      blockedFallbackRequests: Number(
        window.__STREAMARENA_PROVIDER_BENCHMARK_SAFETY__?.blockedFallbackRequests || 0,
      ),
      benchmarkResolveHeadersApplied: Number(
        window.__STREAMARENA_PROVIDER_BENCHMARK_SAFETY__
          ?.benchmarkResolveHeadersApplied || 0,
      ),
    }))
    .catch(() => ({
      blockedMutations: 0,
      emptyProgressReads: 0,
      blockedFallbackRequests: 0,
      benchmarkResolveHeadersApplied: 0,
    }));
  safetyStats.blockedMutations += browserSafety.blockedMutations;
  safetyStats.emptyProgressReads += browserSafety.emptyProgressReads;
  const observedPinning = await resolveObserver.result();
  const {
    allResolveStartsAcknowledged,
    ...pinning
  } = observedPinning;
  safetyStats.providerHealthSuppressionAcknowledged =
    safetyStats.providerHealthSuppressionAcknowledged &&
    allResolveStartsAcknowledged;
  pinning.fallbackDetected =
    pinning.fallbackDetected || browserSafety.blockedFallbackRequests > 0;
  const routes = await networkCapture.finish();
  await page.close().catch(() => {});
  const finalState = finalSample?.rawState;
  const snapshot = finalSample?.snapshot || safeBenchmarkSnapshot(null);
  const milestones = alignBenchmarkMilestones(
    snapshot,
    finalState?.clock,
    trialStartedEpochMs,
  );
  const continuousWindowMs = Math.max(DEFAULT_ADVANCE_MS, options.advanceMs);
  const failureCodes = [];
  if (trialErrorCode) failureCodes.push(trialErrorCode);
  if (pinning.resolveRequestCount === 0) failureCodes.push("NO_PINNED_RESOLVE");
  if (
    pinning.resolveRequestCount === 0 ||
    browserSafety.benchmarkResolveHeadersApplied < pinning.resolveRequestCount
  ) {
    failureCodes.push("BENCHMARK_HEADER_NOT_APPLIED");
  }
  if (!allResolveStartsAcknowledged) {
    failureCodes.push("PROVIDER_HEALTH_SUPPRESSION_NOT_ACKNOWLEDGED");
  }
  if (!pinning.successfulResolveResponse) failureCodes.push("RESOLVE_FAILED");
  if (!pinning.hashMatched || pinning.hashMismatchDetected) failureCodes.push("PIN_MISMATCH");
  if (!pinning.providerMatched || pinning.providerMismatchDetected) {
    failureCodes.push("PROVIDER_MISMATCH");
  }
  if (pinning.fallbackDetected) failureCodes.push("FALLBACK_DETECTED");
  if (snapshot.events.errors > 0 || Number(finalState?.mediaErrorCode || 0) > 0) {
    failureCodes.push("MEDIA_ERROR");
  }
  if (snapshot.readyState < 3) failureCodes.push("READY_STATE_TOO_LOW");
  if (snapshot.paused) failureCodes.push("PLAYBACK_PAUSED");
  if (snapshot.video.width <= 0 || snapshot.video.height <= 0) {
    failureCodes.push("NO_VIDEO_DIMENSIONS");
  }
  if (snapshot.frames.callbacks <= 0 && snapshot.frames.decoded <= 0) {
    failureCodes.push("NO_DECODED_FRAMES");
  }
  if (advanceReachedAtMs === null) failureCodes.push("ADVANCE_TARGET_NOT_REACHED");
  if (
    !continuousProof ||
    continuousProof.sampledDurationMs < continuousWindowMs ||
    continuousProof.mediaTimeDeltaSeconds <
      Math.max(0.05, continuousWindowMs / 1000) ||
    (continuousProof.decodedFrameDelta <= 0 &&
      continuousProof.frameCallbackDelta <= 0) ||
    continuousProof.waitingDelta !== 0 ||
    continuousProof.stalledDelta !== 0
  ) {
    failureCodes.push("CONTINUOUS_PLAYBACK_NOT_PROVEN");
  }
  if (steadyCompletedAtMs === null) failureCodes.push("STEADY_WINDOW_INCOMPLETE");
  if (!steadyProof?.verified) failureCodes.push("STEADY_PLAYBACK_NOT_ADVANCING");

  const uniqueFailures = [...new Set(failureCodes)];
  const result = {
    case: caseLabel(testCase),
    mediaType: testCase.mediaType,
    provider: source.provider,
    providerKind: source.kind,
    baseProvider: source.baseProvider || null,
    eligible: true,
    trial: trialNumber,
    success: uniqueFailures.length === 0,
    failureCodes: uniqueFailures,
    pinning,
    timings: {
      navigationDomContentLoadedMs: navigation.domContentLoadedMs,
      loadMs: navigation.loadMs,
      resolveFirstResponseMs: routes.resolve.firstResponseAtMs,
      resolveCompletionMs: pinning.resolveCompletionMs,
      benchmarkApiOriginMs: milestones.apiOriginTrialMs,
      loadedMetadataMs: milestones.loadedMetadataMs,
      canPlayMs: milestones.canPlayMs,
      playingMs: milestones.playingMs,
      firstTimeUpdateMs: milestones.firstTimeUpdateMs,
      firstFrameMs: milestones.firstFrameMs,
      advanceTargetMs: advanceReachedAtMs,
      steadyCompletedMs: steadyCompletedAtMs,
    },
    playback: {
      currentTime: snapshot.currentTime,
      readyState: snapshot.readyState,
      networkState: snapshot.networkState,
      mode: snapshot.playbackMode,
      width: snapshot.video.width,
      height: snapshot.video.height,
      decodedFrames: snapshot.frames.decoded,
      droppedFrames: snapshot.frames.dropped,
      corruptedFrames: snapshot.frames.corrupted,
      frameCallbacks: snapshot.frames.callbacks,
      estimatedFps: snapshot.frames.estimatedFps,
      maxFrameIntervalMs: snapshot.frames.maxFrameIntervalMs,
      waitingCount: snapshot.events.waiting,
      stalledCount: snapshot.events.stalled,
      errorCount: snapshot.events.errors,
      bufferAheadSeconds: Number(finalState?.bufferAheadSeconds || 0),
      continuous: continuousProof
        ? { requestedDurationMs: continuousWindowMs, ...continuousProof }
        : null,
      steady: steadyProof
        ? { requestedDurationMs: options.steadyMs, ...steadyProof }
        : null,
    },
    routes,
    diagnostics,
    safety: {
      blockedMutations: browserSafety.blockedMutations,
      emptyProgressReads: browserSafety.emptyProgressReads,
    },
  };

  return result;
}

export function aggregateTrials(trials, mediaType = "") {
  const groups = new Map();
  for (const trial of trials) {
    if (mediaType && trial.mediaType !== mediaType) continue;
    const label = sanitizeProviderLabel(trial.provider);
    const group = groups.get(label) || [];
    group.push(trial);
    groups.set(label, group);
  }
  const ranking = [...groups.entries()].map(([provider, entries]) => {
    const successes = entries.filter((entry) => entry.success);
    const firstFrames = successes.map((entry) => entry.timings?.firstFrameMs);
    const stalls = entries.reduce(
      (total, entry) =>
        total +
        Number(entry.playback?.waitingCount || 0) +
        Number(entry.playback?.stalledCount || 0),
      0,
    );
    const droppedFrames = entries.reduce(
      (total, entry) => total + Number(entry.playback?.droppedFrames || 0),
      0,
    );
    return {
      provider,
      trials: entries.length,
      successes: successes.length,
      successRate: Number((successes.length / entries.length).toFixed(4)),
      medianFirstFrameMs: median(firstFrames),
      p95FirstFrameMs: percentile(firstFrames, 95),
      stalls,
      droppedFrames,
    };
  });
  ranking.sort((left, right) => {
    return (
      right.successRate - left.successRate ||
      (left.medianFirstFrameMs ?? Number.POSITIVE_INFINITY) -
        (right.medianFirstFrameMs ?? Number.POSITIVE_INFINITY) ||
      (left.p95FirstFrameMs ?? Number.POSITIVE_INFINITY) -
        (right.p95FirstFrameMs ?? Number.POSITIVE_INFINITY) ||
      left.stalls - right.stalls ||
      left.droppedFrames - right.droppedFrames ||
      left.provider.localeCompare(right.provider)
    );
  });
  return ranking.map((entry, index) => ({ rank: index + 1, ...entry }));
}

export function authAccountIdentifier(payload) {
  const rawId = payload?.id;
  if (typeof rawId !== "string" && typeof rawId !== "number") return "";
  const id = String(rawId).trim();
  return id && id !== "0" && id.length <= 128 ? id : "";
}

export function authAccountFromPayload(payload) {
  const accountId = authAccountIdentifier(payload);
  if (!accountId) return null;
  return { accountId, isAdmin: payload?.isAdmin === true };
}

export function chooseAuthenticatedCandidate(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw benchmarkError("AUTH_CONTEXT_NOT_FOUND");
  }
  const identities = new Set(candidates.map((candidate) => candidate.accountId));
  if (identities.size !== 1 || identities.has("")) {
    throw benchmarkError("AMBIGUOUS_AUTH_CONTEXTS");
  }
  if (!candidates.every((candidate) => candidate.isAdmin === true)) {
    throw benchmarkError("SOURCE_ADMIN_REQUIRED");
  }
  return candidates[0];
}

async function readAuthenticatedAccount(context, origin, timeoutMs) {
  const deadline = performance.now() + Math.min(timeoutMs, 10_000);
  const response = await context.request.get(`${origin}/api/auth/me`, {
    timeout: Math.min(timeoutMs, 10_000),
    failOnStatusCode: false,
  });
  if (response.status() !== 200) return null;
  let payload;
  try {
    payload = await runWithDeadline(
      () => response.json(),
      deadline,
      "AUTH_RESPONSE_TIMEOUT",
    );
  } catch (error) {
    if (error?.benchmarkCode === "AUTH_RESPONSE_TIMEOUT") throw error;
    throw benchmarkError("AUTH_RESPONSE_INVALID");
  }
  const account = authAccountFromPayload(payload);
  if (!account) throw benchmarkError("AUTH_IDENTITY_MISSING");
  return account;
}

async function findAuthenticatedContext(browser, authOrigin, timeoutMs) {
  const contexts = browser.contexts();
  const candidates = [];
  for (const context of contexts) {
    try {
      const account = await readAuthenticatedAccount(
        context,
        authOrigin,
        timeoutMs,
      );
      if (account) candidates.push({ context, ...account });
    } catch (error) {
      if (error?.benchmarkCode) throw error;
      // Try the next attached Chrome context without exposing connection details.
    }
  }
  return chooseAuthenticatedCandidate(candidates);
}

export async function createIsolatedAuthenticatedContext({
  browser,
  authenticatedContext,
  authOrigin,
  baseOrigin,
  timeoutMs,
}) {
  assertSameAuthOrigin(baseOrigin, authOrigin);
  const candidate = authenticatedContext
    ? {
        context: authenticatedContext,
        ...(await readAuthenticatedAccount(authenticatedContext, authOrigin, timeoutMs)),
      }
    : await findAuthenticatedContext(browser, authOrigin, timeoutMs);
  if (!candidate.accountId) throw benchmarkError("AUTH_CONTEXT_NOT_FOUND");
  if (!candidate.isAdmin) throw benchmarkError("SOURCE_ADMIN_REQUIRED");
  const sourceContext = candidate.context;
  const sourceCookies = await sourceContext.cookies(authOrigin);
  const sessionCookie = sourceCookies.find((cookie) => cookie.name === "session");
  if (!sessionCookie?.value) throw benchmarkError("SESSION_COOKIE_NOT_FOUND");

  const context = await browser.newContext({
    viewport: DEFAULT_VIEWPORT,
    serviceWorkers: "block",
  });
  try {
    const target = new URL(baseOrigin);
    await context.addCookies([
      {
        name: "session",
        value: sessionCookie.value,
        url: `${target.origin}/`,
        httpOnly: true,
        secure: target.protocol === "https:",
        sameSite: "Lax",
        expires: sessionCookie.expires,
      },
    ]);
    await context.addInitScript(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        // This context is disposable; storage can also be unavailable by policy.
      }
    });

    const targetAccount = await readAuthenticatedAccount(
      context,
      baseOrigin,
      timeoutMs,
    );
    if (!targetAccount) throw benchmarkError("TARGET_AUTH_REJECTED");
    if (!targetAccount.isAdmin) throw benchmarkError("TARGET_ADMIN_REQUIRED");
    if (targetAccount.accountId !== candidate.accountId) {
      throw benchmarkError("TARGET_ACCOUNT_MISMATCH");
    }
    return context;
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

export async function assertProviderBenchmarkCapability(
  context,
  baseOrigin,
  timeoutMs,
) {
  const response = await context.request.get(
    `${baseOrigin}/api/admin/provider-benchmark-capability`,
    {
      timeout: Math.min(timeoutMs, 10_000),
      failOnStatusCode: false,
      headers: { [PROVIDER_BENCHMARK_HEADER]: "1" },
    },
  );
  if (response.status() !== 200) {
    throw benchmarkError("BENCHMARK_CAPABILITY_UNAVAILABLE");
  }
  if (
    responseHeaderValue(
      response.headers(),
      PROVIDER_HEALTH_RECORDING_ACK_HEADER,
    ) !== PROVIDER_HEALTH_RECORDING_ACK_VALUE
  ) {
    throw benchmarkError("BENCHMARK_CAPABILITY_NOT_ACKNOWLEDGED");
  }
  return true;
}

export async function readConfiguredLiveHlsWorkerOrigins(
  context,
  baseOrigin,
  timeoutMs,
) {
  const deadline = performance.now() + Math.min(timeoutMs, 10_000);
  const response = await context.request.get(`${baseOrigin}/api/admin/providers`, {
    timeout: Math.min(timeoutMs, 10_000),
    failOnStatusCode: false,
  });
  if (response.status() !== 200) {
    throw benchmarkError("LIVE_HLS_WORKER_CONFIG_UNAVAILABLE");
  }
  let payload;
  try {
    payload = await runWithDeadline(
      () => response.json(),
      deadline,
      "LIVE_HLS_WORKER_CONFIG_TIMEOUT",
    );
  } catch (error) {
    if (error?.benchmarkCode === "LIVE_HLS_WORKER_CONFIG_TIMEOUT") throw error;
    throw benchmarkError("LIVE_HLS_WORKER_CONFIG_INVALID");
  }
  return extractConfiguredLiveHlsWorkerOrigins(payload);
}

async function warmPlayerShell(context, baseOrigin, timeoutMs) {
  const page = await context.newPage();
  let networkedResolveRequests = 0;
  page.on("request", (request) => {
    if (isSameOriginResolveStart(request.url(), baseOrigin)) {
      networkedResolveRequests += 1;
    }
  });
  const warmupUrl = new URL("/player.html", baseOrigin);
  warmupUrl.searchParams.set("providerBenchmarkWarmup", "1");
  try {
    await page.goto(warmupUrl.toString(), {
      waitUntil: "load",
      timeout: Math.min(timeoutMs, 15_000),
    });
    // Module execution participates in the load event; one quiet half-second also
    // catches startup work scheduled by the mounted player shell.
    await page.waitForTimeout(500);
    const guardState = await page.evaluate(() => {
      const state = window.__STREAMARENA_PROVIDER_BENCHMARK_SAFETY__;
      if (!state) return null;
      return {
        blockedFallbackRequests: Number(state.blockedFallbackRequests || 0),
        benchmarkResolveHeadersApplied: Number(
          state.benchmarkResolveHeadersApplied || 0,
        ),
      };
    });
    if (!guardState) throw benchmarkError("PLAYER_SHELL_WARMUP_GUARD_MISSING");
    if (
      networkedResolveRequests !== 0 ||
      guardState.blockedFallbackRequests !== 0 ||
      guardState.benchmarkResolveHeadersApplied !== 0
    ) {
      throw benchmarkError("PLAYER_SHELL_WARMUP_RESOLVE_DETECTED");
    }
  } finally {
    await page.close().catch(() => {});
  }
}

async function discoverSources(
  context,
  baseOrigin,
  testCase,
  timeoutMs,
  includeVariants,
) {
  const deadline = performance.now() + timeoutMs;
  const response = await context.request.get(
    sourceDiscoveryUrl(baseOrigin, testCase).toString(),
    { timeout: timeoutMs, failOnStatusCode: false },
  );
  if (response.status() !== 200) throw benchmarkError("SOURCE_DISCOVERY_FAILED");
  let payload;
  try {
    payload = await runWithDeadline(
      () => response.json(),
      deadline,
      "SOURCE_DISCOVERY_TIMEOUT",
    );
  } catch (error) {
    if (error?.benchmarkCode === "SOURCE_DISCOVERY_TIMEOUT") throw error;
    throw benchmarkError("SOURCE_DISCOVERY_INVALID");
  }
  const manifest = classifyExternalSourceRows(payload?.sources, {
    mediaType: testCase.mediaType,
    includeVariants,
  });
  if (!manifest.selected.length && !manifest.missingRequiredBaseProviders.length) {
    throw benchmarkError("NO_EXTERNAL_SOURCES");
  }
  return manifest;
}

function assertSanitizedString(value) {
  if (/(?:https?|wss?):\/\//i.test(value)) throw benchmarkError("UNSAFE_REPORT_URL");
  if (/\bbearer\s+[a-z0-9._~+/=-]+/i.test(value)) {
    throw benchmarkError("UNSAFE_REPORT_SECRET");
  }
  if (/\beyj[a-z0-9_-]{5,}\.[a-z0-9_-]{5,}\.[a-z0-9_-]{5,}\b/i.test(value)) {
    throw benchmarkError("UNSAFE_REPORT_SECRET");
  }
  if (
    /\b(?:access[-_ ]?token|refresh[-_ ]?token|token|api[-_ ]?key|secret|password|authorization|cookie)\b\s*[:=]\s*["']?[a-z0-9._~+/=-]{4,}/i.test(
      value,
    )
  ) {
    throw benchmarkError("UNSAFE_REPORT_SECRET");
  }
  if (EMBEDDED_SOURCE_HASH_PATTERN.test(value)) {
    throw benchmarkError("UNSAFE_REPORT_SOURCE_HASH");
  }
}

export function assertSanitizedReport(value, path = "report") {
  if (typeof value === "string") {
    assertSanitizedString(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSanitizedReport(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (
      /(?:url|uri|host|cookie|token|payload|sourcehash|sourcehistory|console|requesttext|authorization|bearer|jwt|credential|password|passwd|passphrase|secret|api[-_]?key|access[-_]?key|private[-_]?key|session[-_]?id)/i.test(
        key,
      )
    ) {
      throw benchmarkError("UNSAFE_REPORT_FIELD");
    }
    assertSanitizedReport(entry, `${path}.${key}`);
  }
}

export function writeReportAtomically(rawOutputPath, report) {
  assertSanitizedReport(report);
  const outputPath = resolve(String(rawOutputPath || ""));
  const outputDirectory = dirname(outputPath);
  mkdirSync(outputDirectory, { recursive: true });
  const temporaryPath = join(
    outputDirectory,
    `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor = null;
  let renamed = false;
  try {
    descriptor = openSync(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    // Set the descriptor mode before writing. The final path is created only by
    // rename, so a permissive pre-existing file or symlink is never followed.
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    const descriptorToClose = descriptor;
    descriptor = null;
    closeSync(descriptorToClose);
    renameSync(temporaryPath, outputPath);
    renamed = true;
    return outputPath;
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original write error.
      }
    }
    if (!renamed) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The temp file may not have been created or may already be gone.
      }
    }
  }
}

export function computeRequiredCoverage(
  discoveries,
  trials,
  trialsPerCase,
) {
  const caseProviders = [];
  for (const discovery of discoveries) {
    const discovered = new Set(discovery.discoveredBaseProviders || []);
    for (const provider of discovery.requiredBaseProviders || []) {
      const actualTrials = trials.filter(
        (trial) =>
          trial.case === discovery.case &&
          trial.providerKind === "base" &&
          trial.baseProvider === provider,
      ).length;
      const isDiscovered = discovered.has(provider);
      caseProviders.push({
        case: discovery.case,
        mediaType: discovery.mediaType,
        provider,
        discovered: isDiscovered,
        expectedTrials: trialsPerCase,
        actualTrials,
        covered: isDiscovered && actualTrials >= trialsPerCase,
      });
    }
  }
  return {
    passed:
      caseProviders.length > 0 && caseProviders.every((entry) => entry.covered),
    caseProviders,
    missingRequiredProviders: caseProviders
      .filter((entry) => !entry.discovered)
      .map(({ case: caseName, mediaType, provider }) => ({
        case: caseName,
        mediaType,
        provider,
      })),
    missingRequiredTrials: caseProviders
      .filter((entry) => entry.discovered && entry.actualTrials < entry.expectedTrials)
      .map(
        ({ case: caseName, mediaType, provider, expectedTrials, actualTrials }) => ({
          case: caseName,
          mediaType,
          provider,
          expectedTrials,
          actualTrials,
        }),
      ),
  };
}

export function computeGate(trials, minSuccessRate, coverage = { passed: true }) {
  const total = trials.length;
  const successes = trials.filter((trial) => trial.success).length;
  const successRate = total > 0 ? successes / total : 0;
  const integrityFailureCount = trials.filter((trial) =>
    (Array.isArray(trial?.failureCodes) ? trial.failureCodes : []).some((code) =>
      HARD_INTEGRITY_FAILURE_CODES.has(code),
    ),
  ).length;
  const integrityPassed = integrityFailureCount === 0;
  return {
    passed:
      total > 0 &&
      successRate >= minSuccessRate &&
      coverage.passed === true &&
      integrityPassed,
    requiredSuccessRate: minSuccessRate,
    coveragePassed: coverage.passed === true,
    integrityPassed,
    integrityFailureCount,
    totalTrials: total,
    successfulTrials: successes,
    failedTrials: total - successes,
    successRate: Number(successRate.toFixed(4)),
  };
}

export async function runProviderBenchmark(
  options,
  { browser: suppliedBrowser = null, authenticatedContext = null } = {},
) {
  const baseOrigin = normalizeOrigin(options.baseUrl, "INVALID_BASE_ORIGIN");
  const authOrigin = normalizeOrigin(
    options.authOrigin || options.baseUrl,
    "INVALID_AUTH_ORIGIN",
  );
  assertSameAuthOrigin(baseOrigin, authOrigin);
  const browser =
    suppliedBrowser || (await chromium.connectOverCDP(options.cdpEndpoint));
  let context = null;
  const safetyStats = {
    blockedMutations: 0,
    emptyProgressReads: 0,
    providerHealthSuppressionAcknowledged: true,
  };
  const discoveries = [];
  const trialResults = [];
  let liveHlsWorkerOrigins = [];
  try {
    context = await createIsolatedAuthenticatedContext({
      browser,
      authenticatedContext,
      authOrigin,
      baseOrigin,
      timeoutMs: options.timeoutMs,
    });
    await installProviderBenchmarkGuards(context, baseOrigin);
    await assertProviderBenchmarkCapability(
      context,
      baseOrigin,
      options.timeoutMs,
    );
    liveHlsWorkerOrigins = await readConfiguredLiveHlsWorkerOrigins(
      context,
      baseOrigin,
      options.timeoutMs,
    );
    await warmPlayerShell(context, baseOrigin, options.timeoutMs);
    for (let caseIndex = 0; caseIndex < options.cases.length; caseIndex += 1) {
      const testCase = options.cases[caseIndex];
      const manifest = await discoverSources(
        context,
        baseOrigin,
        testCase,
        options.timeoutMs,
        options.includeVariants,
      );
      const sources = manifest.selected;
      discoveries.push(buildDiscoveryReportEntry(testCase, manifest));

      for (let trialIndex = 0; trialIndex < options.trials; trialIndex += 1) {
        const orderedSources = orderSources(
          sources,
          options.order,
          trialIndex,
          caseIndex,
        );
        for (const source of orderedSources) {
          trialResults.push(
            await runTrial({
              context,
              baseOrigin,
              liveHlsWorkerOrigins,
              testCase,
              source,
              trialNumber: trialIndex + 1,
              options,
              safetyStats,
            }),
          );
        }
      }
    }
  } finally {
    await context?.close().catch(() => {});
  }

  const coverage = computeRequiredCoverage(
    discoveries,
    trialResults,
    options.trials,
  );
  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    options: {
      trials: options.trials,
      order: options.order,
      timeoutMs: options.timeoutMs,
      steadyMs: options.steadyMs,
      advanceMs: options.advanceMs,
      providerPolicy: options.includeVariants ? "base-and-variants" : "base-only",
    },
    safety: {
      disposableBrowserContext: true,
      authenticationMaterialCopiedInMemoryOnly: true,
      benchmarkCapabilityAcknowledged: true,
      liveHlsWorkerOriginCount: liveHlsWorkerOrigins.length,
      progressMutationsBlocked: safetyStats.blockedMutations,
      progressReadsEmptied: safetyStats.emptyProgressReads,
      externalProviderHealthRecordingSuppressed:
        trialResults.length > 0 &&
        safetyStats.providerHealthSuppressionAcknowledged,
    },
    discoveries,
    trials: trialResults,
    rankings: {
      overall: aggregateTrials(trialResults),
      movie: aggregateTrials(trialResults, "movie"),
      tv: aggregateTrials(trialResults, "tv"),
    },
    coverage,
    gate: computeGate(trialResults, options.minSuccessRate, coverage),
  };
  assertSanitizedReport(report);
  return report;
}

function printSummary(report) {
  for (const entry of report.rankings.overall) {
    const firstFrame = Number.isFinite(entry.medianFirstFrameMs)
      ? `${Math.round(entry.medianFirstFrameMs)}ms`
      : "n/a";
    console.log(
      `${entry.rank}. ${entry.provider}: ${(entry.successRate * 100).toFixed(1)}% success, median first frame ${firstFrame}, stalls ${entry.stalls}, drops ${entry.droppedFrames}`,
    );
  }
  console.log(
    `Gate: ${report.gate.passed ? "PASS" : "FAIL"} (${report.gate.successfulTrials}/${report.gate.totalTrials} trials)`,
  );
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch {
    console.error("Provider benchmark failed: INVALID_ARGUMENTS");
    return 1;
  }
  if (options.help) {
    printHelp();
    return 0;
  }

  try {
    const report = await runProviderBenchmark(options);
    if (options.outputPath) {
      writeReportAtomically(resolve(process.cwd(), options.outputPath), report);
    }
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printSummary(report);
    }
    return report.gate.passed ? 0 : 2;
  } catch (error) {
    console.error(`Provider benchmark failed: ${errorCode(error)}`);
    return 1;
  }
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().then(
    async (code) => {
      await flushProcessOutput();
      process.exit(code);
    },
    async () => {
      await flushProcessOutput();
      process.exit(1);
    },
  );
}

async function flushProcessOutput() {
  const flush = (stream) =>
    new Promise((done) => {
      if (!stream?.writable) {
        done();
        return;
      }
      stream.write("", done);
    });
  await Promise.all([flush(process.stdout), flush(process.stderr)]);
}

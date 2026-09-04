#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import {
  PROVIDER_BENCHMARK_HEADER,
  alignBenchmarkMilestones,
  assertSameAuthOrigin,
  assertSanitizedReport,
  authAccountFromPayload,
  classifyResolveResponsePayload,
  createIsolatedAuthenticatedContext,
  normalizeOrigin,
  parseRemuxServerTiming,
  runWithDeadline,
  writeReportAtomically,
} from "./provider-playback-benchmark.mjs";

const DEFAULT_BASE_URL = "http://127.0.0.1:5173";
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_ADVANCE_MS = 5_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REMUX_FIRST_BODY_MS = 20_000;
const DEFAULT_MAX_FIRST_FRAME_MS = 20_000;
const BENCHMARK_PLAYBACK_RATE = 1;
const BENCHMARK_PLAYBACK_RATE_EPSILON = 0.01;
const MIN_MEDIA_TO_WALL_TIME_RATIO = 0.9;
const MAX_MEDIA_TO_WALL_TIME_RATIO = 1.1;
const PLAYBACK_SPEED_STORAGE_KEY = "streamarena-playback-speed";
const MIN_VALIDATION_FRESH_MS = 5_000;
const SERVER_EXACT_SESSION_MIN_FRESH_MS = 15_000;
const SELECTION_SAFETY_SLACK_MS = 5_000;
const RESOLVE_START_TIMEOUT_MS = 10_000;
const BENCHMARK_START_FRESHNESS_WINDOW_MS =
  SERVER_EXACT_SESSION_MIN_FRESH_MS +
  RESOLVE_START_TIMEOUT_MS +
  SELECTION_SAFETY_SLACK_MS;
const PLAYBACK_SESSION_STALE_MS = 30 * 24 * 60 * 60 * 1_000;
const TITLE_PREFERENCE_STALE_MS = 90 * 24 * 60 * 60 * 1_000;
const PLAYBACK_SESSION_MAX_ENTRIES = 2_500;
const SOURCE_HASH_PATTERN = /^[a-f0-9]{40}$/;
const SESSION_SCOPE_KEY = "_realDebridCredentialScope";
export const REAL_DEBRID_BENCHMARK_HEADER =
  "x-streamarena-real-debrid-benchmark";
export const EXPECTED_SERVER_INSTANCE_HEADER =
  "x-streamarena-expected-server-instance";
const REAL_DEBRID_BENCHMARK_QUERY_FLAG = "benchmarkExactSession";
const DATABASE_PATH_IDENTITY_DOMAIN =
  "streamarena-provider-benchmark-db-file-v2\0";
const BENCHMARK_PROBE_KEY_IDENTITY_DOMAIN =
  "streamarena-benchmark-probe-key-v1\0";
const BENCHMARK_PROBE_PAYLOAD_IDENTITY_DOMAIN =
  "streamarena-benchmark-probe-payload-v1\0";
const REAL_DEBRID_SCOPE_IDENTITY_DOMAIN =
  "streamarena-provider-benchmark-rd-scope-v1\0";
const OPAQUE_IDENTITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RUN_NONCE_PATTERN = /^[a-f0-9]{64}$/;
const REPORT_FILENAME = "real-debrid-playback.json";
const VIEWPORT = Object.freeze({ width: 1600, height: 900 });
const RESOLVER_PATHS = new Set([
  "/api/resolve/movie",
  "/api/resolve/tv",
  "/api/admin/provider-benchmark-resolve/movie",
  "/api/admin/provider-benchmark-resolve/tv",
]);
const PROGRESS_PATHS = new Set([
  "/api/user/watch-progress",
  "/api/user/continue-watching",
  "/api/session/progress",
]);
const MUTATION_SENSITIVE_PATHS = new Set([
  "/api/title/preferences",
  "/api/user/preferences",
  "/api/user/real-debrid",
  "/api/user/torrent-settings",
  "/api/user/sync",
  "/api/user/my-list",
  "/api/user/live-watch",
  "/api/library",
  "/api/gallery/save-stream",
  "/api/feedback",
]);
const BENCHMARK_SAFE_READ_PATHS = new Set([
  "/api/auth/me",
  "/api/health",
  "/api/title/preferences",
  "/api/user/preferences",
  "/api/user/torrent-settings",
]);
const SESSION_TIMESTAMP_FIELDS = Object.freeze([
  "last_verified_at",
  "next_validation_at",
  "updated_at",
  "last_accessed_at",
]);

function benchmarkError(code) {
  const error = new Error(code);
  error.benchmarkCode = code;
  return error;
}

function errorCode(error, fallback = "INTERNAL_FAILURE") {
  const code = String(error?.benchmarkCode || "").trim();
  if (code) return code;
  if (String(error?.name || "").toLowerCase().includes("timeout")) {
    return "TIMEOUT";
  }
  return fallback;
}

function nextArg(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || String(value).startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function requireAbsolutePath(rawValue, flag) {
  const value = String(rawValue || "").trim();
  if (!value || !isAbsolute(value)) {
    throw new Error(`${flag} must be an absolute path.`);
  }
  return resolve(value);
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || "").trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

const BENCHMARK_NUMERIC_OPTION_LIMITS = Object.freeze([
  ["timeoutMs", "--timeout-ms", 10_000, 180_000],
  ["advanceMs", "--advance-ms", DEFAULT_ADVANCE_MS, 30_000],
  ["drainTimeoutMs", "--drain-timeout-ms", 1_000, 60_000],
  ["maxRemuxFirstBodyMs", "--max-remux-first-body-ms", 1_000, 180_000],
  ["maxFirstFrameMs", "--max-first-frame-ms", 1_000, 180_000],
]);

function assertBenchmarkNumericOptions(options) {
  for (const [property, flag, minimum, maximum] of BENCHMARK_NUMERIC_OPTION_LIMITS) {
    const value = options?.[property];
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${flag} has an invalid value.`);
    }
  }
}

export function assertBenchmarkTransportSecurity(rawValue, kind = "http") {
  let url;
  try {
    url = new URL(String(rawValue || ""));
  } catch {
    throw benchmarkError("INSECURE_BENCHMARK_TRANSPORT");
  }
  if (url.username || url.password) {
    throw benchmarkError("INSECURE_BENCHMARK_TRANSPORT");
  }
  const protocols =
    kind === "cdp" ? new Set(["http:", "https:", "ws:", "wss:"]) : new Set(["http:", "https:"]);
  if (!protocols.has(url.protocol)) {
    throw benchmarkError("INSECURE_BENCHMARK_TRANSPORT");
  }
  if (kind === "cdp" && !isLoopbackHostname(url.hostname)) {
    throw benchmarkError("INSECURE_BENCHMARK_TRANSPORT");
  }
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  if (!secure && !isLoopbackHostname(url.hostname)) {
    throw benchmarkError("INSECURE_BENCHMARK_TRANSPORT");
  }
  return true;
}

export function parseRealDebridBenchmarkArgs(argv) {
  const options = {
    cdpEndpoint: String(process.env.STREAMARENA_CDP_ENDPOINT || "").trim(),
    authOrigin: String(process.env.STREAMARENA_AUTH_ORIGIN || "").trim(),
    baseUrl: String(process.env.STREAMARENA_BASE_URL || DEFAULT_BASE_URL).trim(),
    resolverCachePath: "",
    usersDbPath: "",
    outputDir: "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    advanceMs: DEFAULT_ADVANCE_MS,
    drainTimeoutMs: DEFAULT_DRAIN_TIMEOUT_MS,
    maxRemuxFirstBodyMs: DEFAULT_MAX_REMUX_FIRST_BODY_MS,
    maxFirstFrameMs: DEFAULT_MAX_FIRST_FRAME_MS,
    json: false,
    help: false,
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
    } else if (arg === "--resolver-cache") {
      options.resolverCachePath = requireAbsolutePath(
        nextArg(argv, index, arg),
        arg,
      );
      index += 1;
    } else if (arg === "--users-db") {
      options.usersDbPath = requireAbsolutePath(nextArg(argv, index, arg), arg);
      index += 1;
    } else if (arg === "--output-dir") {
      options.outputDir = requireAbsolutePath(nextArg(argv, index, arg), arg);
      index += 1;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(nextArg(argv, index, arg));
      index += 1;
    } else if (arg === "--advance-ms") {
      options.advanceMs = Number(nextArg(argv, index, arg));
      index += 1;
    } else if (arg === "--drain-timeout-ms") {
      options.drainTimeoutMs = Number(nextArg(argv, index, arg));
      index += 1;
    } else if (arg === "--max-remux-first-body-ms") {
      options.maxRemuxFirstBodyMs = Number(nextArg(argv, index, arg));
      index += 1;
    } else if (arg === "--max-first-frame-ms") {
      options.maxFirstFrameMs = Number(nextArg(argv, index, arg));
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument '${arg}'.`);
    }
  }

  if (options.help) return options;
  if (!options.cdpEndpoint) throw new Error("--cdp-endpoint is required.");
  if (!options.resolverCachePath) {
    throw new Error("--resolver-cache is required.");
  }
  if (!options.usersDbPath) throw new Error("--users-db is required.");
  if (!options.outputDir) throw new Error("--output-dir is required.");
  assertBenchmarkTransportSecurity(options.baseUrl, "http");
  assertBenchmarkTransportSecurity(options.authOrigin || options.baseUrl, "http");
  assertBenchmarkTransportSecurity(options.cdpEndpoint, "cdp");
  assertBenchmarkNumericOptions(options);
  assertSameAuthOrigin(options.baseUrl, options.authOrigin || options.baseUrl);
  return options;
}

export function realDebridBenchmarkHelpText() {
  return [
    "Usage: node scripts/real-debrid-playback-benchmark.mjs [options]",
    "",
    "Required:",
    "  --cdp-endpoint <endpoint>  Existing authenticated Chrome CDP endpoint",
    "  --resolver-cache <path>    Absolute resolver-cache.sqlite path",
    "  --users-db <path>          Absolute users.sqlite path",
    "  --output-dir <path>        Private report directory (created as 0700)",
    "",
    "Options:",
    "  --base-url <origin>        Target StreamArena origin (default: loopback :5173)",
    "  --auth-origin <origin>     Must exactly match --base-url",
    "  --timeout-ms <ms>          Overall playback timeout (10000..180000)",
    "  --advance-ms <ms>          Continuous playback proof (minimum 5000)",
    "  --drain-timeout-ms <ms>    Remux drain timeout (1000..60000)",
    "  --max-remux-first-body-ms <ms>  Successful remux first-byte ceiling (default 20000)",
    "  --max-first-frame-ms <ms>   Decoded first-frame ceiling (default 20000)",
    "  --json                     Print the sanitized report",
    "",
    "Security: non-loopback app/auth endpoints require HTTPS; CDP must be loopback-local to keep timing clocks comparable.",
  ].join("\n");
}

function normalizeSqliteValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) {
    return { binaryLength: value.byteLength };
  }
  return value;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return normalizeSqliteValue(value);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

export function stableDigest(value) {
  return `sha256-${createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("base64url")}`;
}

function snapshotRows(rows) {
  const normalized = (Array.isArray(rows) ? rows : []).map((row) =>
    stableValue(row),
  );
  return { count: normalized.length, digest: stableDigest(normalized) };
}

const PYTHON_SQLITE_READER = String.raw`
import base64
import hashlib
import json
import pathlib
import sqlite3
import sys

def safe(value):
    if isinstance(value, bytes):
        return {"binaryLength": len(value)}
    return value

request = json.load(sys.stdin)
database_uri = pathlib.Path(sys.argv[1]).resolve().as_uri() + "?mode=ro"
connection = sqlite3.connect(database_uri, uri=True, timeout=3.0)
connection.row_factory = sqlite3.Row
connection.execute("PRAGMA query_only = ON")
cursor = connection.execute(request["sql"], request.get("params", []))
if request.get("action") == "snapshot":
    digest = hashlib.sha256()
    count = 0
    for row in cursor:
        normalized = {key: safe(row[key]) for key in row.keys()}
        encoded = json.dumps(normalized, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        digest.update(encoded.encode("utf-8"))
        digest.update(b"\n")
        count += 1
    encoded = base64.urlsafe_b64encode(digest.digest()).decode("ascii").rstrip("=")
    json.dump({"count": count, "digest": "sha256-" + encoded}, sys.stdout)
else:
    rows = [{key: safe(row[key]) for key in row.keys()} for row in cursor]
    json.dump(rows, sys.stdout)
connection.close()
`;

class ReadOnlySqliteDatabase {
  constructor(databasePath, code) {
    this.databasePath = databasePath;
    this.code = code;
    this.query("SELECT 1 AS ok", []);
  }

  run(action, sql, params) {
    const result = spawnSync(
      "python3",
      ["-c", PYTHON_SQLITE_READER, this.databasePath],
      {
        input: JSON.stringify({ action, sql, params }),
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
    );
    if (result.status !== 0 || result.error) throw benchmarkError(this.code);
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw benchmarkError(this.code);
    }
  }

  query(sql, params) {
    return this.run("query", sql, params);
  }

  snapshot(sql, params) {
    return this.run("snapshot", sql, params);
  }

  prepare(sql) {
    return {
      all: (...params) => this.query(sql, params),
      get: (...params) => this.query(sql, params)[0],
    };
  }

  close() {}
}

function canonicalRegularFilePath(rawPath, code) {
  let canonicalPath;
  try {
    const info = lstatSync(rawPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe");
    canonicalPath = realpathSync(rawPath);
    if (!statSync(canonicalPath).isFile()) throw new Error("unsafe");
  } catch {
    throw benchmarkError(code);
  }
  return canonicalPath;
}

export function benchmarkDatabasePathIdentity(rawPath, role) {
  const canonicalPath = canonicalRegularFilePath(
    rawPath,
    "DATABASE_PATH_IDENTITY_UNAVAILABLE",
  );
  const metadata = statSync(canonicalPath, { bigint: true });
  return createHash("sha256")
    .update(DATABASE_PATH_IDENTITY_DOMAIN)
    .update(String(role || ""), "utf8")
    .update("\0")
    .update(canonicalPath, "utf8")
    .update("\0")
    .update(metadata.dev.toString(), "utf8")
    .update("\0")
    .update(metadata.ino.toString(), "utf8")
    .digest("base64url");
}

export function benchmarkDatabaseFilesAreDistinct(leftPath, rightPath) {
  if (realpathSync(leftPath) === realpathSync(rightPath)) return false;
  const left = statSync(leftPath, { bigint: true });
  const right = statSync(rightPath, { bigint: true });
  return left.dev !== right.dev || left.ino !== right.ino;
}

export function realDebridPlaybackSessionScopeIdentity(scope) {
  const normalized = String(scope || "").trim();
  if (!normalized) return "";
  return createHash("sha256")
    .update(REAL_DEBRID_SCOPE_IDENTITY_DOMAIN)
    .update(normalized, "utf8")
    .digest("base64url");
}

function benchmarkProbeIdentity(domain, value) {
  return createHash("sha256")
    .update(domain)
    .update(String(value || ""), "utf8")
    .digest("base64url");
}

function openReadOnlyDatabase(rawPath, code) {
  const canonicalPath = canonicalRegularFilePath(rawPath, code);
  try {
    return new ReadOnlySqliteDatabase(canonicalPath, code);
  } catch {
    throw benchmarkError(code);
  }
}

function requireTables(database, names) {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all();
  const found = new Set(rows.map((row) => String(row.name || "")));
  if (names.some((name) => !found.has(name))) {
    throw benchmarkError("DATABASE_SCHEMA_INVALID");
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseProxyInput(rawValue) {
  let url;
  try {
    url = new URL(String(rawValue || ""), "http://benchmark.invalid");
  } catch {
    return "";
  }
  if (url.pathname !== "/api/remux") return "";
  const input = String(url.searchParams.get("input") || "").trim();
  if (!input) return "";
  let upstream;
  try {
    upstream = new URL(input);
  } catch {
    return "";
  }
  const host = String(upstream.hostname || "").toLowerCase();
  if (
    upstream.protocol !== "https:" ||
    upstream.username ||
    upstream.password ||
    !(host === "download.real-debrid.com" ||
      host.endsWith(".download.real-debrid.com"))
  ) {
    return "";
  }
  return upstream.toString();
}

function parseRealDebridDownload(rawValue) {
  let url;
  try {
    url = new URL(String(rawValue || ""));
  } catch {
    return "";
  }
  const host = String(url.hostname || "").toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !(host === "download.real-debrid.com" ||
      host.endsWith(".download.real-debrid.com"))
  ) {
    return "";
  }
  return url.toString();
}

function realDebridDownloadRequiresRemux(row) {
  const source = String(row?.playable_url || "").toLowerCase();
  const filename = String(row?.filename || "").trim().toLowerCase();
  return [".mkv", ".avi", ".wmv", ".ts", ".m3u8"].some(
    (extension) =>
      source.includes(extension) || filename.endsWith(extension),
  );
}

function isRealDebridLazyHls(rawValue) {
  let url;
  try {
    url = new URL(String(rawValue || ""), "http://benchmark.invalid");
  } catch {
    return false;
  }
  if (
    url.origin !== "http://benchmark.invalid" ||
    url.pathname !== "/api/hls/master.m3u8" ||
    url.searchParams.size !== 1
  ) {
    return false;
  }
  const inputs = url.searchParams.getAll("input");
  if (inputs.length !== 1) return false;
  const match = /^streamarena-rd-hls-v1\.([A-Za-z0-9]{1,64})\.([1-9][0-9]{0,18})\.([A-Za-z0-9_-]{43})$/.exec(
    inputs[0],
  );
  return Boolean(match);
}

export function realDebridRemuxInputs(row) {
  const fallbacks = parseJsonArray(row?.fallback_urls_json);
  if (!fallbacks) return [];
  const inputs = [row?.playable_url, ...fallbacks]
    .map(parseProxyInput)
    .filter(Boolean);
  const directInput = parseRealDebridDownload(row?.playable_url);
  if (directInput && realDebridDownloadRequiresRemux(row)) {
    inputs.push(directInput);
  }
  return [...new Set(inputs)];
}

function normalizedAudioLanguage(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return new Set(["auto", "en", "fr", "es", "de", "it", "pt"]).has(
    normalized,
  )
    ? normalized
    : "";
}

function normalizedQualityFromSessionKey(value) {
  const raw = String(value || "")
    .split(":")
    .at(-1)
    ?.trim()
    .toLowerCase();
  if (["auto", "2160p", "1080p", "720p"].includes(raw)) return raw;
  return "";
}

function normalizedStoredAudioPreference(value) {
  return normalizedAudioLanguage(value) || "auto";
}

function relatedAutoSessionKey(sessionKey) {
  const parts = String(sessionKey || "").split(":");
  if (parts.length < 3) return "";
  parts[parts.length - 2] = "auto";
  return parts.join(":");
}

function requiredTmdbCacheKeys(mediaType, tmdbId, seasonNumber, episodeNumber) {
  if (mediaType === "tv") {
    return [
      `/tv/${tmdbId}?language=en-US`,
      `/tv/${tmdbId}/season/${seasonNumber}/episode/${episodeNumber}?language=en-US`,
      `/tv/${tmdbId}/external_ids?language=en-US`,
    ];
  }
  return [`/movie/${tmdbId}?language=en-US`];
}

function normalizeWhitespace(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeTextForMatch(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleTokensForMatch(value) {
  const stopwords = new Set([
    "the",
    "a",
    "an",
    "and",
    "of",
    "in",
    "on",
    "to",
    "for",
    "vs",
    "v",
    "movie",
    "film",
  ]);
  return normalizeTextForMatch(value)
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !stopwords.has(token));
}

export function doesFilenameLikelyMatchMovie(filename, movieTitle, movieYear) {
  const normalizedFilename = normalizeTextForMatch(filename);
  if (!normalizedFilename) return true;
  const titleTokens = titleTokensForMatch(movieTitle);
  if (titleTokens.length === 0) return true;
  const expectedYear = String(movieYear || "").trim();
  const years = normalizedFilename.match(/\b(?:19|20)\d{2}\b/g) || [];
  const hasExpectedYear = Boolean(
    expectedYear && years.some((value) => value === expectedYear),
  );
  const hasConflictingYear = Boolean(
    expectedYear && years.length > 0 && !hasExpectedYear,
  );
  const filenameTokens = new Set(normalizedFilename.split(/\s+/));
  const matchedTokenCount = titleTokens.filter((token) =>
    filenameTokens.has(token),
  ).length;
  const requiredMatches = titleTokens.length === 1 ? 1 : Math.min(titleTokens.length, 2);
  if (matchedTokenCount >= requiredMatches) {
    if (!expectedYear || hasExpectedYear) return true;
    return !hasConflictingYear;
  }
  return matchedTokenCount >= 1 && hasExpectedYear;
}

function canonicalMovieSessionKey(userId, tmdbId, audioLang, quality) {
  return `real-debrid:user:${userId}:${tmdbId}:${audioLang}:${quality}`;
}

function movieSessionMetadataMatchesCurrent(metadata, tmdbMetadata, selected) {
  if (!tmdbMetadata) return false;
  const imdbId = String(tmdbMetadata.imdbId || "").trim();
  if (!imdbId) return false;
  const displayTitle =
    normalizeWhitespace(tmdbMetadata.displayTitle) || selected.displayTitle;
  const displayYear =
    String(tmdbMetadata.releaseDate || "").trim().slice(0, 4) ||
    selected.displayYear;
  const runtimeMinutes = Number.isInteger(tmdbMetadata.runtimeMinutes)
    ? tmdbMetadata.runtimeMinutes
    : 0;
  const filename = normalizeWhitespace(selected.filename);
  const selectedFilePath = String(metadata.subtitleTargetFilePath || "").trim();
  const expected = {
    tmdbId: selected.tmdbId,
    imdbId,
    displayTitle,
    displayYear,
    runtimeSeconds: runtimeMinutes > 0 ? runtimeMinutes * 60 : 0,
    seasonNumber: 0,
    episodeNumber: 0,
    episodeTitle: "",
    mediaType: "movie",
    subtitleTargetName: selectedFilePath || filename,
    subtitleTargetFilename: filename,
    subtitleTargetFilePath: selectedFilePath,
    resolverProvider: "real-debrid",
    realDebridCached:
      typeof metadata.realDebridCached === "boolean"
        ? metadata.realDebridCached
        : false,
    [SESSION_SCOPE_KEY]: String(metadata[SESSION_SCOPE_KEY] || ""),
  };
  return stableDigest(metadata) === stableDigest(expected);
}

function candidateFromRow(
  row,
  {
    userId,
    nowMs,
    probeKeys,
    titlePreferences,
    minValidationFreshMs,
    sessionKeys,
    totalSessionCount,
    freshTmdbCacheKeys,
    tmdbMetadataByKey,
  },
) {
  const expectedPrefix = `real-debrid:user:${userId}:`;
  const metadata = parseJsonObject(row?.metadata_json);
  const sourceHash = String(row?.source_hash || "").trim().toLowerCase();
  const sessionKey = String(row?.session_key || "").trim();
  const tmdbId = String(row?.tmdb_id || "").trim();
  const audioLang = normalizedAudioLanguage(row?.audio_lang);
  const quality = normalizedQualityFromSessionKey(sessionKey);
  const mediaType = String(metadata?.mediaType || "").trim().toLowerCase();
  const seasonNumber = Math.floor(Number(metadata?.seasonNumber || 0));
  const episodeNumber = Math.floor(Number(metadata?.episodeNumber || 0));
  const displayTitle = String(metadata?.displayTitle || "").trim();
  const displayYear = String(metadata?.displayYear || "").trim();
  const filename = String(row?.filename || "").trim();
  const selectedFilePath = String(
    metadata?.subtitleTargetFilePath || "",
  ).trim();
  const matchName = selectedFilePath || filename;
  const fallbackUrls = parseJsonArray(row?.fallback_urls_json);
  const validationFreshUntil = Number(row?.next_validation_at || 0);
  const updatedAt = Number(row?.updated_at || 0);
  const lastAccessedAt = Number(row?.last_accessed_at || 0);
  const remuxInputs = realDebridRemuxInputs(row);
  const playableRemuxInput = parseProxyInput(row?.playable_url);
  const directRemuxInput =
    realDebridDownloadRequiresRemux(row) &&
    parseRealDebridDownload(row?.playable_url);
  const currentRemuxRoute =
    playableRemuxInput === remuxInputs[0] &&
    fallbackUrls?.length === 1 &&
    isRealDebridLazyHls(fallbackUrls[0]);
  const currentDownloadRoute =
    directRemuxInput === remuxInputs[0] &&
    fallbackUrls?.length === 1 &&
    isRealDebridLazyHls(fallbackUrls[0]);
  const normalRouteIsRemux = Boolean(
    currentRemuxRoute || currentDownloadRoute,
  );
  const currentTmdbMetadata = tmdbMetadataByKey?.get(
    requiredTmdbCacheKeys("movie", tmdbId, 0, 0)[0],
  );
  const selected = {
    tmdbId,
    displayTitle,
    displayYear,
    filename,
  };
  const titlePreference = titlePreferences.find(
    (entry) =>
      String(entry?.media_type || "").toLowerCase() === mediaType &&
      String(entry?.tmdb_id || "") === tmdbId,
  );
  const effectiveAudio =
    audioLang === "auto"
      ? normalizedStoredAudioPreference(titlePreference?.preferred_audio_lang)
      : audioLang;

  if (
    Number(row?.user_id) !== userId ||
    !sessionKey.startsWith(expectedPrefix) ||
    !/^\d+$/.test(tmdbId) ||
    !audioLang ||
    !quality ||
    !SOURCE_HASH_PATTERN.test(sourceHash) ||
    String(row?.health_state || "").trim().toLowerCase() !== "healthy" ||
    Number(row?.health_fail_count || 0) !== 0 ||
    String(row?.last_error || "").trim() ||
    metadata?.resolverProvider !== "real-debrid" ||
    !String(metadata?.[SESSION_SCOPE_KEY] || "").trim() ||
    mediaType !== "movie" ||
    !displayTitle ||
    !doesFilenameLikelyMatchMovie(matchName, displayTitle, displayYear) ||
    effectiveAudio !== audioLang ||
    (titlePreference &&
      Number(titlePreference.updated_at || 0) + TITLE_PREFERENCE_STALE_MS <=
        nowMs + minValidationFreshMs) ||
    validationFreshUntil <= nowMs + minValidationFreshMs ||
    updatedAt <= nowMs - PLAYBACK_SESSION_STALE_MS ||
    lastAccessedAt <= nowMs - PLAYBACK_SESSION_STALE_MS ||
    remuxInputs.length !== 1 ||
    !normalRouteIsRemux ||
    !fallbackUrls ||
    fallbackUrls.length !== 1 ||
    String(row?.source_hash || "") !== sourceHash ||
    String(row?.selected_file || "") !== String(row?.selected_file || "").trim() ||
    String(row?.filename || "") !== String(row?.filename || "").trim() ||
    String(row?.playable_url || "") !== String(row?.playable_url || "").trim() ||
    String(fallbackUrls[0] || "") !== String(fallbackUrls[0] || "").trim() ||
    sessionKey !==
      canonicalMovieSessionKey(userId, tmdbId, audioLang, quality) ||
    totalSessionCount > PLAYBACK_SESSION_MAX_ENTRIES ||
    (audioLang !== "auto" && sessionKeys.has(relatedAutoSessionKey(sessionKey))) ||
    (freshTmdbCacheKeys &&
      requiredTmdbCacheKeys(
        mediaType,
        tmdbId,
        seasonNumber,
        episodeNumber,
      ).some((key) => !freshTmdbCacheKeys.has(key))) ||
    (tmdbMetadataByKey &&
      !movieSessionMetadataMatchesCurrent(metadata, currentTmdbMetadata, selected))
  ) {
    return null;
  }
  const remuxInput = remuxInputs[0];
  const probeKey = `source:${remuxInput}`;
  const sessionSourceProbeKey = `source:${String(row.playable_url || "").trim()}`;
  if (probeKeys.has(probeKey) || probeKeys.has(sessionSourceProbeKey)) return null;
  const candidate = {
    userId,
    sessionKey,
    tmdbId,
    mediaType,
    seasonNumber: mediaType === "tv" ? seasonNumber : 0,
    episodeNumber: mediaType === "tv" ? episodeNumber : 0,
    audioLang,
    quality,
    sourceHash,
    remuxInput,
    probeKey,
    displayTitle,
    displayYear,
    lastAccessedAt,
    updatedAt,
  };
  Object.defineProperty(candidate, "sessionScopeIdentity", {
    value: realDebridPlaybackSessionScopeIdentity(metadata[SESSION_SCOPE_KEY]),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return candidate;
}

export function selectProbeColdRealDebridSession(
  rows,
  {
    userId,
    nowMs = Date.now(),
    probeKeys = new Set(),
    titlePreferences = [],
    minValidationFreshMs = MIN_VALIDATION_FRESH_MS,
    totalSessionCount = Array.isArray(rows) ? rows.length : 0,
    freshTmdbCacheKeys = null,
    tmdbMetadataByKey = null,
  } = {},
) {
  const normalizedUserId = Number(userId);
  if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0) return null;
  const safeRows = Array.isArray(rows) ? rows : [];
  const sessionKeys = new Set(
    safeRows.map((row) => String(row?.session_key || "").trim()),
  );
  const candidates = safeRows
    .map((row) =>
      candidateFromRow(row, {
        userId: normalizedUserId,
        nowMs,
        probeKeys,
        titlePreferences,
        minValidationFreshMs,
        sessionKeys,
        totalSessionCount,
        freshTmdbCacheKeys,
        tmdbMetadataByKey,
      }),
    )
    .filter(Boolean)
    .sort(
      (left, right) =>
        left.lastAccessedAt - right.lastAccessedAt ||
        right.updatedAt - left.updatedAt,
    );
  return candidates[0] || null;
}

export function benchmarkSelectionsMatch(left, right) {
  if (!left || !right) return false;
  const identity = (selection) => ({
    userId: selection.userId,
    sessionKey: selection.sessionKey,
    tmdbId: selection.tmdbId,
    mediaType: selection.mediaType,
    seasonNumber: selection.seasonNumber,
    episodeNumber: selection.episodeNumber,
    audioLang: selection.audioLang,
    quality: selection.quality,
    sourceHash: selection.sourceHash,
    remuxInput: selection.remuxInput,
    probeKey: selection.probeKey,
    displayTitle: selection.displayTitle,
    displayYear: selection.displayYear,
    sessionScopeIdentity: selection.sessionScopeIdentity,
  });
  return stableDigest(identity(left)) === stableDigest(identity(right));
}

function readSelection(
  database,
  userId,
  nowMs,
  minimumFreshMs = MIN_VALIDATION_FRESH_MS,
) {
  const rows = database
    .prepare(
      `SELECT user_id, session_key, tmdb_id, audio_lang, source_hash,
              selected_file, filename, playable_url, fallback_urls_json,
              metadata_json, last_position_seconds, health_state,
              health_fail_count, last_error, last_verified_at,
              next_validation_at, updated_at, last_accessed_at
         FROM playback_sessions
        WHERE user_id = ?`,
    )
    .all(userId);
  const probeKeys = new Set(
    database
      .prepare("SELECT probe_key FROM media_probe_cache")
      .all()
      .map((row) => String(row.probe_key || "")),
  );
  const titlePreferences = database
    .prepare(
      `SELECT media_type, tmdb_id, preferred_audio_lang, updated_at
         FROM title_track_preferences
        WHERE user_id = ?`,
    )
    .all(userId);
  const freshTmdbRows = database
    .prepare(
      `SELECT cache_key,
              json_extract(payload_json, '$.imdb_id') AS imdb_id,
              json_extract(payload_json, '$.title') AS display_title,
              json_extract(payload_json, '$.release_date') AS release_date,
              json_extract(payload_json, '$.runtime') AS runtime_minutes
         FROM tmdb_response_cache
        WHERE expires_at > ?
          AND json_valid(payload_json)
          AND json_type(payload_json) = 'object'`,
    )
    .all(nowMs + minimumFreshMs);
  const freshTmdbCacheKeys = new Set(
    freshTmdbRows.map((row) => String(row.cache_key || "")),
  );
  const tmdbMetadataByKey = new Map(
    freshTmdbRows.map((row) => [
      String(row.cache_key || ""),
      {
        imdbId: row.imdb_id,
        displayTitle: row.display_title,
        releaseDate: row.release_date,
        runtimeMinutes: row.runtime_minutes,
      },
    ]),
  );
  const totalSessionCount = Number(
    database.prepare("SELECT COUNT(*) AS count FROM playback_sessions").get()
      ?.count || 0,
  );
  return selectProbeColdRealDebridSession(rows, {
    userId,
    nowMs,
    probeKeys,
    titlePreferences,
    minValidationFreshMs: minimumFreshMs,
    totalSessionCount,
    freshTmdbCacheKeys,
    tmdbMetadataByKey,
  });
}

function exactResolveRequest(url, expected) {
  const mediaType = expected.mediaType === "tv" ? "tv" : "movie";
  if (
    url.pathname !== `/api/resolve/${mediaType}` &&
    url.pathname !== `/api/admin/provider-benchmark-resolve/${mediaType}`
  ) {
    return false;
  }
  if (!hasSingleSearchParam(url, "tmdbId", expected.tmdbId)) return false;
  const requestedHash = String(singleSearchParam(url, "sourceHash") || "")
    .trim()
    .toLowerCase();
  if (requestedHash !== expected.sourceHash) return false;
  if (url.searchParams.getAll("refreshResolve").length !== 0) return false;
  if (mediaType === "tv") {
    if (
      Number(singleSearchParam(url, "seasonNumber")) !== expected.seasonNumber
    ) {
      return false;
    }
    if (
      Number(singleSearchParam(url, "episodeNumber")) !== expected.episodeNumber
    ) {
      return false;
    }
  }
  return true;
}

function singleSearchParam(url, name) {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function hasSingleSearchParam(url, name, expected) {
  return singleSearchParam(url, name) === String(expected);
}

function exactMediaTracksRequest(url, expected) {
  return (
    url.pathname === "/api/media/tracks" &&
    hasSingleSearchParam(url, "input", expected.remuxInput) &&
    String(singleSearchParam(url, "subtitleLang") || "").toLowerCase() ===
      "off"
  );
}

function exactRemuxRequest(url, expected) {
  const subtitleValues = url.searchParams.getAll("subtitleStream");
  if (subtitleValues.length > 1) return false;
  const subtitleIndex = String(subtitleValues[0] || "-1");
  return (
    url.pathname === "/api/remux" &&
    hasSingleSearchParam(url, "input", expected.remuxInput) &&
    (subtitleIndex === "-1" || subtitleIndex === "")
  );
}

export function realDebridBenchmarkFetchDecision(
  rawUrl,
  pageUrl,
  baseOrigin,
  expected,
  method = "GET",
) {
  let url;
  try {
    url = new URL(rawUrl, pageUrl);
  } catch {
    return "block-invalid";
  }
  const normalizedMethod = String(method || "GET").toUpperCase();
  if (url.origin !== baseOrigin) return "block-cross-origin";
  if (PROGRESS_PATHS.has(url.pathname)) {
    return normalizedMethod === "GET" && url.pathname !== "/api/session/progress"
      ? "empty-progress-read"
      : "block-progress-mutation";
  }
  if (url.pathname === "/api/resolve/sources") return "block-source-menu";
  if (url.pathname.startsWith("/api/tmdb/")) return "block-tmdb-ui";
  if (
    url.pathname.startsWith("/api/hls/") ||
    url.pathname === "/api/live/hls.m3u8" ||
    url.pathname === "/api/live/hls-resource"
  ) {
    return "block-media-fallback";
  }
  if (url.pathname === "/api/library" && normalizedMethod === "GET") {
    return "empty-library-read";
  }
  if (url.pathname === "/api/resolve/local-upgrade") return "block-local-upgrade";
  if (url.pathname.startsWith("/api/resolve/job/")) return "block-resolve-job";
  if (RESOLVER_PATHS.has(url.pathname)) {
    return normalizedMethod === "GET" && exactResolveRequest(url, expected)
      ? "allow-exact-resolve"
      : "block-resolve";
  }
  if (url.pathname === "/api/media/tracks") {
    return normalizedMethod === "GET" && exactMediaTracksRequest(url, expected)
      ? "allow-exact-tracks"
      : "block-tracks";
  }
  if (url.pathname === "/api/remux") {
    return normalizedMethod === "GET" && exactRemuxRequest(url, expected)
      ? "allow-exact-remux"
      : "block-remux";
  }
  if (
    MUTATION_SENSITIVE_PATHS.has(url.pathname) &&
    !new Set(["GET", "HEAD"]).has(normalizedMethod)
  ) {
    return "block-other-mutation";
  }
  if (!new Set(["GET", "HEAD"]).has(normalizedMethod)) {
    return "block-other-mutation";
  }
  if (
    url.pathname.startsWith("/api/") &&
    !BENCHMARK_SAFE_READ_PATHS.has(url.pathname)
  ) {
    return "block-other-read";
  }
  return "passthrough";
}

function rewrittenResolveUrl(url, expected) {
  const next = new URL(url.toString());
  const mediaType = expected.mediaType === "tv" ? "tv" : "movie";
  next.pathname = `/api/admin/provider-benchmark-resolve/${mediaType}`;
  next.searchParams.set("tmdbId", expected.tmdbId);
  next.searchParams.set("title", expected.displayTitle);
  if (expected.displayYear) next.searchParams.set("year", expected.displayYear);
  else next.searchParams.delete("year");
  next.searchParams.set("sourceHash", expected.sourceHash);
  next.searchParams.set("sessionKey", expected.sessionKey);
  next.searchParams.set("resolverProvider", "real-debrid");
  next.searchParams.set("skipExternalEmbed", "1");
  next.searchParams.set("audioLang", expected.audioLang);
  next.searchParams.set("quality", expected.quality);
  next.searchParams.set("subtitleLang", "off");
  next.searchParams.set(REAL_DEBRID_BENCHMARK_QUERY_FLAG, "1");
  next.searchParams.delete("async");
  next.searchParams.delete("refreshResolve");
  next.searchParams.delete("preferredContainer");
  next.searchParams.delete("minSeeders");
  next.searchParams.delete("allowedFormats");
  next.searchParams.delete("sourceLang");
  next.searchParams.delete("sourceAudioProfile");
  if (expected.mediaType === "tv") {
    next.searchParams.set("seasonNumber", String(expected.seasonNumber));
    next.searchParams.set("episodeNumber", String(expected.episodeNumber));
  }
  return next.toString();
}

function installRealDebridBenchmarkBrowserGuards({
  baseOrigin,
  expected,
  benchmarkHeader,
  realDebridBenchmarkHeader,
  expectedServerInstanceHeader,
  playbackSpeedStorageKey,
  expectedPlaybackRate,
}) {
  const state = {
    exactResolveRequests: 0,
    exactTrackRequests: 0,
    exactRemuxRequests: 0,
    progressReadsEmptied: 0,
    progressMutationsBlocked: 0,
    sourceMenuRequestsBlocked: 0,
    tmdbUiReadsBlocked: 0,
    libraryReadsEmptied: 0,
    localUpgradeRequestsBlocked: 0,
    resolveJobsBlocked: 0,
    unsafeRequestsBlocked: 0,
    playbackSpeedWritesNeutralized: 0,
    playbackSpeedGuardFailures: 0,
  };
  Object.defineProperty(globalThis, "__STREAMARENA_RD_BENCHMARK_SAFETY__", {
    value: state,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  try {
    const expectedPlaybackRateValue = String(expectedPlaybackRate);
    const nativeStorageGetItem = Storage.prototype.getItem;
    const nativeStorageSetItem = Storage.prototype.setItem;
    const nativeStorageRemoveItem = Storage.prototype.removeItem;
    Storage.prototype.getItem = function getItem(key) {
      if (String(key) === playbackSpeedStorageKey) {
        return expectedPlaybackRateValue;
      }
      return nativeStorageGetItem.call(this, key);
    };
    Storage.prototype.setItem = function setItem(key, value) {
      if (String(key) === playbackSpeedStorageKey) {
        if (String(value) !== expectedPlaybackRateValue) {
          state.playbackSpeedWritesNeutralized += 1;
        }
        return nativeStorageSetItem.call(
          this,
          playbackSpeedStorageKey,
          expectedPlaybackRateValue,
        );
      }
      return nativeStorageSetItem.call(this, key, value);
    };
    Storage.prototype.removeItem = function removeItem(key) {
      if (String(key) === playbackSpeedStorageKey) {
        return nativeStorageSetItem.call(
          this,
          playbackSpeedStorageKey,
          expectedPlaybackRateValue,
        );
      }
      return nativeStorageRemoveItem.call(this, key);
    };
    localStorage.setItem(playbackSpeedStorageKey, expectedPlaybackRateValue);
  } catch {
    state.playbackSpeedGuardFailures += 1;
  }
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const jsonResponse = (payload, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );

  globalThis.fetch = (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const method = init?.method || (input instanceof Request ? input.method : "GET");
    const decision = realDebridBenchmarkFetchDecision(
      rawUrl,
      location.href,
      baseOrigin,
      expected,
      method,
    );
    if (decision === "empty-progress-read") {
      state.progressReadsEmptied += 1;
      return jsonResponse({ entries: [] });
    }
    if (decision === "block-progress-mutation") {
      state.progressMutationsBlocked += 1;
      return jsonResponse({ ok: true, disabled: true, session: null });
    }
    if (decision === "block-source-menu") {
      state.sourceMenuRequestsBlocked += 1;
      return jsonResponse({ sources: [] });
    }
    if (decision === "block-tmdb-ui") {
      state.tmdbUiReadsBlocked += 1;
      return jsonResponse({ error: "Benchmark uses persisted title metadata." }, 409);
    }
    if (decision === "empty-library-read") {
      state.libraryReadsEmptied += 1;
      return jsonResponse({ movies: [], series: [] });
    }
    if (decision === "block-local-upgrade") {
      state.localUpgradeRequestsBlocked += 1;
      return jsonResponse({ ready: false });
    }
    if (decision === "block-resolve-job") {
      state.resolveJobsBlocked += 1;
      return jsonResponse({ error: "Synchronous benchmark only." }, 409);
    }
    if (decision.startsWith("block-")) {
      state.unsafeRequestsBlocked += 1;
      return jsonResponse({ error: "Blocked by benchmark safety policy." }, 409);
    }
    let request = input instanceof Request ? new Request(input, init) : null;
    if (decision === "allow-exact-resolve") {
      state.exactResolveRequests += 1;
      const original = new URL(rawUrl, location.href);
      const target = rewrittenResolveUrl(original, expected);
      request = request
        ? new Request(target, request)
        : new Request(target, init);
      const headers = new Headers(request.headers);
      headers.set(benchmarkHeader, "1");
      headers.set(realDebridBenchmarkHeader, "1");
      headers.set(
        expectedServerInstanceHeader,
        expected.serverInstanceIdentity,
      );
      request = new Request(request, { headers });
    } else if (decision === "allow-exact-tracks") {
      state.exactTrackRequests += 1;
      request =
        request || new Request(new URL(rawUrl, location.href).toString(), init);
      request = new Request(request, {
        headers: withProviderBenchmarkHeaders(
          request.headers,
          benchmarkHeader,
          realDebridBenchmarkHeader,
          expectedServerInstanceHeader,
          expected.serverInstanceIdentity,
        ),
      });
    } else if (decision === "allow-exact-remux") {
      state.exactRemuxRequests += 1;
      request =
        request || new Request(new URL(rawUrl, location.href).toString(), init);
      request = new Request(request, {
        headers: withProviderBenchmarkHeaders(
          request.headers,
          benchmarkHeader,
          realDebridBenchmarkHeader,
          expectedServerInstanceHeader,
          expected.serverInstanceIdentity,
        ),
      });
    }
    return request ? nativeFetch(request) : nativeFetch(input, init);
  };

  const nativeSendBeacon = navigator.sendBeacon?.bind(navigator);
  if (nativeSendBeacon) {
    navigator.sendBeacon = (rawUrl, data) => {
      const decision = realDebridBenchmarkFetchDecision(
        rawUrl,
        location.href,
        baseOrigin,
        expected,
        "POST",
      );
      if (decision.startsWith("block-")) {
        if (decision === "block-progress-mutation") {
          state.progressMutationsBlocked += 1;
        } else {
          state.unsafeRequestsBlocked += 1;
        }
        return true;
      }
      return nativeSendBeacon(rawUrl, data);
    };
  }
}

export function buildRealDebridBenchmarkInitScript(baseOrigin, expected) {
  return [
    `const PROGRESS_PATHS = new Set(${JSON.stringify([...PROGRESS_PATHS])});`,
    `const RESOLVER_PATHS = new Set(${JSON.stringify([...RESOLVER_PATHS])});`,
    `const MUTATION_SENSITIVE_PATHS = new Set(${JSON.stringify([...MUTATION_SENSITIVE_PATHS])});`,
    `const BENCHMARK_SAFE_READ_PATHS = new Set(${JSON.stringify([...BENCHMARK_SAFE_READ_PATHS])});`,
    `const REAL_DEBRID_BENCHMARK_QUERY_FLAG = ${JSON.stringify(REAL_DEBRID_BENCHMARK_QUERY_FLAG)};`,
    `const withProviderBenchmarkHeaders = ${withProviderBenchmarkHeaders.toString()};`,
    `const singleSearchParam = ${singleSearchParam.toString()};`,
    `const hasSingleSearchParam = ${hasSingleSearchParam.toString()};`,
    `const exactResolveRequest = ${exactResolveRequest.toString()};`,
    `const exactMediaTracksRequest = ${exactMediaTracksRequest.toString()};`,
    `const exactRemuxRequest = ${exactRemuxRequest.toString()};`,
    `const realDebridBenchmarkFetchDecision = ${realDebridBenchmarkFetchDecision.toString()};`,
    `const rewrittenResolveUrl = ${rewrittenResolveUrl.toString()};`,
    `(${installRealDebridBenchmarkBrowserGuards.toString()})(${JSON.stringify({
      baseOrigin,
      expected,
      benchmarkHeader: PROVIDER_BENCHMARK_HEADER,
      realDebridBenchmarkHeader: REAL_DEBRID_BENCHMARK_HEADER,
      expectedServerInstanceHeader: EXPECTED_SERVER_INSTANCE_HEADER,
      playbackSpeedStorageKey: PLAYBACK_SPEED_STORAGE_KEY,
      expectedPlaybackRate: BENCHMARK_PLAYBACK_RATE,
    })});`,
  ].join("\n");
}

function withProviderBenchmarkHeaders(
  headers,
  benchmarkHeader = PROVIDER_BENCHMARK_HEADER,
  realDebridBenchmarkHeader = REAL_DEBRID_BENCHMARK_HEADER,
  expectedServerInstanceHeader = "x-streamarena-expected-server-instance",
  expectedServerInstanceIdentity = "",
) {
  const next = new Headers(headers || {});
  next.set(benchmarkHeader, "1");
  next.set(realDebridBenchmarkHeader, "1");
  if (expectedServerInstanceIdentity) {
    next.set(expectedServerInstanceHeader, expectedServerInstanceIdentity);
  }
  return next;
}

export function withProviderBenchmarkHeader(
  headers = {},
  expectedServerInstanceIdentity = "",
) {
  return {
    ...headers,
    [PROVIDER_BENCHMARK_HEADER]: "1",
    [REAL_DEBRID_BENCHMARK_HEADER]: "1",
    ...(expectedServerInstanceIdentity
      ? {
          [EXPECTED_SERVER_INSTANCE_HEADER]: expectedServerInstanceIdentity,
        }
      : {}),
  };
}

function rowIdentity(row) {
  return stableDigest([Number(row.user_id), String(row.session_key || "")]);
}

function normalizedPlaybackSessionSemantics(row) {
  return {
    identity: rowIdentity(row),
    userId: Number(row.user_id),
    tmdbId: String(row.tmdb_id || ""),
    audioLang: String(row.audio_lang || ""),
    sourceHash: String(row.source_hash || "").trim().toLowerCase(),
    selectedFile: String(row.selected_file || ""),
    filename: String(row.filename || ""),
    playableUrl: String(row.playable_url || ""),
    fallbackUrls: parseJsonArray(row.fallback_urls_json) || null,
    metadata: parseJsonObject(row.metadata_json),
    lastPositionSeconds: Number(row.last_position_seconds || 0),
    healthState: String(row.health_state || ""),
    healthFailCount: Number(row.health_fail_count || 0),
    lastError: String(row.last_error || ""),
  };
}

function normalizedSessionTimestamps(row) {
  return Object.fromEntries(
    SESSION_TIMESTAMP_FIELDS.map((field) => [field, Number(row[field] || 0)]),
  );
}

function snapshotPlaybackSessions(database, userId) {
  const rows = database
    .prepare(
      `SELECT user_id, session_key, tmdb_id, audio_lang, source_hash,
              selected_file, filename, playable_url, fallback_urls_json,
              metadata_json, last_position_seconds, health_state,
              health_fail_count, last_error, last_verified_at,
              next_validation_at, updated_at, last_accessed_at
         FROM playback_sessions
        WHERE user_id = ?
        ORDER BY session_key`,
    )
    .all(userId);
  const semantics = rows.map(normalizedPlaybackSessionSemantics);
  const timestamps = Object.fromEntries(
    rows.map((row) => [rowIdentity(row), normalizedSessionTimestamps(row)]),
  );
  return {
    count: rows.length,
    semanticsDigest: stableDigest(semantics),
    timestamps,
  };
}

function snapshotMediaProbes(database, selectedProbeKey) {
  const selected = database
    .prepare(
      `SELECT probe_key, payload_json, updated_at
         FROM media_probe_cache
        WHERE probe_key = ?
        ORDER BY probe_key`,
    )
    .all(selectedProbeKey);
  const other = database.snapshot(
    `SELECT probe_key, payload_json, updated_at
       FROM media_probe_cache
      WHERE probe_key != ?
      ORDER BY probe_key`,
    [selectedProbeKey],
  );
  const totalCount = Number(
    database.prepare("SELECT COUNT(*) AS count FROM media_probe_cache").get()
      ?.count || 0,
  );
  return {
    totalCount,
    other,
    selectedCount: selected.length,
    selectedDigest: stableDigest(selected),
    selectedPayloadIdentity:
      selected.length === 1
        ? benchmarkProbeIdentity(
            BENCHMARK_PROBE_PAYLOAD_IDENTITY_DOMAIN,
            selected[0].payload_json,
          )
        : "",
  };
}

function snapshotQuery(database, sql, ...params) {
  return database.snapshot(sql, params);
}

function selectedSessionIdentity(selected) {
  return stableDigest([selected.userId, selected.sessionKey]);
}

export function captureDatabaseInvariants({
  resolverDatabase,
  usersDatabase,
  userId,
  selected,
}) {
  return {
    watchProgress: snapshotQuery(
      usersDatabase,
      `SELECT user_id, source_identity, resume_seconds, updated_at
         FROM user_watch_progress WHERE user_id = ? ORDER BY source_identity`,
      userId,
    ),
    continueWatching: snapshotQuery(
      usersDatabase,
      `SELECT * FROM user_continue_watching
        WHERE user_id = ? ORDER BY source_identity`,
      userId,
    ),
    userPreferences: snapshotQuery(
      usersDatabase,
      `SELECT user_id, pref_key, pref_value, updated_at
         FROM user_preferences WHERE user_id = ? ORDER BY pref_key`,
      userId,
    ),
    providerOverrides: snapshotQuery(
      usersDatabase,
      `SELECT provider_key, override_value, updated_at
         FROM provider_overrides ORDER BY provider_key`,
    ),
    customProviders: snapshotQuery(
      usersDatabase,
      `SELECT id, label, base_url, created_at
         FROM custom_providers ORDER BY id`,
    ),
    sourceHealth: snapshotQuery(
      resolverDatabase,
      `SELECT * FROM source_health_stats ORDER BY source_key`,
    ),
    titlePreferences: snapshotQuery(
      resolverDatabase,
      `SELECT * FROM title_track_preferences
        WHERE user_id = ? ORDER BY media_type, tmdb_id`,
      userId,
    ),
    playbackSessions: snapshotPlaybackSessions(resolverDatabase, userId),
    mediaProbes: snapshotMediaProbes(resolverDatabase, selected.probeKey),
    selectedSessionIdentity: selectedSessionIdentity(selected),
  };
}

function exactSnapshotComparison(before, after) {
  const beforeCount = Math.max(0, Number(before?.count || 0));
  const afterCount = Math.max(0, Number(after?.count || 0));
  const unchanged =
    beforeCount === afterCount &&
    String(before?.digest || "") === String(after?.digest || "");
  return {
    beforeCount,
    afterCount,
    beforeDigest: String(before?.digest || ""),
    afterDigest: String(after?.digest || ""),
    unchanged,
    passed: unchanged,
  };
}

function compareSessionTimestamps(before, after) {
  const beforeEntries = before?.timestamps || {};
  const afterEntries = after?.timestamps || {};
  const unchanged = stableDigest(beforeEntries) === stableDigest(afterEntries);
  return {
    beforeDigest: stableDigest(beforeEntries),
    afterDigest: stableDigest(afterEntries),
    unchanged,
    passed: unchanged,
  };
}

export function compareDatabaseInvariants(before, after) {
  const domains = {};
  for (const name of [
    "watchProgress",
    "continueWatching",
    "userPreferences",
    "providerOverrides",
    "customProviders",
    "sourceHealth",
    "titlePreferences",
  ]) {
    domains[name] = exactSnapshotComparison(before?.[name], after?.[name]);
  }
  const sessionSemanticsUnchanged = Boolean(
    before?.playbackSessions?.count === after?.playbackSessions?.count &&
      before?.playbackSessions?.semanticsDigest ===
        after?.playbackSessions?.semanticsDigest,
  );
  domains.sessionSemantics = {
    beforeCount: Math.max(0, Number(before?.playbackSessions?.count || 0)),
    afterCount: Math.max(0, Number(after?.playbackSessions?.count || 0)),
    beforeDigest: String(before?.playbackSessions?.semanticsDigest || ""),
    afterDigest: String(after?.playbackSessions?.semanticsDigest || ""),
    unchanged: sessionSemanticsUnchanged,
    passed: sessionSemanticsUnchanged,
  };
  const sessionTimestamps = compareSessionTimestamps(
    before?.playbackSessions,
    after?.playbackSessions,
  );
  domains.sessionAccessTimestamps = sessionTimestamps;

  const mediaBefore = before?.mediaProbes || {};
  const mediaAfter = after?.mediaProbes || {};
  const otherProbesUnchanged = Boolean(
    mediaBefore?.other?.count === mediaAfter?.other?.count &&
      mediaBefore?.other?.digest === mediaAfter?.other?.digest,
  );
  const selectedProbeChangeAllowed = Boolean(
    Number(mediaBefore.selectedCount || 0) === 0 &&
      Number(mediaAfter.selectedCount || 0) >= 0 &&
      Number(mediaAfter.selectedCount || 0) <= 1,
  );
  domains.mediaProbeCache = {
    beforeCount: Math.max(0, Number(mediaBefore.totalCount || 0)),
    afterCount: Math.max(0, Number(mediaAfter.totalCount || 0)),
    selectedProbeCreated: Number(mediaAfter.selectedCount || 0) === 1,
    otherBeforeDigest: String(mediaBefore?.other?.digest || ""),
    otherAfterDigest: String(mediaAfter?.other?.digest || ""),
    otherProbesUnchanged,
    passed: otherProbesUnchanged && selectedProbeChangeAllowed,
  };

  const passed = Object.values(domains).every((entry) => entry.passed === true);
  return {
    passed,
    domains,
    allowedChanges: {
      selectedProbeCacheEntry: domains.mediaProbeCache.selectedProbeCreated,
      selectedSessionTimestamps: sessionTimestamps.selectedOnlyMonotonic,
    },
  };
}

function applyBenchmarkProbeOwnershipInvariant(
  invariants,
  after,
  selected,
  probeStatus,
) {
  const expectedProbeKeyIdentity = benchmarkProbeIdentity(
    BENCHMARK_PROBE_KEY_IDENTITY_DOMAIN,
    selected.probeKey,
  );
  const selectedCreated = Number(after?.mediaProbes?.selectedCount || 0) === 1;
  const keyMatched =
    probeStatus?.probeKeyIdentity === expectedProbeKeyIdentity;
  const payloadMatched = Boolean(
    probeStatus?.payloadIdentity &&
      probeStatus.payloadIdentity ===
        after?.mediaProbes?.selectedPayloadIdentity,
  );
  const createdByRun = probeStatus?.outcome === "created";
  const drained = probeStatus?.terminal === true && probeStatus?.activeRuns === 0;
  const passed = Boolean(
    invariants?.domains?.mediaProbeCache?.passed &&
      selectedCreated &&
      keyMatched &&
      payloadMatched &&
      createdByRun &&
      drained,
  );
  invariants.domains.mediaProbeCache = {
    ...invariants.domains.mediaProbeCache,
    selectedProbeCreated: selectedCreated,
    benchmarkOwnershipCreated: createdByRun,
    benchmarkSourceMatched: keyMatched,
    benchmarkContentDigestMatched: payloadMatched,
    benchmarkProbeDrained: drained,
    passed,
  };
  invariants.passed = Object.values(invariants.domains).every(
    (entry) => entry.passed === true,
  );
  return {
    createdByRun,
    keyMatched,
    payloadMatched,
    drained,
    passed,
  };
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function numericTree(value) {
  if (Array.isArray(value)) return value.map(numericTree);
  if (!value || typeof value !== "object") {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entry]) => [key, numericTree(entry)])
      .filter(([, entry]) => entry !== undefined),
  );
}

function numericDelta(after, before) {
  const result = {};
  for (const [key, value] of Object.entries(after || {})) {
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      typeof before?.[key] === "number" &&
      Number.isFinite(before[key])
    ) {
      result[key] = value - before[key];
    }
  }
  return result;
}

async function readJsonResponse(response, code, deadlineAtMs) {
  if (response.status() !== 200) throw benchmarkError(code);
  try {
    return await runWithDeadline(
      () => response.json(),
      deadlineAtMs,
      `${code}_TIMEOUT`,
    );
  } catch (error) {
    if (error?.benchmarkCode) throw error;
    throw benchmarkError(code);
  }
}

async function readAuthAccount(context, baseOrigin, timeoutMs) {
  const deadline = performance.now() + Math.min(timeoutMs, 10_000);
  const response = await context.request.get(`${baseOrigin}/api/auth/me`, {
    failOnStatusCode: false,
    timeout: Math.min(timeoutMs, 10_000),
  });
  const payload = await readJsonResponse(response, "AUTH_ACCOUNT_INVALID", deadline);
  const account = authAccountFromPayload(payload);
  const userId = Number(account?.accountId || 0);
  if (!account?.isAdmin || !Number.isInteger(userId) || userId <= 0) {
    throw benchmarkError("AUTH_DATABASE_ID_INVALID");
  }
  return { userId };
}

export async function readRealDebridBenchmarkAttestations(
  context,
  baseOrigin,
  timeoutMs,
) {
  const deadline = performance.now() + Math.min(timeoutMs, 10_000);
  const response = await context.request.get(
    `${baseOrigin}/api/admin/provider-benchmark-capability`,
    {
      failOnStatusCode: false,
      timeout: Math.min(timeoutMs, 10_000),
      headers: withProviderBenchmarkHeader(),
    },
  );
  if (response.status() !== 200) {
    throw benchmarkError("BENCHMARK_CAPABILITY_UNAVAILABLE");
  }
  if (
    responseHeader(
      response.headers(),
      "x-streamarena-provider-health-recording",
    ) !== "suppressed"
  ) {
    throw benchmarkError("BENCHMARK_CAPABILITY_NOT_ACKNOWLEDGED");
  }
  let payload;
  try {
    payload = await runWithDeadline(
      () => response.json(),
      deadline,
      "BENCHMARK_CAPABILITY_TIMEOUT",
    );
  } catch (error) {
    if (error?.benchmarkCode) throw error;
    throw benchmarkError("BENCHMARK_CAPABILITY_INVALID");
  }
  const attestation = {
    realDebridPlaybackSessionScopeIdentity: String(
      payload?.realDebridPlaybackSessionScopeIdentity || "",
    ),
    resolverCacheIdentity: String(
      payload?.databaseIdentities?.resolverCache || "",
    ),
    usersDbIdentity: String(payload?.databaseIdentities?.users || ""),
    serverInstanceIdentity: String(payload?.serverInstanceIdentity || ""),
  };
  if (
    payload?.available !== true ||
    payload?.realDebridExactSessionReuse !== true ||
    !OPAQUE_IDENTITY_PATTERN.test(attestation.resolverCacheIdentity) ||
    !OPAQUE_IDENTITY_PATTERN.test(attestation.usersDbIdentity) ||
    !OPAQUE_IDENTITY_PATTERN.test(attestation.serverInstanceIdentity) ||
    (attestation.realDebridPlaybackSessionScopeIdentity &&
      !OPAQUE_IDENTITY_PATTERN.test(
        attestation.realDebridPlaybackSessionScopeIdentity,
      ))
  ) {
    throw benchmarkError("BENCHMARK_CAPABILITY_INVALID");
  }
  return attestation;
}

export function assertRealDebridBenchmarkAttestations(
  attestation,
  { resolverCachePath, usersDbPath, sessionScopeIdentity },
) {
  const expectedResolverIdentity = benchmarkDatabasePathIdentity(
    resolverCachePath,
    "resolver-cache",
  );
  const expectedUsersIdentity = benchmarkDatabasePathIdentity(usersDbPath, "users");
  if (attestation?.resolverCacheIdentity !== expectedResolverIdentity) {
    throw benchmarkError("RESOLVER_DATABASE_IDENTITY_MISMATCH");
  }
  if (attestation?.usersDbIdentity !== expectedUsersIdentity) {
    throw benchmarkError("USERS_DATABASE_IDENTITY_MISMATCH");
  }
  if (
    sessionScopeIdentity &&
    attestation?.realDebridPlaybackSessionScopeIdentity !== sessionScopeIdentity
  ) {
    throw benchmarkError("REAL_DEBRID_SESSION_SCOPE_MISMATCH");
  }
  return true;
}

async function readRealDebridReadiness(context, baseOrigin, timeoutMs) {
  const deadline = performance.now() + Math.min(timeoutMs, 10_000);
  const response = await context.request.get(
    `${baseOrigin}/api/user/torrent-settings`,
    {
      failOnStatusCode: false,
      timeout: Math.min(timeoutMs, 10_000),
    },
  );
  const payload = await readJsonResponse(
    response,
    "REAL_DEBRID_SETTINGS_UNAVAILABLE",
    deadline,
  );
  return payload?.configured === true && payload?.enabled === true;
}

async function readProviderConfiguration(context, baseOrigin, timeoutMs) {
  const deadline = performance.now() + Math.min(timeoutMs, 10_000);
  const response = await context.request.get(`${baseOrigin}/api/admin/providers`, {
    failOnStatusCode: false,
    timeout: Math.min(timeoutMs, 10_000),
  });
  const payload = await readJsonResponse(
    response,
    "PROVIDER_CONFIGURATION_UNAVAILABLE",
    deadline,
  );
  const providers = Array.isArray(payload?.providers) ? payload.providers : [];
  return { count: providers.length, digest: stableDigest(payload) };
}

async function readRuntime(
  context,
  baseOrigin,
  timeoutMs,
  expectedServerInstanceIdentity,
) {
  const deadline = performance.now() + Math.min(timeoutMs, 10_000);
  const response = await context.request.get(`${baseOrigin}/api/health`, {
    failOnStatusCode: false,
    timeout: Math.min(timeoutMs, 10_000),
    headers: withProviderBenchmarkHeader({}, expectedServerInstanceIdentity),
  });
  const payload = await readJsonResponse(response, "RUNTIME_UNAVAILABLE", deadline);
  return {
    remux: numericTree(payload?.streaming?.remux || {}),
    resolver: numericTree(payload?.resolver || {}),
    mediaProbe: numericTree(payload?.mediaProbe || {}),
    serverInstanceIdentity: String(
      response.headers()["x-streamarena-server-instance"] || "",
    ),
  };
}

async function readBenchmarkProbeStatus(
  context,
  baseOrigin,
  runNonce,
  timeoutMs,
  expectedServerInstanceIdentity,
) {
  const deadline = performance.now() + Math.min(timeoutMs, 10_000);
  const url = new URL(
    "/api/admin/provider-benchmark-probe-status",
    baseOrigin,
  );
  url.searchParams.set("run", runNonce);
  const response = await context.request.get(url.toString(), {
    failOnStatusCode: false,
    timeout: Math.min(timeoutMs, 10_000),
    headers: withProviderBenchmarkHeader({}, expectedServerInstanceIdentity),
  });
  const payload = await readJsonResponse(
    response,
    "BENCHMARK_PROBE_STATUS_INVALID",
    deadline,
  );
  const probe = payload?.probe || {};
  const status = {
    runNonce: String(probe.runNonce || ""),
    probeKeyIdentity: String(probe.probeKeyIdentity || ""),
    outcome: String(probe.outcome || ""),
    terminal: probe.terminal === true,
    payloadIdentity: String(probe.payloadIdentity || ""),
    activeRuns: Number(probe.activeRuns),
    serverInstanceIdentity: String(payload?.serverInstanceIdentity || ""),
  };
  if (
    !RUN_NONCE_PATTERN.test(status.runNonce) ||
    !OPAQUE_IDENTITY_PATTERN.test(status.probeKeyIdentity) ||
    !new Set(["running", "created", "lost-race", "failed"]).has(
      status.outcome,
    ) ||
    !Number.isInteger(status.activeRuns) ||
    status.activeRuns < 0 ||
    !OPAQUE_IDENTITY_PATTERN.test(status.serverInstanceIdentity) ||
    (status.outcome === "created" &&
      !OPAQUE_IDENTITY_PATTERN.test(status.payloadIdentity))
  ) {
    throw benchmarkError("BENCHMARK_PROBE_STATUS_INVALID");
  }
  return status;
}

async function waitForBenchmarkProbeStatus(
  context,
  baseOrigin,
  expected,
  timeoutMs,
) {
  const deadline = performance.now() + timeoutMs;
  let status = null;
  while (performance.now() < deadline) {
    status = await readBenchmarkProbeStatus(
      context,
      baseOrigin,
      expected.runNonce,
      Math.min(10_000, Math.max(1, deadline - performance.now())),
      expected.serverInstanceIdentity,
    );
    if (
      status.runNonce !== expected.runNonce ||
      status.probeKeyIdentity !== expected.probeKeyIdentity ||
      status.serverInstanceIdentity !== expected.serverInstanceIdentity
    ) {
      throw benchmarkError("BENCHMARK_PROBE_OWNERSHIP_MISMATCH");
    }
    if (status.terminal && status.activeRuns === 0) return status;
    await delay(Math.min(250, Math.max(1, deadline - performance.now())));
  }
  throw benchmarkError("BENCHMARK_PROBE_NOT_DRAINED");
}

function remuxIsIdle(runtime) {
  return (
    finiteNumber(runtime?.remux?.active, -1) === 0 &&
    finiteNumber(runtime?.remux?.activeJobs, -1) === 0
  );
}

function mediaProbeIsIdle(runtime) {
  return (
    finiteNumber(runtime?.mediaProbe?.active, -1) === 0 &&
    finiteNumber(runtime?.mediaProbe?.prewarmActive, -1) === 0 &&
    finiteNumber(runtime?.mediaProbe?.benchmarkActive, -1) === 0
  );
}

function benchmarkRuntimeIsIdle(runtime) {
  return Boolean(
    remuxIsIdle(runtime) &&
      mediaProbeIsIdle(runtime) &&
      finiteNumber(runtime?.resolver?.activeResolves, -1) === 0 &&
      finiteNumber(runtime?.resolver?.externalActive, -1) === 0,
  );
}

async function drainBenchmarkJobs(
  context,
  baseOrigin,
  timeoutMs,
  expectedServerInstanceIdentity,
) {
  const deadline = performance.now() + timeoutMs;
  let runtime = null;
  while (performance.now() < deadline) {
    runtime = await readRuntime(
      context,
      baseOrigin,
      Math.min(10_000, Math.max(1, deadline - performance.now())),
      expectedServerInstanceIdentity,
    );
    if (benchmarkRuntimeIsIdle(runtime)) return runtime;
    await delay(Math.min(300, Math.max(1, deadline - performance.now())));
  }
  throw benchmarkError("BENCHMARK_JOBS_NOT_DRAINED");
}

function responseHeader(headers, name) {
  const target = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === target) return String(value || "");
  }
  return "";
}

export function parseResolverServerTiming(rawValue) {
  const result = {};
  for (const part of String(rawValue || "").split(",")) {
    const [rawName, ...parameters] = part.split(";");
    const name = String(rawName || "").trim().toLowerCase();
    if (!/^(?:resolve|resolver)(?:-[a-z0-9]+)*$/.test(name)) continue;
    const duration = parameters
      .map((parameter) => /^\s*dur\s*=\s*(\d+(?:\.\d+)?)\s*$/i.exec(parameter))
      .find(Boolean);
    if (!duration) continue;
    const value = Number(duration[1]);
    if (Number.isFinite(value) && value >= 0) {
      result[name] = Number(value.toFixed(3));
    }
  }
  return result;
}

function createRealDebridNetworkCapture(page, baseOrigin, expected, startedEpochMs) {
  const requests = new Map();
  const capture = {
    resolver: {
      requestCount: 0,
      responseCount: 0,
      firstResponseMs: null,
      statuses: {},
      serverTimingMs: {},
    },
    remux: {
      requestCount: 0,
      responseCount: 0,
      successfulResponseCount: 0,
      matchingRequestCount: 0,
      mismatchedRequestCount: 0,
      firstResponseMs: null,
      firstBodyDataMs: null,
      receivedBytes: 0,
      statuses: {},
      serverTimingMs: {},
      serverInstanceIdentities: [],
    },
    tracks: {
      requestCount: 0,
      responseCount: 0,
      serverInstanceIdentities: [],
    },
  };
  let cdp = null;

  function trialTimeFromWall(wallTimeSeconds) {
    const epoch = Number(wallTimeSeconds) * 1_000;
    return Number.isFinite(epoch)
      ? Number(Math.max(0, epoch - startedEpochMs).toFixed(1))
      : 0;
  }

  function trialTimeFromRecord(record, monotonicSeconds) {
    const delta = Number(monotonicSeconds) * 1_000 - record.startedMonotonicMs;
    return Number(Math.max(0, record.startedTrialMs + delta).toFixed(1));
  }

  function classify(rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (url.origin !== baseOrigin) return null;
      if (RESOLVER_PATHS.has(url.pathname)) return { kind: "resolver", url };
      if (url.pathname === "/api/remux") return { kind: "remux", url };
      if (url.pathname === "/api/media/tracks") return { kind: "tracks", url };
    } catch {
      // Invalid URLs never become tracked benchmark requests.
    }
    return null;
  }

  function registerResponse(record, response, timestamp) {
    if (!record || record.responded) return;
    record.responded = true;
    const bucket = capture[record.kind];
    bucket.responseCount += 1;
    const status = String(Math.floor(Number(response?.status || 0)));
    const successfulRemuxResponse =
      record.kind !== "remux" || status === "200" || status === "206";
    record.successfulResponse = successfulRemuxResponse;
    bucket.statuses = bucket.statuses || {};
    bucket.statuses[status] = (bucket.statuses[status] || 0) + 1;
    if (record.kind === "remux" && successfulRemuxResponse) {
      bucket.successfulResponseCount += 1;
    }
    const responseMs = trialTimeFromRecord(record, timestamp);
    if (
      Object.hasOwn(bucket, "firstResponseMs") &&
      successfulRemuxResponse &&
      (bucket.firstResponseMs === null || responseMs < bucket.firstResponseMs)
    ) {
      bucket.firstResponseMs = responseMs;
    }
    if (record.kind === "remux" || record.kind === "tracks") {
      bucket.serverInstanceIdentities.push(
        responseHeader(response?.headers, "x-streamarena-server-instance"),
      );
    }
    if (record.kind === "resolver") {
      Object.assign(
        bucket.serverTimingMs,
        parseResolverServerTiming(
          responseHeader(response?.headers, "server-timing"),
        ),
      );
    } else if (record.kind === "remux" && successfulRemuxResponse) {
      Object.assign(
        bucket.serverTimingMs,
        parseRemuxServerTiming(responseHeader(response?.headers, "server-timing")),
      );
    }
  }

  return {
    async start() {
      cdp = await page.context().newCDPSession(page);
      await cdp.send("Network.enable");
      cdp.on("Network.requestWillBeSent", (event) => {
        const classified = classify(event.request?.url);
        if (!classified) return;
        const bucket = capture[classified.kind];
        bucket.requestCount += 1;
        if (classified.kind === "remux") {
          if (exactRemuxRequest(classified.url, expected)) {
            bucket.matchingRequestCount += 1;
          } else {
            bucket.mismatchedRequestCount += 1;
          }
        }
        requests.set(event.requestId, {
          kind: classified.kind,
          startedMonotonicMs: Number(event.timestamp) * 1_000,
          startedTrialMs: trialTimeFromWall(event.wallTime),
          responded: false,
          successfulResponse: false,
        });
      });
      cdp.on("Network.responseReceived", (event) => {
        registerResponse(
          requests.get(event.requestId),
          event.response,
          event.timestamp,
        );
      });
      cdp.on("Network.dataReceived", (event) => {
        const record = requests.get(event.requestId);
        if (
          !record ||
          record.kind !== "remux" ||
          !record.successfulResponse
        ) {
          return;
        }
        const length = Math.max(0, Number(event.dataLength || 0));
        capture.remux.receivedBytes += length;
        if (length > 0 && capture.remux.firstBodyDataMs === null) {
          capture.remux.firstBodyDataMs = trialTimeFromRecord(
            record,
            event.timestamp,
          );
        }
      });
      cdp.on("Network.loadingFinished", (event) => requests.delete(event.requestId));
      cdp.on("Network.loadingFailed", (event) => requests.delete(event.requestId));
    },
    async finish() {
      await cdp?.detach().catch(() => {});
      capture.remux.receivedBytes = Math.max(
        0,
        Math.floor(capture.remux.receivedBytes),
      );
      return capture;
    },
  };
}

function createRealDebridResolveObserver(
  page,
  baseOrigin,
  expected,
  startedAtMs,
  deadline,
) {
  const observations = [];
  const parsers = [];
  const onResponse = (response) => {
    let url;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    if (url.origin !== baseOrigin || !RESOLVER_PATHS.has(url.pathname)) return;
    const parser = (async () => {
      let classification;
      let sessionMatched = false;
      let exactReusePayload = false;
      let benchmarkProbeRun = null;
      try {
        const payload = response.ok()
          ? await runWithDeadline(
              () => response.json(),
              deadline,
              "RESOLVE_RESPONSE_TIMEOUT",
            )
          : null;
        sessionMatched =
          String(payload?.session?.key || "").trim() === expected.sessionKey;
        exactReusePayload = payload?.benchmarkExactSessionReuse === true;
        const rawProbeRun = payload?.benchmarkProbeRun;
        if (
          rawProbeRun?.scheduled === true &&
          RUN_NONCE_PATTERN.test(String(rawProbeRun.runNonce || "")) &&
          OPAQUE_IDENTITY_PATTERN.test(
            String(rawProbeRun.probeKeyIdentity || ""),
          ) &&
          OPAQUE_IDENTITY_PATTERN.test(
            String(rawProbeRun.serverInstanceIdentity || ""),
          )
        ) {
          benchmarkProbeRun = {
            runNonce: String(rawProbeRun.runNonce),
            probeKeyIdentity: String(rawProbeRun.probeKeyIdentity),
            serverInstanceIdentity: String(rawProbeRun.serverInstanceIdentity),
          };
        }
        classification = classifyResolveResponsePayload(
          response.status(),
          payload,
          { jsonParsed: response.ok() },
        );
      } catch {
        classification = classifyResolveResponsePayload(
          response.status(),
          null,
          { jsonParsed: false },
        );
      }
      observations.push({
        status: response.status(),
        responseKind: classification.responseKind,
        identityComplete: classification.identityComplete,
        hashMatched: classification.resolvedHash === expected.sourceHash,
        providerMatched: classification.resolverProvider === "real-debrid",
        sessionMatched,
        exactReusePayload,
        benchmarkProbeRun,
        exactReuseAcknowledged:
          String(
            response.headers()[
              "x-streamarena-real-debrid-exact-reuse"
            ] || "",
          ) === "enforced",
        suppressionAcknowledged:
          String(response.headers()["x-streamarena-provider-health-recording"] || "") ===
          "suppressed",
        completedAtMs:
          classification.responseKind === "terminal"
            ? Number((performance.now() - startedAtMs).toFixed(1))
            : null,
      });
    })();
    parsers.push(parser);
  };
  page.on("response", onResponse);
  return {
    async finish() {
      page.off("response", onResponse);
      await Promise.allSettled(parsers);
      const terminals = observations.filter(
        (entry) => entry.responseKind === "terminal",
      );
      const valid = terminals.filter(
        (entry) =>
          entry.identityComplete &&
          entry.hashMatched &&
          entry.providerMatched &&
          entry.sessionMatched &&
          entry.exactReusePayload &&
          entry.exactReuseAcknowledged &&
          entry.benchmarkProbeRun,
      );
      return {
        responseCount: observations.length,
        terminalCount: terminals.length,
        identityMatched: valid.length > 0,
        providerMatched: valid.length > 0,
        sessionMatched: valid.length > 0,
        exactReuseAcknowledged: valid.length > 0,
        healthSuppressionAcknowledged:
          observations.length > 0 &&
          observations.every((entry) => entry.suppressionAcknowledged),
        completionMs: valid
          .map((entry) => entry.completedAtMs)
          .filter(Number.isFinite)
          .sort((left, right) => left - right)[0] ?? null,
        benchmarkProbeRun:
          valid.length === 1 ? valid[0].benchmarkProbeRun : null,
      };
    },
  };
}

function isForcedResolveRequest(url, expected) {
  const mediaType = expected.mediaType === "tv" ? "tv" : "movie";
  return Boolean(
    exactResolveRequest(url, expected) &&
      url.pathname === `/api/admin/provider-benchmark-resolve/${mediaType}` &&
      hasSingleSearchParam(url, "sessionKey", expected.sessionKey) &&
      hasSingleSearchParam(url, "title", expected.displayTitle) &&
      (expected.displayYear
        ? hasSingleSearchParam(url, "year", expected.displayYear)
        : url.searchParams.getAll("year").length === 0) &&
      hasSingleSearchParam(url, "resolverProvider", "real-debrid") &&
      hasSingleSearchParam(url, "skipExternalEmbed", "1") &&
      hasSingleSearchParam(url, "audioLang", expected.audioLang) &&
      hasSingleSearchParam(url, "quality", expected.quality) &&
      hasSingleSearchParam(url, "subtitleLang", "off") &&
      hasSingleSearchParam(url, REAL_DEBRID_BENCHMARK_QUERY_FLAG, "1") &&
      url.searchParams.getAll("async").length === 0 &&
      url.searchParams.getAll("preferredContainer").length === 0 &&
      url.searchParams.getAll("minSeeders").length === 0 &&
      url.searchParams.getAll("allowedFormats").length === 0 &&
      url.searchParams.getAll("sourceLang").length === 0 &&
      url.searchParams.getAll("sourceAudioProfile").length === 0
  );
}

async function installContextSafetyGuards(context, baseOrigin, expected) {
  const state = {
    backupBlocks: 0,
    crossOriginMediaBlocks: 0,
    forcedResolveRequests: 0,
  };
  await context.route("**/*", async (route) => {
    const request = route.request();
    let url;
    try {
      url = new URL(request.url());
    } catch {
      state.backupBlocks += 1;
      await route.abort("blockedbyclient");
      return;
    }
    const unexpectedMediaResource =
      request.resourceType() === "media" &&
      !(url.origin === baseOrigin && exactRemuxRequest(url, expected));
    const crossOriginMedia =
      unexpectedMediaResource ||
      (url.origin !== baseOrigin &&
        (/(?:^|\.)real-debrid\.com$/i.test(url.hostname) ||
          /\.(?:m3u8|mpd|mp4|m4s|ts|aac|mkv|webm)$/i.test(url.pathname)));
    if (crossOriginMedia) {
      state.crossOriginMediaBlocks += 1;
      await route.abort("blockedbyclient");
      return;
    }
    if (url.origin !== baseOrigin) {
      const readOnlyVisual =
        new Set(["GET", "HEAD"]).has(request.method().toUpperCase()) &&
        new Set(["image", "font", "stylesheet"]).has(request.resourceType());
      if (readOnlyVisual) {
        await route.continue();
        return;
      }
      state.backupBlocks += 1;
      await route.abort("blockedbyclient");
      return;
    }
    const decision = realDebridBenchmarkFetchDecision(
      url.toString(),
      baseOrigin,
      baseOrigin,
      expected,
      request.method(),
    );
    if (decision === "allow-exact-resolve") {
      if (!isForcedResolveRequest(url, expected)) {
        state.backupBlocks += 1;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: '{"error":"Benchmark resolve policy rejected the request."}',
        });
        return;
      }
      state.forcedResolveRequests += 1;
      await route.continue({
        headers: withProviderBenchmarkHeader(
          request.headers(),
          expected.serverInstanceIdentity,
        ),
      });
      return;
    }
    if (
      decision === "allow-exact-tracks" ||
      decision === "allow-exact-remux"
    ) {
      await route.continue({
        headers: withProviderBenchmarkHeader(
          request.headers(),
          expected.serverInstanceIdentity,
        ),
      });
      return;
    }
    if (decision === "empty-progress-read") {
      state.backupBlocks += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: '{"entries":[]}',
      });
      return;
    }
    if (decision === "empty-library-read") {
      state.backupBlocks += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: '{"movies":[],"series":[]}',
      });
      return;
    }
    if (decision === "block-source-menu") {
      state.backupBlocks += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: '{"sources":[]}',
      });
      return;
    }
    if (decision === "block-local-upgrade") {
      state.backupBlocks += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: '{"ready":false}',
      });
      return;
    }
    if (decision.startsWith("block-")) {
      state.backupBlocks += 1;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: '{"error":"Blocked by benchmark safety policy."}',
      });
      return;
    }
    await route.continue();
  });
  return state;
}

function safePlayerSnapshot(snapshot) {
  const timings = snapshot?.timings || {};
  const counters = snapshot?.counters || {};
  const quality = snapshot?.quality || {};
  const frames = snapshot?.frameStats || {};
  const video = snapshot?.videoMetrics || {};
  const nullable = (value) =>
    Number.isFinite(Number(value)) ? Number(value) : null;
  const count = (value) => Math.max(0, Math.floor(Number(value) || 0));
  return {
    capturedAtMs: nullable(snapshot?.capturedAtMs),
    currentTime: nullable(snapshot?.currentTime),
    playbackRate: nullable(snapshot?.playbackRate),
    readyState: count(snapshot?.readyState),
    networkState: count(snapshot?.networkState),
    paused: Boolean(snapshot?.paused),
    playbackMode: String(snapshot?.source?.mode || "unknown")
      .trim()
      .toLowerCase()
      .slice(0, 24),
    milestones: {
      loadedMetadataMs: nullable(timings.firstLoadedMetadataMs),
      canPlayMs: nullable(timings.firstCanPlayMs),
      playingMs: nullable(timings.firstPlayingMs),
      firstTimeUpdateMs: nullable(timings.firstTimeUpdateMs),
      firstFrameMs: nullable(timings.firstVideoFrameMs),
    },
    events: {
      waiting: count(counters.waiting),
      stalled: count(counters.stalled),
      errors: count(counters.error),
    },
    frames: {
      decoded: count(quality.totalVideoFrames),
      dropped: count(quality.droppedVideoFrames),
      corrupted: count(quality.corruptedVideoFrames),
      callbacks: count(frames.callbackCount),
    },
    video: {
      width: count(video.videoWidth),
      height: count(video.videoHeight),
    },
  };
}

export function benchmarkPlaybackRateIsOne(value) {
  const rate = Number(value);
  return (
    Number.isFinite(rate) &&
    Math.abs(rate - BENCHMARK_PLAYBACK_RATE) <= BENCHMARK_PLAYBACK_RATE_EPSILON
  );
}

export function benchmarkPlaybackProofIsRealtime(proof) {
  const ratio = Number(proof?.mediaToWallTimeRatio);
  return (
    Number.isFinite(ratio) &&
    ratio >= MIN_MEDIA_TO_WALL_TIME_RATIO &&
    ratio <= MAX_MEDIA_TO_WALL_TIME_RATIO
  );
}

async function readPlayerSample(page) {
  const raw = await page.evaluate(() => {
    const video = document.querySelector("video");
    return {
      snapshot: window.__STREAMARENA_PLAYBACK_BENCHMARK__?.getSnapshot?.() || null,
      timeOriginMs: Number(performance.timeOrigin),
      nowMs: Number(performance.now()),
      mediaErrorCode: Number(video?.error?.code || 0),
    };
  });
  return {
    observedAtMs: performance.now(),
    snapshot: safePlayerSnapshot(raw.snapshot),
    clock: { timeOriginMs: raw.timeOriginMs, nowMs: raw.nowMs },
    mediaErrorCode: raw.mediaErrorCode,
  };
}

function samplePlayable(sample) {
  return Boolean(
    sample?.snapshot?.readyState >= 3 &&
      sample.snapshot.playbackMode === "remux" &&
      benchmarkPlaybackRateIsOne(sample.snapshot.playbackRate) &&
      !sample.snapshot.paused &&
      sample.snapshot.video.width > 0 &&
      sample.snapshot.video.height > 0 &&
      sample.snapshot.events.errors === 0 &&
      sample.mediaErrorCode === 0,
  );
}

function playbackAdvanced(previous, current) {
  return Boolean(
    Number(current?.snapshot?.currentTime || 0) >
      Number(previous?.snapshot?.currentTime || 0) + 0.001 &&
      Number(current?.snapshot?.frames?.decoded || 0) >
        Number(previous?.snapshot?.frames?.decoded || 0),
  );
}

function playbackProof(start, end, sampleCount) {
  const sampledDurationMs = Number(
    Math.max(0, end.observedAtMs - start.observedAtMs).toFixed(1),
  );
  const mediaTimeDeltaSeconds = Number(
    Math.max(
      0,
      Number(end.snapshot.currentTime || 0) -
        Number(start.snapshot.currentTime || 0),
    ).toFixed(3),
  );
  return {
    sampledDurationMs,
    mediaTimeDeltaSeconds,
    mediaToWallTimeRatio:
      sampledDurationMs > 0
        ? Number(
            (mediaTimeDeltaSeconds / (sampledDurationMs / 1_000)).toFixed(3),
          )
        : null,
    decodedFrameDelta: Math.max(
      0,
      end.snapshot.frames.decoded - start.snapshot.frames.decoded,
    ),
    droppedFrameDelta: Math.max(
      0,
      end.snapshot.frames.dropped - start.snapshot.frames.dropped,
    ),
    waitingDelta: Math.max(
      0,
      end.snapshot.events.waiting - start.snapshot.events.waiting,
    ),
    stalledDelta: Math.max(
      0,
      end.snapshot.events.stalled - start.snapshot.events.stalled,
    ),
    sampleCount,
  };
}

async function waitForPlaybackProof(page, advanceMs, deadline) {
  let start = null;
  let previous = null;
  let sampleCount = 0;
  while (performance.now() < deadline) {
    const sample = await readPlayerSample(page);
    if (!samplePlayable(sample)) {
      start = null;
      previous = null;
      sampleCount = 0;
    } else if (!start) {
      start = sample;
      previous = sample;
      sampleCount = 1;
    } else {
      const noNewStall =
        sample.snapshot.events.waiting === start.snapshot.events.waiting &&
        sample.snapshot.events.stalled === start.snapshot.events.stalled;
      const continuous =
        sample.observedAtMs - previous.observedAtMs <= 1_000 &&
        playbackAdvanced(previous, sample);
      if (!noNewStall || !continuous) {
        start = sample;
        previous = sample;
        sampleCount = 1;
      } else {
        previous = sample;
        sampleCount += 1;
        const proof = playbackProof(start, sample, sampleCount);
        if (
          proof.sampledDurationMs >= advanceMs &&
          proof.mediaTimeDeltaSeconds >= advanceMs / 1_000 &&
          benchmarkPlaybackProofIsRealtime(proof) &&
          proof.decodedFrameDelta > 0 &&
          proof.waitingDelta === 0 &&
          proof.stalledDelta === 0
        ) {
          return { sample, proof };
        }
      }
    }
    await delay(Math.min(250, Math.max(1, deadline - performance.now())));
  }
  throw benchmarkError("PLAYBACK_PROOF_TIMEOUT");
}

function buildPlayerUrl(baseOrigin, selected) {
  const pathname =
    selected.mediaType === "tv"
      ? `/watch/tv/${selected.tmdbId}/s${selected.seasonNumber}e${selected.episodeNumber}`
      : `/watch/movie/${selected.tmdbId}`;
  const url = new URL(pathname, baseOrigin);
  url.searchParams.set("tmdbId", selected.tmdbId);
  url.searchParams.set("mediaType", selected.mediaType);
  url.searchParams.set("title", selected.displayTitle);
  if (selected.displayYear) url.searchParams.set("year", selected.displayYear);
  if (selected.mediaType === "tv") {
    url.searchParams.set("seasonNumber", String(selected.seasonNumber));
    url.searchParams.set("episodeNumber", String(selected.episodeNumber));
    url.searchParams.set("episode", `Episode ${selected.episodeNumber}`);
  }
  url.searchParams.set("sourceHash", selected.sourceHash);
  url.searchParams.set("sessionKey", selected.sessionKey);
  url.searchParams.set("audioLang", selected.audioLang);
  url.searchParams.set("quality", selected.quality);
  url.searchParams.set("subtitleLang", "off");
  url.searchParams.set("resolverProvider", "real-debrid");
  url.searchParams.set("benchmark", "1");
  return url;
}

async function runBrowserPlayback({
  context,
  baseOrigin,
  selected,
  timeoutMs,
  advanceMs,
  contextSafety,
  preNavigationCheck,
}) {
  const page = await context.newPage();
  try {
    preNavigationCheck?.();
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
  const startedAtMs = performance.now();
  const startedEpochMs = Date.now();
  const deadline = startedAtMs + timeoutMs;
  const resolveStartDeadline = Math.min(
    deadline,
    startedAtMs + RESOLVE_START_TIMEOUT_MS,
  );
  const navigation = { domContentLoadedMs: null, loadMs: null };
  const diagnostics = { pageErrorCount: 0, requestFailureCount: 0 };
  let proof = null;
  let finalSample = null;
  let failureCode = "";
  page.on("pageerror", () => {
    diagnostics.pageErrorCount += 1;
  });
  page.on("requestfailed", () => {
    diagnostics.requestFailureCount += 1;
  });
  page.once("domcontentloaded", () => {
    navigation.domContentLoadedMs = Number(
      (performance.now() - startedAtMs).toFixed(1),
    );
  });
  page.once("load", () => {
    navigation.loadMs = Number((performance.now() - startedAtMs).toFixed(1));
  });

  const networkCapture = createRealDebridNetworkCapture(
    page,
    baseOrigin,
    selected,
    startedEpochMs,
  );
  const resolveObserver = createRealDebridResolveObserver(
    page,
    baseOrigin,
    selected,
    startedAtMs,
    deadline,
  );
  await networkCapture.start();
  try {
    await page.goto(buildPlayerUrl(baseOrigin, selected).toString(), {
      waitUntil: "domcontentloaded",
      timeout: Math.max(1, resolveStartDeadline - performance.now()),
    });
    await page.waitForFunction(
      () =>
        Number(
          window.__STREAMARENA_RD_BENCHMARK_SAFETY__?.exactResolveRequests || 0,
      ) >= 1,
      undefined,
      { timeout: Math.max(1, resolveStartDeadline - performance.now()) },
    );
    await page.waitForFunction(
      () => Boolean(window.__STREAMARENA_PLAYBACK_BENCHMARK__?.getSnapshot),
      undefined,
      { timeout: Math.max(1, deadline - performance.now()) },
    );
    const forcedPlaybackRate = await page.evaluate(
      ({ playbackSpeedStorageKey, expectedPlaybackRate }) => {
        try {
          localStorage.setItem(
            playbackSpeedStorageKey,
            String(expectedPlaybackRate),
          );
        } catch {
          // The in-memory media element setting below remains authoritative.
        }
        const video = document.querySelector("video");
        if (!video) return null;
        video.defaultPlaybackRate = expectedPlaybackRate;
        video.playbackRate = expectedPlaybackRate;
        video.muted = true;
        return Number(video.playbackRate);
      },
      {
        playbackSpeedStorageKey: PLAYBACK_SPEED_STORAGE_KEY,
        expectedPlaybackRate: BENCHMARK_PLAYBACK_RATE,
      },
    );
    if (!benchmarkPlaybackRateIsOne(forcedPlaybackRate)) {
      throw benchmarkError("PLAYBACK_RATE_CONTROL_FAILED");
    }
    await page.evaluate(() => {
      const video = document.querySelector("video");
      try {
        const attempt = window.__STREAMARENA_PLAYBACK_BENCHMARK__?.play?.();
        attempt?.catch?.(() => {});
      } catch {
        // The measured playback proof records a failed play attempt.
      }
    });
    const result = await waitForPlaybackProof(page, advanceMs, deadline);
    proof = result.proof;
    finalSample = result.sample;
  } catch (error) {
    failureCode = errorCode(error, "PLAYBACK_FAILED");
    finalSample = await readPlayerSample(page).catch(() => null);
  }

  await page.evaluate(() => document.querySelector("video")?.pause()).catch(() => {});
  await page.waitForTimeout(100).catch(() => {});
  const browserSafety = await page
    .evaluate(() => ({
      exactResolveRequests: Number(
        window.__STREAMARENA_RD_BENCHMARK_SAFETY__?.exactResolveRequests || 0,
      ),
      exactTrackRequests: Number(
        window.__STREAMARENA_RD_BENCHMARK_SAFETY__?.exactTrackRequests || 0,
      ),
      progressReadsEmptied: Number(
        window.__STREAMARENA_RD_BENCHMARK_SAFETY__?.progressReadsEmptied || 0,
      ),
      progressMutationsBlocked: Number(
        window.__STREAMARENA_RD_BENCHMARK_SAFETY__?.progressMutationsBlocked || 0,
      ),
      sourceMenuRequestsBlocked: Number(
        window.__STREAMARENA_RD_BENCHMARK_SAFETY__?.sourceMenuRequestsBlocked || 0,
      ),
      tmdbUiReadsBlocked: Number(
        window.__STREAMARENA_RD_BENCHMARK_SAFETY__?.tmdbUiReadsBlocked || 0,
      ),
      libraryReadsEmptied: Number(
        window.__STREAMARENA_RD_BENCHMARK_SAFETY__?.libraryReadsEmptied || 0,
      ),
      localUpgradeRequestsBlocked: Number(
        window.__STREAMARENA_RD_BENCHMARK_SAFETY__?.localUpgradeRequestsBlocked || 0,
      ),
      resolveJobsBlocked: Number(
        window.__STREAMARENA_RD_BENCHMARK_SAFETY__?.resolveJobsBlocked || 0,
      ),
      unsafeRequestsBlocked: Number(
        window.__STREAMARENA_RD_BENCHMARK_SAFETY__?.unsafeRequestsBlocked || 0,
      ),
      playbackSpeedWritesNeutralized: Number(
        window.__STREAMARENA_RD_BENCHMARK_SAFETY__
          ?.playbackSpeedWritesNeutralized || 0,
      ),
      playbackSpeedGuardFailures: Number(
        window.__STREAMARENA_RD_BENCHMARK_SAFETY__
          ?.playbackSpeedGuardFailures || 0,
      ),
    }))
    .catch(() => null);
  const pinning = await resolveObserver.finish();
  const network = await networkCapture.finish();
  await page.close().catch(() => {});

  const snapshot = finalSample?.snapshot || safePlayerSnapshot(null);
  const milestones = alignBenchmarkMilestones(
    snapshot,
    finalSample?.clock,
    startedEpochMs,
  );
  return {
    failureCode,
    navigation,
    diagnostics,
    pinning,
    network,
    browserSafety,
    contextSafety: { ...contextSafety },
    milestones,
    playback: {
      currentTime: snapshot.currentTime,
      playbackRate: snapshot.playbackRate,
      readyState: snapshot.readyState,
      networkState: snapshot.networkState,
      paused: snapshot.paused,
      mode: snapshot.playbackMode,
      width: snapshot.video.width,
      height: snapshot.video.height,
      decodedFrames: snapshot.frames.decoded,
      droppedFrames: snapshot.frames.dropped,
      corruptedFrames: snapshot.frames.corrupted,
      frameCallbacks: snapshot.frames.callbacks,
      waitingCount: snapshot.events.waiting,
      stalledCount: snapshot.events.stalled,
      errorCount: snapshot.events.errors,
      continuous: proof,
    },
  };
}

function providerConfigurationInvariant(before, after) {
  const unchanged = Boolean(
    before?.count === after?.count && before?.digest === after?.digest,
  );
  return {
    beforeCount: Math.max(0, Number(before?.count || 0)),
    afterCount: Math.max(0, Number(after?.count || 0)),
    beforeDigest: String(before?.digest || ""),
    afterDigest: String(after?.digest || ""),
    unchanged,
    passed: unchanged,
  };
}

function withProviderConfigurationInvariant(invariants, before, after) {
  const next = {
    ...invariants,
    domains: {
      ...invariants.domains,
      providerConfiguration: providerConfigurationInvariant(before, after),
    },
  };
  next.passed = Object.values(next.domains).every(
    (entry) => entry.passed === true,
  );
  return next;
}

export function resolverExternalStartedUnchanged(runtimeBefore, runtimeAfter) {
  const before = Number(runtimeBefore?.resolver?.externalStarted);
  const after = Number(runtimeAfter?.resolver?.externalStarted);
  return Number.isFinite(before) && Number.isFinite(after) && after === before;
}

function playbackFailureCodes(
  result,
  invariants,
  runtimeBefore,
  runtimeAfter,
  serverInstanceContinuous,
  probeOwnership,
  expectedMediaType,
  performanceBudgets,
) {
  const failures = [];
  if (result.failureCode) failures.push(result.failureCode);
  if (!result.browserSafety) failures.push("BROWSER_SAFETY_STATE_MISSING");
  if (result.browserSafety?.exactResolveRequests !== 1) {
    failures.push("EXACT_RESOLVE_NOT_ISSUED");
  }
  if (result.browserSafety?.resolveJobsBlocked > 0) {
    failures.push("ASYNC_RESOLVE_ATTEMPTED");
  }
  if (result.browserSafety?.unsafeRequestsBlocked > 0) {
    failures.push("UNSAFE_BROWSER_REQUEST_BLOCKED");
  }
  if (result.contextSafety?.backupBlocks > 0) {
    failures.push("CONTEXT_GUARD_BLOCKED_REQUEST");
  }
  if (result.contextSafety?.crossOriginMediaBlocks > 0) {
    failures.push("CROSS_ORIGIN_MEDIA_ATTEMPTED");
  }
  if (result.contextSafety?.forcedResolveRequests !== 1) {
    failures.push("FORCED_RESOLVE_NOT_OBSERVED");
  }
  if (result.browserSafety?.playbackSpeedGuardFailures > 0) {
    failures.push("PLAYBACK_SPEED_GUARD_FAILED");
  }
  if (
    result.network.resolver.requestCount !== 1 ||
    result.network.resolver.responseCount !== 1 ||
    result.pinning.responseCount !== 1 ||
    result.pinning.terminalCount !== 1
  ) {
    failures.push("EXACT_RESOLVE_COUNT_MISMATCH");
  }
  if (!result.pinning.identityMatched) failures.push("PIN_IDENTITY_MISMATCH");
  if (!result.pinning.providerMatched) failures.push("PROVIDER_MISMATCH");
  if (!result.pinning.sessionMatched) failures.push("SESSION_KEY_MISMATCH");
  if (!result.pinning.exactReuseAcknowledged) {
    failures.push("EXACT_REUSE_NOT_ACKNOWLEDGED");
  }
  if (!result.pinning.healthSuppressionAcknowledged) {
    failures.push("HEALTH_SUPPRESSION_NOT_ACKNOWLEDGED");
  }
  if (result.network.remux.requestCount < 1) failures.push("REMUX_NOT_REQUESTED");
  if (result.network.remux.mismatchedRequestCount > 0) {
    failures.push("REMUX_INPUT_MISMATCH");
  }
  if (result.network.remux.successfulResponseCount < 1) {
    failures.push("REMUX_NO_SUCCESSFUL_RESPONSE");
  }
  if (!Number.isFinite(result.network.remux.firstBodyDataMs)) {
    failures.push("REMUX_NO_BODY_DATA");
  } else if (
    result.network.remux.firstBodyDataMs >
    performanceBudgets.maxRemuxFirstBodyMs
  ) {
    failures.push("REMUX_FIRST_BODY_BUDGET_EXCEEDED");
  }
  if (!Number.isFinite(result.network.remux.serverTimingMs?.["remux-response"])) {
    failures.push("REMUX_SERVER_TIMING_MISSING");
  }
  if (
    !Number.isFinite(
      result.network.resolver.serverTimingMs?.["resolve-response"],
    )
  ) {
    failures.push("RESOLVER_SERVER_TIMING_MISSING");
  }
  if (result.playback.mode !== "remux") failures.push("REMUX_PLAYBACK_NOT_PROVEN");
  if (!benchmarkPlaybackRateIsOne(result.playback.playbackRate)) {
    failures.push("PLAYBACK_RATE_NOT_ONE");
  }
  if (result.playback.readyState < 3) failures.push("READY_STATE_TOO_LOW");
  if (result.playback.width < 1 || result.playback.height < 1) {
    failures.push("VIDEO_DIMENSIONS_MISSING");
  }
  if (!result.playback.continuous?.decodedFrameDelta) {
    failures.push("DECODED_ADVANCE_NOT_PROVEN");
  }
  if (!benchmarkPlaybackProofIsRealtime(result.playback.continuous)) {
    failures.push("PLAYBACK_NOT_REALTIME");
  }
  if (!Number.isFinite(result.milestones.firstFrameMs)) {
    failures.push("FIRST_FRAME_TIMING_MISSING");
  } else if (
    result.milestones.firstFrameMs > performanceBudgets.maxFirstFrameMs
  ) {
    failures.push("FIRST_FRAME_BUDGET_EXCEEDED");
  }
  if (!invariants.passed) failures.push("DATABASE_INVARIANTS_CHANGED");
  if (!probeOwnership?.passed) failures.push("PROBE_OWNERSHIP_NOT_PROVEN");
  if (!resolverExternalStartedUnchanged(runtimeBefore, runtimeAfter)) {
    failures.push("EXACT_SESSION_REUSE_NOT_PROVEN");
  }
  const resolverDelta = numericDelta(runtimeAfter?.resolver, runtimeBefore?.resolver);
  const expectedRequestKey =
    expectedMediaType === "tv" ? "tvRequests" : "movieRequests";
  const otherRequestKey =
    expectedMediaType === "tv" ? "movieRequests" : "tvRequests";
  if (
    resolverDelta[expectedRequestKey] !== 1 ||
    resolverDelta[otherRequestKey] !== 0
  ) {
    failures.push("RESOLVER_REQUEST_COUNT_MISMATCH");
  }
  if (!serverInstanceContinuous) failures.push("SERVER_INSTANCE_CHANGED");
  if (!remuxIsIdle(runtimeAfter)) failures.push("REMUX_NOT_DRAINED");
  if (!mediaProbeIsIdle(runtimeAfter)) failures.push("MEDIA_PROBE_NOT_DRAINED");
  return [...new Set(failures)];
}

export function assertRealDebridReportSanitized(report) {
  assertSanitizedReport(report);
  const encoded = JSON.stringify(report);
  if (
    /(?:sessionKey|remuxInput|probeKey|resolverCachePath|usersDbPath|cdpEndpoint)/i.test(
      encoded,
    )
  ) {
    throw benchmarkError("UNSAFE_RD_REPORT_FIELD");
  }
  if (SOURCE_HASH_PATTERN.test(encoded) || /[a-f0-9]{40}/i.test(encoded)) {
    throw benchmarkError("UNSAFE_RD_REPORT_SOURCE_IDENTITY");
  }
  return true;
}

export function writePrivateRealDebridReport(rawOutputDirectory, report) {
  assertRealDebridReportSanitized(report);
  const outputDirectory = resolve(String(rawOutputDirectory || ""));
  try {
    const existing = lstatSync(outputDirectory);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error("unsafe");
    }
    if ((existing.mode & 0o777) !== 0o700) throw new Error("unsafe");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw benchmarkError("PRIVATE_REPORT_DIRECTORY_INVALID");
    }
    try {
      mkdirSync(outputDirectory, { mode: 0o700 });
      chmodSync(outputDirectory, 0o700);
    } catch {
      throw benchmarkError("PRIVATE_REPORT_DIRECTORY_INVALID");
    }
  }
  const outputPath = join(outputDirectory, REPORT_FILENAME);
  writeReportAtomically(outputPath, report);
  chmodSync(outputPath, 0o600);
  if (
    (statSync(outputDirectory).mode & 0o777) !== 0o700 ||
    (statSync(outputPath).mode & 0o777) !== 0o600
  ) {
    throw benchmarkError("PRIVATE_REPORT_PERMISSIONS_INVALID");
  }
  return outputPath;
}

function unavailableReport({ reasonCode, options, invariants, runtimeBefore, runtimeAfter }) {
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: "unavailable",
    reasonCode,
    options: {
      timeoutMs: options.timeoutMs,
      advanceMs: options.advanceMs,
      drainTimeoutMs: options.drainTimeoutMs,
      maxRemuxFirstBodyMs: options.maxRemuxFirstBodyMs,
      maxFirstFrameMs: options.maxFirstFrameMs,
      subtitlePolicy: "off",
      sessionPolicy: "existing-healthy-probe-cold",
    },
    safety: {
      disposableBrowserContext: true,
      authenticationMaterialCopiedInMemoryOnly: true,
      databasesOpenedReadOnly: true,
      cacheEvictionAttempted: false,
      progressWritesAttempted: false,
    },
    invariants,
    runtime: {
      remuxBefore: runtimeBefore?.remux || {},
      remuxAfter: runtimeAfter?.remux || {},
      remuxDelta: numericDelta(runtimeAfter?.remux, runtimeBefore?.remux),
      resolverDelta: numericDelta(runtimeAfter?.resolver, runtimeBefore?.resolver),
    },
    gate: { passed: false, failureCodes: [reasonCode] },
  };
  assertRealDebridReportSanitized(report);
  return report;
}

export async function runRealDebridPlaybackBenchmark(options) {
  options = {
    baseUrl: DEFAULT_BASE_URL,
    authOrigin: "",
    cdpEndpoint: "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    advanceMs: DEFAULT_ADVANCE_MS,
    drainTimeoutMs: DEFAULT_DRAIN_TIMEOUT_MS,
    maxRemuxFirstBodyMs: DEFAULT_MAX_REMUX_FIRST_BODY_MS,
    maxFirstFrameMs: DEFAULT_MAX_FIRST_FRAME_MS,
    ...options,
  };
  assertBenchmarkNumericOptions(options);
  assertBenchmarkTransportSecurity(options.baseUrl, "http");
  assertBenchmarkTransportSecurity(
    options.authOrigin || options.baseUrl,
    "http",
  );
  assertBenchmarkTransportSecurity(options.cdpEndpoint, "cdp");
  const baseOrigin = normalizeOrigin(options.baseUrl, "INVALID_BASE_ORIGIN");
  const authOrigin = normalizeOrigin(
    options.authOrigin || options.baseUrl,
    "INVALID_AUTH_ORIGIN",
  );
  assertSameAuthOrigin(baseOrigin, authOrigin);
  const browser = await chromium.connectOverCDP(options.cdpEndpoint);
  let context = null;
  let resolverDatabase = null;
  let usersDatabase = null;
  try {
    context = await createIsolatedAuthenticatedContext({
      browser,
      authOrigin,
      baseOrigin,
      timeoutMs: options.timeoutMs,
    });
    const { userId } = await readAuthAccount(context, baseOrigin, options.timeoutMs);
    const realDebridReady = await readRealDebridReadiness(
      context,
      baseOrigin,
      options.timeoutMs,
    );
    resolverDatabase = openReadOnlyDatabase(
      options.resolverCachePath,
      "RESOLVER_DATABASE_UNAVAILABLE",
    );
    usersDatabase = openReadOnlyDatabase(
      options.usersDbPath,
      "USERS_DATABASE_UNAVAILABLE",
    );
    if (
      !benchmarkDatabaseFilesAreDistinct(
        options.resolverCachePath,
        options.usersDbPath,
      )
    ) {
      throw benchmarkError("DATABASE_PATHS_NOT_DISTINCT");
    }
    requireTables(resolverDatabase, [
      "playback_sessions",
      "media_probe_cache",
      "source_health_stats",
      "title_track_preferences",
      "tmdb_response_cache",
    ]);
    requireTables(usersDatabase, [
      "user_watch_progress",
      "user_continue_watching",
      "user_preferences",
      "provider_overrides",
      "custom_providers",
    ]);

    const minimumSelectionFreshMs = BENCHMARK_START_FRESHNESS_WINDOW_MS;
    const selected = readSelection(
      resolverDatabase,
      userId,
      Date.now(),
      minimumSelectionFreshMs,
    );
    const capabilityBefore = await readRealDebridBenchmarkAttestations(
      context,
      baseOrigin,
      options.timeoutMs,
    );
    assertRealDebridBenchmarkAttestations(capabilityBefore, {
      resolverCachePath: options.resolverCachePath,
      usersDbPath: options.usersDbPath,
      sessionScopeIdentity: selected?.sessionScopeIdentity || "",
    });
    if (selected) {
      selected.serverInstanceIdentity = capabilityBefore.serverInstanceIdentity;
    }
    const runtimeBefore = await readRuntime(
      context,
      baseOrigin,
      options.timeoutMs,
      capabilityBefore.serverInstanceIdentity,
    );
    const providerBefore = await readProviderConfiguration(
      context,
      baseOrigin,
      options.timeoutMs,
    );
    const snapshotTarget =
      selected ||
      ({
        userId,
        sessionKey: "none",
        sourceHash: "none",
        probeKey: "none",
      });
    const before = captureDatabaseInvariants({
      resolverDatabase,
      usersDatabase,
      userId,
      selected: snapshotTarget,
    });

    if (!realDebridReady || !selected || !benchmarkRuntimeIsIdle(runtimeBefore)) {
      const reasonCode = !realDebridReady
        ? "REAL_DEBRID_NOT_READY"
        : selected
          ? "RUNTIME_BUSY"
          : "NO_SAFE_PROBE_COLD_SESSION";
      const providerAfter = await readProviderConfiguration(
        context,
        baseOrigin,
        options.timeoutMs,
      );
      const runtimeAfter = await readRuntime(
        context,
        baseOrigin,
        options.timeoutMs,
        capabilityBefore.serverInstanceIdentity,
      );
      const after = captureDatabaseInvariants({
        resolverDatabase,
        usersDatabase,
        userId,
        selected: snapshotTarget,
      });
      const invariants = withProviderConfigurationInvariant(
        compareDatabaseInvariants(before, after),
        providerBefore,
        providerAfter,
      );
      return unavailableReport({
        reasonCode,
        options,
        invariants,
        runtimeBefore,
        runtimeAfter,
      });
    }

    // Close the selection-to-run race without deleting, expiring, or rewriting
    // any cache row. If another request populated the exact probe meanwhile,
    // this benchmark is no longer cold and must decline to run.
    if (
      readSelection(
        resolverDatabase,
        userId,
        Date.now(),
        minimumSelectionFreshMs,
      )?.probeKey !== selected.probeKey
    ) {
      const providerAfter = await readProviderConfiguration(
        context,
        baseOrigin,
        options.timeoutMs,
      );
      const runtimeAfter = await readRuntime(
        context,
        baseOrigin,
        options.timeoutMs,
        capabilityBefore.serverInstanceIdentity,
      );
      const after = captureDatabaseInvariants({
        resolverDatabase,
        usersDatabase,
        userId,
        selected,
      });
      const invariants = withProviderConfigurationInvariant(
        compareDatabaseInvariants(before, after),
        providerBefore,
        providerAfter,
      );
      return unavailableReport({
        reasonCode: "COLD_SESSION_CHANGED_BEFORE_RUN",
        options,
        invariants,
        runtimeBefore,
        runtimeAfter,
      });
    }

    await context.addInitScript({
      content: buildRealDebridBenchmarkInitScript(baseOrigin, selected),
    });
    const contextSafety = await installContextSafetyGuards(
      context,
      baseOrigin,
      selected,
    );
    let playbackResult;
    try {
      playbackResult = await runBrowserPlayback({
        context,
        baseOrigin,
        selected,
        timeoutMs: options.timeoutMs,
        advanceMs: options.advanceMs,
        contextSafety,
        preNavigationCheck: () => {
          const currentSelection = readSelection(
            resolverDatabase,
            userId,
            Date.now(),
            BENCHMARK_START_FRESHNESS_WINDOW_MS,
          );
          if (!benchmarkSelectionsMatch(selected, currentSelection)) {
            throw benchmarkError(
              "COLD_SESSION_CHANGED_OR_STALE_BEFORE_NAVIGATION",
            );
          }
        },
      });
    } catch (error) {
      if (
        errorCode(error) ===
        "COLD_SESSION_CHANGED_OR_STALE_BEFORE_NAVIGATION"
      ) {
        const providerAfter = await readProviderConfiguration(
          context,
          baseOrigin,
          options.timeoutMs,
        );
        const runtimeAfter = await readRuntime(
          context,
          baseOrigin,
          options.timeoutMs,
          capabilityBefore.serverInstanceIdentity,
        );
        const after = captureDatabaseInvariants({
          resolverDatabase,
          usersDatabase,
          userId,
          selected,
        });
        const invariants = withProviderConfigurationInvariant(
          compareDatabaseInvariants(before, after),
          providerBefore,
          providerAfter,
        );
        return unavailableReport({
          reasonCode: "COLD_SESSION_CHANGED_OR_STALE_BEFORE_NAVIGATION",
          options,
          invariants,
          runtimeBefore,
          runtimeAfter,
        });
      }
      playbackResult = {
        failureCode: errorCode(error, "PLAYBACK_FAILED"),
        navigation: {},
        diagnostics: { pageErrorCount: 0, requestFailureCount: 0 },
        pinning: {
          responseCount: 0,
          terminalCount: 0,
          identityMatched: false,
          providerMatched: false,
          sessionMatched: false,
          exactReuseAcknowledged: false,
          healthSuppressionAcknowledged: false,
          completionMs: null,
        },
        network: {
          resolver: { requestCount: 0, responseCount: 0, serverTimingMs: {} },
          remux: {
            requestCount: 0,
            responseCount: 0,
            successfulResponseCount: 0,
            matchingRequestCount: 0,
            mismatchedRequestCount: 0,
            firstResponseMs: null,
            firstBodyDataMs: null,
            receivedBytes: 0,
            serverTimingMs: {},
          },
          tracks: { requestCount: 0, responseCount: 0 },
        },
        browserSafety: null,
        contextSafety: { ...contextSafety },
        milestones: {},
        playback: {
          currentTime: null,
          playbackRate: null,
          readyState: 0,
          networkState: 0,
          paused: true,
          mode: "unknown",
          width: 0,
          height: 0,
          decodedFrames: 0,
          droppedFrames: 0,
          corruptedFrames: 0,
          frameCallbacks: 0,
          waitingCount: 0,
          stalledCount: 0,
          errorCount: 0,
          continuous: null,
        },
      };
    }

    const benchmarkProbeRun = playbackResult.pinning.benchmarkProbeRun;
    let probeStatus = null;
    let probeStatusFailure = "";
    if (
      benchmarkProbeRun?.serverInstanceIdentity !==
      capabilityBefore.serverInstanceIdentity
    ) {
      probeStatusFailure = "BENCHMARK_PROBE_INSTANCE_MISMATCH";
    } else {
      try {
        probeStatus = await waitForBenchmarkProbeStatus(
          context,
          baseOrigin,
          benchmarkProbeRun,
          options.drainTimeoutMs,
        );
      } catch (error) {
        probeStatusFailure = errorCode(
          error,
          "BENCHMARK_PROBE_NOT_DRAINED",
        );
      }
    }
    delete playbackResult.pinning.benchmarkProbeRun;
    playbackResult.pinning.benchmarkProbeScheduled = Boolean(benchmarkProbeRun);
    playbackResult.pinning.benchmarkProbeTerminal = Boolean(
      probeStatus?.terminal,
    );
    playbackResult.pinning.benchmarkProbeCreated =
      probeStatus?.outcome === "created";

    let drainFailure = "";
    let runtimeAfter;
    try {
      runtimeAfter = await drainBenchmarkJobs(
        context,
        baseOrigin,
        options.drainTimeoutMs,
        capabilityBefore.serverInstanceIdentity,
      );
    } catch (error) {
      drainFailure = errorCode(error, "BENCHMARK_JOBS_NOT_DRAINED");
      runtimeAfter = await readRuntime(
        context,
        baseOrigin,
        options.timeoutMs,
        capabilityBefore.serverInstanceIdentity,
      );
    }
    const providerAfter = await readProviderConfiguration(
      context,
      baseOrigin,
      options.timeoutMs,
    );
    let serverInstanceContinuous = false;
    try {
      const capabilityAfter = await readRealDebridBenchmarkAttestations(
        context,
        baseOrigin,
        options.timeoutMs,
      );
      const responseInstances = [
        ...(playbackResult.network.remux.serverInstanceIdentities || []),
        ...(playbackResult.network.tracks.serverInstanceIdentities || []),
      ];
      serverInstanceContinuous =
        capabilityAfter.serverInstanceIdentity ===
          capabilityBefore.serverInstanceIdentity &&
        runtimeBefore.serverInstanceIdentity ===
          capabilityBefore.serverInstanceIdentity &&
        runtimeAfter.serverInstanceIdentity ===
          capabilityBefore.serverInstanceIdentity &&
        benchmarkProbeRun?.serverInstanceIdentity ===
          capabilityBefore.serverInstanceIdentity &&
        probeStatus?.serverInstanceIdentity ===
          capabilityBefore.serverInstanceIdentity &&
        responseInstances.length ===
          playbackResult.network.remux.responseCount +
            playbackResult.network.tracks.responseCount &&
        responseInstances.every(
          (identity) => identity === capabilityBefore.serverInstanceIdentity,
        );
    } catch {
      serverInstanceContinuous = false;
    }
    const after = captureDatabaseInvariants({
      resolverDatabase,
      usersDatabase,
      userId,
      selected,
    });
    const invariants = withProviderConfigurationInvariant(
      compareDatabaseInvariants(before, after),
      providerBefore,
      providerAfter,
    );
    const probeOwnership = applyBenchmarkProbeOwnershipInvariant(
      invariants,
      after,
      selected,
      probeStatus,
    );
    const failureCodes = playbackFailureCodes(
      playbackResult,
      invariants,
      runtimeBefore,
      runtimeAfter,
      serverInstanceContinuous,
      probeOwnership,
      selected.mediaType,
      {
        maxRemuxFirstBodyMs: options.maxRemuxFirstBodyMs,
        maxFirstFrameMs: options.maxFirstFrameMs,
      },
    );
    if (drainFailure) failureCodes.push(drainFailure);
    if (probeStatusFailure) failureCodes.push(probeStatusFailure);
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      status: "complete",
      selection: {
        mediaType: selected.mediaType,
        tmdbId: selected.tmdbId,
        seasonNumber: selected.seasonNumber || null,
        episodeNumber: selected.episodeNumber || null,
        audioLanguage: selected.audioLang,
        quality: selected.quality,
        probeColdAtStart: true,
        healthState: "healthy",
      },
      options: {
        timeoutMs: options.timeoutMs,
        advanceMs: options.advanceMs,
        drainTimeoutMs: options.drainTimeoutMs,
        maxRemuxFirstBodyMs: options.maxRemuxFirstBodyMs,
        maxFirstFrameMs: options.maxFirstFrameMs,
        subtitlePolicy: "off",
        sessionPolicy: "existing-healthy-probe-cold",
      },
      timings: {
        navigationDomContentLoadedMs:
          playbackResult.navigation.domContentLoadedMs ?? null,
        loadMs: playbackResult.navigation.loadMs ?? null,
        resolverFirstResponseMs:
          playbackResult.network.resolver.firstResponseMs ?? null,
        resolverCompletionMs: playbackResult.pinning.completionMs,
        resolverServerTimingMs:
          playbackResult.network.resolver.serverTimingMs || {},
        remuxFirstResponseMs:
          playbackResult.network.remux.firstResponseMs ?? null,
        remuxFirstBodyDataMs:
          playbackResult.network.remux.firstBodyDataMs ?? null,
        remuxServerTimingMs:
          playbackResult.network.remux.serverTimingMs || {},
        loadedMetadataMs: playbackResult.milestones.loadedMetadataMs ?? null,
        canPlayMs: playbackResult.milestones.canPlayMs ?? null,
        playingMs: playbackResult.milestones.playingMs ?? null,
        firstFrameMs: playbackResult.milestones.firstFrameMs ?? null,
      },
      playback: playbackResult.playback,
      resolver: playbackResult.pinning,
      network: {
        resolverRequestCount: playbackResult.network.resolver.requestCount,
        resolverResponseCount: playbackResult.network.resolver.responseCount,
        remuxRequestCount: playbackResult.network.remux.requestCount,
        remuxResponseCount: playbackResult.network.remux.responseCount,
        remuxSuccessfulResponseCount:
          playbackResult.network.remux.successfulResponseCount,
        remuxBodyBytes: playbackResult.network.remux.receivedBytes,
        mediaTrackRequestCount: playbackResult.network.tracks.requestCount,
        mediaTrackResponseCount: playbackResult.network.tracks.responseCount,
      },
      safety: {
        disposableBrowserContext: true,
        authenticationMaterialCopiedInMemoryOnly: true,
        databasesOpenedReadOnly: true,
        cacheEvictionAttempted: false,
        exactResolveRequests:
          playbackResult.browserSafety?.exactResolveRequests || 0,
        forcedResolveRequests: playbackResult.contextSafety.forcedResolveRequests,
        progressReadsEmptied:
          playbackResult.browserSafety?.progressReadsEmptied || 0,
        progressMutationsBlocked:
          playbackResult.browserSafety?.progressMutationsBlocked || 0,
        sourceMenuRequestsBlocked:
          playbackResult.browserSafety?.sourceMenuRequestsBlocked || 0,
        tmdbUiReadsBlocked:
          playbackResult.browserSafety?.tmdbUiReadsBlocked || 0,
        libraryReadsEmptied:
          playbackResult.browserSafety?.libraryReadsEmptied || 0,
        localUpgradeRequestsBlocked:
          playbackResult.browserSafety?.localUpgradeRequestsBlocked || 0,
        unsafeBrowserRequestsBlocked:
          playbackResult.browserSafety?.unsafeRequestsBlocked || 0,
        playbackSpeedWritesNeutralized:
          playbackResult.browserSafety?.playbackSpeedWritesNeutralized || 0,
        playbackSpeedGuardFailures:
          playbackResult.browserSafety?.playbackSpeedGuardFailures || 0,
        contextGuardBlocks: playbackResult.contextSafety.backupBlocks,
        crossOriginMediaBlocks:
          playbackResult.contextSafety.crossOriginMediaBlocks,
        benchmarkProbeOwnershipCreated: probeOwnership.createdByRun,
        benchmarkProbeContentDigestMatched: probeOwnership.payloadMatched,
        benchmarkProbeDrained: probeOwnership.drained,
        serverInstanceContinuous,
      },
      diagnostics: playbackResult.diagnostics,
      invariants,
      runtime: {
        remuxBefore: runtimeBefore.remux,
        remuxAfter: runtimeAfter.remux,
        remuxDelta: numericDelta(runtimeAfter.remux, runtimeBefore.remux),
        resolverDelta: numericDelta(runtimeAfter.resolver, runtimeBefore.resolver),
        mediaProbeBefore: runtimeBefore.mediaProbe,
        mediaProbeAfter: runtimeAfter.mediaProbe,
        mediaProbeDelta: numericDelta(
          runtimeAfter.mediaProbe,
          runtimeBefore.mediaProbe,
        ),
        jobsDrained:
          remuxIsIdle(runtimeAfter) && mediaProbeIsIdle(runtimeAfter),
      },
      gate: {
        passed: failureCodes.length === 0,
        failureCodes: [...new Set(failureCodes)],
      },
    };
    assertRealDebridReportSanitized(report);
    return report;
  } finally {
    resolverDatabase?.close?.();
    usersDatabase?.close?.();
    await context?.close().catch(() => {});
  }
}

function printReportSummary(report) {
  if (report.status === "unavailable") {
    console.log(`Real-Debrid benchmark unavailable: ${report.reasonCode}`);
    return;
  }
  const firstFrame = Number.isFinite(report.timings?.firstFrameMs)
    ? `${Math.round(report.timings.firstFrameMs)}ms`
    : "n/a";
  const firstBody = Number.isFinite(report.timings?.remuxFirstBodyDataMs)
    ? `${Math.round(report.timings.remuxFirstBodyDataMs)}ms`
    : "n/a";
  console.log(
    `Real-Debrid playback ${report.gate.passed ? "PASS" : "FAIL"}: first body ${firstBody}, first frame ${firstFrame}, decoded ${report.playback.decodedFrames}, dropped ${report.playback.droppedFrames}`,
  );
}

async function main() {
  let options;
  try {
    options = parseRealDebridBenchmarkArgs(process.argv.slice(2));
  } catch {
    console.error("Real-Debrid benchmark failed: INVALID_ARGUMENTS");
    return 1;
  }
  if (options.help) {
    console.log(realDebridBenchmarkHelpText());
    return 0;
  }
  try {
    const report = await runRealDebridPlaybackBenchmark(options);
    writePrivateRealDebridReport(options.outputDir, report);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printReportSummary(report);
    if (report.status === "unavailable") return 3;
    return report.gate.passed ? 0 : 2;
  } catch (error) {
    console.error(`Real-Debrid benchmark failed: ${errorCode(error)}`);
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

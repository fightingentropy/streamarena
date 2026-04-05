#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, "..");

const DEFAULT_PORT = 5181;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_WARMUP_MS = 2_500;
const DEFAULT_MEASURE_MS = 8_000;
const DEFAULT_PAUSE_MS = 600;
const DEFAULT_OBJECTIVE = "balanced";
const DEFAULT_VIEWPORT = { width: 1600, height: 900 };
const DEFAULT_SOURCE_CANDIDATES = [
  "assets/videos/Pride.Prejudice.2005.2160p.4K.WEB.x265.10bit.AAC5.1-[YTS.MX].mp4",
  "assets/videos/jeffrey-epstein-filthy-rich-official-trailer-netflix.mp4",
];

function parseArgs(argv) {
  const options = {
    source: "",
    port: DEFAULT_PORT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    warmupMs: DEFAULT_WARMUP_MS,
    measureMs: DEFAULT_MEASURE_MS,
    pauseMs: DEFAULT_PAUSE_MS,
    headed: false,
    reuseServer: false,
    build: null,
    json: false,
    outputPath: "",
    objective: DEFAULT_OBJECTIVE,
    strategies: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextValue = () => {
      index += 1;
      return argv[index];
    };

    if (arg === "--source") {
      options.source = String(nextValue() || "").trim();
    } else if (arg === "--port") {
      options.port = Number(nextValue() || DEFAULT_PORT);
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(nextValue() || DEFAULT_TIMEOUT_MS);
    } else if (arg === "--warmup-ms") {
      options.warmupMs = Number(nextValue() || DEFAULT_WARMUP_MS);
    } else if (arg === "--measure-ms") {
      options.measureMs = Number(nextValue() || DEFAULT_MEASURE_MS);
    } else if (arg === "--pause-ms") {
      options.pauseMs = Number(nextValue() || DEFAULT_PAUSE_MS);
    } else if (arg === "--strategy" || arg === "--strategies") {
      const raw = String(nextValue() || "").trim();
      if (raw) {
        options.strategies.push(
          ...raw
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        );
      }
    } else if (arg === "--objective") {
      options.objective = String(nextValue() || DEFAULT_OBJECTIVE)
        .trim()
        .toLowerCase();
    } else if (arg === "--output") {
      options.outputPath = String(nextValue() || "").trim();
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--headed") {
      options.headed = true;
    } else if (arg === "--reuse-server") {
      options.reuseServer = true;
    } else if (arg === "--build") {
      options.build = true;
    } else if (arg === "--no-build") {
      options.build = false;
    } else if (arg === "--help" || arg === "-h") {
      printHelpAndExit(0);
    } else {
      throw new Error(`Unknown argument '${arg}'.`);
    }
  }

  if (!Number.isFinite(options.port) || options.port <= 0) {
    throw new Error("Port must be a positive number.");
  }
  if (
    !["balanced", "latency", "efficiency"].includes(options.objective)
  ) {
    throw new Error(
      "Objective must be one of: balanced, latency, efficiency.",
    );
  }

  return options;
}

function printHelpAndExit(code = 0) {
  const lines = [
    "Usage: bun run bench:playback -- [options]",
    "",
    "Options:",
    "  --source <path>         Repo-local asset path or URL to benchmark",
    "  --strategy <list>       Comma list: direct,hls,remux:auto,remux:copy,remux:normalize",
    "  --port <port>           Port for a temporary Rust server (default: 5181)",
    "  --reuse-server          Reuse an already-running server on --port",
    "  --build                 Force bun run build before benchmarking",
    "  --no-build              Skip build even if dist/ is missing",
    "  --warmup-ms <ms>        Playback warmup before steady-state measure",
    "  --measure-ms <ms>       Steady-state playback window",
    "  --pause-ms <ms>         Time to keep the player paused during pause/resume",
    "  --timeout-ms <ms>       Timeout for startup, pause/resume, and seek steps",
    "  --objective <mode>      balanced | latency | efficiency",
    "  --headed                Run Chromium headed instead of headless",
    "  --json                  Print the full report JSON to stdout",
    "  --output <path>         Write the full report JSON to disk",
  ];
  console.log(lines.join("\n"));
  process.exit(code);
}

function resolveDefaultSource() {
  for (const candidate of DEFAULT_SOURCE_CANDIDATES) {
    if (existsSync(resolve(ROOT_DIR, candidate))) {
      return candidate;
    }
  }
  throw new Error(
    "No default benchmark source was found. Pass --source assets/videos/<file>.",
  );
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
    const relativePath = relative(ROOT_DIR, absoluteValue);
    return toPosixPath(relativePath);
  }

  return toPosixPath(value);
}

function inferStrategyTokens(sourceInput) {
  const lower = String(sourceInput || "").toLowerCase();
  if (
    lower.endsWith(".mkv") ||
    lower.endsWith(".webm") ||
    lower.endsWith(".avi") ||
    lower.endsWith(".wmv") ||
    lower.endsWith(".ts")
  ) {
    return ["remux:auto", "hls"];
  }
  return ["direct", "remux:auto", "hls"];
}

function normalizeStrategy(rawToken) {
  const token = String(rawToken || "")
    .trim()
    .toLowerCase();
  if (!token) {
    throw new Error("Empty strategy token.");
  }

  if (token === "direct") {
    return {
      token,
      label: "direct",
      transport: "direct",
      remuxVideoMode: "",
    };
  }
  if (token === "hls") {
    return {
      token,
      label: "hls",
      transport: "hls",
      remuxVideoMode: "",
    };
  }
  if (token === "remux" || token.startsWith("remux:")) {
    const remuxVideoMode = token.includes(":")
      ? token.split(":")[1] || "auto"
      : "auto";
    if (!["auto", "copy", "normalize"].includes(remuxVideoMode)) {
      throw new Error(
        `Unsupported remux strategy '${token}'. Use remux:auto, remux:copy, or remux:normalize.`,
      );
    }
    return {
      token,
      label: `remux:${remuxVideoMode}`,
      transport: "remux",
      remuxVideoMode,
    };
  }

  throw new Error(
    `Unsupported strategy '${rawToken}'. Use direct, hls, remux:auto, remux:copy, or remux:normalize.`,
  );
}

function ensureBuildIfNeeded(shouldBuild) {
  const distIndex = resolve(ROOT_DIR, "dist/index.html");
  if (shouldBuild === false) {
    return Promise.resolve();
  }
  if (shouldBuild === true || !existsSync(distIndex)) {
    return runCommand("bun", ["run", "build"], {
      cwd: ROOT_DIR,
      description: "build frontend",
    });
  }
  return Promise.resolve();
}

function runCommand(command, args, { cwd, env = {}, description = command } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      rejectPromise(
        new Error(`Failed to ${description}: ${error.message || error}`),
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      rejectPromise(
        new Error(
          `Failed to ${description} (exit ${code}).\n${stderr || stdout || ""}`.trim(),
        ),
      );
    });
  });
}

async function waitForServer(baseUrl, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until timeout.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${baseUrl} to become healthy.`);
}

async function startServer(port, { reuseServer = false } = {}) {
  const baseUrl = `http://127.0.0.1:${port}`;
  if (reuseServer) {
    await waitForServer(baseUrl, 10_000);
    return {
      baseUrl,
      stop: async () => {},
      reused: true,
      startupLogs: [],
    };
  }

  const startupLogs = [];
  const child = spawn("cargo", ["run"], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      RUST_LOG:
        process.env.RUST_LOG ||
        "netflix_rust_backend=warn,tower_http=warn",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const recordLogChunk = (chunk) => {
    const lines = String(chunk)
      .split(/\r?\n/g)
      .map((line) => line.trimEnd())
      .filter(Boolean);
    startupLogs.push(...lines);
    while (startupLogs.length > 160) {
      startupLogs.shift();
    }
  };

  child.stdout.on("data", recordLogChunk);
  child.stderr.on("data", recordLogChunk);

  let exitedEarly = false;
  let exitCode = null;
  child.on("close", (code) => {
    exitedEarly = true;
    exitCode = code;
  });

  try {
    await waitForServer(baseUrl, 35_000);
  } catch (error) {
    if (exitedEarly) {
      throw new Error(
        [
          `Rust server exited before becoming healthy (exit ${exitCode ?? "unknown"}).`,
          startupLogs.join("\n"),
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    throw new Error(
      [`Timed out waiting for benchmark server.`, startupLogs.join("\n")]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return {
    baseUrl,
    reused: false,
    startupLogs,
    stop: async () => {
      if (child.exitCode !== null) {
        return;
      }
      child.kill("SIGINT");
      await Promise.race([
        new Promise((resolvePromise) => child.once("close", resolvePromise)),
        delay(5_000).then(() => {
          if (child.exitCode === null) {
            child.kill("SIGKILL");
          }
        }),
      ]);
    },
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return response.json();
}

function resolveLocalProbePath(sourceInput) {
  if (/^[a-z]+:\/\//i.test(sourceInput)) {
    return "";
  }

  const normalized = String(sourceInput || "").replace(/^\/+/, "");
  const absolutePath = resolve(ROOT_DIR, normalized);
  return existsSync(absolutePath) ? absolutePath : "";
}

function parseFrameRate(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return 0;
  }

  if (raw.includes("/")) {
    const [numeratorRaw, denominatorRaw] = raw.split("/", 2);
    const numerator = Number(numeratorRaw);
    const denominator = Number(denominatorRaw);
    if (
      Number.isFinite(numerator) &&
      Number.isFinite(denominator) &&
      denominator > 0
    ) {
      return numerator / denominator;
    }
    return 0;
  }

  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : 0;
}

async function probeLocalSource(sourceInput) {
  const localPath = resolveLocalProbePath(sourceInput);
  if (!localPath) {
    return null;
  }

  try {
    const { stdout } = await runCommand(
      "ffprobe",
      [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        localPath,
      ],
      {
        cwd: ROOT_DIR,
        description: "probe local media source",
      },
    );
    const payload = JSON.parse(stdout || "{}");
    const streams = Array.isArray(payload?.streams) ? payload.streams : [];
    const format = payload?.format || {};
    const videoStream =
      streams.find((stream) => stream?.codec_type === "video") || null;

    return {
      sourceInput,
      localPath,
      tracks: {
        audioTracks: [],
        durationSeconds: safeRound(Number(format?.duration || 0), 3) || 0,
        formatLongName: String(format?.format_long_name || ""),
        formatName: String(format?.format_name || ""),
        subtitleTracks: [],
        videoBFrameLeadSeconds: 0,
        videoBFrames: Number(videoStream?.has_b_frames || 0) || 0,
        videoCodec: String(videoStream?.codec_name || ""),
        videoFrameRateFps:
          safeRound(
            parseFrameRate(
              videoStream?.avg_frame_rate || videoStream?.r_frame_rate,
            ),
            3,
          ) || 0,
        videoStartTimeSeconds:
          safeRound(Number(videoStream?.start_time || 0), 3) || 0,
      },
    };
  } catch {
    return null;
  }
}

async function fetchSourceProbe(baseUrl, sourceInput) {
  const localProbe = await probeLocalSource(sourceInput);
  if (localProbe) {
    return localProbe;
  }

  const params = new URLSearchParams({ input: sourceInput });
  try {
    return await fetchJson(`${baseUrl}/api/media/tracks?${params.toString()}`);
  } catch {
    return null;
  }
}

function buildStrategySource(strategy, sourceInput) {
  if (strategy.transport === "direct") {
    if (/^[a-z]+:\/\//i.test(sourceInput)) {
      return sourceInput;
    }
    return sourceInput.startsWith("/") ? sourceInput : `/${sourceInput}`;
  }

  if (strategy.transport === "remux") {
    const params = new URLSearchParams({
      input: sourceInput,
      videoMode: strategy.remuxVideoMode || "auto",
    });
    return `/api/remux?${params.toString()}`;
  }

  const params = new URLSearchParams({ input: sourceInput });
  return `/api/hls/master.m3u8?${params.toString()}`;
}

function inferTitleFromSource(sourceInput) {
  const normalized = String(sourceInput || "")
    .split("?")[0]
    .split("/")
    .filter(Boolean)
    .at(-1);
  return normalized || "Benchmark Source";
}

function buildPlayerUrl(baseUrl, strategy, sourceInput) {
  const params = new URLSearchParams({
    src: buildStrategySource(strategy, sourceInput),
    title: `${inferTitleFromSource(sourceInput)} (${strategy.label})`,
    benchmark: "1",
  });
  return `${baseUrl}/player?${params.toString()}`;
}

function isPlaybackNetworkUrl(rawUrl) {
  try {
    const pathname = new URL(rawUrl).pathname;
    return (
      pathname.startsWith("/assets/videos/") ||
      pathname.startsWith("/media/") ||
      pathname.startsWith("/videos/") ||
      pathname === "/api/remux" ||
      pathname === "/api/hls/master.m3u8" ||
      pathname === "/api/hls/segment.ts"
    );
  } catch {
    return false;
  }
}

function diffNumber(after, before) {
  if (!Number.isFinite(after) || !Number.isFinite(before)) {
    return null;
  }
  return after - before;
}

function safeRound(value, digits = 2) {
  return Number.isFinite(value)
    ? Number(Number(value).toFixed(digits))
    : null;
}

function pickSeekTarget(snapshot, probePayload) {
  const durationSeconds =
    Number(snapshot?.durationSeconds) ||
    Number(probePayload?.tracks?.durationSeconds) ||
    0;
  const currentTime = Number(snapshot?.currentTime) || 0;

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 8) {
    return Math.max(1, currentTime + 1);
  }

  const maxSeek = Math.max(1, durationSeconds - 4);
  const middle = durationSeconds * 0.5;
  const fromCurrent = currentTime + Math.min(30, durationSeconds * 0.25);
  return Math.min(maxSeek, Math.max(1, Math.max(middle, fromCurrent)));
}

function computeScore(strategySummary, { objective = DEFAULT_OBJECTIVE, targetFps = 24 } = {}) {
  if (!strategySummary.success) {
    return Number.NEGATIVE_INFINITY;
  }

  const weights = {
    balanced: {
      startup: 0.12,
      resume: 0.08,
      seek: 0.08,
      processing: 7,
      bandwidth: 6,
      fpsBonus: 140,
    },
    latency: {
      startup: 0.18,
      resume: 0.12,
      seek: 0.14,
      processing: 4,
      bandwidth: 2,
      fpsBonus: 120,
    },
    efficiency: {
      startup: 0.08,
      resume: 0.05,
      seek: 0.05,
      processing: 10,
      bandwidth: 14,
      fpsBonus: 100,
    },
  }[objective];

  const startupMs = Number(strategySummary.startup?.settledMs) || 60_000;
  const resumeMs = Number(strategySummary.pauseResume?.resumeLatencyMs) || 20_000;
  const seekMs = Number(strategySummary.seek?.seekLatencyMs) || 20_000;
  const waitingCount = Number(strategySummary.events?.waitingCount) || 0;
  const stalledCount = Number(strategySummary.events?.stalledCount) || 0;
  const errorCount = Number(strategySummary.events?.errorCount) || 0;
  const droppedRatio = Number(strategySummary.steady?.droppedFrameRatio) || 0;
  const avgProcessingMs =
    Number(strategySummary.steady?.avgProcessingDurationMs) || 0;
  const mbps =
    Number(strategySummary.efficiency?.comparisonMegabitsPerSecond) ||
    Number(strategySummary.steady?.megabitsPerSecond) ||
    0;
  const effectiveFps = Number(strategySummary.steady?.effectiveFps) || 0;
  const fpsRatio = targetFps > 0 ? Math.min(effectiveFps / targetFps, 1.2) : 0;

  const score =
    1000 -
    startupMs * weights.startup -
    resumeMs * weights.resume -
    seekMs * weights.seek -
    waitingCount * 35 -
    stalledCount * 80 -
    errorCount * 180 -
    droppedRatio * 650 -
    avgProcessingMs * weights.processing -
    mbps * weights.bandwidth +
    fpsRatio * weights.fpsBonus;

  return safeRound(score, 2);
}

function summarizeStrategyRun({
  strategy,
  url,
  startupSnapshot,
  startupNetworkSnapshot,
  preSteadySnapshot,
  steadySnapshot,
  pauseResumeResult,
  seekResult,
  finalSnapshot,
  preSteadyNetworkSnapshot,
  steadyNetworkSnapshot,
  finalNetworkSnapshot,
  probePayload,
  consoleErrors,
  pageErrors,
  requestFailures,
}) {
  const steadyPlayedSeconds =
    diffNumber(steadySnapshot?.currentTime, preSteadySnapshot?.currentTime) || 0;
  const framesFromQuality =
    diffNumber(
      steadySnapshot?.quality?.totalVideoFrames,
      preSteadySnapshot?.quality?.totalVideoFrames,
    ) || 0;
  const framesFromCallbacks =
    diffNumber(
      steadySnapshot?.frameStats?.callbackCount,
      preSteadySnapshot?.frameStats?.callbackCount,
    ) || 0;
  const steadyFrames = Math.max(framesFromQuality, framesFromCallbacks, 0);
  const steadyDroppedFrames =
    diffNumber(
      steadySnapshot?.quality?.droppedVideoFrames,
      preSteadySnapshot?.quality?.droppedVideoFrames,
    ) || 0;
  const steadyTransferBytes =
    diffNumber(
      steadyNetworkSnapshot?.receivedBytes,
      preSteadyNetworkSnapshot?.receivedBytes,
    ) ||
    diffNumber(
      steadySnapshot?.resources?.transferSize,
      preSteadySnapshot?.resources?.transferSize,
    ) ||
    0;
  const startupTransferBytes =
    Number(startupNetworkSnapshot?.receivedBytes) ||
    Number(startupSnapshot?.resources?.transferSize) ||
    0;
  const totalTransferBytes =
    Number(finalNetworkSnapshot?.receivedBytes) ||
    Number(finalSnapshot?.resources?.transferSize) ||
    0;
  const startupElapsedSeconds =
    Number(startupSnapshot?.capturedAtMs) > 0
      ? Number(startupSnapshot.capturedAtMs) / 1000
      : null;
  const totalElapsedSeconds =
    Number(finalSnapshot?.capturedAtMs) > 0
      ? Number(finalSnapshot.capturedAtMs) / 1000
      : null;
  const effectiveFps =
    steadyPlayedSeconds > 0 ? steadyFrames / steadyPlayedSeconds : null;
  const droppedFrameRatio =
    steadyFrames > 0 ? steadyDroppedFrames / steadyFrames : 0;
  const steadyMegabitsPerSecond =
    steadyPlayedSeconds > 0
      ? (steadyTransferBytes * 8) / steadyPlayedSeconds / 1_000_000
      : null;
  const startupMegabitsPerSecond =
    startupElapsedSeconds > 0
      ? (startupTransferBytes * 8) / startupElapsedSeconds / 1_000_000
      : null;
  const totalMegabitsPerSecond =
    totalElapsedSeconds > 0
      ? (totalTransferBytes * 8) / totalElapsedSeconds / 1_000_000
      : null;
  const comparisonMegabitsPerSecond =
    totalMegabitsPerSecond ?? steadyMegabitsPerSecond;
  const targetFps =
    Number(probePayload?.tracks?.videoFrameRateFps) > 0
      ? Number(probePayload.tracks.videoFrameRateFps)
      : 24;

  const summary = {
    strategy: strategy.label,
    transport: strategy.transport,
    remuxVideoMode: strategy.remuxVideoMode || null,
    url,
    success: true,
    source: finalSnapshot?.source || startupSnapshot?.source || null,
    startup: {
      metadataMs: startupSnapshot?.timings?.firstLoadedMetadataMs ?? null,
      canPlayMs: startupSnapshot?.timings?.firstCanPlayMs ?? null,
      playingMs: startupSnapshot?.timings?.firstPlayingMs ?? null,
      firstFrameMs: startupSnapshot?.timings?.firstVideoFrameMs ?? null,
      settledMs: startupSnapshot?.capturedAtMs ?? null,
    },
    steady: {
      playedSeconds: safeRound(steadyPlayedSeconds, 3),
      frames: Math.max(0, Math.round(steadyFrames)),
      droppedFrames: Math.max(0, Math.round(steadyDroppedFrames)),
      droppedFrameRatio: safeRound(droppedFrameRatio, 4),
      effectiveFps: safeRound(effectiveFps, 3),
      avgProcessingDurationMs:
        steadySnapshot?.frameStats?.meanProcessingDurationMs ?? null,
      avgFrameIntervalMs: steadySnapshot?.frameStats?.meanFrameIntervalMs ?? null,
      transferBytes: Math.max(0, Math.round(steadyTransferBytes)),
      megabitsPerSecond: safeRound(steadyMegabitsPerSecond, 3),
    },
    efficiency: {
      startupTransferBytes: Math.max(0, Math.round(startupTransferBytes)),
      totalTransferBytes: Math.max(0, Math.round(totalTransferBytes)),
      startupMegabitsPerSecond: safeRound(startupMegabitsPerSecond, 3),
      steadyMegabitsPerSecond: safeRound(steadyMegabitsPerSecond, 3),
      totalMegabitsPerSecond: safeRound(totalMegabitsPerSecond, 3),
      comparisonMegabitsPerSecond: safeRound(comparisonMegabitsPerSecond, 3),
    },
    pauseResume: {
      pauseSettledMs: pauseResumeResult?.pauseSettledMs ?? null,
      resumeLatencyMs: pauseResumeResult?.resumeLatencyMs ?? null,
      baselineCurrentTime: pauseResumeResult?.baselineCurrentTime ?? null,
      endCurrentTime: pauseResumeResult?.endCurrentTime ?? null,
    },
    seek: {
      targetSeconds: seekResult?.targetSeconds ?? null,
      seekLatencyMs: seekResult?.seekLatencyMs ?? null,
      absoluteErrorSeconds: seekResult?.absoluteErrorSeconds ?? null,
      endCurrentTime: seekResult?.endCurrentTime ?? null,
    },
    events: {
      waitingCount: finalSnapshot?.counters?.waiting ?? 0,
      stalledCount: finalSnapshot?.counters?.stalled ?? 0,
      errorCount: finalSnapshot?.counters?.error ?? 0,
    },
    finalSnapshot: {
      currentTime: finalSnapshot?.currentTime ?? null,
      readyState: finalSnapshot?.readyState ?? null,
      quality: finalSnapshot?.quality ?? null,
      resources: finalSnapshot?.resources ?? null,
      networkCapture: finalNetworkSnapshot ?? null,
      frameStats: finalSnapshot?.frameStats ?? null,
      recentEvents: Array.isArray(finalSnapshot?.events)
        ? finalSnapshot.events.slice(-12)
        : [],
      sourceHistory: Array.isArray(finalSnapshot?.sourceHistory)
        ? finalSnapshot.sourceHistory.slice(-12)
        : [],
    },
    browserDiagnostics: {
      consoleErrors,
      pageErrors,
      requestFailures,
    },
  };

  return summary;
}

function formatMilliseconds(value) {
  return Number.isFinite(value) ? `${Math.round(value)}ms` : "n/a";
}

function formatRatio(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "n/a";
}

function formatFps(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)}fps` : "n/a";
}

function formatMbps(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)}Mb/s` : "n/a";
}

function padCell(value, width) {
  const text = String(value ?? "");
  if (text.length >= width) {
    return text.slice(0, width);
  }
  return `${text}${" ".repeat(width - text.length)}`;
}

function printPrettyReport(report) {
  const probe = report.probe?.tracks || {};
  console.log(`Source: ${report.sourceInput}`);
  console.log(`Objective: ${report.objective}`);
  if (probe.formatName || probe.videoCodec) {
    console.log(
      `Probe: format=${probe.formatName || "unknown"} codec=${probe.videoCodec || "unknown"} fps=${safeRound(probe.videoFrameRateFps, 3) ?? "n/a"} duration=${probe.durationSeconds ?? "n/a"}s`,
    );
  }
  console.log("");

  const rows = [
    [
      padCell("Strategy", 16),
      padCell("Startup", 10),
      padCell("Resume", 10),
      padCell("Seek", 10),
      padCell("Dropped", 10),
      padCell("Decode", 12),
      padCell("Bandwidth", 12),
      padCell("Score", 10),
    ].join(" "),
  ];

  report.strategies.forEach((strategy) => {
    if (!strategy.success) {
      rows.push(
        [
          padCell(strategy.strategy, 16),
          padCell("failed", 10),
          padCell("failed", 10),
          padCell("failed", 10),
          padCell("n/a", 10),
          padCell("n/a", 12),
          padCell("n/a", 12),
          padCell("-inf", 10),
        ].join(" "),
      );
      return;
    }

    rows.push(
      [
        padCell(strategy.strategy, 16),
        padCell(formatMilliseconds(strategy.startup.settledMs), 10),
        padCell(formatMilliseconds(strategy.pauseResume.resumeLatencyMs), 10),
        padCell(formatMilliseconds(strategy.seek.seekLatencyMs), 10),
        padCell(formatRatio(strategy.steady.droppedFrameRatio), 10),
        padCell(formatFps(strategy.steady.effectiveFps), 12),
        padCell(
          formatMbps(strategy.efficiency?.comparisonMegabitsPerSecond),
          12,
        ),
        padCell(safeRound(strategy.score, 2) ?? "n/a", 10),
      ].join(" "),
    );
  });

  console.log(rows.join("\n"));
  console.log("");

  if (report.recommendedStrategy) {
    const best = report.strategies.find(
      (strategy) => strategy.strategy === report.recommendedStrategy,
    );
    if (best?.success) {
      const reasons = [];
      const fastestStartup = Math.min(
        ...report.strategies
          .filter((strategy) => strategy.success)
          .map((strategy) => strategy.startup.settledMs || Number.POSITIVE_INFINITY),
      );
      const lowestDroppedRatio = Math.min(
        ...report.strategies
          .filter((strategy) => strategy.success)
          .map((strategy) => strategy.steady.droppedFrameRatio ?? Number.POSITIVE_INFINITY),
      );
      const lowestResume = Math.min(
        ...report.strategies
          .filter((strategy) => strategy.success)
          .map((strategy) => strategy.pauseResume.resumeLatencyMs ?? Number.POSITIVE_INFINITY),
      );
      if (best.startup.settledMs === fastestStartup) {
        reasons.push("fastest startup");
      }
      if (best.steady.droppedFrameRatio === lowestDroppedRatio) {
        reasons.push("lowest dropped-frame ratio");
      }
      if (best.pauseResume.resumeLatencyMs === lowestResume) {
        reasons.push("fastest resume");
      }
      if ((best.events.waitingCount || 0) === 0 && (best.events.stalledCount || 0) === 0) {
        reasons.push("no waits or stalls");
      }

      console.log(
        `Recommended: ${best.strategy}${
          reasons.length ? ` (${reasons.slice(0, 3).join(", ")})` : ""
        }`,
      );
    }
  }
}

async function runStrategy(browser, baseUrl, strategy, sourceInput, options, probePayload) {
  const context = await browser.newContext({
    viewport: DEFAULT_VIEWPORT,
    serviceWorkers: "block",
  });

  await context.addInitScript(({ remuxVideoMode }) => {
    try {
      localStorage.clear();
      localStorage.setItem("netflix-native-playback-mode", "off");
      localStorage.setItem("netflix-remux-video-mode", remuxVideoMode);
      localStorage.setItem("netflix-stream-quality-pref", "1080p");
    } catch {
      // Ignore storage issues in restrictive browser contexts.
    }
  }, { remuxVideoMode: strategy.remuxVideoMode || "auto" });

  const page = await context.newPage();
  const cdpSession = await context.newCDPSession(page);
  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  const trackedRequests = new Map();
  const networkTotals = {
    receivedBytes: 0,
    encodedBytes: 0,
    requestCount: 0,
  };

  const readNetworkSnapshot = () => ({
    receivedBytes: Math.max(0, Math.round(networkTotals.receivedBytes)),
    encodedBytes: Math.max(0, Math.round(networkTotals.encodedBytes)),
    requestCount: networkTotals.requestCount,
  });

  await cdpSession.send("Network.enable");
  cdpSession.on("Network.requestWillBeSent", (event) => {
    trackedRequests.set(event.requestId, {
      url: event.request.url,
      relevant: isPlaybackNetworkUrl(event.request.url),
      countedResponse: false,
    });
  });
  cdpSession.on("Network.responseReceived", (event) => {
    const tracked = trackedRequests.get(event.requestId);
    if (!tracked?.relevant || tracked.countedResponse) {
      return;
    }
    tracked.countedResponse = true;
    networkTotals.requestCount += 1;
  });
  cdpSession.on("Network.dataReceived", (event) => {
    const tracked = trackedRequests.get(event.requestId);
    if (!tracked?.relevant) {
      return;
    }
    networkTotals.receivedBytes += Number(event.dataLength || 0);
    networkTotals.encodedBytes += Number(event.encodedDataLength || 0);
  });

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(String(error?.message || error));
  });
  page.on("requestfailed", (request) => {
    requestFailures.push(
      `${request.method()} ${request.url()} :: ${request.failure()?.errorText || "unknown failure"}`,
    );
  });

  const url = buildPlayerUrl(baseUrl, strategy, sourceInput);

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs,
    });

    await page.waitForFunction(
      () =>
        Boolean(window.__NETFLIX_PLAYBACK_BENCHMARK__?.getSnapshot),
      undefined,
      { timeout: options.timeoutMs },
    );

    const startupSnapshot = await page.evaluate((timeoutMs) => {
      return window.__NETFLIX_PLAYBACK_BENCHMARK__.waitForPlayback({
        timeoutMs,
        minCurrentTime: 1.25,
      });
    }, options.timeoutMs);
    const startupNetworkSnapshot = readNetworkSnapshot();

    if (options.warmupMs > 0) {
      await delay(options.warmupMs);
    }

    const preSteadySnapshot = await page.evaluate(() =>
      window.__NETFLIX_PLAYBACK_BENCHMARK__.getSnapshot(),
    );
    const preSteadyNetworkSnapshot = readNetworkSnapshot();
    await delay(options.measureMs);
    const steadySnapshot = await page.evaluate(() =>
      window.__NETFLIX_PLAYBACK_BENCHMARK__.getSnapshot(),
    );
    const steadyNetworkSnapshot = readNetworkSnapshot();

    const pauseResumeResult = await page.evaluate(
      ({ pauseDurationMs, timeoutMs }) =>
        window.__NETFLIX_PLAYBACK_BENCHMARK__.measurePauseResume({
          pauseDurationMs,
          timeoutMs,
          playbackAdvanceSeconds: 0.35,
        }),
      {
        pauseDurationMs: options.pauseMs,
        timeoutMs: options.timeoutMs,
      },
    );

    const snapshotAfterResume = await page.evaluate(() =>
      window.__NETFLIX_PLAYBACK_BENCHMARK__.getSnapshot(),
    );
    const seekTargetSeconds = pickSeekTarget(snapshotAfterResume, probePayload);
    const seekResult = await page.evaluate(
      ({ targetSeconds, timeoutMs }) =>
        window.__NETFLIX_PLAYBACK_BENCHMARK__.measureSeek({
          targetSeconds,
          timeoutMs,
          playbackAdvanceSeconds: 0.35,
        }),
      {
        targetSeconds: seekTargetSeconds,
        timeoutMs: options.timeoutMs,
      },
    );

    const finalSnapshot = await page.evaluate(() =>
      window.__NETFLIX_PLAYBACK_BENCHMARK__.getSnapshot(),
    );
    const finalNetworkSnapshot = readNetworkSnapshot();

    const summary = summarizeStrategyRun({
      strategy,
      url,
      startupSnapshot,
      startupNetworkSnapshot,
      preSteadySnapshot,
      steadySnapshot,
      pauseResumeResult,
      seekResult,
      finalSnapshot,
      preSteadyNetworkSnapshot,
      steadyNetworkSnapshot,
      finalNetworkSnapshot,
      probePayload,
      consoleErrors,
      pageErrors,
      requestFailures,
    });
    summary.score = computeScore(summary, {
      objective: options.objective,
      targetFps:
        Number(probePayload?.tracks?.videoFrameRateFps) > 0
          ? Number(probePayload.tracks.videoFrameRateFps)
          : 24,
    });
    return summary;
  } catch (error) {
    return {
      strategy: strategy.label,
      transport: strategy.transport,
      remuxVideoMode: strategy.remuxVideoMode || null,
      url,
      success: false,
      error: String(error?.message || error),
      browserDiagnostics: {
        consoleErrors,
        pageErrors,
        requestFailures,
      },
      score: Number.NEGATIVE_INFINITY,
    };
  } finally {
    await context.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourceInput = normalizeSourceInput(options.source);
  const strategies = (options.strategies.length
    ? options.strategies
    : inferStrategyTokens(sourceInput)
  ).map(normalizeStrategy);

  await ensureBuildIfNeeded(options.build);

  const server = await startServer(options.port, {
    reuseServer: options.reuseServer,
  });

  let browser;
  try {
    const probePayload = await fetchSourceProbe(server.baseUrl, sourceInput);
    try {
      browser = await chromium.launch({
        headless: !options.headed,
        args: [
          "--autoplay-policy=no-user-gesture-required",
          "--disable-background-timer-throttling",
          "--disable-renderer-backgrounding",
          "--disable-backgrounding-occluded-windows",
        ],
      });
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes("Executable doesn't exist")) {
        throw new Error(
          `${message}\nRun 'bun run bench:playback:install' once to install Chromium.`,
        );
      }
      throw error;
    }

    const strategiesReport = [];
    for (const strategy of strategies) {
      strategiesReport.push(
        await runStrategy(
          browser,
          server.baseUrl,
          strategy,
          sourceInput,
          options,
          probePayload,
        ),
      );
    }

    const successfulStrategies = strategiesReport
      .filter((strategy) => strategy.success)
      .sort((left, right) => (right.score || 0) - (left.score || 0));
    const recommendedStrategy = successfulStrategies[0]?.strategy || null;

    const report = {
      sourceInput,
      baseUrl: server.baseUrl,
      objective: options.objective,
      options: {
        port: options.port,
        timeoutMs: options.timeoutMs,
        warmupMs: options.warmupMs,
        measureMs: options.measureMs,
        pauseMs: options.pauseMs,
        headed: options.headed,
        reuseServer: options.reuseServer,
        strategies: strategies.map((strategy) => strategy.label),
      },
      probe: probePayload,
      recommendedStrategy,
      strategies: strategiesReport,
      generatedAt: new Date().toISOString(),
    };

    if (options.outputPath) {
      const outputPath = resolve(ROOT_DIR, options.outputPath);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, JSON.stringify(report, null, 2));
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }

    printPrettyReport(report);
    if (options.outputPath) {
      console.log(`Saved JSON report to ${resolve(ROOT_DIR, options.outputPath)}`);
    }
  } finally {
    await browser?.close();
    await server.stop();
  }
}

main().catch((error) => {
  console.error(String(error?.message || error));
  process.exitCode = 1;
});

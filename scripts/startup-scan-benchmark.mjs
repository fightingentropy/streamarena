#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BINARY = resolve(
  ROOT_DIR,
  "target",
  "debug",
  process.platform === "win32" ? "streamarena-backend.exe" : "streamarena-backend",
);

function parseArgs(argv) {
  const options = {
    binary: DEFAULT_BINARY,
    samples: 3,
    timeoutMs: 10_000,
    maxP95Ms: 2_500,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[(index += 1)];
    if (arg === "--binary") options.binary = resolve(ROOT_DIR, String(next() || ""));
    else if (arg === "--samples") options.samples = Number(next() || 0);
    else if (arg === "--timeout-ms") options.timeoutMs = Number(next() || 0);
    else if (arg === "--max-p95-ms") options.maxP95Ms = Number(next() || 0);
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") printHelpAndExit();
    else throw new Error(`Unknown argument '${arg}'.`);
  }
  if (!Number.isInteger(options.samples) || options.samples < 1 || options.samples > 20) {
    throw new Error("--samples must be an integer from 1 to 20.");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 500) {
    throw new Error("--timeout-ms must be at least 500.");
  }
  if (!Number.isFinite(options.maxP95Ms) || options.maxP95Ms < 0) {
    throw new Error("--max-p95-ms must be zero or a positive number.");
  }
  return options;
}

function printHelpAndExit() {
  console.log(
    [
      "Usage: bun run bench:startup -- [options]",
      "",
      "Options:",
      "  --binary <path>       Backend binary (default: target/debug/streamarena-backend)",
      "  --samples <n>         Isolated cold-start samples (default: 3)",
      "  --timeout-ms <ms>     Per-sample readiness deadline (default: 10000)",
      "  --max-p95-ms <ms>     Fail when startup p95 exceeds this budget; 0 disables",
      "  --json                Print the full JSON report",
    ].join("\n"),
  );
  process.exit(0);
}

async function ensureBinary(binary) {
  if (existsSync(binary)) return;
  await new Promise((resolvePromise, reject) => {
    const child = spawn("cargo", ["build", "--bin", "streamarena-backend"], {
      cwd: ROOT_DIR,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`cargo build exited with ${code}`));
    });
  });
  if (!existsSync(binary)) throw new Error(`Backend binary not found at ${binary}`);
}

async function waitForReady(baseUrl, deadline) {
  let lastError = "server did not accept a request";
  while (performance.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/config`, {
        cache: "no-store",
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
      lastError = `readiness returned HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error?.message || error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(lastError);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function runSample(binary, timeoutMs, sample) {
  const sandbox = mkdtempSync(join(tmpdir(), "streamarena-startup-"));
  const logs = [];
  const started = performance.now();
  const child = spawn(binary, [], {
    cwd: sandbox,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      RUST_LOG: "streamarena_backend=info",
      OUTBOUND_HTTP_PROXY: "",
      SPORTS_HTTP_PROXY: "",
      OPEN_SIGNUP_ENABLED: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const deadline = started + timeoutMs;
  let settled = false;
  try {
    const baseUrl = await new Promise((resolvePromise, reject) => {
      const onLine = (line) => {
        logs.push(line);
        if (logs.length > 80) logs.shift();
        const match = line.match(/Rust server running at (http:\/\/\S+)/);
        if (match && !settled) {
          settled = true;
          resolvePromise(match[1]);
        }
      };
      createInterface({ input: child.stdout }).on("line", onLine);
      createInterface({ input: child.stderr }).on("line", onLine);
      child.once("error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      child.once("exit", (code, signal) => {
        if (!settled) {
          settled = true;
          reject(new Error(`backend exited before readiness (${code ?? signal})`));
        }
      });
      setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`startup log timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs).unref();
    });
    await waitForReady(baseUrl, deadline);
    return {
      sample,
      ok: true,
      startupMs: Number((performance.now() - started).toFixed(2)),
    };
  } catch (error) {
    return {
      sample,
      ok: false,
      startupMs: Number((performance.now() - started).toFixed(2)),
      error: String(error?.message || error),
      logs,
    };
  } finally {
    await stopChild(child);
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(sorted.length * fraction) - 1;
  return sorted[Math.max(0, index)];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await ensureBinary(options.binary);
  const samples = [];
  for (let sample = 1; sample <= options.samples; sample += 1) {
    samples.push(await runSample(options.binary, options.timeoutMs, sample));
  }
  const successful = samples.filter((sample) => sample.ok).map((sample) => sample.startupMs);
  const p95Ms = percentile(successful, 0.95);
  const violations = [];
  if (successful.length !== samples.length) violations.push("one or more startup samples failed");
  if (options.maxP95Ms > 0 && (!Number.isFinite(p95Ms) || p95Ms > options.maxP95Ms)) {
    violations.push(`startup p95 ${p95Ms ?? "n/a"}ms exceeded ${options.maxP95Ms}ms`);
  }
  const report = {
    generatedAt: new Date().toISOString(),
    samples,
    summary: {
      successful: successful.length,
      total: samples.length,
      p50Ms: percentile(successful, 0.5),
      p95Ms,
      maxMs: percentile(successful, 1),
    },
    gate: {
      maxP95Ms: options.maxP95Ms || null,
      passed: violations.length === 0,
      violations,
    },
  };
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      `Startup scan: ok=${report.summary.successful}/${report.summary.total} p50=${report.summary.p50Ms ?? "n/a"}ms p95=${report.summary.p95Ms ?? "n/a"}ms max=${report.summary.maxMs ?? "n/a"}ms`,
    );
    for (const violation of violations) console.error(`Benchmark gate: ${violation}`);
  }
  if (!report.gate.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});

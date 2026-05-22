#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const rootDir = resolve(new URL("..", import.meta.url).pathname);
const port = Number(process.env.FRONTEND_SMOKE_PORT || 4174);
const baseUrl = `http://127.0.0.1:${port}`;
const viteBin = resolve(rootDir, "node_modules/.bin/vite");
const smokeVideo = "assets/videos/fantozzi-1975-1080p-h264-aac-4k-restored.mp4";
const hevcSmokeVideo = "assets/videos/project-hail-mary-2026-2160p-hevc.mp4";

if (!existsSync(viteBin)) {
  console.error("Missing Vite binary. Run bun install first.");
  process.exit(1);
}

const server = spawn(
  viteBin,
  ["--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  {
    cwd: rootDir,
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk.toString();
});

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Vite exited early.\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/login.html`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for Vite on ${baseUrl}.\n${serverOutput}`);
}

function jsonResponse(payload, status = 200) {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  };
}

function apiPayload(url, method) {
  const path = url.pathname;
  if (path === "/api/auth/me") {
    return { id: 1, username: "smoke", displayName: "Smoke User" };
  }
  if (path === "/api/auth/login" || path === "/api/auth/signup") {
    return { user: { id: 1, username: "smoke", displayName: "Smoke User" } };
  }
  if (path === "/api/auth/logout") {
    return { ok: true };
  }
  if (path === "/api/config") {
    return {
      playbackSessionsEnabled: false,
      hlsMaxTranscodeJobs: 1,
      remuxMaxConcurrent: 1,
    };
  }
  if (path === "/api/health") {
    return { ok: true };
  }
  if (path === "/api/library") {
    return {
      movies: [
        {
          id: "smoke-movie",
          title: "Smoke Movie",
          year: "1975",
          src: smokeVideo,
          thumb: "assets/images/thumbnail.jpg",
          description: "Smoke-test title",
        },
      ],
      series: [],
    };
  }
  if (path === "/api/user/preferences") return {};
  if (path === "/api/user/watch-progress") return { entries: [] };
  if (path === "/api/user/continue-watching") {
    return {
      entries: [
        {
          sourceIdentity: smokeVideo,
          title: "Smoke Movie",
          src: smokeVideo,
          mediaType: "movie",
          resumeSeconds: 120,
          updatedAt: Date.now(),
        },
      ],
    };
  }
  if (path === "/api/user/my-list") return { entries: [] };
  if (path === "/api/tmdb/popular-movies") return { results: [] };
  if (path === "/api/tmdb/search") return { results: [] };
  if (path === "/api/tmdb/details") return { title: "Smoke Movie", year: "1975" };
  if (path === "/api/tmdb/tv/season") return { episodes: [] };
  if (path === "/api/football/matches") return { matches: [] };
  if (path === "/api/football/stream") return { streams: [] };
  if (path === "/api/live/hls-resource") return { ok: true };
  if (path === "/api/live/hls.m3u8") return "#EXTM3U\n";
  if (path === "/api/hls/master.m3u8") {
    return "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\n/api/hls/segment.ts?index=0\n#EXT-X-ENDLIST\n";
  }
  if (path === "/api/upload/infer" && method !== "GET") return {};
  return {};
}

const pages = [
  { path: "/login.html", selector: ".login-page" },
  { path: "/settings.html", selector: ".settings-content" },
  { path: "/upload.html", selector: ".upload-page" },
  { path: "/live.html", selector: ".live-page" },
  { path: "/football.html", selector: ".football-page" },
  { path: "/index.html", selector: ".home-page" },
  {
    path: `/player.html?src=${encodeURIComponent(smokeVideo)}&title=Smoke%20Movie&year=1975`,
    selector: ".player-shell",
    expectOfflineRecovery: true,
  },
  {
    path: `/player.html?src=${encodeURIComponent(hevcSmokeVideo)}&title=Project%20Hail%20Mary&year=2026`,
    selector: ".player-shell",
    expectHlsMaster: true,
  },
];

async function runSmoke() {
  await waitForServer();

  const browser = await chromium.launch({ headless: true });
  try {
    for (const pageSpec of pages) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const failures = [];
      let sawHlsMasterRequest = false;

      page.on("pageerror", (error) => {
        failures.push(`page error: ${error.message}`);
      });
      page.on("requestfailed", (request) => {
        if (["document", "script", "stylesheet"].includes(request.resourceType())) {
          failures.push(`request failed: ${request.method()} ${request.url()}`);
        }
      });
      page.on("response", (response) => {
        if (
          response.status() >= 400 &&
          ["document", "script", "stylesheet"].includes(response.request().resourceType())
        ) {
          failures.push(`bad response ${response.status()}: ${response.url()}`);
        }
      });

      await page.route("**/api/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === "/api/hls/master.m3u8") {
          sawHlsMasterRequest = true;
        }
        if (pageSpec.path === "/login.html" && url.pathname === "/api/auth/me") {
          await route.fulfill(jsonResponse({ error: "Not authenticated." }, 401));
          return;
        }
        const payload = apiPayload(url, request.method());
        if (url.pathname === "/api/live/hls.m3u8" || url.pathname === "/api/hls/master.m3u8") {
          await route.fulfill({
            status: 200,
            contentType: "application/vnd.apple.mpegurl",
            body: String(payload),
          });
          return;
        }
        if (url.pathname === "/api/hls/segment.ts") {
          await route.fulfill({
            status: 200,
            contentType: "video/mp2t",
            body: "",
          });
          return;
        }
        await route.fulfill(jsonResponse(payload));
      });

      await page.goto(`${baseUrl}${pageSpec.path}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(pageSpec.selector, { timeout: 8_000 });
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});

      if (pageSpec.expectHlsMaster) {
        for (let attempt = 0; attempt < 40 && !sawHlsMasterRequest; attempt += 1) {
          await delay(100);
        }
        if (!sawHlsMasterRequest) {
          throw new Error(`${pageSpec.path}\nHEVC/HDR source did not use HLS fallback.`);
        }
      }

      if (pageSpec.expectOfflineRecovery) {
        await page.context().setOffline(true);
        await page.evaluate(() => {
          window.dispatchEvent(new Event("offline"));
        });
        await page.waitForSelector(".resolver-overlay.is-recovery:not([hidden])", {
          timeout: 4_000,
        });
        const recoveryText = await page.$eval(
          ".resolver-card",
          (node) => node.textContent || "",
        );
        if (!/No connection|offline|Retry now/i.test(recoveryText)) {
          throw new Error(`Player offline recovery overlay missing.\n${recoveryText}`);
        }
        await page.context().setOffline(false);
        await page.evaluate(() => {
          window.dispatchEvent(new Event("online"));
        });
      }

      if (failures.length > 0) {
        throw new Error(`${pageSpec.path}\n${failures.join("\n")}`);
      }

      console.log(`smoke ok: ${pageSpec.path}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

try {
  await runSmoke();
  console.log("Frontend smoke passed.");
} finally {
  server.kill("SIGTERM");
}

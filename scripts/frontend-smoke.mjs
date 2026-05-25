#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, devices } from "playwright";

const rootDir = resolve(new URL("..", import.meta.url).pathname);
const port = Number(process.env.FRONTEND_SMOKE_PORT || 4174);
const baseUrl = `http://127.0.0.1:${port}`;
const viteBin = resolve(rootDir, "node_modules/.bin/vite");
const smokeVideo = "assets/videos/fantozzi-1975-1080p-h264-aac-4k-restored.mp4";
const hevcSmokeVideo = "assets/videos/project-hail-mary-2026-2160p-hevc.mp4";
const sourceSwitchHashA = "a".repeat(40);
const sourceSwitchHashB = "b".repeat(40);
const hlsManagedTmdbId = "273240";
const hlsManagedSourceHash = "3b77214a7852eace6248758affc3ed060579a216";
const hlsManagedSourceInput =
  "https://example.test/Off.Campus.2026.S01E01.720p.HEVC.x265-MeGusta.mkv";

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
  if (path === "/api/home/bootstrap") {
    const sampleMovie = {
      id: 1,
      title: "Smoke Movie",
      release_date: "1975-01-01",
      poster_path: "/poster.jpg",
      backdrop_path: "/backdrop.jpg",
      overview: "Smoke-test title",
      genre_ids: [28],
      vote_average: 8.1,
      adult: false,
    };
    return {
      imageBase: "https://image.tmdb.org/t/p",
      genres: [{ id: 28, name: "Action" }],
      popular: { results: [sampleMovie] },
      trending: { results: [sampleMovie] },
      nowPlaying: { results: [sampleMovie] },
      topRated: { results: [sampleMovie] },
      library: {
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
      },
    };
  }
  if (path === "/api/tmdb/popular-movies") return { results: [] };
  if (path === "/api/tmdb/search") return { results: [] };
  if (path === "/api/tmdb/details") return { title: "Smoke Movie", year: "1975" };
  if (path === "/api/tmdb/tv/season") return { episodes: [] };
  if (path === "/api/resolve/sources") {
    return {
      sources: [
        {
          sourceHash: sourceSwitchHashA,
          infoHash: sourceSwitchHashA,
          primary: "Off.Campus.S01E01.1080p.WEB.h264",
          filename: "Off.Campus.S01E01.1080p.WEB.h264.mkv",
          provider: "Torrentio",
          qualityLabel: "1080p",
          container: "mkv",
          seeders: 490,
          size: "632 MB",
        },
        {
          sourceHash: sourceSwitchHashB,
          infoHash: sourceSwitchHashB,
          primary: "Off.Campus.S01E01.MULTI.2160p.WEB.h265",
          filename: "Off.Campus.S01E01.MULTI.2160p.WEB.h265.mkv",
          provider: "Torrentio",
          qualityLabel: "4K HDR",
          container: "mkv",
          seeders: 377,
          size: "7.35 GB",
        },
      ],
    };
  }
  if (path === "/api/resolve/tv") {
    const tmdbId = url.searchParams.get("tmdbId") || "";
    if (tmdbId === hlsManagedTmdbId) {
      return {
        sourceHash: hlsManagedSourceHash,
        sourceInput: hlsManagedSourceInput,
        playableUrl: `/api/remux?input=${encodeURIComponent(hlsManagedSourceInput)}&audioStream=1`,
        fallbackUrls: [],
        filename: "Off.Campus.2026.S01E01.720p.HEVC.x265-MeGusta.mkv",
        tracks: {
          audioTracks: [
            {
              streamIndex: 1,
              language: "en",
              title: "English",
              codec: "eac3",
              isDefault: true,
            },
          ],
          subtitleTracks: [],
        },
        selectedAudioStreamIndex: 1,
        selectedSubtitleStreamIndex: -1,
        preferences: { audioLang: "en", subtitleLang: "" },
        metadata: {
          displayTitle: "Off Campus",
          displayYear: "2026",
          seasonNumber: 1,
          episodeNumber: 1,
          episodeTitle: "The Deal",
          runtimeSeconds: 3180,
        },
      };
    }
    const sourceHash = url.searchParams.get("sourceHash") || sourceSwitchHashA;
    return {
      sourceHash,
      sourceInput: `mock://${sourceHash}`,
      playableUrl: `${smokeVideo}?source=${sourceHash}`,
      fallbackUrls: [],
      tracks: {
        audioTracks: [
          {
            streamIndex: 0,
            language: "en",
            title: "English",
            codec: "aac",
            isDefault: true,
          },
        ],
        subtitleTracks: [],
      },
      selectedAudioStreamIndex: 0,
      selectedSubtitleStreamIndex: -1,
      preferences: { audioLang: "en", subtitleLang: "" },
      metadata: {
        displayTitle: "Off Campus",
        seasonNumber: 1,
        episodeNumber: 1,
        episodeTitle: "The Deal",
        runtimeSeconds: 3600,
      },
    };
  }
  if (path === "/api/football/matches") return { matches: [] };
  if (path === "/api/football/stream") return { streams: [] };
  if (path === "/api/basketball/matches") return { matches: [] };
  if (path === "/api/basketball/stream") return { streams: [] };
  if (path === "/api/sports/stream") return { streams: [] };
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
  { path: "/sports", selector: ".sports-page", expectSportsTabs: true },
  { path: "/index.html", selector: ".home-page" },
  {
    path: "/index.html",
    selector: ".home-page",
    expectServerContinueWatchingTruth: true,
  },
  {
    path: `/player.html?src=${encodeURIComponent(smokeVideo)}&title=Smoke%20Movie&year=1975`,
    selector: ".player-shell",
    expectOfflineRecovery: true,
  },
  {
    path: `/player.html?src=${encodeURIComponent(hevcSmokeVideo)}&title=Project%20Hail%20Mary&year=2026`,
    selector: ".player-shell",
    expectDirectVideo: true,
  },
  {
    path: `/player.html?src=${encodeURIComponent(hevcSmokeVideo)}&title=Project%20Hail%20Mary&year=2026`,
    selector: ".player-shell",
    contextOptions: devices["iPhone 13"],
    expectHlsMaster: true,
    expectMobileFullscreenToggle: true,
  },
  {
    path: `/player.html?tmdbId=${hlsManagedTmdbId}&mediaType=tv&title=Off%20Campus&seasonNumber=1&episodeNumber=1`,
    selector: ".player-shell",
    delayHlsImport: true,
    expectHlsManagedDuringImport: true,
    expectHlsMaster: true,
  },
  {
    path: "/player.html?tmdbId=auto-fallback-tv&mediaType=tv&title=Off%20Campus&seasonNumber=1&episodeNumber=1",
    selector: ".player-shell",
    expectAutomaticSourceFallback: true,
  },
  {
    path: "/player.html?tmdbId=source-switch-tv&mediaType=tv&title=Off%20Campus&seasonNumber=1&episodeNumber=1",
    selector: ".player-shell",
    expectSourceSwitch: true,
  },
];

async function runSmoke() {
  await waitForServer();

  const browser = await chromium.launch({ headless: true });
  try {
    for (const pageSpec of pages) {
      const context = await browser.newContext(
        pageSpec.contextOptions || { viewport: { width: 1280, height: 900 } },
      );
      const page = await context.newPage();
      const failures = [];
      let sawHlsMasterRequest = false;
      let sawRemuxRequest = false;
      let sawSourceSwitchResolveHash = "";
      let sawHlsManagedResolve = false;
      let sawSportsBasketballMatches = false;
      let sawHlsManagedImportHold = false;
      let automaticFallbackResolveCount = 0;
      let sawAutomaticFallbackResolveHash = "";
      let hlsBundleRequested = false;
      let hlsBundleReleased = false;

      let hlsBundleHoldActive = false;
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

      if (pageSpec.delayHlsImport) {
        await page.route(/.*(?:hls|hls__js).*\.js(?:\?.*)?$/, async (route) => {
          hlsBundleRequested = true;
          hlsBundleHoldActive = true;
          const response = await route.fetch();
          const body = await response.body();
          await delay(2000);
          hlsBundleHoldActive = false;
          hlsBundleReleased = true;
          await route.fulfill({
            status: response.status(),
            headers: response.headers(),
            body,
          });
        });
      }

      await page.route("**/api/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === "/api/hls/master.m3u8") {
          sawHlsMasterRequest = true;
        }
        if (url.pathname === "/api/remux") {
          sawRemuxRequest = true;
        }
        if (pageSpec.expectSourceSwitch && url.pathname === "/api/resolve/tv") {
          const sourceHash = url.searchParams.get("sourceHash") || "";
          if (sourceHash) {
            sawSourceSwitchResolveHash = sourceHash;
          }
        }
        if (
          pageSpec.expectAutomaticSourceFallback &&
          url.pathname === "/api/resolve/tv"
        ) {
          automaticFallbackResolveCount += 1;
          const sourceHash = url.searchParams.get("sourceHash") || "";
          if (sourceHash) {
            sawAutomaticFallbackResolveHash = sourceHash;
          }
        }
        if (
          pageSpec.expectHlsManagedDuringImport &&
          url.pathname === "/api/resolve/tv"
        ) {
          sawHlsManagedResolve = true;
        }
        if (pageSpec.expectSportsTabs && url.pathname === "/api/basketball/matches") {
          sawSportsBasketballMatches = true;
        }
        if (pageSpec.path === "/login.html" && url.pathname === "/api/auth/me") {
          await route.fulfill(jsonResponse({ error: "Not authenticated." }, 401));
          return;
        }
        if (
          pageSpec.expectServerContinueWatchingTruth &&
          url.pathname === "/api/user/continue-watching"
        ) {
          await route.fulfill(jsonResponse({ entries: [] }));
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

      if (pageSpec.expectServerContinueWatchingTruth) {
        await context.addInitScript(() => {
          const staleSource = "tmdb:movie:999999";
          localStorage.setItem(`netflix-resume:${staleSource}`, "120");
          localStorage.setItem(
            "netflix-continue-watching-meta",
            JSON.stringify({
              [staleSource]: {
                sourceIdentity: staleSource,
                title: "Ghost Movie",
                mediaType: "movie",
                tmdbId: "999999",
                resumeSeconds: 120,
                updatedAt: Date.now(),
              },
            }),
          );
        });
      }

      await page.goto(`${baseUrl}${pageSpec.path}`, { waitUntil: "domcontentloaded" });
      if (pageSpec.expectHlsManagedDuringImport) {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if (sawHlsManagedResolve && hlsBundleHoldActive) {
            sawHlsManagedImportHold = true;
            break;
          }
          await delay(25);
        }
      }
      await page.waitForSelector(pageSpec.selector, { timeout: 8_000 });

      if (pageSpec.expectHlsManagedDuringImport) {
        const earlyVideoSource = await page.evaluate(
          () => document.querySelector("video")?.getAttribute("src") || "",
        );
        if (!hlsBundleRequested) {
          throw new Error(
            `${pageSpec.path}\nHLS-managed source setup did not request hls.js.\n${JSON.stringify({
              sawHlsManagedResolve,
              sawHlsManagedImportHold,
              hlsBundleRequested,
              hlsBundleHoldActive,
              hlsBundleReleased,
              earlyVideoSource,
              failures,
            })}`,
          );
        }
        if (earlyVideoSource.includes("/api/hls/master.m3u8")) {
          throw new Error(
            `${pageSpec.path}\nHLS.js-managed source was assigned directly to video.src before hls.js attached.`,
          );
        }
      }

      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});

      if (pageSpec.expectServerContinueWatchingTruth) {
        await page.waitForFunction(
          () =>
            !localStorage.getItem("netflix-resume:tmdb:movie:999999") &&
            !(localStorage.getItem("netflix-continue-watching-meta") || "").includes("Ghost Movie"),
          null,
          { timeout: 8_000 },
        );
        const staleState = await page.evaluate(() => ({
          rowText: document.querySelector("#continueCards")?.textContent || "",
          resume: localStorage.getItem("netflix-resume:tmdb:movie:999999"),
          meta: localStorage.getItem("netflix-continue-watching-meta") || "",
        }));
        if (
          /Ghost Movie/.test(staleState.rowText) ||
          staleState.resume ||
          /Ghost Movie/.test(staleState.meta)
        ) {
          throw new Error(
            `${pageSpec.path}\nServer Continue Watching should remove stale local entries.\n${JSON.stringify(staleState)}`,
          );
        }
      }

      if (pageSpec.expectSportsTabs) {
        await page.getByRole("button", { name: "Basketball" }).click();
        await page.waitForFunction(() => new URL(window.location.href).searchParams.get("sport") === "basketball");
        await page.waitForFunction(() => {
          const buttons = [...document.querySelectorAll(".sports-switcher button")];
          const buttonFor = (label) =>
            buttons.find((button) => button.textContent?.trim() === label);
          const football = buttonFor("Football");
          const basketball = buttonFor("Basketball");
          return (
            football?.getAttribute("aria-pressed") === "false" &&
            basketball?.getAttribute("aria-pressed") === "true"
          );
        });
        for (let attempt = 0; attempt < 20 && !sawSportsBasketballMatches; attempt += 1) {
          await delay(100);
        }
        const sportsUrl = new URL(page.url());
        if (
          sportsUrl.pathname !== "/sports" ||
          sportsUrl.searchParams.get("sport") !== "basketball" ||
          !sawSportsBasketballMatches
        ) {
          throw new Error(
            `${pageSpec.path}\nSports tabs should stay on /sports and load basketball data.\n${JSON.stringify({
              url: page.url(),
              sawSportsBasketballMatches,
            })}`,
          );
        }
      }

      if (pageSpec.expectDirectVideo) {
        for (
          let attempt = 0;
          attempt < 10 && !sawHlsMasterRequest && !sawRemuxRequest;
          attempt += 1
        ) {
          await delay(100);
        }
        if (sawHlsMasterRequest || sawRemuxRequest) {
          throw new Error(`${pageSpec.path}\nDesktop HEVC source should stay direct.`);
        }
      }

      if (pageSpec.expectHlsMaster) {
        for (let attempt = 0; attempt < 40 && !sawHlsMasterRequest; attempt += 1) {
          await delay(100);
        }
        if (!sawHlsMasterRequest) {
          throw new Error(`${pageSpec.path}\nHEVC/HDR source did not use HLS fallback.`);
        }
      }

      if (pageSpec.expectAutomaticSourceFallback) {
        await page.waitForFunction(
          (hash) =>
            Boolean(
              document.querySelector(`.source-option[data-source-hash="${hash}"]`),
            ) &&
            (document.querySelector("video")?.getAttribute("src") || "").includes(hash),
          sourceSwitchHashA,
          { timeout: 8_000 },
        );

        for (let errorIndex = 0; errorIndex < 3; errorIndex += 1) {
          const expectedResolveCount = automaticFallbackResolveCount + 1;
          await page.evaluate(() => {
            document.querySelector("video")?.dispatchEvent(new Event("error"));
          });
          for (let attempt = 0; attempt < 80; attempt += 1) {
            if (automaticFallbackResolveCount >= expectedResolveCount) {
              break;
            }
            await delay(100);
          }
        }

        for (
          let attempt = 0;
          attempt < 80 && sawAutomaticFallbackResolveHash !== sourceSwitchHashB;
          attempt += 1
        ) {
          await delay(100);
        }
        const fallbackState = await page.evaluate(() => ({
          selectedHash:
            document.querySelector(".source-option[aria-selected='true']")
              ?.dataset.sourceHash || "",
          videoSource: document.querySelector("video")?.getAttribute("src") || "",
          resolverText:
            document.querySelector(".resolver-overlay:not([hidden]) .resolver-card")
              ?.textContent || "",
        }));
        if (
          sawAutomaticFallbackResolveHash !== sourceSwitchHashB ||
          fallbackState.selectedHash !== sourceSwitchHashB ||
          !fallbackState.videoSource.includes(sourceSwitchHashB)
        ) {
          throw new Error(
            `${pageSpec.path}\nAutomatic source fallback failed.\n${JSON.stringify({
              sawAutomaticFallbackResolveHash,
              automaticFallbackResolveCount,
              fallbackState,
            })}`,
          );
        }
      }

      if (pageSpec.expectSourceSwitch) {
        await page.waitForSelector("#toggleSource", { state: "visible", timeout: 8_000 });
        await page.click("#toggleSource");
        await page.waitForFunction(
          (hash) =>
            Boolean(
              document.querySelector(`.source-option[data-source-hash="${hash}"]`),
            ),
          sourceSwitchHashB,
          { timeout: 8_000 },
        );
        await page.evaluate((hash) => {
          document
            .querySelector(`.source-option[data-source-hash="${hash}"]`)
            ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        }, sourceSwitchHashB);
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const switched = await page.evaluate((expectedHash) => {
            const selectedHash =
              document.querySelector(".source-option[aria-selected='true']")
                ?.dataset.sourceHash || "";
            const videoSource = document.querySelector("video")?.getAttribute("src") || "";
            const sourcePopoverOpen =
              document.querySelector("#sourceControl")?.classList.contains("is-open") ||
              false;
            return (
              selectedHash === expectedHash &&
              videoSource.includes(expectedHash)
            );
          }, sourceSwitchHashB);
          if (switched) {
            break;
          }
          await delay(100);
        }
        const switchState = await page.evaluate(() => ({
          selectedHash:
            document.querySelector(".source-option[aria-selected='true']")
              ?.dataset.sourceHash || "",
          videoSource: document.querySelector("video")?.getAttribute("src") || "",
          sourcePopoverOpen:
            document.querySelector("#sourceControl")?.classList.contains("is-open") || false,
        }));
        if (
          sawSourceSwitchResolveHash !== sourceSwitchHashB ||
          switchState.selectedHash !== sourceSwitchHashB ||
          !switchState.videoSource.includes(sourceSwitchHashB)
        ) {
          throw new Error(
            `${pageSpec.path}\nSource switch failed.\n${JSON.stringify({
              sawSourceSwitchResolveHash,
              switchState,
            })}`,
          );
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

      if (pageSpec.expectMobileFullscreenToggle) {
        const fullscreenButton = page.locator("#toggleFullscreen");
        await fullscreenButton.waitFor({ state: "visible", timeout: 4_000 });
        const readFullscreenLabel = () => fullscreenButton.getAttribute("aria-label");
        const clickFullscreenToggle = () =>
          page.evaluate(() => {
            document.querySelector("#toggleFullscreen")?.click();
          });

        const enterLabel = await readFullscreenLabel();
        if (enterLabel !== "Fullscreen") {
          throw new Error(
            `${pageSpec.path}\nMobile fullscreen button should start in enter mode.\n${enterLabel}`,
          );
        }
        await clickFullscreenToggle();
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const exitLabel = await readFullscreenLabel();
          if (exitLabel === "Exit fullscreen") {
            break;
          }
          await delay(100);
        }
        const activeLabel = await readFullscreenLabel();
        if (activeLabel !== "Exit fullscreen") {
          throw new Error(
            `${pageSpec.path}\nMobile fullscreen toggle did not enter fullscreen.\n${activeLabel}`,
          );
        }
        await clickFullscreenToggle();
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const resetLabel = await readFullscreenLabel();
          if (resetLabel === "Fullscreen") {
            break;
          }
          await delay(100);
        }
        const finalLabel = await readFullscreenLabel();
        if (finalLabel !== "Fullscreen") {
          throw new Error(
            `${pageSpec.path}\nMobile fullscreen toggle did not exit fullscreen.\n${finalLabel}`,
          );
        }
      }

      if (failures.length > 0) {
        throw new Error(`${pageSpec.path}\n${failures.join("\n")}`);
      }

      console.log(`smoke ok: ${pageSpec.path}`);
      await context.close();
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

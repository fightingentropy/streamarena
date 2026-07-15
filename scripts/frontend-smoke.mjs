#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, devices } from "playwright";

const rootDir = resolve(new URL("..", import.meta.url).pathname);
const port = Number(process.env.FRONTEND_SMOKE_PORT || 4174);
const baseUrl = `http://127.0.0.1:${port}`;
const liveIframeEmbedUrl = `${baseUrl}/offline.html`;
const liveIframeAltUrl = `${baseUrl}/privacy.html`;
const viteBin = resolve(rootDir, "node_modules/.bin/vite");
const smokeVideo = "assets/videos/fantozzi-1975-1080p-h264-aac-4k-restored.mp4";
const hevcSmokeVideo = "assets/videos/project-hail-mary-2026-2160p-hevc.mp4";
const sourceSwitchHashA = "a".repeat(40);
const sourceSwitchHashB = "b".repeat(40);
const hlsManagedTmdbId = "273240";
const emptyTracksTmdbId = "empty-tracks-tv";
const translatedSubtitleTmdbId = "translated-subtitle-tv";
const staleEnglishSubtitleStreamIndex = 3_000_000_101;
const translatedEnglishSubtitleStreamIndex = 3_000_000_102;
const hlsManagedSourceHash = "3b77214a7852eace6248758affc3ed060579a216";
const hlsManagedSourceInput =
  "https://example.test/Off.Campus.2026.S01E01.720p.HEVC.x265-MeGusta.mkv";
const liveStreamSwitchStreams = [
  {
    id: "sports-main",
    label: "Streamed main",
    source: "https://sports.example.test/main",
    provider: "streamed",
    playbackType: "hls",
    quality: "720p",
  },
  {
    id: "sports-alt",
    label: "MatchStream backup",
    source: "https://sports.example.test/backup",
    provider: "matchstream",
    playbackType: "hls",
    quality: "1080p",
  },
];
const liveStreamSwitchParams = new URLSearchParams({
  src: liveStreamSwitchStreams[0].source,
  title: "Smoke Sports",
  live: "1",
  liveEmbed: "1",
  liveResolver: "sports",
  liveStreamId: liveStreamSwitchStreams[0].id,
  liveStreams: JSON.stringify(liveStreamSwitchStreams),
});
const liveStreamSwitchPath = `/player.html?${liveStreamSwitchParams.toString()}`;
const liveIframeSwitchStreams = [
  {
    id: "iframe-main",
    label: "Kobra main",
    source: `live-iframe:${encodeURIComponent("/offline.html")}`,
    provider: "ntvs",
    playbackType: "iframe",
    quality: "HD",
  },
  {
    id: "iframe-alt",
    label: "Kobra backup",
    source: `live-iframe:${encodeURIComponent("/privacy.html")}`,
    provider: "ntvs",
    playbackType: "iframe",
    quality: "HD",
  },
];
const liveIframeSwitchParams = new URLSearchParams({
  src: liveIframeSwitchStreams[0].source,
  title: "Live Iframe",
  live: "1",
  liveEmbed: "1",
  liveResolver: "sports",
  liveStreamId: liveIframeSwitchStreams[0].id,
  liveStreams: JSON.stringify(liveIframeSwitchStreams),
});
const liveIframeSwitchPath = `/player.html?${liveIframeSwitchParams.toString()}`;

function sportsEarlyPlaybackMatches() {
  const now = Date.now();
  const buildMatch = ({ id, title, startsInMinutes }) => ({
    id,
    title,
    league: "Smoke League",
    sport: "Football",
    startTimestamp: now + startsInMinutes * 60_000,
    endsAtTimestamp: now + (startsInMinutes + 120) * 60_000,
    linkCount: 1,
    channelCount: 1,
    streams: [
      {
        id: `${id}-stream`,
        label: `${title} stream`,
        source: `https://sports.example.test/${id}`,
        provider: "streamed",
        playbackType: "hls",
        quality: "HD",
      },
    ],
    provider: "streamed",
  });
  return [
    buildMatch({ id: "early-window", title: "Early Window Match", startsInMinutes: 5 }),
    buildMatch({ id: "outside-window", title: "Outside Window Match", startsInMinutes: 11 }),
  ];
}

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
    return { id: 1, email: "smoke@example.com", displayName: "Smoke User" };
  }
  if (path === "/api/auth/login" || path === "/api/auth/signup") {
    return { user: { id: 1, email: "smoke@example.com", displayName: "Smoke User" } };
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
  if (path === "/api/tmdb/details") {
    return {
      title: "Smoke Movie",
      release_date: "1975-01-01",
      runtime: 95,
      certification: "PG",
      genres: [{ id: 28, name: "Action" }],
      credits: { cast: [{ name: "Smoke Actor" }] },
    };
  }
  if (path === "/api/tmdb/tv/season") return { episodes: [] };
  if (path === "/api/resolve/sources") {
    // The player auto-selects sourceSwitchHashB (4K HDR) as the default playback
    // source once the list loads — it prefers the highest-quality release. The
    // source tests below therefore treat hashB as the initial/default source and
    // sourceSwitchHashA (1080p) as the alternate they switch to / fall back to.
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
    if (tmdbId === translatedSubtitleTmdbId) {
      return {
        sourceHash: "d".repeat(40),
        sourceInput: smokeVideo,
        playableUrl: smokeVideo,
        fallbackUrls: [],
        tracks: {
          audioTracks: [],
          subtitleTracks: [
            {
              streamIndex: staleEnglishSubtitleStreamIndex,
              language: "en",
              isTextBased: true,
              isExternal: true,
              label: "English (OpenSubtitles)",
              vttUrl: "/api/subtitles.external.vtt?track=stale",
            },
            {
              streamIndex: translatedEnglishSubtitleStreamIndex,
              language: "en",
              isTextBased: true,
              isExternal: true,
              label: "English Translated (OpenSubtitles)",
              vttUrl: "/api/subtitles.external.vtt?track=translated",
            },
          ],
        },
        selectedAudioStreamIndex: -1,
        selectedSubtitleStreamIndex: translatedEnglishSubtitleStreamIndex,
        preferences: { audioLang: "en", subtitleLang: "en" },
        metadata: {
          displayTitle: "Translated Subtitle",
          seasonNumber: 1,
          episodeNumber: 2,
          episodeTitle: "Regression",
          runtimeSeconds: 3600,
        },
      };
    }
    if (tmdbId === emptyTracksTmdbId) {
      return {
        sourceHash: "e".repeat(40),
        sourceInput: smokeVideo,
        playableUrl: smokeVideo,
        fallbackUrls: [],
        resolverProvider: "external-embed",
        tracks: {
          audioTracks: [],
          subtitleTracks: [],
        },
        selectedAudioStreamIndex: -1,
        selectedSubtitleStreamIndex: -1,
        preferences: { audioLang: "en", subtitleLang: "" },
        metadata: {
          displayTitle: "Empty Tracks",
          seasonNumber: 1,
          episodeNumber: 1,
          episodeTitle: "Pilot",
          runtimeSeconds: 3600,
          resolverProvider: "external-embed",
        },
      };
    }
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
  if (path === "/api/football/matches") {
    return { matches: sportsEarlyPlaybackMatches(), sourceProvider: "streamed" };
  }
  if (path === "/api/football/stream") return { streams: [] };
  if (path === "/api/basketball/matches") return { matches: [] };
  if (path === "/api/basketball/stream") return { streams: [] };
  if (path === "/api/sports/stream") return { streams: [] };
  if (path === "/api/live/hls-resource") return "";
  if (path === "/api/live/hls.m3u8") {
    return "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\n/api/live/hls-resource?index=0\n#EXT-X-ENDLIST\n";
  }
  if (path === "/api/hls/master.m3u8") {
    return "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\n/api/hls/segment.ts?index=0\n#EXT-X-ENDLIST\n";
  }
  return {};
}

const pages = [
  { path: "/login.html", selector: ".login-page" },
  { path: "/settings.html", selector: ".settings-content" },
  {
    path: "/settings.html",
    selector: ".settings-content",
    expectRealDebridLoadFailureNoOverwrite: true,
    expectHydratedPreferencesBeforeMount: true,
  },
  { path: "/live.html", selector: ".live-page" },
  { path: "/sports", selector: ".sports-page", expectSportsEarlyPlayback: true },
  { path: "/sports", selector: ".sports-page", expectSportsTabs: true },
  {
    path: "/index.html",
    selector: ".home-page",
    expectHomeAccessibility: true,
    expectHoverResolvePrewarm: true,
  },
  {
    path: "/index.html",
    selector: ".home-page",
    contextOptions: {
      viewport: { width: 320, height: 700 },
      deviceScaleFactor: 1,
      hasTouch: true,
      isMobile: true,
    },
    expectTouchCardActions: true,
    expectNarrowNavigation: true,
  },
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
    expectSeekProgress: true,
  },
  {
    path: `/player.html?src=${encodeURIComponent(hevcSmokeVideo)}&title=Project%20Hail%20Mary&year=2026`,
    selector: ".player-shell",
    contextOptions: devices["iPhone 13"],
    expectHlsMaster: true,
    expectMobileFullscreenToggle: true,
  },
  {
    path: liveIframeSwitchPath,
    selector: ".player-shell",
    expectLiveIframeUnsandboxed: true,
    expectLiveIframeSourceSwitch: true,
  },
  {
    path: liveIframeSwitchPath,
    selector: ".player-shell",
    contextOptions: devices["iPhone 13"],
    expectLiveIframeUnsandboxed: true,
    expectLiveIframeSourceSwitch: true,
  },
  {
    path: liveStreamSwitchPath,
    selector: ".player-shell",
    expectLiveStreamSwitch: true,
    stubHlsPlayback: true,
  },
  {
    path: `/player.html?tmdbId=${hlsManagedTmdbId}&mediaType=tv&title=Off%20Campus&seasonNumber=1&episodeNumber=1`,
    selector: ".player-shell",
    delayHlsImport: true,
    expectHlsManagedDuringImport: true,
    expectHlsMaster: true,
  },
  {
    path: `/player.html?tmdbId=${emptyTracksTmdbId}&mediaType=tv&title=Empty%20Tracks&seasonNumber=1&episodeNumber=1&audioLang=en`,
    selector: ".player-shell",
    expectUnknownAudioFallback: true,
  },
  {
    path: `/player.html?tmdbId=${translatedSubtitleTmdbId}&mediaType=tv&title=Translated%20Subtitle&seasonNumber=1&episodeNumber=2`,
    selector: ".player-shell",
    expectTranslatedSubtitleMigration: true,
  },
  {
    path: `/watch?tmdbId=${hlsManagedTmdbId}&mediaType=tv&title=Off%20Campus&seasonNumber=1&episodeNumber=1`,
    selector: ".player-shell",
    expectHlsMaster: true,
    // A legacy long URL must canonicalize to the short, self-contained path that
    // carries the full identity (tmdbId + media type + season/episode).
    expectCanonicalWatchPath: `/watch/tv/${hlsManagedTmdbId}/off-campus/s1e1`,
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
  {
    path: "/player.html?tmdbId=source-switch-failure-tv&mediaType=tv&title=Off%20Campus&seasonNumber=1&episodeNumber=1",
    selector: ".player-shell",
    expectSourceSwitchFailureRestore: true,
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
      let sourceSwitchResolveHashes = [];
      let sawHlsManagedResolve = false;
      let sawSportsBasketballMatches = false;
      let sawHlsManagedImportHold = false;
      let automaticFallbackResolveCount = 0;
      let sawAutomaticFallbackResolveHash = "";
      let liveStreamResolveSources = [];
      let liveStreamHlsInputs = [];
      let hlsBundleRequested = false;
      let hlsBundleReleased = false;
      const hoverResolvePrewarmRequests = [];
      const realDebridUpdateBodies = [];

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

      if (pageSpec.stubHlsPlayback) {
        await page.route(
          /.*\/node_modules\/\.vite\/deps\/hls__js\.js(?:\?.*)?$/,
          async (route) => {
            await route.fulfill({
              status: 200,
              contentType: "text/javascript",
              body: `
                export default class Hls {
                  static Events = {
                    ERROR: "hlsError",
                    MEDIA_ATTACHED: "hlsMediaAttached",
                    MANIFEST_PARSED: "hlsManifestParsed",
                    LEVEL_SWITCHED: "hlsLevelSwitched"
                  };
                  static ErrorTypes = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError" };
                  static isSupported() { return true; }
                  constructor() {
                    this.handlers = new Map();
                    this.levels = [{ height: 1080, bitrate: 5000000, name: "1080p" }];
                    this.currentLevel = -1;
                  }
                  on(event, handler) {
                    const handlers = this.handlers.get(event) || [];
                    handlers.push(handler);
                    this.handlers.set(event, handlers);
                  }
                  emit(event, data = {}) {
                    for (const handler of this.handlers.get(event) || []) handler(event, data);
                  }
                  attachMedia() {
                    queueMicrotask(() => this.emit(Hls.Events.MEDIA_ATTACHED));
                  }
                  loadSource(source) {
                    fetch(source).catch(() => {}).finally(() => {
                      queueMicrotask(() => this.emit(Hls.Events.MANIFEST_PARSED));
                    });
                  }
                  startLoad() {}
                  recoverMediaError() {}
                  destroy() {
                    this.handlers.clear();
                  }
                }
              `,
            });
          },
        );
      }

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
        if (
          pageSpec.expectHoverResolvePrewarm &&
          url.pathname === "/api/resolve/movie"
        ) {
          hoverResolvePrewarmRequests.push(Object.fromEntries(url.searchParams));
        }
        if (
          (pageSpec.expectSourceSwitch ||
            pageSpec.expectSourceSwitchFailureRestore) &&
          url.pathname === "/api/resolve/tv"
        ) {
          const sourceHash = url.searchParams.get("sourceHash") || "";
          if (sourceHash) {
            sawSourceSwitchResolveHash = sourceHash;
            sourceSwitchResolveHashes.push(sourceHash);
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
        if (pageSpec.expectLiveStreamSwitch && url.pathname === "/api/sports/stream") {
          const requestedSource = url.searchParams.get("url") || "";
          const stream =
            liveStreamSwitchStreams.find((option) => option.source === requestedSource) ||
            liveStreamSwitchStreams[0];
          liveStreamResolveSources.push(requestedSource);
          await route.fulfill(
            jsonResponse({
              playbackType: "hls",
              playbackUrl: `https://hls.example.test/${stream.id}.m3u8`,
              playerPage: requestedSource,
              source: requestedSource,
            }),
          );
          return;
        }
        if (pageSpec.path === "/login.html" && url.pathname === "/api/auth/me") {
          await route.fulfill(jsonResponse({ error: "Not authenticated." }, 401));
          return;
        }
        if (
          pageSpec.expectRealDebridLoadFailureNoOverwrite &&
          url.pathname === "/api/user/torrent-settings"
        ) {
          if (request.method() === "GET") {
            await route.fulfill(jsonResponse({ error: "Temporary failure." }, 503));
            return;
          }
          realDebridUpdateBodies.push(request.postDataJSON());
          await route.fulfill(jsonResponse({
            ok: true,
            configured: true,
            maskedApiKey: "abcd…wxyz",
            localTorrentEnabled: false,
          }));
          return;
        }
        if (
          pageSpec.expectHydratedPreferencesBeforeMount &&
          url.pathname === "/api/user/preferences" &&
          request.method() === "GET"
        ) {
          await route.fulfill(jsonResponse({
            "streamarena-default-audio-lang": "ja",
            "streamarena-subtitle-color-pref": "#00ff00",
          }));
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
        if (pageSpec.expectLiveStreamSwitch && url.pathname === "/api/live/hls.m3u8") {
          liveStreamHlsInputs.push(url.searchParams.get("input") || "");
        }
        if (url.pathname === "/api/live/hls.m3u8" || url.pathname === "/api/hls/master.m3u8") {
          await route.fulfill({
            status: 200,
            contentType: "application/vnd.apple.mpegurl",
            body: String(payload),
          });
          return;
        }
        if (url.pathname === "/api/live/hls-resource") {
          await route.fulfill({
            status: 200,
            contentType: "video/mp2t",
            body: "",
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
        if (url.pathname === "/api/subtitles.external.vtt") {
          await route.fulfill({
            status: 200,
            contentType: "text/vtt; charset=utf-8",
            body: "WEBVTT\n\n",
          });
          return;
        }
        await route.fulfill(jsonResponse(payload));
      });

      if (pageSpec.expectServerContinueWatchingTruth) {
        await context.addInitScript(() => {
          const staleSource = "tmdb:movie:999999";
          const user = { id: 1, email: "smoke@example.com", displayName: "Smoke User" };
          localStorage.setItem("streamarena-user-state-owner-v1", "1");
          localStorage.setItem("streamarena-user-state-user-v1", JSON.stringify(user));
          localStorage.setItem(`streamarena-resume:${staleSource}`, "120");
          localStorage.setItem(
            "streamarena-continue-watching-meta",
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

      if (pageSpec.expectTranslatedSubtitleMigration) {
        await context.addInitScript(
          ({ storageKey, staleStreamIndex }) => {
            localStorage.setItem(storageKey, String(staleStreamIndex));
          },
          {
            storageKey: `streamarena-subtitle-stream:tv:${translatedSubtitleTmdbId}:s1:e2`,
            staleStreamIndex: staleEnglishSubtitleStreamIndex,
          },
        );
      }

      if (pageSpec.expectSourceSwitch || pageSpec.expectSourceSwitchFailureRestore) {
        await context.addInitScript(({ sourceHashes, failingHash }) => {
          const shouldHandleSource = (media) => {
            const currentSource = String(media.getAttribute("src") || "");
            return sourceHashes.some((hash) => currentSource.includes(hash));
          };
          const isFailingSource = (media) => {
            if (!failingHash) {
              return false;
            }
            const currentSource = String(media.getAttribute("src") || "");
            return currentSource.includes(failingHash);
          };
          const originalLoad = HTMLMediaElement.prototype.load;
          const originalPlay = HTMLMediaElement.prototype.play;
          HTMLMediaElement.prototype.load = function patchedLoad(...args) {
            if (!shouldHandleSource(this)) {
              return originalLoad.apply(this, args);
            }
            const requestedSource = String(this.getAttribute("src") || "");
            Object.defineProperty(this, "currentSrc", {
              configurable: true,
              value: new URL(requestedSource, window.location.origin).toString(),
            });
            if (!isFailingSource(this)) {
              queueMicrotask(() => {
                this.dispatchEvent(new Event("loadedmetadata"));
                this.dispatchEvent(new Event("canplay"));
              });
            }
            return undefined;
          };
          HTMLMediaElement.prototype.play = function patchedPlay(...args) {
            if (!shouldHandleSource(this)) {
              return originalPlay.apply(this, args);
            }
            if (isFailingSource(this)) {
              queueMicrotask(() => {
                this.dispatchEvent(new Event("error"));
              });
              return Promise.reject(
                new DOMException("Mock playback failure", "NotSupportedError"),
              );
            }
            queueMicrotask(() => {
              this.dispatchEvent(new Event("playing"));
              this.dispatchEvent(new Event("timeupdate"));
            });
            return Promise.resolve();
          };
        }, {
          sourceHashes: [sourceSwitchHashA, sourceSwitchHashB],
          // The player defaults to hashB, so make the 1080p alternate (hashA) the
          // failing source the failure-restore test switches to.
          failingHash: pageSpec.expectSourceSwitchFailureRestore
            ? sourceSwitchHashA
            : "",
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

      if (pageSpec.expectSeekProgress) {
        const seekProgressState = await page.evaluate(() => {
          const video = document.querySelector("#playerVideo");
          const seekBar = document.querySelector("#seekBar");
          const playedProgress = document.querySelector("#seekPlayedProgress");
          const bufferedProgress = document.querySelector("#seekBufferedProgress");
          Object.defineProperty(video, "duration", {
            configurable: true,
            value: 100,
          });
          Object.defineProperty(video, "currentTime", {
            configurable: true,
            value: 40,
          });
          video.dispatchEvent(new Event("timeupdate"));
          const style = getComputedStyle(seekBar);
          let playedRuleBackground = "";
          for (const sheet of Array.from(document.styleSheets)) {
            try {
              for (const rule of Array.from(sheet.cssRules || [])) {
                if (rule.selectorText === ".seek-track-played::-webkit-progress-value") {
                  playedRuleBackground = rule.style.background;
                }
              }
            } catch {
              // Ignore cross-origin sheets; the bundled player stylesheet is same-origin.
            }
          }
          return {
            value: Number(seekBar.value),
            played: Number(playedProgress.value),
            buffered: Number(bufferedProgress.value),
            backgroundImage: style.backgroundImage,
            playedRuleBackground,
          };
        });
        if (
          seekProgressState.value !== 400 ||
          seekProgressState.played !== 400 ||
          seekProgressState.buffered !== 400 ||
          seekProgressState.backgroundImage !== "none" ||
          seekProgressState.playedRuleBackground !== "var(--ui-accent)"
        ) {
          throw new Error(
            `${pageSpec.path}\nSeek track did not paint the played portion red.\n${JSON.stringify(seekProgressState)}`,
          );
        }
      }

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

      if (pageSpec.expectHomeAccessibility) {
        await page.waitForSelector(".card-primary-action", { timeout: 8_000 });
        const accessibilityState = await page.evaluate(() => {
          const cards = [...document.querySelectorAll("article.card")];
          const heroTitle = document.querySelector("#heroTitle");
          const carousel = document.querySelector(".hero-carousel-dots");
          const carouselButtons = [...(carousel?.querySelectorAll("button") || [])];
          return {
            deadControlCount: document.querySelectorAll(
              '.kids, [aria-label="Notifications"], [aria-label="Rate title"]',
            ).length,
            cardCount: cards.length,
            cardsWithTabIndex: cards.filter((card) => card.hasAttribute("tabindex")).length,
            cardPrimaryActionCount: cards.filter(
              (card) => card.querySelector(":scope > button.card-primary-action"),
            ).length,
            hiddenHoverCount: cards.filter((card) => {
              const hover = card.querySelector(".card-hover");
              return hover?.hasAttribute("inert") && hover.getAttribute("aria-hidden") === "true";
            }).length,
            heroTitleTabIndex: heroTitle?.getAttribute("tabindex") ?? null,
            carouselRole: carousel?.getAttribute("role") || "",
            carouselUsesSelectionState: carouselButtons.some((button) =>
              button.hasAttribute("aria-selected"),
            ),
            carouselPressedCount: carouselButtons.filter((button) =>
              button.hasAttribute("aria-pressed"),
            ).length,
            carouselButtonCount: carouselButtons.length,
          };
        });
        if (
          accessibilityState.deadControlCount !== 0 ||
          accessibilityState.cardCount < 1 ||
          accessibilityState.cardsWithTabIndex !== 0 ||
          accessibilityState.cardPrimaryActionCount !== accessibilityState.cardCount ||
          accessibilityState.hiddenHoverCount !== accessibilityState.cardCount ||
          accessibilityState.heroTitleTabIndex !== null ||
          accessibilityState.carouselRole !== "group" ||
          accessibilityState.carouselUsesSelectionState ||
          accessibilityState.carouselPressedCount !== accessibilityState.carouselButtonCount
        ) {
          throw new Error(
            `${pageSpec.path}\nHome accessibility semantics regressed.\n${JSON.stringify(accessibilityState)}`,
          );
        }

        const heroInfo = page.locator("#heroInfo");
        await heroInfo.click();
        await page.waitForSelector(".details-modal.is-open", { timeout: 8_000 });
        await page.waitForFunction(
          () => document.querySelector("#detailsMaturity")?.textContent?.trim() === "PG",
          null,
          { timeout: 8_000 },
        );
        const openModalState = await page.evaluate(() => {
          const modal = document.querySelector("#detailsModal");
          const sheet = modal?.querySelector(".details-sheet");
          const siblings = [...(modal?.parentElement?.children || [])].filter(
            (element) => element !== modal,
          );
          return {
            activeElementId: document.activeElement?.id || "",
            focusInsideDialog: Boolean(sheet?.contains(document.activeElement)),
            backgroundIsInert: siblings.length > 0 && siblings.every(
              (element) => element.hasAttribute("inert"),
            ),
            certification: document.querySelector("#detailsMaturity")?.textContent?.trim() || "",
          };
        });
        if (
          openModalState.activeElementId !== "detailsClose" ||
          !openModalState.focusInsideDialog ||
          !openModalState.backgroundIsInert ||
          openModalState.certification !== "PG"
        ) {
          throw new Error(
            `${pageSpec.path}\nDetails dialog did not initialize accessibly.\n${JSON.stringify(openModalState)}`,
          );
        }

        await page.keyboard.press("Shift+Tab");
        const trappedFocus = await page.evaluate(() =>
          Boolean(document.querySelector(".details-sheet")?.contains(document.activeElement)),
        );
        if (!trappedFocus) {
          throw new Error(`${pageSpec.path}\nDetails dialog did not contain reverse Tab focus.`);
        }
        await page.keyboard.press("Escape");
        await page.waitForSelector(".details-modal", { state: "hidden", timeout: 8_000 });
        await page.waitForFunction(() => document.activeElement?.id === "heroInfo", null, {
          timeout: 8_000,
        });
        const closedModalState = await page.evaluate(() => ({
          activeElementId: document.activeElement?.id || "",
          inertBackgroundCount: document.querySelectorAll(
            ".home-page > [inert]",
          ).length,
        }));
        if (
          closedModalState.activeElementId !== "heroInfo" ||
          closedModalState.inertBackgroundCount !== 0
        ) {
          throw new Error(
            `${pageSpec.path}\nDetails dialog did not restore focus and background state.\n${JSON.stringify(closedModalState)}`,
          );
        }

        const firstCard = page.locator("article.card").first();
        const cardPrimaryAction = firstCard.locator(":scope > .card-primary-action");
        await firstCard.hover();
        await page.waitForFunction(() =>
          document.querySelector("article.card")?.classList.contains("is-hovering"),
          null,
          { timeout: 8_000 },
        );
        await firstCard.locator(".hover-details").click();
        await page.waitForSelector(".details-modal.is-open", { timeout: 8_000 });
        await page.locator("#detailsClose").click();
        await page.waitForSelector(".details-modal", { state: "hidden", timeout: 8_000 });
        await page.waitForFunction(() => {
          const card = document.querySelector("article.card");
          return document.activeElement === card?.querySelector(":scope > .card-primary-action");
        }, null, { timeout: 8_000 });

        if (pageSpec.expectHoverResolvePrewarm) {
          const tmdbMovieCard = page.locator(
            '#cardsContainer article.card[data-tmdb-id="1"]',
          );
          if (await tmdbMovieCard.count() !== 1) {
            throw new Error(`${pageSpec.path}\nTMDB movie hover target is missing or ambiguous.`);
          }
          await tmdbMovieCard.hover();
          for (let attempt = 0; attempt < 80 && !hoverResolvePrewarmRequests.length; attempt += 1) {
            await delay(50);
          }
          const warmRequest = hoverResolvePrewarmRequests[0] || {};
          if (
            warmRequest.tmdbId !== "1" ||
            warmRequest.resolverProvider !== "fastest" ||
            warmRequest.sourceLang !== "en" ||
            warmRequest.sourceAudioProfile !== "single" ||
            Object.prototype.hasOwnProperty.call(warmRequest, "sourceHash") ||
            !page.url().endsWith("/index.html")
          ) {
            throw new Error(
              `${pageSpec.path}\nMovie hover did not start an unpinned HLS prewarm before navigation.\n${JSON.stringify({ warmRequest, url: page.url() })}`,
            );
          }

          const continueAction = page.locator(
            "#continueCards article.card > .card-primary-action",
          );
          if (await continueAction.count() !== 1) {
            throw new Error(`${pageSpec.path}\nContinue Watching action is missing or ambiguous.`);
          }
          await continueAction.click();
          await page.waitForURL(
            (nextUrl) =>
              nextUrl.pathname.startsWith("/watch") ||
              nextUrl.pathname.includes("player"),
            { timeout: 8_000 },
          );
          const continueUrl = new URL(page.url());
          if (continueUrl.searchParams.get("resumePlayback") !== "1") {
            throw new Error(
              `${pageSpec.path}\nContinue Watching did not preserve source-resume intent.\n${continueUrl.toString()}`,
            );
          }
        }
      }

      if (pageSpec.expectTouchCardActions || pageSpec.expectNarrowNavigation) {
        await page.waitForSelector(".card-touch-actions", { timeout: 8_000 });
        const responsiveState = await page.evaluate(() => {
          const nav = document.querySelector(".top-nav");
          const navLeft = nav?.querySelector(".nav-left");
          const navRight = nav?.querySelector(".nav-right");
          const firstCard = document.querySelector(".card");
          const firstCardHover = firstCard?.querySelector(".card-hover");
          const actions = firstCard?.querySelector(".card-touch-actions");
          const leftRect = navLeft?.getBoundingClientRect();
          const rightRect = navRight?.getBoundingClientRect();
          const cardRect = firstCard?.getBoundingClientRect();
          const actionRect = actions?.getBoundingClientRect();
          const actionButtons = [...(actions?.querySelectorAll("button") || [])].map((button) => {
            const rect = button.getBoundingClientRect();
            return {
              display: getComputedStyle(button).display,
              height: rect.height,
              width: rect.width,
            };
          });
          const navigationTargets = [
            ...(nav?.querySelectorAll("nav a") || []),
            nav?.querySelector("#openSearchButton"),
            nav?.querySelector(".account-avatar-btn"),
          ]
            .filter(Boolean)
            .map((target) => {
              const rect = target.getBoundingClientRect();
              return {
                label: target.getAttribute("aria-label") || target.textContent?.trim() || "target",
                height: rect.height,
                width: rect.width,
              };
            })
            .filter((target) => target.height > 0 && target.width > 0);
          return {
            viewportWidth: window.innerWidth,
            coarsePointer: window.matchMedia("(hover: none) and (pointer: coarse)").matches,
            navClientWidth: nav?.clientWidth || 0,
            navScrollWidth: nav?.scrollWidth || 0,
            navLeftRight: leftRect?.right || 0,
            navRightLeft: rightRect?.left || 0,
            navRightEdge: rightRect?.right || 0,
            cardHoverDisplay: firstCardHover ? getComputedStyle(firstCardHover).display : "missing",
            actionsDisplay: actions ? getComputedStyle(actions).display : "missing",
            actionsPointerEvents: actions ? getComputedStyle(actions).pointerEvents : "missing",
            actionsFitCard: Boolean(
              cardRect && actionRect &&
              actionRect.left >= cardRect.left - 0.5 &&
              actionRect.right <= cardRect.right + 0.5 &&
              actionRect.bottom <= cardRect.bottom + 0.5
            ),
            actionButtons,
            navigationTargets,
          };
        });
        if (
          responsiveState.viewportWidth !== 320 ||
          !responsiveState.coarsePointer ||
          responsiveState.navLeftRight > responsiveState.navRightLeft + 0.5 ||
          responsiveState.navRightEdge > responsiveState.viewportWidth + 0.5 ||
          responsiveState.navScrollWidth > responsiveState.navClientWidth + 1 ||
          responsiveState.cardHoverDisplay !== "none" ||
          responsiveState.actionsDisplay !== "flex" ||
          responsiveState.actionsPointerEvents === "none" ||
          !responsiveState.actionsFitCard ||
          responsiveState.actionButtons.length !== 2 ||
          responsiveState.actionButtons.some(
            (button) => button.display === "none" || button.width < 43 || button.height < 43,
          ) ||
          responsiveState.navigationTargets.length < 3 ||
          responsiveState.navigationTargets.some(
            (target) => target.width < 43 || target.height < 43,
          )
        ) {
          throw new Error(
            `${pageSpec.path}\nTouch actions or 320px navigation layout regressed.\n${JSON.stringify(responsiveState)}`,
          );
        }

        const touchActionGroups = page.locator(".card-touch-actions");
        const touchActionGroupCount = await touchActionGroups.count();
        if (touchActionGroupCount < 1) {
          throw new Error(`${pageSpec.path}\nNo persistent touch card actions rendered.`);
        }
        const firstTouchActionGroup = touchActionGroups.first();
        const touchDetailsButton = firstTouchActionGroup.locator(".card-touch-details");
        if (await touchDetailsButton.count() !== 1) {
          throw new Error(`${pageSpec.path}\nTouch Details action is missing or ambiguous.`);
        }
        await touchDetailsButton.click();
        await page.waitForSelector(".details-modal.is-open", { timeout: 8_000 });
        await page.waitForFunction(
          () => document.querySelector("#detailsMaturity")?.textContent?.trim() === "Unrated",
          null,
          { timeout: 8_000 },
        );
        if (!page.url().endsWith("/index.html")) {
          throw new Error(`${pageSpec.path}\nTouch Details action unexpectedly started playback.`);
        }
        await page.locator("#detailsClose").click();
        await page.waitForSelector(".details-modal", { state: "hidden", timeout: 8_000 });

        const touchMyListButton = firstTouchActionGroup.locator(".card-touch-my-list");
        if (await touchMyListButton.count() !== 1) {
          throw new Error(`${pageSpec.path}\nTouch My List action is missing or ambiguous.`);
        }
        await touchMyListButton.click();
        await page.waitForFunction(
          () => Boolean(document.querySelector(".card-touch-my-list[aria-pressed='true']")),
          null,
          { timeout: 8_000 },
        );

        const openSearchButton = page.locator("#openSearchButton");
        if (await openSearchButton.count() !== 1) {
          throw new Error(`${pageSpec.path}\nNarrow navigation Search control is missing or ambiguous.`);
        }
        await openSearchButton.click();
        await page.waitForFunction(() => document.body.classList.contains("is-search-mode"));
        await page.waitForSelector(".nav-search-box.is-open", {
          state: "visible",
          timeout: 8_000,
        });
        const searchLayout = await page.evaluate(() => {
          const nav = document.querySelector(".top-nav");
          const navLeft = nav?.querySelector(".nav-left");
          const navRight = nav?.querySelector(".nav-right");
          const search = nav?.querySelector(".nav-search-box.is-open");
          const rightRect = navRight?.getBoundingClientRect();
          const searchRect = search?.getBoundingClientRect();
          return {
            navLeftDisplay: navLeft ? getComputedStyle(navLeft).display : "missing",
            navRightEdge: rightRect?.right || 0,
            searchLeft: searchRect?.left || 0,
            searchRight: searchRect?.right || 0,
            viewportWidth: window.innerWidth,
          };
        });
        if (
          searchLayout.navLeftDisplay !== "none" ||
          searchLayout.searchLeft < 9 ||
          searchLayout.searchRight > searchLayout.viewportWidth - 9 ||
          searchLayout.navRightEdge > searchLayout.viewportWidth + 0.5
        ) {
          throw new Error(
            `${pageSpec.path}\nSearch navigation overlaps at 320px.\n${JSON.stringify(searchLayout)}`,
          );
        }
      }

      if (pageSpec.expectRealDebridLoadFailureNoOverwrite) {
        const initialPreferences = await page.evaluate(() => ({
          audio: document.querySelector("#defaultAudioLanguage")?.value || "",
          subtitleColor: document.querySelector("#subtitleColorInput")?.value || "",
        }));
        if (
          initialPreferences.audio !== "ja" ||
          initialPreferences.subtitleColor.toLowerCase() !== "#00ff00"
        ) {
          throw new Error(
            `${pageSpec.path}\nSettings mounted before server preference hydration.\n${JSON.stringify(initialPreferences)}`,
          );
        }
        await page.waitForFunction(
          () => /Unable to load Real-Debrid settings/.test(
            document.querySelector(".real-debrid-status")?.textContent || "",
          ),
          null,
          { timeout: 8_000 },
        );
        await page.getByRole("button", { name: "Save Settings" }).click();
        await delay(250);
        if (realDebridUpdateBodies.length !== 0) {
          throw new Error(
            `${pageSpec.path}\nUnrelated Settings save overwrote Real-Debrid state after GET failure.\n${JSON.stringify(realDebridUpdateBodies)}`,
          );
        }

        await page.locator("#realDebridApiKey").fill("a".repeat(40));
        await page.getByRole("button", { name: "Save Settings" }).click();
        await page.waitForFunction(
          () => document.querySelector(".real-debrid-status")?.textContent?.trim() === "Saved",
          null,
          { timeout: 8_000 },
        );
        if (
          realDebridUpdateBodies.length !== 1 ||
          realDebridUpdateBodies[0]?.apiKey !== "a".repeat(40) ||
          Object.hasOwn(realDebridUpdateBodies[0], "localTorrentEnabled")
        ) {
          throw new Error(
            `${pageSpec.path}\nDirty Real-Debrid save did not use field-level update semantics.\n${JSON.stringify(realDebridUpdateBodies)}`,
          );
        }
      }

      if (pageSpec.expectUnknownAudioFallback) {
        await page.waitForFunction(
          () => document.querySelectorAll("#audioOptions .audio-option").length > 0,
          null,
          { timeout: 8_000 },
        );
        const audioFallbackState = await page.evaluate(() => {
          document.querySelector("#toggleAudio")?.click();
          const options = [...document.querySelectorAll("#audioOptions .audio-option")].map(
            (option) => ({
              text: option.textContent?.trim() || "",
              optionType: option.dataset.optionType || "",
              selected: option.getAttribute("aria-selected") || "",
            }),
          );
          return {
            title: document.querySelector("#toggleAudio")?.getAttribute("title") || "",
            menuLabel:
              document.querySelector("#audioMenu")?.getAttribute("aria-label") || "",
            options,
          };
        });
        const fakeLanguages = new Set(["Auto", "English", "French", "Spanish", "German"]);
        const renderedFakeLanguages = audioFallbackState.options
          .map((option) => option.text)
          .filter((text) => fakeLanguages.has(text));
        if (
          audioFallbackState.options.length !== 1 ||
          audioFallbackState.options[0]?.text !== "Default" ||
          audioFallbackState.options[0]?.optionType !== "default-audio" ||
          audioFallbackState.options[0]?.selected !== "true" ||
          renderedFakeLanguages.length > 0 ||
          !audioFallbackState.title.includes("audio: Default") ||
          !audioFallbackState.menuLabel.includes("Default")
        ) {
          throw new Error(
            `${pageSpec.path}\nUnknown audio tracks should render one honest Default option.\n${JSON.stringify(audioFallbackState)}`,
          );
        }
      }

      if (pageSpec.expectTranslatedSubtitleMigration) {
        const storageKey =
          `streamarena-subtitle-stream:tv:${translatedSubtitleTmdbId}:s1:e2`;
        await page.waitForFunction(
          ({ expectedStreamIndex, expectedStorageKey }) => {
            const selected = document.querySelector(
              "#subtitleOptions .subtitle-option[aria-selected='true']",
            );
            return (
              Number(selected?.dataset.subtitleStream) === expectedStreamIndex &&
              Number(localStorage.getItem(expectedStorageKey)) === expectedStreamIndex
            );
          },
          {
            expectedStreamIndex: translatedEnglishSubtitleStreamIndex,
            expectedStorageKey: storageKey,
          },
          { timeout: 8_000 },
        );
        const subtitleState = await page.evaluate((expectedStorageKey) => {
          const options = [...document.querySelectorAll(
            "#subtitleOptions .subtitle-option",
          )].map((option) => ({
            streamIndex: Number(option.dataset.subtitleStream),
            selected: option.getAttribute("aria-selected") === "true",
            text: option.textContent?.trim() || "",
          }));
          return {
            options,
            storedStreamIndex: Number(localStorage.getItem(expectedStorageKey)),
          };
        }, storageKey);
        const selected = subtitleState.options.find((option) => option.selected);
        const availableTracks = subtitleState.options.filter(
          (option) => option.streamIndex >= 0,
        );
        if (
          availableTracks.length !== 2 ||
          !availableTracks.some(
            (option) => option.streamIndex === staleEnglishSubtitleStreamIndex,
          ) ||
          selected?.streamIndex !== translatedEnglishSubtitleStreamIndex ||
          !selected.text.includes("Translated dialogue") ||
          subtitleState.storedStreamIndex !== translatedEnglishSubtitleStreamIndex
        ) {
          throw new Error(
            `${pageSpec.path}\nA stale English OpenSubtitles id overrode the newly ranked translated track.\n${JSON.stringify(subtitleState)}`,
          );
        }
      }

      if (pageSpec.expectServerContinueWatchingTruth) {
        await page.waitForFunction(
          () =>
            !localStorage.getItem("streamarena-resume:tmdb:movie:999999") &&
            !(localStorage.getItem("streamarena-continue-watching-meta") || "").includes("Ghost Movie"),
          null,
          { timeout: 8_000 },
        );
        const staleState = await page.evaluate(() => ({
          rowText: document.querySelector("#continueCards")?.textContent || "",
          resume: localStorage.getItem("streamarena-resume:tmdb:movie:999999"),
          meta: localStorage.getItem("streamarena-continue-watching-meta") || "",
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
        await page.waitForFunction(
          () => {
            const buttons = [...document.querySelectorAll(".sports-genres button")];
            const buttonFor = (label) =>
              buttons.find((button) => button.textContent?.trim() === label);
            const football = buttonFor("Football");
            const basketball = buttonFor("Basketball");
            return (
              football?.getAttribute("aria-pressed") === "false" &&
              basketball?.getAttribute("aria-pressed") === "true"
            );
          },
          null,
          { timeout: 8_000 },
        );
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

      if (pageSpec.expectSportsEarlyPlayback) {
        const earlyButton = page.getByRole("button", {
          name: "Play Early Window Match in StreamArena",
        });
        const outsideButton = page.getByRole("button", { name: "Outside Window Match" });
        await earlyButton.waitFor({ state: "visible" });
        const playbackState = {
          earlyDisabled: await earlyButton.isDisabled(),
          outsideDisabled: await outsideButton.isDisabled(),
          earlyTitle: await earlyButton.getAttribute("title"),
          outsideTitle: await outsideButton.getAttribute("title"),
        };
        if (
          playbackState.earlyDisabled ||
          !playbackState.outsideDisabled ||
          playbackState.earlyTitle !== "Play in StreamArena" ||
          playbackState.outsideTitle !== "Available 10 minutes before start"
        ) {
          throw new Error(
            `${pageSpec.path}\nSports matches should become playable exactly 10 minutes before kickoff.\n${JSON.stringify(playbackState)}`,
          );
        }
        await earlyButton.click();
        await page.waitForURL((url) => url.pathname === "/watch", { timeout: 8_000 });
        const playerUrl = new URL(page.url());
        if (
          playerUrl.origin !== baseUrl ||
          playerUrl.pathname !== "/watch" ||
          playerUrl.searchParams.get("src") !==
            "https://sports.example.test/early-window"
        ) {
          throw new Error(
            `${pageSpec.path}\nEarly sports playback must navigate only to StreamArena's internal player.\n${playerUrl}`,
          );
        }
      }

      if (pageSpec.expectLiveIframeUnsandboxed) {
        await page.waitForFunction(
          (expectedSrc) => {
            const frame = document.querySelector("#liveEmbedFrame");
            return Boolean(
              frame &&
                !frame.hidden &&
                frame.getAttribute("src") === expectedSrc,
            );
          },
          liveIframeEmbedUrl,
          { timeout: 8_000 },
        );
        const iframeState = await page.evaluate(() => {
          const frame = document.querySelector("#liveEmbedFrame");
          return {
            sandbox: frame?.getAttribute("sandbox") ?? null,
            allow: frame?.getAttribute("allow") || "",
            referrerpolicy: frame?.getAttribute("referrerpolicy") || "",
          };
        });
        if (
          iframeState.sandbox !== null ||
          !iframeState.allow.includes("fullscreen") ||
          iframeState.referrerpolicy !== "strict-origin-when-cross-origin"
        ) {
          throw new Error(
            `${pageSpec.path}\nLive iframe should be unsandboxed while keeping frame policies.\n${JSON.stringify(iframeState)}`,
          );
        }
        const readIframePlayLabel = () =>
          page.getAttribute("#togglePlay", "aria-label");
        const clickIframePlayToggle = () =>
          page.evaluate(() => document.querySelector("#togglePlay")?.click());
        if ((await readIframePlayLabel()) !== "Pause") {
          throw new Error(`${pageSpec.path}\nLive iframe should start with play intent.`);
        }
        await clickIframePlayToggle();
        if ((await readIframePlayLabel()) !== "Play") {
          throw new Error(`${pageSpec.path}\nLive iframe pause intent was not retained.`);
        }
        await clickIframePlayToggle();
        if ((await readIframePlayLabel()) !== "Pause") {
          throw new Error(`${pageSpec.path}\nLive iframe did not resume play intent.`);
        }

        if (pageSpec.expectLiveIframeSourceSwitch) {
          await page.evaluate(() => {
            document.querySelector(".player-shell")?.classList.add("controls-hidden");
          });
          const pickerState = await page.evaluate(() => {
            const picker = document.querySelector("#toggleLiveStream");
            const rect = picker?.getBoundingClientRect();
            return {
              hidden: picker?.closest("#liveStreamControl")?.hidden ?? true,
              width: rect?.width || 0,
              height: rect?.height || 0,
              visibility: picker ? getComputedStyle(picker).visibility : "missing",
              playerUiOpacity: getComputedStyle(
                document.querySelector(".player-ui"),
              ).opacity,
            };
          });
          if (
            pickerState.hidden ||
            pickerState.width < 40 ||
            pickerState.height < 40 ||
            pickerState.visibility !== "visible" ||
            pickerState.playerUiOpacity !== "1"
          ) {
            throw new Error(
              `${pageSpec.path}\nLive iframe source picker should remain visible after controls hide.\n${JSON.stringify(pickerState)}`,
            );
          }

          await page.click("#toggleLiveStream");
          await page.click(
            `.live-stream-option[data-stream-id="${liveIframeSwitchStreams[1].id}"]`,
          );
          await page.waitForFunction(
            ({ expectedId, expectedSrc }) => {
              const frame = document.querySelector("#liveEmbedFrame");
              const selected = document.querySelector(
                ".live-stream-option[aria-selected='true']",
              );
              return (
                frame?.src === expectedSrc &&
                selected?.dataset.streamId === expectedId &&
                new URL(window.location.href).searchParams.get("liveStreamId") ===
                  expectedId
              );
            },
            {
              expectedId: liveIframeSwitchStreams[1].id,
              expectedSrc: liveIframeAltUrl,
            },
            { timeout: 8_000 },
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
        // The player defaults to the 4K source (hashB). A fatal playback error no
        // longer silently switches sources; it surfaces the recovery overlay,
        // whose "Try another source" action resolves the 1080p alternate (hashA).
        await page.waitForFunction(
          (hash) =>
            Boolean(
              document.querySelector(`.source-option[data-source-hash="${hash}"]`),
            ) &&
            (document.querySelector("video")?.getAttribute("src") || "").includes(hash),
          sourceSwitchHashB,
          { timeout: 8_000 },
        );

        // Fail the active (hashB) source.
        await page.evaluate(() => {
          document.querySelector("video")?.dispatchEvent(new Event("error"));
        });

        // Recovery surfaces an error overlay with a usable "Try another source"
        // action rather than auto-switching.
        await page.waitForFunction(
          () => {
            const overlay = document.querySelector(".resolver-overlay");
            const alternate = document.querySelector("#resolverAlternateButton");
            return Boolean(
              overlay &&
                !overlay.hidden &&
                overlay.classList.contains("is-error") &&
                alternate &&
                !alternate.hidden,
            );
          },
          null,
          { timeout: 8_000 },
        );

        // Choosing "Try another source" resolves the alternate (hashA) and makes
        // it the active playback source. As in the manual source-switch test we
        // assert on the selected source + active video rather than overlay state
        // (the mock <video> never fires canplay headless, so the overlay lingers).
        await page.click("#resolverAlternateButton");
        for (let attempt = 0; attempt < 150; attempt += 1) {
          const recovered = await page.evaluate((hash) => {
            const selectedHash =
              document.querySelector(".source-option[aria-selected='true']")
                ?.dataset.sourceHash || "";
            const videoSource = document.querySelector("video")?.getAttribute("src") || "";
            return selectedHash === hash && videoSource.includes(hash);
          }, sourceSwitchHashA);
          if (recovered) {
            break;
          }
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
          sawAutomaticFallbackResolveHash !== sourceSwitchHashA ||
          fallbackState.selectedHash !== sourceSwitchHashA ||
          !fallbackState.videoSource.includes(sourceSwitchHashA)
        ) {
          throw new Error(
            `${pageSpec.path}\nManual source recovery failed.\n${JSON.stringify({
              sawAutomaticFallbackResolveHash,
              automaticFallbackResolveCount,
              fallbackState,
            })}`,
          );
        }
      }

      if (pageSpec.expectSourceSwitch) {
        // The player defaults to the 4K source (hashB), so switching exercises a
        // real change to the 1080p alternate (hashA).
        await page.waitForFunction(
          () => {
            const overlay = document.querySelector(".resolver-overlay");
            return !overlay || overlay.hidden || overlay.classList.contains("is-error");
          },
          { timeout: 8_000 },
        );
        await page.waitForSelector("#toggleSource", { state: "visible", timeout: 8_000 });
        await page.click("#toggleSource");
        await page.evaluate(() => {
          const sourceControl = document.querySelector("#sourceControl");
          sourceControl?.classList.add("is-open");
          document.querySelector("#toggleSource")?.setAttribute("aria-expanded", "true");
        });
        await page.waitForFunction(
          (hash) =>
            Boolean(
              document.querySelector(`.source-option[data-source-hash="${hash}"]`),
            ),
          sourceSwitchHashA,
          { timeout: 8_000 },
        );
        await page.evaluate((hash) => {
          document
            .querySelector(`.source-option[data-source-hash="${hash}"]`)
            ?.click();
        }, sourceSwitchHashA);
        for (let attempt = 0; attempt < 80; attempt += 1) {
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
          }, sourceSwitchHashA);
          if (switched) {
            break;
          }
          const isResolving = await page.evaluate(() => {
            const overlay = document.querySelector(".resolver-overlay");
            return Boolean(
              overlay &&
                !overlay.hidden &&
                !overlay.classList.contains("is-error"),
            );
          });
          if (!isResolving) {
            await page.evaluate((hash) => {
              const sourceControl = document.querySelector("#sourceControl");
              sourceControl?.classList.add("is-open");
              document
                .querySelector(`.source-option[data-source-hash="${hash}"]`)
                ?.click();
            }, sourceSwitchHashA);
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
          sawSourceSwitchResolveHash !== sourceSwitchHashA ||
          !sourceSwitchResolveHashes.includes(sourceSwitchHashA) ||
          switchState.selectedHash !== sourceSwitchHashA ||
          !switchState.videoSource.includes(sourceSwitchHashA)
        ) {
          throw new Error(
            `${pageSpec.path}\nSource switch failed.\n${JSON.stringify({
              sawSourceSwitchResolveHash,
              sourceSwitchResolveHashes,
              switchState,
            })}`,
          );
        }
      }

      if (pageSpec.expectSourceSwitchFailureRestore) {
        // The player defaults to the 4K source (hashB). Manually switching to a
        // source that fails to play (hashA — see failingHash below) surfaces the
        // recovery overlay, and "Try another source" recovers to the working hashB.
        await page.waitForFunction(
          (hash) =>
            Boolean(
              document.querySelector(`.source-option[data-source-hash="${hash}"]`),
            ) &&
            (document.querySelector("video")?.getAttribute("src") || "").includes(hash),
          sourceSwitchHashB,
          { timeout: 8_000 },
        );
        await page.waitForSelector("#toggleSource", { state: "visible", timeout: 8_000 });
        await page.click("#toggleSource");
        await page.evaluate(() => {
          const sourceControl = document.querySelector("#sourceControl");
          sourceControl?.classList.add("is-open");
          document.querySelector("#toggleSource")?.setAttribute("aria-expanded", "true");
        });
        await page.waitForFunction(
          (hash) =>
            Boolean(
              document.querySelector(`.source-option[data-source-hash="${hash}"]`),
            ),
          sourceSwitchHashA,
          { timeout: 8_000 },
        );
        // Switch to the source that fails to play (hashA).
        await page.evaluate((hash) => {
          document
            .querySelector(`.source-option[data-source-hash="${hash}"]`)
            ?.click();
        }, sourceSwitchHashA);

        // The failed provisional switch must roll back to the last confirmed
        // source (hashB) without waiting for another user action.
        for (let attempt = 0; attempt < 150; attempt += 1) {
          const recovered = await page.evaluate((hash) => {
            const selectedHash =
              document.querySelector(".source-option[aria-selected='true']")
                ?.dataset.sourceHash || "";
            const videoSource = document.querySelector("video")?.getAttribute("src") || "";
            return selectedHash === hash && videoSource.includes(hash);
          }, sourceSwitchHashB);
          if (recovered) {
            break;
          }
          await delay(100);
        }
        const restoreState = await page.evaluate(() => ({
          selectedHash:
            document.querySelector(".source-option[aria-selected='true']")
              ?.dataset.sourceHash || "",
          videoSource: document.querySelector("video")?.getAttribute("src") || "",
        }));
        if (
          !sourceSwitchResolveHashes.includes(sourceSwitchHashA) ||
          restoreState.selectedHash !== sourceSwitchHashB ||
          !restoreState.videoSource.includes(sourceSwitchHashB)
        ) {
          throw new Error(
            `${pageSpec.path}\nFailed manual switch should recover to a working source.\n${JSON.stringify({
              sawSourceSwitchResolveHash,
              sourceSwitchResolveHashes,
              restoreState,
            })}`,
          );
        }
      }

      if (pageSpec.expectLiveStreamSwitch) {
        // Live-stream resolution + HLS attach can take several seconds on a
        // loaded machine, so allow generous time for each step. These waits
        // resolve as soon as the condition is met, so they don't slow the happy
        // path — only a genuine failure waits the full timeout.
        const liveStreamWaitMs = 20_000;
        const waitForLiveHlsInput = async (streamId) => {
          const expectedInput = `/${streamId}.m3u8`;
          for (let attempt = 0; attempt < 200; attempt += 1) {
            if (liveStreamHlsInputs.some((input) => input.includes(expectedInput))) {
              return;
            }
            await delay(100);
          }
          throw new Error(
            `${pageSpec.path}\nLive stream did not request the expected HLS input.\n${JSON.stringify({
              expectedInput,
              liveStreamHlsInputs,
            })}`,
          );
        };

        await page.waitForSelector("#toggleLiveStream", {
          state: "visible",
          timeout: liveStreamWaitMs,
        });
        await page.waitForFunction(
          (streamId) => {
            const selected =
              document.querySelector(".live-stream-option[aria-selected='true']")
                ?.dataset.streamId || "";
            const iframeActive =
              document.querySelector("#liveEmbedFrame")?.hidden === false;
            return selected === streamId && !iframeActive;
          },
          liveStreamSwitchStreams[0].id,
          { timeout: liveStreamWaitMs },
        );
        await waitForLiveHlsInput(liveStreamSwitchStreams[0].id);
        await page.click("#toggleLiveStream");
        await page.evaluate((streamId) => {
          document
            .querySelector(`.live-stream-option[data-stream-id="${streamId}"]`)
            ?.click();
        }, liveStreamSwitchStreams[1].id);
        let liveStreamSwitched = false;
        for (let attempt = 0; attempt < 200 && !liveStreamSwitched; attempt += 1) {
          liveStreamSwitched = await page.evaluate((streamId) => {
            const selected =
              document.querySelector(".live-stream-option[aria-selected='true']")
                ?.dataset.streamId || "";
            const iframeActive =
              document.querySelector("#liveEmbedFrame")?.hidden === false;
            const currentStreamId = new URL(window.location.href).searchParams.get(
              "liveStreamId",
            );
            return (
              selected === streamId &&
              currentStreamId === streamId &&
              !iframeActive
            );
          }, liveStreamSwitchStreams[1].id);
          if (liveStreamSwitched) {
            break;
          }
          // Re-assert the selection every ~2s in case the first click landed
          // before the switcher was ready under load.
          if (attempt % 20 === 19) {
            await page.evaluate((streamId) => {
              document
                .querySelector(`.live-stream-option[data-stream-id="${streamId}"]`)
                ?.click();
            }, liveStreamSwitchStreams[1].id);
          }
          await delay(100);
        }
        if (!liveStreamSwitched) {
          const liveSwitchState = await page.evaluate(() => ({
            selected:
              document.querySelector(".live-stream-option[aria-selected='true']")
                ?.dataset.streamId || "",
            iframeActive: document.querySelector("#liveEmbedFrame")?.hidden === false,
            currentStreamId: new URL(window.location.href).searchParams.get(
              "liveStreamId",
            ),
          }));
          throw new Error(
            `${pageSpec.path}\nLive stream switch did not take effect.\n${JSON.stringify(liveSwitchState)}`,
          );
        }
        await waitForLiveHlsInput(liveStreamSwitchStreams[1].id);
        if (!liveStreamResolveSources.includes(liveStreamSwitchStreams[1].source)) {
          throw new Error(
            `${pageSpec.path}\nLive stream switch did not resolve the selected source.\n${JSON.stringify({
              expectedSource: liveStreamSwitchStreams[1].source,
              liveStreamResolveSources,
              liveStreamHlsInputs,
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

      if (pageSpec.expectCanonicalWatchPath) {
        const watchUrlState = await page.evaluate(() => ({
          pathname: window.location.pathname,
          search: window.location.search,
        }));
        if (watchUrlState.pathname !== pageSpec.expectCanonicalWatchPath) {
          throw new Error(
            `${pageSpec.path}\nPlayer should canonicalize to the short watch path.\n${JSON.stringify({
              expected: pageSpec.expectCanonicalWatchPath,
              actual: watchUrlState,
            })}`,
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

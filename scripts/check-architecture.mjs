#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const rootDir = resolve(new URL("..", import.meta.url).pathname);
const maxSourceLines = {
  "src-ui/pages/player.js": 9_300,
  "src-ui/pages/home.jsx": 5_300,
  "src-ui/pages/settings.jsx": 1_600,
};
const defaultPageLineLimit = 1_500;
const backendSourceLineLimits = {
  "src/persistence.rs": 7_050,
  "src/routes.rs": 4_600,
  "src/resolver.rs": 7_400,
  "src/football.rs": 6_500,
};
const workerSourceLineLimit = 250;
const maxJsBundleBytes = 700 * 1024;
const maxCssBundleBytes = 160 * 1024;
const forbiddenFrontendDeps = [
  "@vitejs/plugin-react",
  "next",
  "react",
  "react-dom",
  "vue",
  "svelte",
];

const errors = [];
const notes = [];

async function readText(path) {
  return readFile(join(rootDir, path), "utf8");
}

function fail(message) {
  errors.push(message);
}

function note(message) {
  notes.push(message);
}

function lineCount(text) {
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

function isFrontendSourceModule(name) {
  return name.endsWith(".js") || name.endsWith(".jsx");
}

async function checkPackageShape() {
  const pkg = JSON.parse(await readText("package.json"));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (!deps["solid-js"]) {
    fail("solid-js must remain the frontend runtime dependency.");
  }
  for (const dep of forbiddenFrontendDeps) {
    if (deps[dep]) {
      fail(`Unexpected frontend framework dependency found: ${dep}`);
    }
  }
}

async function checkViteShape() {
  const viteConfig = await readText("vite.config.js");
  if (!/appType:\s*["']mpa["']/.test(viteConfig)) {
    fail("vite.config.js should keep appType: \"mpa\" for route-level bundles.");
  }
  for (const page of [
    "index",
    "login",
    "player",
    "settings",
    "live",
    "sports",
  ]) {
    if (!new RegExp(`${page}:\\s*resolve\\(`).test(viteConfig)) {
      fail(`vite.config.js is missing the ${page} HTML entry.`);
    }
  }
}

async function checkEntrypoints() {
  const entriesDir = join(rootDir, "src-ui/entries");
  const files = (await readdir(entriesDir)).filter((name) => name.endsWith(".js")).sort();
  // Pages reachable while logged out (the login screen, the password-reset
  // link emailed to signed-out users, and the help/legal pages) mount via
  // mountPublicPage.
  const publicPages = new Set([
    "login.js",
    "reset-password.js",
    "help.js",
    "legal.js",
  ]);
  // admin.js needs an *admin* session, not just any authenticated one, so it
  // gates itself against /api/auth/me and redirects rather than using the
  // generic authenticated-page helper.
  const selfGatedPages = new Set(["admin.js"]);
  for (const file of files) {
    const relPath = `src-ui/entries/${file}`;
    const source = await readText(relPath);
    if (publicPages.has(file)) {
      if (!source.includes("mountPublicPage")) {
        fail(`${relPath} should use mountPublicPage.`);
      }
      continue;
    }
    if (selfGatedPages.has(file)) {
      // Still must enforce a session, just through its own admin-aware path.
      if (!source.includes("/api/auth/me")) {
        fail(`${relPath} should gate access against /api/auth/me.`);
      }
      continue;
    }
    if (!source.includes("mountAuthenticatedPage")) {
      fail(`${relPath} should use mountAuthenticatedPage.`);
    }
    if (/requireAuth|hydrateFromServer|mountPage/.test(source)) {
      fail(`${relPath} should delegate auth/hydration/mounting to page-entry.js.`);
    }
  }
}

async function checkSourceSizes() {
  const pagesDir = join(rootDir, "src-ui/pages");
  const files = (await readdir(pagesDir)).filter(isFrontendSourceModule).sort();
  const largest = [];
  for (const file of files) {
    const relPath = `src-ui/pages/${file}`;
    const count = lineCount(await readText(relPath));
    largest.push([relPath, count]);
    const limit = maxSourceLines[relPath] || defaultPageLineLimit;
    if (count > limit) {
      fail(`${relPath} has ${count} nonblank lines, above the ${limit}-line guard.`);
    }
  }
  largest
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .forEach(([relPath, count]) => note(`${relPath}: ${count} nonblank lines`));
}

async function checkDomainDecomposition() {
  for (const [relPath, limit] of Object.entries(backendSourceLineLimits)) {
    const count = lineCount(await readText(relPath));
    if (count > limit) {
      fail(`${relPath} has ${count} nonblank lines, above the ${limit}-line growth guard.`);
    }
  }

  const persistence = await readText("src/persistence.rs");
  for (const moduleName of ["continue_watching", "migrations", "user_state"]) {
    if (!persistence.includes(`mod ${moduleName};`)) {
      fail(`src/persistence.rs must keep the ${moduleName} domain module.`);
    }
  }
  const continueWatchingCount = lineCount(await readText("src/persistence/continue_watching.rs"));
  const continueWatchingLimit = 450;
  if (continueWatchingCount > continueWatchingLimit) {
    fail(`src/persistence/continue_watching.rs has ${continueWatchingCount} nonblank lines, above the ${continueWatchingLimit}-line domain guard.`);
  }
  const football = await readText("src/football.rs");
  if (!football.includes("mod schedule;")) {
    fail("src/football.rs must keep the schedule merge module.");
  }
  const scheduleCount = lineCount(await readText("src/football/schedule.rs"));
  const scheduleLimit = 400;
  if (scheduleCount > scheduleLimit) {
    fail(`src/football/schedule.rs has ${scheduleCount} nonblank lines, above the ${scheduleLimit}-line domain guard.`);
  }
  const routes = await readText("src/routes.rs");
  if (!routes.includes("mod admin;")) {
    fail("src/routes.rs must keep the admin handlers module.");
  }
  const adminCount = lineCount(await readText("src/routes/admin.rs"));
  const adminLimit = 1_000;
  if (adminCount > adminLimit) {
    fail(`src/routes/admin.rs has ${adminCount} nonblank lines, above the ${adminLimit}-line domain guard.`);
  }
  const resolver = await readText("src/resolver.rs");
  if (!resolver.includes("mod scoring;")) {
    fail("src/resolver.rs must keep the scoring domain module.");
  }
  if (!resolver.includes("mod external_embed;")) {
    fail("src/resolver.rs must keep the external embed catalog module.");
  }
  const scoringCount = lineCount(await readText("src/resolver/scoring.rs"));
  const scoringLimit = 1_250;
  if (scoringCount > scoringLimit) {
    fail(`src/resolver/scoring.rs has ${scoringCount} nonblank lines, above the ${scoringLimit}-line domain guard.`);
  }
  const embedCount = lineCount(await readText("src/resolver/external_embed.rs"));
  const embedLimit = 650;
  if (embedCount > embedLimit) {
    fail(`src/resolver/external_embed.rs has ${embedCount} nonblank lines, above the ${embedLimit}-line domain guard.`);
  }
  const liveStreamCacheCount = lineCount(await readText("src-ui/player/live-stream-cache.js"));
  const liveStreamCacheLimit = 650;
  if (liveStreamCacheCount > liveStreamCacheLimit) {
    fail(`src-ui/player/live-stream-cache.js has ${liveStreamCacheCount} nonblank lines, above the ${liveStreamCacheLimit}-line domain guard.`);
  }
  const customSubtitleCount = lineCount(await readText("src-ui/player/custom-subtitle-overlay.js"));
  const customSubtitleLimit = 300;
  if (customSubtitleCount > customSubtitleLimit) {
    fail(`src-ui/player/custom-subtitle-overlay.js has ${customSubtitleCount} nonblank lines, above the ${customSubtitleLimit}-line domain guard.`);
  }
  const liveHealthCount = lineCount(await readText("src-ui/player/live-playback-health.js"));
  const liveHealthLimit = 350;
  if (liveHealthCount > liveHealthLimit) {
    fail(`src-ui/player/live-playback-health.js has ${liveHealthCount} nonblank lines, above the ${liveHealthLimit}-line domain guard.`);
  }
  const liveSeekCount = lineCount(await readText("src-ui/player/live-seek.js"));
  const liveSeekLimit = 150;
  if (liveSeekCount > liveSeekLimit) {
    fail(`src-ui/player/live-seek.js has ${liveSeekCount} nonblank lines, above the ${liveSeekLimit}-line domain guard.`);
  }
  const subtitlePlacementCount = lineCount(await readText("src-ui/player/subtitle-placement.js"));
  const subtitlePlacementLimit = 150;
  if (subtitlePlacementCount > subtitlePlacementLimit) {
    fail(`src-ui/player/subtitle-placement.js has ${subtitlePlacementCount} nonblank lines, above the ${subtitlePlacementLimit}-line domain guard.`);
  }
  const featuredHeroCount = lineCount(await readText("src-ui/lib/featured-hero.js"));
  const featuredHeroLimit = 450;
  if (featuredHeroCount > featuredHeroLimit) {
    fail(`src-ui/lib/featured-hero.js has ${featuredHeroCount} nonblank lines, above the ${featuredHeroLimit}-line domain guard.`);
  }
  const player = await readText("src-ui/pages/player.js");
  for (const symbol of [
    "createResolverOverlayController",
    "playback-preferences.js",
    "continue-watching-pin.js",
    "createLiveStreamCache",
    "createCustomSubtitleOverlay",
    "createLivePlaybackHealthWatch",
    "createSourceDownloadController",
    "live-seek.js",
    "subtitle-placement.js",
  ]) {
    if (!player.includes(symbol)) {
      fail(`src-ui/pages/player.js must keep the extracted ${symbol} seam.`);
    }
  }
  const home = await readText("src-ui/pages/home.jsx");
  for (const symbol of ["selectFeaturedHeroCandidate", "buildFeaturedHeroCandidates"]) {
    if (!home.includes(symbol)) {
      fail(`src-ui/pages/home.jsx must keep the extracted ${symbol} seam.`);
    }
  }
  const main = await readText("src/main.rs");
  for (const moduleName of ["cleanup_guard", "egress_policy", "provider_budget", "key_lock"]) {
    if (!main.includes(`mod ${moduleName};`)) {
      fail(`src/main.rs must keep the ${moduleName} trust-boundary module.`);
    }
    const relPath = `src/${moduleName}.rs`;
    const count = lineCount(await readText(relPath));
    const limit = moduleName === "key_lock" ? 80 : 250;
    if (count > limit) {
      fail(`${relPath} has ${count} nonblank lines, above the ${limit}-line domain guard.`);
    }
  }
  const webLiveChannels = await readText("src-ui/lib/live-channels.js");
  if (!webLiveChannels.includes("shared/live-channels.json")) {
    fail("src-ui/lib/live-channels.js must load the shared live catalog.");
  }
  const mobileLiveChannels = await readText("mobile/src/lib/live-channels.ts");
  if (!mobileLiveChannels.includes("streamarena-shared/live-channels.json")) {
    fail("mobile/src/lib/live-channels.ts must load the shared live catalog.");
  }
  if (!mobileLiveChannels.includes("loadLiveChannelOverrides")) {
    fail("mobile/src/lib/live-channels.ts must apply runtime channel overrides.");
  }
  const replaySafeClient = await readText("src-ui/lib/replay-safe-state.js");
  if (!replaySafeClient.includes("nextUserStateMutationTimestamp")) {
    fail("Frontend durable-state transport lost its monotonic mutation clock.");
  }
  for (const relPath of ["src-ui/pages/player.js", "src-ui/lib/continue-watching.js"]) {
    if (!(await readText(relPath)).includes("replaySafeMutationBody")) {
      fail(`${relPath} must use the shared replay-safe mutation boundary.`);
    }
  }

  const workerDir = join(rootDir, "workers/live-hls-proxy/src");
  const workerFiles = (await readdir(workerDir)).filter((name) => name.endsWith(".js")).sort();
  for (const file of workerFiles) {
    const relPath = `workers/live-hls-proxy/src/${file}`;
    const count = lineCount(await readText(relPath));
    if (count > workerSourceLineLimit) {
      fail(`${relPath} has ${count} nonblank lines, above the ${workerSourceLineLimit}-line Worker domain guard.`);
    }
  }
  const workerIndex = await readText("workers/live-hls-proxy/src/index.js");
  if (lineCount(workerIndex) > 80) {
    fail("The live-HLS Worker entrypoint must remain route dispatch only.");
  }
  for (const boundary of ["authorization", "origin", "playlist", "resource"]) {
    if (!workerFiles.includes(`${boundary}.js`)) {
      fail(`The live-HLS Worker is missing its ${boundary} trust-boundary module.`);
    }
  }
}

async function checkBuiltBundles() {
  const assetsDir = join(rootDir, "dist/ui-assets");
  try {
    await stat(assetsDir);
  } catch {
    note("dist/ui-assets is missing; run bun run build before checking bundle sizes.");
    return;
  }

  const files = (await readdir(assetsDir)).filter(
    (name) => name.endsWith(".js") || name.endsWith(".css"),
  );
  const largest = [];
  for (const file of files) {
    const fileStat = await stat(join(assetsDir, file));
    largest.push([file, fileStat.size]);
    if (file.endsWith(".js") && fileStat.size > maxJsBundleBytes) {
      fail(`${file} is ${(fileStat.size / 1024).toFixed(1)} KiB, above the JS bundle guard.`);
    }
    if (file.endsWith(".css") && fileStat.size > maxCssBundleBytes) {
      fail(`${file} is ${(fileStat.size / 1024).toFixed(1)} KiB, above the CSS bundle guard.`);
    }
  }
  largest
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .forEach(([file, bytes]) => note(`${basename(file)}: ${(bytes / 1024).toFixed(1)} KiB`));
}

await checkPackageShape();
await checkViteShape();
await checkEntrypoints();
await checkSourceSizes();
await checkDomainDecomposition();
await checkBuiltBundles();

if (notes.length > 0) {
  console.log("Architecture notes:");
  for (const entry of notes) {
    console.log(`- ${entry}`);
  }
}

if (errors.length > 0) {
  console.error("\nArchitecture check failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("\nArchitecture check passed.");

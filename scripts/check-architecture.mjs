#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const rootDir = resolve(new URL("..", import.meta.url).pathname);
const maxSourceLines = {
  "src-ui/pages/player.js": 10_800,
  "src-ui/pages/home.jsx": 5_450,
  "src-ui/pages/settings.jsx": 1_600,
};
const defaultPageLineLimit = 1_500;
const backendSourceLineLimits = {
  "src/persistence.rs": 7_350,
  "src/routes.rs": 5_450,
  "src/resolver.rs": 11_500,
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
  for (const moduleName of ["migrations", "user_state"]) {
    if (!persistence.includes(`mod ${moduleName};`)) {
      fail(`src/persistence.rs must keep the ${moduleName} domain module.`);
    }
  }
  const main = await readText("src/main.rs");
  for (const moduleName of ["cleanup_guard", "egress_policy", "provider_budget"]) {
    if (!main.includes(`mod ${moduleName};`)) {
      fail(`src/main.rs must keep the ${moduleName} trust-boundary module.`);
    }
    const relPath = `src/${moduleName}.rs`;
    const count = lineCount(await readText(relPath));
    if (count > 250) {
      fail(`${relPath} has ${count} nonblank lines, above the 250-line domain guard.`);
    }
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

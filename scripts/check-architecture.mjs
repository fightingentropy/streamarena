#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const rootDir = resolve(new URL("..", import.meta.url).pathname);
const maxSourceLines = {
  "src-ui/pages/player.js": 10_000,
  "src-ui/pages/home.js": 6_000,
  "src-ui/pages/upload.js": 1_600,
  "src-ui/pages/settings.js": 1_600,
};
const defaultPageLineLimit = 1_500;
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
  return text.split("\n").length;
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
  for (const page of ["index", "login", "player", "settings", "upload", "live", "football"]) {
    if (!new RegExp(`${page}:\\s*resolve\\(`).test(viteConfig)) {
      fail(`vite.config.js is missing the ${page} HTML entry.`);
    }
  }
}

async function checkEntrypoints() {
  const entriesDir = join(rootDir, "src-ui/entries");
  const files = (await readdir(entriesDir)).filter((name) => name.endsWith(".js")).sort();
  for (const file of files) {
    const relPath = `src-ui/entries/${file}`;
    const source = await readText(relPath);
    if (file === "login.js") {
      if (!source.includes("mountPublicPage")) {
        fail(`${relPath} should use mountPublicPage.`);
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
  const files = (await readdir(pagesDir)).filter((name) => name.endsWith(".js")).sort();
  const largest = [];
  for (const file of files) {
    const relPath = `src-ui/pages/${file}`;
    const count = lineCount(await readText(relPath));
    largest.push([relPath, count]);
    const limit = maxSourceLines[relPath] || defaultPageLineLimit;
    if (count > limit) {
      fail(`${relPath} has ${count} lines, above the ${limit}-line guard.`);
    }
  }
  largest
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .forEach(([relPath, count]) => note(`${relPath}: ${count} lines`));
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

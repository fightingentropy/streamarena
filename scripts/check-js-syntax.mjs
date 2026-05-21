#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const rootDir = resolve(new URL("..", import.meta.url).pathname);
const checkDirs = ["src-ui", "scripts"];
const checkFiles = ["vite.config.js"];

async function collectJsFiles(dir) {
  const output = [];
  const entries = await readdir(join(rootDir, dir), { withFileTypes: true });
  for (const entry of entries) {
    const relPath = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      output.push(...await collectJsFiles(relPath));
    } else if (/\.[cm]?js$/.test(entry.name)) {
      output.push(relPath);
    }
  }
  return output;
}

function checkFile(relPath) {
  return new Promise((resolveCheck) => {
    const child = spawn(process.execPath, ["--check", relPath], {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("close", (code) => {
      resolveCheck({ relPath, code, output });
    });
  });
}

const files = [
  ...checkFiles,
  ...(await Promise.all(checkDirs.map(collectJsFiles))).flat(),
].sort();

const failures = [];
for (const file of files) {
  const result = await checkFile(file);
  if (result.code !== 0) {
    failures.push(result);
  }
}

if (failures.length > 0) {
  console.error("Frontend syntax check failed:");
  for (const failure of failures) {
    console.error(`\n${failure.relPath}`);
    console.error(failure.output.trim());
  }
  process.exit(1);
}

console.log(`Frontend syntax check passed (${files.length} files).`);

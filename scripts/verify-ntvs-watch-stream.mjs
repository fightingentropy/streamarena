#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const matchSlug = process.env.NTVS_VERIFY_MATCH || "croatia-vs-slovenia-2423014";
const watchUrl = `https://ntv.cx/watch/kobra/${matchSlug}`;
const fetchWatchUrl = `https://ntvs.cx/watch/kobra/${matchSlug}`;
const proxy = String(process.env.SPORTS_HTTP_PROXY || process.env.OUTBOUND_HTTP_PROXY || "").trim();
const nodeBin = process.env.NODE_BIN || "node";
const resolverScript = [
  process.env.NTVS_HLS_RESOLVER_SCRIPT,
  join(rootDir, "bin/resolve-ntvs-hls.mjs"),
  join(rootDir, "scripts/resolve-ntvs-hls.mjs"),
]
  .map((value) => String(value || "").trim())
  .find((value) => value && existsSync(value));

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`PASS: ${message}`);
}

async function fetchText(url, referer = "https://ntvs.cx/") {
  if (proxy) {
    const result = spawnSync(
      "curl",
      [
        "-sS",
        "--proxy",
        proxy,
        "--max-time",
        "20",
        "-A",
        "Mozilla/5.0",
        "-H",
        `Referer: ${referer}`,
        "-w",
        "\n__HTTP_STATUS__:%{http_code}",
        url,
      ],
      { encoding: "utf8" },
    );
    const combined = String(result.stdout || "");
    const marker = combined.lastIndexOf("\n__HTTP_STATUS__:");
    const text = marker >= 0 ? combined.slice(0, marker) : combined;
    const status = Number(
      (marker >= 0 ? combined.slice(marker + "\n__HTTP_STATUS__:".length) : "0").trim(),
    );
    return { status: Number.isFinite(status) ? status : 0, text };
  }

  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Referer: referer,
    },
    redirect: "follow",
  });
  const text = await response.text();
  return { status: response.status, text };
}

function extractWrapperEmbedUrls(html, baseUrl) {
  const values = [];
  const patterns = [
    /\/embed\?t=[^"'`\s>]+/gi,
    /<option[^>]*value=["']([^"']*\/embed\?t=[^"']+)["']/gi,
    /<iframe[^>]*src=["']([^"']*\/embed\?t=[^"']+)["']/gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const raw = (match[1] || match[0] || "").replace(/&quot;/g, '"').trim();
      if (!raw) continue;
      try {
        values.push(new URL(raw, baseUrl).toString());
      } catch {
        // Ignore malformed candidates.
      }
    }
  }
  return [...new Set(values)];
}

function extractEmbedStUrls(html) {
  const values = [];
  for (const match of html.matchAll(/https?:\/\/embed\.st\/embed\/[^"'`\s>]+/gi)) {
    values.push(match[0].trim());
  }
  return [...new Set(values)];
}

function resolveHls(embedUrl) {
  const env = {
    ...process.env,
    ...(proxy ? { SPORTS_HTTP_PROXY: proxy, NTVS_EMBED_BROWSER_PROXY: proxy } : {}),
  };
  const result = spawnSync(nodeBin, [resolverScript, embedUrl], {
    cwd: rootDir,
    env,
    encoding: "utf8",
    timeout: 45000,
  });
  if (result.status !== 0) {
    return {
      ok: false,
      error: (result.stderr || result.stdout || "resolver failed").trim(),
    };
  }
  try {
    return { ok: true, payload: JSON.parse(result.stdout.trim()) };
  } catch (error) {
    return { ok: false, error: error?.message || "invalid resolver JSON" };
  }
}

if (!resolverScript) {
  fail("NTVS HLS resolver script not found.");
}

console.log(`Verifying ${watchUrl}`);
if (proxy) {
  console.log(`Using proxy: ${proxy}`);
}

const watchPage = await fetchText(fetchWatchUrl);
if (watchPage.status !== 200) {
  fail(`watch page returned HTTP ${watchPage.status}`);
}
pass(`watch page fetched (${watchPage.text.length} bytes)`);

const wrapperEmbeds = extractWrapperEmbedUrls(watchPage.text, fetchWatchUrl);
if (!wrapperEmbeds.length) {
  fail("watch page did not expose wrapper embed URLs");
}
pass(`found ${wrapperEmbeds.length} wrapper embed candidate(s)`);

let embedStCandidates = [];
for (const wrapperUrl of wrapperEmbeds.slice(0, 3)) {
  const wrapperPage = await fetchText(wrapperUrl, wrapperUrl);
  if (wrapperPage.status !== 200) {
    continue;
  }
  embedStCandidates.push(...extractEmbedStUrls(wrapperPage.text));
}
embedStCandidates = [...new Set(embedStCandidates)];
if (!embedStCandidates.length) {
  fail("wrapper embed pages did not expose embed.st player URLs");
}
pass(`found ${embedStCandidates.length} embed.st candidate(s)`);

const adminCandidate =
  embedStCandidates.find((url) => url.includes("/embed/admin/")) || embedStCandidates[0];
const deltaCandidate = embedStCandidates.find((url) => url.includes("/embed/delta/")) || null;

const adminResolved = resolveHls(adminCandidate);
if (!adminResolved.ok) {
  fail(`admin embed failed to resolve: ${adminResolved.error}`);
}
pass(`admin embed resolved to HLS (${adminResolved.payload.playbackUrl})`);

if (deltaCandidate) {
  const deltaResolved = resolveHls(deltaCandidate);
  if (deltaResolved.ok) {
    console.log(`NOTE: delta embed also resolved (${deltaResolved.payload.playbackUrl})`);
  } else {
    console.log(`NOTE: delta embed failed as expected (${deltaResolved.error.split("\n")[0]})`);
  }
}

console.log(
  JSON.stringify(
    {
      watchUrl,
      wrapperEmbeds: wrapperEmbeds.slice(0, 3),
      adminEmbed: adminCandidate,
      deltaEmbed: deltaCandidate,
      resolvedPlaybackUrl: adminResolved.payload.playbackUrl,
      resolvedReferer: adminResolved.payload.referer,
    },
    null,
    2,
  ),
);

pass("Croatia vs Slovenia NTVS watch-page resolution chain is working on this host.");

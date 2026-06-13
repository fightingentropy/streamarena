#!/usr/bin/env node
// Fleet classifier: for each provider we currently resolve with a headless
// Chromium subprocess, can we instead resolve to the final HLS playlist with an
// (impersonated) HTTP client ALONE — i.e. WITHOUT a browser?
//
// It fetches the provider's entry page with a real Chrome TLS/HTTP2 fingerprint
// (curl-impersonate when available, else Node fetch), dumps the page's inline
// resolve mechanism (inline scripts, API endpoints, encoded blobs), attempts the
// full HTTP-only resolve, and VALIDATES the resulting .m3u8. Per-provider verdict
// tells you whether that browser hop is replaceable.
//
// Providers (mirrors scripts/resolve-*.mjs + live.rs browser fetch):
//   ntvs        embed.st/embed/...          -> strmd.st       (navigate+wait)
//   streamed    embedsports.top/embed/...   -> strmd.top      (navigate+wait)
//   videasy     player.videasy.to/movie|tv  -> HLS  [VOD]     (navigate+wait)
//   vidlink     vidlink.pro/movie|tv        -> API  [VOD]     (already native/WASM)
//   matchstream <chan>/ch?id=...            -> zohanayaan...  (multi-hop iframes)
//
// Usage:
//   node scripts/probe-embed-resolve.mjs <entry-url>          # auto-detect provider
//   node scripts/probe-embed-resolve.mjs --provider videasy   # use the provider's VOD sample
//   node scripts/probe-embed-resolve.mjs --provider ntvs --discover   # find a live event
//   node scripts/probe-embed-resolve.mjs --all                # sweep every provider, summary table
//
// Env: PROBE_TIMEOUT_MS (default 20000), PROBE_CURL (override impersonate binary)
//
// Run from a network that can reach these hosts (the prod mini, or anywhere they
// resolve). The streamed live discovery also needs the streamed.su API tier up.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 20000);
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// HTTP engine: prefer curl-impersonate (true browser fingerprint), else fetch.
// ---------------------------------------------------------------------------
function detectCurl() {
  return [
    process.env.PROBE_CURL,
    "/opt/homebrew/bin/curl_chrome116", "/opt/homebrew/bin/curl_chrome110",
    "/opt/homebrew/bin/curl-impersonate-chrome",
    "/usr/local/bin/curl_chrome116", "/usr/local/bin/curl-impersonate-chrome",
  ].filter(Boolean).find((p) => existsSync(p)) || null;
}
const CURL = detectCurl();
let tmpSeq = 0;

async function httpGet(url, { referer = "", accept = "text/html,application/xhtml+xml,application/json,*/*" } = {}) {
  if (CURL) {
    const tmp = join(tmpdir(), `probe-${process.pid}-${tmpSeq++}.bin`);
    const args = ["-sS", "-L", "-m", String(Math.ceil(TIMEOUT_MS / 1000)), "-o", tmp,
      "-w", "%{http_code}\t%{content_type}\t%{url_effective}", "-H", `Accept: ${accept}`];
    if (referer) args.push("-e", referer);
    args.push(url);
    const r = spawnSync(CURL, args, { encoding: "utf8", maxBuffer: 1 << 27 });
    let body = ""; try { body = readFileSync(tmp, "utf8"); } catch {}
    try { unlinkSync(tmp); } catch {}
    if (r.status !== 0 && !body) return { status: 0, ctype: "", finalUrl: url, body: "", err: (r.stderr || "").trim() || `curl exit ${r.status}` };
    const [status = "0", ctype = "", finalUrl = url] = String(r.stdout || "").trim().split("\t");
    return { status: Number(status), ctype, finalUrl, body };
  }
  try {
    const res = await fetch(url, {
      redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": CHROME_UA, Accept: accept, "Accept-Language": "en-US,en;q=0.9", ...(referer ? { Referer: referer } : {}) },
    });
    return { status: res.status, ctype: res.headers.get("content-type") || "", finalUrl: res.url, body: await res.text() };
  } catch (e) { return { status: 0, ctype: "", finalUrl: url, body: "", err: e.cause?.code || e.name || e.message }; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const uniq = (a) => [...new Set(a)];
const abs = (u, base) => { try { return new URL(u, base).href; } catch { return null; } };
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
const isM3u8 = (u) => /\.m3u8(\?|$)/i.test(u);

function decodeMaybeBase64(s) {
  try {
    const d = Buffer.from(s, "base64").toString("utf8");
    const printable = d.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "").length / Math.max(1, d.length);
    if (printable > 0.9 && /(https?:|strmd|\.m3u8|playlist|"file"|"source"|\{)/i.test(d)) return d;
  } catch {}
  return null;
}

function harvestM3u8FromJson(value, out = []) {
  if (value == null) return out;
  if (typeof value === "string") { if (isM3u8(value)) out.push(value); return out; }
  if (typeof value === "object") { Object.values(value).forEach((v) => harvestM3u8FromJson(v, out)); return out; }
  return out;
}

// Pull every interesting signal out of an embed/player HTML + its inline scripts.
function dissect(html) {
  const inlineScripts = [], externalScripts = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = (m[1] || "").match(/\bsrc=["']([^"']+)["']/i);
    if (src) externalScripts.push(src[1]); else if (m[2].trim()) inlineScripts.push(m[2].trim());
  }
  const blob = html + "\n" + inlineScripts.join("\n");
  const directM3u8 = uniq([...blob.matchAll(/https?:\/\/[^\s"'`<>()]+?\.m3u8[^\s"'`<>()]*/gi)].map((x) => x[0]));
  const endpoints = uniq([
    ...[...blob.matchAll(/\bfetch\s*\(\s*[`"']([^`"']+)[`"']/gi)].map((x) => x[1]),
    ...[...blob.matchAll(/\.open\s*\(\s*["'][A-Z]+["']\s*,\s*[`"']([^`"']+)[`"']/gi)].map((x) => x[1]),
    ...[...blob.matchAll(/\baxios(?:\.\w+)?\s*\(\s*[`"']([^`"']+)[`"']/gi)].map((x) => x[1]),
    ...[...blob.matchAll(/["'`](\/(?:api|fetch|sources?|stream|getstream|playlist|hls|e|p)\/[^"'`]*)["'`]/gi)].map((x) => x[1]),
    ...[...blob.matchAll(/https?:\/\/[a-z0-9.-]+\/(?:api|fetch|sources?|stream|getstream|playlist)\/[^\s"'`<>()]+/gi)].map((x) => x[0]),
  ]).filter((u) => !isM3u8(u));
  const templateFetches = uniq([...blob.matchAll(/\bfetch\s*\(\s*`([^`]*\$\{[^`]*)`/gi)].map((x) => x[1]));
  const blobs = [];
  for (const m of blob.matchAll(/["'`]([A-Za-z0-9+/]{40,}={0,2})["'`]/g)) { const d = decodeMaybeBase64(m[1]); if (d) blobs.push({ raw: m[1].slice(0, 44) + "…", decoded: d }); }
  const markers = ["atob(", "decodeURIComponent(", "fromCharCode", "unescape(", "JSON.parse(", "CryptoJS", "btoa(", "WebAssembly", "wasm"].filter((k) => blob.includes(k));
  const evalCalls = uniq([...blob.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*\(/g)].map((x) => x[1])).filter((n) => /load|player|stream|get|adv|play|init/i.test(n));
  return { inlineScripts, externalScripts, directM3u8, endpoints, templateFetches, blobs, markers, evalCalls };
}

async function validateM3u8(url, refererCandidates) {
  for (const referer of refererCandidates) {
    const r = await httpGet(url, { referer, accept: "application/vnd.apple.mpegurl,application/x-mpegURL,*/*" });
    if (r.status === 200 && /#EXTM3U/.test(r.body)) {
      const isMaster = /#EXT-X-STREAM-INF/i.test(r.body);
      let variant = null;
      if (isMaster) {
        const v = r.body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#"));
        if (v) { const vu = abs(v.trim(), url); const vr = await httpGet(vu, { referer, accept: "*/*" }); variant = { ok: vr.status === 200 && /#EXTM3U/.test(vr.body), status: vr.status }; }
      }
      return { ok: true, referer, kind: isMaster ? "master" : "media", variant, head: r.body.split(/\r?\n/).slice(0, 4).join(" | ") };
    }
  }
  return { ok: false };
}

// ---------------------------------------------------------------------------
// Provider registry — one entry per resolve-*.mjs / browser path.
// ---------------------------------------------------------------------------
const STREAMED_MIRRORS = ["https://streamed.su", "https://streamed.pk", "https://streamed.st", "https://streami.su"];

async function discoverStreamedEntry(embedHostRe) {
  for (const base of STREAMED_MIRRORS) {
    const live = await httpGet(`${base}/api/matches/live`, { referer: base + "/" });
    let matches = null; try { matches = JSON.parse(live.body); } catch {}
    if (!Array.isArray(matches) || !matches.length) { console.log(`    ${base}: ${live.err ? "ERR " + live.err : "HTTP " + live.status + " (no live array)"}`); continue; }
    console.log(`    ${base}: ${matches.length} live matches`);
    for (const match of matches) for (const src of match.sources || []) {
      const s = await httpGet(`${base}/api/stream/${src.source}/${src.id}`, { referer: base + "/" });
      let streams = null; try { streams = JSON.parse(s.body); } catch {}
      const embed = (Array.isArray(streams) ? streams : []).map((x) => x.embedUrl).find((u) => u && embedHostRe.test(hostOf(u)));
      if (embed) { console.log(`    picked "${match.title}" -> ${embed}`); return embed; }
    }
  }
  return null;
}

const PROVIDERS = {
  ntvs: {
    kind: "navigate+wait", live: true,
    note: "embed.st → strmd.st. m3u8 computed by page JS after a click; no in-page eval by our script.",
    matchEntry: (u) => /^https?:\/\/(www\.)?embed\.st\/embed\//i.test(u),
    hlsHost: (h) => /(^|\.)strmd\.st$/i.test(h),
    referers: (e) => uniq([e, "https://embed.st/"]),
    discover: () => discoverStreamedEntry(/(^|\.)embed\.st$/i),
    watchScrape: /https?:\/\/(?:www\.)?embed\.st\/embed\/[^\s"'`<>()]+/i,
  },
  streamed: {
    kind: "navigate+wait", live: true,
    note: "embedsports.top → strmd.top. Mechanically identical to ntvs.",
    matchEntry: (u) => /^https?:\/\/(www\.)?embedsports\.top\/embed\//i.test(u),
    hlsHost: (h) => /(^|\.)strmd\.top$/i.test(h),
    referers: (e) => uniq([e, "https://embedsports.top/"]),
    discover: () => discoverStreamedEntry(/(^|\.)embedsports\.top$/i),
    watchScrape: /https?:\/\/(?:www\.)?embedsports\.top\/embed\/[^\s"'`<>()]+/i,
  },
  videasy: {
    kind: "navigate+wait (VOD)", live: false,
    note: "player.videasy.net/.to /movie|/tv → HLS. VOD ⇒ testable now (no live event needed).",
    matchEntry: (u) => /^https?:\/\/player\.videasy\.(net|to)\/(movie|tv)\//i.test(u),
    hlsHost: () => true,
    referers: (e) => uniq([e, "https://player.videasy.net/"]),
    sample: "https://player.videasy.to/movie/27205", // Inception
  },
  vidlink: {
    kind: "native/WASM (VOD)", live: false, alreadyNative: true,
    note: "vidlink.pro /movie|/tv. Token via getAdv() WASM, then /api/b/... ALREADY browserless in resolve-external-embed-hls.mjs.",
    matchEntry: (u) => /^https?:\/\/vidlink\.pro\/(movie|tv)\//i.test(u),
    hlsHost: () => true,
    referers: (e) => uniq([e, "https://vidlink.pro/"]),
    sample: "https://vidlink.pro/movie/27205",
    assets: ["https://vidlink.pro/script.js", "https://vidlink.pro/fu.wasm"], // native-path deps
  },
  matchstream: {
    kind: "multi-hop iframe", live: true, hard: true,
    note: "channel /ch?id= → helpless.click/brightcoremind players → zohanayaan.com/28585519.net. Uses window.loadPlayerChannel + ad bootstrap. Hardest to de-browser.",
    matchEntry: (u) => /\/ch\?[^#]*\bid=/i.test(u),
    hlsHost: (h) => /(^|\.)(zohanayaan\.com|28585519\.net)$/i.test(h),
    referers: (e) => uniq([e]),
  },
};

function detectProvider(url) {
  return Object.entries(PROVIDERS).find(([, p]) => p.matchEntry(url))?.[0] || null;
}

async function resolveEntry(name, p, arg) {
  if (arg && p.matchEntry(arg)) return arg;
  if (arg && /^https?:\/\//.test(arg) && p.watchScrape) {
    console.log(`  [watch] scraping ${arg} for a ${name} entry…`);
    const r = await httpGet(arg, { referer: new URL(arg).origin + "/" });
    const hit = r.body.match(new RegExp(p.watchScrape.source, "i"));
    console.log(`    -> ${hit ? hit[0] : "none (HTTP " + r.status + (r.err ? " " + r.err : "") + ")"}`);
    return hit ? hit[0] : null;
  }
  if (process.argv.includes("--discover") && p.discover) { console.log(`  [discover] searching for a live ${name} event…`); return p.discover(); }
  if (p.sample) { console.log(`  [sample] using VOD sample ${p.sample}`); return p.sample; }
  return null;
}

// ---------------------------------------------------------------------------
// Run one provider end-to-end -> verdict
// ---------------------------------------------------------------------------
function line(c = "─") { return c.repeat(72); }

async function runProvider(name, arg) {
  const p = PROVIDERS[name];
  console.log(`\n${line("━")}\n▌ ${name.toUpperCase()}  (${p.kind})${p.hard ? "  ⚠ hard" : ""}${p.alreadyNative ? "  ✓ already native" : ""}\n▌ ${p.note}\n${line("━")}`);

  const entry = await resolveEntry(name, p, arg);
  if (!entry) { console.log("  no entry URL (host down / not live / no sample). SKIP."); return { name, verdict: "no-entry" }; }

  // VidLink: the native path's health is just "are its token assets reachable?"
  if (p.assets) {
    let ok = true;
    for (const a of p.assets) { const r = await httpGet(a, { referer: "https://vidlink.pro/" }); console.log(`  asset ${a} -> HTTP ${r.status} ${r.body.length || 0}B ${r.err || ""}`); if (r.status !== 200) ok = false; }
    console.log(ok ? "  ✓ native WASM token assets reachable — browserless path viable." : "  ✗ token assets unreachable right now.");
  }

  const page = await httpGet(entry, { referer: p.referers(entry)[1] || entry });
  console.log(`  entry: HTTP ${page.status} ${page.ctype} ${page.body.length}B ${page.err || ""}`);
  if (page.status !== 200 || !page.body) return { name, verdict: "unreachable", entry };

  const challenge = /just a moment|cf-mitigated|challenge-platform|cdn-cgi\/challenge/i.test(page.body);
  const placeholder = page.body.length < 1400 && !/strmd|\.m3u8/i.test(page.body);
  const d = dissect(page.body);
  console.log(`  ext scripts : ${d.externalScripts.join("  ") || "(none)"}`);
  console.log(`  inline      : ${d.inlineScripts.length}`);
  d.inlineScripts.forEach((s, i) => console.log(`    [${i}] ${s.replace(/\s+/g, " ").slice(0, 280)}${s.length > 280 ? " …" : ""}`));
  if (d.endpoints.length) console.log(`  endpoints   :\n    - ${d.endpoints.join("\n    - ")}`);
  if (d.templateFetches.length) console.log(`  tmpl fetch  :\n    - ${d.templateFetches.join("\n    - ")}`);
  if (d.evalCalls.length) console.log(`  window.fns  : ${d.evalCalls.join(", ")}`);
  if (d.blobs.length) { console.log(`  b64 blobs   :`); d.blobs.slice(0, 4).forEach((b) => console.log(`    - ${b.raw} -> ${b.decoded.replace(/\s+/g, " ").slice(0, 140)}`)); }
  console.log(`  markers     : ${d.markers.join(", ") || "(none)"}`);
  if (challenge) console.log("  ⚠ Cloudflare challenge page.");
  if (placeholder) console.log("  ⚠ empty placeholder shell — event not live?");

  // HTTP-only resolve attempt.
  const refs = p.referers(entry);
  const cands = new Set(d.directM3u8.map((u) => abs(u, entry)));
  for (const ep of d.endpoints) {
    const epUrl = abs(ep, entry); if (!epUrl || ep.includes("${")) continue;
    const r = await httpGet(epUrl, { referer: entry, accept: "application/json,*/*" });
    let parsed = null; try { parsed = JSON.parse(r.body); } catch {}
    const hits = parsed ? harvestM3u8FromJson(parsed) : uniq([...r.body.matchAll(/https?:\/\/[^\s"'`<>()]+?\.m3u8[^\s"'`<>()]*/gi)].map((x) => x[0]));
    console.log(`  GET ${epUrl} -> HTTP ${r.status} ${r.body.length || 0}B ${r.err || ""} | m3u8 hits: ${hits.length}`);
    hits.forEach((h) => cands.add(abs(h, epUrl)));
  }
  for (const b of d.blobs) for (const h of uniq([...b.decoded.matchAll(/https?:\/\/[^\s"'`<>()]+?\.m3u8[^\s"'`<>()]*/gi)].map((x) => x[0]))) cands.add(h);

  const candidates = [...cands].filter(Boolean);
  let validated = null;
  for (const c of candidates) { const v = await validateM3u8(c, refs); console.log(`  validate ${c} -> ${v.ok ? `✅ ${v.kind} (referer=${v.referer})` : "❌"}`); if (v.ok) { validated = { url: c, ...v }; break; } }

  // Verdict
  let verdict;
  if (validated) verdict = "REPLACEABLE";
  else if (p.alreadyNative) verdict = "already-native";
  else if (placeholder) verdict = "inconclusive (not live)";
  else if (challenge) verdict = "anti-bot gate";
  else if (d.markers.length || d.templateFetches.length || d.evalCalls.length) verdict = "needs JS port";
  else verdict = "no source via HTTP";
  console.log(`  ── verdict: ${verdict}${validated ? `  (${validated.url})` : ""}`);
  return { name, verdict, entry, validated: validated?.url || null };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
console.log(`HTTP engine : ${CURL ? `curl-impersonate (${CURL})` : "node fetch (NO browser TLS fingerprint)"}`);

const urlArg = args.find((a) => /^https?:\/\//.test(a));
const provFlagIdx = args.indexOf("--provider");
const provFlag = provFlagIdx >= 0 ? args[provFlagIdx + 1] : null;

let results = [];
if (args.includes("--all")) {
  for (const name of Object.keys(PROVIDERS)) results.push(await runProvider(name, null));
} else if (provFlag) {
  if (!PROVIDERS[provFlag]) { console.log(`Unknown provider "${provFlag}". Known: ${Object.keys(PROVIDERS).join(", ")}`); process.exit(2); }
  results.push(await runProvider(provFlag, urlArg || null));
} else if (urlArg) {
  const name = detectProvider(urlArg);
  if (!name) { console.log(`No provider matched ${urlArg}. Known: ${Object.keys(PROVIDERS).join(", ")} (or pass --provider <name>).`); process.exit(2); }
  results.push(await runProvider(name, urlArg));
} else {
  console.log(`\nUsage:\n  node scripts/probe-embed-resolve.mjs <entry-url>\n  node scripts/probe-embed-resolve.mjs --provider <${Object.keys(PROVIDERS).join("|")}> [--discover]\n  node scripts/probe-embed-resolve.mjs --all`);
  process.exit(2);
}

console.log(`\n${line("━")}\nSUMMARY\n${line("━")}`);
for (const r of results) console.log(`  ${r.name.padEnd(12)} ${r.verdict}`);
console.log("");

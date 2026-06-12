// Live HLS proxy on Cloudflare Workers.
//
// Two jobs:
//
// 1. Segment offload (the original job): fetch live HLS segments/keys from
//    upstream embeds and relay them to viewers, so the bandwidth-heavy bytes
//    serve from Cloudflare's network + edge cache instead of the Mac mini's
//    home uplink. The mini rewrites *segment* URLs to point here for
//    browser-safe streams; many viewers then collapse to ~1 upstream fetch per
//    segment instead of N fetches through the home uplink.
//
// 2. Playlist fronting (added after the 2026-06-11 incident): Cloudflare's
//    always-on L7 DDoS managed ruleset intermittently mints 503s for bursty
//    `/api/live/*` playlist polling on the streamthatshit.com zone (hls.js
//    refresh + failover retries), while requests to this workers.dev host pass
//    untouched. So signed live playlist URLs now point here; this Worker
//    fetches the *rewritten* playlist from the origin (the mini keeps doing
//    the fetch + rewrite + transcode decision — it has ffprobe/ffmpeg and the
//    browser-bound fetcher, which a Worker cannot run) and re-points the
//    origin-relative URLs in the body at this Worker:
//      - `/api/live/hls.m3u8?…`      → nested playlists, proxied the same way
//      - `/api/live/hls-resource?…`  → mini-served resources (transcode-needed
//        or not-yet-probed segments), relayed to the origin with `viaOrigin=1`
//    Segment URLs the mini already rewrote to this Worker's absolute base
//    (browser-safe streams) are left untouched and keep fetching upstream
//    directly. The worker→origin subrequest dodges the zone edge entirely when
//    ORIGIN_DIRECT_BASE names a DNS-only (grey-cloud) hostname for the origin
//    IP: the fetch connects straight to Caddy, whose Cloudflare-IP lock still
//    passes because Worker egress uses Cloudflare IPs. (cf.resolveOverride
//    can't do this — it is silently ignored for workers.dev deployments —
//    and without the direct base the fetch re-enters the zone edge, putting
//    the DDoS ruleset right back in the path for relayed client retries.)
//
// Security: every request must carry the same HMAC `sig` the Rust backend
// produces (`sign_live_hls_proxy_url` in src/live.rs) — only the mini, holding
// LIVE_HLS_PROXY_SECRET, can mint valid URLs, so this is not an open proxy
// (origin relays are additionally pinned to ORIGIN_BASE). The signature is
// HMAC-SHA256 over: CONTEXT 0x00 input 0x00 referer, base64url (no pad).
//
// Config: env.LIVE_HLS_PROXY_SECRET (secret, must equal the mini's),
// env.ORIGIN_BASE (var, e.g. https://streamthatshit.com), and optional
// env.ORIGIN_DIRECT_BASE (secret, e.g. http://<random-label>.streamthatshit.com
// — a grey-cloud record; kept secret so the public repo doesn't advertise the
// name, and plain HTTP so no certificate ever lands the name in CT logs. The
// leg carries signed URLs for short-lived public streams, so plaintext is an
// accepted trade-off for keeping the origin IP unpublished).

const SIGNATURE_CONTEXT = "netflix-live-hls-v1";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// Segments are immutable for their short live lifetime; a brief edge cache is
// what fans one upstream fetch out to many concurrent viewers of the same
// stream. Applies to origin-relayed segments too, which also dedupes the
// mini's per-request ffmpeg transcodes across viewers.
const SEGMENT_CACHE_TTL_SECONDS = 20;
// Live media playlists mutate every target-duration (~2-4s); a tiny TTL
// coalesces concurrent viewers' polls without serving stale playlists. (Edge
// cache hints are inert on workers.dev today; they matter if this Worker ever
// moves onto a zone route, and they are harmless meanwhile.)
const PLAYLIST_CACHE_TTL_SECONDS = 2;
// VOD external-embed masters (carried with `directSeg=1`) are immutable for the
// stream token's life (~25 min) — unlike live, they never mutate. Cache the
// worker->origin subrequest for them long enough that a cold burst of player
// polls collapses onto one origin fetch plus fast cached replays, instead of N
// concurrent slow invocations that the workers.dev edge starts 503ing. Matches
// the origin's declared `Cache-Control: max-age=300` for these playlists.
const VOD_PLAYLIST_CACHE_TTL_SECONDS = 300;

const encoder = new TextEncoder();

function base64UrlDecodeToBytes(value) {
  let normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4 !== 0) normalized += "=";
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function verifySignature(secret, input, referer, signature) {
  let provided;
  try {
    provided = base64UrlDecodeToBytes(signature);
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = concatBytes([
    encoder.encode(SIGNATURE_CONTEXT),
    new Uint8Array([0]),
    encoder.encode(input),
    new Uint8Array([0]),
    encoder.encode(referer),
  ]);
  // Recompute and constant-time compare. (Workers' crypto.subtle.verify for HMAC
  // is unreliable; signing matches the Rust backend exactly, so compare bytes.)
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= provided[i] ^ expected[i];
  return diff === 0;
}

// Port of `is_public_hls_proxy_hostname` in src/live.rs: reject localhost /
// private / IP / malformed hosts so a leaked secret can't turn this into an
// SSRF gadget against internal addresses.
function isPublicHlsProxyHostname(host) {
  const value = host.trim().replace(/\.+$/, "").toLowerCase();
  if (
    value.length === 0 ||
    value.includes(":") ||
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value.endsWith(".local") ||
    value.endsWith(".internal") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(value)
  ) {
    return false;
  }
  return (
    value.includes(".") &&
    !value.startsWith(".") &&
    !value.endsWith(".") &&
    !value.includes("..") &&
    /^[a-z0-9.-]+$/.test(value)
  );
}

function deny(status, message) {
  return new Response(message, {
    status,
    headers: { "cache-control": "no-store", "content-type": "text/plain" },
  });
}

// Validate the shared signed-URL contract (`input`, optional `referer`,
// `externalEmbed=1`, `sig`) and return the parsed target, or a deny Response.
async function authorizeSignedRequest(url, env) {
  const input = url.searchParams.get("input");
  const referer = url.searchParams.get("referer") || "";
  const signature = url.searchParams.get("sig");
  const externalEmbed = url.searchParams.get("externalEmbed");
  if (!input || !signature || externalEmbed !== "1") return deny(400, "bad request");

  const secret = env.LIVE_HLS_PROXY_SECRET;
  if (!secret) return deny(503, "not configured");
  if (!(await verifySignature(secret, input, referer, signature))) {
    return deny(403, "bad signature");
  }

  let target;
  try {
    target = new URL(input);
  } catch {
    return deny(400, "bad input url");
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return deny(400, "bad scheme");
  }
  if (!isPublicHlsProxyHostname(target.hostname)) return deny(403, "host not allowed");

  return { target, referer };
}

// Fetch `path` + raw query from the origin (the mini, behind Caddy). With
// ORIGIN_DIRECT_BASE set (grey-cloud hostname), the connection goes straight
// to the origin IP instead of re-entering the zone's edge — which is the
// whole point: the zone's L7 DDoS managed ruleset never sees live traffic.
function fetchFromOrigin(env, path, search, requestHeaders, cacheTtl) {
  const base = ((env.ORIGIN_DIRECT_BASE || env.ORIGIN_BASE || "").trim()).replace(/\/+$/, "");
  if (!base) return null;
  const originUrl = `${base}${path}${search}`;
  const cf = {
    cacheTtl,
    cacheEverything: true,
    cacheKey: originUrl,
  };
  const headers = { Accept: "*/*", "X-Live-Worker-Origin-Fetch": "1" };
  const range = requestHeaders.get("Range");
  if (range) headers["Range"] = range;
  return fetch(originUrl, { method: "GET", headers, cf });
}

// Re-point the origin's rewritten playlist at this Worker. The mini emits
// origin-relative URLs (`/api/live/…`); served from this host they would
// resolve against the Worker anyway, but the mini-served resources must be
// tagged: nested playlists come back to this Worker's playlist route, and
// `/api/live/hls-resource` lines get `viaOrigin=1` so the resource route
// relays them to the origin (preserving the mini's probe + transcode path)
// instead of fetching the upstream bytes raw. Absolute URLs (segments the
// mini already routed to this Worker for browser-safe streams) don't start
// with `/` and pass through untouched.
function rewriteProxiedLiveUrl(pathAndQuery, workerBase) {
  if (pathAndQuery.startsWith("/api/live/hls-resource?")) {
    return `${workerBase}${pathAndQuery}&viaOrigin=1`;
  }
  return `${workerBase}${pathAndQuery}`;
}

const URI_ATTRIBUTE_PATTERN = /URI="(\/api\/live\/(?:hls\.m3u8|hls-resource)\?[^"]*)"/g;

function rewriteOriginPlaylist(body, workerBase) {
  return body
    .split("\n")
    .map((line) => {
      if (line.startsWith("#")) {
        return line.replace(
          URI_ATTRIBUTE_PATTERN,
          (_match, pathAndQuery) => `URI="${rewriteProxiedLiveUrl(pathAndQuery, workerBase)}"`,
        );
      }
      const trimmed = line.trim();
      if (
        trimmed.startsWith("/api/live/hls.m3u8?") ||
        trimmed.startsWith("/api/live/hls-resource?")
      ) {
        return rewriteProxiedLiveUrl(trimmed, workerBase);
      }
      return line;
    })
    .join("\n");
}

// GET /api/live/hls.m3u8 — signed playlist proxy. The origin does the real
// work (upstream fetch, browser-bound fallback, rewrite, segment trimming,
// worker routing for browser-safe streams); this just keeps the client-facing
// hop off the zone and re-points relative URLs at this Worker.
async function handlePlaylist(request, url, env) {
  if (request.method !== "GET") return deny(405, "method not allowed");
  const authorized = await authorizeSignedRequest(url, env);
  if (authorized instanceof Response) return authorized;

  // `directSeg=1` marks an immutable VOD master (see VOD_PLAYLIST_CACHE_TTL_*):
  // cache its origin subrequest long, and hint it as publicly cacheable. Live
  // playlists keep the tiny TTL and stay no-store.
  const immutableVod = url.searchParams.get("directSeg") === "1";
  const playlistTtl = immutableVod
    ? VOD_PLAYLIST_CACHE_TTL_SECONDS
    : PLAYLIST_CACHE_TTL_SECONDS;

  const originFetch = fetchFromOrigin(
    env,
    "/api/live/hls.m3u8",
    url.search,
    request.headers,
    playlistTtl,
  );
  if (!originFetch) return deny(503, "origin not configured");

  let upstream;
  try {
    upstream = await originFetch;
  } catch {
    return deny(502, "origin fetch failed");
  }
  if (!upstream.ok) {
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain",
        "Access-Control-Allow-Origin": "*",
        "X-Live-Proxy": "cf-worker",
      },
    });
  }

  const body = rewriteOriginPlaylist(await upstream.text(), url.origin);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
      "cache-control": immutableVod
        ? `public, max-age=${VOD_PLAYLIST_CACHE_TTL_SECONDS}`
        : "no-store",
      "Access-Control-Allow-Origin": "*",
      "X-Live-Proxy": "cf-worker",
      "X-Live-Proxy-Mode": "playlist",
    },
  });
}

// /api/live/hls-resource?…&viaOrigin=1 — relay a signed resource request to
// the origin so the mini still serves it (probe + transcode for streams that
// need it). Same path, params and signature, so the origin validates the
// identical signature; only the Worker-private `viaOrigin` marker is dropped.
async function relayResourceViaOrigin(request, url, env) {
  const forwarded = new URLSearchParams(url.searchParams);
  forwarded.delete("viaOrigin");
  const originFetch = fetchFromOrigin(
    env,
    "/api/live/hls-resource",
    `?${forwarded.toString()}`,
    request.headers,
    SEGMENT_CACHE_TTL_SECONDS,
  );
  if (!originFetch) return deny(503, "origin not configured");

  let upstream;
  try {
    upstream = await originFetch;
  } catch {
    return deny(502, "origin fetch failed");
  }

  const headers = new Headers();
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const v = upstream.headers.get(name);
    if (v) headers.set(name, v);
  }
  headers.set(
    "Cache-Control",
    upstream.ok ? `public, max-age=${SEGMENT_CACHE_TTL_SECONDS}` : "no-store",
  );
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-Live-Proxy", "cf-worker");
  headers.set("X-Live-Proxy-Mode", "origin");

  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
}

async function handleResource(request, url, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return deny(405, "method not allowed");
  }
  const authorized = await authorizeSignedRequest(url, env);
  if (authorized instanceof Response) return authorized;

  if (url.searchParams.get("viaOrigin") === "1") {
    return relayResourceViaOrigin(request, url, env);
  }

  const { target, referer } = authorized;
  const upstreamHeaders = {
    "User-Agent": BROWSER_UA,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  };
  if (referer) upstreamHeaders["Referer"] = referer;
  const range = request.headers.get("Range");
  if (range) upstreamHeaders["Range"] = range;

  // Cache by the upstream URL so all viewers of the same segment share one
  // entry. Skip the shared cache for Range requests (partial responses).
  const cf = range
    ? {}
    : { cacheTtl: SEGMENT_CACHE_TTL_SECONDS, cacheEverything: true, cacheKey: target.toString() };

  let upstream;
  try {
    upstream = await fetch(target.toString(), { method: "GET", headers: upstreamHeaders, cf });
  } catch (error) {
    return deny(502, "upstream fetch failed");
  }

  const headers = new Headers();
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const v = upstream.headers.get(name);
    if (v) headers.set(name, v);
  }
  headers.set(
    "Cache-Control",
    upstream.ok ? `public, max-age=${SEGMENT_CACHE_TTL_SECONDS}` : "no-store",
  );
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-Live-Proxy", "cf-worker");
  headers.set("X-Live-Proxy-Mode", "upstream");

  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/live/hls.m3u8") return handlePlaylist(request, url, env);
    if (url.pathname === "/api/live/hls-resource") return handleResource(request, url, env);
    return deny(404, "not found");
  },
};

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
//    `/api/live/*` playlist polling on the streamarena.xyz zone (hls.js
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
// Security: every request must carry the same expiry-bound HMAC `sig` the Rust
// backend produces (`sign_live_hls_proxy_url` in src/live.rs) — only the mini,
// holding LIVE_HLS_PROXY_SECRET, can mint valid URLs, so this is not an open
// proxy (origin relays are additionally pinned to ORIGIN_BASE). The v2
// signature is HMAC-SHA256 over:
//   CONTEXT 0x00 input 0x00 referer 0x00 expires
// where `expires` is canonical absolute Unix time in seconds.
//
// Config: env.LIVE_HLS_PROXY_SECRET (secret, must equal the mini's),
// env.ORIGIN_BASE (var, e.g. https://streamarena.xyz), optional transition var
// env.LIVE_HLS_LEGACY_SIGNATURE_ACCEPT_UNTIL (absolute Unix seconds), and optional
// env.ORIGIN_DIRECT_BASE (secret, e.g. http://<random-label>.streamarena.xyz
// — a grey-cloud record; kept secret so the public repo doesn't advertise the
// name, and plain HTTP so no certificate ever lands the name in CT logs. The
// leg carries signed URLs for short-lived public streams, so plaintext is an
// accepted trade-off for keeping the origin IP unpublished).

const SIGNATURE_CONTEXT_V1 = "streamarena-live-hls-v1";
const SIGNATURE_CONTEXT_V2 = "streamarena-live-hls-v2";
// Keep these values exactly aligned with src/live.rs. The four-hour issuance
// TTL covers long playback; the six-hour ceiling rejects operator mistakes and
// attacker-chosen far-future expiries; 60 seconds handles clock skew.
const SIGNATURE_TTL_SECONDS = 4 * 60 * 60;
const SIGNATURE_MAX_TTL_SECONDS = 6 * 60 * 60;
const SIGNATURE_CLOCK_SKEW_SECONDS = 60;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// Segments are immutable for their short live lifetime; a brief edge cache is
// what fans one upstream fetch out to many concurrent viewers of the same
// stream. Applies to origin-relayed segments too, which also dedupes the
// mini's per-request ffmpeg transcodes across viewers.
const SEGMENT_CACHE_TTL_SECONDS = 20;
// Live media playlists mutate every target-duration (~2-4s); a tiny TTL
// coalesces concurrent viewers' polls without serving stale playlists. (These
// cf.cacheTtl hints were inert while this Worker lived only on workers.dev;
// since the zone-routed custom domain was attached — see "routes" in
// wrangler.jsonc — subrequest caching is empirically active on BOTH hosts
// (verified 2026-07-06: MISS→HIT on repeat fetches via workers.dev and the
// custom domain). The backend keeps workers.dev as its client-facing base to
// stay out of the zone's L7 DDoS managed ruleset, which 503'd bursty live
// polling on 2026-06-11; the custom domain is the standby host.)
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

async function verifySignature(
  secret,
  input,
  referer,
  expires,
  signature,
  context = SIGNATURE_CONTEXT_V2,
) {
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
    encoder.encode(context),
    new Uint8Array([0]),
    encoder.encode(input),
    new Uint8Array([0]),
    encoder.encode(referer),
    ...(expires === null
      ? []
      : [new Uint8Array([0]), encoder.encode(String(expires))]),
  ]);
  // Recompute and constant-time compare. (Workers' crypto.subtle.verify for HMAC
  // is unreliable; signing matches the Rust backend exactly, so compare bytes.)
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= provided[i] ^ expected[i];
  return diff === 0;
}

function parseSignatureExpiry(value, nowSeconds) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const expires = Number(value);
  if (!Number.isSafeInteger(expires)) return null;
  const earliest = nowSeconds - SIGNATURE_CLOCK_SKEW_SECONDS;
  const latest = nowSeconds + SIGNATURE_MAX_TTL_SECONDS + SIGNATURE_CLOCK_SKEW_SECONDS;
  return expires >= earliest && expires <= latest ? expires : null;
}

function legacySignatureIsTemporarilyAllowed(value, nowSeconds) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return false;
  const deadline = Number(value);
  if (!Number.isSafeInteger(deadline)) return false;
  return (
    deadline >= nowSeconds - SIGNATURE_CLOCK_SKEW_SECONDS &&
    deadline <= nowSeconds + SIGNATURE_MAX_TTL_SECONDS + SIGNATURE_CLOCK_SKEW_SECONDS
  );
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

// Observability for the edge-cache move: `cf-cache-status` on a subrequest
// response says whether the cf.cacheTtl/cacheEverything hints actually hit
// Cloudflare's cache (HIT/MISS/EXPIRED…). The header only appears when the
// hints are live — i.e. on the zone-routed custom domain; on the workers.dev
// rollback host it's absent and surfaces as "none". Relayed on every proxied
// response so one curl against either host verifies the caching layer without
// needing `wrangler tail`.
function upstreamCacheStatus(upstream) {
  return upstream.headers.get("cf-cache-status") || "none";
}

// Validate the shared signed-URL contract (`input`, optional `referer`,
// `externalEmbed=1`, `expires`, `sig`) and return the parsed target, or a deny
// Response. During the documented deployment transition only, a v1 URL without
// an expiry can be accepted until one tightly-bounded absolute deadline.
async function authorizeSignedRequest(
  url,
  env,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const input = url.searchParams.get("input");
  const referer = url.searchParams.get("referer") || "";
  const externalEmbed = url.searchParams.get("externalEmbed");
  if (!input || externalEmbed !== "1") return deny(400, "bad request");

  const secret = env.LIVE_HLS_PROXY_SECRET;
  if (!secret) return deny(503, "not configured");

  const expiryValue = url.searchParams.get("expires");
  let expiresAt = null;
  if (expiryValue === null) {
    const legacySignature = url.searchParams.get("sig");
    if (
      !legacySignature ||
      !legacySignatureIsTemporarilyAllowed(
        env.LIVE_HLS_LEGACY_SIGNATURE_ACCEPT_UNTIL,
        nowSeconds,
      )
    ) {
      return deny(400, "missing expiry");
    }
    if (
      !(await verifySignature(
        secret,
        input,
        referer,
        null,
        legacySignature,
        SIGNATURE_CONTEXT_V1,
      ))
    ) {
      return deny(403, "bad signature");
    }
  } else {
    expiresAt = parseSignatureExpiry(expiryValue, nowSeconds);
    if (expiresAt === null) return deny(403, "bad expiry");
    // During backend-first rollout `sig` is v1 for the old Worker while
    // `sigV2` is the expiry-bound value. In steady state v2 lives in `sig`.
    const signature = url.searchParams.get("sigV2") || url.searchParams.get("sig");
    if (!signature) return deny(400, "bad request");
    if (!(await verifySignature(secret, input, referer, expiresAt, signature))) {
      return deny(403, "bad signature");
    }
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

  return { target, referer, expiresAt };
}

// One GET to a specific origin base. Path+query is forwarded verbatim so the
// backend's HMAC signature keeps validating.
function originSubrequest(base, path, search, requestHeaders, cacheTtl, signal) {
  const originUrl = `${base}${path}${search}`;
  const headers = { Accept: "*/*", "X-Live-Worker-Origin-Fetch": "1" };
  const range = requestHeaders.get("Range");
  if (range) headers["Range"] = range;
  const init = {
    method: "GET",
    headers,
    cf: { cacheTtl, cacheEverything: true, cacheKey: originUrl },
  };
  if (signal) init.signal = signal;
  return fetch(originUrl, init);
}

// How long the grey-cloud direct leg gets before we also reach for the zone
// edge. A healthy direct origin answers in well under this; it only bites when
// the direct leg is degraded — e.g. the home router's port-forward for the
// grey-cloud origin gets dropped on a reboot, so Cloudflare's ~15s origin
// connect timeout would otherwise stall every playlist fetch for ~20s.
const ORIGIN_DIRECT_SOFT_DEADLINE_MS = 2500;
// After the direct leg misses the deadline (or errors), skip it for this long
// so we don't re-pay the deadline on every request while it stays down. One
// request re-probes once the cooldown lapses, so recovery is automatic. This is
// best-effort, per-isolate state — safe to lose; it only tunes latency.
const ORIGIN_DIRECT_COOLDOWN_MS = 30000;
let directOriginTrippedUntil = 0;

// Fetch `path` + raw query from the origin (the mini, behind Caddy). With
// ORIGIN_DIRECT_BASE set (grey-cloud hostname), the connection goes straight
// to the origin IP instead of re-entering the zone's edge — which is the whole
// point: the zone's L7 DDoS managed ruleset never sees live traffic.
//
// Resilience: when both the direct (grey) base and the edge ORIGIN_BASE are
// configured, the direct leg is preferred but bounded by a soft deadline. If it
// is slow (a degraded port-forward) or returns 5xx, the edge base serves the
// request instead — so a broken direct leg costs ~2.5s once (then nothing,
// while the breaker is open), not ~20s on every fetch. A healthy direct leg
// wins long before the deadline, keeping the edge (and its DDoS ruleset) out of
// the path in normal operation.
function fetchFromOrigin(env, path, search, requestHeaders, cacheTtl) {
  const direct = (env.ORIGIN_DIRECT_BASE || "").trim().replace(/\/+$/, "");
  const edge = (env.ORIGIN_BASE || "").trim().replace(/\/+$/, "");
  const primary = direct || edge;
  if (!primary) return null;

  // No distinct fallback to lean on: original single-origin behaviour.
  if (!direct || !edge || direct === edge) {
    return originSubrequest(primary, path, search, requestHeaders, cacheTtl);
  }
  // Direct leg is in cooldown after recent failures: skip straight to the edge.
  if (Date.now() < directOriginTrippedUntil) {
    return originSubrequest(edge, path, search, requestHeaders, cacheTtl);
  }

  return (async () => {
    const controller = new AbortController();
    let deadlineTimer;
    const softDeadline = new Promise((resolve) => {
      deadlineTimer = setTimeout(() => resolve("slow"), ORIGIN_DIRECT_SOFT_DEADLINE_MS);
    });
    const directAttempt = originSubrequest(
      direct,
      path,
      search,
      requestHeaders,
      cacheTtl,
      controller.signal,
    )
      .then((response) => ({ response }))
      .catch((error) => ({ error }));

    const settled = await Promise.race([directAttempt, softDeadline]);
    clearTimeout(deadlineTimer);

    if (settled !== "slow") {
      // Direct answered in time. Trust any non-5xx (incl. signed 4xx denials,
      // which the edge would mirror); only 5xx earns the edge retry.
      if (settled.response && settled.response.status < 500) {
        directOriginTrippedUntil = 0; // healthy — keep the breaker closed
        return settled.response;
      }
      directOriginTrippedUntil = Date.now() + ORIGIN_DIRECT_COOLDOWN_MS;
      return originSubrequest(edge, path, search, requestHeaders, cacheTtl);
    }

    // Direct missed the deadline — trip the breaker, drop it, serve from edge.
    directOriginTrippedUntil = Date.now() + ORIGIN_DIRECT_COOLDOWN_MS;
    controller.abort();
    return originSubrequest(edge, path, search, requestHeaders, cacheTtl);
  })();
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
        "X-Upstream-Cache": upstreamCacheStatus(upstream),
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
      "X-Upstream-Cache": upstreamCacheStatus(upstream),
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
  headers.set("X-Upstream-Cache", upstreamCacheStatus(upstream));

  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
}

// Some external-embed CDNs disguise each `.ts` fragment as a PNG: a real PNG header
// (magic `89 50 4E 47 ...`) is prepended to the MPEG-TS payload, served as
// `content-type: image/png`. Browser hls.js strips this client-side
// (`src-ui/player/hls-controller.js`) and the Rust origin strips it in
// `live_hls_resource_handler`; mirror it here so the worker's direct-fetch path hands
// native players (AVPlayer) clean mpeg-ts too. Cheap 4-byte check ⇒ safe for every
// fragment; returns the input untouched when it isn't PNG-prefixed.
function stripPngPrefixedTs(bytes) {
  if (
    bytes.length < 8 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    return bytes;
  }
  const limit = Math.min(bytes.length - 376, 65536);
  for (let i = 1; i < limit; i += 1) {
    if (bytes[i] === 0x47 && bytes[i + 188] === 0x47 && bytes[i + 376] === 0x47) {
      return bytes.subarray(i);
    }
  }
  return bytes;
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

  // PNG-disguised mpeg-ts: buffer the (small, cacheable) segment, strip the prepended
  // PNG header to the first TS sync byte, and serve clean mpeg-ts so native players can
  // demux it. Only PNG responses are buffered; everything else streams through below.
  const upstreamContentType = upstream.headers.get("content-type") || "";
  if (request.method === "GET" && upstream.ok && /png/i.test(upstreamContentType)) {
    const raw = new Uint8Array(await upstream.arrayBuffer());
    const stripped = stripPngPrefixedTs(raw);
    const headers = new Headers();
    headers.set("content-type", stripped.length !== raw.length ? "video/mp2t" : upstreamContentType);
    const acceptRanges = upstream.headers.get("accept-ranges");
    if (acceptRanges) headers.set("accept-ranges", acceptRanges);
    headers.set("Cache-Control", `public, max-age=${SEGMENT_CACHE_TTL_SECONDS}`);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("X-Live-Proxy", "cf-worker");
    headers.set("X-Live-Proxy-Mode", "upstream");
    headers.set("X-Upstream-Cache", upstreamCacheStatus(upstream));
    return new Response(stripped, { status: upstream.status, headers });
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
  headers.set("X-Upstream-Cache", upstreamCacheStatus(upstream));

  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
}

// Named exports keep the security contract directly regression-testable in
// Node without changing the Worker's module-handler entry point.
export {
  SIGNATURE_CLOCK_SKEW_SECONDS,
  SIGNATURE_MAX_TTL_SECONDS,
  SIGNATURE_TTL_SECONDS,
  authorizeSignedRequest,
  legacySignatureIsTemporarilyAllowed,
  parseSignatureExpiry,
  verifySignature,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/live/hls.m3u8") return handlePlaylist(request, url, env);
    if (url.pathname === "/api/live/hls-resource") return handleResource(request, url, env);
    return deny(404, "not found");
  },
};

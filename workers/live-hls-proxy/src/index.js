// Live HLS segment proxy on Cloudflare Workers.
//
// Offloads the bandwidth-heavy part of the Mac mini's `/api/live/hls-resource`
// path (fetching live HLS segments/keys from upstream embeds and relaying them
// to viewers) onto Cloudflare's network + edge cache. The mini keeps serving the
// playlists and all the smart HLS logic; it just rewrites *segment* URLs to point
// here for browser-safe streams. Many viewers of one stream then collapse to ~1
// upstream fetch per segment instead of N fetches through the home uplink.
//
// Security: every request must carry the same HMAC `sig` the Rust backend
// produces (`sign_live_hls_proxy_url` in src/live.rs) — only the mini, holding
// LIVE_HLS_PROXY_SECRET, can mint valid URLs, so this is not an open proxy. The
// signature is HMAC-SHA256 over: CONTEXT 0x00 input 0x00 referer, base64url (no pad).

const SIGNATURE_CONTEXT = "netflix-live-hls-v1";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// Segments are immutable for their short live lifetime; a brief edge cache is
// what fans one upstream fetch out to many concurrent viewers of the same stream.
const SEGMENT_CACHE_TTL_SECONDS = 20;

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/live/hls-resource") return deny(404, "not found");
    if (request.method !== "GET" && request.method !== "HEAD") {
      return deny(405, "method not allowed");
    }

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

    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      headers,
    });
  },
};

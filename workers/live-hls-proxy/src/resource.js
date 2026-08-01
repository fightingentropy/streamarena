import { authorizeSignedRequest, isPublicHlsProxyHostname } from "./authorization.js";
import {
  BROWSER_UA,
  MAX_BUFFERED_PNG_SEGMENT_BYTES,
  MAX_UPSTREAM_REDIRECTS,
  SEGMENT_CACHE_TTL_SECONDS,
} from "./constants.js";
import { BodyLimitError, deny, readBoundedBytes, upstreamCacheStatus } from "./http.js";
import { fetchFromOrigin } from "./origin.js";

export async function fetchWithSafeRedirects(
  initialUrl,
  init,
  { fetcher = fetch, blockedHostname = "", maxRedirects = MAX_UPSTREAM_REDIRECTS } = {},
) {
  let current = new URL(initialUrl);
  for (let redirects = 0; ; redirects += 1) {
    if (
      current.protocol !== "https:" ||
      !isPublicHlsProxyHostname(current.hostname) ||
      (blockedHostname && current.hostname.toLowerCase() === blockedHostname.toLowerCase())
    ) {
      throw new Error("unsafe redirect target");
    }
    const response = await fetcher(current.toString(), { ...init, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;
    if (redirects >= maxRedirects) throw new Error("redirect limit exceeded");
    const location = response.headers.get("location");
    if (!location) throw new Error("redirect missing location");
    current = new URL(location, current);
  }
}

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
  return relayResponse(request, upstream, "origin");
}

export function stripPngPrefixedTs(bytes) {
  if (
    bytes.length < 8 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    return bytes;
  }
  const limit = Math.min(bytes.length - 376, 65_536);
  for (let index = 1; index < limit; index += 1) {
    if (
      bytes[index] === 0x47 &&
      bytes[index + 188] === 0x47 &&
      bytes[index + 376] === 0x47
    ) {
      return bytes.subarray(index);
    }
  }
  return bytes;
}

function relayResponse(request, upstream, mode) {
  const headers = new Headers();
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set(
    "Cache-Control",
    upstream.ok ? `public, max-age=${SEGMENT_CACHE_TTL_SECONDS}` : "no-store",
  );
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-Live-Proxy", "cf-worker");
  headers.set("X-Live-Proxy-Mode", mode);
  headers.set("X-Upstream-Cache", upstreamCacheStatus(upstream));
  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
}

export async function handleResource(request, url, env) {
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
  if (referer) upstreamHeaders.Referer = referer;
  const range = request.headers.get("Range");
  if (range) upstreamHeaders.Range = range;
  const cf = range
    ? {}
    : {
        cacheTtl: SEGMENT_CACHE_TTL_SECONDS,
        cacheEverything: true,
        cacheKey: target.toString(),
      };

  let upstream;
  try {
    upstream = await fetchWithSafeRedirects(
      target,
      { method: "GET", headers: upstreamHeaders, cf },
      { blockedHostname: url.hostname },
    );
  } catch {
    return deny(502, "upstream fetch failed");
  }

  const contentType = upstream.headers.get("content-type") || "";
  if (request.method === "GET" && upstream.ok && /png/i.test(contentType)) {
    try {
      const raw = await readBoundedBytes(upstream, MAX_BUFFERED_PNG_SEGMENT_BYTES);
      const stripped = stripPngPrefixedTs(raw);
      const headers = new Headers();
      headers.set("content-type", stripped.length !== raw.length ? "video/mp2t" : contentType);
      const acceptRanges = upstream.headers.get("accept-ranges");
      if (acceptRanges) headers.set("accept-ranges", acceptRanges);
      headers.set("Cache-Control", `public, max-age=${SEGMENT_CACHE_TTL_SECONDS}`);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("X-Live-Proxy", "cf-worker");
      headers.set("X-Live-Proxy-Mode", "upstream");
      headers.set("X-Upstream-Cache", upstreamCacheStatus(upstream));
      return new Response(stripped, { status: upstream.status, headers });
    } catch (error) {
      if (error instanceof BodyLimitError) return deny(502, "segment exceeded safety limits");
      return deny(502, "segment decode failed");
    }
  }
  return relayResponse(request, upstream, "upstream");
}

import {
  SEGMENT_CACHE_TTL_SECONDS,
  VOD_SEGMENT_CACHE_TTL_SECONDS,
} from "./constants.js";

// A browser cache hit does not execute the Worker authorization check again.
// Never let a cached response outlive its bearer grant, including the expiry
// grace window accepted by authorization. Legacy grants have no bounded TTL.
export function boundedCacheTtl(authorization, ttl, now = Math.floor(Date.now() / 1000)) {
  if (!Number.isSafeInteger(authorization.expiresAt)) return 0;
  let expiresAt = authorization.expiresAt;
  // Honor explicit upstream token deadlines too. Opaque provider tokens stay
  // opaque; their existing expiry-bound URL remains part of the cache key.
  for (const key of ["expires", "exp", "expiry"]) {
    const value = authorization.target.searchParams.get(key);
    if (value && /^(0|[1-9]\d*)$/.test(value)) {
      const expires = Number(value);
      if (Number.isSafeInteger(expires)) expiresAt = Math.min(expiresAt, expires);
    }
  }
  return Math.max(0, Math.min(ttl, expiresAt - now));
}

export function resourceCacheTtl(url, authorization) {
  return boundedCacheTtl(
    authorization,
    url.searchParams.get("vod") === "1"
      ? VOD_SEGMENT_CACHE_TTL_SECONDS
      : SEGMENT_CACHE_TTL_SECONDS,
  );
}

export function fetchCacheOptions(ttl, headers) {
  if (ttl <= 0 || headers.get("Range")) return { cache: "no-store" };
  return {
    cf: {
      cacheEverything: true,
      // Preserve the origin's successful-response cache policy, including
      // private/no-store. Forcing a 200 TTL would override those directives.
      // Authorization runs before fetch; expired/grace grants bypass above.
      // Do not negative-cache a failed provider lookup or a redirect. The
      // default key preserves the complete URL, including its token/query,
      // and follows each redirect's URL. cf.cacheKey is Enterprise-only.
      cacheTtlByStatus: { "300-599": -1 },
    },
  };
}

export function responseCacheControl(upstream, ttl, requestHeaders) {
  const upstreamPolicy = upstream.headers.get("cache-control") || "";
  if (
    !upstream.ok ||
    ttl <= 0 ||
    upstream.status === 206 ||
    requestHeaders.has("Range") ||
    /\b(?:private|no-store|no-cache)\b/i.test(upstreamPolicy)
  ) {
    return "no-store";
  }
  return `public, max-age=${ttl}`;
}

export function isImmutablePlaylist(body) {
  return /^(?:#EXT-X-STREAM-INF:|#EXT-X-ENDLIST\s*$|#EXT-X-PLAYLIST-TYPE:VOD\s*$)/m.test(body);
}

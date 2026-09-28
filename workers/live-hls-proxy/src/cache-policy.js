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

// Relaying an edge HIT creates a new response. Account for its existing age so
// the browser does not receive a fresh lifetime for already-cached media.
// null means the upstream supplied no explicit freshness limit; retain the
// app's existing grant-bounded policy in that case.
export function upstreamFreshnessTtl(headers, now = Math.floor(Date.now() / 1000)) {
  const policy = headers.get("cache-control") || "";
  if (/\b(?:private|no-store|no-cache)\b/i.test(policy)) return 0;
  const directive = (name) => {
    const entries = policy.split(",").map((part) => part.trim())
      .filter((part) => part.split("=", 1)[0].trim().toLowerCase() === name);
    if (!entries.length) return null;
    if (entries.length !== 1) return 0;
    const match = entries[0].match(/^[^=]+=\s*(?:"(\d+)"|(\d+))$/);
    const value = match ? Number(match[1] ?? match[2]) : NaN;
    return Number.isSafeInteger(value) ? value : 0;
  };
  // s-maxage may permit the shared cache to retain media longer than a browser.
  // Never promote that longer lifetime into browser max-age. Taking the lower
  // explicit limit also avoids extending a short shared-cache policy.
  const lifetimes = [directive("max-age"), directive("s-maxage")]
    .filter((value) => value !== null);
  const rawExpires = headers.get("expires");
  if (!lifetimes.length && rawExpires === null) return null;
  const rawAge = headers.get("age");
  if (rawAge !== null && !/^\d+$/.test(rawAge)) return 0;
  const age = Number(rawAge || 0);
  if (!Number.isSafeInteger(age)) return 0;
  const rawDate = headers.get("date");
  const date = rawDate === null ? now : Math.floor(Date.parse(rawDate) / 1000);
  if (!Number.isFinite(date)) return 0;
  const apparentAge = Math.max(0, now - date, age);
  if (lifetimes.length) return Math.max(0, Math.min(...lifetimes) - apparentAge);
  const expiry = Math.floor(Date.parse(rawExpires) / 1000);
  return Number.isFinite(expiry) ? Math.max(0, expiry - date - apparentAge) : 0;
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
  const upstreamTtl = upstreamFreshnessTtl(upstream.headers);
  const remaining = upstreamTtl === null ? ttl : Math.min(ttl, upstreamTtl);
  return remaining > 0 ? `public, max-age=${remaining}` : "no-store";
}

export function isImmutablePlaylist(body) {
  return /^(?:#EXT-X-STREAM-INF:|#EXT-X-ENDLIST\s*$|#EXT-X-PLAYLIST-TYPE:VOD\s*$)/m.test(body);
}

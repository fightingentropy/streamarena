import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { handlePlaylist } from "../src/playlist.js";
import { handleResource, fetchWithSafeRedirects } from "../src/resource.js";
import { boundedCacheTtl, upstreamFreshnessTtl } from "../src/cache-policy.js";
import { logProxyFailure } from "../src/diagnostics.js";

const SECRET = "test-cache-expiry-secret-with-enough-length";
const NOW = 1_800_000_000;
const ENV = { LIVE_HLS_PROXY_SECRET: SECRET, ORIGIN_BASE: "https://origin.example.com" };

function signedUrl({
  input = "https://cdn.example.com/segment.m4s?token=source-token",
  referer = "https://cinejoy.pk/",
  expires = NOW + 7_200,
  route = "hls-resource",
  vod = false,
  origin = false,
} = {}) {
  const url = new URL(`https://worker.example.com/api/live/${route}`);
  for (const [key, value] of Object.entries({ input, referer, externalEmbed: "1" })) {
    url.searchParams.set(key, value);
  }
  const fields = [expires === null ? "streamarena-live-hls-v1" : "streamarena-live-hls-v2", input, referer];
  if (expires !== null) {
    url.searchParams.set("expires", String(expires));
    fields.push(String(expires));
  }
  url.searchParams.set("sig", createHmac("sha256", SECRET).update(fields.join("\0")).digest("base64url"));
  if (vod) url.searchParams.set("vod", "1");
  if (origin) url.searchParams.set("viaOrigin", "1");
  return url;
}

test("VOD uses a longer bounded TTL; live retains its short TTL without Enterprise cache keys", async (t) => {
  t.mock.method(Date, "now", () => NOW * 1000);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    return new Response("segment", { headers: { "content-type": "video/mp4" } });
  });
  for (const [vod, expected] of [[false, 20], [true, 3_600]]) {
    const url = signedUrl({ vod });
    const response = await handleResource(new Request(url), url, ENV);
    assert.equal(await response.text(), "segment");
    assert.equal(response.headers.get("cache-control"), `public, max-age=${expected}`);
    assert.deepEqual(requests.at(-1).init.cf, {
      cacheEverything: true,
      cacheTtlByStatus: { "300-599": -1 },
    });
    assert.equal(requests.at(-1).url, url.searchParams.get("input"));
  }
});

test("cached bytes never outlive a bearer or explicit upstream expiry, including time spent fetching", async (t) => {
  let now = NOW;
  t.mock.method(Date, "now", () => now * 1000);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push(init);
    now += 3;
    return new Response("segment");
  });
  const url = signedUrl({ vod: true, expires: NOW + 5 });
  const response = await handleResource(new Request(url), url, ENV);
  assert.equal(requests[0].cf.cacheTtlByStatus["200-299"], undefined);
  assert.equal(response.headers.get("cache-control"), "public, max-age=2");
  assert.equal(boundedCacheTtl({
    expiresAt: NOW + 500,
    target: new URL(`https://cdn.example.com/media?exp=${NOW + 30}`),
  }, 3_600, NOW), 30);
  assert.equal(boundedCacheTtl({
    expiresAt: NOW + 500,
    target: new URL(`https://cdn.example.com/media?expires=${NOW - 1}`),
  }, 3_600, NOW), 0);
});

test("expiry grace and legacy grants remain playable but cannot populate a cache", async (t) => {
  t.mock.method(Date, "now", () => NOW * 1000);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push(init);
    return new Response("segment");
  });
  for (const expires of [NOW - 1, null]) {
    const url = signedUrl({ vod: true, expires });
    const response = await handleResource(new Request(url), url, {
      ...ENV, LIVE_HLS_LEGACY_SIGNATURE_ACCEPT_UNTIL: String(NOW + 60),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(requests.at(-1).cache, "no-store");
    assert.equal(requests.at(-1).cf, undefined);
  }
});

test("private or tampered requests are denied before any fetch or cache lookup", async (t) => {
  t.mock.method(Date, "now", () => NOW * 1000);
  let fetched = false;
  t.mock.method(globalThis, "fetch", async () => { fetched = true; return new Response("private"); });
  for (const field of ["privateSession", "sig"]) {
    const url = signedUrl({ vod: true });
    url.searchParams.set(field, "must-not-be-public");
    const response = await handleResource(new Request(url), url, ENV);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(fetched, false);
});

test("origin relay cache identity keeps signed input, referrer and expiry intact", async (t) => {
  t.mock.method(Date, "now", () => NOW * 1000);
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requested.push({ url: new URL(url), init });
    return new Response("segment", { headers: { "cache-control": "public, max-age=3600" } });
  });
  for (const expires of [NOW + 400, NOW + 500]) {
    const url = signedUrl({ vod: true, origin: true, expires });
    const response = await handleResource(new Request(url), url, ENV);
    assert.equal(response.headers.get("x-live-proxy-mode"), "origin");
    const sent = requested.at(-1);
    assert.equal(sent.url.searchParams.has("viaOrigin"), false);
    for (const key of ["input", "referer", "expires", "sig", "vod"]) {
      assert.equal(sent.url.searchParams.get(key), url.searchParams.get(key));
    }
    assert.equal(sent.init.cf.cacheKey, undefined);
    assert.equal(response.headers.get("cache-control"), `public, max-age=${expires - NOW}`);
  }
  assert.notEqual(requested[0].url.toString(), requested[1].url.toString());
});

test("an aged origin cache HIT does not restart the browser freshness window", async (t) => {
  t.mock.method(Date, "now", () => NOW * 1000);
  t.mock.method(globalThis, "fetch", async () => new Response("segment", {
    headers: {
      "content-type": "video/mp4",
      "cache-control": "public, max-age=60, s-maxage=3600",
      "date": new Date((NOW - 25) * 1000).toUTCString(),
      "age": "30",
      "cf-cache-status": "HIT",
    },
  }));
  const url = signedUrl({ vod: true, origin: true });
  const response = await handleResource(new Request(url), url, ENV);
  assert.equal(response.headers.get("x-upstream-cache"), "HIT");
  assert.equal(response.headers.get("cache-control"), "public, max-age=30");
  assert.equal(await response.text(), "segment");

  const expiring = signedUrl({ vod: true, origin: true, expires: NOW + 10 });
  const expiringResponse = await handleResource(new Request(expiring), expiring, ENV);
  assert.equal(expiringResponse.headers.get("cache-control"), "public, max-age=10");
});

test("freshness handles Date, Age, Expires and distinct shared/browser lifetimes conservatively", () => {
  const date = new Date((NOW - 10) * 1000).toUTCString();
  for (const [headers, expected] of [
    [{ "cache-control": "public, max-age=60", date, age: "20" }, 40],
    [{ "cache-control": "public, max-age=60", date, age: "5" }, 50],
    [{ "cache-control": "public, max-age=60, s-maxage=3600", age: "20" }, 40],
    [{ "cache-control": "public, max-age=3600, s-maxage=60", age: "20" }, 40],
    [{ "cache-control": 'public, MAX-AGE="60"', age: "20" }, 40],
    [{ expires: new Date((NOW + 30) * 1000).toUTCString(), date, age: "20" }, 20],
    [{ "cache-control": "max-age=60", expires: "0", age: "20" }, 40],
    [{ "cache-control": "max-age=60", date: new Date((NOW - 70) * 1000).toUTCString() }, 0],
    [{ "cache-control": "max-age=60", age: "61" }, 0],
    [{ "cache-control": "max-age=60", age: "not-a-number" }, 0],
    [{ "cache-control": "max-age=60", date: "invalid" }, 0],
    [{ "cache-control": "max-age=60, max-age=90" }, 0],
    [{ "cache-control": "max-age=60, s-maxage=invalid" }, 0],
    [{ "cache-control": "max-age=invalid" }, 0],
    [{ "cache-control": "max-age=0" }, 0],
    [{ "cache-control": "private, max-age=60" }, 0],
    [{ "cache-control": "public, no-cache, max-age=60" }, 0],
    [{ expires: "0" }, 0],
    [{}, null],
  ]) {
    assert.equal(upstreamFreshnessTtl(new Headers(headers), NOW), expected, JSON.stringify(headers));
  }
});

test("stale media and immutable playlists do not acquire a new browser cache lifetime", async (t) => {
  t.mock.method(Date, "now", () => NOW * 1000);
  t.mock.method(globalThis, "fetch", async () => new Response("#EXTM3U\n#EXT-X-ENDLIST", {
    headers: { "cache-control": "public, max-age=20", "age": "25" },
  }));
  for (const origin of [false, true]) {
    const url = signedUrl({ vod: true, origin });
    const response = await handleResource(new Request(url), url, ENV);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const url = signedUrl({ route: "hls.m3u8" });
  const response = await handlePlaylist(new Request(url), url, ENV);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("ranges, private upstream responses and provider failures are never served as public cache entries", async (t) => {
  t.mock.method(Date, "now", () => NOW * 1000);
  t.mock.method(console, "warn", () => {});
  for (const [status, policy, range] of [
    [200, "private, max-age=3600", false],
    [200, "no-store", false],
    [206, "public, max-age=3600", true],
    [502, "public, max-age=3600", false],
  ]) {
    let init;
    const mock = t.mock.method(globalThis, "fetch", async (_url, options) => {
      init = options;
      return new Response("body", { status, headers: { "cache-control": policy } });
    });
    const url = signedUrl({ vod: true });
    const response = await handleResource(new Request(url, {
      headers: range ? { Range: "bytes=0-5" } : {},
    }), url, ENV);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    if (range) {
      assert.equal(init.cache, "no-store");
      assert.equal(init.cf, undefined);
      assert.equal(init.headers.Range, "bytes=0-5");
    }
    mock.mock.restore();
  }
});

test("immutable playlists cache without directSeg while rolling playlists ignore the hint", async (t) => {
  t.mock.method(Date, "now", () => NOW * 1000);
  for (const [body, direct, policy] of [
    ["#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n/api/live/hls.m3u8?input=child", false, "public, max-age=120"],
    ["#EXTM3U\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST", false, "public, max-age=120"],
    ["#EXTM3U\n#EXTINF:4,\nsegment.ts", true, "no-store"],
  ]) {
    const mock = t.mock.method(globalThis, "fetch", async () => new Response(body, {
      headers: { "cache-control": "public, max-age=300" },
    }));
    const url = signedUrl({ route: "hls.m3u8", expires: NOW + 120 });
    if (direct) url.searchParams.set("directSeg", "1");
    const response = await handlePlaylist(new Request(url), url, ENV);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), policy);
    mock.mock.restore();
  }
});

test("large media stays streamed, and HEAD releases the unused upstream body", async (t) => {
  t.mock.method(Date, "now", () => NOW * 1000);
  let controller;
  let canceled = false;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(value) { controller = value; },
    cancel() { canceled = true; },
  }), { headers: { "content-type": "video/mp4" } }));
  const url = signedUrl({ vod: true });
  const response = await handleResource(new Request(url), url, ENV);
  controller.enqueue(new TextEncoder().encode("first chunk"));
  controller.close();
  assert.equal(await response.text(), "first chunk");
  const head = await handleResource(new Request(url, { method: "HEAD" }), url, ENV);
  assert.equal(head.body, null);
  assert.equal(canceled, true);
});

test("failure diagnostics classify fetch errors without leaking signed links, headers or secrets", async (t) => {
  t.mock.method(Date, "now", () => NOW * 1000);
  const logs = [];
  t.mock.method(console, "warn", (value) => logs.push(JSON.parse(value)));
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("cf.cacheKey needs Enterprise: https://cdn.example.com/secret-path?token=TOPSECRET");
  });
  const url = signedUrl({ vod: true });
  const response = await handleResource(new Request(url), url, ENV);
  assert.equal(response.status, 502);
  assert.equal(await response.text(), "upstream fetch failed");
  assert.deepEqual(logs[0], {
    event: "live_hls_proxy_failure",
    stage: "resource_upstream",
    upstreamHost: "cdn.example.com",
    reason: "cache_configuration",
    elapsedMs: 0,
  });
  logProxyFailure("origin_direct", { error: new Error("DNS failure https://private-origin.example/secret") });
  assert.equal(logs[1].reason, "dns");
  const serialized = JSON.stringify(logs);
  for (const secret of ["TOPSECRET", "secret-path", "source-token", "private-origin.example", url.searchParams.get("sig")]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("redirect subrequests use each complete URL as the default cache identity", async () => {
  const requests = [];
  await fetchWithSafeRedirects("https://first.example.com/segment?token=first", { cf: { cacheEverything: true } }, {
    fetcher: async (url, init) => {
      requests.push({ url, init });
      return requests.length === 1
        ? new Response(null, { status: 302, headers: { location: "https://next.example.com/segment?token=next" } })
        : new Response("media");
    },
  });
  assert.deepEqual(requests.map(({ url }) => url), [
    "https://first.example.com/segment?token=first",
    "https://next.example.com/segment?token=next",
  ]);
  assert.ok(requests.every(({ init }) => init.cf.cacheKey === undefined));
});

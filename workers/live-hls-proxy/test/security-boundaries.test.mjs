import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { authorizeSignedRequest } from "../src/authorization.js";
import { BROWSER_UA, hlsUserAgent, MAX_PLAYLIST_BYTES } from "../src/constants.js";
import { BodyLimitError, readBoundedText } from "../src/http.js";
import { normalizeOriginBase } from "../src/origin.js";
import { PlaylistLimitError, rewriteOriginPlaylist } from "../src/playlist.js";
import { fetchWithSafeRedirects, handleResource } from "../src/resource.js";

const SECRET = "test-live-hls-proxy-secret-with-enough-length";
const NOW = 1_800_000_000;

test("Aether segments retain the resolver UA while other sources keep their existing UA", () => {
  assert.match(hlsUserAgent("https://aether.ist/"), /Chrome\/150 /);
  assert.match(hlsUserAgent("https://nextgencloudfabric.com/"), /Chrome\/150 /);
  for (const referer of [undefined, "", "https://cinejoy.pk/", "https://embed.st/"]) {
    assert.equal(hlsUserAgent(referer), BROWSER_UA);
  }
});

function signedWorkerUrl(input, referer = "", now = NOW) {
  const expires = now + 300;
  const url = new URL("https://live.example.workers.dev/api/live/hls-resource");
  url.searchParams.set("input", input);
  url.searchParams.set("externalEmbed", "1");
  url.searchParams.set("expires", String(expires));
  if (referer) url.searchParams.set("referer", referer);
  url.searchParams.set(
    "sig",
    createHmac("sha256", SECRET)
      .update(["streamarena-live-hls-v2", input, referer, String(expires)].join("\0"))
      .digest("base64url"),
  );
  return url;
}

test("Aether media keeps its signed referrer and Lul omits the language header that causes 403", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push(init.headers);
    return new Response("media", { headers: { "content-type": "video/mp2t" } });
  });
  for (const referer of ["https://aether.ist/", "https://nextgencloudfabric.com/", "https://cinejoy.pk/"]) {
    const url = signedWorkerUrl("https://cdn.example.com/segment.ts", referer, Math.floor(Date.now() / 1000));
    const response = await handleResource(new Request(url), url, { LIVE_HLS_PROXY_SECRET: SECRET });
    assert.equal(response.status, 200);
    const headers = requests.at(-1);
    assert.equal(headers.Referer, referer);
    assert.equal(headers["User-Agent"], hlsUserAgent(referer));
    assert.equal(headers["Accept-Language"], referer === "https://aether.ist/" ? undefined : "en-US,en;q=0.9");
    assert.equal(headers.Cookie, undefined);
  }
});

async function denied(input) {
  const result = await authorizeSignedRequest(
    signedWorkerUrl(input),
    { LIVE_HLS_PROXY_SECRET: SECRET },
    NOW,
  );
  assert.ok(result instanceof Response);
  return result.status;
}

test("signed egress still rejects insecure, internal and recursive targets", async () => {
  assert.equal(await denied("http://cdn.example.com/segment.ts"), 400);
  assert.equal(await denied("https://127.0.0.1/private"), 403);
  assert.equal(await denied("https://metadata.internal/private"), 403);
  assert.equal(
    await denied("https://live.example.workers.dev/api/live/hls-resource?loop=1"),
    403,
  );
});

test("origin configuration is an exact, credential-free origin", () => {
  assert.equal(normalizeOriginBase("https://streamarena.xyz/"), "https://streamarena.xyz");
  assert.equal(normalizeOriginBase("http://origin.example/"), "");
  assert.equal(
    normalizeOriginBase("http://origin.example/", { allowHttp: true }),
    "http://origin.example",
  );
  for (const unsafe of [
    "https://user:pass@origin.example/",
    "https://origin.example/path",
    "https://origin.example/?query=1",
    "https://localhost/",
    "https://127.0.0.1/",
  ]) {
    assert.equal(normalizeOriginBase(unsafe, { allowHttp: true }), "");
  }
});

test("playlist rewrite bounds line count, URI length and nested fan-out", () => {
  const normal = rewriteOriginPlaylist(
    "#EXTM3U\n/api/live/hls.m3u8?input=child\n/api/live/hls-resource?input=seg",
    "https://worker.example",
  );
  assert.match(normal, /https:\/\/worker\.example\/api\/live\/hls\.m3u8/);
  assert.match(normal, /viaOrigin=1/);

  const fanOut = ["#EXTM3U"];
  for (let index = 0; index < 65; index += 1) {
    fanOut.push(`/api/live/hls.m3u8?input=child-${index}`);
  }
  assert.throws(
    () => rewriteOriginPlaylist(fanOut.join("\n"), "https://worker.example"),
    PlaylistLimitError,
  );
  assert.throws(
    () =>
      rewriteOriginPlaylist(
        `/api/live/hls-resource?input=${"x".repeat(9_000)}`,
        "https://worker.example",
      ),
    PlaylistLimitError,
  );
});

test("bounded buffering rejects declared and streamed oversize bodies", async () => {
  await assert.rejects(
    readBoundedText(
      new Response("small", { headers: { "content-length": String(MAX_PLAYLIST_BYTES + 1) } }),
      MAX_PLAYLIST_BYTES,
    ),
    BodyLimitError,
  );
  await assert.rejects(
    readBoundedText(new Response("abcdef"), 5),
    BodyLimitError,
  );
});

test("redirects are manual, bounded and revalidated on every hop", async () => {
  const requested = [];
  const privateRedirect = async (url, init) => {
    requested.push({ url, redirect: init.redirect });
    return new Response(null, {
      status: 302,
      headers: { location: "https://127.0.0.1/private" },
    });
  };
  await assert.rejects(
    fetchWithSafeRedirects("https://cdn.example.com/start", {}, { fetcher: privateRedirect }),
    /unsafe redirect target/,
  );
  assert.deepEqual(requested, [
    { url: "https://cdn.example.com/start", redirect: "manual" },
  ]);

  const selfRedirect = async () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://live.example.workers.dev/api/live/hls-resource" },
    });
  await assert.rejects(
    fetchWithSafeRedirects("https://cdn.example.com/start", {}, {
      fetcher: selfRedirect,
      blockedHostname: "live.example.workers.dev",
    }),
    /unsafe redirect target/,
  );

  let hop = 0;
  const endless = async () => {
    hop += 1;
    return new Response(null, {
      status: 302,
      headers: { location: `https://cdn.example.com/hop-${hop}` },
    });
  };
  await assert.rejects(
    fetchWithSafeRedirects("https://cdn.example.com/start", {}, {
      fetcher: endless,
      maxRedirects: 2,
    }),
    /redirect limit exceeded/,
  );
});

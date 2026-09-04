import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCinejoy } from "./lib/resolve-cinejoy-hls.mjs";
import { CINEJOY_SERVERS, isCinejoyWatchUrl, isCinejoyPlaylistUrl,
  isCinejoySupportRequest, selectCinejoyServer } from "./lib/cinejoy-policy.mjs";

test("watch routes require an exact origin and numeric movie or episode identity", () => {
  for (const path of ["movie/27205", "tv/1396/1/2"]) assert.ok(isCinejoyWatchUrl(`https://cinejoy.to/watch/${path}`));
  for (const url of ["http://cinejoy.to/watch/movie/1", "https://cinejoy.to.evil.test/watch/movie/1",
    "https://user:pass@cinejoy.to/watch/movie/1", "https://cinejoy.to:8443/watch/movie/1",
    "https://cinejoy.to/watch/tv/1/0/1", "https://cinejoy.to/watch/movie/1?server=x",
    "https://127.0.0.1/watch/movie/1", "https://cinejoy.to/watch/movie/abc"]) assert.ok(!isCinejoyWatchUrl(url), url);
});

test("each pinned server accepts only its own master, never segments or another server", () => {
  const urls = { LISBON: "https://info.movieboxnoob.cc/playlist/abc.m3u8",
    NEBULA: "https://nebula.bright67.online/hls/abc/master.m3u8",
    SOLARA: "https://lol.movieboxnoob.cc/content?v=abc" };
  for (const [server, url] of Object.entries(urls)) {
    for (const key of Object.keys(CINEJOY_SERVERS)) assert.equal(isCinejoyPlaylistUrl(url, key), key === server);
    assert.ok(!isCinejoyPlaylistUrl(url.replace("https://", "https://user:secret@"), server));
    const malicious = new URL(url);
    malicious.hostname += ".evil.test";
    assert.ok(!isCinejoyPlaylistUrl(malicious.href, server));
  }
  assert.ok(!isCinejoyPlaylistUrl("https://info.movieboxnoob.cc/video/id/video_1080p.m3u8", "LISBON"));
  assert.ok(!isCinejoyPlaylistUrl("https://lol.movieboxnoob.cc/s?segment=x", "SOLARA"));
  assert.ok(!isCinejoyPlaylistUrl("https://lol.movieboxnoob.cc/content", "SOLARA"));
});

function fakeBrowser({ unavailable = false, timeout = false } = {}) {
  const state = { closed: 0, aborted: [], continued: [], selected: null, fetched: [] };
  let handler;
  const request = async (url, type = "fetch") => handler({
    request: () => ({ url: () => url, resourceType: () => type, method: () => "GET" }),
    abort: async () => { state.aborted.push(url); },
    continue: async () => { state.continued.push(url); },
    fetch: async () => { state.fetched.push(url); return { ok: () => true,
      json: async () => ({ servers: unavailable ? [] : Object.values(CINEJOY_SERVERS).map(name => ({ name, status: "ok" })) }) }; },
    fulfill: async ({ json }) => { state.selected = json; },
  });
  const page = {
    on() {}, route: async (_, callback) => { handler = callback; },
    goto: async () => {
      if (timeout) return;
      await request("https://api.shegu.st/servers");
      if (unavailable) return;
      await request("https://info.movieboxnoob.cc/playlist/wrong.m3u8");
      await request("https://nebula.bright67.online/hls/test/segment.ts", "media");
      await request("https://nebula.bright67.online/hls/test/master.m3u8");
    },
  };
  return { state, load: async () => ({ chromium: { launch: async () => ({
    newPage: async () => page, close: async () => { state.closed++; },
  }) } }) };
}

test("resolver pins the server, aborts every media request, and closes the browser", async () => {
  const fake = fakeBrowser();
  const result = await resolveCinejoy("https://cinejoy.to/watch/movie/27205", "NEBULA", 1000, fake.load);
  assert.equal(result.playbackUrl, "https://nebula.bright67.online/hls/test/master.m3u8");
  assert.equal(result.referer, "https://cinejoy.to/");
  assert.deepEqual(fake.state.selected, { servers: [{ name: "Nebula", status: "ok" }] });
  assert.deepEqual(fake.state.fetched, ["https://api.shegu.st/servers"]);
  assert.equal(fake.state.continued.length, 0);
  assert.equal(fake.state.aborted.length, 3);
  assert.equal(fake.state.closed, 1);
});

test("unavailable servers and timeout close the browser without switching providers", async () => {
  for (const scenario of [{ unavailable: true }, { timeout: true }]) {
    const fake = fakeBrowser(scenario);
    await assert.rejects(resolveCinejoy("https://cinejoy.to/watch/movie/27205", "NEBULA", 1000, fake.load));
    assert.equal(fake.state.closed, 1);
    assert.equal(fake.state.selected, null);
  }
});

test("discovery is pinned and unknown or unavailable servers fail closed", () => {
  const servers = Object.values(CINEJOY_SERVERS).map(name => ({ name, status: "ok" }));
  assert.deepEqual(selectCinejoyServer({ servers }, "NEBULA"), { servers: [servers[1]] });
  assert.throws(() => selectCinejoyServer({ servers }, "UNKNOWN"));
  assert.throws(() => selectCinejoyServer({ servers: [{ name: "Lisbon", status: "down" }] }, "LISBON"));
});

test("browser egress allows essential discovery only, with no media or analytics", () => {
  assert.ok(isCinejoySupportRequest("https://api.shegu.st/g", "fetch", "POST"));
  assert.ok(isCinejoySupportRequest("https://api.shegu.st/crush.wasm", "fetch"));
  assert.ok(isCinejoySupportRequest("https://cinejoy.to/_app/immutable/entry/app.hash.js", "script"));
  assert.ok(isCinejoySupportRequest("https://api.themoviedb.org/3/movie/1", "fetch"));
  for (const url of ["https://a.shegu.st/api/event", "https://api.shegu.st/unknown",
    "https://127.0.0.1/private", "https://api.shegu.st.evil.test/g",
    "https://info.movieboxnoob.cc/video/id/segment.html", "https://flagsapi.com/US/flat/64.png"]) {
    assert.ok(!isCinejoySupportRequest(url, "fetch", "GET"));
  }
});

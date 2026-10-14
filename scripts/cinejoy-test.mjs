import assert from "node:assert/strict";
import { test } from "node:test";
import { CinejoyResolver, resolveCinejoy } from "./lib/resolve-cinejoy-hls.mjs";
import { CINEJOY_SERVERS, isCinejoyWatchUrl, isCinejoyPlaylistUrl,
  isCinejoySupportRequest, selectCinejoyServer } from "./lib/cinejoy-policy.mjs";

test("watch routes require an exact origin and numeric movie or episode identity", () => {
  for (const path of ["movie/27205", "tv/1396/1/2"]) assert.ok(isCinejoyWatchUrl(`https://cinejoy.pk/watch/${path}`));
  for (const url of ["http://cinejoy.pk/watch/movie/1", "https://cinejoy.pk.evil.test/watch/movie/1", "https://cinejoy.to/watch/movie/1",
    "https://user:pass@cinejoy.pk/watch/movie/1", "https://cinejoy.pk:8443/watch/movie/1",
    "https://cinejoy.pk/watch/tv/1/0/1", "https://cinejoy.pk/watch/movie/1?server=x",
    "https://127.0.0.1/watch/movie/1", "https://cinejoy.pk/watch/movie/abc"]) assert.ok(!isCinejoyWatchUrl(url), url);
});

test("each pinned server accepts only its own master, never segments or another server", () => {
  const urls = { LISBON: "https://ok.solarpanelcleaning.cc/playlist/abc.m3u8",
    NEBULA: "https://nebula.bright67.online/hls/abc/master.m3u8",
    SOLARA: "https://asm.solarpanelcleaning.cc/content?v=abc" };
  for (const [server, url] of Object.entries(urls)) {
    for (const key of Object.keys(CINEJOY_SERVERS)) assert.equal(isCinejoyPlaylistUrl(url, key), key === server);
    assert.ok(!isCinejoyPlaylistUrl(url.replace("https://", "https://user:secret@"), server));
    const malicious = new URL(url);
    malicious.hostname += ".evil.test";
    assert.ok(!isCinejoyPlaylistUrl(malicious.href, server));
  }
  assert.ok(!isCinejoyPlaylistUrl("https://ok.solarpanelcleaning.cc/video/id/video_1080p.m3u8", "LISBON"));
  assert.ok(!isCinejoyPlaylistUrl("https://asm.solarpanelcleaning.cc/s?segment=x", "SOLARA"));
  assert.ok(!isCinejoyPlaylistUrl("https://asm.solarpanelcleaning.cc/content", "SOLARA"));
  assert.ok(!isCinejoyPlaylistUrl("https://info.movieboxnoob.cc/playlist/old.m3u8", "LISBON"));
  assert.ok(!isCinejoyPlaylistUrl("https://lol.movieboxnoob.cc/content?v=old", "SOLARA"));
  const lisbon = "https://lit.cheaptruckrepairs.cc/playlist/test.m3u8";
  assert.ok(isCinejoyPlaylistUrl(lisbon, "LISBON"));
  assert.ok(!isCinejoyPlaylistUrl(lisbon, "NEBULA"));
  assert.ok(!isCinejoyPlaylistUrl(lisbon, "SOLARA"));
  assert.ok(!isCinejoyPlaylistUrl(lisbon.replace(".cc/", ".cc.evil.test/"), "LISBON"));
  assert.ok(!isCinejoyPlaylistUrl("https://lit.cheaptruckrepairs.cc/video/id/video_1080p.m3u8", "LISBON"));
});

function fakeBrowser({ unavailable = false, timeout = false } = {}) {
  const state = { contexts: 0, contextsClosed: 0, launches: 0, connected: true, closed: 0, aborted: [], continued: [], selected: null, fetched: [] };
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
      await request("https://api.wing.st/servers");
      if (unavailable) return;
      await request("https://ok.solarpanelcleaning.cc/playlist/wrong.m3u8");
      await request("https://nebula.bright67.online/hls/test/segment.ts", "media");
      await request("https://nebula.bright67.online/hls/test/master.m3u8");
    },
  };
  return { state, load: async () => ({ chromium: { launch: async () => {
    state.launches++; state.connected = true;
    return {
      isConnected: () => state.connected,
      newContext: async () => { state.contexts++; return {
        newPage: async () => page,
        close: async () => { state.contextsClosed++; },
      }; },
      close: async () => { state.connected = false; state.closed++; },
    };
  } } }) };
}

test("resolver pins the server, aborts every media request, and closes the browser", async () => {
  const fake = fakeBrowser();
  const result = await resolveCinejoy("https://cinejoy.pk/watch/movie/27205", "NEBULA", 1000, fake.load);
  assert.equal(result.playbackUrl, "https://nebula.bright67.online/hls/test/master.m3u8");
  assert.equal(result.referer, "https://cinejoy.pk/");
  assert.deepEqual(fake.state.selected, { servers: [{ name: "Nebula", status: "ok" }] });
  assert.deepEqual(fake.state.fetched, ["https://api.wing.st/servers"]);
  assert.equal(fake.state.continued.length, 0);
  assert.equal(fake.state.aborted.length, 3);
  assert.equal(fake.state.closed, 1);
});

test("unavailable servers and timeout close the browser without switching providers", async () => {
  for (const scenario of [{ unavailable: true }, { timeout: true }]) {
    const fake = fakeBrowser(scenario);
    await assert.rejects(resolveCinejoy("https://cinejoy.pk/watch/movie/27205", "NEBULA", 1000, fake.load));
    assert.equal(fake.state.closed, 1);
    assert.equal(fake.state.selected, null);
  }
});

test("discovery is pinned and unknown or unavailable servers fail closed", () => {
  const servers = Object.values(CINEJOY_SERVERS).map(name => ({ name, status: "ok" }));
  assert.deepEqual(selectCinejoyServer({ servers }, "NEBULA"), { servers: [servers[1]] });
  assert.throws(() => selectCinejoyServer({ servers }, "UNKNOWN"));
  assert.throws(() => selectCinejoyServer({ servers: [{ name: "Athens", status: "ok" }] }, "ATHENS"));
  assert.throws(() => selectCinejoyServer({ servers: [{ name: "Lisbon", status: "down" }] }, "LISBON"));
});

test("browser egress allows essential discovery only, with no media or analytics", () => {
  assert.ok(isCinejoySupportRequest("https://api.wing.st/g", "fetch", "POST"));
  assert.ok(isCinejoySupportRequest("https://api.wing.st/crush.wasm", "fetch"));
  assert.ok(isCinejoySupportRequest("https://cinejoy.pk/_app/immutable/entry/app.hash.js", "script"));
  assert.ok(isCinejoySupportRequest("https://api.themoviedb.org/3/movie/1", "fetch"));
  for (const url of ["https://a.wing.st/api/event", "https://api.shegu.st/servers", "https://api.wing.st/unknown",
    "https://127.0.0.1/private", "https://api.wing.st.evil.test/g",
    "https://ok.solarpanelcleaning.cc/video/id/segment.html", "https://flagsapi.com/US/flat/64.png"]) {
    assert.ok(!isCinejoySupportRequest(url, "fetch", "GET"));
  }
});


test("warm browser uses fresh contexts and restarts after browser disconnect", async () => {
  const fake = fakeBrowser();
  const resolver = new CinejoyResolver(fake.load);
  for (const id of [27205, 157336]) {
    const result = await resolver.resolve(`https://cinejoy.pk/watch/movie/${id}`, "NEBULA", 1000);
    assert.equal(result.referer, "https://cinejoy.pk/");
  }
  assert.equal(fake.state.launches, 1);
  assert.equal(fake.state.contexts, 2);
  assert.equal(fake.state.contextsClosed, 2);
  fake.state.connected = false;
  await resolver.resolve("https://cinejoy.pk/watch/movie/872585", "NEBULA", 1000);
  assert.equal(fake.state.launches, 2);
  assert.equal(fake.state.contextsClosed, 3);
  await resolver.close();
  await assert.rejects(resolver.resolve("https://cinejoy.pk/watch/movie/27205", "NEBULA", 1000));
});

test("a worker never mixes simultaneous server requests", async () => {
  const fake = fakeBrowser({ timeout: true });
  const resolver = new CinejoyResolver(fake.load);
  const first = resolver.resolve("https://cinejoy.pk/watch/movie/27205", "NEBULA", 1000);
  await assert.rejects(resolver.resolve("https://cinejoy.pk/watch/movie/157336", "LISBON", 1000), /unavailable/);
  await assert.rejects(first, /timed out/);
  assert.equal(fake.state.contexts, 1);
  assert.equal(fake.state.contextsClosed, 1);
  await resolver.close();
});

import { CinejoyAssetCache } from "./lib/cinejoy-asset-cache.mjs";

test("asset reuse excludes provider state, media and mutable URLs and never replays cookies", () => {
  const cache = new CinejoyAssetCache();
  const url = "https://cinejoy.pk/_app/immutable/chunks/BHL3aMHr.js";
  for (const forbidden of ["https://api.wing.st/crush.wasm", "https://api.wing.st/servers", "https://api.wing.st/g",
    "https://cinejoy.pk/watch/movie/1", `${url}?session=one`, url.replace("cinejoy.pk", "evil.test"),
    url.replace("BHL3aMHr", "app"), "https://nebula.bright67.online/hls/test/master.m3u8"]) {
    assert.equal(cache.accepts(forbidden), false, forbidden);
  }
  const headers = { "cache-control": "public, max-age=31536000, immutable", "content-type": "application/javascript",
    "set-cookie": "secret=one", "content-encoding": "gzip", "content-length": "1", "connection": "keep-alive" };
  assert.equal(cache.put(url, headers, Buffer.from("public script")), true);
  assert.deepEqual(cache.get(url).headers, { "cache-control": headers["cache-control"], "content-type": "application/javascript" });
  for (const changed of [{ "cache-control": "private, max-age=100, immutable" },
    { "cache-control": "public, max-age=100" }, { "cache-control": "public, max-age=0, immutable" },
    { vary: "Cookie" }, { age: "31536000" }, { "content-type": "text/html" }]) {
    assert.equal(cache.put(url, { ...headers, ...changed }, Buffer.from("no")), false);
  }
});

test("public assets expire and the cache is bounded by bytes and entries", () => {
  let now = 100;
  const cache = new CinejoyAssetCache({ maxBytes: 6, maxEntries: 2, ttlMs: 50, now: () => now });
  const headers = { "cache-control": "public, max-age=100, immutable", "content-type": "text/css" };
  const url = n => `https://cinejoy.pk/_app/immutable/assets/style.abcdefgh${n}.css`;
  assert.ok(cache.put(url(1), headers, Buffer.from("123")));
  assert.ok(cache.put(url(2), headers, Buffer.from("456")));
  assert.ok(cache.put(url(3), headers, Buffer.from("789")));
  assert.equal(cache.get(url(1)), null);
  assert.equal(cache.bytes, 6);
  assert.equal(cache.put(url(4), headers, Buffer.alloc(7)), false);
  now += 51;
  assert.equal(cache.get(url(2)), null);
  assert.equal(cache.get(url(3)), null);
  assert.equal(cache.bytes, 0);
});

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function fakeWorker(t, { idleMs = 1000, maxRequests = 100 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "cinejoy-worker-test-"));
  const moduleUrl = new URL("./lib/cinejoy-worker.mjs", import.meta.url).href;
  const fixture = join(dir, "worker.mjs");
  const marker = join(dir, "closed");
  await writeFile(fixture, `import { serveCinejoyWorker } from ${JSON.stringify(moduleUrl)};
    import { writeFile } from 'node:fs/promises';
    await serveCinejoyWorker({ idleMs: ${idleMs}, maxRequests: ${maxRequests}, resolver: {
      resolve: async (url, server) => {
        if (url === 'stall') return new Promise(() => {});
        return { playbackUrl: 'https://fixture.test/master.m3u8', referer: 'https://cinejoy.pk/', server };
      },
      close: async () => { await writeFile(${JSON.stringify(marker)}, 'closed'); },
    } });`);
  const child = spawn(process.execPath, [fixture], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  t.after(async () => { child.kill(); await rm(dir, { recursive: true, force: true }); });
  const lines = [], waiters = []; let pending = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    pending += chunk; let i;
    while ((i = pending.indexOf("\n")) !== -1) {
      const value = JSON.parse(pending.slice(0, i)); pending = pending.slice(i + 1);
      const waiter = waiters.shift(); if (waiter) waiter(value); else lines.push(value);
    }
  });
  return { child, exited, marker,
    send: (id, watchUrl = "fixture", server = "NEBULA") => child.stdin.write(`${JSON.stringify({id, watchUrl, server, timeoutMs: 500})}\n`),
    next: () => lines.length ? Promise.resolve(lines.shift()) : new Promise(resolve => waiters.push(resolve)) };
}

test("worker returns correlated replies and marks retirement before closing", { timeout: 4000 }, async t => {
  const worker = await fakeWorker(t, { maxRequests: 2 });
  worker.send(1); const first = await worker.next();
  worker.send(2, "fixture", "LISBON"); const second = await worker.next();
  assert.equal(first.id, 1); assert.equal(first.retire, false);
  assert.equal(second.id, 2); assert.equal(second.retire, true);
  assert.equal(second.result.server, "LISBON");
  assert.equal((await worker.exited)[0], 0);
  assert.equal(await readFile(worker.marker, "utf8"), "closed");
});

test("EOF cancels a hung active request and closes its browser immediately", { timeout: 4000 }, async t => {
  const worker = await fakeWorker(t);
  worker.send(1, "stall");
  worker.child.stdin.end();
  assert.equal((await worker.exited)[0], 0);
  assert.equal(await readFile(worker.marker, "utf8"), "closed");
});

test("worker rejects oversized or concurrent requests instead of buffering an unbounded queue", { timeout: 4000 }, async t => {
  for (const message of ["x".repeat(4097),
    `${JSON.stringify({ id: 1, watchUrl: "stall", server: "NEBULA", timeoutMs: 500 })}\n` +
    `${JSON.stringify({ id: 2, watchUrl: "fixture", server: "LISBON", timeoutMs: 500 })}\n`]) {
    const worker = await fakeWorker(t);
    worker.child.stdin.write(message);
    assert.equal((await worker.exited)[0], 2);
    assert.equal(await readFile(worker.marker, "utf8"), "closed");
  }
});

test("idle worker exits and releases its browser", { timeout: 4000 }, async t => {
  const worker = await fakeWorker(t, { idleMs: 30 });
  assert.equal((await worker.exited)[0], 0);
  assert.equal(await readFile(worker.marker, "utf8"), "closed");
});

test("context creation is inside the resolve deadline, and a failed browser is retired", { timeout: 3000 }, async () => {
  let closed = 0;
  const resolver = new CinejoyResolver(async () => ({ chromium: { launch: async () => ({
    isConnected: () => true,
    newContext: () => new Promise(() => {}),
    close: async () => { closed++; },
  }) } }));
  const start = Date.now();
  await assert.rejects(resolver.resolve("https://cinejoy.pk/watch/movie/27205", "NEBULA", 1000), /timed out/);
  assert.ok(Date.now() - start < 1800);
  assert.equal(closed, 1);
  assert.equal(resolver.browser, null);
  await resolver.close();
});

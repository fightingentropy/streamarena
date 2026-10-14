const assert = require("node:assert/strict");
const test = require("node:test");
const { videoHarness } = require("./helpers/video-harness");

const query = new URLSearchParams({
  input: "https://cdn.example/master.m3u8", referer: "https://cinejoy.to/",
  externalEmbed: "1", expires: "2000000000", sig: "fixture-signature",
});
const route = (host) => `https://${host}/api/live/hls.m3u8?${query}`;
const direct = route("media.streamarena.xyz");
const worker = route("live.streamarena.xyz");
const app = route("streamarena.xyz");
const resolved = { playableUrl: worker, directMediaUrls: [direct], fallbackUrls: [app], sourceHash: "fixture" };
const media = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\n/api/live/hls-resource?input=fragment&expires=2000000000&sig=fixture\n#EXT-X-ENDLIST\n";

const settled = () => new Promise((resolve) => setImmediate(resolve));
function noTimers() { return 1; }

test("signed direct → Worker → app is additive, deduplicated, and keeps private grants private", () => {
  const { mediaDeliveryUrls } = videoHarness().load("media-delivery");
  assert.deepEqual(Array.from(mediaDeliveryUrls(worker, [app, worker], [direct, direct])), [direct, worker, app]);
  const invalid = [
    direct.replace("https:", "http:"), direct.replace("fixture-signature", "other"),
    direct.replace("2000000000", "2000000001"), `${direct}&privateSession=1`,
    direct.replace("https://media.", "https://user:secret@media."),
    direct.replace("externalEmbed=1", "externalEmbed=0"),
  ];
  assert.deepEqual(Array.from(mediaDeliveryUrls(worker, [app], invalid)), [worker, app]);
  assert.deepEqual(Array.from(mediaDeliveryUrls(`${app}&privateSession=session`, [], [direct])), [`${app}&privateSession=session`]);
  assert.deepEqual(Array.from(mediaDeliveryUrls("file:///offline.mp4", [], [direct])), ["file:///offline.mp4"]);
  assert.deepEqual(Array.from(mediaDeliveryUrls(worker, [app])), [worker, app]);
});

test("routing and repeated fallback planning retain distinct stable relay mappings", async () => {
  const fetched = [];
  const h = videoHarness({ fetcher: async (url, init) => { fetched.push({ url, init }); return new Response(media); } });
  const proxy = h.load("strip-proxy");
  await proxy.ensureStripProxy();
  proxy.beginStripProxySession();
  const primary = h.load("routing").decideSource(resolved);
  const fallbacks = h.load("refresh").buildFallbackCandidates(resolved);
  assert.equal(fallbacks.length, 2);
  assert.equal(new Set([primary.uri, ...fallbacks.map((s) => s.uri)]).size, 3);
  assert.deepEqual(h.load("refresh").buildFallbackCandidates(resolved), fallbacks);
  for (const source of [primary, ...fallbacks]) {
    const output = [];
    await proxy.serve({ write: (bytes) => output.push(Buffer.from(bytes)) }, new URL(source.uri).pathname + new URL(source.uri).search, null);
    assert.match(Buffer.concat(output).toString(), /200 OK/);
  }
  assert.deepEqual(fetched.map((r) => r.url), [direct, worker, app]);
  assert.deepEqual(fetched.map((r) => r.init.credentials), ["omit", "omit", "include"]);
});

test("relative direct playlist children stay on the direct host and omit credentials", async () => {
  const fetched = [];
  const h = videoHarness({ fetcher: async (url, init) => {
    fetched.push({ url, init });
    return new Response(url.includes("hls-resource") ? Buffer.from([0x47, 1, 2, 3]) : media);
  } });
  const proxy = h.load("strip-proxy");
  await proxy.ensureStripProxy();
  const url = proxy.stripProxyMasterUrl(8771, direct, "https://cinejoy.to/");
  const writes = [];
  await proxy.serve({ write: (data) => writes.push(Buffer.from(data)) }, new URL(url).pathname + new URL(url).search, null);
  const child = Buffer.concat(writes).toString().match(/http:\/\/127\.0\.0\.1:8771\/s\?id=\d+/)[0];
  await proxy.serve({ write() {} }, new URL(child).pathname + new URL(child).search, null);
  assert.equal(new URL(fetched[1].url).host, "media.streamarena.xyz");
  assert.equal(fetched[1].init.credentials, "omit");
});

test("a new session invalidates old IDs and late playlist responses cannot repopulate mappings", async () => {
  let finish;
  const proxy = videoHarness({ fetcher: () => new Promise((r) => { finish = r; }) }).load("strip-proxy");
  await proxy.ensureStripProxy();
  const old = proxy.stripProxyMasterUrl(8771, direct);
  const output = [];
  const pending = proxy.serve({ write: (data) => output.push(Buffer.from(data)) }, new URL(old).pathname + new URL(old).search, null);
  proxy.beginStripProxySession();
  const next = proxy.stripProxyMasterUrl(8771, worker);
  assert.notEqual(next, old);
  finish(new Response(media));
  await pending;
  assert.match(Buffer.concat(output).toString(), /410 Error/);
  const stale = [];
  await proxy.serve({ write: (data) => stale.push(Buffer.from(data)) }, new URL(old).pathname + new URL(old).search, null);
  assert.match(Buffer.concat(stale).toString(), /400 Error/);
});

test("a relay body timeout remains armed after headers and moves on without redundant retries", async () => {
  let fetchCount = 0;
  const proxy = videoHarness({
    timer: (cb) => setTimeout(cb, 5),
    fetcher: async (_url, init) => {
      fetchCount += 1;
      return { ok: true, text: () => new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("body timed out")));
      }) };
    },
  }).load("strip-proxy");
  await assert.rejects(proxy.fetchText(direct, ""), /body timed out/);
  assert.equal(fetchCount, 1);
});

test("expired/forbidden media fails promptly rather than retrying the same authorization", async () => {
  for (const status of [401, 403]) {
    let requests = 0;
    const proxy = videoHarness({ fetcher: async () => { requests += 1; return new Response("denied", { status }); } }).load("strip-proxy");
    await assert.rejects(proxy.fetchText("https://cdn.example/master.m3u8", ""), new RegExp(String(status)));
    assert.equal(requests, 1);
  }
});

test("missing origin skips relay retries and re-resolve, retains a newer seek and pause", async () => {
  let finishSources;
  const sourceList = new Promise(resolve => { finishSources = resolve; });
  let fetchCount = 0;
  const h = videoHarness({
    timer: noTimers, clearTimer() {},
    fetcher: async () => { fetchCount++; return new Response("missing", { status: 424 }); },
    services: {
      resolveTitle: async params => ({ ...resolved, sourceHash: params.sourceHash || "lisbon" }),
      getSources: () => sourceList,
    },
  });
  const module = h.load("state");
  const store = module.usePlayerStore;
  const proxy = h.load("strip-proxy");
  const seeks = [];
  module.registerSeek(seconds => seeks.push(seconds));
  await store.getState().open({ tmdbId: "157336", mediaType: "movie" });
  const first = store.getState().source;
  store.getState().onLoad(1000, first);
  store.getState().seekTo(600);
  store.getState().pause();
  const broken = "/s?" + new URLSearchParams({ u: "https://media.streamarena.xyz/api/live/hls-resource?input=missing" });
  await proxy.serve({ write() {} }, broken, null);
  assert.equal(store.getState().status, "resolving", "relay must notify even when VLC does not emit an error");
  assert.equal(store.getState().source, null);
  store.getState().seekTo(720);
  await proxy.serve({ write() {} }, broken, null);
  store.getState().onError("late old engine error", first);
  finishSources({ sources: [{ sourceHash: "miami", isTorrent: false }, { sourceHash: "lisbon", isTorrent: false }] });
  await settled();
  const replacement = store.getState().source;
  store.getState().onLoad(1000, replacement);
  assert.equal(store.getState().selectedSourceHash, "miami");
  assert.equal(store.getState().position, 720);
  assert.equal(store.getState().paused, true);
  assert.equal(seeks.at(-1), 720);
  assert.equal(h.requests.length, 2, "no duplicate resolve or refresh of Lisbon");
  assert.equal(h.requests[1].refreshResolve, undefined);
  assert.equal(h.reports.length, 1);
  assert.equal(fetchCount, 2, "each missing request is attempted only once");
  assert.equal(proxy.hasUnavailableStripProxyMedia(replacement.uri), false);
  store.getState().close();
});

test("a late missing-origin response cannot fail a new relay session", async () => {
  let finish;
  const proxy = videoHarness({ fetcher: () => new Promise(resolve => { finish = resolve; }) }).load("strip-proxy");
  await proxy.ensureStripProxy();
  proxy.beginStripProxySession();
  let notified = 0;
  proxy.setStripProxyUnavailableHandler(() => { notified++; });
  const pending = proxy.serve({ write() {} }, "/s?u=" + encodeURIComponent("https://media.streamarena.xyz/api/live/hls-resource?input=old"), null);
  proxy.beginStripProxySession();
  const next = proxy.stripProxyMasterUrl(8771, direct);
  finish(new Response("missing", { status: 424 }));
  await pending;
  assert.equal(notified, 0);
  assert.equal(proxy.hasUnavailableStripProxyMedia(next), false);
});

async function playerFixture(options = {}, timers = {}) {
  const h = videoHarness({
    timer: noTimers, clearTimer() {}, ...timers,
    services: { resolveTitle: async () => resolved, ...options },
  });
  const module = h.load("state");
  const store = module.usePlayerStore;
  const seeks = [];
  module.registerSeek((seconds) => seeks.push(seconds));
  await store.getState().open({ tmdbId: "157336", mediaType: "movie" });
  await settled();
  return { h, store, seeks };
}

test("VOD transport fallbacks preserve pause and pending seek through early failures, ignore stale callbacks", async () => {
  const { store, seeks, h } = await playerFixture();
  const first = store.getState().source;
  store.getState().onLoad(1000, first);
  store.getState().seekTo(400);
  store.getState().pause();
  store.getState().onError("direct unavailable", first);
  const second = store.getState().source;
  assert.notEqual(second.uri, first.uri);
  assert.equal(store.getState().paused, true);
  assert.equal(store.getState().loaded, false);
  store.getState().onError("late duplicate", first);
  store.getState().onLoad(1000, first);
  store.getState().setProgress(1, 1000, first);
  assert.equal(store.getState().source, second);
  assert.equal(store.getState().loaded, false);
  assert.equal(store.getState().position, 400);
  store.getState().setProgress(0, 1000, second);
  store.getState().onError("Worker unavailable", second);
  const third = store.getState().source;
  store.getState().onLoad(1000, third);
  assert.equal(store.getState().position, 400);
  assert.equal(store.getState().paused, true);
  assert.equal(store.getState().status, "paused");
  assert.equal(seeks.at(-1), 400);
  assert.equal(h.requests.length, 1);
  assert.equal(h.reports.length, 0);
});

test("a manual backward seek during fallback supersedes the saved resume target", async () => {
  const { store, seeks } = await playerFixture();
  store.getState().onLoad(1000, store.getState().source);
  store.getState().seekTo(600);
  store.getState().onError("direct unavailable", store.getState().source);
  store.getState().seekTo(120);
  store.getState().onLoad(1000, store.getState().source);
  assert.equal(seeks.at(-1), 120);
  assert.equal(store.getState().position, 120);
});

test("an accepted native seek remains pending until progress confirms it across route failures", async () => {
  const { store, seeks } = await playerFixture();
  const first = store.getState().source;
  store.getState().onLoad(1000, first);
  store.getState().seekTo(400);
  store.getState().setProgress(400, 1000, first);
  store.getState().onError("direct unavailable", first);
  const second = store.getState().source;
  store.getState().onLoad(1000, second);
  assert.equal(seeks.at(-1), 400);
  store.getState().setProgress(0, 1000, second);
  assert.equal(store.getState().pendingSeekSeconds, 400);
  store.getState().onError("Worker failed before seek completed", second);
  assert.equal(store.getState().resumeSeconds, 400);
  const third = store.getState().source;
  store.getState().onLoad(1000, third);
  assert.equal(seeks.at(-1), 400);
  store.getState().setProgress(400, 1000, third);
  assert.equal(store.getState().pendingSeekSeconds, null);
  store.getState().setProgress(401, 1000, third);
  assert.equal(store.getState().position, 401);
});

test("nearby coarse keyframe landing confirms after natural advancement", async () => {
  const { store } = await playerFixture();
  const source = store.getState().source;
  store.getState().onLoad(1000, source);
  store.getState().seekTo(400);
  store.getState().setProgress(403, 1000, source);
  assert.equal(store.getState().pendingSeekSeconds, 400);
  store.getState().setProgress(404, 1000, source);
  store.getState().setProgress(405, 1000, source);
  assert.equal(store.getState().pendingSeekSeconds, null);
  assert.equal(store.getState().position, 405);
});

test("a far-off failed seek has a deadline and keeps its target for the next route", async () => {
  let now = 1000;
  const timers = controlledTimers();
  const { store } = await playerFixture({}, { ...timers, clock: { now: () => now } });
  const first = store.getState().source;
  store.getState().onLoad(1000, first);
  store.getState().seekTo(400);
  store.getState().setProgress(0, 1000, first);
  store.getState().setProgress(1, 1000, first);
  assert.equal(store.getState().pendingSeekSeconds, 400);
  assert.equal(timers.count(), 1);
  now += 10_001;
  store.getState().setProgress(2, 1000, first);
  assert.notEqual(store.getState().source.uri, first.uri);
  assert.equal(store.getState().resumeSeconds, 400);
});

test("a single live source tries direct → Worker → app without another provider resolve", async () => {
  let resolves = 0;
  const { store } = await playerFixture({ resolveSportStream: async () => {
    resolves += 1;
    return { playbackUrl: worker, directMediaUrls: [direct], transportFallbackUrls: [app] };
  } });
  await store.getState().openLive({ id: "sky", title: "Sky", sources: [{ id: "one", label: "One", sports: { url: "fixture" } }] });
  assert.equal(store.getState().source.uri, direct);
  store.getState().onStall(); // no native error from a blackholed direct host
  assert.equal(store.getState().source.uri, worker);
  store.getState().onError("Worker failed", store.getState().source);
  assert.equal(store.getState().source.uri, app);
  assert.equal(store.getState().selectedLiveSourceId, "one");
  assert.equal(resolves, 1);
  store.getState().onLoad(0, store.getState().source);
  assert.equal(store.getState().resumeSeconds, 0);
  store.getState().onError("app failed", store.getState().source);
  assert.equal(store.getState().status, "error");
  assert.equal(resolves, 1);
});

test("an aborted old live resolve cannot replace a newer source or its fallback queue", async () => {
  let oldResolve;
  const { store } = await playerFixture({ resolveSportStream: async (url) => {
    if (url === "slow") return new Promise((r) => { oldResolve = r; });
    return { playbackUrl: worker, directMediaUrls: [direct], transportFallbackUrls: [app] };
  } });
  const pending = store.getState().openLive({ id: "old", title: "Old", sources: [{ id: "old", label: "Old", sports: { url: "slow" } }] });
  await store.getState().openLive({ id: "new", title: "New", sources: [{ id: "new", label: "New", sports: { url: "fast" } }] });
  oldResolve({ playbackUrl: "https://obsolete.example/old.m3u8" });
  await pending;
  assert.equal(store.getState().selectedLiveSourceId, "new");
  assert.equal(store.getState().source.uri, direct);
  assert.deepEqual(Array.from(store.getState().fallbackSources, (s) => s.uri), [worker, app]);
});

test("deep resume alone cannot reset the exhausted provider recovery budget", async () => {
  const { store } = await playerFixture();
  store.setState({ reresolved: true, errorCount: 1 });
  const source = store.getState().source;
  store.getState().onLoad(1000, source);
  store.getState().setProgress(600, 1000, source);
  store.getState().setProgress(600, 1000, source);
  assert.equal(store.getState().reresolved, true);
  for (let pos = 601; pos <= 632; pos++) store.getState().setProgress(pos, 1000, source);
  assert.equal(store.getState().reresolved, false);
});

function controlledTimers() {
  const pending = new Map();
  let seq = 0;
  return {
    timer(fn) { pending.set(++seq, fn); return seq; },
    clearTimer(id) { pending.delete(id); },
    count() { return pending.size; },
    fire() {
      const [id, fn] = [...pending].at(-1);
      pending.delete(id);
      fn();
    },
  };
}

test("a seek jump with no subsequent playback cannot dismiss the startup watchdog", async () => {
  const timers = controlledTimers();
  const { store } = await playerFixture({}, timers);
  const first = store.getState().source;
  store.getState().setProgress(0, 1000, first);
  store.getState().onLoad(1000, first);
  store.getState().seekTo(600);
  store.getState().setProgress(600, 1000, first);
  store.getState().setProgress(600, 1000, first);
  assert.equal(timers.count(), 1);
  timers.fire();
  assert.notEqual(store.getState().source.uri, first.uri);
  assert.equal(store.getState().resumeSeconds, 600);
});

test("live parsing alone keeps the watchdog armed; pause and real advancement control it", async () => {
  const timers = controlledTimers();
  const { store } = await playerFixture({ resolveSportStream: async () => ({
    playbackUrl: worker, directMediaUrls: [direct], transportFallbackUrls: [app],
  }) }, timers);
  await store.getState().openLive({ id: "sky", title: "Sky", sources: [{ id: "one", label: "One", sports: { url: "fixture" } }] });
  const source = store.getState().source;
  store.getState().onLoad(0, source);
  store.getState().setProgress(0, 0, source);
  assert.equal(timers.count(), 1);
  store.getState().pause();
  assert.equal(timers.count(), 0);
  store.getState().play();
  assert.equal(timers.count(), 1);
  store.getState().setProgress(0, 0, source);
  store.getState().setProgress(1, 0, source);
  assert.equal(timers.count(), 0);
});

test("an aborted VOD resolve cannot reset the newer title's relay mappings", async () => {
  let oldResolve;
  const h = videoHarness({
    timer: noTimers, clearTimer() {}, fetcher: async () => new Response(media),
    services: { resolveTitle: async (params) => params.tmdbId === "old"
      ? new Promise((r) => { oldResolve = r; }) : resolved },
  });
  const store = h.load("state").usePlayerStore;
  const old = store.getState().open({ tmdbId: "old", mediaType: "movie" });
  await store.getState().open({ tmdbId: "new", mediaType: "movie" });
  const current = store.getState().source;
  oldResolve({ ...resolved, playableUrl: app });
  await old;
  assert.equal(store.getState().source, current);
  const writes = [];
  const url = new URL(current.uri);
  await h.load("strip-proxy").serve({ write: (bytes) => writes.push(Buffer.from(bytes)) }, url.pathname + url.search, null);
  assert.match(Buffer.concat(writes).toString(), /200 OK/);
});

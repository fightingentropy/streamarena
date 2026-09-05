const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

const origin = "https://streamarena.xyz";
function loadRouting(port) {
  const compiled = ts.transpileModule(
    readFileSync(join(__dirname, "../src/video/routing.ts"), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } },
  ).outputText;
  const mod = { exports: {} };
  const deps = {
    "@/lib/config": { toAbsoluteApiUrl: (url) => new URL(url, origin).href },
    "@/lib/streamarena": {
      buildHlsMasterUrl: (url, audio) => `/api/hls/master.m3u8?input=${encodeURIComponent(url)}&audioStream=${audio}`,
    },
    "./strip-proxy": {
      getStripProxyPort: () => port,
      stripProxyMasterUrl: (p, url, ref) => `http://127.0.0.1:${p}/m?u=${encodeURIComponent(url)}&ref=${encodeURIComponent(ref)}`,
    },
  };
  runInNewContext(compiled, { exports: mod.exports, module: mod, URL, require: (id) => deps[id] });
  return mod.exports;
}

const cinejoy = "/api/live/hls.m3u8?url=https%3A%2F%2Finfo.movieboxnoob.cc%2Fmaster.m3u8&referer=https%3A%2F%2Fcinejoy.to%2F&exp=123&sig=signed";

test("CineJoy preserves the signed adaptive HLS ladder for native playback, with or without a strip proxy", () => {
  for (const port of [null, 8771]) {
    const { decideSource } = loadRouting(port);
    const source = decideSource({ playableUrl: cinejoy });
    assert.equal(source.uri, origin + cinejoy);
    assert.equal(source.isHls, true);
    assert.notEqual(source.engine, "vlc");
  }
});

test("other embed providers retain their VLC strip-proxy route", () => {
  const { decideSource } = loadRouting(8771);
  const url = cinejoy.replace("cinejoy.to", "another.example");
  const source = decideSource({ playableUrl: url });
  assert.equal(source.engine, "vlc");
  assert.equal(new URL(source.uri).searchParams.get("ref"), "https://another.example/");
});

test("an explicit CineJoy audio-stream choice still uses the server audio route", () => {
  const source = loadRouting(8771).decideSource({ playableUrl: cinejoy }, 2);
  assert.equal(new URL(source.uri).pathname, "/api/hls/master.m3u8");
  assert.equal(new URL(source.uri).searchParams.get("audioStream"), "2");
});

test("the native exception requires the exact CineJoy referer and the HLS playlist route", () => {
  const { isCineJoyHls } = loadRouting(null);
  assert.equal(isCineJoyHls(cinejoy), true);
  assert.equal(isCineJoyHls(cinejoy.replace("cinejoy.to", "cinejoy.to.example")), false);
  assert.equal(isCineJoyHls(cinejoy.replace("hls.m3u8", "hls-resource")), false);
  assert.equal(isCineJoyHls("https://example.com/video.mp4?referer=https://cinejoy.to/"), false);
});

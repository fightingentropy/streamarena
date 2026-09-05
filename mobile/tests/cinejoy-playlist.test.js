const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="audio.m3u8"\n'
  + '#EXT-X-STREAM-INF:BANDWIDTH=20000000,RESOLUTION=3840x2160,VIDEO-RANGE=PQ,CODECS="hvc1.2.4.L150.B0,mp4a.40.2",AUDIO="audio"\n4k.m3u8\n'
  + '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,AUDIO="audio"\n1080.m3u8\n';
const media = '#EXTM3U\n#EXTINF:10,\nsegment.ts\n#EXT-X-ENDLIST';

function loadProxy(fetcher) {
  const source = readFileSync(join(__dirname, "../src/video/strip-proxy.ts"), "utf8");
  const compiled = ts.transpileModule(source + '\nexport { resolveToMediaPlaylist, rewritePlaylist, serve };', {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod = { exports: {} };
  runInNewContext(compiled, {
    module: mod, exports: mod.exports, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: fetcher,
    require: (id) => id === "buffer" ? { Buffer } : id === "@/lib/config" ? { API_ORIGIN: "https://streamarena.xyz" } : {},
  });
  return mod.exports;
}

test("CineJoy retains 4K/HDR and external audio through the device playlist rewrite", async () => {
  const requests = [];
  const proxy = loadProxy(async (url, init) => {
    requests.push({ url, init });
    return new Response(master);
  });
  const result = await proxy.resolveToMediaPlaylist("https://cdn.example/master.m3u8", "https://cinejoy.to/");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.headers.Referer, "https://cinejoy.to/");
  assert.equal(requests[0].init.credentials, "omit");
  assert.equal(result.text, master);
  const rewritten = proxy.rewritePlaylist(result.text, result.baseUrl, "https://cinejoy.to/", 8771);
  assert.match(rewritten, /RESOLUTION=3840x2160,VIDEO-RANGE=PQ/);
  assert.match(rewritten, /hvc1\.2\.4\.L150\.B0/);
  assert.match(rewritten, /TYPE=AUDIO,GROUP-ID="audio",URI="http:\/\/127\.0\.0\.1:8771\/m\?mid=\d+"/);
  assert.equal(rewritten.match(/#EXT-X-STREAM-INF/g).length, 2);
});

test("other embeds retain the existing highest-variant workaround", async () => {
  const requests = [];
  const proxy = loadProxy(async (url) => {
    requests.push(url);
    return new Response(requests.length === 1 ? master : media);
  });
  const result = await proxy.resolveToMediaPlaylist("https://cdn.example/master.m3u8", "https://another.example/");
  assert.deepEqual(requests, ["https://cdn.example/master.m3u8", "https://cdn.example/4k.m3u8"]);
  assert.equal(result.text, media);
});

test("the device relay serves fMP4 with its media type and preserves the bytes", async () => {
  const fragment = Buffer.from([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 53]);
  const proxy = loadProxy(async () => new Response(fragment));
  const writes = [];
  await proxy.serve({ write: (chunk) => writes.push(Buffer.from(chunk)) }, "/s?u=https%3A%2F%2Fcdn.example%2Finit.html", null);
  const response = Buffer.concat(writes);
  const split = response.indexOf("\r\n\r\n");
  assert.match(response.subarray(0, split).toString(), /Content-Type: video\/mp4/);
  assert.deepEqual(response.subarray(split + 4), fragment);
});

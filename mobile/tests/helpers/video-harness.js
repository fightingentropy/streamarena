const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");

// Runs the production TypeScript routing/store/playlist code with only native IO
// and application data services replaced. Can also accept a real fetcher for a
// bounded signed-media probe without opening a user session or writing progress.
function videoHarness({ fetcher = fetch, services = {}, timer = setTimeout, clearTimer = clearTimeout, clock = Date } = {}) {
  const modules = new Map();
  const requests = [];
  const reports = [];
  const config = {
    API_ORIGIN: "https://streamarena.xyz",
    toAbsoluteApiUrl: (value) => !value ? "" : /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)
      ? value : `https://streamarena.xyz${value.startsWith("/") ? "" : "/"}${value}`,
  };
  const externals = {
    "@/lib/config": config,
    "@/lib/streamarena": {
      getCachedPreferences: () => ({}),
      getSources: async (...args) => services.getSources?.(...args) ?? { sources: [] },
      resolveTitle: async (params, signal) => {
        requests.push(params);
        return services.resolveTitle?.(params, signal);
      },
      buildHlsMasterUrl: (url, audio) => `/api/hls/master.m3u8?${new URLSearchParams({ input: url,
        ...(audio != null && audio >= 0 ? { audioStream: String(audio) } : {}),
      })}`,
    },
    "@/lib/live": {
      resolveSportStream: (...args) => services.resolveSportStream?.(...args),
      resolveTwitchStream: (...args) => services.resolveTwitchStream?.(...args),
    },
    "@/store/offline": { getReadyOfflineRecord: () => null },
    "./report": {
      reportProgress() {}, reportNow() {}, stopReporting() {}, beginReporting() {},
      reportPlaybackError: (message) => reports.push(message),
    },
    "./resume": { loadResumeSeconds: async (...args) => services.loadResumeSeconds?.(...args) ?? 0 },
    "react-native-tcp-socket": {
      createServer: () => ({ on() {}, close() {}, listen(_options, ready) { ready(); } }),
    },
    "react-native-video": { TextTrackType: { VTT: "text/vtt" } },
    buffer: { Buffer },
    zustand: require("zustand"),
  };
  function load(name) {
    if (modules.has(name)) return modules.get(name).exports;
    let source = readFileSync(join(__dirname, "../../src/video", `${name}.ts`), "utf8");
    if (name === "strip-proxy") source += "\nexport { serve, rewritePlaylist, resolveToMediaPlaylist, fetchText, fetchBytes };";
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const mod = { exports: {} };
    modules.set(name, mod);
    runInNewContext(compiled, {
      exports: mod.exports, module: mod, URL, URLSearchParams, AbortController, Error, Date: clock,
      setTimeout: timer, clearTimeout: clearTimer, fetch: fetcher,
      require: (id) => {
        if (id in externals) return externals[id];
        if (id.startsWith("./")) return load(id.slice(2));
        throw new Error(`Unexpected dependency ${id}`);
      },
    });
    return mod.exports;
  }
  return { load, requests, reports };
}

module.exports = { videoHarness };

#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createHlsPlaybackController } from "../src-ui/player/hls-controller.js";

function createHarness({
  nativeHls = true,
  hlsJs = false,
  effectiveCurrentTime = 0,
  loadHlsConstructorFn,
} = {}) {
  const events = new EventTarget();
  const state = {
    lastRequestedSource: "",
    activatedFallbacks: [],
    loads: 0,
    playRequests: 0,
    playableSources: [],
    progressSources: 0,
    source: "",
  };
  const video = {
    currentSrc: "",
    currentTime: 0,
    setAttribute(name, value) {
      if (name === "src") {
        state.source = value;
        this.currentSrc = value;
      }
    },
    getAttribute(name) {
      return name === "src" ? state.source : null;
    },
    load() {
      state.loads += 1;
    },
    addEventListener: (...args) => events.addEventListener(...args),
    removeEventListener: (...args) => events.removeEventListener(...args),
    dispatch(type) {
      events.dispatchEvent(new Event(type));
    },
  };
  const controller = createHlsPlaybackController({
    ...(loadHlsConstructorFn ? { loadHlsConstructorFn } : {}),
    getVideo: () => video,
    getLastRequestedAbsolutePlaybackSource: () => state.lastRequestedSource,
    hasNativeHlsPlaybackSupport: () => nativeHls,
    hasHlsJsPlaybackSupport: () => hlsJs,
    buildSoftwareDecodeUrl: (input, startSeconds) =>
      `/api/remux?input=${encodeURIComponent(input)}&start=${startSeconds}`,
    getEffectiveCurrentTime: () => effectiveCurrentTime,
    tryPlay: () => {
      state.playRequests += 1;
    },
    onSourceLoadProgress: () => {
      state.progressSources += 1;
    },
    onSourcePlayable: (source) => {
      state.playableSources.push(source);
    },
    onRemuxFallbackActivated: (source) => {
      state.activatedFallbacks.push(source);
      state.lastRequestedSource = source;
    },
  });
  return { controller, state, video };
}

const previousWindow = globalThis.window;
globalThis.window = { location: { origin: "https://app.test" } };

try {
  {
    const { controller, state, video } = createHarness();
    const source = "https://media.test/paused.m3u8";
    state.lastRequestedSource = source;
    assert.equal(
      controller.play({
        absoluteSource: source,
        requestedStartSeconds: 42,
        autoplay: false,
      }),
      true,
    );
    assert.equal(state.source, source);
    assert.equal(state.loads, 1);
    assert.equal(state.playRequests, 0);
    video.dispatch("loadedmetadata");
    assert.equal(video.currentTime, 42);
    assert.equal(state.playRequests, 0);
    video.dispatch("loadeddata");
    assert.deepEqual(state.playableSources, [source]);
    console.log("✓ paused native HLS loads and seeks without requesting playback");
  }

  {
    const { controller, state } = createHarness();
    const source = "https://media.test/playing.m3u8";
    state.lastRequestedSource = source;
    assert.equal(controller.play({ absoluteSource: source }), true);
    assert.equal(state.playRequests, 1);
    console.log("✓ HLS keeps autoplay enabled by default");
  }

  {
    const { controller, state, video } = createHarness({
      effectiveCurrentTime: 27.8,
    });
    const source = "https://media.test/native-fallback.m3u8";
    state.lastRequestedSource = source;
    assert.equal(
      controller.play({
        absoluteSource: source,
        hlsMeta: { input: "mock://native-fallback" },
        autoplay: false,
      }),
      true,
    );
    video.dispatch("error");
    assert.match(state.source, /^https:\/\/app\.test\/api\/remux\?/);
    assert.equal(state.playRequests, 0);
    video.dispatch("loadeddata");
    assert.deepEqual(state.activatedFallbacks, [state.source]);
    assert.deepEqual(state.playableSources, [state.source]);
    assert.equal(state.progressSources, 1);
    assert.equal(state.lastRequestedSource, state.source);
    assert.equal(new URL(state.source).searchParams.get("start"), "27");
    console.log("✓ native HLS remux fallback proves the original source group ready");
  }

  {
    const { controller, state, video } = createHarness();
    const failures = [];
    for (const name of ["old", "current"]) {
      controller.destroy();
      state.lastRequestedSource = `https://media.test/${name}.m3u8`;
      controller.play({
        absoluteSource: state.lastRequestedSource,
        handleHlsPlaybackFailure: () => failures.push(name),
      });
    }
    video.dispatch("error");
    assert.deepEqual(failures, ["current"], "a previous native HLS error handler must not fail the replacement");
    console.log("✓ native HLS detaches callbacks when switching providers");
  }

  {
    const pendingImport = Promise.withResolvers();
    const instances = [];
    class FakeHls {
      static isSupported = () => true;
      static Events = Object.fromEntries(["ERROR", "MEDIA_ATTACHED", "MANIFEST_PARSED", "FRAG_BUFFERED", "LEVEL_SWITCHED"].map(name => [name, name]));
      static ErrorTypes = { NETWORK_ERROR: "network", MEDIA_ERROR: "media" };
      constructor(config) {
        this.config = config;
        this.listeners = new Map();
        this.starts = [];
        this.loads = [];
        this.levels = [];
        instances.push(this);
      }
      on(name, callback) { this.listeners.set(name, callback); }
      emit(name, data) { this.listeners.get(name)?.(name, data); }
      attachMedia() { this.emit("MEDIA_ATTACHED"); }
      loadSource(source) { this.loads.push(source); }
      startLoad(position) { this.starts.push(position); }
      recoverMediaError() { this.emit("MEDIA_ATTACHED"); }
      destroy() { this.destroyed = true; }
    }
    const { controller, state, video } = createHarness({
      nativeHls: false, hlsJs: true,
      loadHlsConstructorFn: () => pendingImport.promise,
    });
    state.lastRequestedSource = "https://media.test/same-url.m3u8";
    controller.play({ absoluteSource: state.lastRequestedSource, requestedStartSeconds: 10 });
    controller.destroy();
    controller.play({ absoluteSource: state.lastRequestedSource, requestedStartSeconds: 60 });
    assert.equal(controller.seek(300), true);
    assert.equal(controller.seek(420), true);
    pendingImport.resolve(FakeHls);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(instances.length, 1, "same-URL retries must not resurrect a destroyed pending instance");
    const hls = instances[0];
    assert(controller.isPendingSource(state.lastRequestedSource), "wait for manifest before allowing play of the new blob");
    hls.emit("MANIFEST_PARSED");
    assert.deepEqual(hls.starts, [420], "load the latest requested seek without fetching the opening segment");
    video.readyState = 1;
    video.seeking = true;
    hls.emit("FRAG_BUFFERED");
    assert.deepEqual(state.playableSources, [], "audio/init/buffered bytes alone do not confirm a successful video handoff");
    video.currentTime = 120;
    hls.emit("ERROR", { fatal: true, type: "network" });
    assert.equal(hls.starts.at(-1), 120, "recover at the current backward seek, not hls.js's previous high-water time");
    video.currentTime = 180;
    hls.emit("ERROR", { fatal: true, type: "media" });
    assert.equal(hls.starts.at(-1), 180);
    assert.equal(hls.loads.length, 1, "media recovery should reuse the manifest and preserve the new position");
    video.readyState = 3;
    video.seeking = false;
    video.dispatch("canplay");
    assert.deepEqual(state.playableSources, [state.lastRequestedSource]);
    controller.destroy();
    console.log("✓ HLS generations, queued seeks, playable confirmation and position-preserving recovery");
  }

  {
    const { controller, state, video } = createHarness({ nativeHls: false });
    const source = "https://media.test/unsupported-fallback.m3u8";
    state.lastRequestedSource = source;
    assert.equal(
      controller.play({
        absoluteSource: source,
        hlsMeta: { input: "mock://unsupported-fallback" },
        requestedStartSeconds: 42,
        autoplay: false,
      }),
      true,
    );
    assert.match(state.source, /^https:\/\/app\.test\/api\/remux\?/);
    assert.equal(state.playRequests, 0);
    video.dispatch("loadeddata");
    assert.deepEqual(state.activatedFallbacks, [state.source]);
    assert.deepEqual(state.playableSources, [state.source]);
    assert.equal(state.progressSources, 1);
    assert.equal(state.lastRequestedSource, state.source);
    assert.equal(new URL(state.source).searchParams.get("start"), "42");
    console.log("✓ unsupported HLS remux fallback proves the original source group ready");
  }
} finally {
  if (previousWindow === undefined) {
    delete globalThis.window;
  } else {
    globalThis.window = previousWindow;
  }
}

// Exercise the player entrypoint too: a real HLS-to-HLS switch leaves currentSrc
// pointing at the detached blob until the asynchronous attachment completes.
const playerSource = await readFile(new URL("../src-ui/pages/player.js", import.meta.url), "utf8");
const tryPlaySource = playerSource.slice(
  playerSource.indexOf("async function tryPlay() {"),
  playerSource.indexOf("async function togglePlayback() {"),
);
let pending = true;
let playCalls = 0;
const nextSource = "https://app.test/api/live/hls.m3u8?input=aether";
const video = {
  currentSrc: "blob:https://app.test/previous-cinejoy",
  networkState: 2,
  ended: false,
  getAttribute: () => pending ? "" : "blob:https://app.test/new-aether",
  play: async () => {
    playCalls += 1;
    if (pending) throw Object.assign(new Error("Interrupted by a new load"), { name: "AbortError" });
  },
};
const tryPlay = vm.runInNewContext(`${tryPlaySource}\ntryPlay`, {
  video,
  isLiveIframePlaybackActive: () => false,
  lastRequestedAbsolutePlaybackSource: nextSource,
  lastRequestedPlaybackSource: "",
  hlsPlaybackController: {
    isPendingSource: (source) => pending && source === nextSource,
    isActive: () => !pending,
  },
  hasActiveSource: () => true,
  armLiveStartupHealthWatch() {},
  syncPlayState() {},
  isLivePlayback: false,
  playbackSourceGeneration: 1,
  isManualSourceSwitchPending: () => true,
  isPlaybackBlockedByPolicy: () => false,
});
await tryPlay();
assert.equal(playCalls, 0, "do not play the old blob while its replacement attaches");
pending = false;
await tryPlay();
assert.equal(playCalls, 1, "the manifest callback can play the newly attached source");
video.play = async () => { throw Object.assign(new Error("Unsupported codec"), { name: "NotSupportedError" }); };
await assert.rejects(tryPlay(), { name: "NotSupportedError" });
console.log("✓ HLS source switches wait for attachment and still report real playback errors");

console.log("\nAll HLS autoplay tests passed.");

#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHlsPlaybackController } from "../src-ui/player/hls-controller.js";

function createHarness({
  nativeHls = true,
  hlsJs = false,
  effectiveCurrentTime = 0,
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

console.log("\nAll HLS autoplay tests passed (4 cases).");

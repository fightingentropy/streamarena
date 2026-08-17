#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildDeferredMediaTracksQuery,
  createDeferredMediaTrackController,
  createDeferredMediaTrackIdentity,
  getDeferredTrackRestartPlan,
  isDeferredMediaTrackIdentityCurrent,
  waitForDeferredMediaTrackProbe,
} from "../src-ui/player/deferred-media-tracks.js";

function createMedia({ readyState = 0, error = null } = {}) {
  const listeners = new Map();
  return {
    readyState,
    error,
    addEventListener(event, listener) {
      const eventListeners = listeners.get(event) || new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
    },
    removeEventListener(event, listener) {
      listeners.get(event)?.delete(listener);
    },
    dispatch(event) {
      [...(listeners.get(event) || [])].forEach((listener) => listener());
    },
    listenerCount() {
      return [...listeners.values()].reduce(
        (count, eventListeners) => count + eventListeners.size,
        0,
      );
    },
  };
}

function createClock() {
  const tasks = new Map();
  let nextId = 1;
  return {
    setTimeoutFn(callback) {
      const id = nextId++;
      tasks.set(id, callback);
      return id;
    },
    clearTimeoutFn(id) {
      tasks.delete(id);
    },
    fire() {
      const callbacks = [...tasks.values()];
      tasks.clear();
      callbacks.forEach((callback) => callback());
    },
  };
}

const query = new URLSearchParams(
  buildDeferredMediaTracksQuery({
    sourceInput: "/api/local-torrent/stream/session/file",
    title: "Slow Horses",
    year: "2022",
    imdbId: "tt5875444",
    filename: "Slow.Horses.S04E01.mkv",
    mediaType: "tv",
    seasonNumber: 4,
    episodeNumber: 1,
    audioLang: "EN",
    subtitleLang: "OFF",
  }),
);
assert.equal(query.get("input"), "/api/local-torrent/stream/session/file");
assert.equal(query.get("filename"), "Slow.Horses.S04E01.mkv");
assert.equal(query.get("imdbId"), "tt5875444");
assert.equal(query.get("seasonNumber"), "4");
assert.equal(query.get("episodeNumber"), "1");
assert.equal(query.get("audioLang"), "en");
assert.equal(query.get("subtitleLang"), "off");

const movieQuery = new URLSearchParams(
  buildDeferredMediaTracksQuery({
    sourceInput: "/api/local-cache/stream/movie",
    mediaType: "movie",
    seasonNumber: 1,
    episodeNumber: 1,
  }),
);
assert.equal(movieQuery.has("seasonNumber"), false);
assert.equal(movieQuery.has("episodeNumber"), false);
assert.equal(movieQuery.get("subtitleLang"), "");

const identity = createDeferredMediaTrackIdentity({
  playbackRequestToken: 7,
  sourceHash: "ABCDEF",
  sourceInput: " /api/local-torrent/stream/a/file ",
  audioLang: "EN",
  subtitleLang: "OFF",
});
assert.equal(
  isDeferredMediaTrackIdentityCurrent(
    identity,
    createDeferredMediaTrackIdentity({
      playbackRequestToken: 7,
      sourceHash: "abcdef",
      sourceInput: "/api/local-torrent/stream/a/file",
      audioLang: "en",
      subtitleLang: "off",
    }),
  ),
  true,
);
assert.equal(
  isDeferredMediaTrackIdentityCurrent(
    identity,
    { ...identity, subtitleLang: "en" },
  ),
  false,
);

assert.deepEqual(
  getDeferredTrackRestartPlan({
    currentRoute: "direct",
    selectedAudioStreamIndex: 1,
    defaultAudioStreamIndex: 1,
  }),
  { required: false, mode: "", reason: "" },
  "a direct source already playing its safe default audio should not restart",
);
assert.deepEqual(
  getDeferredTrackRestartPlan({
    currentRoute: "direct",
    selectedAudioStreamIndex: 1,
    defaultAudioStreamIndex: 1,
    forceAudioRemux: true,
  }),
  { required: true, mode: "remux", reason: "audio" },
  "unsafe direct audio should switch to remux",
);
assert.deepEqual(
  getDeferredTrackRestartPlan({
    currentRoute: "hls",
    selectedAudioStreamIndex: 2,
    defaultAudioStreamIndex: 1,
  }),
  { required: true, mode: "hls", reason: "audio" },
  "an HLS source only restarts when enrichment selects another audio stream",
);
assert.deepEqual(
  getDeferredTrackRestartPlan({
    currentRoute: "hls",
    selectedAudioStreamIndex: 2,
    firstAudioStreamIndex: 1,
    defaultAudioStreamIndex: 2,
  }),
  { required: true, mode: "hls", reason: "audio" },
  "implicit ffmpeg audio is the first probed track, not the disposition default",
);
assert.deepEqual(
  getDeferredTrackRestartPlan({
    currentRoute: "remux",
    currentSubtitleStreamIndex: -1,
    selectedNativeSubtitleStreamIndex: 4,
  }),
  { required: true, mode: "remux", reason: "subtitle" },
  "an internal subtitle needs a remux restart to map its stream",
);

{
  const readyMedia = createMedia({ readyState: 3 });
  assert.equal(await waitForDeferredMediaTrackProbe(readyMedia), "ready");
  assert.equal(readyMedia.listenerCount(), 0);
}

{
  const media = createMedia();
  const clock = createClock();
  const waiting = waitForDeferredMediaTrackProbe(media, clock);
  assert.equal(media.listenerCount(), 3);
  media.dispatch("playing");
  assert.equal(await waiting, "ready");
  assert.equal(media.listenerCount(), 0);
}

{
  const media = createMedia();
  const clock = createClock();
  const waiting = waitForDeferredMediaTrackProbe(media, clock);
  clock.fire();
  assert.equal(await waiting, "timeout");
  assert.equal(media.listenerCount(), 0);
}

{
  const media = createMedia();
  const clock = createClock();
  const controller = new AbortController();
  const waiting = waitForDeferredMediaTrackProbe(media, {
    ...clock,
    signal: controller.signal,
  });
  assert.equal(media.listenerCount(), 3);
  controller.abort();
  assert.equal(await waiting, "canceled");
  assert.equal(media.listenerCount(), 0);
}

const flushAsyncWork = () => new Promise((resolve) => setTimeout(resolve, 0));

function createControllerHarness({
  audioLang = "auto",
  subtitleLang = "off",
  currentRoute = "hls",
  responsePayload,
  requestTracks,
  shouldForceAudioRemux = false,
  softwareDecodeRequired = false,
  subtitleTrack = null,
  nativeSubtitleLoaded = false,
  videoPaused = true,
  mediaReadyState = 3,
  tryPlayFn = async () => {},
  warnFn = () => assert.fail("canceled enrichment must not warn"),
} = {}) {
  const sourceChanges = [];
  const subtitleApplications = [];
  const state = {
    video: createMedia({ readyState: mediaReadyState }),
    playbackRequestToken: 11,
    sourceHash: "abcdef",
    sourceInput: "/api/local-torrent/stream/session/file",
    audioLang,
    subtitleLang,
    currentPlaybackSource: `/${currentRoute}`,
    title: "Slow Horses",
    year: "2022",
    filename: "Slow.Horses.S04E01.mkv",
    isTv: true,
    seasonNumber: 4,
    episodeNumber: 1,
    selectedAudioStreamIndex: -1,
    selectedSubtitleStreamIndex: -1,
    activeAudioSyncMs: 0,
    preferredAudioSyncMs: 0,
  };
  state.video.paused = videoPaused;
  let trackStateApplyCount = 0;
  const controller = createDeferredMediaTrackController({
    requestTracks:
      requestTracks || (async () => responsePayload),
    getState: () => state,
    setActiveSourceInput: (value) => {
      state.sourceInput = value;
    },
    applyTrackState: (next) => {
      trackStateApplyCount += 1;
      state.audioTracks = next.audioTracks;
      state.subtitleTracks = next.subtitleTracks;
      state.selectedAudioStreamIndex = next.selectedAudioStreamIndex;
      state.selectedSubtitleStreamIndex = next.selectedSubtitleStreamIndex;
    },
    parseHlsMasterSource: () =>
      currentRoute === "hls"
        ? { audioStreamIndex: -1, subtitleStreamIndex: -1 }
        : null,
    parseTranscodeSource: () =>
      currentRoute === "remux"
        ? { audioStreamIndex: -1, subtitleStreamIndex: -1 }
        : null,
    getDefaultEmbeddedAudioTrack: () =>
      state.audioTracks?.find((track) => track.isDefault) ||
      state.audioTracks?.[0] ||
      null,
    getSubtitleTrackByStreamIndex: () => subtitleTrack,
    shouldUseNativeEmbeddedSubtitleTrack: (track) => Boolean(track),
    hasLoadedNativeSubtitleTrack: () => nativeSubtitleLoaded,
    shouldForceRemuxForEmbeddedAudio: () => shouldForceAudioRemux,
    shouldUseSoftwareDecode: () => softwareDecodeRequired,
    buildHlsPlaybackUrl: () => "/api/hls/master?audioStream=2",
    buildSoftwareDecodeUrl: () => "/api/remux?subtitleStream=4",
    setVideoSource: (source, options) => sourceChanges.push({ source, options }),
    applySubtitleTrackByStreamIndex: (index, options) =>
      subtitleApplications.push({ index, options }),
    tryPlay: tryPlayFn,
    warn: warnFn,
  });
  return {
    controller,
    state,
    sourceChanges,
    subtitleApplications,
    getTrackStateApplyCount: () => trackStateApplyCount,
  };
}

{
  const harness = createControllerHarness({
    audioLang: "auto",
    responsePayload: {
      tracks: {
        audioTracks: [{ streamIndex: 2, isDefault: true, codec: "aac" }],
        subtitleTracks: [],
      },
      selectedAudioStreamIndex: 2,
      selectedSubtitleStreamIndex: -1,
    },
  });
  assert.equal(
    harness.controller.schedule({
      tracksPending: true,
      sourceInput: harness.state.sourceInput,
    }),
    true,
  );
  await flushAsyncWork();
  assert.equal(harness.state.selectedAudioStreamIndex, -1);
  assert.deepEqual(harness.sourceChanges, []);
  harness.controller.dispose();
}

{
  const harness = createControllerHarness({
    audioLang: "auto",
    currentRoute: "direct",
    shouldForceAudioRemux: true,
    responsePayload: {
      tracks: {
        audioTracks: [{ streamIndex: 1, isDefault: true, codec: "dts" }],
        subtitleTracks: [],
      },
      selectedAudioStreamIndex: 1,
      selectedSubtitleStreamIndex: -1,
    },
  });
  harness.controller.schedule({
    tracksPending: true,
    sourceInput: harness.state.sourceInput,
  });
  await flushAsyncWork();
  assert.equal(harness.state.selectedAudioStreamIndex, -1);
  assert.equal(harness.sourceChanges[0]?.source, "/api/remux?subtitleStream=4");
  harness.controller.dispose();
}

{
  const internalSubtitle = {
    streamIndex: 4,
    isExternal: false,
    isTextBased: true,
  };
  const harness = createControllerHarness({
    audioLang: "en",
    subtitleLang: "en",
    currentRoute: "direct",
    subtitleTrack: internalSubtitle,
    responsePayload: {
      tracks: { audioTracks: [], subtitleTracks: [internalSubtitle] },
      selectedAudioStreamIndex: -1,
      selectedSubtitleStreamIndex: 4,
    },
  });
  harness.controller.schedule({
    tracksPending: true,
    sourceInput: harness.state.sourceInput,
  });
  await flushAsyncWork();
  assert.equal(harness.sourceChanges[0]?.source, "/api/remux?subtitleStream=4");
  assert.deepEqual(harness.subtitleApplications.at(-1), {
    index: 4,
    options: { preservePendingNative: true },
  });
  harness.controller.dispose();
}

{
  const internalSubtitle = {
    streamIndex: 4,
    isExternal: false,
    isTextBased: true,
  };
  const harness = createControllerHarness({
    audioLang: "en",
    subtitleLang: "en",
    currentRoute: "direct",
    subtitleTrack: internalSubtitle,
    nativeSubtitleLoaded: true,
    responsePayload: {
      tracks: { audioTracks: [], subtitleTracks: [internalSubtitle] },
      selectedAudioStreamIndex: -1,
      selectedSubtitleStreamIndex: 4,
    },
  });
  harness.controller.schedule({
    tracksPending: true,
    sourceInput: harness.state.sourceInput,
  });
  await flushAsyncWork();
  assert.deepEqual(harness.sourceChanges, []);
  assert.deepEqual(harness.subtitleApplications.at(-1), {
    index: 4,
    options: undefined,
  });
  harness.controller.dispose();
}

{
  let resolveRequest;
  const harness = createControllerHarness({
    responsePayload: null,
    requestTracks: () =>
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
  });
  harness.controller.schedule({
    tracksPending: true,
    sourceInput: harness.state.sourceInput,
  });
  await flushAsyncWork();
  harness.state.playbackRequestToken += 1;
  harness.state.sourceHash = "provisional-b";
  resolveRequest({
    tracks: { audioTracks: [], subtitleTracks: [] },
    selectedAudioStreamIndex: -1,
    selectedSubtitleStreamIndex: -1,
  });
  await flushAsyncWork();
  assert.equal(
    harness.getTrackStateApplyCount(),
    1,
    "a provisional resolve must not invalidate the still-playing source",
  );
  harness.controller.dispose();
}

{
  const warnings = [];
  const harness = createControllerHarness({
    currentRoute: "direct",
    softwareDecodeRequired: true,
    videoPaused: false,
    responsePayload: {
      tracks: { audioTracks: [], subtitleTracks: [] },
      selectedAudioStreamIndex: -1,
      selectedSubtitleStreamIndex: -1,
    },
    tryPlayFn: async () => {
      throw new Error("play rejected");
    },
    warnFn: (...args) => warnings.push(args),
  });
  harness.controller.schedule({
    tracksPending: true,
    sourceInput: harness.state.sourceInput,
  });
  await flushAsyncWork();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], "Deferred media track application failed.");
  assert.match(warnings[0][1].message, /play rejected/);
  harness.controller.dispose();
}

{
  let requestCount = 0;
  const harness = createControllerHarness({
    mediaReadyState: 0,
    requestTracks: async () => {
      requestCount += 1;
      return null;
    },
  });
  harness.controller.schedule({
    tracksPending: true,
    sourceInput: harness.state.sourceInput,
  });
  assert.equal(harness.state.video.listenerCount(), 3);
  harness.controller.cancel();
  await flushAsyncWork();
  assert.equal(harness.state.video.listenerCount(), 0);
  assert.equal(requestCount, 0);
}

{
  let requestAborted = false;
  const harness = createControllerHarness({
    responsePayload: null,
    requestTracks: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          requestAborted = true;
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });
  harness.controller.schedule({
    tracksPending: true,
    sourceInput: harness.state.sourceInput,
  });
  await flushAsyncWork();
  harness.controller.cancel();
  await flushAsyncWork();
  assert.equal(requestAborted, true);
  assert.equal(harness.getTrackStateApplyCount(), 0);
}

console.log("deferred-media-tracks-test: ok");

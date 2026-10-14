#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";
import * as manual from "../src-ui/player/manual-source-switch.js";

const source = await readFile(new URL("../src-ui/pages/player.js", import.meta.url), "utf8");
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const flush = () => new Promise(resolve => setImmediate(resolve));

function switchingHarness() {
  const jobs = new Map();
  const applied = [];
  const rollbacks = [];
  const context = {
    ...manual, console, HTMLElement: class {},
    selectedSourceHash: "A", pendingSourceSwitchHash: "", sourceSelectionPinned: false,
    isTmdbResolvedPlayback: true, userLocalTorrentEnabled: false,
    preferredResolverProvider: "fastest", tmdbPlaybackRequestToken: 0, tmdbResolveRetries: 0,
    sourceControl: null, sourceOptionDetails: null, resumeTime: 42,
    video: { currentTime: 42, paused: false, readyState: 4 },
    activeSource: "A-url",
    normalizeSourceHash: value => value,
    getSourceOptionByHash: hash => ({ hash }), isSourceOptionEmbed: () => true,
    isUserRealDebridPlaybackEnabled: () => false,
    pickTorrentResolverProvider: () => "fastest",
    isLiveIframePlaybackActive: () => false,
    isTranscodeSourceActive: () => false,
    requestResolveJson: { cancelActive: async () => {} },
    localCacheUpgradeWatch: { setHasUpgraded() {} },
  };
  context.getEffectiveCurrentTime = () => context.video.currentTime;
  context.getManualSourceSwitchRestoreSource = () => context.activeSource;
  context.captureManualSourceSwitchBaseline = ({ resumeSeconds, wasPaused }) => ({
    restorePlaybackSource: context.activeSource, selectedSourceHash: context.selectedSourceHash,
    restoreResumeSeconds: resumeSeconds, restoreWasPaused: wasPaused,
  });
  context.setPendingSourceSwitchHash = hash => { context.pendingSourceSwitchHash = hash; };
  context.resolveTmdbSourcesAndPlay = ({ requestSourceHash }) => {
    const job = Promise.withResolvers();
    jobs.set(requestSourceHash, job);
    return job.promise;
  };
  context.rollbackManualSourceSwitchPlayback = async baseline => {
    rollbacks.push(baseline);
    context.selectedSourceHash = baseline.selectedSourceHash;
  };
  context.manualSourceSwitch = manual.createManualSourceSwitchController({
    rollback: context.rollbackManualSourceSwitchPlayback,
    setTimeoutFn: () => 1, clearTimeoutFn() {},
  });
  context.applyResolvedTmdbPlayback = async (_, options) => {
    applied.push(options);
    context.activeSource = `${options.resolvedSourceHash}-url`;
    context.video.currentTime = options.startSeconds;
    context.manualSourceSwitch.recordPlaybackRequested(options.manualSourceSwitchRequest, {
      sourceHash: options.resolvedSourceHash, absolutePlaybackSource: context.activeSource,
    });
    return {};
  };
  context.completeManualSourceSwitchIfActive = () => context.manualSourceSwitch.completeIfActive(undefined, {
    activePlaybackSource: context.activeSource,
  });
  for (const name of ["syncSourceSelectionState", "renderSelectedSourceDetails", "closeSourcePopover",
    "applyPreferredSourceAudioSync", "persistSourceHashInUrl", "syncAudioState", "stopLocalCacheUpgradeWatch",
    "closeAudioPopover", "openSourcePopover", "seekToAbsoluteTime", "markInitialResumeHandled", "clearPlaybackRecovery"]) context[name] = () => {};
  vm.createContext(context);
  vm.runInContext(extract("async function handleSourceOptionSelection(", "if (audioTabSubtitles)"), context);
  return { context, jobs, applied, rollbacks };
}

test("late failures from B cannot roll back a newer successful C", async () => {
  const { context, jobs, rollbacks } = switchingHarness();
  const b = context.handleSourceOptionSelection("B");
  await flush();
  const c = context.handleSourceOptionSelection("C");
  await flush();
  jobs.get("C").resolve({ resolved: {}, resolvedSourceHash: "C" });
  await c;
  jobs.get("B").reject(new Error("old request failed after cancellation"));
  await b;
  assert.equal(context.selectedSourceHash, "C");
  assert.deepEqual(rollbacks, []);
});

test("switch handoff uses current progress and pause state after a slow resolve", async () => {
  const { context, jobs, applied } = switchingHarness();
  const b = context.handleSourceOptionSelection("B");
  await flush();
  context.video.currentTime = 57;
  context.video.paused = true;
  jobs.get("B").resolve({ resolved: {}, resolvedSourceHash: "B" });
  await b;
  assert.equal(applied[0].startSeconds, 57, "do not replay the 15 seconds spent resolving");
  assert.equal(applied[0].autoplay, false, "honor a pause made while waiting");
});

test("rapid switches carry confirmed position through a loading video reset", async () => {
  const { context, jobs, applied } = switchingHarness();
  const b = context.handleSourceOptionSelection("B");
  await flush();
  context.video.readyState = 0;
  jobs.get("B").resolve({ resolved: {}, resolvedSourceHash: "B" });
  await b;
  context.video.currentTime = 0;
  context.video.paused = true;
  const c = context.handleSourceOptionSelection("C");
  await flush();
  jobs.get("C").resolve({ resolved: {}, resolvedSourceHash: "C" });
  await c;
  assert.equal(applied[1].startSeconds, 42);
  assert.equal(applied[1].autoplay, true);
});

test("rollback cancelled while awaiting resolver cleanup cannot mutate a newer request", async () => {
  const cleanup = Promise.withResolvers();
  const request = {};
  let current = request;
  const context = {
    manualSourceSwitch: { isCurrent: value => value === current },
    requestResolveJson: { cancelActive: () => cleanup.promise },
    tmdbPlaybackRequestToken: 7,
  };
  vm.createContext(context);
  vm.runInContext(extract("async function rollbackManualSourceSwitchPlayback(", "const manualSourceSwitch ="), context);
  const rollback = context.rollbackManualSourceSwitchPlayback({}, { request });
  current = {};
  cleanup.resolve();
  assert.equal(await rollback, false);
  assert.equal(context.tmdbPlaybackRequestToken, 7);
});

test("a seek timeupdate without decoded data must not disarm recovery", () => {
  let clears = 0;
  const handlers = [];
  const context = {
    video: { currentTime: 130, readyState: 1, seeking: true },
    trackListener: (_, __, callback) => handlers.push(callback),
    getEffectiveCurrentTime: () => 130,
    clearPlaybackRecovery: () => { clears++; }, clearStreamStallRecovery: () => { clears++; },
    completeManualSourceSwitchIfActive() {}, clearLiveStartupHealthWatch() {},
    rememberLiveStreamSuccess() {}, getSelectedLiveStreamOption() {},
    hideStaleLiveResolverWhilePlayingForState() {}, isLivePlayback: false, resolverOverlay: null,
    liveTransportFallback: { isRecovering: () => false }, hideResolver() {}, applyInitialResumeIfReady: () => true,
    persistResumeTime() {}, hasSeriesEpisodeControls: false, autoPlayOverlayVisible: false,
  };
  vm.runInNewContext(extract('trackListener(video, "timeupdate", () => {', 'trackListener(video, "play", syncPlayState)'), context);
  handlers[0]();
  assert.equal(clears, 0);
  context.video.readyState = 3;
  context.video.seeking = false;
  handlers[0]();
  assert.equal(clears, 2);
});

test("buffered remux seeks reuse the decoder; unbuffered seeks restart at the target", () => {
  const loads = [];
  const context = {
    performance, lastPlaybackSeekAt: 0, stallRetryGeneration: 0,
    video: { currentTime: 20, paused: false, buffered: { length: 1, start: () => 10, end: () => 60 } },
    isLivePlayback: false, resetAudioDecodeWatchState() {}, markInitialResumeHandled() {},
    isTranscodeSourceActive: () => true, activeTranscodeInput: "media", transcodeBaseOffsetSeconds: 100,
    activeAudioStreamIndex: -1, activeAudioSyncMs: 0, preferredAudioSyncMs: 0, selectedSubtitleStreamIndex: -1,
    buildSoftwareDecodeUrl: (_, time) => `remux:${time}`,
    setVideoSource: url => loads.push(url), tryPlay() {},
  };
  vm.createContext(context);
  vm.runInContext(extract("function seekToAbsoluteTime(", "function getSeekRatioFromPointerEvent("), context);
  context.seekToAbsoluteTime(140);
  assert.equal(context.video.currentTime, 40);
  assert.deepEqual(loads, []);
  context.seekToAbsoluteTime(180);
  assert.deepEqual(loads, ["remux:180"]);
});

test("retrying HLS passes the saved position into its loader", () => {
  let options;
  const context = {
    lastRequestedPlaybackSource: "https://cdn.test/master.m3u8",
    getEffectiveCurrentTime: () => 432,
    isTranscodeSourceActive: () => false,
    setVideoSource: (_, value) => { options = value; }, tryPlay() {},
  };
  vm.runInNewContext(`${extract("function retryCurrentPlaybackFromSavedPosition()", "async function runPlaybackRecoveryAttempt(")}\nretryCurrentPlaybackFromSavedPosition();`, context);
  assert.equal(options.startSeconds, 432);
});

test("fatal HLS recovery retains the seek target until the replacement takes over", async () => {
  const video = { currentTime: 900, paused: false };
  let recoveredAt;
  const context = {
    video, isLivePlayback: false, isTmdbResolvedPlayback: true,
    sourceGeneration: 1, playbackSourceGeneration: 1,
    hlsPlaybackController: { destroy: () => { video.currentTime = 0; video.paused = true; } },
    handlePlaybackErrorRecovery: async () => { recoveredAt = video.currentTime; return true; },
    reportCurrentTmdbPlaybackFailure() {},
  };
  vm.runInNewContext(`${extract("const handleHlsPlaybackFailure = (", "    hlsPlaybackController.play({")}\nhandleHlsPlaybackFailure('decode failed');`, context);
  await flush();
  assert.equal(recoveredAt, 900, "detaching MSE before recovery loses the seek target");
  assert.equal(video.paused, false);
});

test("an old health check cannot recover over a newer source selection", async () => {
  const health = Promise.withResolvers();
  let recoveries = 0;
  const context = {
    manualSourceSwitch: { getPending: () => null }, isBrowserOffline: () => false,
    playbackSourceGeneration: 1, tmdbPlaybackRequestToken: 1,
    checkPlaybackServerHealth: () => health.promise,
    attemptTmdbRecovery: () => { recoveries++; return true; },
    showResolverError() {},
  };
  vm.createContext(context);
  vm.runInContext(extract("async function handlePlaybackErrorRecovery(", "function isSourceFallbackResolveError("), context);
  const recovery = context.handlePlaybackErrorRecovery("old decode error");
  context.tmdbPlaybackRequestToken++;
  health.resolve(true);
  await recovery;
  assert.equal(recoveries, 0);
});

test("automatic fallback follows a seek and pause made while the replacement resolves", async () => {
  const resolve = Promise.withResolvers();
  let applied;
  const context = {
    ...manual, tmdbPlaybackRequestToken: 1, tmdbSkipExternalEmbed: false,
    isTmdbResolvedPlayback: true, isTmdbTvPlayback: false, tmdbId: 123,
    selectedSourceHash: "A", preferredResolverProvider: "fastest", userLocalTorrentEnabled: false,
    availablePlaybackSources: [{}], video: { currentTime: 170, paused: false },
    isManualSourceSwitchPending: () => false, stopLocalCacheUpgradeWatch() {},
    localCacheUpgradeWatch: { setHasUpgraded() {} }, getPinnedSourceHashForRequests: () => "",
    isTorrentResolverProvider: () => false, resolveTorrentRequestProvider: () => "fastest",
    isUserRealDebridPlaybackEnabled: () => false, normalizeSourceHash: value => value,
    resolveTmdbMovieViaBackend: () => resolve.promise,
    runResolveWithSupersession: async ({ resolve, isSuperseded }) => ({ value: await resolve(), stale: isSuperseded() }),
    getManualSourceSwitchRestoreSource: () => "A-url",
    applyResolvedTmdbPlayback: async (_, options) => { applied = options; },
  };
  context.getEffectiveCurrentTime = () => context.video.currentTime;
  vm.createContext(context);
  vm.runInContext(extract("async function resolveTmdbSourcesAndPlay({", "// A single source can expose"), context);
  const recovery = context.resolveTmdbSourcesAndPlay({ startSeconds: 170, preservePlaybackState: true });
  context.video.currentTime = 900;
  context.video.paused = true;
  resolve.resolve({ sourceHash: "B" });
  await recovery;
  assert.equal(applied.startSeconds, 900);
  assert.equal(applied.autoplay, false);
});

#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createLiveTransportFallbackController } from "../src-ui/player/live-transport-fallback.js";
import { getLivePlaybackSource, normalizeBrowserBoundLiveHlsReferer, normalizePlaybackSourceValue } from "../src-ui/player/live-streams.js";
import { isHlsPlaybackSource } from "../src-ui/player/hls-playback.js";
import { buildMediaDeliveryQueue } from "../src-ui/player/media-delivery.js";
import { buildOrderedRemuxFallbacks, buildResolvedRemuxVariantSource } from "../src-ui/player/remux-routing.js";

const path = "/api/live/hls.m3u8?input=signed&externalEmbed=1&sig=test-signature&expires=9999999999";
const direct = `https://media.example${path}`;
const worker = `https://live.example${path}`;
const origin = path;
const player = await readFile(new URL("../src-ui/pages/player.js", import.meta.url), "utf8");
function extract(start, end) {
  const from = player.indexOf(start);
  const to = player.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return player.slice(from, to);
}
const functions = [
  extract("async function resolveLivePlaybackSource(", "function isPlaybackBlockedByPolicy("),
  extract("async function switchToLiveStreamOption(", "async function attemptAutomaticLiveStreamFallback("),
  extract("async function attemptAutomaticLiveStreamFallback(", "function handleLivePlaybackFailure("),
].join("\n");

function harness({ options = [{ id: "a", source: "https://provider.example/a" }], requestJson } = {}) {
  const switched = [];
  const failed = [];
  let retries = 0;
  let playRequests = 0;
  const context = {
    DOMException, URLSearchParams, getLivePlaybackSource, normalizePlaybackSourceValue,
    normalizeBrowserBoundLiveHlsReferer, isHlsPlaybackSource, buildMediaDeliveryQueue,
    liveTransportFallback: createLiveTransportFallbackController(),
    isLivePlayback: true, liveAutoplayRequested: true,
    shouldResolveLiveEmbedSource: true, liveEmbedResolver: "sports",
    liveStreamOptions: options, selectedLiveStreamId: options[0].id, src: options[0].source,
    liveAutoFallbackAttemptedStreamIds: new Set(), activeLiveHlsReferer: "",
    video: { paused: false },
    getLiveEmbedFallbackSources: () => [], parseLiveIframePlaybackSource: () => null,
    requestJson: requestJson || (async () => ({ playbackUrl: worker, playbackType: "hls", directMediaUrls: [direct], transportFallbackUrls: [origin] })),
    isResolveAbortError: (error) => error?.name === "AbortError",
    getSelectedLiveStreamOption: () => options.find((option) => option.id === context.selectedLiveStreamId),
    getOrderedLiveFallbackOptions: () => options.filter((option) => option.id !== context.selectedLiveStreamId && !context.liveAutoFallbackAttemptedStreamIds.has(option.id)),
    rememberLiveStreamFailure: (option) => failed.push(option.id),
    setExplicitPlaybackSourceState: (source) => { context.src = source; },
    setVideoSource: (source, settings) => { switched.push({ source, ...settings }); context.video.paused = !settings.autoplay; },
    tryPlay: () => { playRequests += 1; return new Promise(() => {}); },
    hasLivePlaybackStarted: () => true, isStartupArmed: () => false,
    scheduleLiveFallbackRetry: () => { retries += 1; },
    clearLiveVisualHealthWatch() {}, clearLiveStartupHealthWatch() {},
    startLiveVisualHealthWatch() {}, armLiveStartupHealthWatch() {},
    syncLiveStreamControls() {}, persistLiveStreamSelectionInUrl() {}, resetLiveStreamPlaybackState() {},
    syncPlayState() {}, syncDurationText() {}, closeLiveStreamPopover() {}, showResolver() {}, hideResolver() {},
    showResolverError(error) { throw error; },
  };
  vm.createContext(context);
  vm.runInContext(functions, context);
  return { context, switched, failed, get retries() { return retries; }, get playRequests() { return playRequests; } };
}

test("one-provider live channel tries direct, Worker, then origin without changing provider", async () => {
  const state = harness();
  const { context } = state;
  assert.equal(await context.resolveLivePlaybackSource(context.src), direct);
  assert.equal(await context.attemptAutomaticLiveStreamFallback(), true);
  assert.equal(state.switched[0].source, worker);
  assert.equal(context.selectedLiveStreamId, "a");
  assert.equal(context.src, "https://provider.example/a");
  assert.deepEqual(state.failed, []);
  assert.equal(await context.attemptAutomaticLiveStreamFallback(), true);
  assert.equal(state.switched[1].source, origin);
  assert.deepEqual(state.failed, []);
  assert.equal(await context.attemptAutomaticLiveStreamFallback(), false);
  assert.deepEqual(state.failed, ["a"]);
  assert.equal(state.retries, 1);
  assert.equal(state.playRequests, 2, "play() waiting for frames must not hold the recovery lock");
});

test("movie and TV source application explicitly opts in to direct URLs without mutating the native payload", () => {
  for (const mediaType of ["movie", "tv"]) {
    const resolved = { mediaType, playableUrl: worker, fallbackUrls: [origin], directMediaUrls: [direct], sourceHash: "provider-a" };
    const originalPayload = JSON.stringify(resolved);
    let queue;
    const context = {
      resolved, buildMediaDeliveryQueue, buildOrderedRemuxFallbacks, buildResolvedRemuxVariantSource,
      buildPreferredBrowserPlaybackSource: (source) => source,
      shouldAvoidRemuxFallbackForHls: () => false,
      activeTrackSourceInput: "", selectedAudioStreamIndex: -1, selectedSubtitleStreamIndex: -1,
      normalizedResolvedSourceHash: "provider-a", preferredAudioSyncMs: 0,
      parseTranscodeSource: () => null, buildSoftwareDecodeUrl: () => "",
      setTmdbSourceQueue(primary, fallbacks) { queue = [primary, ...fallbacks]; },
    };
    vm.runInNewContext(extract('  const nativePreferredSource = String(resolved?.playableUrl', '  if (isProvisionalManualSourceSwitch) {'), context);
    assert.deepEqual(queue, [direct, worker, origin]);
    assert.equal(JSON.stringify(resolved), originalPayload);
  }
});

test("missing direct opt-in preserves legacy web and native delivery order", async () => {
  assert.deepEqual(buildMediaDeliveryQueue(worker, [origin]), [worker, origin]);
  const state = harness({ requestJson: async () => ({ playbackUrl: worker, transportFallbackUrls: [origin] }) });
  assert.equal(await state.context.resolveLivePlaybackSource(state.context.src), worker);
  await state.context.attemptAutomaticLiveStreamFallback();
  assert.equal(state.switched[0].source, origin);
});

test("direct variant URLs remain ordered ahead of Worker and same-origin variants", () => {
  assert.deepEqual(buildMediaDeliveryQueue(`${worker}&directSegments=1`, [worker, `${origin}&directSegments=1`, origin], [`${direct}&directSegments=1`, direct]), [
    `${direct}&directSegments=1`, direct, `${worker}&directSegments=1`, worker, `${origin}&directSegments=1`, origin,
  ]);
});

test("direct candidates are deduplicated and limited to the primary public signed HLS source", () => {
  const invalid = [null, {}, "", direct.replace("https:", "http:"),
    direct.replace("media.example", "user:password@media.example"),
    direct.replace("input=signed", "input=another-provider"),
    `${direct}&referer=https://wrong.example/`, `${direct}&privateSession=1`,
    direct.replace("sig=test-signature", "sig=wrong-signature"),
    direct.replace("hls.m3u8", "hls-resource"), "javascript:test.m3u8"];
  assert.deepEqual(buildMediaDeliveryQueue(worker, [origin, worker], [...invalid.slice(0, 4), ` ${direct} `, direct, ...invalid.slice(4)]), [direct, worker, origin]);
  for (const candidate of invalid) assert.deepEqual(buildMediaDeliveryQueue(worker, [origin], [candidate]), [worker, origin]);
  assert.deepEqual(buildMediaDeliveryQueue("/api/remux?input=video", [], [direct]), ["/api/remux?input=video"]);
  assert.deepEqual(buildMediaDeliveryQueue(`${worker}&privateSession=1`, [], [direct]), [`${worker}&privateSession=1`]);
});

test("all delivery routes must fail before a different provider is selected", async () => {
  const state = harness({ options: [{ id: "a", source: "https://provider.example/a" }, { id: "b", source: "https://provider.example/b" }] });
  const { context } = state;
  await context.resolveLivePlaybackSource(context.src);
  await context.attemptAutomaticLiveStreamFallback();
  await context.attemptAutomaticLiveStreamFallback();
  assert.equal(context.selectedLiveStreamId, "a");
  await context.attemptAutomaticLiveStreamFallback();
  assert.equal(context.selectedLiveStreamId, "b");
  assert.equal(state.switched[2].source, direct);
  assert.deepEqual(state.failed, ["a"]);
});

test("concurrent media error callbacks consume only one route", async () => {
  const state = harness();
  await state.context.resolveLivePlaybackSource(state.context.src);
  await Promise.all([state.context.attemptAutomaticLiveStreamFallback(), state.context.attemptAutomaticLiveStreamFallback()]);
  assert.equal(state.switched.length, 1);
  assert.equal(state.switched[0].source, worker);
  assert.equal(state.context.liveTransportFallback.takeNext(), origin);
});

test("fallback keeps intentionally paused playback paused", async () => {
  const state = harness();
  await state.context.resolveLivePlaybackSource(state.context.src);
  state.context.video.paused = true;
  state.context.liveAutoplayRequested = false;
  await state.context.attemptAutomaticLiveStreamFallback();
  assert.equal(state.switched[0].autoplay, false);
  assert.equal(state.playRequests, 0);
});

test("a fatal media error pausing the video does not override the viewer's play intent", async () => {
  const state = harness();
  await state.context.resolveLivePlaybackSource(state.context.src);
  state.context.video.paused = true;
  state.context.liveAutoplayRequested = true;
  await state.context.attemptAutomaticLiveStreamFallback();
  assert.equal(state.switched[0].autoplay, true);
  assert.equal(state.playRequests, 1);
});

test("old-media errors cannot change a provider while its manual resolution is pending", async () => {
  const response = Promise.withResolvers();
  const options = [{ id: "a", source: "https://provider.example/a" }, { id: "b", source: "https://provider.example/b" }];
  const state = harness({ options, requestJson: () => response.promise });
  const pending = state.context.switchToLiveStreamOption(options[1]);
  assert.equal(await state.context.attemptAutomaticLiveStreamFallback(), true);
  assert.deepEqual(state.failed, []);
  assert.equal(state.switched.length, 0);
  assert.equal(state.context.selectedLiveStreamId, "b");
  response.resolve({ playbackUrl: direct, transportFallbackUrls: [worker, origin] });
  assert.equal(await pending, true);
  assert.equal(state.switched[0].source, direct);
});

test("bounded retry re-resolves a failed paused media element but respects a user pause", async () => {
  const state = harness();
  let retry;
  state.context.liveFallbackRetry = { schedule(callback) { retry = callback; return true; } };
  state.context.document = { visibilityState: "visible" };
  state.context.resetLiveAutoFallbackAttempts = () => {};
  vm.runInContext(extract("function scheduleLiveFallbackRetry(", "function openLiveStreamPopover("), state.context);
  state.context.video.paused = true;
  state.context.scheduleLiveFallbackRetry("retry");
  await retry();
  assert.equal(state.switched[0].source, direct);
  assert.equal(state.switched[0].autoplay, true);
  state.context.liveAutoplayRequested = false;
  state.context.scheduleLiveFallbackRetry("retry");
  await retry();
  assert.equal(state.switched.length, 1);
});

test("a synchronous delivery setup failure advances to the next transport", async () => {
  const state = harness();
  await state.context.resolveLivePlaybackSource(state.context.src);
  const setSource = state.context.setVideoSource;
  state.context.setVideoSource = (source, options) => {
    if (source === worker) throw new Error("transport unavailable");
    setSource(source, options);
  };
  await state.context.attemptAutomaticLiveStreamFallback();
  assert.equal(state.switched[0].source, origin);
  assert.deepEqual(state.failed, []);
});

test("manual selection supersedes a pending resolver and cannot restore the previous provider", async () => {
  const response = Promise.withResolvers();
  const options = [{ id: "a", source: "https://provider.example/a" }, { id: "b", source: "https://provider.example/b" }];
  const state = harness({ options, requestJson: () => response.promise });
  const pending = state.context.switchToLiveStreamOption(options[1], { autoFallback: true });
  state.context.liveTransportFallback.reset();
  state.context.selectedLiveStreamId = "new-manual-selection";
  state.context.src = "https://provider.example/new";
  response.resolve({ playbackUrl: direct, transportFallbackUrls: [worker, origin], source: options[0].source });
  assert.equal(await pending, false);
  assert.equal(state.context.selectedLiveStreamId, "new-manual-selection");
  assert.equal(state.context.src, "https://provider.example/new");
  assert.equal(state.context.liveTransportFallback.hasFallback(), false);
  assert.equal(state.switched.length, 0);
});

test("a newer resolution replaces delivery URLs and rejects an older response", async () => {
  const first = Promise.withResolvers();
  let requests = 0;
  const state = harness({ requestJson: () => ++requests === 1 ? first.promise : Promise.resolve({ playbackUrl: origin }) });
  const pending = state.context.resolveLivePlaybackSource(state.context.src);
  const rejection = assert.rejects(pending, { name: "AbortError" });
  assert.equal(await state.context.resolveLivePlaybackSource("https://provider.example/b"), origin);
  first.resolve({ playbackUrl: direct, transportFallbackUrls: [worker] });
  await rejection;
  assert.equal(state.context.liveTransportFallback.hasFallback(), false);
  assert.equal(state.context.liveTransportFallback.isKnownSource(origin), true);
});

test("duplicate, empty and unsupported delivery URLs do not enter the queue", async () => {
  const state = harness({ requestJson: async () => ({ playbackUrl: direct, transportFallbackUrls: [direct, "", null, {}, "https://provider.example/embed", worker, worker, origin] }) });
  await state.context.resolveLivePlaybackSource(state.context.src);
  assert.equal(state.context.liveTransportFallback.takeNext(), worker);
  assert.equal(state.context.liveTransportFallback.takeNext(), origin);
  assert.equal(state.context.liveTransportFallback.takeNext(), "");
});

test("stale recovery finishing cannot clear the newer source's recovery lock", async () => {
  const controller = createLiveTransportFallbackController();
  const oldWait = Promise.withResolvers();
  const newWait = Promise.withResolvers();
  const old = controller.runRecovery(() => oldWait.promise);
  await Promise.resolve();
  controller.reset();
  const newer = controller.runRecovery(() => newWait.promise);
  await Promise.resolve();
  oldWait.resolve(true);
  await old;
  assert.equal(controller.isRecovering(), true);
  assert.equal(controller.runRecovery(() => assert.fail("duplicate recovery")), newer);
  newWait.resolve(true);
  await newer;
  assert.equal(controller.isRecovering(), false);
});

test("a queued native error cleared by source replacement cannot consume a delivery route", () => {
  let onError;
  let recoveries = 0;
  const context = {
    video: { error: null },
    trackListener: (_, __, handler) => { onError = handler; },
    clearLiveVisualHealthWatch() {}, clearLiveStartupHealthWatch() {}, hideSeekLoadingIndicator() {},
    isLiveIframePlaybackActive: () => false,
    isLivePlayback: true,
    handleLivePlaybackFailure: () => { recoveries += 1; },
  };
  vm.runInNewContext(extract('trackListener(video, "error", () => {', "function isInteractiveTarget("), context);
  onError();
  assert.equal(recoveries, 0);
  context.video.error = { message: "Network failed" };
  onError();
  assert.equal(recoveries, 1);
});

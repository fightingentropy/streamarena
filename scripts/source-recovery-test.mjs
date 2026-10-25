#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";
import * as manual from "../src-ui/player/manual-source-switch.js";
import { createPlaybackRouting } from "../src-ui/player/playback-routing.js";
import {
  AUTOMATIC_RECOVERY_BUDGET_MS,
  AUTOMATIC_RECOVERY_MAX_SOURCES,
  createSourceRecoveryBudget,
  describeFailedSourceRecovery,
  runBoundedSourceRecovery,
} from "../src-ui/player/source-recovery.js";

const source = await readFile(new URL("../src-ui/pages/player.js", import.meta.url), "utf8");
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const flush = () => new Promise(resolve => setImmediate(resolve));
const hash = letter => letter.repeat(40);
const [A, B, C, D, E] = ["a", "b", "c", "d", "e"].map(hash);
const unavailable = () => Object.assign(new Error("Selected external HLS source is unavailable. Try another server."), { status: 424 });
const { pickResolverAlternateSourceHash } = createPlaybackRouting({});
const sourceList = [B, C, D, E].map((sourceHash, index) => ({
  sourceHash, container: "hls", isTorrent: false, automaticFallbackEligible: true, score: 1_000 - index,
}));

test("recovery stops after the source cap and never resolves a source twice", async () => {
  const failed = new Set([A]);
  const budget = createSourceRecoveryBudget({ knownFailedSourceHashes: failed });
  budget.begin(A);
  const resolved = [];
  const outcome = await runBoundedSourceRecovery({
    budget,
    pickSourceHash: avoided => pickResolverAlternateSourceHash({ availablePlaybackSources: sourceList,
      resolverFailedSourceHashes: avoided, allowPreviouslyFailedFallback: false }) || null,
    resolveSource: async ({ sourceHash, avoidSourceHashes }) => {
      assert(!avoidSourceHashes.includes(sourceHash), "a pinned candidate must not be in its own avoid list");
      resolved.push(sourceHash);
      throw unavailable();
    },
  });
  assert.equal(outcome.recovered, false);
  assert.deepEqual(resolved, [B, C, D]);
  assert.equal(resolved.length, AUTOMATIC_RECOVERY_MAX_SOURCES);
  assert(budget.isExhausted());
  assert.deepEqual([...failed].sort(), [A, B, C, D], "failed candidates stay avoided for this page");
});

test("the time budget caps each resolve and ends recovery", async () => {
  let now = 0;
  const budget = createSourceRecoveryBudget({ nowFn: () => now });
  budget.begin(A);
  const timeouts = [];
  const outcome = await runBoundedSourceRecovery({
    budget,
    pickSourceHash: avoided => [B, C, D].find(candidate => !avoided.has(candidate)) ?? null,
    resolveSource: async ({ timeoutMs }) => {
      timeouts.push(timeoutMs);
      now += 35_000;
      throw unavailable();
    },
  });
  assert.equal(outcome.recovered, false);
  assert.deepEqual(timeouts, [AUTOMATIC_RECOVERY_BUDGET_MS, AUTOMATIC_RECOVERY_BUDGET_MS - 35_000]);
  assert.equal(budget.summary().sources, 2);
});

test("a server pick sends every tried source and does not repeat after it fails", async () => {
  const budget = createSourceRecoveryBudget({ knownFailedSourceHashes: new Set([E]) });
  budget.begin(A);
  const requests = [];
  const outcome = await runBoundedSourceRecovery({
    budget,
    pickSourceHash: () => "",
    resolveSource: async request => {
      requests.push(request);
      throw unavailable();
    },
  });
  assert.equal(outcome.recovered, false);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].avoidSourceHashes, [A, E]);
});

test("a source that resolves after the viewer acts is stale, not a new failure", async () => {
  const budget = createSourceRecoveryBudget();
  budget.begin(A);
  let current = true;
  const outcome = await runBoundedSourceRecovery({
    budget,
    isCurrent: () => current,
    pickSourceHash: () => B,
    resolveSource: async () => {
      current = false;
      throw unavailable();
    },
  });
  assert.deepEqual(outcome, { stale: true });
  assert.equal(budget.summary().sources, 1);
});

test("sustained playback ends the attempt; a reset starts a fresh one", () => {
  const budget = createSourceRecoveryBudget({ settleSeconds: 30 });
  budget.begin(A);
  budget.claimSource();
  assert.equal(budget.noteProgress(600), false);
  assert.equal(budget.noteProgress(620), false);
  assert.equal(budget.noteProgress(630), true);
  assert.equal(budget.isActive(), false);
  budget.begin(B);
  budget.fail();
  assert(budget.hasFailed());
  budget.reset();
  assert.equal(budget.hasFailed(), false);
  assert.deepEqual(budget.avoidedSourceHashes(), []);
});

test("the avoid list keeps recent failures first and stays bounded", () => {
  const known = new Set(Array.from({ length: 20 }, (_, index) => index.toString(16).padStart(40, "0")));
  const budget = createSourceRecoveryBudget({ knownFailedSourceHashes: known });
  budget.begin(A);
  const avoided = budget.avoidedSourceHashes();
  assert.equal(avoided[0], A);
  assert.equal(avoided.length, 16);
});

test("an automatic resolve cannot replay a source that already failed", async () => {
  let applied = false;
  const context = {
    ...manual, tmdbPlaybackRequestToken: 1, tmdbSkipExternalEmbed: false,
    isTmdbResolvedPlayback: true, isTmdbTvPlayback: false, tmdbId: 123,
    selectedSourceHash: "", preferredResolverProvider: "fastest", userLocalTorrentEnabled: false,
    availablePlaybackSources: [{}], video: { currentTime: 600, paused: false },
    isManualSourceSwitchPending: () => false, stopLocalCacheUpgradeWatch() {},
    localCacheUpgradeWatch: { setHasUpgraded() {} }, getPinnedSourceHashForRequests: () => "",
    isTorrentResolverProvider: () => false, resolveTorrentRequestProvider: () => "fastest",
    isUserRealDebridPlaybackEnabled: () => false, normalizeSourceHash: value => value,
    // An older server ignores avoidSourceHashes and returns its top-ranked source.
    resolveTmdbMovieViaBackend: async (_, options) => {
      assert.deepEqual(options.avoidSourceHashes, [A]);
      return { sourceHash: A };
    },
    runResolveWithSupersession: async ({ resolve }) => ({ value: await resolve(), stale: false }),
    getManualSourceSwitchRestoreSource: () => "A-url",
    applyResolvedTmdbPlayback: async () => { applied = true; },
  };
  context.getEffectiveCurrentTime = () => context.video.currentTime;
  vm.createContext(context);
  vm.runInContext(extract("async function resolveTmdbSourcesAndPlay({", "// A single source can expose"), context);
  await assert.rejects(context.resolveTmdbSourcesAndPlay({
    playbackRequestToken: 1, refreshResolve: true, allowSourceFallback: false, avoidSourceHashes: [A],
  }), /already failed/);
  assert.equal(applied, false);
});

// Production, 2026-10-25: each replacement's opening segments played, then its
// media returned 424. The player re-resolved for 106 s with no final state.
function recoveryHarness({ fails = new Set(), sources = sourceList } = {}) {
  let now = 0;
  const failed = new Set();
  const resolves = [];
  const context = {
    console: { error() {} }, isTmdbResolvedPlayback: true, isRecoveringTmdbStream: false,
    isManualSourceSwitchPending: () => false, resolverFailedSourceHashes: failed,
    sourceRecovery: createSourceRecoveryBudget({ knownFailedSourceHashes: failed, nowFn: () => now }),
    runBoundedSourceRecovery, describeFailedSourceRecovery,
    normalizeSourceHash: value => String(value || "").toLowerCase(),
    selectedSourceHash: A, sourceSelectionPinned: false, currentTmdbPlaybackSessionKey: "",
    tmdbPlaybackRequestToken: 0, tmdbSkipExternalEmbed: false, preferredResolverProvider: "fastest",
    DEFAULT_RESOLVER_PROVIDER: "fastest", availablePlaybackSources: sources,
    pickResolverAlternateSourceHashFromRouting: pickResolverAlternateSourceHash,
    getEffectiveCurrentTime: () => 600, stopLocalCacheUpgradeWatch() {},
    hasQueuedTmdbSourceFallback: () => false, tryNextTmdbSource: async () => true,
    reportCurrentTmdbPlaybackFailure: async () => true,
    demoteCurrentExternalEmbedSourceForRecovery: () => {
      failed.add(context.selectedSourceHash);
      context.selectedSourceHash = "";
      return Promise.resolve(true);
    },
    resolveTmdbSourcesAndPlay: async options => {
      resolves.push(options);
      now += 6_000;
      if (fails.has(options.requestSourceHash)) throw unavailable();
      context.selectedSourceHash = options.requestSourceHash;
      return { nativeLaunched: false, resolved: { sourceHash: options.requestSourceHash } };
    },
    video: { paused: false, pause() { this.paused = true; } },
    overlay: null,
    showResolver: message => { context.overlay = { message, error: false }; },
    showResolverError: (message, _fallback, options) => { context.overlay = { message, error: true, ...options }; },
  };
  vm.createContext(context);
  vm.runInContext(`${extract("function attemptTmdbRecovery(", "function setEpisodeLabel(")}
${extract("function pickResolverAlternateSourceHash(", "async function resolveTmdbFromResolverAction(")}`, context);
  const mediaFails = async () => {
    const handled = context.attemptTmdbRecovery("Trying alternate source...", { sourceUnavailable: true });
    for (let index = 0; index < 5; index++) await flush();
    return handled;
  };
  return { context, resolves, failed, mediaFails };
}

test("replacements that start and then lose their media end in a final error", async () => {
  const { context, resolves, mediaFails } = recoveryHarness({ fails: new Set([C]) });
  assert.equal(await mediaFails(), true);
  assert.equal(context.selectedSourceHash, B);
  assert.equal(await mediaFails(), true);
  assert.equal(context.selectedSourceHash, D, "C's resolve failed, so recovery moved on to D");
  assert.equal(await mediaFails(), true);

  const pinned = resolves.map(request => request.requestSourceHash);
  assert.deepEqual(pinned, [B, C, D]);
  assert(!pinned.includes(A), "the source whose media failed is never re-resolved");
  assert(resolves.every(request => request.refreshResolve && request.allowSourceFallback === false),
    "each claimed source is one fresh resolve, without a hidden unpinned fallback");
  assert.equal(context.overlay.error, true);
  assert.equal(context.overlay.showRetry, true);
  assert.match(context.overlay.message, /after trying 3 other sources\. Retry now, or try another source\./);
  assert.equal(context.video.paused, true, "the broken source must not play over the final error");

  // Late stall/media callbacks from the abandoned source change nothing.
  const finalOverlay = context.overlay;
  assert.equal(await mediaFails(), true);
  assert.equal(resolves.length, 3);
  assert.equal(context.overlay, finalOverlay);

  // Retry now / Try another source reset the attempt.
  context.sourceRecovery.reset();
  context.selectedSourceHash = D;
  assert.equal(await mediaFails(), true);
  assert.equal(resolves.at(-1).requestSourceHash, E);
});

test("without a source list the server chooses, avoiding the failed source", async () => {
  const { context, resolves, mediaFails } = recoveryHarness({ sources: [], fails: new Set([""]) });
  await mediaFails();
  assert.equal(resolves.length, 1);
  assert.equal(resolves[0].requestSourceHash, "");
  assert.deepEqual(resolves[0].avoidSourceHashes, [A]);
  assert.equal(context.overlay.error, true);
  assert.match(context.overlay.message, /after trying another source/);
});

#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

import {
  aggregateTrials,
  allResolveStartsAcknowledgeHealthSuppression,
  alignBenchmarkMilestones,
  assertSameAuthOrigin,
  assertSanitizedReport,
  authAccountFromPayload,
  authAccountIdentifier,
  benchmarkFetchDecision,
  buildDiscoveryReportEntry,
  buildProviderBenchmarkInitScript,
  chooseAuthenticatedCandidate,
  classifyExternalSourceRows,
  classifyNetworkRoute,
  classifyResolveOutcome,
  classifyResolveResponsePayload,
  classifyResponseRole,
  computeGate,
  computeRequiredCoverage,
  createIsolatedAuthenticatedContext,
  createNetworkCapture,
  createResolveObserver,
  extractConfiguredLiveHlsWorkerOrigins,
  isExternalSourceRow,
  isSameOriginResolveStart,
  orderSources,
  parseArgs,
  parseMovieSpec,
  parseRemuxServerTiming,
  parseTvSpec,
  PROVIDER_BENCHMARK_HEADER,
  PROVIDER_HEALTH_RECORDING_ACK_HEADER,
  providerBenchmarkHelpText,
  readConfiguredLiveHlsWorkerOrigins,
  REQUIRED_BASE_PROVIDERS,
  runWithDeadline,
  sanitizeProviderLabel,
  assertProviderBenchmarkCapability,
  summarizePlaybackWindow,
  summarizeResolveObservations,
  writeReportAtomically,
} from "./provider-playback-benchmark.mjs";

assert.deepEqual(parseMovieSpec("27205"), {
  mediaType: "movie",
  tmdbId: "27205",
  seasonNumber: 0,
  episodeNumber: 0,
});
assert.deepEqual(parseTvSpec("1396:1:1"), {
  mediaType: "tv",
  tmdbId: "1396",
  seasonNumber: 1,
  episodeNumber: 1,
});
assert.throws(() => parseTvSpec("1396:1"));

const args = parseArgs([
  "--cdp-endpoint",
  "http://127.0.0.1:9222",
  "--movie",
  "27205",
  "--tv",
  "1396:1:1",
  "--trials",
  "2",
  "--order",
  "reversed",
]);
assert.equal(args.cases.length, 2);
assert.equal(args.trials, 2);
assert.equal(args.order, "reversed");
assert.equal(args.includeVariants, false);
assert.match(
  providerBenchmarkHelpText(),
  /Allow playback failures; coverage and safety gates still apply/,
);

assert.equal(
  assertSameAuthOrigin(
    "https://stream.example/watch/movie/1",
    "https://stream.example/elsewhere",
  ),
  "https://stream.example",
);

const workerProviderPayload = {
  providers: [
    {
      key: "infra:live-hls-worker",
      custom: true,
      effectiveUrl: "https://attacker.invalid",
    },
    {
      key: "infra:live-hls-worker",
      custom: false,
      effectiveUrl: "https://live.streamarena.xyz",
    },
  ],
};
assert.deepEqual(
  extractConfiguredLiveHlsWorkerOrigins(workerProviderPayload),
  ["https://live.streamarena.xyz"],
);
assert.deepEqual(
  extractConfiguredLiveHlsWorkerOrigins({
    providers: [
      {
        key: "infra:live-hls-worker",
        custom: false,
        effectiveUrl: "",
      },
    ],
  }),
  [],
);
assert.throws(
  () =>
    extractConfiguredLiveHlsWorkerOrigins({
      providers: [
        {
          key: "infra:live-hls-worker",
          custom: false,
          effectiveUrl: "https://live.streamarena.xyz/unexpected-prefix",
        },
      ],
    }),
  (error) => error?.benchmarkCode === "LIVE_HLS_WORKER_CONFIG_INVALID",
);

const pinnedHash = "a".repeat(40);
const otherHash = "b".repeat(40);
const benchmarkPageUrl = `https://stream.example/watch/movie/27205?sourceHash=${pinnedHash}&benchmark=1`;
assert.equal(
  benchmarkFetchDecision(
    `/api/resolve/movie?tmdbId=27205&sourceHash=${pinnedHash}`,
    benchmarkPageUrl,
    "https://stream.example",
  ),
  "allow-pinned-resolve",
);
assert.equal(
  benchmarkFetchDecision(
    `/api/resolve/movie?tmdbId=27205&sourceHash=${otherHash}`,
    benchmarkPageUrl,
    "https://stream.example",
  ),
  "block-unpinned-resolve",
);
assert.equal(
  benchmarkFetchDecision(
    "/api/resolve/movie?tmdbId=27205",
    benchmarkPageUrl,
    "https://stream.example",
  ),
  "block-unpinned-resolve",
);
assert.equal(
  benchmarkFetchDecision(
    "https://other.example/api/resolve/movie?sourceHash=" + pinnedHash,
    benchmarkPageUrl,
    "https://stream.example",
  ),
  "passthrough",
);
assert.equal(
  benchmarkFetchDecision(
    "/api/user/watch-progress",
    benchmarkPageUrl,
    "https://stream.example",
  ),
  "empty-progress-read",
);
assert.equal(
  benchmarkFetchDecision(
    "/api/user/watch-progress-extra",
    benchmarkPageUrl,
    "https://stream.example",
    "POST",
  ),
  "passthrough",
);
assert.equal(
  benchmarkFetchDecision(
    "/api/session/progress",
    benchmarkPageUrl,
    "https://stream.example",
    "GET",
  ),
  "block-progress-mutation",
);
assert.equal(
  allResolveStartsAcknowledgeHealthSuppression([
    {
      requestPinned: true,
      healthRecordingAcknowledgement: "suppressed",
    },
  ]),
  true,
);
for (const starts of [
  [],
  [{ requestPinned: true, healthRecordingAcknowledgement: "" }],
  [{ requestPinned: true, healthRecordingAcknowledgement: "Suppressed" }],
  [{ requestPinned: false, healthRecordingAcknowledgement: "suppressed" }],
]) {
  assert.equal(allResolveStartsAcknowledgeHealthSuppression(starts), false);
}
assert.equal(
  isSameOriginResolveStart(
    "https://stream.example/api/resolve/movie?tmdbId=27205",
    "https://stream.example",
  ),
  true,
);
assert.equal(
  isSameOriginResolveStart(
    "https://other.example/api/resolve/movie?tmdbId=27205",
    "https://stream.example",
  ),
  false,
);
assert.equal(
  isSameOriginResolveStart(
    "https://stream.example/api/resolve/movie/extra",
    "https://stream.example",
  ),
  false,
);
assert.equal(
  PROVIDER_HEALTH_RECORDING_ACK_HEADER,
  "x-streamarena-provider-health-recording",
);

function resolveObservation({
  isResolveStart = false,
  requestPinned = true,
  status = 200,
  payload = null,
  jsonParsed = true,
  completedAtMs = null,
} = {}) {
  return {
    isResolveStart,
    requestPinned,
    healthRecordingAcknowledgement: isResolveStart ? "suppressed" : "",
    status,
    identityCompletedAtMs: completedAtMs,
    ...classifyResolveResponsePayload(status, payload, { jsonParsed }),
  };
}

const pendingThenFailedPinning = summarizeResolveObservations(
  [
    resolveObservation({
      isResolveStart: true,
      payload: { jobId: "job-one", status: "pending" },
    }),
    resolveObservation({
      payload: { jobId: "job-one", status: "error", error: "unavailable" },
    }),
  ],
  pinnedHash,
);
assert.equal(pendingThenFailedPinning.pendingResolveResponse, true);
assert.equal(pendingThenFailedPinning.failedResolveResponse, true);
assert.equal(pendingThenFailedPinning.successfulResolveResponse, false);
assert.equal(pendingThenFailedPinning.terminalIdentityInvalid, false);
const failedPinnedResolve = classifyResolveOutcome(pendingThenFailedPinning);
assert.deepEqual(failedPinnedResolve.failureCodes, ["RESOLVE_FAILED"]);
assert.equal(
  computeGate(
    [{ success: false, failureCodes: failedPinnedResolve.failureCodes }],
    0,
    { passed: true },
  ).integrityPassed,
  true,
);

const pinnedHttpFailure = classifyResolveOutcome(
  summarizeResolveObservations(
    [resolveObservation({ isResolveStart: true, status: 424 })],
    pinnedHash,
  ),
);
assert.deepEqual(pinnedHttpFailure.failureCodes, ["RESOLVE_FAILED"]);

const playablePendingPinning = summarizeResolveObservations(
  [
    resolveObservation({
      isResolveStart: true,
      payload: { status: "pending", playableUrl: "/api/remux" },
    }),
  ],
  pinnedHash,
);
assert.equal(playablePendingPinning.successfulResolveResponse, true);
assert.equal(playablePendingPinning.pendingResolveResponse, false);
assert.deepEqual(classifyResolveOutcome(playablePendingPinning).failureCodes, [
  "RESOLVE_IDENTITY_INVALID",
]);

const playableErrorPinning = summarizeResolveObservations(
  [
    resolveObservation({
      isResolveStart: true,
      payload: {
        status: "error",
        playableUrl: "/api/remux",
        sourceHash: otherHash,
        resolverProvider: "external-embed",
      },
    }),
  ],
  pinnedHash,
);
assert.equal(playableErrorPinning.successfulResolveResponse, true);
assert.equal(playableErrorPinning.failedResolveResponse, false);
assert.deepEqual(classifyResolveOutcome(playableErrorPinning).failureCodes, [
  "PIN_MISMATCH",
]);

const resolveObserverHandlers = new Map();
const resolveObserverPage = {
  on(name, handler) {
    resolveObserverHandlers.set(name, handler);
  },
  off(name, handler) {
    if (resolveObserverHandlers.get(name) === handler) {
      resolveObserverHandlers.delete(name);
    }
  },
};
const cancellationObserver = createResolveObserver(
  resolveObserverPage,
  "https://stream.example",
  pinnedHash,
  { mediaType: "movie" },
  performance.now(),
  performance.now() + 1_000,
);
const resolveJobUrl = "https://stream.example/api/resolve/job/job-one";
for (const [method, status] of [
  ["DELETE", 204],
  ["POST", 200],
  ["PATCH", 200],
]) {
  resolveObserverHandlers.get("response")({
    url: () => resolveJobUrl,
    request: () => ({ method: () => method }),
    status: () => status,
    ok: () => status >= 200 && status < 300,
    headers: () => ({}),
    json: async () => null,
  });
}
const cancellationPinning = await cancellationObserver.result();
assert.equal(cancellationPinning.terminalIdentityInvalid, false);
assert.equal(cancellationPinning.successfulResolveResponse, false);
assert.deepEqual(classifyResolveOutcome(cancellationPinning).failureCodes, [
  "RESOLVE_FAILED",
]);

for (const terminalWithoutIdentity of [
  resolveObservation({
    isResolveStart: true,
    payload: { status: "done", result: { playableUrl: "/api/remux" } },
  }),
  resolveObservation({
    isResolveStart: true,
    payload: { unexpected: true },
  }),
  resolveObservation({
    isResolveStart: true,
    payload: null,
    jsonParsed: false,
  }),
  resolveObservation({
    isResolveStart: true,
    payload: { playableUrl: "/api/remux" },
  }),
  resolveObservation({
    isResolveStart: true,
    payload: { playableUrl: "/api/remux", sourceHash: pinnedHash },
  }),
  resolveObservation({
    isResolveStart: true,
    payload: {
      playableUrl: "/api/remux",
      sourceHash: "invalid-hash",
      resolverProvider: "external-embed",
    },
  }),
]) {
  const malformedPinning = summarizeResolveObservations(
    [terminalWithoutIdentity],
    pinnedHash,
  );
  assert.equal(malformedPinning.successfulResolveResponse, true);
  assert.equal(malformedPinning.terminalIdentityInvalid, true);
  const malformedOutcome = classifyResolveOutcome(malformedPinning);
  assert.deepEqual(malformedOutcome.failureCodes, ["RESOLVE_IDENTITY_INVALID"]);
  assert.equal(
    computeGate(
      [{ success: false, failureCodes: malformedOutcome.failureCodes }],
      0,
      { passed: true },
    ).integrityPassed,
    false,
  );
}

const mismatchedResolveHash = classifyResolveOutcome(
  summarizeResolveObservations(
    [
      resolveObservation({
        isResolveStart: true,
        payload: {
          playableUrl: "/api/remux",
          sourceHash: otherHash,
          resolverProvider: "external-embed",
        },
      }),
    ],
    pinnedHash,
  ),
);
assert.deepEqual(mismatchedResolveHash.failureCodes, ["PIN_MISMATCH"]);

const mismatchedResolveProvider = classifyResolveOutcome(
  summarizeResolveObservations(
    [
      resolveObservation({
        isResolveStart: true,
        payload: {
          playableUrl: "/api/remux",
          sourceHash: pinnedHash,
          resolverProvider: "real-debrid",
        },
      }),
    ],
    pinnedHash,
  ),
);
assert.deepEqual(mismatchedResolveProvider.failureCodes, ["PROVIDER_MISMATCH"]);
for (const mismatch of [mismatchedResolveHash, mismatchedResolveProvider]) {
  assert.equal(
    computeGate(
      [{ success: false, failureCodes: mismatch.failureCodes }],
      0,
      { passed: true },
    ).integrityPassed,
    false,
  );
}

const validResolvedPayload = {
  playableUrl: "/api/remux",
  sourceHash: pinnedHash,
  metadata: { resolverProvider: "external-embed" },
};
const validMatchedPinning = summarizeResolveObservations(
  [
    resolveObservation({
      isResolveStart: true,
      payload: { status: "done", result: validResolvedPayload },
      completedAtMs: 37,
    }),
  ],
  pinnedHash,
);
assert.equal(validMatchedPinning.successfulResolveResponse, true);
assert.equal(validMatchedPinning.hashMatched, true);
assert.equal(validMatchedPinning.providerMatched, true);
assert.equal(validMatchedPinning.terminalIdentityInvalid, false);
assert.equal(validMatchedPinning.resolveCompletionMs, 37);
assert.deepEqual(classifyResolveOutcome(validMatchedPinning).failureCodes, []);

const actualUnpinnedFallback = classifyResolveOutcome(
  summarizeResolveObservations(
    [
      resolveObservation({
        isResolveStart: true,
        requestPinned: false,
        payload: validResolvedPayload,
      }),
    ],
    pinnedHash,
  ),
);
assert.deepEqual(actualUnpinnedFallback.failureCodes, ["FALLBACK_DETECTED"]);
assert.equal(
  computeGate(
    [{ success: false, failureCodes: actualUnpinnedFallback.failureCodes }],
    0,
    { passed: true },
  ).integrityPassed,
  false,
);

const safelyBlockedFallbackAttempt = classifyResolveOutcome(
  pendingThenFailedPinning,
  { blockedFallbackRequests: 1 },
);
assert.deepEqual(safelyBlockedFallbackAttempt.failureCodes, ["RESOLVE_FAILED"]);
assert.equal(safelyBlockedFallbackAttempt.blockedFallbackRequests, 1);
assert.equal(
  computeGate(
    [
      {
        success: false,
        failureCodes: safelyBlockedFallbackAttempt.failureCodes,
      },
    ],
    0,
    { passed: true },
  ).integrityPassed,
  true,
);

const forwardedFetches = [];
const forwardedBeacons = [];
const browserSandbox = {
  Headers,
  JSON,
  Object,
  Promise,
  Request,
  Response,
  String,
  URL,
  fetch: async (request) => {
    forwardedFetches.push(request);
    return new Response("ok", { status: 200 });
  },
  location: { href: benchmarkPageUrl },
  navigator: {
    sendBeacon(rawUrl, data) {
      forwardedBeacons.push({ rawUrl, data });
      return true;
    },
  },
};
vm.createContext(browserSandbox);
vm.runInContext(
  buildProviderBenchmarkInitScript("https://stream.example"),
  browserSandbox,
);
assert.equal(
  buildProviderBenchmarkInitScript("https://stream.example").includes(".route("),
  false,
);
const pinnedResponse = await browserSandbox.fetch(
  `/api/resolve/movie?tmdbId=27205&sourceHash=${pinnedHash}`,
);
assert.equal(pinnedResponse.status, 200);
assert.equal(forwardedFetches.length, 1);
assert.equal(forwardedFetches[0].headers.get(PROVIDER_BENCHMARK_HEADER), "1");
const blockedResolve = await browserSandbox.fetch(
  `/api/resolve/movie?tmdbId=27205&sourceHash=${otherHash}`,
);
assert.equal(blockedResolve.status, 409);
assert.equal(forwardedFetches.length, 1);
const emptyProgress = await browserSandbox.fetch("/api/user/watch-progress");
assert.equal(emptyProgress.status, 200);
assert.deepEqual(await emptyProgress.json(), { entries: [] });
assert.equal(forwardedFetches.length, 1);
assert.equal(browserSandbox.navigator.sendBeacon("/api/session/progress", "ignored"), true);
assert.equal(forwardedBeacons.length, 0);
assert.equal(
  browserSandbox.__STREAMARENA_PROVIDER_BENCHMARK_SAFETY__
    .benchmarkResolveHeadersApplied,
  1,
);
assert.equal(
  browserSandbox.__STREAMARENA_PROVIDER_BENCHMARK_SAFETY__.blockedFallbackRequests,
  1,
);
assert.equal(
  browserSandbox.__STREAMARENA_PROVIDER_BENCHMARK_SAFETY__.blockedMutations,
  1,
);
assert.throws(
  () =>
    parseArgs([
      "--cdp-endpoint",
      "http://127.0.0.1:9222",
      "--base-url",
      "https://stream.example",
      "--auth-origin",
      "https://other.example",
      "--movie",
      "27205",
    ]),
  (error) => error?.benchmarkCode === "CROSS_ORIGIN_AUTH_FORBIDDEN",
);
assert.equal(
  parseArgs([
    "--cdp-endpoint",
    "http://127.0.0.1:9222",
    "--movie",
    "27205",
    "--include-variants",
  ]).includeVariants,
  true,
);
assert.equal(
  parseArgs([
    "--cdp-endpoint",
    "http://127.0.0.1:9222",
    "--movie",
    "27205",
    "--include-variants",
    "--base-only",
  ]).includeVariants,
  false,
);

assert.equal(
  isExternalSourceRow({ isTorrent: false, sourceHash: "a".repeat(40) }),
  true,
);
assert.equal(
  isExternalSourceRow({ isTorrent: true, sourceHash: "a".repeat(40) }),
  false,
);

const hashFor = (index) => index.toString(16).padStart(40, "0");
const baseRows = REQUIRED_BASE_PROVIDERS.movie.map((provider, index) => ({
  isTorrent: false,
  sourceHash: hashFor(index + 1),
  provider: "LivNet",
  primary: provider,
}));
baseRows.push({
  isTorrent: false,
  sourceHash: hashFor(20),
  provider: "LivNet",
  primary: "NebulaStreams",
});
baseRows.push({
  isTorrent: false,
  sourceHash: hashFor(21),
  provider: "VidEasy",
  primary: "Yoru",
});
baseRows.push({
  isTorrent: false,
  sourceHash: hashFor(22),
  provider: "CineJoy",
  primary: "CineJoy",
});

const movieManifest = classifyExternalSourceRows(baseRows, {
  mediaType: "movie",
});
assert.deepEqual(movieManifest.missingRequiredBaseProviders, []);
assert.equal(movieManifest.selected.length, 10);
assert.deepEqual(
  movieManifest.variants.map((source) => source.provider),
  ["VidEasy / Yoru"],
);
assert.deepEqual(
  movieManifest.additional.map((source) => source.provider),
  ["CineJoy"],
);
const discoveryReportEntry = buildDiscoveryReportEntry(
  parseMovieSpec("27205"),
  movieManifest,
);
assert.equal(discoveryReportEntry.additionalProviderCount, 1);
assert.equal("additionalProviders" in discoveryReportEntry, false);
assert.equal(JSON.stringify(discoveryReportEntry).includes("CineJoy"), false);
assert.equal(
  classifyExternalSourceRows(baseRows, {
    mediaType: "movie",
    includeVariants: true,
  }).selected.length,
  11,
);
const tvManifest = classifyExternalSourceRows(baseRows, { mediaType: "tv" });
assert.deepEqual(tvManifest.missingRequiredBaseProviders, []);
assert.equal(tvManifest.selected.some((source) => source.baseProvider === "Gallic"), false);
assert.deepEqual(
  classifyExternalSourceRows(
    baseRows.filter((row) => row.primary !== "Meridian"),
    { mediaType: "movie" },
  ).missingRequiredBaseProviders,
  ["Meridian"],
);
const impersonatingCustomRows = baseRows
  .filter((row) => row.primary !== "VidLink" && row.primary !== "CineJoy")
  .concat({
    isTorrent: false,
    sourceHash: hashFor(30),
    provider: "LivNet",
    primary: "VidLink",
    releaseGroup: "Custom Stremio addon",
  });
const impersonatingCustomManifest = classifyExternalSourceRows(
  impersonatingCustomRows,
  { mediaType: "movie" },
);
assert.equal(
  impersonatingCustomManifest.missingRequiredBaseProviders.includes("VidLink"),
  true,
);
assert.equal(
  impersonatingCustomManifest.selected.some(
    (source) => source.hash === hashFor(30),
  ),
  false,
);
assert.deepEqual(
  impersonatingCustomManifest.additional.map((source) => source.provider),
  ["Additional provider"],
);
const impersonatingCustomReport = buildDiscoveryReportEntry(
  parseMovieSpec("27205"),
  impersonatingCustomManifest,
);
assert.equal(impersonatingCustomReport.additionalProviderCount, 1);
assert.equal("additionalProviders" in impersonatingCustomReport, false);
assert.equal(
  isExternalSourceRow({ isTorrent: false, sourceHash: "not-a-hash" }),
  false,
);

assert.deepEqual(orderSources([1, 2, 3], "rotated", 1), [2, 3, 1]);
assert.deepEqual(orderSources([1, 2, 3], "reversed", 0), [3, 2, 1]);

assert.deepEqual(
  alignBenchmarkMilestones(
    {
      capturedAtMs: 4_000,
      milestones: {
        loadedMetadataMs: 1_000,
        canPlayMs: 1_500,
        playingMs: 1_750,
        firstTimeUpdateMs: 2_000,
        firstFrameMs: 1_800,
      },
    },
    { timeOriginMs: 10_000, nowMs: 5_000 },
    9_500,
  ),
  {
    apiOriginTrialMs: 1_500,
    loadedMetadataMs: 2_500,
    canPlayMs: 3_000,
    playingMs: 3_250,
    firstTimeUpdateMs: 3_500,
    firstFrameMs: 3_300,
  },
);

assert.equal(
  classifyNetworkRoute(
    "https://example.invalid/api/live/hls-resource?secret=hidden",
    "XHR",
    "https://stream.invalid",
  ),
  null,
);
assert.equal(
  classifyNetworkRoute(
    "https://live.streamarena.xyz/api/live/hls.m3u8?sig=hidden",
    "XHR",
    "https://stream.invalid",
    ["https://live.streamarena.xyz"],
  ),
  "liveHlsManifest",
);
assert.equal(
  classifyNetworkRoute(
    "https://live.streamarena.xyz/api/live/hls-resource?sig=hidden",
    "XHR",
    "https://stream.invalid",
    ["https://live.streamarena.xyz"],
  ),
  "liveHlsResource",
);
assert.equal(
  classifyNetworkRoute(
    "https://attacker.invalid/api/live/hls-resource?sig=hidden",
    "XHR",
    "https://stream.invalid",
    ["https://live.streamarena.xyz"],
  ),
  null,
);
assert.equal(
  classifyNetworkRoute(
    "https://live.streamarena.xyz/api/remux?input=hidden",
    "Media",
    "https://stream.invalid",
    ["https://live.streamarena.xyz"],
  ),
  null,
);
assert.equal(
  classifyNetworkRoute(
    "https://stream.invalid/api/live/hls-resource?secret=hidden",
    "XHR",
    "https://stream.invalid",
  ),
  "liveHlsResource",
);
assert.equal(
  classifyNetworkRoute(
    "https://other.invalid/api/remux?input=hidden",
    "Media",
    "https://stream.invalid",
  ),
  null,
);
assert.equal(
  classifyNetworkRoute(
    "https://cdn.invalid/private/segment.m4s?token=hidden",
    "Fetch",
    "https://stream.invalid",
  ),
  "directMedia",
);
assert.equal(
  classifyNetworkRoute(
    "https://stream.invalid/assets/app.js",
    "Script",
    "https://stream.invalid",
  ),
  null,
);
assert.equal(
  classifyResponseRole(
    "liveHlsResource",
    "application/vnd.apple.mpegurl",
    "XHR",
    200,
  ),
  "childManifest",
);
assert.equal(
  classifyResponseRole("liveHlsResource", "image/png", "XHR", 200),
  "mediaResource",
);
assert.equal(
  classifyResponseRole(
    "liveHlsManifest",
    "application/vnd.apple.mpegurl",
    "XHR",
    200,
  ),
  "manifest",
);

assert.deepEqual(
  parseRemuxServerTiming(
    'remux-queue;dur=1.25, secret;dur=999;desc="https://hidden.invalid", remux-probe;dur=2, remux-response;dur=3;desc="comma,inside", remux-codec-setup;dur=NaN, remux-ffmpeg-spawn;dur=-1',
  ),
  {
    "remux-queue": 1.25,
    "remux-probe": 2,
    "remux-response": 3,
  },
);

const cdpHandlers = new Map();
const fakeCdpSession = {
  send: async () => {},
  on(name, handler) {
    cdpHandlers.set(name, handler);
  },
  detach: async () => {},
};
const fakeNetworkPage = {
  context: () => ({ newCDPSession: async () => fakeCdpSession }),
};
const trialEpochMs = 1_700_000_000_000;
const networkCapture = createNetworkCapture(
  fakeNetworkPage,
  "https://stream.invalid",
  trialEpochMs,
  ["https://live.streamarena.xyz"],
);
await networkCapture.start();
cdpHandlers.get("Network.requestWillBeSent")({
  requestId: "failed-media",
  timestamp: 50,
  wallTime: trialEpochMs / 1_000 + 0.1,
  request: { url: "https://stream.invalid/api/remux?input=hidden" },
  type: "Media",
});
cdpHandlers.get("Network.responseReceived")({
  requestId: "failed-media",
  timestamp: 50.25,
  response: {
    status: 206,
    mimeType: "video/mp4",
    headers: {},
  },
});
cdpHandlers.get("Network.dataReceived")({
  requestId: "failed-media",
  timestamp: 50.3,
  dataLength: 321,
  encodedDataLength: 222,
});
cdpHandlers.get("Network.loadingFailed")({
  requestId: "failed-media",
  timestamp: 50.5,
});
cdpHandlers.get("Network.requestWillBeSent")({
  requestId: "worker-manifest",
  timestamp: 51,
  wallTime: trialEpochMs / 1_000 + 1.1,
  request: {
    url: "https://live.streamarena.xyz/api/live/hls.m3u8?sig=hidden",
  },
  type: "XHR",
});
cdpHandlers.get("Network.responseReceived")({
  requestId: "worker-manifest",
  timestamp: 51.1,
  response: {
    status: 200,
    mimeType: "application/vnd.apple.mpegurl",
    headers: {},
  },
});
cdpHandlers.get("Network.dataReceived")({
  requestId: "worker-manifest",
  timestamp: 51.15,
  dataLength: 123,
  encodedDataLength: 100,
});
cdpHandlers.get("Network.loadingFinished")({
  requestId: "worker-manifest",
  timestamp: 51.2,
  encodedDataLength: 100,
});
const failedNetworkReport = await networkCapture.finish();
assert.deepEqual(failedNetworkReport.remux.ttfbMs, { median: 250, p95: 250 });
assert.deepEqual(failedNetworkReport.remux.durationMs, {
  median: 500,
  p95: 500,
});
assert.equal(failedNetworkReport.remux.firstResponseAtMs, 350);
assert.equal(failedNetworkReport.remux.failedCount, 1);
assert.equal(failedNetworkReport.remux.receivedBytes, 321);
assert.equal(failedNetworkReport.remux.encodedBytes, 222);
assert.equal(failedNetworkReport.liveHlsManifest.requestCount, 1);
assert.equal(failedNetworkReport.liveHlsManifest.responseCount, 1);
assert.equal(failedNetworkReport.liveHlsManifest.receivedBytes, 123);
assert.deepEqual(failedNetworkReport.liveHlsManifest.ttfbMs, {
  median: 100,
  p95: 100,
});

assert.equal(
  sanitizeProviderLabel("VidRock https://secret.invalid/path?token=x"),
  "VidRock",
);

const ranking = aggregateTrials([
  {
    mediaType: "movie",
    provider: "Slow reliable",
    success: true,
    timings: { firstFrameMs: 3_000 },
    playback: { waitingCount: 0, stalledCount: 0, droppedFrames: 0 },
  },
  {
    mediaType: "movie",
    provider: "Fast unreliable",
    success: true,
    timings: { firstFrameMs: 500 },
    playback: { waitingCount: 0, stalledCount: 0, droppedFrames: 0 },
  },
  {
    mediaType: "movie",
    provider: "Fast unreliable",
    success: false,
    timings: { firstFrameMs: null },
    playback: { waitingCount: 0, stalledCount: 0, droppedFrames: 0 },
  },
]);
assert.equal(ranking[0].provider, "Slow reliable");
assert.equal(ranking[0].successRate, 1);

const discovery = {
  case: "movie:27205",
  mediaType: "movie",
  requiredBaseProviders: ["VidEasy", "VidLink"],
  discoveredBaseProviders: ["VidEasy", "VidLink"],
};
const partialCoverage = computeRequiredCoverage(
  [discovery],
  [
    {
      case: "movie:27205",
      providerKind: "base",
      baseProvider: "VidEasy",
      success: true,
    },
  ],
  1,
);
assert.equal(partialCoverage.passed, false);
assert.equal(partialCoverage.missingRequiredTrials[0].provider, "VidLink");
assert.equal(
  computeGate([{ success: true }], 0, partialCoverage).passed,
  false,
);
const completeCoverage = computeRequiredCoverage(
  [discovery],
  ["VidEasy", "VidLink"].map((baseProvider) => ({
    case: "movie:27205",
    providerKind: "base",
    baseProvider,
    success: true,
  })),
  1,
);
assert.equal(completeCoverage.passed, true);
assert.equal(
  computeGate([{ success: true }, { success: true }], 1, completeCoverage).passed,
  true,
);
const allowedPlaybackFailureGate = computeGate(
  [{ success: false, failureCodes: ["MEDIA_ERROR"] }],
  0,
  { passed: true },
);
assert.equal(allowedPlaybackFailureGate.passed, true);
assert.equal(allowedPlaybackFailureGate.integrityPassed, true);
const forbiddenIntegrityFailureGate = computeGate(
  [{ success: false, failureCodes: ["PIN_MISMATCH"] }],
  0,
  { passed: true },
);
assert.equal(forbiddenIntegrityFailureGate.passed, false);
assert.equal(forbiddenIntegrityFailureGate.integrityPassed, false);
assert.equal(forbiddenIntegrityFailureGate.integrityFailureCount, 1);

assert.equal(authAccountIdentifier({ id: 42 }), "42");
assert.equal(authAccountIdentifier({ email: "private@example.com" }), "");
assert.deepEqual(authAccountFromPayload({ id: 42, isAdmin: true }), {
  accountId: "42",
  isAdmin: true,
});
assert.deepEqual(authAccountFromPayload({ id: 42, isAdmin: false }), {
  accountId: "42",
  isAdmin: false,
});
const sharedAccountCandidate = { accountId: "42", context: {}, isAdmin: true };
assert.equal(
  chooseAuthenticatedCandidate([
    sharedAccountCandidate,
    { accountId: "42", context: {}, isAdmin: true },
  ]),
  sharedAccountCandidate,
);
assert.throws(
  () =>
    chooseAuthenticatedCandidate([
      { accountId: "42", context: {}, isAdmin: true },
      { accountId: "84", context: {}, isAdmin: true },
    ]),
  (error) => error?.benchmarkCode === "AMBIGUOUS_AUTH_CONTEXTS",
);
assert.throws(
  () =>
    chooseAuthenticatedCandidate([
      { accountId: "42", context: {}, isAdmin: false },
    ]),
  (error) => error?.benchmarkCode === "SOURCE_ADMIN_REQUIRED",
);

await assert.rejects(
  runWithDeadline(
    () => new Promise(() => {}),
    performance.now() + 20,
    "TEST_DEADLINE",
  ),
  (error) => error?.benchmarkCode === "TEST_DEADLINE",
);
let expiredOperationStarted = false;
await assert.rejects(
  runWithDeadline(
    () => {
      expiredOperationStarted = true;
    },
    performance.now() - 1,
    "TEST_ALREADY_EXPIRED",
  ),
  (error) => error?.benchmarkCode === "TEST_ALREADY_EXPIRED",
);
assert.equal(expiredOperationStarted, false);

const apiResponse = (status, payload, headers = {}) => ({
  status: () => status,
  headers: () => headers,
  json: async () => payload,
});
const sourceAuthContext = {
  request: {
    get: async () => apiResponse(200, { id: 42, isAdmin: true }),
  },
  cookies: async () => [
    {
      name: "session",
      value: "not-reported",
      expires: -1,
    },
  ],
};
for (const failureStage of ["cookies", "init-script", "target-auth"]) {
  let closeCount = 0;
  const disposableContext = {
    addCookies: async () => {
      if (failureStage === "cookies") throw new Error("cookie install failed");
    },
    addInitScript: async () => {
      if (failureStage === "init-script") throw new Error("init script failed");
    },
    request: {
      get: async () =>
        failureStage === "target-auth"
          ? apiResponse(401, null)
          : apiResponse(200, { id: 42, isAdmin: true }),
    },
    close: async () => {
      closeCount += 1;
    },
  };
  await assert.rejects(
    createIsolatedAuthenticatedContext({
      browser: { newContext: async () => disposableContext },
      authenticatedContext: sourceAuthContext,
      authOrigin: "https://stream.example",
      baseOrigin: "https://stream.example",
      timeoutMs: 1_000,
    }),
  );
  assert.equal(closeCount, 1, `${failureStage} must close the disposable context`);
}

let capabilityRequest = null;
const capabilityContext = {
  request: {
    get: async (url, options) => {
      capabilityRequest = { url, options };
      return apiResponse(200, null, {
        [PROVIDER_HEALTH_RECORDING_ACK_HEADER]: "suppressed",
      });
    },
  },
};
assert.equal(
  await assertProviderBenchmarkCapability(
    capabilityContext,
    "https://stream.example",
    1_000,
  ),
  true,
);
assert.equal(
  capabilityRequest.url,
  "https://stream.example/api/admin/provider-benchmark-capability",
);
assert.deepEqual(capabilityRequest.options.headers, {
  [PROVIDER_BENCHMARK_HEADER]: "1",
});
await assert.rejects(
  assertProviderBenchmarkCapability(
    {
      request: {
        get: async () => apiResponse(200, null, {
          [PROVIDER_HEALTH_RECORDING_ACK_HEADER]: "Suppressed",
        }),
      },
    },
    "https://stream.example",
    1_000,
  ),
  (error) => error?.benchmarkCode === "BENCHMARK_CAPABILITY_NOT_ACKNOWLEDGED",
);

let providerConfigRequest = null;
assert.deepEqual(
  await readConfiguredLiveHlsWorkerOrigins(
    {
      request: {
        get: async (url, options) => {
          providerConfigRequest = { url, options };
          return apiResponse(200, workerProviderPayload);
        },
      },
    },
    "https://stream.example",
    1_000,
  ),
  ["https://live.streamarena.xyz"],
);
assert.equal(
  providerConfigRequest.url,
  "https://stream.example/api/admin/providers",
);
assert.equal(providerConfigRequest.options.failOnStatusCode, false);

const sampleSnapshot = ({ currentTime, decoded, callbacks, waiting = 0 }) => ({
  currentTime,
  frames: { decoded, callbacks, dropped: 0 },
  events: { waiting, stalled: 0 },
});
assert.deepEqual(
  summarizePlaybackWindow(
    {
      observedAtMs: 100,
      snapshot: sampleSnapshot({ currentTime: 10, decoded: 20, callbacks: 30 }),
    },
    {
      observedAtMs: 5_200,
      snapshot: sampleSnapshot({
        currentTime: 15.1,
        decoded: 143,
        callbacks: 153,
      }),
    },
    21,
  ),
  {
    sampledDurationMs: 5_100,
    mediaTimeDeltaSeconds: 5.1,
    decodedFrameDelta: 123,
    frameCallbackDelta: 123,
    droppedFrameDelta: 0,
    waitingDelta: 0,
    stalledDelta: 0,
    sampleCount: 21,
  },
);

assert.doesNotThrow(() =>
  assertSanitizedReport({ provider: "VidRock", timings: { firstFrameMs: 123 } }),
);
assert.throws(() =>
  assertSanitizedReport({ media: "https://secret.invalid/stream.m3u8" }),
);
assert.throws(() =>
  assertSanitizedReport({ identity: "a".repeat(40) }),
);
assert.throws(() =>
  assertSanitizedReport({ identity: `prefix-${"b".repeat(40)}-suffix` }),
);
assert.throws(() => assertSanitizedReport({ sourceHistory: [] }));
for (const unsafeReport of [
  { nestedAccessTokenValue: "redacted" },
  { metadata: { clientSecretHint: "redacted" } },
  { message: "Bearer abcdefghijklmnopqrstuvwxyz.1234567890.signature" },
  { message: "token=abcdefghijklmnopqrstuvwxyz" },
  { message: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signature" },
]) {
  assert.throws(() => assertSanitizedReport(unsafeReport));
}
assert.doesNotThrow(() =>
  assertSanitizedReport({ provider: "Token House", durationMs: 12 }),
);

const atomicOutputDirectory = mkdtempSync(
  join(tmpdir(), "streamarena-provider-benchmark-"),
);
try {
  const victimPath = join(atomicOutputDirectory, "victim.json");
  const outputPath = join(atomicOutputDirectory, "report.json");
  writeFileSync(victimPath, "must remain unchanged\n", { mode: 0o644 });
  symlinkSync(victimPath, outputPath);
  writeReportAtomically(outputPath, {
    schemaVersion: 2,
    gate: { passed: true },
  });
  assert.equal(lstatSync(outputPath).isSymbolicLink(), false);
  assert.equal(statSync(outputPath).mode & 0o777, 0o600);
  assert.equal(readFileSync(victimPath, "utf8"), "must remain unchanged\n");
  assert.equal(
    readdirSync(atomicOutputDirectory).some((name) => name.endsWith(".tmp")),
    false,
  );

  chmodSync(outputPath, 0o666);
  writeReportAtomically(outputPath, {
    schemaVersion: 2,
    gate: { passed: false },
  });
  assert.equal(statSync(outputPath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(outputPath, "utf8")).gate.passed, false);
} finally {
  rmSync(atomicOutputDirectory, { recursive: true, force: true });
}

console.log("provider playback benchmark tests passed");

#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REAL_DEBRID_BENCHMARK_HEADER,
  assertBenchmarkTransportSecurity,
  assertRealDebridBenchmarkAttestations,
  assertRealDebridReportSanitized,
  benchmarkDatabaseFilesAreDistinct,
  benchmarkDatabasePathIdentity,
  benchmarkPlaybackProofIsRealtime,
  benchmarkPlaybackRateIsOne,
  benchmarkSelectionsMatch,
  buildRealDebridBenchmarkInitScript,
  compareDatabaseInvariants,
  doesFilenameLikelyMatchMovie,
  parseRealDebridBenchmarkArgs,
  parseResolverServerTiming,
  realDebridBenchmarkFetchDecision,
  realDebridPlaybackSessionScopeIdentity,
  realDebridRemuxInputs,
  readRealDebridBenchmarkAttestations,
  resolverExternalStartedUnchanged,
  runRealDebridPlaybackBenchmark,
  selectProbeColdRealDebridSession,
  stableDigest,
  withProviderBenchmarkHeader,
  writePrivateRealDebridReport,
} from "./real-debrid-playback-benchmark.mjs";

const nowMs = 2_000_000_000_000;
const sourceHash = "a".repeat(40);
const remuxInput =
  "https://7.download.real-debrid.com/d/example/cold-video.mkv";
const remuxUrl = `/api/remux?${new URLSearchParams({ input: remuxInput })}`;
const lazyHlsUrl = `/api/hls/master.m3u8?${new URLSearchParams({
  input: `streamarena-rd-hls-v1.abc123.2000000000.${"A".repeat(43)}`,
})}`;

function validRow(overrides = {}) {
  return {
    user_id: 7,
    session_key: "real-debrid:user:7:27205:auto:1080p",
    tmdb_id: "27205",
    audio_lang: "auto",
    source_hash: sourceHash,
    selected_file: "11",
    filename: "Cold.Video.1080p.mkv",
    playable_url: remuxUrl,
    fallback_urls_json: JSON.stringify([lazyHlsUrl]),
    metadata_json: JSON.stringify({
      tmdbId: "27205",
      imdbId: "tt1375666",
      resolverProvider: "real-debrid",
      mediaType: "movie",
      displayTitle: "Cold Video",
      displayYear: "2024",
      runtimeSeconds: 8_880,
      seasonNumber: 0,
      episodeNumber: 0,
      episodeTitle: "",
      subtitleTargetName: "Cold.Video.1080p.mkv",
      subtitleTargetFilename: "Cold.Video.1080p.mkv",
      subtitleTargetFilePath: "",
      realDebridCached: true,
      _realDebridCredentialScope: "opaque-test-scope",
    }),
    last_position_seconds: 0,
    health_state: "healthy",
    health_fail_count: 0,
    last_error: "",
    last_verified_at: nowMs - 1_000,
    next_validation_at: nowMs + 60_000,
    updated_at: nowMs - 10_000,
    last_accessed_at: nowMs - 20_000,
    ...overrides,
  };
}

const selection = selectProbeColdRealDebridSession([validRow()], {
  userId: 7,
  nowMs,
  probeKeys: new Set(),
  titlePreferences: [],
});
assert.ok(selection, "a healthy fresh RD session with no probe is selected");
assert.equal(selection.mediaType, "movie");
assert.equal(selection.remuxInput, remuxInput);
assert.deepEqual(realDebridRemuxInputs(validRow()), [remuxInput]);
assert.ok(
  selectProbeColdRealDebridSession([validRow()], {
    userId: 7,
    nowMs,
  }),
  "the current persisted remux plus authenticated lazy-HLS shape is eligible",
);
const legacyHlsRow = validRow({
  playable_url: "https://stream.real-debrid.com/example/full.m3u8",
  fallback_urls_json: JSON.stringify([remuxUrl]),
});
assert.deepEqual(realDebridRemuxInputs(legacyHlsRow), [remuxInput]);
assert.equal(
  selectProbeColdRealDebridSession([legacyHlsRow], {
    userId: 7,
    nowMs,
  }),
  null,
  "a legacy raw RD HLS route is ineligible because the browser benchmark blocks cross-origin media",
);
const currentDownloadRow = validRow({
  playable_url: remuxInput,
  fallback_urls_json: JSON.stringify([lazyHlsUrl]),
});
assert.deepEqual(realDebridRemuxInputs(currentDownloadRow), [remuxInput]);
assert.ok(
  selectProbeColdRealDebridSession([currentDownloadRow], {
    userId: 7,
    nowMs,
  }),
  "a non-browser-safe RD download that normalizes to remux is eligible",
);
assert.equal(
  doesFilenameLikelyMatchMovie(
    "Cold.Video.2024.1080p.mkv",
    "Cold Video",
    "2024",
  ),
  true,
);
assert.equal(
  doesFilenameLikelyMatchMovie(
    "Entirely.Unrelated.2024.1080p.mkv",
    "Cold Video",
    "2024",
  ),
  false,
);
assert.equal(
  selectProbeColdRealDebridSession(
    [validRow({ filename: "Entirely.Unrelated.2024.1080p.mkv" })],
    { userId: 7, nowMs },
  ),
  null,
  "a filename that the backend would reject cannot qualify for the benchmark",
);
assert.equal(
  selectProbeColdRealDebridSession(
    [validRow({ next_validation_at: nowMs + 15_000 })],
    { userId: 7, nowMs, minValidationFreshMs: 15_000 },
  ),
  null,
  "the final preflight requires the full conservative startup window",
);
const changedSelection = selectProbeColdRealDebridSession(
  [validRow({ source_hash: "b".repeat(40) })],
  { userId: 7, nowMs },
);
assert.equal(benchmarkSelectionsMatch(selection, changedSelection), false);
assert.equal(benchmarkSelectionsMatch(selection, selection), true);

assert.equal(
  selectProbeColdRealDebridSession([validRow()], {
    userId: 7,
    nowMs,
    probeKeys: new Set([`source:${remuxInput}`]),
  }),
  null,
  "an existing probe is never deleted to manufacture a cold run",
);
assert.equal(
  selectProbeColdRealDebridSession([validRow()], {
    userId: 7,
    nowMs,
    freshTmdbCacheKeys: new Set(),
  }),
  null,
  "selection declines when the resolver would populate TMDB cache state",
);
assert.ok(
  selectProbeColdRealDebridSession([validRow()], {
    userId: 7,
    nowMs,
    freshTmdbCacheKeys: new Set(["/movie/27205?language=en-US"]),
  }),
);
const currentTmdbMetadata = new Map([
  [
    "/movie/27205?language=en-US",
    {
      imdbId: "tt1375666",
      displayTitle: "Cold Video",
      releaseDate: "2024-07-16",
      runtimeMinutes: 148,
    },
  ],
]);
assert.ok(
  selectProbeColdRealDebridSession([validRow()], {
    userId: 7,
    nowMs,
    tmdbMetadataByKey: currentTmdbMetadata,
  }),
  "selection proves cached TMDB metadata will reproduce session semantics",
);
assert.equal(
  selectProbeColdRealDebridSession([validRow()], {
    userId: 7,
    nowMs,
    tmdbMetadataByKey: new Map(),
  }),
  null,
  "selection declines when current metadata cannot prove safe reuse",
);
assert.equal(
  selectProbeColdRealDebridSession([validRow()], {
    userId: 7,
    nowMs,
    probeKeys: new Set([`source:${validRow().playable_url}`]),
  }),
  null,
  "a cached session-source probe is not evicted or reused",
);
assert.equal(
  selectProbeColdRealDebridSession(
    [validRow({ health_state: "invalid" })],
    { userId: 7, nowMs },
  ),
  null,
);
assert.equal(
  selectProbeColdRealDebridSession(
    [validRow({ next_validation_at: nowMs + 1_000 })],
    { userId: 7, nowMs },
  ),
  null,
  "a session too close to revalidation is declined",
);
assert.equal(
  selectProbeColdRealDebridSession(
    [
      validRow({
        playable_url: remuxInput,
        fallback_urls_json: JSON.stringify([remuxUrl]),
      }),
    ],
    { userId: 7, nowMs },
  ),
  null,
  "a direct route is not assumed to become remux merely because it has a fallback",
);
assert.equal(
  selectProbeColdRealDebridSession([validRow()], {
    userId: 7,
    nowMs,
    titlePreferences: [
      { media_type: "movie", tmdb_id: "27205", preferred_audio_lang: "en" },
    ],
  }),
  null,
  "an auto session that title preferences would redirect is declined",
);
assert.equal(
  selectProbeColdRealDebridSession(
    [
      validRow({
        session_key: "real-debrid:user:7:27205:en:1080p",
        audio_lang: "en",
      }),
      validRow(),
    ],
    { userId: 7, nowMs },
  )?.audioLang,
  "auto",
  "a non-auto session that would delete its related auto row is not eligible",
);
const secondInput =
  "https://8.download.real-debrid.com/d/example/other-video.mkv";
assert.equal(
  selectProbeColdRealDebridSession(
    [
      validRow({
        fallback_urls_json: JSON.stringify([
          remuxUrl,
          `/api/remux?${new URLSearchParams({ input: secondInput })}`,
        ]),
      }),
    ],
    { userId: 7, nowMs },
  ),
  null,
  "ambiguous remux inputs are rejected",
);

const olderRow = validRow({ last_accessed_at: nowMs - 50_000 });
const newerRow = validRow({
  session_key: "real-debrid:user:7:27205:en:1080p",
  audio_lang: "en",
  last_accessed_at: nowMs - 5_000,
});
assert.equal(
  selectProbeColdRealDebridSession([newerRow, olderRow], {
    userId: 7,
    nowMs,
  }).sessionKey,
  olderRow.session_key,
  "selection prefers the least recently accessed safe session",
);

const expected = {
  mediaType: "movie",
  tmdbId: "27205",
  seasonNumber: 0,
  episodeNumber: 0,
  sourceHash,
  sessionKey: validRow().session_key,
  audioLang: "auto",
  quality: "1080p",
  remuxInput,
};
const pageUrl = `https://stream.example/watch/movie/27205?sourceHash=${sourceHash}`;
const exactResolve = `https://stream.example/api/resolve/movie?${new URLSearchParams(
  { tmdbId: "27205", sourceHash },
)}`;
assert.equal(
  realDebridBenchmarkFetchDecision(
    exactResolve,
    pageUrl,
    "https://stream.example",
    expected,
  ),
  "allow-exact-resolve",
);
const dedicatedExactResolve = exactResolve.replace(
  "/api/resolve/movie",
  "/api/admin/provider-benchmark-resolve/movie",
);
assert.equal(
  realDebridBenchmarkFetchDecision(
    dedicatedExactResolve,
    pageUrl,
    "https://stream.example",
    expected,
  ),
  "allow-exact-resolve",
);
assert.equal(
  realDebridBenchmarkFetchDecision(
    `${exactResolve}&refreshResolve=1`,
    pageUrl,
    "https://stream.example",
    expected,
  ),
  "block-resolve",
);
assert.equal(
  realDebridBenchmarkFetchDecision(
    `${exactResolve}&sourceHash=${"b".repeat(40)}`,
    pageUrl,
    "https://stream.example",
    expected,
  ),
  "block-resolve",
  "duplicate resolve identities fail closed",
);
assert.equal(
  realDebridBenchmarkFetchDecision(
    "https://stream.example/api/resolve/movie?tmdbId=27205",
    pageUrl,
    "https://stream.example",
    expected,
  ),
  "block-resolve",
);
assert.equal(
  realDebridBenchmarkFetchDecision(
    "https://stream.example/api/resolve/sources?tmdbId=27205",
    pageUrl,
    "https://stream.example",
    expected,
  ),
  "block-source-menu",
);
assert.equal(
  realDebridBenchmarkFetchDecision(
    "https://stream.example/api/hls/master.m3u8?input=fallback",
    pageUrl,
    "https://stream.example",
    expected,
  ),
  "block-media-fallback",
  "the proof cannot silently switch from remux to HLS",
);
assert.equal(
  realDebridBenchmarkFetchDecision(
    "https://stream.example/api/library",
    pageUrl,
    "https://stream.example",
    expected,
  ),
  "empty-library-read",
);
assert.equal(
  realDebridBenchmarkFetchDecision(
    "https://stream.example/api/user/watch-progress",
    pageUrl,
    "https://stream.example",
    expected,
    "GET",
  ),
  "empty-progress-read",
);
assert.equal(
  realDebridBenchmarkFetchDecision(
    "https://stream.example/api/user/continue-watching",
    pageUrl,
    "https://stream.example",
    expected,
    "PUT",
  ),
  "block-progress-mutation",
);
assert.equal(
  realDebridBenchmarkFetchDecision(
    `https://stream.example/api/media/tracks?${new URLSearchParams({
      input: remuxInput,
      subtitleLang: "off",
    })}`,
    pageUrl,
    "https://stream.example",
    expected,
  ),
  "allow-exact-tracks",
);
assert.equal(
  realDebridBenchmarkFetchDecision(
    `https://stream.example/api/media/tracks?${new URLSearchParams({
      input: remuxInput,
      subtitleLang: "en",
    })}`,
    pageUrl,
    "https://stream.example",
    expected,
  ),
  "block-tracks",
);
assert.equal(
  realDebridBenchmarkFetchDecision(
    `https://stream.example/api/media/tracks?input=${encodeURIComponent(remuxInput)}&subtitleLang=off&input=${encodeURIComponent("https://other.download.real-debrid.com/d/other.mkv")}`,
    pageUrl,
    "https://stream.example",
    expected,
  ),
  "block-tracks",
  "duplicate media inputs fail closed",
);
assert.equal(
  realDebridBenchmarkFetchDecision(
    `https://stream.example${remuxUrl}`,
    pageUrl,
    "https://stream.example",
    expected,
  ),
  "allow-exact-remux",
);
assert.equal(
  realDebridBenchmarkFetchDecision(
    `https://stream.example${remuxUrl}&input=${encodeURIComponent("https://other.download.real-debrid.com/d/other.mkv")}`,
    pageUrl,
    "https://stream.example",
    expected,
  ),
  "block-remux",
  "duplicate remux inputs fail closed",
);
assert.equal(
  realDebridBenchmarkFetchDecision(
    "https://stream.example/api/resolve/job/not-allowed",
    pageUrl,
    "https://stream.example",
    expected,
  ),
  "block-resolve-job",
);
assert.equal(
  realDebridBenchmarkFetchDecision(
    "https://stream.example/api/user/preferences",
    pageUrl,
    "https://stream.example",
    expected,
    "PUT",
  ),
  "block-other-mutation",
);
assert.equal(
  realDebridBenchmarkFetchDecision(
    "https://stream.example/api/unknown-write",
    pageUrl,
    "https://stream.example",
    expected,
    "POST",
  ),
  "block-other-mutation",
  "all unknown same-origin mutations are blocked by default",
);
assert.equal(
  realDebridBenchmarkFetchDecision(
    "https://collector.example/identify",
    pageUrl,
    "https://stream.example",
    expected,
    "POST",
  ),
  "block-cross-origin",
  "cross-origin writes and identifier egress fail closed",
);
assert.equal(
  realDebridBenchmarkFetchDecision(
    "https://stream.example/api/debug/cache",
    pageUrl,
    "https://stream.example",
    expected,
    "GET",
  ),
  "block-other-read",
  "unknown API reads cannot trigger hidden cache mutation",
);
assert.deepEqual(withProviderBenchmarkHeader({ accept: "application/json" }), {
  accept: "application/json",
  "x-streamarena-provider-benchmark": "1",
  [REAL_DEBRID_BENCHMARK_HEADER]: "1",
});
const initScript = buildRealDebridBenchmarkInitScript(
  "https://stream.example",
  expected,
);
assert.match(initScript, /__STREAMARENA_RD_BENCHMARK_SAFETY__/);
assert.match(initScript, /rewrittenResolveUrl/);
assert.match(initScript, /benchmarkExactSession/);
assert.match(initScript, /provider-benchmark-resolve/);
assert.match(initScript, /streamarena-playback-speed/);
assert.match(initScript, /expectedPlaybackRate/);
assert.ok(
  initScript.indexOf("const singleSearchParam") <
    initScript.indexOf("const exactResolveRequest"),
  "the generated browser guard defines strict query helpers before use",
);

assert.deepEqual(
  parseResolverServerTiming(
    "resolver-cache;dur=1.25, resolver-total;dur=9, other;dur=999, resolve-upstream;dur=-1",
  ),
  { "resolver-cache": 1.25, "resolver-total": 9 },
);

assert.equal(benchmarkPlaybackRateIsOne(1), true);
assert.equal(benchmarkPlaybackRateIsOne(0.75), false);
assert.equal(benchmarkPlaybackRateIsOne(null), false);
assert.equal(
  benchmarkPlaybackProofIsRealtime({ mediaToWallTimeRatio: 0.95 }),
  true,
);
assert.equal(
  benchmarkPlaybackProofIsRealtime({ mediaToWallTimeRatio: 0.75 }),
  false,
  "slow playback cannot satisfy the continuous playback proof",
);
assert.equal(
  benchmarkPlaybackProofIsRealtime({ mediaToWallTimeRatio: 1.5 }),
  false,
  "a seek-like media-time jump cannot satisfy the playback proof",
);

function exactDomain(count = 1, digest = "same") {
  return { count, digest };
}

function invariantSnapshot({ changedProgress = false, changedOtherProbe = false } = {}) {
  return {
    watchProgress: exactDomain(2, changedProgress ? "changed" : "watch"),
    continueWatching: exactDomain(3, "continue"),
    userPreferences: exactDomain(4, "prefs"),
    providerOverrides: exactDomain(5, "overrides"),
    customProviders: exactDomain(6, "custom"),
    sourceHealth: exactDomain(1, "health"),
    titlePreferences: exactDomain(2, "title"),
    playbackSessions: {
      count: 2,
      semanticsDigest: "semantics",
      timestamps: {
        selected: {
          last_verified_at: 10,
          next_validation_at: 20,
          updated_at: 30,
          last_accessed_at: 40,
        },
        other: {
          last_verified_at: 1,
          next_validation_at: 2,
          updated_at: 3,
          last_accessed_at: 4,
        },
      },
    },
    mediaProbes: {
      totalCount: changedOtherProbe ? 8 : 7,
      other: exactDomain(changedOtherProbe ? 8 : 7, changedOtherProbe ? "changed" : "probes"),
      selectedCount: 0,
      selectedDigest: stableDigest([]),
    },
    selectedSessionIdentity: "selected",
  };
}

const invariantBefore = invariantSnapshot();
const invariantAfter = structuredClone(invariantBefore);
invariantAfter.playbackSessions.timestamps.selected.last_accessed_at = 50;
invariantAfter.mediaProbes.totalCount = 8;
invariantAfter.mediaProbes.selectedCount = 1;
invariantAfter.mediaProbes.selectedDigest = "created";
assert.equal(
  compareDatabaseInvariants(invariantBefore, invariantAfter).passed,
  false,
  "even selected session timestamps must remain unchanged on exact reuse",
);
invariantAfter.playbackSessions.timestamps.selected.last_accessed_at = 40;
assert.equal(
  compareDatabaseInvariants(invariantBefore, invariantAfter).passed,
  true,
  "only the selected media-probe row may be created",
);
assert.equal(
  compareDatabaseInvariants(invariantBefore, invariantSnapshot({ changedProgress: true })).passed,
  false,
  "progress changes fail the invariant gate",
);
assert.equal(
  compareDatabaseInvariants(
    invariantBefore,
    invariantSnapshot({ changedOtherProbe: true }),
  ).passed,
  false,
  "unrelated probe changes fail the invariant gate",
);
const timestampRegression = structuredClone(invariantBefore);
timestampRegression.playbackSessions.timestamps.selected.last_accessed_at = 1;
assert.equal(
  compareDatabaseInvariants(invariantBefore, timestampRegression).passed,
  false,
  "selected session timestamps must remain monotonic",
);

const validArgs = [
  "--cdp-endpoint",
  "http://127.0.0.1:9222",
  "--base-url",
  "https://stream.example",
  "--auth-origin",
  "https://stream.example",
  "--resolver-cache",
  "/srv/streamarena/cache/resolver-cache.sqlite",
  "--users-db",
  "/srv/streamarena/cache/users.sqlite",
  "--output-dir",
  "/srv/private/rd-benchmark",
];
assert.equal(parseRealDebridBenchmarkArgs(validArgs).advanceMs, 5_000);
assert.equal(parseRealDebridBenchmarkArgs(validArgs).maxFirstFrameMs, 20_000);
assert.equal(
  parseRealDebridBenchmarkArgs(validArgs).maxRemuxFirstBodyMs,
  20_000,
);
assert.equal(assertBenchmarkTransportSecurity("http://127.0.0.1:5173"), true);
assert.equal(assertBenchmarkTransportSecurity("https://stream.example"), true);
assert.equal(
  assertBenchmarkTransportSecurity("ws://localhost:9222/devtools/browser/id", "cdp"),
  true,
);
assert.throws(
  () =>
    assertBenchmarkTransportSecurity(
      "wss://debug.example/devtools/browser/id",
      "cdp",
    ),
  /INSECURE_BENCHMARK_TRANSPORT/,
  "remote browser clocks cannot be used for local startup timing",
);
assert.throws(
  () => assertBenchmarkTransportSecurity("http://stream.example"),
  /INSECURE_BENCHMARK_TRANSPORT/,
);
assert.throws(
  () =>
    assertBenchmarkTransportSecurity(
      "ws://stream.example/devtools/browser/id",
      "cdp",
    ),
  /INSECURE_BENCHMARK_TRANSPORT/,
);
await assert.rejects(
  runRealDebridPlaybackBenchmark({
    baseUrl: "http://stream.example",
    authOrigin: "http://stream.example",
    cdpEndpoint: "",
  }),
  /INSECURE_BENCHMARK_TRANSPORT/,
  "the exported runner must enforce transport safety even when argument parsing is bypassed",
);
for (const [property, value, expectedMessage] of [
  ["timeoutMs", "90000", "--timeout-ms"],
  ["advanceMs", 4_999, "--advance-ms"],
  ["drainTimeoutMs", Number.NaN, "--drain-timeout-ms"],
  ["maxRemuxFirstBodyMs", Number.POSITIVE_INFINITY, "--max-remux-first-body-ms"],
  ["maxFirstFrameMs", 999, "--max-first-frame-ms"],
]) {
  await assert.rejects(
    runRealDebridPlaybackBenchmark({
      baseUrl: "http://127.0.0.1:5173",
      authOrigin: "http://127.0.0.1:5173",
      cdpEndpoint: "http://127.0.0.1:9222",
      [property]: value,
    }),
    new RegExp(expectedMessage),
    `the exported runner rejects invalid direct-call ${property}`,
  );
}
assert.throws(
  () => parseRealDebridBenchmarkArgs(validArgs.slice(2)),
  /cdp-endpoint/,
);
assert.throws(
  () =>
    parseRealDebridBenchmarkArgs(
      validArgs.map((value) =>
        value === "/srv/streamarena/cache/resolver-cache.sqlite"
          ? "cache/resolver-cache.sqlite"
          : value,
      ),
    ),
  /absolute path/,
);
assert.throws(
  () => parseRealDebridBenchmarkArgs([...validArgs, "--advance-ms", "4999"]),
  /invalid value/,
);
assert.throws(
  () =>
    parseRealDebridBenchmarkArgs(
      validArgs.map((value) =>
        value === "https://stream.example" ? "http://stream.example" : value,
      ),
    ),
  /INSECURE_BENCHMARK_TRANSPORT/,
);
assert.throws(
  () =>
    parseRealDebridBenchmarkArgs([
      ...validArgs,
      "--auth-origin",
      "https://other.example",
    ]),
  /CROSS_ORIGIN_AUTH_FORBIDDEN/,
);

const attestationRoot = mkdtempSync(
  join(tmpdir(), "streamarena-rd-attestation-test-"),
);
try {
  const resolverPath = join(attestationRoot, "resolver-cache.sqlite");
  const usersPath = join(attestationRoot, "users.sqlite");
  writeFileSync(resolverPath, "resolver");
  writeFileSync(usersPath, "users");
  assert.equal(
    benchmarkDatabaseFilesAreDistinct(resolverPath, usersPath),
    true,
  );
  const resolverAlias = join(attestationRoot, "resolver-alias.sqlite");
  linkSync(resolverPath, resolverAlias);
  assert.equal(
    benchmarkDatabaseFilesAreDistinct(resolverPath, resolverAlias),
    false,
    "hard links to one SQLite inode are not distinct databases",
  );
  const sessionScopeIdentity = realDebridPlaybackSessionScopeIdentity(
    "user:7:credential:opaque:delivery:remote-hls-v1",
  );
  const capabilityPayload = {
    available: true,
    realDebridExactSessionReuse: true,
    realDebridPlaybackSessionScopeIdentity: sessionScopeIdentity,
    databaseIdentities: {
      resolverCache: benchmarkDatabasePathIdentity(
        resolverPath,
        "resolver-cache",
      ),
      users: benchmarkDatabasePathIdentity(usersPath, "users"),
    },
    serverInstanceIdentity: "i".repeat(43),
  };
  let capabilityRequest;
  const attestation = await readRealDebridBenchmarkAttestations(
    {
      request: {
        get: async (url, options) => {
          capabilityRequest = { url, options };
          return {
            status: () => 200,
            headers: () => ({
              "x-streamarena-provider-health-recording": "suppressed",
            }),
            json: async () => capabilityPayload,
          };
        },
      },
    },
    "https://stream.example",
    1_000,
  );
  assert.equal(
    capabilityRequest.url,
    "https://stream.example/api/admin/provider-benchmark-capability",
  );
  assert.equal(capabilityRequest.options.headers[REAL_DEBRID_BENCHMARK_HEADER], "1");
  assert.equal(
    assertRealDebridBenchmarkAttestations(attestation, {
      resolverCachePath: resolverPath,
      usersDbPath: usersPath,
      sessionScopeIdentity,
    }),
    true,
  );
  assert.throws(
    () =>
      assertRealDebridBenchmarkAttestations(
        { ...attestation, realDebridPlaybackSessionScopeIdentity: "s".repeat(43) },
        { resolverCachePath: resolverPath, usersDbPath: usersPath, sessionScopeIdentity },
      ),
    /REAL_DEBRID_SESSION_SCOPE_MISMATCH/,
  );
  assert.throws(
    () =>
      assertRealDebridBenchmarkAttestations(
        { ...attestation, resolverCacheIdentity: "r".repeat(43) },
        { resolverCachePath: resolverPath, usersDbPath: usersPath, sessionScopeIdentity },
      ),
    /RESOLVER_DATABASE_IDENTITY_MISMATCH/,
  );
  assert.throws(
    () =>
      assertRealDebridBenchmarkAttestations(
        { ...attestation, usersDbIdentity: "u".repeat(43) },
        { resolverCachePath: resolverPath, usersDbPath: usersPath, sessionScopeIdentity },
      ),
    /USERS_DATABASE_IDENTITY_MISMATCH/,
  );
  const originalIdentity = benchmarkDatabasePathIdentity(
    resolverPath,
    "resolver-cache",
  );
  const replacementPath = join(attestationRoot, "replacement.sqlite");
  writeFileSync(replacementPath, "replacement");
  renameSync(replacementPath, resolverPath);
  assert.notEqual(
    benchmarkDatabasePathIdentity(resolverPath, "resolver-cache"),
    originalIdentity,
    "an atomic replacement at the same canonical path must change the identity",
  );
} finally {
  rmSync(attestationRoot, { recursive: true, force: true });
}

assert.equal(
  resolverExternalStartedUnchanged(
    { resolver: { externalStarted: 8 } },
    { resolver: { externalStarted: 8 } },
  ),
  true,
);
assert.equal(
  resolverExternalStartedUnchanged(
    { resolver: { externalStarted: 8 } },
    { resolver: { externalStarted: 9 } },
  ),
  false,
);
assert.equal(
  resolverExternalStartedUnchanged(
    { resolver: { externalStarted: 8 } },
    { resolver: { externalStarted: 1 } },
  ),
  false,
  "a counter reset cannot masquerade as exact-session reuse",
);

const safeReport = {
  schemaVersion: 1,
  status: "complete",
  timings: { firstFrameMs: 1234.5 },
  invariants: {
    beforeDigest: stableDigest({ safe: true }),
    domains: {
      mediaProbeCache: {
        benchmarkContentDigestMatched: true,
      },
    },
  },
  safety: {
    benchmarkProbeContentDigestMatched: true,
  },
  gate: { passed: true, failureCodes: [] },
};
assert.equal(assertRealDebridReportSanitized(safeReport), true);
assert.throws(
  () => assertRealDebridReportSanitized({ ...safeReport, endpoint: remuxInput }),
  /UNSAFE_REPORT_URL/,
);
assert.throws(
  () => assertRealDebridReportSanitized({ ...safeReport, identity: sourceHash }),
  /UNSAFE_REPORT_SOURCE_HASH|UNSAFE_RD_REPORT_SOURCE_IDENTITY/,
);
assert.throws(
  () => assertRealDebridReportSanitized({ ...safeReport, sessionKey: "private" }),
  /UNSAFE_RD_REPORT_FIELD/,
);

const temporaryRoot = mkdtempSync(join(tmpdir(), "streamarena-rd-report-test-"));
try {
  const outputDirectory = join(temporaryRoot, "private");
  const outputPath = writePrivateRealDebridReport(outputDirectory, safeReport);
  assert.equal(statSync(outputDirectory).mode & 0o777, 0o700);
  assert.equal(statSync(outputPath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")), safeReport);

  const permissiveDirectory = join(temporaryRoot, "permissive");
  mkdirSync(permissiveDirectory, { mode: 0o755 });
  chmodSync(permissiveDirectory, 0o755);
  assert.throws(
    () => writePrivateRealDebridReport(permissiveDirectory, safeReport),
    /PRIVATE_REPORT_DIRECTORY_INVALID/,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log("real-debrid-playback-benchmark tests passed");

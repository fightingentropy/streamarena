export function createPlaybackBenchmarkApi({
  video,
  getEffectiveCurrentTime,
  getDisplayDurationSeconds,
  extractPlaybackSourceInput,
  tryPlay,
  seekToAbsoluteTime,
  buildSoftwareDecodeUrl,
  buildHlsPlaybackUrl,
  setVideoSource,
  getPreferredRemuxVideoMode,
  getPreferredAudioSyncMs,
}) {
  const benchmarkOriginMs = performance.now();
  const benchmarkState = {
    counters: {
      loadedmetadata: 0,
      canplay: 0,
      playing: 0,
      waiting: 0,
      stalled: 0,
      error: 0,
      play: 0,
      pause: 0,
      seeking: 0,
      seeked: 0,
      ended: 0,
      timeupdate: 0,
    },
    timings: {
      firstLoadedMetadataMs: null,
      firstCanPlayMs: null,
      firstPlayingMs: null,
      firstTimeUpdateMs: null,
      firstVideoFrameMs: null,
      lastVideoFrameMs: null,
      lastSourceSetMs: null,
    },
    frameStats: {
      callbackCount: 0,
      processingDurationSampleCount: 0,
      processingDurationTotalMs: 0,
      maxProcessingDurationMs: 0,
      frameIntervalSampleCount: 0,
      frameIntervalTotalMs: 0,
      maxFrameIntervalMs: 0,
      maxPresentedFramesDelta: 0,
      lastFrameNowMs: null,
      lastPresentedFrames: null,
    },
    events: [],
    sourceHistory: [],
    frameCallbackArmed: false,
  };
  const loggedEvents = new Set([
    "sourcechange",
    "loadedmetadata",
    "canplay",
    "playing",
    "waiting",
    "stalled",
    "error",
    "play",
    "pause",
    "seeking",
    "seeked",
    "ended",
  ]);

  function benchmarkNowMs() {
    return performance.now() - benchmarkOriginMs;
  }

  function roundBenchmarkNumber(value, digits = 2) {
    return Number.isFinite(value)
      ? Number(Number(value).toFixed(digits))
      : null;
  }

  function rememberFirstBenchmarkTiming(key) {
    if (benchmarkState.timings[key] === null) {
      benchmarkState.timings[key] = roundBenchmarkNumber(benchmarkNowMs(), 1);
    }
  }

  function getBenchmarkCurrentSource() {
    return String(video.currentSrc || video.getAttribute("src") || "").trim();
  }

  function inferBenchmarkPlaybackMode(source = getBenchmarkCurrentSource()) {
    const normalized = String(source || "").toLowerCase();
    if (normalized.includes("/api/hls/master.m3u8")) {
      return "hls";
    }
    if (normalized.includes("/api/live/hls.m3u8")) {
      return "live-hls";
    }
    if (normalized.includes("/api/remux")) {
      return "remux";
    }
    return "direct";
  }

  function pushBenchmarkEvent(type, details = {}) {
    if (!loggedEvents.has(type)) {
      return;
    }
    benchmarkState.events.push({
      type,
      atMs: roundBenchmarkNumber(benchmarkNowMs(), 1),
      currentTime: roundBenchmarkNumber(getEffectiveCurrentTime(), 3),
      readyState: Number(video.readyState || 0),
      paused: Boolean(video.paused),
      seeking: Boolean(video.seeking),
      mode: inferBenchmarkPlaybackMode(),
      ...details,
    });
    if (benchmarkState.events.length > 120) {
      benchmarkState.events.shift();
    }
  }

  function readBenchmarkVideoQuality() {
    if (typeof video.getVideoPlaybackQuality !== "function") {
      return null;
    }

    try {
      const quality = video.getVideoPlaybackQuality();
      return {
        droppedVideoFrames: Number(quality?.droppedVideoFrames || 0),
        totalVideoFrames: Number(quality?.totalVideoFrames || 0),
        corruptedVideoFrames: Number(quality?.corruptedVideoFrames || 0),
        creationTime: Number(quality?.creationTime || 0),
      };
    } catch {
      return null;
    }
  }

  function summarizeBenchmarkResources() {
    const totals = {
      requestCount: 0,
      transferSize: 0,
      encodedBodySize: 0,
      decodedBodySize: 0,
      durationMs: 0,
    };

    const entries = performance.getEntriesByType("resource");
    entries.forEach((entry) => {
      const name = String(entry?.name || "");
      let pathname = "";
      try {
        pathname = new URL(name, window.location.origin).pathname;
      } catch {
        pathname = name;
      }

      const isPlaybackEntry =
        pathname.startsWith("/assets/videos/") ||
        pathname.startsWith("/media/") ||
        pathname.startsWith("/videos/") ||
        pathname === "/api/remux" ||
        pathname === "/api/hls/master.m3u8" ||
        pathname === "/api/hls/segment.ts" ||
        pathname === "/api/live/hls.m3u8" ||
        pathname === "/api/live/hls-resource";

      if (!isPlaybackEntry) {
        return;
      }

      totals.requestCount += 1;
      totals.transferSize += Number(entry?.transferSize || 0);
      totals.encodedBodySize += Number(entry?.encodedBodySize || 0);
      totals.decodedBodySize += Number(entry?.decodedBodySize || 0);
      totals.durationMs += Number(entry?.duration || 0);
    });

    return {
      requestCount: totals.requestCount,
      transferSize: Math.max(0, Math.round(totals.transferSize)),
      encodedBodySize: Math.max(0, Math.round(totals.encodedBodySize)),
      decodedBodySize: Math.max(0, Math.round(totals.decodedBodySize)),
      durationMs: roundBenchmarkNumber(totals.durationMs, 1),
    };
  }

  function getBenchmarkSnapshot() {
    const frameStats = benchmarkState.frameStats;
    const quality = readBenchmarkVideoQuality();
    const effectiveDurationSeconds = (() => {
      if (typeof getDisplayDurationSeconds === "function") {
        const displayDuration = Number(getDisplayDurationSeconds());
        if (Number.isFinite(displayDuration) && displayDuration > 0) {
          return roundBenchmarkNumber(displayDuration, 3);
        }
      }
      const fallbackDuration = Number(video.duration);
      return Number.isFinite(fallbackDuration)
        ? roundBenchmarkNumber(fallbackDuration, 3)
        : null;
    })();

    return {
      benchmarkMode: true,
      capturedAtMs: roundBenchmarkNumber(benchmarkNowMs(), 1),
      currentTime: roundBenchmarkNumber(getEffectiveCurrentTime(), 3),
      rawCurrentTime: roundBenchmarkNumber(Number(video.currentTime || 0), 3),
      durationSeconds: effectiveDurationSeconds,
      playbackRate: roundBenchmarkNumber(Number(video.playbackRate || 1), 3),
      readyState: Number(video.readyState || 0),
      networkState: Number(video.networkState || 0),
      paused: Boolean(video.paused),
      ended: Boolean(video.ended),
      seeking: Boolean(video.seeking),
      muted: Boolean(video.muted),
      volume: roundBenchmarkNumber(Number(video.volume || 0), 3),
      source: {
        currentSource: getBenchmarkCurrentSource(),
        input: extractPlaybackSourceInput(getBenchmarkCurrentSource()),
        mode: inferBenchmarkPlaybackMode(),
      },
      videoMetrics: {
        clientWidth: Number(video.clientWidth || 0),
        clientHeight: Number(video.clientHeight || 0),
        videoWidth: Number(video.videoWidth || 0),
        videoHeight: Number(video.videoHeight || 0),
      },
      timings: { ...benchmarkState.timings },
      counters: { ...benchmarkState.counters },
      quality,
      frameStats: {
        callbackCount: benchmarkState.frameStats.callbackCount,
        processingDurationSampleCount:
          frameStats.processingDurationSampleCount,
        meanProcessingDurationMs:
          frameStats.processingDurationSampleCount > 0
            ? roundBenchmarkNumber(
                frameStats.processingDurationTotalMs /
                  frameStats.processingDurationSampleCount,
                3,
              )
            : null,
        maxProcessingDurationMs: roundBenchmarkNumber(
          frameStats.maxProcessingDurationMs,
          3,
        ),
        frameIntervalSampleCount: frameStats.frameIntervalSampleCount,
        meanFrameIntervalMs:
          frameStats.frameIntervalSampleCount > 0
            ? roundBenchmarkNumber(
                frameStats.frameIntervalTotalMs /
                  frameStats.frameIntervalSampleCount,
                3,
              )
            : null,
        maxFrameIntervalMs: roundBenchmarkNumber(
          frameStats.maxFrameIntervalMs,
          3,
        ),
        estimatedFrameRateFps:
          frameStats.frameIntervalSampleCount > 0 &&
          frameStats.frameIntervalTotalMs > 0
            ? roundBenchmarkNumber(
                1000 /
                  (frameStats.frameIntervalTotalMs /
                    frameStats.frameIntervalSampleCount),
                3,
              )
            : null,
        maxPresentedFramesDelta: frameStats.maxPresentedFramesDelta,
      },
      resources: summarizeBenchmarkResources(),
      events: benchmarkState.events.slice(),
      sourceHistory: benchmarkState.sourceHistory.slice(),
    };
  }

  async function waitForBenchmarkCondition(
    predicate,
    {
      timeoutMs = 30_000,
      pollIntervalMs = 50,
      errorMessage = "Benchmark condition timed out.",
    } = {},
  ) {
    const startedAt = performance.now();

    return new Promise((resolve, reject) => {
      function step() {
        let result = null;
        try {
          result = predicate();
        } catch (error) {
          reject(error);
          return;
        }

        if (result) {
          resolve(result === true ? getBenchmarkSnapshot() : result);
          return;
        }

        if (performance.now() - startedAt >= timeoutMs) {
          reject(new Error(errorMessage));
          return;
        }

        window.setTimeout(step, pollIntervalMs);
      }

      step();
    });
  }

  function armBenchmarkFrameCallback() {
    if (
      benchmarkState.frameCallbackArmed ||
      typeof video.requestVideoFrameCallback !== "function"
    ) {
      return;
    }

    benchmarkState.frameCallbackArmed = true;
    video.requestVideoFrameCallback((now, metadata) => {
      benchmarkState.frameCallbackArmed = false;
      benchmarkState.frameStats.callbackCount += 1;
      rememberFirstBenchmarkTiming("firstVideoFrameMs");
      benchmarkState.timings.lastVideoFrameMs = roundBenchmarkNumber(
        benchmarkNowMs(),
        1,
      );

      const processingDurationMs =
        Number(metadata?.processingDuration || 0) * 1000;
      if (Number.isFinite(processingDurationMs) && processingDurationMs >= 0) {
        benchmarkState.frameStats.processingDurationSampleCount += 1;
        benchmarkState.frameStats.processingDurationTotalMs +=
          processingDurationMs;
        benchmarkState.frameStats.maxProcessingDurationMs = Math.max(
          benchmarkState.frameStats.maxProcessingDurationMs,
          processingDurationMs,
        );
      }

      if (Number.isFinite(benchmarkState.frameStats.lastFrameNowMs)) {
        const frameIntervalMs = now - benchmarkState.frameStats.lastFrameNowMs;
        if (Number.isFinite(frameIntervalMs) && frameIntervalMs >= 0) {
          benchmarkState.frameStats.frameIntervalSampleCount += 1;
          benchmarkState.frameStats.frameIntervalTotalMs += frameIntervalMs;
          benchmarkState.frameStats.maxFrameIntervalMs = Math.max(
            benchmarkState.frameStats.maxFrameIntervalMs,
            frameIntervalMs,
          );
        }
      }
      benchmarkState.frameStats.lastFrameNowMs = now;

      const presentedFrames = Number(metadata?.presentedFrames || 0);
      if (
        Number.isFinite(presentedFrames) &&
        Number.isFinite(benchmarkState.frameStats.lastPresentedFrames)
      ) {
        benchmarkState.frameStats.maxPresentedFramesDelta = Math.max(
          benchmarkState.frameStats.maxPresentedFramesDelta,
          Math.max(
            0,
            presentedFrames - benchmarkState.frameStats.lastPresentedFrames,
          ),
        );
      }
      if (Number.isFinite(presentedFrames) && presentedFrames >= 0) {
        benchmarkState.frameStats.lastPresentedFrames = presentedFrames;
      }

      if (!video.ended) {
        armBenchmarkFrameCallback();
      }
    });
  }

  function recordBenchmarkVideoEvent(type) {
    if (Object.hasOwn(benchmarkState.counters, type)) {
      benchmarkState.counters[type] += 1;
    }

    if (type === "loadedmetadata") {
      rememberFirstBenchmarkTiming("firstLoadedMetadataMs");
      armBenchmarkFrameCallback();
    } else if (type === "canplay") {
      rememberFirstBenchmarkTiming("firstCanPlayMs");
      armBenchmarkFrameCallback();
    } else if (type === "playing") {
      rememberFirstBenchmarkTiming("firstPlayingMs");
      armBenchmarkFrameCallback();
    } else if (type === "timeupdate") {
      rememberFirstBenchmarkTiming("firstTimeUpdateMs");
    }

    if (type === "error") {
      pushBenchmarkEvent(type, {
        mediaErrorCode: Number(video.error?.code || 0) || null,
        mediaErrorMessage: String(video.error?.message || "").trim() || null,
      });
      return;
    }

    pushBenchmarkEvent(type);
  }

  [
    "loadedmetadata",
    "canplay",
    "playing",
    "waiting",
    "stalled",
    "error",
    "play",
    "pause",
    "seeking",
    "seeked",
    "ended",
    "timeupdate",
  ].forEach((eventName) => {
    video.addEventListener(eventName, () => recordBenchmarkVideoEvent(eventName));
  });

  return {
    getSnapshot: getBenchmarkSnapshot,
    play: async () => {
      await tryPlay();
      return getBenchmarkSnapshot();
    },
    pause: () => {
      video.pause();
      return getBenchmarkSnapshot();
    },
    waitForPlayback: async ({
      timeoutMs = 30_000,
      minCurrentTime = 1.25,
    } = {}) => {
      return waitForBenchmarkCondition(
        () => {
          const snapshot = getBenchmarkSnapshot();
          if (!snapshot.source.currentSource) {
            return null;
          }
          const hasStarted =
            snapshot.timings.firstPlayingMs !== null ||
            snapshot.timings.firstVideoFrameMs !== null;
          if (
            hasStarted &&
            snapshot.readyState >= 2 &&
            snapshot.currentTime >= minCurrentTime
          ) {
            return snapshot;
          }
          return null;
        },
        {
          timeoutMs,
          errorMessage: `Playback did not advance past ${minCurrentTime}s in time.`,
        },
      );
    },
    measurePauseResume: async ({
      pauseDurationMs = 500,
      playbackAdvanceSeconds = 0.35,
      timeoutMs = 15_000,
    } = {}) => {
      const baselineCurrentTime = getEffectiveCurrentTime();
      const pauseStartedAt = performance.now();
      video.pause();
      await waitForBenchmarkCondition(() => video.paused, {
        timeoutMs,
        errorMessage: "Pause did not settle in time.",
      });
      const pauseSettledMs = performance.now() - pauseStartedAt;

      if (pauseDurationMs > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, pauseDurationMs));
      }

      const resumeStartedAt = performance.now();
      await tryPlay();
      const targetTime = baselineCurrentTime + Math.max(0.05, playbackAdvanceSeconds);
      await waitForBenchmarkCondition(
        () => {
          if (video.paused || video.readyState < 2) {
            return null;
          }
          return getEffectiveCurrentTime() >= targetTime
            ? getBenchmarkSnapshot()
            : null;
        },
        {
          timeoutMs,
          errorMessage: "Playback did not resume cleanly in time.",
        },
      );

      return {
        baselineCurrentTime: roundBenchmarkNumber(baselineCurrentTime, 3),
        pauseSettledMs: roundBenchmarkNumber(pauseSettledMs, 2),
        resumeLatencyMs: roundBenchmarkNumber(
          performance.now() - resumeStartedAt,
          2,
        ),
        endCurrentTime: roundBenchmarkNumber(getEffectiveCurrentTime(), 3),
        snapshot: getBenchmarkSnapshot(),
      };
    },
    measureSeek: async ({
      targetSeconds = 0,
      playbackAdvanceSeconds = 0.35,
      timeoutMs = 20_000,
      showLoading = true,
    } = {}) => {
      const baselineCurrentTime = getEffectiveCurrentTime();
      const safeTargetSeconds = Math.max(0, Number(targetSeconds) || 0);
      const seekStartedAt = performance.now();
      seekToAbsoluteTime(safeTargetSeconds, { showLoading });

      await waitForBenchmarkCondition(
        () => {
          if (video.seeking || video.readyState < 2) {
            return null;
          }
          const effectiveCurrentTime = getEffectiveCurrentTime();
          const nearTarget = Math.abs(effectiveCurrentTime - safeTargetSeconds) <= 1;
          const advancedPastTarget =
            effectiveCurrentTime >=
            safeTargetSeconds + Math.max(0.05, playbackAdvanceSeconds);
          return nearTarget || advancedPastTarget
            ? getBenchmarkSnapshot()
            : null;
        },
        {
          timeoutMs,
          errorMessage: `Seek to ${safeTargetSeconds}s did not settle in time.`,
        },
      );

      const endCurrentTime = getEffectiveCurrentTime();
      return {
        baselineCurrentTime: roundBenchmarkNumber(baselineCurrentTime, 3),
        targetSeconds: roundBenchmarkNumber(safeTargetSeconds, 3),
        seekLatencyMs: roundBenchmarkNumber(
          performance.now() - seekStartedAt,
          2,
        ),
        endCurrentTime: roundBenchmarkNumber(endCurrentTime, 3),
        absoluteErrorSeconds: roundBenchmarkNumber(
          Math.abs(endCurrentTime - safeTargetSeconds),
          3,
        ),
        snapshot: getBenchmarkSnapshot(),
      };
    },
    setStrategy: async ({
      mode = "direct",
      input = "",
      startSeconds = 0,
      audioStreamIndex = -1,
      subtitleStreamIndex = -1,
      videoMode = getPreferredRemuxVideoMode(),
    } = {}) => {
      const safeInput = String(input || "").trim();
      if (!safeInput) {
        throw new Error("Benchmark strategy input is required.");
      }

      let nextSource = safeInput;
      if (mode === "remux") {
        nextSource = buildSoftwareDecodeUrl(
          safeInput,
          startSeconds,
          audioStreamIndex,
          getPreferredAudioSyncMs(),
          subtitleStreamIndex,
          videoMode,
        );
      } else if (mode === "hls") {
        nextSource = buildHlsPlaybackUrl(
          safeInput,
          audioStreamIndex,
          subtitleStreamIndex,
        );
      } else if (mode === "direct") {
        if (
          !safeInput.startsWith("/") &&
          !/^[a-z]+:\/\//i.test(safeInput)
        ) {
          nextSource = `/${safeInput}`;
        }
      } else {
        throw new Error(`Unsupported benchmark strategy '${mode}'.`);
      }

      setVideoSource(nextSource);
      await tryPlay();
      return getBenchmarkSnapshot();
    },
    _recordSourceChange: (source) => {
      const atMs = roundBenchmarkNumber(benchmarkNowMs(), 1);
      benchmarkState.timings.lastSourceSetMs = atMs;
      benchmarkState.sourceHistory.push({
        atMs,
        mode: inferBenchmarkPlaybackMode(source),
        source,
      });
      if (benchmarkState.sourceHistory.length > 24) {
        benchmarkState.sourceHistory.shift();
      }
      pushBenchmarkEvent("sourcechange", {
        source,
        mode: inferBenchmarkPlaybackMode(source),
      });
    },
  };
}

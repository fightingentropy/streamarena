import { isHlsPlaybackSource } from "./hls-playback.js";

const DEFAULT_READY_TIMEOUT_MS = 8_000;

function normalizeIdentityString(value, { lowercase = false } = {}) {
  const normalized = String(value || "").trim();
  return lowercase ? normalized.toLowerCase() : normalized;
}

function normalizeStreamIndex(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : -1;
}

export function createDeferredMediaTrackIdentity({
  playbackRequestToken = 0,
  sourceHash = "",
  sourceInput = "",
  audioLang = "",
  subtitleLang = "",
} = {}) {
  const parsedToken = Number(playbackRequestToken);
  return {
    playbackRequestToken: Number.isFinite(parsedToken)
      ? Math.floor(parsedToken)
      : 0,
    sourceHash: normalizeIdentityString(sourceHash, { lowercase: true }),
    sourceInput: normalizeIdentityString(sourceInput),
    audioLang: normalizeIdentityString(audioLang, { lowercase: true }),
    subtitleLang: normalizeIdentityString(subtitleLang, { lowercase: true }),
  };
}

export function isDeferredMediaTrackIdentityCurrent(expected, current) {
  if (!expected || !current) {
    return false;
  }
  return (
    expected.playbackRequestToken === current.playbackRequestToken &&
    expected.sourceHash === current.sourceHash &&
    expected.sourceInput === current.sourceInput &&
    expected.audioLang === current.audioLang &&
    expected.subtitleLang === current.subtitleLang
  );
}

export function buildDeferredMediaTracksQuery({
  sourceInput = "",
  title = "",
  year = "",
  imdbId = "",
  filename = "",
  mediaType = "",
  seasonNumber = 0,
  episodeNumber = 0,
  audioLang = "auto",
  subtitleLang = "",
} = {}) {
  const input = normalizeIdentityString(sourceInput);
  if (!input) {
    return "";
  }

  const query = new URLSearchParams({ input });
  const optionalValues = {
    title,
    year,
    imdbId,
    filename,
  };
  Object.entries(optionalValues).forEach(([key, value]) => {
    const normalized = normalizeIdentityString(value);
    if (normalized) {
      query.set(key, normalized);
    }
  });

  query.set(
    "audioLang",
    normalizeIdentityString(audioLang, { lowercase: true }) || "auto",
  );
  // Send the current value even when it is empty, and preserve `off`
  // explicitly. The backend uses `off` to avoid unnecessary external lookup
  // for viewers who disabled subtitles.
  query.set(
    "subtitleLang",
    normalizeIdentityString(subtitleLang, { lowercase: true }),
  );

  if (normalizeIdentityString(mediaType, { lowercase: true }) === "tv") {
    const normalizedSeason = normalizeStreamIndex(Number(seasonNumber) - 1) + 1;
    const normalizedEpisode = normalizeStreamIndex(Number(episodeNumber) - 1) + 1;
    if (normalizedSeason > 0) {
      query.set("seasonNumber", String(normalizedSeason));
    }
    if (normalizedEpisode > 0) {
      query.set("episodeNumber", String(normalizedEpisode));
    }
  }

  return query.toString();
}

export function waitForDeferredMediaTrackProbe(
  media,
  {
    timeoutMs = DEFAULT_READY_TIMEOUT_MS,
    signal,
    setTimeoutFn = (callback, delayMs) =>
      globalThis.setTimeout(callback, delayMs),
    clearTimeoutFn = (timeoutId) => globalThis.clearTimeout(timeoutId),
  } = {},
) {
  if (!media || typeof media.addEventListener !== "function") {
    return Promise.resolve("unavailable");
  }
  if (signal?.aborted) {
    return Promise.resolve("canceled");
  }
  if (media.error) {
    return Promise.resolve("error");
  }
  if (Number(media.readyState || 0) >= 3) {
    return Promise.resolve("ready");
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId = null;
    const listeners = [
      ["canplay", () => finish("ready")],
      ["playing", () => finish("ready")],
      ["error", () => finish("error")],
    ];

    function cleanup() {
      listeners.forEach(([event, listener]) => {
        media.removeEventListener?.(event, listener);
      });
      if (timeoutId !== null) {
        clearTimeoutFn(timeoutId);
        timeoutId = null;
      }
      signal?.removeEventListener?.("abort", handleAbort);
    }

    function finish(reason) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(reason);
    }

    function handleAbort() {
      finish("canceled");
    }

    listeners.forEach(([event, listener]) => {
      media.addEventListener(event, listener);
    });
    signal?.addEventListener?.("abort", handleAbort, { once: true });
    timeoutId = setTimeoutFn(
      () => finish("timeout"),
      Math.max(1, Number(timeoutMs) || DEFAULT_READY_TIMEOUT_MS),
    );

    // Close the small race between the pre-listener check and registration.
    if (signal?.aborted) {
      finish("canceled");
    } else if (media.error) {
      finish("error");
    } else if (Number(media.readyState || 0) >= 3) {
      finish("ready");
    }
  });
}

export function getDeferredTrackRestartPlan({
  currentRoute = "direct",
  currentAudioStreamIndex = -1,
  currentSubtitleStreamIndex = -1,
  selectedAudioStreamIndex = -1,
  firstAudioStreamIndex = -1,
  defaultAudioStreamIndex = -1,
  selectedNativeSubtitleStreamIndex = -1,
  forceAudioRemux = false,
  softwareDecodeRequired = false,
} = {}) {
  const route = ["direct", "hls", "remux"].includes(currentRoute)
    ? currentRoute
    : "direct";
  const currentAudio = normalizeStreamIndex(currentAudioStreamIndex);
  const currentSubtitle = normalizeStreamIndex(currentSubtitleStreamIndex);
  const selectedAudio = normalizeStreamIndex(selectedAudioStreamIndex);
  const firstAudio = normalizeStreamIndex(firstAudioStreamIndex);
  const defaultAudio = normalizeStreamIndex(defaultAudioStreamIndex);
  const nativeSubtitle = normalizeStreamIndex(
    selectedNativeSubtitleStreamIndex,
  );
  const implicitAudio = route === "direct" ? defaultAudio : firstAudio;
  const effectiveCurrentAudio = currentAudio >= 0 ? currentAudio : implicitAudio;
  const needsAudioSelection =
    selectedAudio >= 0 && selectedAudio !== effectiveCurrentAudio;
  const needsNativeSubtitle =
    nativeSubtitle >= 0 &&
    (route !== "remux" || currentSubtitle !== nativeSubtitle);

  if (needsNativeSubtitle) {
    return { required: true, mode: "remux", reason: "subtitle" };
  }
  if (
    route === "direct" &&
    (Boolean(forceAudioRemux) || Boolean(softwareDecodeRequired))
  ) {
    return { required: true, mode: "remux", reason: "audio" };
  }
  if (!needsAudioSelection) {
    return { required: false, mode: "", reason: "" };
  }
  if (route === "hls") {
    return { required: true, mode: "hls", reason: "audio" };
  }
  return { required: true, mode: "remux", reason: "audio" };
}

function normalizeTrackPayload(
  payload,
  fallbackAudioPreference = "auto",
  { mapAudioSelection = true } = {},
) {
  const tracks = payload?.tracks || {};
  const durationSeconds = Number(tracks.durationSeconds);
  const selectedAudioStreamIndex = mapAudioSelection
    ? normalizeStreamIndex(payload?.selectedAudioStreamIndex)
    : -1;
  const selectedSubtitleStreamIndex = normalizeStreamIndex(
    payload?.selectedSubtitleStreamIndex,
  );
  return {
    audioTracks: Array.isArray(tracks.audioTracks) ? tracks.audioTracks : [],
    subtitleTracks: Array.isArray(tracks.subtitleTracks)
      ? tracks.subtitleTracks
      : [],
    selectedAudioStreamIndex,
    selectedSubtitleStreamIndex,
    durationSeconds:
      Number.isFinite(durationSeconds) && durationSeconds > 0
        ? Math.floor(durationSeconds)
        : null,
    audioPreference:
      normalizeIdentityString(
        payload?.preferences?.audioLang || fallbackAudioPreference || "auto",
        { lowercase: true },
      ) || "auto",
  };
}

async function requestMediaTracks(url, { signal } = {}) {
  const response = await globalThis.fetch(url, { signal });
  const rawText = await response.text();
  let payload = null;
  if (rawText) {
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = { message: rawText };
    }
  }
  if (!response.ok) {
    throw new Error(
      String(
        payload?.error ||
          payload?.message ||
          `Request failed (${response.status}).`,
      ),
    );
  }
  return payload;
}

function getCurrentIdentity(getState) {
  const state = getState();
  return createDeferredMediaTrackIdentity({
    sourceInput: state.sourceInput,
    audioLang: state.audioLang,
    subtitleLang: state.subtitleLang,
  });
}

function getCurrentRoute(state, parseTranscodeSource, parseHlsMasterSource) {
  const remuxMeta = parseTranscodeSource(state.currentPlaybackSource);
  if (remuxMeta) {
    return {
      kind: "remux",
      audioStreamIndex: remuxMeta.audioStreamIndex,
      subtitleStreamIndex: remuxMeta.subtitleStreamIndex,
    };
  }
  const hlsMeta = parseHlsMasterSource(state.currentPlaybackSource);
  if (hlsMeta) {
    return {
      kind: "hls",
      audioStreamIndex: hlsMeta.audioStreamIndex,
      subtitleStreamIndex: hlsMeta.subtitleStreamIndex,
    };
  }
  if (isHlsPlaybackSource(state.currentPlaybackSource)) {
    return { kind: "hls", audioStreamIndex: -1, subtitleStreamIndex: -1 };
  }
  return { kind: "direct", audioStreamIndex: -1, subtitleStreamIndex: -1 };
}

/**
 * Owns best-effort media probing after playback has started. The page supplies
 * its mutable playback state through a narrow adapter, while request ordering,
 * stale-response rejection, and restart decisions stay in this domain module.
 */
export function createDeferredMediaTrackController({
  requestTracks = requestMediaTracks,
  getState,
  setActiveSourceInput,
  applyTrackState,
  isSupportedAudioLanguage = () => false,
  parseTranscodeSource = () => null,
  parseHlsMasterSource = () => null,
  getDefaultEmbeddedAudioTrack = () => null,
  getSubtitleTrackByStreamIndex = () => null,
  shouldUseNativeEmbeddedSubtitleTrack = () => false,
  hasLoadedNativeSubtitleTrack = () => false,
  applyStoredSubtitleSelectionPreference = () => {},
  shouldForceRemuxForEmbeddedAudio = () => false,
  shouldUseSoftwareDecode = () => false,
  rebuildTrackOptionButtons = () => {},
  syncAudioState = () => {},
  syncDurationText = () => {},
  getEffectiveCurrentTime = () => 0,
  buildHlsPlaybackUrl = (sourceInput) => sourceInput,
  buildSoftwareDecodeUrl = (sourceInput) => sourceInput,
  setVideoSource = () => {},
  applySubtitleTrackByStreamIndex = () => {},
  tryPlay = async () => {},
  warn = (...args) => console.warn(...args),
} = {}) {
  let requestSequence = 0;
  let activeOperationController = null;
  let sourceChangeInProgress = false;

  function cancel() {
    if (sourceChangeInProgress) {
      return requestSequence;
    }
    requestSequence += 1;
    activeOperationController?.abort();
    activeOperationController = null;
    return requestSequence;
  }

  function beginOperation() {
    const scheduledSequence = cancel();
    const controller = new AbortController();
    activeOperationController = controller;
    return { scheduledSequence, controller };
  }

  async function runRequest(url, timeoutMs, scheduledSequence, controller) {
    const timeoutId = globalThis.setTimeout(
      () => controller.abort(),
      Math.max(1, Number(timeoutMs) || 20_000),
    );
    try {
      return await requestTracks(url, { signal: controller.signal });
    } finally {
      globalThis.clearTimeout(timeoutId);
      if (
        scheduledSequence === requestSequence &&
        activeOperationController === controller
      ) {
        activeOperationController = null;
      }
    }
  }

  async function applyDeferredPayload(payload) {
    const before = getState();
    const shouldMapAudioSelection = before.audioLang !== "auto";
    const normalizedTracks = normalizeTrackPayload(payload, before.audioLang, {
      mapAudioSelection: shouldMapAudioSelection,
    });
    applyTrackState(normalizedTracks, {
      resetDuration: false,
      updateAudioPreference: true,
    });
    applyStoredSubtitleSelectionPreference();

    const state = getState();
    const route = getCurrentRoute(
      state,
      parseTranscodeSource,
      parseHlsMasterSource,
    );
    const defaultAudioTrack = getDefaultEmbeddedAudioTrack();
    const selectedSubtitleTrack = getSubtitleTrackByStreamIndex(
      state.selectedSubtitleStreamIndex,
    );
    const useNativeSubtitle = shouldUseNativeEmbeddedSubtitleTrack(
      selectedSubtitleTrack,
    );
    const nativeSubtitleAlreadyLoaded =
      useNativeSubtitle && hasLoadedNativeSubtitleTrack(selectedSubtitleTrack);
    const nativeSubtitleStreamIndex =
      useNativeSubtitle && !nativeSubtitleAlreadyLoaded
      ? state.selectedSubtitleStreamIndex
      : -1;
    const restartPlan = getDeferredTrackRestartPlan({
      currentRoute: route.kind,
      currentAudioStreamIndex: route.audioStreamIndex,
      currentSubtitleStreamIndex: route.subtitleStreamIndex,
      selectedAudioStreamIndex: state.selectedAudioStreamIndex,
      firstAudioStreamIndex: Number(normalizedTracks.audioTracks[0]?.streamIndex),
      defaultAudioStreamIndex: Number(defaultAudioTrack?.streamIndex),
      selectedNativeSubtitleStreamIndex: nativeSubtitleStreamIndex,
      forceAudioRemux: shouldForceRemuxForEmbeddedAudio(),
      softwareDecodeRequired: shouldUseSoftwareDecode(state.sourceInput),
    });

    rebuildTrackOptionButtons();
    syncAudioState();
    syncDurationText();
    if (!restartPlan.required || !state.sourceInput) {
      applySubtitleTrackByStreamIndex(state.selectedSubtitleStreamIndex);
      return false;
    }

    const resumeFrom = Math.max(0, getEffectiveCurrentTime());
    const wasPaused = Boolean(state.video?.paused);
    const nextSource =
      restartPlan.mode === "hls"
        ? buildHlsPlaybackUrl(state.sourceInput, state.selectedAudioStreamIndex, -1)
        : buildSoftwareDecodeUrl(
            state.sourceInput,
            0,
            state.selectedAudioStreamIndex,
            state.activeAudioSyncMs || state.preferredAudioSyncMs,
            state.selectedSubtitleStreamIndex,
          );
    sourceChangeInProgress = true;
    try {
      setVideoSource(nextSource, {
        startSeconds: resumeFrom > 1 ? resumeFrom : 0,
        resetInitialResume: false,
        autoplay: !wasPaused,
      });
    } finally {
      sourceChangeInProgress = false;
    }
    applySubtitleTrackByStreamIndex(state.selectedSubtitleStreamIndex, {
      preservePendingNative: restartPlan.mode === "remux",
    });
    if (!wasPaused) {
      await tryPlay();
    }
    syncDurationText();
    return true;
  }

  function schedule(resolved) {
    const state = getState();
    if (resolved?.tracksPending !== true || !state.video) {
      return false;
    }
    const sourceInput = normalizeIdentityString(
      resolved?.sourceInput || state.sourceInput,
    );
    if (!sourceInput) {
      return false;
    }

    const expectedIdentity = createDeferredMediaTrackIdentity({
      sourceInput,
      audioLang: state.audioLang,
      subtitleLang: state.subtitleLang,
    });
    const query = buildDeferredMediaTracksQuery({
      sourceInput,
      title: resolved?.metadata?.displayTitle || state.title,
      year: resolved?.metadata?.displayYear || state.year,
      imdbId: resolved?.metadata?.imdbId || "",
      filename: resolved?.filename || state.filename,
      mediaType: state.isTv ? "tv" : "movie",
      seasonNumber: resolved?.metadata?.seasonNumber || state.seasonNumber,
      episodeNumber: resolved?.metadata?.episodeNumber || state.episodeNumber,
      audioLang: state.audioLang,
      subtitleLang: state.subtitleLang,
    });
    if (!query) {
      return false;
    }
    const { scheduledSequence, controller } = beginOperation();

    void (async () => {
      await waitForDeferredMediaTrackProbe(state.video, {
        timeoutMs: 8_000,
        signal: controller.signal,
      });
      if (
        scheduledSequence !== requestSequence ||
        !isDeferredMediaTrackIdentityCurrent(
          expectedIdentity,
          getCurrentIdentity(getState),
        )
      ) {
        controller.abort();
        if (activeOperationController === controller) {
          activeOperationController = null;
        }
        return;
      }
      let payload;
      try {
        payload = await runRequest(
          `/api/media/tracks?${query}`,
          45_000,
          scheduledSequence,
          controller,
        );
      } catch (error) {
        if (scheduledSequence !== requestSequence) {
          return;
        }
        warn("Deferred media track enrichment failed.", error);
        return;
      }
      if (
        scheduledSequence !== requestSequence ||
        !isDeferredMediaTrackIdentityCurrent(
          expectedIdentity,
          getCurrentIdentity(getState),
        )
      ) {
        return;
      }
      try {
        await applyDeferredPayload(payload);
      } catch (error) {
        if (scheduledSequence === requestSequence) {
          warn("Deferred media track application failed.", error);
        }
      }
    })();
    return true;
  }

  async function resolveExplicit(sourceInput) {
    const normalizedSourceInput = normalizeIdentityString(sourceInput);
    setActiveSourceInput(normalizedSourceInput);
    if (!normalizedSourceInput) {
      cancel();
      applyTrackState(normalizeTrackPayload(null), {
        resetDuration: true,
        updateAudioPreference: false,
      });
      rebuildTrackOptionButtons();
      return;
    }
    const { scheduledSequence, controller } = beginOperation();

    const state = getState();
    const query = new URLSearchParams({ input: normalizedSourceInput });
    if (state.title) query.set("title", state.title);
    if (state.year) query.set("year", state.year);
    if (isSupportedAudioLanguage(state.audioLang) && state.audioLang !== "auto") {
      query.set("audioLang", state.audioLang);
    }
    if (state.subtitleLang && state.subtitleLang !== "off") {
      query.set("subtitleLang", state.subtitleLang);
    }

    try {
      const payload = await runRequest(
        `/api/media/tracks?${query.toString()}`,
        20_000,
        scheduledSequence,
        controller,
      );
      if (scheduledSequence !== requestSequence) {
        return;
      }
      applyTrackState(normalizeTrackPayload(payload, state.audioLang), {
        resetDuration: true,
        updateAudioPreference: false,
      });
    } catch {
      if (scheduledSequence !== requestSequence) {
        return;
      }
      applyTrackState(normalizeTrackPayload(null), {
        resetDuration: true,
        updateAudioPreference: false,
      });
    }
    rebuildTrackOptionButtons();
    syncAudioState();
    syncDurationText();
  }

  return {
    schedule,
    resolveExplicit,
    cancel,
    dispose: cancel,
  };
}

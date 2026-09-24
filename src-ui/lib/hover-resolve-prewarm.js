export function buildMovieResolvePrewarmUrl({
  tmdbId = "",
  title = "",
  year = "",
  audioLang = "en",
  subtitleLang = "",
  quality = "auto",
} = {}) {
  const normalizedTmdbId = String(tmdbId || "").trim();
  if (!/^\d+$/.test(normalizedTmdbId)) {
    return "";
  }
  const params = new URLSearchParams({
    tmdbId: normalizedTmdbId,
    title: String(title || "").trim(),
    year: String(year || "").trim(),
    audioLang: String(audioLang || "en").trim() || "en",
    quality: String(quality || "auto").trim(),
    resolverProvider: "fastest",
    sourceLang: "en",
    sourceAudioProfile: "single",
  });
  const normalizedSubtitleLang = String(subtitleLang || "").trim();
  if (normalizedSubtitleLang) {
    params.set("subtitleLang", normalizedSubtitleLang);
  }
  return `/api/resolve/movie?${params.toString()}`;
}

export function buildTvResolvePrewarmUrl({
  tmdbId = "",
  title = "",
  year = "",
  seasonNumber = 1,
  episodeNumber = 1,
  audioLang = "en",
  subtitleLang = "",
  quality = "auto",
  preferredContainer = "",
} = {}) {
  const normalizedTmdbId = String(tmdbId || "").trim();
  if (!/^\d+$/.test(normalizedTmdbId)) {
    return "";
  }
  const safeSeason = Math.max(1, Math.floor(Number(seasonNumber) || 1));
  const safeEpisode = Math.max(1, Math.floor(Number(episodeNumber) || 1));
  const params = new URLSearchParams({
    tmdbId: normalizedTmdbId,
    title: String(title || "").trim(),
    year: String(year || "").trim(),
    seasonNumber: String(safeSeason),
    episodeNumber: String(safeEpisode),
    audioLang: String(audioLang || "en").trim() || "en",
    quality: String(quality || "auto").trim(),
    resolverProvider: "fastest",
    sourceLang: "en",
    sourceAudioProfile: "single",
  });
  if (preferredContainer) params.set("preferredContainer", preferredContainer);
  const normalizedSubtitleLang = String(subtitleLang || "").trim();
  if (normalizedSubtitleLang) {
    params.set("subtitleLang", normalizedSubtitleLang);
  }
  return `/api/resolve/tv?${params.toString()}`;
}

export function buildResolvePrewarmUrl(details = {}) {
  return String(details.mediaType || "").trim() === "tv"
    ? buildTvResolvePrewarmUrl(details)
    : buildMovieResolvePrewarmUrl(details);
}

export function createMovieResolvePrewarmer({
  fetchFn,
  buildUrl = buildMovieResolvePrewarmUrl,
  maxConcurrent = 1,
  maxRemembered = 48,
  timeoutMs = 15_000,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
} = {}) {
  const requestFetch = typeof fetchFn === "function" ? fetchFn : globalThis.fetch;
  const buildRequestUrl = typeof buildUrl === "function" ? buildUrl : buildMovieResolvePrewarmUrl;
  const safeMaxConcurrent = Math.max(1, Math.floor(Number(maxConcurrent) || 1));
  const safeMaxRemembered = Math.max(1, Math.floor(Number(maxRemembered) || 1));
  const requests = new Map();
  const pending = new Map();
  let paused = false;

  function pruneRemembered() {
    while (requests.size > safeMaxRemembered) {
      const oldestKey = [...requests].find(([, status]) => status === "ready")?.[0];
      if (!oldestKey) break;
      requests.delete(oldestKey);
    }
  }

  function prewarm(details = {}) {
    const url = buildRequestUrl(details);
    if (paused || !url || typeof requestFetch !== "function" || requests.has(url)) {
      return false;
    }
    if (pending.size >= safeMaxConcurrent) {
      return false;
    }

    const controller = new AbortController();
    const timeoutId = setTimeoutFn(() => controller.abort(), Math.max(1, Number(timeoutMs) || 15_000));
    pending.set(url, { controller, timeoutId });
    requests.set(url, "pending");
    let request;
    try {
      request = requestFetch(url, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal: controller.signal,
        priority: "low",
      });
    } catch (error) {
      request = Promise.reject(error);
    }
    void Promise.resolve(request)
      .then((response) => {
        if (controller.signal.aborted) return;
        if (!response?.ok) {
          throw new Error(`Resolve prewarm failed (${response?.status || 0}).`);
        }
        requests.delete(url);
        requests.set(url, "ready");
        pruneRemembered();
      })
      .catch(() => {
        if (pending.get(url)?.controller === controller) requests.delete(url);
      })
      .finally(() => {
        clearTimeoutFn(timeoutId);
        if (pending.get(url)?.controller === controller) {
          pending.delete(url);
          if (requests.get(url) === "pending") requests.delete(url);
        }
      });
    return true;
  }

  function cancelAll() {
    for (const [url, { controller, timeoutId }] of pending) {
      controller.abort();
      clearTimeoutFn(timeoutId);
      requests.delete(url);
    }
    pending.clear();
  }

  return {
    prewarm,
    cancelAll,
    pause() { paused = true; cancelAll(); },
    resume() { paused = false; },
    getActiveCount: () => pending.size,
    getStatus: (details = {}) => requests.get(buildRequestUrl(details)) || "",
  };
}

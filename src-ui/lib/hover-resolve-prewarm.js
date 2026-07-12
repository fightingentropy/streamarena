import { DEFAULT_STREAM_QUALITY_PREFERENCE } from "./preferences.js";

export function buildMovieResolvePrewarmUrl({
  tmdbId = "",
  title = "",
  year = "",
  audioLang = "en",
  subtitleLang = "",
  quality = DEFAULT_STREAM_QUALITY_PREFERENCE,
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
    quality: String(quality || DEFAULT_STREAM_QUALITY_PREFERENCE).trim(),
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

export function createMovieResolvePrewarmer({
  fetchFn,
  maxConcurrent = 2,
  maxRemembered = 48,
} = {}) {
  const requestFetch = typeof fetchFn === "function" ? fetchFn : globalThis.fetch;
  const safeMaxConcurrent = Math.max(1, Math.floor(Number(maxConcurrent) || 1));
  const safeMaxRemembered = Math.max(1, Math.floor(Number(maxRemembered) || 1));
  const requests = new Map();
  let activeCount = 0;

  function pruneRemembered() {
    while (requests.size > safeMaxRemembered) {
      const oldestKey = requests.keys().next().value;
      if (!oldestKey) break;
      requests.delete(oldestKey);
    }
  }

  function prewarm(details = {}) {
    const url = buildMovieResolvePrewarmUrl(details);
    if (!url || typeof requestFetch !== "function" || requests.has(url)) {
      return false;
    }
    if (activeCount >= safeMaxConcurrent) {
      return false;
    }

    activeCount += 1;
    requests.set(url, "pending");
    void Promise.resolve(
      requestFetch(url, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        keepalive: true,
      }),
    )
      .then((response) => {
        if (!response?.ok) {
          throw new Error(`Resolve prewarm failed (${response?.status || 0}).`);
        }
        requests.delete(url);
        requests.set(url, "ready");
        pruneRemembered();
      })
      .catch(() => {
        requests.delete(url);
      })
      .finally(() => {
        activeCount = Math.max(0, activeCount - 1);
      });
    return true;
  }

  return {
    prewarm,
    getActiveCount: () => activeCount,
    getStatus: (details = {}) => requests.get(buildMovieResolvePrewarmUrl(details)) || "",
  };
}

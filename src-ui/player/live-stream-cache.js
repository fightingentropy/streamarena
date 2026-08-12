import { normalizePlaybackSourceValue } from "./live-streams.js";

export const LIVE_FAILED_STREAM_CACHE_TTL_MS = 5 * 60 * 1000;
export const LIVE_FAILED_STREAM_CACHE_STORAGE_PREFIX =
  "streamarena-live-failed-streams:";
export const LIVE_WORKING_STREAM_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const LIVE_WORKING_STREAM_CACHE_STORAGE_PREFIX =
  "streamarena-live-working-stream:";
export const LIVE_SOURCE_PREFERENCE_STORAGE_KEY =
  "streamarena-live-source-preferences";
export const LIVE_SOURCE_PREFERENCE_TTL_MS = 24 * 60 * 60 * 1000;

function readOrigin(origin) {
  const explicit = String(origin || "").trim();
  if (explicit) {
    return explicit;
  }
  try {
    return String(globalThis.location?.origin || "").trim();
  } catch {
    return "";
  }
}

export function normalizeLiveStreamPreferenceProvider(
  streamOption = {},
  origin = "",
) {
  const explicitProvider = String(streamOption?.provider || "")
    .trim()
    .toLowerCase();
  if (explicitProvider) {
    return explicitProvider;
  }
  try {
    const host = new URL(
      normalizePlaybackSourceValue(streamOption?.source),
      readOrigin(origin) || "http://localhost",
    ).hostname.toLowerCase();
    if (host.includes("streamed.pk")) {
      return "streamed";
    }
    if (
      host === "ntvs.cx" ||
      host === "www.ntvs.cx" ||
      host === "ntv.cx" ||
      host === "www.ntv.cx" ||
      host === "embed.st" ||
      host === "www.embed.st" ||
      host === "hesgoaler.com" ||
      host.endsWith(".hesgoaler.com") ||
      host.endsWith(".lovetier.bz")
    ) {
      return "ntvs";
    }
    if (
      host.includes("matchstream") ||
      host.endsWith(".st") ||
      host.endsWith(".to") ||
      host.endsWith(".link")
    ) {
      return "matchstream";
    }
  } catch {
    // Provider inference is best effort.
  }
  return "live";
}

export function getLiveStreamSourceHost(streamOption = {}, origin = "") {
  try {
    return new URL(
      normalizePlaybackSourceValue(streamOption?.source),
      readOrigin(origin) || "http://localhost",
    ).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function getLiveStreamLabelSlot(streamOption = {}) {
  const label = String(streamOption?.label || "").trim();
  const match = /#\s*(\d+)\s*$/i.exec(label);
  return match ? match[1] : "";
}

export function getLiveSourcePreferenceKeys(streamOption = {}, origin = "") {
  const source = normalizePlaybackSourceValue(streamOption?.source);
  const provider = normalizeLiveStreamPreferenceProvider(streamOption, origin);
  const host = getLiveStreamSourceHost(streamOption, origin);
  const slot = getLiveStreamLabelSlot(streamOption);
  const keys = [];
  if (source) {
    keys.push(`source:${source}`);
  }
  if (provider && host) {
    keys.push(`host:${provider}:${host}`);
  }
  if (provider && slot) {
    keys.push(`slot:${provider}:${slot}`);
  }
  return keys;
}

export function liveStreamEntryMatchesOption(entry, streamOption) {
  const entryStreamId = String(entry?.streamId || "").trim();
  const streamId = String(streamOption?.id || "").trim();
  if (!entryStreamId || !streamId || entryStreamId !== streamId) {
    return false;
  }
  const entrySource = normalizePlaybackSourceValue(entry?.source);
  const optionSource = normalizePlaybackSourceValue(streamOption?.source);
  return !entrySource || !optionSource || entrySource === optionSource;
}

export function liveStreamCacheStorageKey(prefix, eventSlug) {
  const slug = String(eventSlug || "").trim();
  return slug ? `${prefix}${slug}` : "";
}

export function createLiveStreamCache({
  getEventSlug,
  getStreamOptions,
  isLivePlayback,
  storage = globalThis.localStorage,
  now = () => Date.now(),
  origin = "",
} = {}) {
  let failedCacheKey = "";
  let failedStatuses = new Map();
  let workingCacheKey = "";
  let workingEntry = null;
  let preferenceEntries = null;

  function currentOrigin() {
    return readOrigin(origin);
  }

  function streamOptions() {
    return Array.isArray(getStreamOptions?.()) ? getStreamOptions() : [];
  }

  function livePlaybackActive() {
    return Boolean(isLivePlayback?.());
  }

  function eventSlug() {
    return String(getEventSlug?.() || "").trim();
  }

  function failedStorageKey() {
    return liveStreamCacheStorageKey(
      LIVE_FAILED_STREAM_CACHE_STORAGE_PREFIX,
      eventSlug(),
    );
  }

  function workingStorageKey() {
    return liveStreamCacheStorageKey(
      LIVE_WORKING_STREAM_CACHE_STORAGE_PREFIX,
      eventSlug(),
    );
  }

  function getFailureEntry(streamOption, at = now()) {
    const streamId = String(streamOption?.id || "").trim();
    if (!streamId) {
      return null;
    }
    const entry = failedStatuses.get(streamId) || null;
    if (!entry || Number(entry.expiresAt || 0) <= at) {
      return null;
    }
    const optionSource = normalizePlaybackSourceValue(streamOption?.source);
    if (entry.source && optionSource && entry.source !== optionSource) {
      return null;
    }
    return entry;
  }

  function isRecentlyFailed(streamOption, at = now()) {
    return Boolean(getFailureEntry(streamOption, at));
  }

  function getOptionStatus(streamOption) {
    const entry = getFailureEntry(streamOption);
    if (!entry) {
      return null;
    }
    return {
      state: "skipped",
      label: "Skipped",
      detail: "Recently failed. Select it manually to retry.",
    };
  }

  function pruneFailureCache(at = now()) {
    let changed = false;
    const validSourcesById = new Map(
      streamOptions().map((option) => [
        option.id,
        normalizePlaybackSourceValue(option.source),
      ]),
    );
    failedStatuses.forEach((entry, streamId) => {
      const validSource = validSourcesById.get(streamId);
      if (
        !entry ||
        Number(entry.expiresAt || 0) <= at ||
        (validSource && entry.source && entry.source !== validSource)
      ) {
        failedStatuses.delete(streamId);
        changed = true;
      }
    });
    return changed;
  }

  function persistFailureCache() {
    const cacheKey = failedCacheKey || failedStorageKey();
    if (!cacheKey) {
      return;
    }
    try {
      pruneFailureCache();
      const entries = Array.from(failedStatuses.entries()).map(
        ([streamId, entry]) => ({
          streamId,
          source: entry.source,
          expiresAt: entry.expiresAt,
          reason: entry.reason || "",
        }),
      );
      if (!entries.length) {
        storage.removeItem(cacheKey);
        return;
      }
      storage.setItem(cacheKey, JSON.stringify(entries));
    } catch {
      // Skipped-source caching is a convenience only.
    }
  }

  function loadFailureCacheForCurrentEvent() {
    const cacheKey = failedStorageKey();
    if (!cacheKey || cacheKey === failedCacheKey) {
      pruneFailureCache();
      return;
    }

    failedCacheKey = cacheKey;
    failedStatuses = new Map();

    try {
      const parsed = JSON.parse(storage.getItem(cacheKey) || "[]");
      const entries = Array.isArray(parsed) ? parsed : [];
      const at = now();
      entries.forEach((entry) => {
        const streamId = String(entry?.streamId || "").trim();
        const expiresAt = Number(entry?.expiresAt || 0);
        if (!streamId || expiresAt <= at) {
          return;
        }
        failedStatuses.set(streamId, {
          source: normalizePlaybackSourceValue(entry?.source),
          expiresAt,
          reason: String(entry?.reason || "").trim(),
        });
      });
      if (pruneFailureCache(at)) {
        persistFailureCache();
      }
    } catch {
      failedStatuses = new Map();
    }
  }

  function getRememberedWorkingOption(at = now()) {
    const entry = workingEntry || null;
    if (!entry || Number(entry.expiresAt || 0) <= at) {
      return null;
    }

    const entrySource = normalizePlaybackSourceValue(entry.source);
    const options = streamOptions();
    return (
      options.find((option) => liveStreamEntryMatchesOption(entry, option)) ||
      options.find(
        (option) =>
          entrySource &&
          normalizePlaybackSourceValue(option?.source) === entrySource,
      ) ||
      null
    );
  }

  function pruneWorkingCache(at = now()) {
    if (!workingEntry) {
      return false;
    }
    const rememberedOption = getRememberedWorkingOption(at);
    if (
      !rememberedOption ||
      Number(workingEntry.expiresAt || 0) <= at ||
      isRecentlyFailed(rememberedOption, at)
    ) {
      workingEntry = null;
      return true;
    }
    return false;
  }

  function persistWorkingCache() {
    const cacheKey = workingCacheKey || workingStorageKey();
    if (!cacheKey) {
      return;
    }
    try {
      pruneWorkingCache();
      if (!workingEntry) {
        storage.removeItem(cacheKey);
        return;
      }
      storage.setItem(cacheKey, JSON.stringify(workingEntry));
    } catch {
      // Working-stream caching is a convenience only.
    }
  }

  function loadWorkingCacheForCurrentEvent() {
    const cacheKey = workingStorageKey();
    if (!cacheKey || cacheKey === workingCacheKey) {
      if (pruneWorkingCache()) {
        persistWorkingCache();
      }
      return;
    }

    workingCacheKey = cacheKey;
    workingEntry = null;

    try {
      const parsed = JSON.parse(storage.getItem(cacheKey) || "null");
      const streamId = String(parsed?.streamId || "").trim();
      const source = normalizePlaybackSourceValue(parsed?.source);
      const expiresAt = Number(parsed?.expiresAt || 0);
      if (streamId && source && expiresAt > now()) {
        workingEntry = {
          streamId,
          source,
          expiresAt,
          confirmedAt: Number(parsed?.confirmedAt || 0),
          reason: String(parsed?.reason || "").trim(),
        };
      }
      if (pruneWorkingCache()) {
        persistWorkingCache();
      }
    } catch {
      workingEntry = null;
    }
  }

  function clearSuccess(streamOption) {
    if (
      !workingEntry ||
      !liveStreamEntryMatchesOption(workingEntry, streamOption)
    ) {
      return;
    }
    workingEntry = null;
    persistWorkingCache();
  }

  function loadPreferenceEntries() {
    if (preferenceEntries instanceof Map) {
      return preferenceEntries;
    }

    preferenceEntries = new Map();
    try {
      const parsed = JSON.parse(
        storage.getItem(LIVE_SOURCE_PREFERENCE_STORAGE_KEY) || "[]",
      );
      const entries = Array.isArray(parsed) ? parsed : [];
      const at = now();
      entries.forEach((entry) => {
        const key = String(entry?.key || "").trim();
        const expiresAt = Number(entry?.expiresAt || 0);
        if (!key || expiresAt <= at) {
          return;
        }
        preferenceEntries.set(key, {
          score: Number(entry?.score || 0),
          expiresAt,
          lastSuccessAt: Number(entry?.lastSuccessAt || 0),
          lastFailureAt: Number(entry?.lastFailureAt || 0),
        });
      });
    } catch {
      preferenceEntries = new Map();
    }
    return preferenceEntries;
  }

  function persistPreferenceEntries() {
    const entries = loadPreferenceEntries();
    const at = now();
    try {
      const payload = Array.from(entries.entries())
        .filter(([, entry]) => Number(entry?.expiresAt || 0) > at)
        .map(([key, entry]) => ({
          key,
          score: Math.max(-12, Math.min(12, Number(entry?.score || 0))),
          expiresAt: Number(entry?.expiresAt || 0),
          lastSuccessAt: Number(entry?.lastSuccessAt || 0),
          lastFailureAt: Number(entry?.lastFailureAt || 0),
        }));
      if (!payload.length) {
        storage.removeItem(LIVE_SOURCE_PREFERENCE_STORAGE_KEY);
        return;
      }
      storage.setItem(
        LIVE_SOURCE_PREFERENCE_STORAGE_KEY,
        JSON.stringify(payload),
      );
    } catch {
      // Live-source preference storage is best effort.
    }
  }

  function recordPreference(streamOption, delta) {
    if (!streamOption?.source) {
      return;
    }

    const keys = getLiveSourcePreferenceKeys(streamOption, currentOrigin());
    if (!keys.length) {
      return;
    }

    const entries = loadPreferenceEntries();
    const at = now();
    const scoreDelta = Number(delta || 0);
    keys.forEach((key) => {
      const existing = entries.get(key) || {};
      const nextScore = Math.max(
        -12,
        Math.min(12, Number(existing.score || 0) + scoreDelta),
      );
      entries.set(key, {
        score: nextScore,
        expiresAt: at + LIVE_SOURCE_PREFERENCE_TTL_MS,
        lastSuccessAt:
          scoreDelta > 0 ? at : Number(existing.lastSuccessAt || 0),
        lastFailureAt:
          scoreDelta < 0 ? at : Number(existing.lastFailureAt || 0),
      });
    });
    persistPreferenceEntries();
  }

  function getPreferenceScore(streamOption) {
    const entries = loadPreferenceEntries();
    const at = now();
    return getLiveSourcePreferenceKeys(streamOption, currentOrigin()).reduce(
      (score, key) => {
        const entry = entries.get(key);
        if (!entry || Number(entry.expiresAt || 0) <= at) {
          return score;
        }
        return score + Number(entry.score || 0);
      },
      0,
    );
  }

  function getPreferredRankedOption() {
    const options = streamOptions();
    if (!livePlaybackActive() || options.length <= 1) {
      return null;
    }

    return (
      options
        .map((option, index) => ({
          option,
          index,
          score: getPreferenceScore(option),
        }))
        .filter(
          (entry) =>
            entry.option?.source &&
            entry.score > 0 &&
            !isRecentlyFailed(entry.option),
        )
        .sort((left, right) => {
          if (right.score !== left.score) {
            return right.score - left.score;
          }
          return left.index - right.index;
        })[0]?.option || null
    );
  }

  function rememberFailure(streamOption, reason = "") {
    const streamId = String(streamOption?.id || "").trim();
    const source = normalizePlaybackSourceValue(streamOption?.source);
    if (!streamId || !source) {
      return false;
    }
    if (!failedCacheKey) {
      loadFailureCacheForCurrentEvent();
    }
    clearSuccess(streamOption);
    recordPreference(streamOption, -2);
    failedStatuses.set(streamId, {
      source,
      expiresAt: now() + LIVE_FAILED_STREAM_CACHE_TTL_MS,
      reason: String(reason || "").trim(),
    });
    persistFailureCache();
    return true;
  }

  function clearFailure(streamOption) {
    const streamId = String(streamOption?.id || "").trim();
    if (!streamId) {
      return false;
    }
    if (failedStatuses.delete(streamId)) {
      persistFailureCache();
      return true;
    }
    return false;
  }

  function rememberSuccess(streamOption, reason = "") {
    const streamId = String(streamOption?.id || "").trim();
    const source = normalizePlaybackSourceValue(streamOption?.source);
    if (!streamId || !source) {
      return false;
    }
    recordPreference(streamOption, 3);
    if (!workingCacheKey) {
      loadWorkingCacheForCurrentEvent();
    }

    const at = now();
    const existing = workingEntry || null;
    const sameEntry =
      existing &&
      String(existing.streamId || "").trim() === streamId &&
      normalizePlaybackSourceValue(existing.source) === source;
    const failureRemoved =
      Boolean(getFailureEntry(streamOption, at)) &&
      failedStatuses.delete(streamId);
    if (failureRemoved) {
      persistFailureCache();
    }

    if (
      sameEntry &&
      Number(existing.expiresAt || 0) >
        at + LIVE_WORKING_STREAM_CACHE_TTL_MS / 2
    ) {
      return failureRemoved;
    }

    workingEntry = {
      streamId,
      source,
      expiresAt: at + LIVE_WORKING_STREAM_CACHE_TTL_MS,
      confirmedAt: at,
      reason: String(reason || "").trim(),
    };
    persistWorkingCache();
    return failureRemoved;
  }

  function prepareForCurrentEvent() {
    if (!livePlaybackActive()) {
      failedCacheKey = "";
      failedStatuses = new Map();
      workingCacheKey = "";
      workingEntry = null;
      return;
    }
    loadFailureCacheForCurrentEvent();
    pruneFailureCache();
    loadWorkingCacheForCurrentEvent();
    pruneWorkingCache();
  }

  return {
    isRecentlyFailed,
    getOptionStatus,
    rememberFailure,
    clearFailure,
    rememberSuccess,
    prepareForCurrentEvent,
    getRememberedWorkingOption,
    getPreferredRankedOption,
    getPreferenceScore,
  };
}

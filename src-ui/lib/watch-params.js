const SESSION_PREFIX = "watch:";
const LOCAL_PREFIX = "netflix-watch-params:";

export function slugifyTitle(title) {
  return String(title || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function buildWatchParamsStorageKey(slug, { tmdbId = "", seriesId = "" } = {}) {
  const base = `${LOCAL_PREFIX}${slug}`;
  const seriesKey = String(seriesId || "").trim().toLowerCase();
  const tmdbKey = String(tmdbId || "").trim();
  if (seriesKey) {
    return `${base}:series:${seriesKey}`;
  }
  if (tmdbKey) {
    return `${base}:tmdb:${tmdbKey}`;
  }
  return base;
}

function disambiguationFromParamsString(paramsString) {
  try {
    const params = new URLSearchParams(paramsString);
    return {
      tmdbId: params.get("tmdbId") || "",
      seriesId: params.get("seriesId") || "",
    };
  } catch {
    return { tmdbId: "", seriesId: "" };
  }
}

export function saveWatchParams(slug, paramsString, disambiguation = {}) {
  if (!slug || !paramsString) {
    return;
  }
  const resolved =
    disambiguation.tmdbId || disambiguation.seriesId
      ? disambiguation
      : disambiguationFromParamsString(paramsString);
  const storageKey = buildWatchParamsStorageKey(slug, resolved);
  try {
    localStorage.setItem(storageKey, paramsString);
    sessionStorage.setItem(`${SESSION_PREFIX}${slug}`, paramsString);
  } catch {
    // Ignore storage failures.
  }
}

export function loadWatchParams(slug) {
  if (!slug) {
    return null;
  }

  try {
    const sessionValue = sessionStorage.getItem(`${SESSION_PREFIX}${slug}`);
    if (sessionValue) {
      saveWatchParams(slug, sessionValue);
      return sessionValue;
    }
  } catch {
    // Ignore storage failures.
  }

  try {
    const exact = localStorage.getItem(`${LOCAL_PREFIX}${slug}`);
    if (exact) {
      return exact;
    }
  } catch {
    // Ignore storage failures.
  }

  try {
    const prefix = `${LOCAL_PREFIX}${slug}:`;
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) {
        continue;
      }
      const value = localStorage.getItem(key);
      if (value) {
        return value;
      }
    }
  } catch {
    // Ignore storage failures.
  }

  return null;
}

export function applyStoredParamsToSearchParams(params, stored) {
  const storedParams = new URLSearchParams(stored);
  for (const [key, value] of storedParams.entries()) {
    if (!params.has(key)) {
      params.set(key, value);
    }
  }
}

export function findSeriesEntryBySlug(slug, library) {
  const normalizedSlug = String(slug || "").trim().toLowerCase();
  if (!normalizedSlug) {
    return null;
  }
  for (const [seriesId, entry] of Object.entries(library || {})) {
    const normalizedId = String(seriesId || "").trim().toLowerCase();
    const titleSlug = slugifyTitle(entry?.title || "");
    if (normalizedId === normalizedSlug || titleSlug === normalizedSlug) {
      return { id: seriesId, entry };
    }
  }
  return null;
}

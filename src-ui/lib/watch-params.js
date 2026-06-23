const SESSION_PREFIX = "watch:";
const LOCAL_PREFIX = "streamarena-watch-params:";
const WATCH_PATH_PATTERN = /^\/watch(?:\/|$)/;

export function slugifyTitle(title) {
  return String(title || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function buildWatchUrl(params) {
  const searchParams =
    params instanceof URLSearchParams
      ? new URLSearchParams(params)
      : new URLSearchParams(params || "");
  const query = searchParams.toString();
  return query ? `/watch?${query}` : "/watch";
}

// Short, shareable, self-contained path for a TMDB catalog title. The tmdbId is
// the only thing the player needs to cold-resolve everything else (title,
// poster, year via /api/tmdb/details; audio/quality from stored prefs). The
// slug is cosmetic and ignored on parse, e.g. /watch/movie/496243/parasite or
// /watch/tv/1399/game-of-thrones/s1e5.
export function buildTmdbWatchPath({
  mediaType,
  tmdbId,
  title = "",
  seasonNumber = null,
  episodeNumber = null,
} = {}) {
  const type =
    String(mediaType || "").trim().toLowerCase() === "tv" ? "tv" : "movie";
  const id = String(tmdbId || "").trim();
  if (!id) {
    return buildWatchUrl({ title });
  }
  let path = `/watch/${type}/${id}`;
  const slug = slugifyTitle(title);
  if (slug) {
    path += `/${slug}`;
  }
  if (type === "tv") {
    const season = Math.floor(Number(seasonNumber));
    const episode = Math.floor(Number(episodeNumber));
    if (season > 0 && episode > 0) {
      path += `/s${season}e${episode}`;
    }
  }
  return path;
}

// Short path for a catalogued live channel. The channel id (e.g.
// "bloomberg-tv-us") is enough for the player to rebuild the full stream set,
// artwork and title from the live-channel catalog — no query string needed.
export function buildLiveWatchPath(channelId) {
  const id = String(channelId || "").trim();
  return id ? `/watch/live/${id}` : "/watch";
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

export function normalizeInternalReturnToPath(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) {
      return "";
    }
    if (
      WATCH_PATH_PATTERN.test(url.pathname) ||
      url.pathname === "/login" ||
      url.pathname === "/login.html"
    ) {
      return "";
    }
    return `${url.pathname || "/"}${url.search || ""}${url.hash || ""}`;
  } catch {
    return "";
  }
}

export function getCurrentReturnToPath() {
  return normalizeInternalReturnToPath(window.location.href) || "/";
}

export function addCurrentReturnToParam(params) {
  const returnTo = getCurrentReturnToPath();
  if (returnTo) {
    params.set("returnTo", returnTo);
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

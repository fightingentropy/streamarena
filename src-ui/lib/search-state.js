const SEARCH_KEYS = ["search", "q", "mediaType", "genre", "year", "personId"];
const SNAPSHOT_KEY = "streamarena-search-session-v1";
const SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const SNAPSHOT_MAX_LENGTH = 1_000_000;

export function normalizeSearchState(value = {}) {
  return {
    query: String(value.query || "").trim().slice(0, 200),
    mediaType: ["movie", "tv"].includes(value.mediaType) ? value.mediaType : "all",
    genre: String(value.genre || "").trim().slice(0, 80),
    year: String(value.year || "").replace(/\D/g, "").slice(0, 4),
    personId: /^\d{1,12}$/.test(String(value.personId || "")) ? String(value.personId) : "",
  };
}

export function readSearchLocation(href) {
  const url = new URL(href, "https://streamarena.xyz");
  const state = normalizeSearchState({ query: url.searchParams.get("q"), mediaType: url.searchParams.get("mediaType"), genre: url.searchParams.get("genre"), year: url.searchParams.get("year"), personId: url.searchParams.get("personId") });
  return { active: url.searchParams.get("search") === "1" || Boolean(state.query), state };
}

export function searchLocation(href, value, active = true) {
  const url = new URL(href, "https://streamarena.xyz");
  const state = normalizeSearchState(value);
  SEARCH_KEYS.forEach((key) => url.searchParams.delete(key));
  if (active) {
    // The search UI belongs to Home, including when opened from its Live tab.
    if (url.pathname === "/live" || url.pathname === "/live.html") url.pathname = "/";
    url.searchParams.set("search", "1");
    if (state.query) url.searchParams.set("q", state.query);
    if (state.mediaType !== "all") url.searchParams.set("mediaType", state.mediaType);
    for (const key of ["genre", "year", "personId"]) if (state[key]) url.searchParams.set(key, state[key]);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function searchStateKey(state) {
  return JSON.stringify(normalizeSearchState(state));
}

// Keep only the current tab's last search, owned by the signed-in account.
// No extra title requests are needed when returning from a long movie.
export function writeSearchSnapshot(state, data, owner, storage, now = Date.now()) {
  if (!owner || !Array.isArray(data?.results) || !Number.isInteger(data.page) || data.page < 1) return;
  try {
    const serialized = JSON.stringify({ key: searchStateKey(state), owner: String(owner), savedAt: now, data });
    if (serialized.length > SNAPSHOT_MAX_LENGTH) return;
    (storage || globalThis.sessionStorage).setItem(SNAPSHOT_KEY, serialized);
  } catch { /* Search remains usable when session storage is unavailable. */ }
}

export function readSearchSnapshot(state, owner, storage, now = Date.now()) {
  if (!owner) return null;
  try {
    const value = JSON.parse((storage || globalThis.sessionStorage).getItem(SNAPSHOT_KEY) || "null");
    if (!value || value.owner !== String(owner) || value.key !== searchStateKey(state) ||
      !Number.isFinite(value.savedAt) || now < value.savedAt || now - value.savedAt > SNAPSHOT_MAX_AGE_MS ||
      !Array.isArray(value.data?.results) || !Array.isArray(value.data?.genres) ||
      !Number.isInteger(value.data?.page) || value.data.page < 1) return null;
    return value.data;
  } catch { return null; }
}

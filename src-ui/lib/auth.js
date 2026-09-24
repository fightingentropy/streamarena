const RESUME_STORAGE_PREFIX = "streamarena-resume:";
const CONTINUE_WATCHING_META_KEY = "streamarena-continue-watching-meta";
const MY_LIST_STORAGE_KEY = "streamarena-my-list-v1";
const APP_LOCAL_STORAGE_PREFIX = "streamarena-";
const WATCH_SESSION_STORAGE_PREFIX = "watch:";
export const USER_STATE_OWNER_KEY = "streamarena-user-state-owner-v1";
export const USER_STATE_CACHED_USER_KEY = "streamarena-user-state-user-v1";
export const SERVER_HYDRATED_EVENT = "streamarena:server-hydrated";

function emptyHydrationState() {
  return {
    ok: false,
    pending: false,
    authExpired: false,
    didLoadPreferences: false,
    didLoadProgress: false,
    didLoadContinueWatching: false,
    didLoadMyList: false,
  };
}

let latestHydrationState = Object.freeze(emptyHydrationState());
let hydrationGeneration = 0;
let userStateGeneration = 0;
let activeHydration = null;

export function getHydrationState() {
  return { ...latestHydrationState };
}

export function getServerHydrationStatus() {
  const { authExpired, didLoadProgress, didLoadContinueWatching } = latestHydrationState;
  return { authExpired, didLoadProgress, didLoadContinueWatching };
}

function publishHydrationState(result) {
  latestHydrationState = Object.freeze({ ...result });
  dispatchHydratedEvent(latestHydrationState);
}

const DEPRECATED_BROWSER_PREF_KEYS = new Set([
  "streamarena-hero-trailer-muted-v2",
  "streamarena-stream-quality-pref",
  "streamarena-source-filter-allowed-formats",
  "streamarena-source-filter-results-limit",
  "streamarena-source-filter-min-seeders",
  "streamarena-source-filter-language",
  "streamarena-source-filter-audio-profile",
  "streamarena-resolver-provider",
  "streamarena-remux-video-mode",
]);

function removeStorageKeys(storage, shouldRemove) {
  if (!storage || typeof shouldRemove !== "function") {
    return;
  }
  try {
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && shouldRemove(key)) {
        keys.push(key);
      }
    }
    keys.forEach((key) => storage.removeItem(key));
  } catch {
    // Ignore storage failures.
  }
}

function getBrowserStorage(name) {
  try {
    return globalThis[name] || null;
  } catch {
    return null;
  }
}

function normalizeUserId(userOrId) {
  const raw =
    userOrId && typeof userOrId === "object"
      ? userOrId.id
      : userOrId;
  const normalized = String(raw ?? "").trim();
  return normalized && normalized !== "0" ? normalized : "";
}

function sanitizeCachedUser(user) {
  const id = normalizeUserId(user);
  if (!id || !user || typeof user !== "object") {
    return null;
  }
  return {
    id: user.id,
    email: String(user.email || ""),
    displayName: String(user.displayName || ""),
    emailVerified: Boolean(user.emailVerified),
    isAdmin: Boolean(user.isAdmin),
  };
}

function readStorageValue(storage, key) {
  try {
    return storage?.getItem(key) || "";
  } catch {
    return "";
  }
}

function writeStorageValue(storage, key, value) {
  try {
    storage?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function installUserStateOwnerGuard(expectedOwner) {
  if (
    typeof window === "undefined" ||
    typeof window.addEventListener !== "function"
  ) {
    return;
  }
  window.__streamArenaExpectedUserStateOwner = expectedOwner;
  if (window.__streamArenaUserStateOwnerGuardInstalled) {
    return;
  }
  window.__streamArenaUserStateOwnerGuardInstalled = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== USER_STATE_OWNER_KEY) return;
    const expected = String(window.__streamArenaExpectedUserStateOwner || "");
    const nextOwner = String(event.newValue || "");
    if (nextOwner === expected) return;

    // Another tab logged out or changed accounts. Do not clear here: the other
    // tab may already have populated the new owner's cache. Leave the stale UI
    // immediately so it cannot write old activity using the new shared cookie.
    delete window.__currentUser;
    window.location.href = nextOwner ? "/" : "/login.html";
  });
}

function redirectToLogin(reason = "") {
  if (typeof window === "undefined") {
    return;
  }
  const query = reason ? `?auth=${encodeURIComponent(reason)}` : "";
  window.location.href = `/login.html${query}`;
}

function dispatchHydratedEvent(result) {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") {
    return;
  }
  if (typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent(SERVER_HYDRATED_EVENT, { detail: result }));
    return;
  }
  if (typeof Event === "function") {
    const event = new Event(SERVER_HYDRATED_EVENT);
    event.detail = result;
    window.dispatchEvent(event);
  }
}

export function isAuthFailureResponse(response) {
  return response?.status === 401 || response?.status === 403;
}

export function clearUserLocalState() {
  userStateGeneration += 1;
  hydrationGeneration += 1;
  activeHydration = null;
  latestHydrationState = Object.freeze(emptyHydrationState());
  if (typeof window !== "undefined") {
    delete window.__currentUser;
  }
  removeStorageKeys(getBrowserStorage("localStorage"), (key) =>
    key.startsWith(APP_LOCAL_STORAGE_PREFIX),
  );
  removeStorageKeys(getBrowserStorage("sessionStorage"), (key) =>
    key.startsWith(WATCH_SESSION_STORAGE_PREFIX) ||
    key.startsWith(APP_LOCAL_STORAGE_PREFIX),
  );
}

/**
 * Associate the browser cache with one account. A confirmed account change, or
 * old unowned data from before this marker existed, is cleared before the new
 * account can read it. Matching-account caches remain available offline.
 */
export function establishUserLocalState(user, { clearUnowned = true } = {}) {
  const safeUser = sanitizeCachedUser(user);
  if (!safeUser) {
    return { ok: false, didClear: false, ownerChanged: false };
  }

  const storage = getBrowserStorage("localStorage");
  const nextOwner = normalizeUserId(safeUser);
  const previousOwner = readStorageValue(storage, USER_STATE_OWNER_KEY);
  const ownerChanged = Boolean(previousOwner && previousOwner !== nextOwner);
  const shouldClear = ownerChanged || (!previousOwner && clearUnowned);

  if (shouldClear) {
    clearUserLocalState();
  }

  writeStorageValue(storage, USER_STATE_OWNER_KEY, nextOwner);
  writeStorageValue(storage, USER_STATE_CACHED_USER_KEY, JSON.stringify(safeUser));
  if (typeof window !== "undefined") {
    window.__currentUser = safeUser;
  }
  installUserStateOwnerGuard(nextOwner);
  return { ok: true, didClear: shouldClear, ownerChanged };
}

export function getCachedUserForOffline() {
  const storage = getBrowserStorage("localStorage");
  const owner = readStorageValue(storage, USER_STATE_OWNER_KEY);
  const rawUser = readStorageValue(storage, USER_STATE_CACHED_USER_KEY);
  if (!owner || !rawUser) {
    return null;
  }
  try {
    const user = sanitizeCachedUser(JSON.parse(rawUser));
    return user && normalizeUserId(user) === owner ? user : null;
  } catch {
    return null;
  }
}

function activateCachedUser(cachedUser) {
  if (!cachedUser || typeof window === "undefined") return;
  window.__currentUser = cachedUser;
  installUserStateOwnerGuard(normalizeUserId(cachedUser));
}

export function handleAuthFailureResponse(response, { redirect = true } = {}) {
  if (!isAuthFailureResponse(response)) {
    return false;
  }
  clearUserLocalState();
  if (redirect) {
    redirectToLogin();
  }
  return true;
}

/** Ignore auth failures belonging to a request from a previous local session. */
export async function fetchUserApi(path, options) {
  const owner = readStorageValue(getBrowserStorage("localStorage"), USER_STATE_OWNER_KEY);
  const userId = normalizeUserId(typeof window !== "undefined" && window.__currentUser);
  const generation = userStateGeneration;
  const response = await fetch(path, options);
  if (generation === userStateGeneration &&
      owner === readStorageValue(getBrowserStorage("localStorage"), USER_STATE_OWNER_KEY) &&
      userId === normalizeUserId(typeof window !== "undefined" && window.__currentUser)) {
    handleAuthFailureResponse(response);
  }
  return response;
}

/**
 * Resolve the current session without conflating an invalid session with a
 * temporary network/server outage. A matching owner-tagged cache can be used
 * while offline, but never after a confirmed 401/403.
 */
export async function getAuthSession({ allowOffline = true, signal } = {}) {
  const owner = readStorageValue(getBrowserStorage("localStorage"), USER_STATE_OWNER_KEY);
  const generation = userStateGeneration;
  const isCurrent = () => generation === userStateGeneration &&
    owner === readStorageValue(getBrowserStorage("localStorage"), USER_STATE_OWNER_KEY);
  const superseded = () => ({ status: "superseded", user: null });
  let response;
  try {
    response = await fetch("/api/auth/me", { cache: "no-store", signal });
  } catch (error) {
    if (!isCurrent()) return superseded();
    const cachedUser = allowOffline ? getCachedUserForOffline() : null;
    activateCachedUser(cachedUser);
    return {
      status: cachedUser ? "offline" : "unavailable",
      user: cachedUser,
      error,
    };
  }

  if (!isCurrent()) return superseded();
  if (isAuthFailureResponse(response)) {
    clearUserLocalState();
    return { status: "unauthorized", user: null, response };
  }

  if (!response.ok) {
    const cachedUser = allowOffline ? getCachedUserForOffline() : null;
    activateCachedUser(cachedUser);
    return {
      status: cachedUser ? "offline" : "unavailable",
      user: cachedUser,
      response,
    };
  }

  try {
    const user = await response.json();
    if (!isCurrent()) return superseded();
    const state = establishUserLocalState(user);
    if (!state.ok) {
      throw new Error("The session response did not include a valid user.");
    }
    return { status: "authenticated", user: window.__currentUser, response };
  } catch (error) {
    if (!isCurrent()) return superseded();
    const cachedUser = allowOffline ? getCachedUserForOffline() : null;
    activateCachedUser(cachedUser);
    return {
      status: cachedUser ? "offline" : "unavailable",
      user: cachedUser,
      response,
      error,
    };
  }
}

/**
 * Check if user is logged in. A confirmed auth failure redirects to login;
 * temporary outages can continue with a matching owner-tagged offline cache.
 */
export async function requireAuth() {
  const session = await getAuthSession();
  if (session.user) {
    return session.user;
  }
  if (session.status === "unauthorized") {
    redirectToLogin();
    return new Promise(() => {});
  }
  throw new Error("Unable to verify your session right now.");
}

/**
 * Get current user without redirecting. Returns null if not logged in or no
 * verified/cached account is available.
 */
export async function getCurrentUser() {
  if (typeof window !== "undefined" && window.__currentUser) {
    return window.__currentUser;
  }
  const session = await getAuthSession();
  return session.user || null;
}

/**
 * Sign out only after the server confirms that the HttpOnly session cookie was
 * invalidated. Redirecting after a failed logout would let that cookie sign the
 * browser straight back in.
 */
export async function signOut() {
  let response;
  try {
    response = await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    console.warn("Unable to sign out while the server is unavailable.");
    return false;
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    console.warn(
      payload?.error || payload?.message || `Unable to sign out (${response.status}).`,
    );
    return false;
  }
  clearUserLocalState();
  redirectToLogin();
  return true;
}

// Bound the whole response, including its body, so a stalled noncritical
// endpoint cannot leave Home in a permanent hydration/loading state.
async function fetchHydrationEndpoint(path) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(path, { cache: "no-store", signal: controller.signal });
        const payload = response?.ok ? await response.json() : null;
        return { response, payload };
      })(),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, 8000);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function hydrationEntries(payload) {
  return Array.isArray(payload?.entries) ? payload.entries : Array.isArray(payload) ? payload : [];
}

/**
 * Start all account reads together. Home waits only for preferences; the player
 * still awaits complete hydration before deciding whether/how far to resume.
 * Every response is scoped to the validated owner and this hydration generation.
 */
export function beginServerHydration() {
  const currentUser = (typeof window !== "undefined" && window.__currentUser) || getCachedUserForOffline();
  const owner = normalizeUserId(currentUser);
  const storage = getBrowserStorage("localStorage");
  const result = emptyHydrationState();
  if (!owner || readStorageValue(storage, USER_STATE_OWNER_KEY) !== owner) {
    const complete = Promise.resolve(result);
    return { preferencesReady: complete, myListReady: complete, progressReady: complete, continueWatchingReady: complete, complete };
  }
  if (activeHydration?.owner === owner && activeHydration.generation === hydrationGeneration) {
    return activeHydration;
  }

  const generation = ++hydrationGeneration;
  const stillOwnsState = () =>
    generation === hydrationGeneration && readStorageValue(storage, USER_STATE_OWNER_KEY) === owner;
  result.pending = true;
  publishHydrationState(result);
  let progressEntries = [];
  let continueEntries = [];
  const initialList = storage.getItem(MY_LIST_STORAGE_KEY);
  const initialContinue = storage.getItem(CONTINUE_WATCHING_META_KEY);
  const expectedResumes = new Map();
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(RESUME_STORAGE_PREFIX)) expectedResumes.set(key, storage.getItem(key));
  }
  function applyResume(sourceIdentity, resumeSeconds) {
    const key = `${RESUME_STORAGE_PREFIX}${sourceIdentity}`;
    // Another tab or a Home action may save/delete progress while the GET is
    // pending. A snapshot taken before that action must not undo it.
    if (storage.getItem(key) !== (expectedResumes.get(key) ?? null)) return;
    const value = String(resumeSeconds);
    storage.setItem(key, value);
    expectedResumes.set(key, value);
  }

  function applyResumes() {
    const sources = new Set();
    for (const entry of progressEntries) {
      if (entry.sourceIdentity && entry.resumeSeconds > 0) {
        sources.add(entry.sourceIdentity);
        applyResume(entry.sourceIdentity, entry.resumeSeconds);
      }
    }
    for (const entry of continueEntries) {
      if (!entry.sourceIdentity) continue;
      sources.add(entry.sourceIdentity);
      if (entry.resumeSeconds > 0) {
        applyResume(entry.sourceIdentity, entry.resumeSeconds);
      }
    }
    if (result.didLoadProgress && result.didLoadContinueWatching) {
      for (const [key, expected] of expectedResumes) {
        if (!sources.has(key.slice(RESUME_STORAGE_PREFIX.length)) && storage.getItem(key) === expected) {
          storage.removeItem(key);
          expectedResumes.set(key, null);
        }
      }
    }
  }

  async function hydrateEndpoint(path, flag, apply) {
    const data = await fetchHydrationEndpoint(path);
    if (!stillOwnsState()) return { ...result };
    if (isAuthFailureResponse(data?.response)) {
      result.authExpired = true;
      result.pending = false;
      clearUserLocalState();
      publishHydrationState(result);
      redirectToLogin();
      return { ...result };
    }
    if (data?.response?.ok) {
      try {
        result[flag] = apply(data.payload) !== false;
        if (result[flag] && (flag === "didLoadProgress" || flag === "didLoadContinueWatching")) applyResumes();
      } catch {
        // Preserve any remaining matching-account cache on storage/JSON failure.
        result[flag] = false;
      }
    }
    if (stillOwnsState()) publishHydrationState(result);
    return { ...result };
  }

  const preferencesReady = hydrateEndpoint("/api/user/preferences", "didLoadPreferences", (prefs) => {
    if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) throw new Error("Invalid preferences");
    for (const [key, value] of Object.entries(prefs)) {
      if (DEPRECATED_BROWSER_PREF_KEYS.has(key)) storage.removeItem(key);
      else storage.setItem(key, String(value));
    }
  });
  const progressReady = hydrateEndpoint("/api/user/watch-progress", "didLoadProgress", (payload) => {
    progressEntries = hydrationEntries(payload);
  });
  const continueReady = hydrateEndpoint("/api/user/continue-watching", "didLoadContinueWatching", (payload) => {
    if (storage.getItem(CONTINUE_WATCHING_META_KEY) !== initialContinue) return false;
    continueEntries = hydrationEntries(payload);
    const metaMap = {};
    for (const entry of continueEntries) {
      if (entry.sourceIdentity) metaMap[entry.sourceIdentity] = entry;
    }
    if (Object.keys(metaMap).length) storage.setItem(CONTINUE_WATCHING_META_KEY, JSON.stringify(metaMap));
    else storage.removeItem(CONTINUE_WATCHING_META_KEY);
  });
  const listReady = hydrateEndpoint("/api/user/my-list", "didLoadMyList", (payload) => {
    if (storage.getItem(MY_LIST_STORAGE_KEY) !== initialList) return false;
    const entries = hydrationEntries(payload);
    if (entries.length) storage.setItem(MY_LIST_STORAGE_KEY, JSON.stringify(entries));
    else storage.removeItem(MY_LIST_STORAGE_KEY);
  });
  const complete = Promise.all([preferencesReady, progressReady, continueReady, listReady]).then(() => {
    result.pending = false;
    result.ok = !result.authExpired && result.didLoadPreferences && result.didLoadProgress && result.didLoadContinueWatching && result.didLoadMyList;
    if (stillOwnsState()) {
      publishHydrationState(result);
      activeHydration = null;
    }
    return { ...result };
  });
  activeHydration = { owner, generation, preferencesReady, progressReady, continueWatchingReady: continueReady, myListReady: listReady, complete };
  return activeHydration;
}

/** Await complete server state for pages whose initial behavior depends on it. */
export async function hydrateFromServer() {
  return beginServerHydration().complete;
}

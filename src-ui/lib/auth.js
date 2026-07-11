const RESUME_STORAGE_PREFIX = "streamarena-resume:";
const CONTINUE_WATCHING_META_KEY = "streamarena-continue-watching-meta";
const MY_LIST_STORAGE_KEY = "streamarena-my-list-v1";
const APP_LOCAL_STORAGE_PREFIX = "streamarena-";
const WATCH_SESSION_STORAGE_PREFIX = "watch:";
export const USER_STATE_OWNER_KEY = "streamarena-user-state-owner-v1";
export const USER_STATE_CACHED_USER_KEY = "streamarena-user-state-user-v1";
export const SERVER_HYDRATED_EVENT = "streamarena:server-hydrated";

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

/**
 * Resolve the current session without conflating an invalid session with a
 * temporary network/server outage. A matching owner-tagged cache can be used
 * while offline, but never after a confirmed 401/403.
 */
export async function getAuthSession({ allowOffline = true, signal } = {}) {
  let response;
  try {
    response = await fetch("/api/auth/me", { cache: "no-store", signal });
  } catch (error) {
    const cachedUser = allowOffline ? getCachedUserForOffline() : null;
    activateCachedUser(cachedUser);
    return {
      status: cachedUser ? "offline" : "unavailable",
      user: cachedUser,
      error,
    };
  }

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
    const state = establishUserLocalState(user);
    if (!state.ok) {
      throw new Error("The session response did not include a valid user.");
    }
    return { status: "authenticated", user: window.__currentUser, response };
  } catch (error) {
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

function pruneLocalResumeKeys(serverResumeSources) {
  if (!(serverResumeSources instanceof Set)) return;
  const storage = getBrowserStorage("localStorage");
  if (!storage) return;
  const keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(RESUME_STORAGE_PREFIX)) {
      keys.push(key);
    }
  }
  keys.forEach((key) => {
    const sourceIdentity = key.slice(RESUME_STORAGE_PREFIX.length);
    if (!serverResumeSources.has(sourceIdentity)) {
      storage.removeItem(key);
    }
  });
}

async function fetchHydrationEndpoint(path) {
  try {
    return await fetch(path, { cache: "no-store" });
  } catch {
    return null;
  }
}

/**
 * Hydrate localStorage from server data on page load. Successful server
 * responses replace their corresponding local cache. Failed network/5xx
 * responses leave the matching account's cache intact for offline use.
 */
export async function hydrateFromServer() {
  const result = {
    ok: false,
    authExpired: false,
    didLoadPreferences: false,
    didLoadProgress: false,
    didLoadContinueWatching: false,
    didLoadMyList: false,
  };
  try {
    const currentUser =
      (typeof window !== "undefined" && window.__currentUser) ||
      getCachedUserForOffline();
    const hydrationOwner = normalizeUserId(currentUser);
    const initialStorage = getBrowserStorage("localStorage");
    if (
      !hydrationOwner ||
      readStorageValue(initialStorage, USER_STATE_OWNER_KEY) !== hydrationOwner
    ) {
      return result;
    }

    const [prefsRes, progressRes, continueRes, listRes] = await Promise.all([
      fetchHydrationEndpoint("/api/user/preferences"),
      fetchHydrationEndpoint("/api/user/watch-progress"),
      fetchHydrationEndpoint("/api/user/continue-watching"),
      fetchHydrationEndpoint("/api/user/my-list"),
    ]);
    const responses = [prefsRes, progressRes, continueRes, listRes];

    if (responses.some(isAuthFailureResponse)) {
      result.authExpired = true;
      clearUserLocalState();
      redirectToLogin();
      return result;
    }

    const storage = getBrowserStorage("localStorage");
    if (!storage) {
      return result;
    }
    const stillOwnsHydrationState = () =>
      readStorageValue(storage, USER_STATE_OWNER_KEY) === hydrationOwner;
    if (!stillOwnsHydrationState()) {
      return result;
    }

    if (prefsRes?.ok) {
      result.didLoadPreferences = true;
      const prefs = await prefsRes.json();
      if (!stillOwnsHydrationState()) return result;
      if (prefs && typeof prefs === "object") {
        for (const [key, value] of Object.entries(prefs)) {
          if (DEPRECATED_BROWSER_PREF_KEYS.has(key)) {
            storage.removeItem(key);
            continue;
          }
          storage.setItem(key, String(value));
        }
      }
    }

    const serverResumeSources = new Set();
    const didLoadProgress = Boolean(progressRes?.ok);
    const didLoadContinueWatching = Boolean(continueRes?.ok);
    result.didLoadProgress = didLoadProgress;
    result.didLoadContinueWatching = didLoadContinueWatching;

    if (didLoadProgress) {
      const progress = await progressRes.json();
      if (!stillOwnsHydrationState()) return result;
      const progressEntries = Array.isArray(progress?.entries)
        ? progress.entries
        : Array.isArray(progress)
          ? progress
          : [];
      for (const entry of progressEntries) {
        if (entry.sourceIdentity && entry.resumeSeconds > 0) {
          serverResumeSources.add(entry.sourceIdentity);
          storage.setItem(
            `${RESUME_STORAGE_PREFIX}${entry.sourceIdentity}`,
            String(entry.resumeSeconds),
          );
        }
      }
    }

    if (didLoadContinueWatching) {
      const continueData = await continueRes.json();
      if (!stillOwnsHydrationState()) return result;
      const continueEntries = Array.isArray(continueData?.entries)
        ? continueData.entries
        : Array.isArray(continueData)
          ? continueData
          : [];
      const metaMap = {};
      for (const entry of continueEntries) {
        if (entry.sourceIdentity) {
          serverResumeSources.add(entry.sourceIdentity);
          metaMap[entry.sourceIdentity] = entry;
          if (entry.resumeSeconds > 0) {
            storage.setItem(
              `${RESUME_STORAGE_PREFIX}${entry.sourceIdentity}`,
              String(entry.resumeSeconds),
            );
          }
        }
      }
      if (Object.keys(metaMap).length > 0) {
        storage.setItem(CONTINUE_WATCHING_META_KEY, JSON.stringify(metaMap));
      } else {
        storage.removeItem(CONTINUE_WATCHING_META_KEY);
      }
    }

    if (didLoadProgress && didLoadContinueWatching) {
      pruneLocalResumeKeys(serverResumeSources);
    }

    if (listRes?.ok) {
      result.didLoadMyList = true;
      const list = await listRes.json();
      if (!stillOwnsHydrationState()) return result;
      const listEntries = Array.isArray(list?.entries)
        ? list.entries
        : Array.isArray(list)
          ? list
          : [];
      if (listEntries.length > 0) {
        storage.setItem(MY_LIST_STORAGE_KEY, JSON.stringify(listEntries));
      } else {
        storage.removeItem(MY_LIST_STORAGE_KEY);
      }
    }
    result.ok = responses.every((response) => response?.ok);
  } catch {
    // Malformed or temporarily unavailable server data: retain this account's
    // owner-tagged browser cache instead of treating it as an auth failure.
  } finally {
    dispatchHydratedEvent(result);
  }
  return result;
}

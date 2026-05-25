/**
 * Check if user is logged in. If not, redirect to /login.
 * Returns the user object {id, username, displayName} on success.
 */
export async function requireAuth() {
  try {
    const res = await fetch("/api/auth/me");
    if (res.ok) {
      const user = await res.json();
      window.__currentUser = user;
      return user;
    }
  } catch {}
  window.location.href = "/login.html";
  return new Promise(() => {}); // Never resolves — prevents page from continuing
}

/**
 * Get current user without redirecting. Returns null if not logged in.
 */
export async function getCurrentUser() {
  if (window.__currentUser) return window.__currentUser;
  try {
    const res = await fetch("/api/auth/me");
    if (res.ok) {
      const user = await res.json();
      window.__currentUser = user;
      return user;
    }
  } catch {}
  return null;
}

/**
 * Sign out — delete session and redirect to login.
 */
export async function signOut() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {}
  window.location.href = "/login.html";
}

const RESUME_STORAGE_PREFIX = "netflix-resume:";
const CONTINUE_WATCHING_META_KEY = "netflix-continue-watching-meta";
const MY_LIST_STORAGE_KEY = "netflix-my-list-v1";
export const SERVER_HYDRATED_EVENT = "netflix:server-hydrated";
const DEPRECATED_BROWSER_PREF_KEYS = new Set([
  "netflix-hero-trailer-muted-v2",
  "netflix-source-filter-allowed-formats",
  "netflix-source-filter-results-limit",
  "netflix-source-filter-min-seeders",
  "netflix-source-filter-language",
  "netflix-source-filter-audio-profile",
  "netflix-resolver-provider",
  "netflix-remux-video-mode",
]);

function pruneLocalResumeKeys(serverResumeSources) {
  if (!(serverResumeSources instanceof Set)) return;
  const keys = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(RESUME_STORAGE_PREFIX)) {
      keys.push(key);
    }
  }
  keys.forEach((key) => {
    const sourceIdentity = key.slice(RESUME_STORAGE_PREFIX.length);
    if (!serverResumeSources.has(sourceIdentity)) {
      localStorage.removeItem(key);
    }
  });
}

/**
 * Hydrate localStorage from server data on page load.
 * Server is the source of truth; this replaces the local cache.
 */
export async function hydrateFromServer() {
  const result = {
    ok: false,
    didLoadProgress: false,
    didLoadContinueWatching: false,
    didLoadMyList: false,
  };
  try {
    const [prefsRes, progressRes, continueRes, listRes] = await Promise.all([
      fetch("/api/user/preferences"),
      fetch("/api/user/watch-progress"),
      fetch("/api/user/continue-watching"),
      fetch("/api/user/my-list"),
    ]);

    if (prefsRes.ok) {
      const prefs = await prefsRes.json();
      if (prefs && typeof prefs === "object") {
        for (const [key, value] of Object.entries(prefs)) {
          if (DEPRECATED_BROWSER_PREF_KEYS.has(key)) {
            localStorage.removeItem(key);
            continue;
          }
          localStorage.setItem(key, String(value));
        }
      }
    }

    const serverResumeSources = new Set();
    const didLoadProgress = progressRes.ok;
    const didLoadContinueWatching = continueRes.ok;
    result.didLoadProgress = didLoadProgress;
    result.didLoadContinueWatching = didLoadContinueWatching;

    if (didLoadProgress) {
      const progress = await progressRes.json();
      const progressEntries = Array.isArray(progress?.entries)
        ? progress.entries
        : Array.isArray(progress)
          ? progress
          : [];
      for (const entry of progressEntries) {
        if (entry.sourceIdentity && entry.resumeSeconds > 0) {
          serverResumeSources.add(entry.sourceIdentity);
          localStorage.setItem(`${RESUME_STORAGE_PREFIX}${entry.sourceIdentity}`, String(entry.resumeSeconds));
        }
      }
    }

    if (didLoadContinueWatching) {
      const continueData = await continueRes.json();
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
            localStorage.setItem(`${RESUME_STORAGE_PREFIX}${entry.sourceIdentity}`, String(entry.resumeSeconds));
          }
        }
      }
      if (Object.keys(metaMap).length > 0) {
        localStorage.setItem(CONTINUE_WATCHING_META_KEY, JSON.stringify(metaMap));
      } else {
        localStorage.removeItem(CONTINUE_WATCHING_META_KEY);
      }
    }

    if (didLoadProgress && didLoadContinueWatching) {
      pruneLocalResumeKeys(serverResumeSources);
    }

    if (listRes.ok) {
      result.didLoadMyList = true;
      const list = await listRes.json();
      const listEntries = Array.isArray(list?.entries)
        ? list.entries
        : Array.isArray(list)
          ? list
          : [];
      if (listEntries.length > 0) {
        localStorage.setItem(MY_LIST_STORAGE_KEY, JSON.stringify(listEntries));
      } else {
        localStorage.removeItem(MY_LIST_STORAGE_KEY);
      }
    }
    result.ok = true;
  } catch {
    // Offline or server error — use existing localStorage data
  } finally {
    window.dispatchEvent(new CustomEvent(SERVER_HYDRATED_EVENT, { detail: result }));
  }
  return result;
}

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

/**
 * Hydrate localStorage from server data on page load.
 * Server is the source of truth; this populates the local cache.
 */
export async function hydrateFromServer() {
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
          localStorage.setItem(key, String(value));
        }
      }
    }

    if (progressRes.ok) {
      const progress = await progressRes.json();
      const progressEntries = Array.isArray(progress?.entries)
        ? progress.entries
        : Array.isArray(progress)
          ? progress
          : [];
      for (const entry of progressEntries) {
        if (entry.sourceIdentity && entry.resumeSeconds > 0) {
          localStorage.setItem(`netflix-resume:${entry.sourceIdentity}`, String(entry.resumeSeconds));
        }
      }
    }

    if (continueRes.ok) {
      const continueData = await continueRes.json();
      const continueEntries = Array.isArray(continueData?.entries)
        ? continueData.entries
        : Array.isArray(continueData)
          ? continueData
          : [];
      if (continueEntries.length > 0) {
        const metaMap = {};
        for (const entry of continueEntries) {
          if (entry.sourceIdentity) {
            metaMap[entry.sourceIdentity] = entry;
            if (entry.resumeSeconds > 0) {
              localStorage.setItem(`netflix-resume:${entry.sourceIdentity}`, String(entry.resumeSeconds));
            }
          }
        }
        localStorage.setItem("netflix-continue-watching-meta", JSON.stringify(metaMap));
      }
    }

    if (listRes.ok) {
      const list = await listRes.json();
      const listEntries = Array.isArray(list?.entries)
        ? list.entries
        : Array.isArray(list)
          ? list
          : [];
      if (listEntries.length > 0) {
        localStorage.setItem("netflix-my-list-v1", JSON.stringify(listEntries));
      }
    }
  } catch {
    // Offline or server error — use existing localStorage data
  }
}

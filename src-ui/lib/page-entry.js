import { beginServerHydration, getAuthSession, getCachedUserForOffline, getHydrationState, hydrateFromServer } from "./auth.js";
import { initEmailVerificationBanner } from "./email-verification-banner.js";
import { mountPage } from "./mount-page.js";
import { migrateLegacyStorageKeys } from "./storage-migration.js";

async function loadPageComponent(loadPage) {
  const pageModule = typeof loadPage === "function" ? await loadPage() : loadPage;
  return pageModule?.default || pageModule;
}

export async function mountAuthenticatedPage(loadPage, options = {}) {
  // Rebrand storage migration must run before any page module loads and reads
  // its keys, and before hydrateFromServer writes them back.
  migrateLegacyStorageKeys();
  // Download the page module and check auth in parallel for speed, but do not
  // mount protected UI (or run its data fetches) until auth and account-backed
  // browser preferences are settled.
  const componentPromise = loadPageComponent(loadPage);
  const session = await getAuthSession();
  if (session.status === "superseded") return;

  if (session.status === "unauthorized") {
    window.location.href = "/login.html";
    return;
  }
  if (!session.user) {
    // A network/5xx failure is not proof that the session is invalid. Keep any
    // owner-tagged state intact and let the login page explain the temporary
    // verification failure instead of deleting it as though this were a 401.
    window.location.href = "/login.html?auth=unavailable";
    return;
  }

  if (session.status === "authenticated") {
    const hydration = options.deferHydration
      ? await beginServerHydration().preferencesReady
      : await hydrateFromServer();
    if (hydration.authExpired) {
      return;
    }
  }

  const component = await componentPromise;
  // A background response or another tab can invalidate/change the account
  // while the page module downloads. Never mount that stale account's UI.
  const cachedUser = getCachedUserForOffline();
  if (getHydrationState().authExpired ||
      String(window.__currentUser?.id || "") !== String(session.user.id) ||
      (cachedUser && String(cachedUser.id) !== String(session.user.id))) return;
  mountPage(component, options);
  initEmailVerificationBanner(session.user);
}

export async function mountPublicPage(loadPage, options = {}) {
  migrateLegacyStorageKeys();
  mountPage(await loadPageComponent(loadPage), options);
}

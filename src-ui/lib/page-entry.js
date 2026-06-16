import { hydrateFromServer } from "./auth.js";
import { initEmailVerificationBanner } from "./email-verification-banner.js";
import { renderLegacyMovedNotice } from "./moved-banner.js";
import { mountPage } from "./mount-page.js";
import { migrateLegacyStorageKeys } from "./storage-migration.js";

async function loadPageComponent(loadPage) {
  const pageModule = typeof loadPage === "function" ? await loadPage() : loadPage;
  return pageModule?.default || pageModule;
}

export async function mountAuthenticatedPage(loadPage, options = {}) {
  // Legacy domain (streamthatshit.com): show only the "we moved" notice — do
  // not boot the app, hit /api/auth/me, or stream anything.
  if (renderLegacyMovedNotice()) return;
  // Rebrand storage migration must run before any page module loads and reads
  // its keys, and before hydrateFromServer writes them back.
  migrateLegacyStorageKeys();
  // Download the page module and check auth in parallel for speed, but do not
  // mount protected UI (or run its data fetches) until auth is confirmed.
  const componentPromise = loadPageComponent(loadPage);
  const user = await fetch("/api/auth/me")
    .then(async (response) => (response.ok ? await response.json() : null))
    .catch(() => null);

  if (!user) {
    window.location.href = "/login.html";
    return;
  }
  window.__currentUser = user;

  mountPage(await componentPromise, options);

  void hydrateFromServer();
  initEmailVerificationBanner(user);
}

export async function mountPublicPage(loadPage, options = {}) {
  if (renderLegacyMovedNotice()) return;
  migrateLegacyStorageKeys();
  mountPage(await loadPageComponent(loadPage), options);
}

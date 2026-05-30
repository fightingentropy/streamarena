import { hydrateFromServer } from "./auth.js";
import { mountPage } from "./mount-page.js";

async function loadPageComponent(loadPage) {
  const pageModule = typeof loadPage === "function" ? await loadPage() : loadPage;
  return pageModule?.default || pageModule;
}

export async function mountAuthenticatedPage(loadPage, options = {}) {
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
}

export async function mountPublicPage(loadPage, options = {}) {
  mountPage(await loadPageComponent(loadPage), options);
}

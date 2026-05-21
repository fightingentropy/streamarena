import { hydrateFromServer, requireAuth } from "./auth.js";
import { mountPage } from "./mount-page.js";

async function loadPageComponent(loadPage) {
  const pageModule = typeof loadPage === "function" ? await loadPage() : loadPage;
  return pageModule?.default || pageModule;
}

export async function mountAuthenticatedPage(loadPage, options = {}) {
  await requireAuth();
  await hydrateFromServer();
  mountPage(await loadPageComponent(loadPage), options);
}

export async function mountPublicPage(loadPage, options = {}) {
  mountPage(await loadPageComponent(loadPage), options);
}

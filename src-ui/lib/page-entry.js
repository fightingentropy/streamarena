import { hydrateFromServer } from "./auth.js";
import { mountPage } from "./mount-page.js";

async function loadPageComponent(loadPage) {
  const pageModule = typeof loadPage === "function" ? await loadPage() : loadPage;
  return pageModule?.default || pageModule;
}

export async function mountAuthenticatedPage(loadPage, options = {}) {
  const authPromise = fetch("/api/auth/me")
    .then(async (response) => {
      if (!response.ok) {
        return null;
      }
      const user = await response.json();
      window.__currentUser = user;
      return user;
    })
    .catch(() => null);

  mountPage(await loadPageComponent(loadPage), options);

  void hydrateFromServer();

  const user = await authPromise;
  if (!user) {
    window.location.href = "/login.html";
  }
}

export async function mountPublicPage(loadPage, options = {}) {
  mountPage(await loadPageComponent(loadPage), options);
}

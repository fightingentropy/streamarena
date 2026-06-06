import "../../style.css";

import { mountAuthenticatedPage } from "../lib/page-entry.js";

const homeBootstrapFetchTimeoutMs = 2500;

window.__HOME_BOOTSTRAP_PROMISE__ = (() => {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    homeBootstrapFetchTimeoutMs,
  );
  return fetch("/api/home/bootstrap", { signal: controller.signal })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null)
    .finally(() => window.clearTimeout(timeout));
})();

await mountAuthenticatedPage(() => import("../pages/home.jsx"));

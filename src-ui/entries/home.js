import "../../style.css";

import { mountAuthenticatedPage } from "../lib/page-entry.js";
import { loadLiveChannelOverrides } from "../lib/live-channels.js";

// The home page surfaces a live rail; apply admin URL overrides early.
loadLiveChannelOverrides();

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

import "../../style.css";
import "../../browse.css";

import { mountAuthenticatedPage } from "../lib/page-entry.js";
import { loadInitialHomeBootstrap } from "../lib/home-bootstrap.js";
import { loadLiveChannelOverrides } from "../lib/live-channels.js";

// The home page surfaces a live rail; apply admin URL overrides early.
loadLiveChannelOverrides();

window.__HOME_BOOTSTRAP_PROMISE__ = loadInitialHomeBootstrap();

await mountAuthenticatedPage(() => import("../pages/home.jsx"), { deferHydration: true });

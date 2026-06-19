import "../../style.css";
import "../../live.css";

import { mountAuthenticatedPage } from "../lib/page-entry.js";
import { loadLiveChannelOverrides } from "../lib/live-channels.js";

// Pull admin URL overrides early so channel links use the swapped sources.
loadLiveChannelOverrides();

await mountAuthenticatedPage(() => import("../pages/live.jsx"), {
  bodyClass: "live-route",
});

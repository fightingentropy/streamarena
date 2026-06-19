import "../../player.css";

import { mountAuthenticatedPage } from "../lib/page-entry.js";
import { loadLiveChannelOverrides } from "../lib/live-channels.js";

// Apply admin URL overrides to the live-channel resume fallbacks.
loadLiveChannelOverrides();

await mountAuthenticatedPage(() => import("../pages/player.js"));

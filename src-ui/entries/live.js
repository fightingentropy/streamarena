import "../../style.css";
import "../../live.css";

import { requireAuth, hydrateFromServer } from "../lib/auth.js";

await requireAuth();
await hydrateFromServer();

const { mountPage } = await import("../lib/mount-page.js");
const { default: LivePage } = await import("../pages/live.js");

mountPage(LivePage, { bodyClass: "live-route" });

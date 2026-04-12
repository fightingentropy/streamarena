import "../../player.css";

import { requireAuth, hydrateFromServer } from "../lib/auth.js";

await requireAuth();
hydrateFromServer();

const { mountPage } = await import("../lib/mount-page.js");
const { default: PlayerPage } = await import("../pages/player.js");

mountPage(PlayerPage);

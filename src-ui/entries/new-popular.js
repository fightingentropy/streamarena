import "../../style.css";
import "../../new-popular.css";

import { requireAuth, hydrateFromServer } from "../lib/auth.js";

await requireAuth();
await hydrateFromServer();

const { mountPage } = await import("../lib/mount-page.js");
const { default: NewPopularPage } = await import("../pages/new-popular.js");

mountPage(NewPopularPage, { bodyClass: "new-popular-route" });

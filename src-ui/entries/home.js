import "../../style.css";

import { requireAuth, hydrateFromServer } from "../lib/auth.js";

await requireAuth();
hydrateFromServer();

const { mountPage } = await import("../lib/mount-page.js");
const { default: HomePage } = await import("../pages/home.js");

mountPage(HomePage);

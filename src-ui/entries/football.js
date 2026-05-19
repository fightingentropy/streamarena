import "../../style.css";
import "../../football.css";

import { requireAuth, hydrateFromServer } from "../lib/auth.js";

await requireAuth();
await hydrateFromServer();

const { mountPage } = await import("../lib/mount-page.js");
const { default: FootballPage } = await import("../pages/football.js");

mountPage(FootballPage, { bodyClass: "football-route" });

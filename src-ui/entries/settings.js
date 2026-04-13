import "../../settings.css";

import { requireAuth, hydrateFromServer } from "../lib/auth.js";

await requireAuth();
await hydrateFromServer();

const { mountPage } = await import("../lib/mount-page.js");
const { default: SettingsPage } = await import("../pages/settings.js");

mountPage(SettingsPage);

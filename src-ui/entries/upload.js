import "../../upload.css";

import { requireAuth, hydrateFromServer } from "../lib/auth.js";

await requireAuth();
hydrateFromServer();

const { mountPage } = await import("../lib/mount-page.js");
const { default: UploadPage } = await import("../pages/upload.js");

mountPage(UploadPage);

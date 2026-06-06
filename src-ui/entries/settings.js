import "../../settings.css";

import { mountAuthenticatedPage } from "../lib/page-entry.js";

await mountAuthenticatedPage(() => import("../pages/settings.jsx"));

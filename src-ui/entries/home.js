import "../../style.css";

import { mountAuthenticatedPage } from "../lib/page-entry.js";

await mountAuthenticatedPage(() => import("../pages/home.js"));

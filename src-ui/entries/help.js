import "../../help.css";

import { mountPublicPage } from "../lib/page-entry.js";

await mountPublicPage(() => import("../pages/help.jsx"));

import "../../login.css";

import { mountPublicPage } from "../lib/page-entry.js";

await mountPublicPage(() => import("../pages/login.jsx"));

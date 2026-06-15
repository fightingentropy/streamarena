import "../../help.css";
import "../../legal.css";

import { mountPublicPage } from "../lib/page-entry.js";

await mountPublicPage(() => import("../pages/legal.jsx"));

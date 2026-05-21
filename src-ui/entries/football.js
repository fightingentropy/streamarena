import "../../style.css";
import "../../football.css";

import { mountAuthenticatedPage } from "../lib/page-entry.js";

await mountAuthenticatedPage(() => import("../pages/football.js"), {
  bodyClass: "football-route",
});

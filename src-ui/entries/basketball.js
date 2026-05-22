import "../../style.css";
import "../../football.css";

import { mountAuthenticatedPage } from "../lib/page-entry.js";

await mountAuthenticatedPage(() => import("../pages/basketball.js"), {
  bodyClass: "football-route basketball-route",
});

import "../../style.css";
import "../../sports.css";

import { mountAuthenticatedPage } from "../lib/page-entry.js";

await mountAuthenticatedPage(() => import("../pages/sports.jsx"), {
  bodyClass: "sports-route",
});

import "../../style.css";
import "../../live.css";

import { mountAuthenticatedPage } from "../lib/page-entry.js";

await mountAuthenticatedPage(() => import("../pages/live.jsx"), {
  bodyClass: "live-route",
});

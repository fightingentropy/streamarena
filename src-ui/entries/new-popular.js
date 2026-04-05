import "../../style.css";
import "../../new-popular.css";

import { mountPage } from "../lib/mount-page.js";
import NewPopularPage from "../pages/new-popular.js";

mountPage(NewPopularPage, { bodyClass: "new-popular-route" });
queueMicrotask(() => {
  void import("../../new-popular.js");
});

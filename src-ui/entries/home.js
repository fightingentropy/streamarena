import "../../style.css";

import { mountPage } from "../lib/mount-page.js";
import HomePage from "../pages/home.js";

mountPage(HomePage);
queueMicrotask(() => {
  void import("../../script.js");
});

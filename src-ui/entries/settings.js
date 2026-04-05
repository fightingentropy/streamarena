import "../../settings.css";

import { mountPage } from "../lib/mount-page.js";
import SettingsPage from "../pages/settings.js";

mountPage(SettingsPage);
queueMicrotask(() => {
  void import("../../settings.js");
});

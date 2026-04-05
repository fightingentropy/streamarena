import "../../player.css";

import { mountPage } from "../lib/mount-page.js";
import PlayerPage from "../pages/player.js";

mountPage(PlayerPage);
queueMicrotask(() => {
  void import("../../player.js");
});

import "../../upload.css";

import { mountPage } from "../lib/mount-page.js";
import UploadPage from "../pages/upload.js";

mountPage(UploadPage);
queueMicrotask(() => {
  void import("../../upload.js");
});

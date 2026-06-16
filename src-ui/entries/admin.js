import "../../admin.css";

import { render } from "solid-js/web";

import { renderLegacyMovedNotice } from "../lib/moved-banner.js";
import AdminPage from "../pages/admin.jsx";

// Legacy domain (streamthatshit.com): show only the "we moved" notice and stop.
// This entry mounts directly (it does not go through page-entry.js), so the
// guard has to be repeated here — otherwise the admin dashboard would keep
// booting and live-fetching on the flagged old domain.
if (!renderLegacyMovedNotice()) {
  // Admin is gated server-side — every /api/admin/* call requires an admin
  // session — but we also check here so anonymous visitors go straight to login
  // and signed-in non-admins get a clean "access denied" view instead of a wall
  // of failed requests.
  const user = await fetch("/api/auth/me")
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);

  if (!user) {
    window.location.href = "/login.html";
  } else {
    window.__currentUser = user;
    document.body.className = "admin-body";
    render(AdminPage, document.body);
  }
}

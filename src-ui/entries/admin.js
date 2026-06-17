import "../../admin.css";

import { render } from "solid-js/web";

import AdminPage from "../pages/admin.jsx";

// Admin is gated server-side — the page shell requires a session and every
// /api/admin/* call requires an admin session — but we also check here so
// anonymous visitors go straight to login and signed-in non-admins get a clean
// "access denied" view instead of a wall of failed requests.
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

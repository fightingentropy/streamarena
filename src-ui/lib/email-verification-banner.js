// Soft email-verification UI (Spotify-style): a dismissable nudge for users who
// haven't confirmed their email yet, plus a transient notice when the user
// returns from clicking a verification link (?verified=success|expired|invalid).
//
// Framework-free so it can run on any authenticated page from the shared
// page-entry hook. Styling lives in the sibling stylesheet, which Vite bundles
// into the page's same-origin CSS <link>; injecting a <style> element from JS
// would be blocked by the strict `style-src 'self'` CSP.
import "./email-verification-banner.css";

const VERIFIED_NOTICES = {
  success: { text: "Email verified — you're all set.", tone: "success" },
  expired: { text: "That verification link expired. We can send you a new one.", tone: "error" },
  invalid: { text: "That verification link is invalid or has already been used.", tone: "error" },
};

export function initEmailVerificationBanner(user) {
  // 1) Surface the outcome of a verification link the user just clicked.
  showVerifiedNoticeFromUrl();
  // 2) Nudge users whose email is still unconfirmed.
  if (user && user.emailVerified === false) {
    showVerifyBanner(user);
  }
}

function showVerifiedNoticeFromUrl() {
  let params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return;
  }
  const status = params.get("verified");
  if (!status) return;

  // Strip the param so a refresh or share doesn't re-trigger the notice.
  params.delete("verified");
  const query = params.toString();
  const cleanUrl =
    window.location.pathname + (query ? `?${query}` : "") + window.location.hash;
  try {
    window.history.replaceState({}, "", cleanUrl);
  } catch {}

  if (status === "success" && window.__currentUser) {
    window.__currentUser.emailVerified = true;
  }
  const notice = VERIFIED_NOTICES[status] || VERIFIED_NOTICES.invalid;
  showToast(notice.text, notice.tone);
}

function showToast(text, tone) {
  const toast = document.createElement("div");
  toast.className = `email-verify-toast email-verify-toast--${tone}`;
  toast.setAttribute("role", "status");
  toast.textContent = text;
  document.body.appendChild(toast);
  window.setTimeout(() => toast.remove(), 6000);
}

function showVerifyBanner(user) {
  if (document.querySelector(".email-verify-banner")) return;

  const banner = document.createElement("div");
  banner.className = "email-verify-banner";
  banner.setAttribute("role", "status");

  const body = document.createElement("div");
  body.className = "email-verify-banner__body";
  const title = document.createElement("p");
  title.className = "email-verify-banner__title";
  title.textContent = "Verify your email";
  const text = document.createElement("p");
  text.className = "email-verify-banner__text";
  text.textContent = user.email
    ? `We sent a confirmation link to ${user.email}.`
    : "We sent you a confirmation link.";
  body.append(title, text);

  const actions = document.createElement("div");
  actions.className = "email-verify-banner__actions";
  const resend = document.createElement("button");
  resend.type = "button";
  resend.className = "email-verify-banner__btn email-verify-banner__btn--primary";
  resend.textContent = "Resend email";
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "email-verify-banner__btn email-verify-banner__btn--ghost";
  dismiss.textContent = "Dismiss";
  actions.append(resend, dismiss);

  banner.append(body, actions);
  document.body.appendChild(banner);

  dismiss.addEventListener("click", () => banner.remove());
  resend.addEventListener("click", async () => {
    resend.disabled = true;
    resend.textContent = "Sending…";
    try {
      const res = await fetch("/api/auth/resend-verification", { method: "POST" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      resend.textContent = "Sent ✓";
      window.setTimeout(() => banner.remove(), 2000);
    } catch {
      resend.disabled = false;
      resend.textContent = "Try again";
    }
  });
}

// Soft email-verification UI (Spotify-style): a dismissable nudge for users who
// haven't confirmed their email yet, plus a transient notice when the user
// returns from clicking a verification link (?verified=success|expired|invalid).
//
// Self-contained and framework-free so it can run on any authenticated page from
// the shared page-entry hook. Styles are injected once and use the app's design
// tokens with hard fallbacks (some pages don't load style.css).

const STYLE_ELEMENT_ID = "email-verify-styles";

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

function ensureStyles() {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = `
.email-verify-banner,
.email-verify-toast {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  z-index: 9000;
  max-width: min(640px, calc(100vw - 32px));
  background: #1f1f1f;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-left: 4px solid var(--netflix-red, #e50914);
  border-radius: 8px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
  color: var(--text, #f6f6f6);
  font-family: var(--font-netflix-sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  animation: email-verify-rise 0.25s ease;
}
.email-verify-banner {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 18px;
}
.email-verify-toast {
  padding: 12px 20px;
  font-size: 14px;
  font-weight: 600;
}
.email-verify-toast--success { border-left-color: #2ecc71; }
@keyframes email-verify-rise {
  from { opacity: 0; transform: translate(-50%, 12px); }
  to { opacity: 1; transform: translateX(-50%); }
}
.email-verify-banner__body { flex: 1; min-width: 0; }
.email-verify-banner__title { font-weight: 700; font-size: 14px; margin: 0 0 2px; }
.email-verify-banner__text { font-size: 13px; color: var(--muted, #c9c9c9); margin: 0; word-break: break-word; }
.email-verify-banner__actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.email-verify-banner__btn {
  border: none;
  border-radius: 4px;
  padding: 8px 14px;
  font: inherit;
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
}
.email-verify-banner__btn--primary { background: var(--netflix-red, #e50914); color: #fff; }
.email-verify-banner__btn--primary:disabled { opacity: 0.6; cursor: default; }
.email-verify-banner__btn--ghost { background: transparent; color: var(--muted, #c9c9c9); }
.email-verify-banner__btn--ghost:hover { color: var(--text, #f6f6f6); }
`;
  document.head.appendChild(style);
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
  ensureStyles();
  const toast = document.createElement("div");
  toast.className = `email-verify-toast email-verify-toast--${tone}`;
  toast.setAttribute("role", "status");
  toast.textContent = text;
  document.body.appendChild(toast);
  window.setTimeout(() => toast.remove(), 6000);
}

function showVerifyBanner(user) {
  if (document.querySelector(".email-verify-banner")) return;
  ensureStyles();

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

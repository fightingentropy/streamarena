import { createSignal, Show } from "solid-js";

// The reset link is path-based: /reset-password/<token>. Read the token from
// the address bar (the page is served for any /reset-password/* path).
function tokenFromPath() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  const idx = parts.indexOf("reset-password");
  return idx >= 0 && parts[idx + 1] ? decodeURIComponent(parts[idx + 1]) : "";
}

export default function ResetPasswordPage() {
  const token = tokenFromPath();
  const [error, setError] = createSignal(
    token ? "" : "This reset link is incomplete. Request a new one from the sign-in page.",
  );
  const [submitting, setSubmitting] = createSignal(false);
  const [done, setDone] = createSignal(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    const form = e.target;
    const password = form.password.value;
    const confirm = form.confirm.value;

    if (!token) {
      setError("This reset link is incomplete. Request a new one from the sign-in page.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      setDone(true);
      window.setTimeout(() => {
        window.location.href = "/login.html";
      }, 2200);
    } catch (err) {
      setError(err.message || "Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return <><div data-solid-page-root="" class="solid-page-root">
    <main class="login-page">
      <div class="login-card">
        <a href="/" class="login-logo">
          <img src="/assets/icons/streamarena-mark.svg" alt="StreamArena" />
        </a>
        <h1>Reset password</h1>
        <Show
          when={done()}
          fallback={
            <>
              <form class="login-form" onSubmit={handleSubmit}>
                <p class="login-sub">Choose a new password for your account.</p>
                <div class="login-field">
                  <label for="password">New password</label>
                  <input
                    id="password"
                    name="password"
                    type="password"
                    autocomplete="new-password"
                    required
                  />
                </div>
                <div class="login-field">
                  <label for="confirm">Confirm password</label>
                  <input
                    id="confirm"
                    name="confirm"
                    type="password"
                    autocomplete="new-password"
                    required
                  />
                </div>
                <p class="login-error" hidden={!error()}>{error()}</p>
                <button class="login-btn" type="submit" disabled={submitting()}>
                  Update password
                </button>
              </form>
              <p class="login-toggle">
                <a class="login-toggle-btn" href="/login.html">Back to sign in</a>
              </p>
            </>
          }
        >
          <p class="login-notice">Your password has been updated. Redirecting you to sign in…</p>
          <p class="login-toggle">
            <a class="login-toggle-btn" href="/login.html">Go to sign in now</a>
          </p>
        </Show>
      </div>
    </main>
  </div></>;
}

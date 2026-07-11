import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { establishUserLocalState, getAuthSession } from "../lib/auth.js";

export default function LoginPage() {
  const [isSignUp, setIsSignUp] = createSignal(false);
  const [forgot, setForgot] = createSignal(false);
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  let authCheckController = null;

  // If already authenticated, redirect to home
  onMount(() => {
    authCheckController = new AbortController();
    void getAuthSession({
      allowOffline: false,
      signal: authCheckController.signal,
    })
      .then((session) => {
        if (authCheckController?.signal.aborted) return;
        if (session.status === "authenticated") {
          window.location.href = "/";
          return;
        }
        if (session.status === "unavailable") {
          setNotice("We couldn't verify your session right now. You can try signing in again.");
        }
      })
      .catch(() => {});
  });
  onCleanup(() => authCheckController?.abort());

  function toggleMode() {
    setIsSignUp((prev) => !prev);
    setForgot(false);
    setError("");
    setNotice("");
  }

  function showForgot() {
    setForgot(true);
    setIsSignUp(false);
    setError("");
    setNotice("");
  }

  function backToSignIn() {
    setForgot(false);
    setError("");
    setNotice("");
  }

  async function handleForgot(e) {
    e.preventDefault();
    setError("");
    setNotice("");
    const email = e.target.email.value.trim();
    if (!email) {
      setError("Please enter your email.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      setNotice(
        "If an account exists for that email, a password-reset link is on its way. Check your inbox.",
      );
    } catch (err) {
      setError(err.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    authCheckController?.abort();
    setError("");
    setSubmitting(true);

    const form = e.target;
    const email = form.email.value.trim();
    const password = form.password.value;
    const displayName = form.displayName?.value.trim() || "";

    if (!email || !password || (isSignUp() && !displayName)) {
      setError("Please fill in all fields.");
      setSubmitting(false);
      return;
    }

    try {
      const endpoint = isSignUp() ? "/api/auth/signup" : "/api/auth/login";
      const payload = isSignUp()
        ? { email, password, displayName }
        : { email, password };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || data.message || `Request failed (${res.status})`);
      }

      const localState = establishUserLocalState(data.user);
      if (!localState.ok) {
        throw new Error("Sign-in succeeded, but the account response was invalid. Please reload.");
      }
      window.location.href = "/";
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
        <h1>{forgot() ? "Reset password" : isSignUp() ? "Create Account" : "Sign In"}</h1>
        <form class="login-form" onSubmit={forgot() ? handleForgot : handleSubmit}>
          <p class="login-sub" hidden={!forgot()}>
            Enter your account email and we'll send you a link to set a new password.
          </p>
          <div class="login-field" hidden={!isSignUp() || forgot()}>
            <label for="displayName">Display name</label>
            <input
              id="displayName"
              name="displayName"
              type="text"
              autocomplete="name"
              required={isSignUp() && !forgot()}
            />
          </div>
          <div class="login-field">
            <label for="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autocomplete="email"
              required
            />
          </div>
          <div class="login-field" hidden={forgot()}>
            <label for="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autocomplete={isSignUp() ? "new-password" : "current-password"}
              required={!forgot()}
            />
          </div>
          <p class="login-forgot" hidden={isSignUp() || forgot()}>
            <button class="login-toggle-btn" type="button" onClick={showForgot}>
              Forgot password?
            </button>
          </p>
          <p class="login-notice" hidden={!notice()}>
            {notice()}
          </p>
          <p class="login-error" hidden={!error()}>
            {error()}
          </p>
          <button class="login-btn" type="submit" disabled={submitting()}>
            {forgot() ? "Send reset link" : isSignUp() ? "Create Account" : "Sign In"}
          </button>
        </form>
        <p class="login-toggle">
          <Show
            when={forgot()}
            fallback={
              <>
                <span>{isSignUp() ? "Already have an account?" : "New here?"}</span>{" "}
                <button class="login-toggle-btn" type="button" onClick={toggleMode}>
                  {isSignUp() ? "Sign in" : "Create account"}
                </button>
              </>
            }
          >
            <button class="login-toggle-btn" type="button" onClick={backToSignIn}>
              Back to sign in
            </button>
          </Show>
        </p>
      </div>
    </main>
  </div></>;
}

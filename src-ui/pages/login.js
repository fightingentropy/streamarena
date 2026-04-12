import html from "solid-js/html";
import { createSignal } from "solid-js";

// ─── Migrate localStorage data to server ───

async function migrateLocalStorageToServer() {
  const preferences = {};
  const PREF_KEYS = [
    "netflix-stream-quality-pref",
    "netflix-default-audio-lang",
    "netflix-subtitle-color-pref",
    "netflix-profile-avatar-style",
    "netflix-profile-avatar-mode",
    "netflix-profile-avatar-image",
    "netflix-source-filter-min-seeders",
    "netflix-source-filter-language",
    "netflix-source-filter-audio-profile",
    "netflix-remux-video-mode",
    "netflix-hero-trailer-muted-v2",
  ];
  for (const key of PREF_KEYS) {
    const val = localStorage.getItem(key);
    if (val !== null) preferences[key] = val;
  }

  const watchProgress = {};
  const continueWatching = {};
  try {
    const metaRaw = localStorage.getItem("netflix-continue-watching-meta");
    if (metaRaw) Object.assign(continueWatching, JSON.parse(metaRaw));
  } catch {}

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith("netflix-resume:")) {
      const id = key.slice("netflix-resume:".length);
      const val = Number(localStorage.getItem(key));
      if (id && Number.isFinite(val) && val > 0) watchProgress[id] = val;
    }
  }

  let myList = [];
  try {
    myList = JSON.parse(localStorage.getItem("netflix-my-list-v1") || "[]");
  } catch {}

  const hasData =
    Object.keys(preferences).length > 0 ||
    Object.keys(watchProgress).length > 0 ||
    Object.keys(continueWatching).length > 0 ||
    myList.length > 0;
  if (!hasData) return;

  await fetch("/api/user/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preferences, watchProgress, continueWatching, myList }),
  });
}

export default function LoginPage() {
  const [isSignUp, setIsSignUp] = createSignal(false);
  const [error, setError] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);

  // If already authenticated, redirect to home
  fetch("/api/auth/me")
    .then((res) => {
      if (res.ok) window.location.href = "/";
    })
    .catch(() => {});

  function toggleMode() {
    setIsSignUp((prev) => !prev);
    setError("");
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);

    const form = e.target;
    const username = form.username.value.trim();
    const password = form.password.value;

    if (!username || !password) {
      setError("Please fill in all fields.");
      setSubmitting(false);
      return;
    }

    try {
      const endpoint = isSignUp() ? "/api/auth/signup" : "/api/auth/login";
      const payload = isSignUp()
        ? { username, password, displayName: form.displayName?.value.trim() || username }
        : { username, password };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || data.message || `Request failed (${res.status})`);
      }

      await migrateLocalStorageToServer();
      window.location.href = "/";
    } catch (err) {
      setError(err.message || "Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return html`<div data-solid-page-root="" style="display: contents">
    <main class="login-page">
      <div class="login-card">
        <a href="/" class="login-logo">
          <img src="assets/icons/netflix-n.svg" alt="Netflix" />
        </a>
        <h1>${() => (isSignUp() ? "Create Account" : "Sign In")}</h1>
        <form class="login-form" onSubmit=${handleSubmit}>
          <div
            class="login-field"
            style=${() => (isSignUp() ? "" : "display:none")}
          >
            <label for="displayName">Display name</label>
            <input
              id="displayName"
              name="displayName"
              type="text"
              autocomplete="name"
              required=${() => isSignUp()}
            />
          </div>
          <div class="login-field">
            <label for="username">Username</label>
            <input
              id="username"
              name="username"
              type="text"
              autocomplete="username"
              required
            />
          </div>
          <div class="login-field">
            <label for="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autocomplete=${() =>
                isSignUp() ? "new-password" : "current-password"}
              required
            />
          </div>
          <p
            class="login-error"
            style=${() => (error() ? "" : "display:none")}
          >
            ${() => error()}
          </p>
          <button
            class="login-btn"
            type="submit"
            disabled=${() => submitting()}
          >
            ${() => (isSignUp() ? "Create Account" : "Sign In")}
          </button>
        </form>
        <p class="login-toggle">
          <span>${() => (isSignUp() ? "Already have an account?" : "New here?")}</span>
          <button
            class="login-toggle-btn"
            type="button"
            onClick=${toggleMode}
          >
            ${() => (isSignUp() ? "Sign in" : "Create account")}
          </button>
        </p>
      </div>
    </main>
  </div>`;
}

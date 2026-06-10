import { createSignal, onMount } from "solid-js";

// ─── Migrate localStorage data to server ───

async function migrateLocalStorageToServer() {
  const preferences = {};
  const PREF_KEYS = [
    "netflix-default-audio-lang",
    "netflix-subtitle-color-pref",
    "netflix-profile-avatar-style",
    "netflix-profile-avatar-mode",
    "netflix-profile-avatar-image",
  ];
  for (const key of PREF_KEYS) {
    const val = localStorage.getItem(key);
    if (val !== null) preferences[key] = val;
  }

  const watchProgress = [];
  const continueWatching = [];
  try {
    const metaRaw = localStorage.getItem("netflix-continue-watching-meta");
    if (metaRaw) {
      const parsed = JSON.parse(metaRaw);
      const entries = Array.isArray(parsed)
        ? parsed
        : Object.entries(parsed || {}).map(([sourceIdentity, entry]) => ({
            ...(entry && typeof entry === "object" ? entry : {}),
            sourceIdentity:
              String(entry?.sourceIdentity || "").trim() || sourceIdentity,
            resumeSeconds:
              Number(entry?.resumeSeconds ?? entry) > 0
                ? Number(entry?.resumeSeconds ?? entry)
                : Number(localStorage.getItem(`netflix-resume:${sourceIdentity}`) || 0),
          }));
      continueWatching.push(
        ...entries.filter((entry) => String(entry?.sourceIdentity || "").trim()),
      );
    }
  } catch {}

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith("netflix-resume:")) {
      const id = key.slice("netflix-resume:".length);
      const val = Number(localStorage.getItem(key));
      if (id && Number.isFinite(val) && val > 0) {
        watchProgress.push({
          sourceIdentity: id,
          resumeSeconds: val,
          updatedAt: Date.now(),
        });
      }
    }
  }

  let myList = [];
  try {
    myList = JSON.parse(localStorage.getItem("netflix-my-list-v1") || "[]");
  } catch {}

  const hasData =
    Object.keys(preferences).length > 0 ||
    watchProgress.length > 0 ||
    continueWatching.length > 0 ||
    myList.length > 0;
  if (!hasData) return;

  const syncRes = await fetch("/api/user/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preferences, watchProgress, continueWatching, myList }),
  });
  if (!syncRes.ok) {
    console.warn("Failed to sync local data to server:", syncRes.status);
  }
}

export default function LoginPage() {
  const [isSignUp, setIsSignUp] = createSignal(false);
  const [error, setError] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);

  // If already authenticated, redirect to home
  onMount(() => {
    void fetch("/api/auth/me")
      .then((res) => {
        if (res.ok) window.location.href = "/";
      })
      .catch(() => {});
  });

  function toggleMode() {
    setIsSignUp((prev) => !prev);
    setError("");
  }

  async function handleSubmit(e) {
    e.preventDefault();
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

  return <><div data-solid-page-root="" class="solid-page-root">
    <main class="login-page">
      <div class="login-card">
        <a href="/" class="login-logo">
          <img src="/assets/icons/netflix-n.svg" alt="Netflix" />
        </a>
        <h1>{(isSignUp() ? "Create Account" : "Sign In")}</h1>
        <form class="login-form" onSubmit={handleSubmit}>
          <div
            class="login-field"
            hidden={!isSignUp()}
          >
            <label for="displayName">Display name</label>
            <input
              id="displayName"
              name="displayName"
              type="text"
              autocomplete="name"
              required={isSignUp()}
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
          <div class="login-field">
            <label for="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autocomplete={isSignUp() ? "new-password" : "current-password"}
              required
            />
          </div>
          <p
            class="login-error"
            hidden={!error()}
          >
            {error()}
          </p>
          <button
            class="login-btn"
            type="submit"
            disabled={submitting()}
          >
            {(isSignUp() ? "Create Account" : "Sign In")}
          </button>
        </form>
        <p class="login-toggle">
          <span>{(isSignUp() ? "Already have an account?" : "New here?")}</span>
          <button
            class="login-toggle-btn"
            type="button"
            onClick={toggleMode}
          >
            {(isSignUp() ? "Sign in" : "Create account")}
          </button>
        </p>
      </div>
    </main>
  </div></>;
}

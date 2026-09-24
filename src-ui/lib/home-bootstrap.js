// Read the HTML snapshot before starting any optional network refresh.
export function readInjectedHomeBootstrap() {
  if (window.__HOME_BOOTSTRAP__ && typeof window.__HOME_BOOTSTRAP__ === "object") {
    return window.__HOME_BOOTSTRAP__;
  }
  const json = document.getElementById("home-bootstrap")?.textContent || "";
  try {
    const payload = JSON.parse(json);
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      window.__HOME_BOOTSTRAP__ = payload;
      return payload;
    }
  } catch {
    // An absent or invalid snapshot falls back to the bootstrap endpoint.
  }
  return null;
}

export function loadInitialHomeBootstrap() {
  const snapshot = readInjectedHomeBootstrap();
  if (snapshot && snapshot._meta?.status !== "warming") {
    return Promise.resolve(snapshot);
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 2500);
  return fetch("/api/home/bootstrap", { signal: controller.signal })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null)
    .finally(() => window.clearTimeout(timeout));
}

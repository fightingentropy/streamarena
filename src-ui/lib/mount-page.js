import { render } from "solid-js/web";

export function mountPage(Page, options = {}) {
  document.body.className = options.bodyClass || "";
  render(Page, document.body);
  registerServiceWorker();
}

function registerServiceWorker() {
  if (
    window.__netflixServiceWorkerRegistered ||
    !("serviceWorker" in navigator) ||
    !isServiceWorkerSafeOrigin()
  ) {
    return;
  }
  window.__netflixServiceWorkerRegistered = true;
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
}

function isServiceWorkerSafeOrigin() {
  return (
    window.location.protocol === "https:" ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
  );
}

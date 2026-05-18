import { render } from "solid-js/web";

import { wireBrowseNavMore } from "./browse-nav-more.js";

export function mountPage(Page, options = {}) {
  document.body.className = options.bodyClass || "";
  render(Page, document.body);
  queueMicrotask(() => {
    wireBrowseNavMore();
  });
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
  const register = () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  };
  if (document.readyState === "complete") {
    register();
  } else {
    window.addEventListener("load", register, { once: true });
  }
}

function isServiceWorkerSafeOrigin() {
  return (
    window.location.protocol === "https:" ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
  );
}

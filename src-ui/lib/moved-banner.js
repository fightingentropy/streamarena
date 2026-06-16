// "We've moved" notice, shown only when the app is served from the legacy
// domain (streamthatshit.com). It points users at the new home, streamarena.xyz,
// and reassures them their account carries over — both hosts are the same
// backend and the same account database, so the email + password are identical.
//
// Framework-free so it runs from the shared page-entry hook on every page.
// Styling lives in the sibling stylesheet, which Vite bundles into the page's
// same-origin CSS <link>; injecting a <style> from JS would be blocked by the
// strict `style-src 'self'` CSP.
import "./moved-banner.css";

const LEGACY_HOST = "streamthatshit.com";
const NEW_HOST = "streamarena.xyz";
const NEW_ORIGIN = "https://streamarena.xyz";
const DISMISS_KEY = "streamarena-moved-banner-dismissed";

function isLegacyHost() {
  let host;
  try {
    host = window.location.hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === LEGACY_HOST || host.endsWith(`.${LEGACY_HOST}`);
}

function newSiteUrl() {
  const { pathname, search, hash } = window.location;
  return `${NEW_ORIGIN}${pathname}${search}${hash}`;
}

function isDismissed() {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function initMovedBanner() {
  if (!isLegacyHost() || isDismissed()) return;
  if (document.querySelector(".moved-banner")) return;

  const banner = document.createElement("div");
  banner.className = "moved-banner";
  banner.setAttribute("role", "region");
  banner.setAttribute("aria-label", "Site moved notice");

  const body = document.createElement("div");
  body.className = "moved-banner__body";
  const title = document.createElement("p");
  title.className = "moved-banner__title";
  title.textContent = "StreamArena has a new address";
  const text = document.createElement("p");
  text.className = "moved-banner__text";
  text.textContent = `We've moved to ${NEW_HOST}. Sign in there with the same email and password — your account, watchlist, and history are all there.`;
  body.append(title, text);

  const actions = document.createElement("div");
  actions.className = "moved-banner__actions";
  const go = document.createElement("a");
  go.className = "moved-banner__btn";
  go.href = newSiteUrl();
  go.textContent = `Go to ${NEW_HOST}`;
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "moved-banner__dismiss";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.textContent = "×";
  actions.append(go, dismiss);

  banner.append(body, actions);

  const mount = () => {
    if (document.body) document.body.appendChild(banner);
  };
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });

  dismiss.addEventListener("click", () => {
    banner.remove();
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {}
  });
}

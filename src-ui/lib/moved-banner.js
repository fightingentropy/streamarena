// Legacy-domain "we moved" interstitial. When the app is served from the old
// domain (streamthatshit.com) we do NOT boot the streaming UI at all — we
// replace the page with a full-screen "we moved to streamarena.xyz" notice and
// signal the page-entry hook to stop. Both hosts are the same backend and the
// same account database, so the email + password carry over unchanged.
//
// Framework-free so it runs from the shared page-entry hook on every page.
// Styling lives in the sibling stylesheet, which Vite bundles into the page's
// same-origin CSS <link>; injecting a <style> from JS would be blocked by the
// strict `style-src 'self'` CSP.
import "./moved-banner.css";

const LEGACY_HOST = "streamthatshit.com";
const NEW_HOST = "streamarena.xyz";
const NEW_ORIGIN = "https://streamarena.xyz";

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

function buildNotice() {
  const page = document.createElement("div");
  page.className = "moved-page";
  page.setAttribute("role", "region");
  page.setAttribute("aria-label", "Site moved notice");

  const card = document.createElement("div");
  card.className = "moved-page__card";

  const brand = document.createElement("div");
  brand.className = "moved-page__brand";
  brand.textContent = "StreamArena";

  const title = document.createElement("h1");
  title.className = "moved-page__title";
  title.textContent = "We've moved";

  const text = document.createElement("p");
  text.className = "moved-page__text";
  text.textContent = `StreamArena now lives at ${NEW_HOST}. Sign in there with the same email and password — your account, watchlist, and history are all there.`;

  const go = document.createElement("a");
  go.className = "moved-page__btn";
  go.href = newSiteUrl();
  go.textContent = `Go to ${NEW_HOST}`;

  card.append(brand, title, text, go);
  page.append(card);
  return page;
}

// If we're on the legacy host, take over the whole page with the moved notice
// and return `true` so the caller skips mounting the app (no auth fetch, no
// data fetches, no streaming). Returns `false` on the live domain — the caller
// proceeds normally.
export function renderLegacyMovedNotice() {
  if (!isLegacyHost()) return false;

  const mount = () => {
    try {
      document.title = `StreamArena has moved to ${NEW_HOST}`;
    } catch {}
    document.documentElement.classList.add("moved-page-active");
    if (document.querySelector(".moved-page")) return;
    document.body.replaceChildren(buildNotice());
  };
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
  return true;
}

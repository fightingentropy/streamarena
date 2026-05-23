import html from "solid-js/html";
import { createSignal, onCleanup, onMount } from "solid-js";
import {
  normalizeAvatarStyle,
  normalizeAvatarMode,
  sanitizeAvatarImageData,
  getStoredAvatarStylePreference,
  getStoredAvatarModePreference,
  getStoredAvatarImagePreference,
} from "../shared.js";
import SportsScheduleView from "../components/sports-schedule-view.js";
import { signOut } from "../lib/auth.js";
import { liveNavClass, sportsNavClass } from "../lib/browse-nav.js";

export default function SportsPage() {
  const [accountMenuOpen, setAccountMenuOpen] = createSignal(false);
  const [avatarClass, setAvatarClass] = createSignal("avatar avatar-style-blue");
  const [avatarCustomStyle, setAvatarCustomStyle] = createSignal("");
  const displayName = window.__currentUser?.displayName || "Account";
  let accountMenuEl;

  function applyAvatarStyle(style, mode, imageData) {
    const normalizedStyle = normalizeAvatarStyle(style);
    const normalizedMode = normalizeAvatarMode(mode);
    const safeImage = sanitizeAvatarImageData(imageData);

    if (normalizedMode === "custom" && safeImage) {
      setAvatarClass("avatar avatar-custom-image");
      setAvatarCustomStyle(
        `--avatar-image: url("${safeImage}"); background-image: var(--avatar-image)`,
      );
      return;
    }

    setAvatarClass(`avatar avatar-style-${normalizedStyle}`);
    setAvatarCustomStyle("");
  }

  function toggleAccountMenu(event) {
    event.stopPropagation();
    setAccountMenuOpen((previous) => !previous);
  }

  function closeAccountMenu() {
    setAccountMenuOpen(false);
  }

  function handleDocumentClick(event) {
    if (accountMenuEl && !accountMenuEl.contains(event.target)) {
      closeAccountMenu();
    }
  }

  function handleDocumentKeydown(event) {
    if (event.key === "Escape") {
      closeAccountMenu();
    }
  }

  async function handleSignOut(event) {
    event.preventDefault();
    await signOut();
  }

  onMount(() => {
    applyAvatarStyle(
      getStoredAvatarStylePreference(),
      getStoredAvatarModePreference(),
      getStoredAvatarImagePreference(),
    );
    document.addEventListener("click", handleDocumentClick);
    document.addEventListener("keydown", handleDocumentKeydown);
  });

  onCleanup(() => {
    document.removeEventListener("click", handleDocumentClick);
    document.removeEventListener("keydown", handleDocumentKeydown);
  });

  return html`
    <div data-solid-page-root="" style="display: contents">
      <div class="page home-page sports-page" tabindex="0">
        <header class="top-nav">
          <div class="nav-left">
            <a href="/" class="nav-logo" aria-label="Go to homepage">
              <img
                src="assets/icons/netflix-logo-clean.png"
                class="logo-wordmark-image"
                alt="Netflix"
              />
            </a>
            <nav>
              <a href="/">Home</a>
              <a href="/live" class=${liveNavClass("")}>Live</a>
              <a href="/sports" class=${sportsNavClass("sports")}>Sports</a>
              <a href="/#myListRow" class="optional">My List</a>
            </nav>
          </div>
          <div class="nav-right">
            <button
              class="icon-btn"
              aria-label="Search"
              aria-expanded="false"
              onClick=${() => {
                window.location.href = "/";
              }}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M14.33 12.9 19.71 18.28a1 1 0 0 1-1.42 1.42l-5.38-5.38a8 8 0 1 1 1.42-1.42Zm-6.33 1.1a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z"></path>
              </svg>
            </button>
            <a href="#" class="kids">Kids</a>
            <button class="icon-btn notification-btn" type="button" aria-label="Notifications">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 22a2.6 2.6 0 0 0 2.45-1.72h-4.9A2.6 2.6 0 0 0 12 22Zm7.1-5.2-1.45-1.84V10a5.68 5.68 0 0 0-4.48-5.56V3a1.17 1.17 0 1 0-2.34 0v1.44A5.68 5.68 0 0 0 6.35 10v4.96L4.9 16.8a1 1 0 0 0 .78 1.62h12.64a1 1 0 0 0 .78-1.62Z"></path>
              </svg>
            </button>
            <div class="account-menu" ref=${(el) => { accountMenuEl = el; }}>
              <button
                class="account-avatar-btn"
                aria-label="Account menu"
                aria-haspopup="menu"
                aria-controls="accountMenuPanel"
                aria-expanded=${() => (accountMenuOpen() ? "true" : "false")}
                onClick=${toggleAccountMenu}
              >
                <div
                  class=${() => avatarClass()}
                  style=${() => avatarCustomStyle()}
                  aria-hidden="true"
                ></div>
              </button>
              <button
                class="icon-btn account-menu-toggle"
                aria-label="Account menu"
                aria-haspopup="menu"
                aria-expanded=${() => (accountMenuOpen() ? "true" : "false")}
                onClick=${toggleAccountMenu}
              >
                <svg viewBox="0 0 12 8" aria-hidden="true">
                  <path
                    d="M1 1.5 6 6.5l5-5"
                    stroke="currentColor"
                    stroke-width="1.8"
                    fill="none"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  ></path>
                </svg>
              </button>
              <div
                id="accountMenuPanel"
                class="account-menu-panel"
                role="menu"
                style=${() => (accountMenuOpen() ? "" : "display:none")}
              >
                <a
                  class="account-menu-item account-menu-item--muted"
                  href="#"
                  role="menuitem"
                  tabindex="-1"
                >${displayName}</a>
                <a class="account-menu-item" href="/settings" role="menuitem">Upload Media</a>
                <a class="account-menu-item" href="/settings" role="menuitem">Settings</a>
                <a
                  class="account-menu-item"
                  href="#"
                  role="menuitem"
                  onClick=${handleSignOut}
                >Sign Out</a>
              </div>
            </div>
          </div>
        </header>

        <${SportsScheduleView} />
      </div>
    </div>
  `;
}

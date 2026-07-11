import { createSignal, onCleanup, onMount } from "solid-js";
import {
  normalizeAvatarStyle,
  normalizeAvatarMode,
  sanitizeAvatarImageData,
  getStoredAvatarStylePreference,
  getStoredAvatarModePreference,
  getStoredAvatarImagePreference,
} from "../shared.js";
import LiveChannelsView from "../components/live-channels-view.jsx";
import FeedbackNav from "../components/feedback-nav.jsx";
import BrandWordmark from "../components/brand-wordmark.jsx";
import { signOut } from "../lib/auth.js";
import { liveNavClass, sportsNavClass } from "../lib/browse-nav.js";
import { bindTopNavScrollState } from "../lib/top-nav-scroll.js";

export default function LivePage() {
  const [accountMenuOpen, setAccountMenuOpen] = createSignal(false);
  const [avatarClass, setAvatarClass] = createSignal("avatar avatar-style-blue");
  const [avatarImageSrc, setAvatarImageSrc] = createSignal("");
  const displayName = window.__currentUser?.displayName || "Account";
  let accountMenuEl;
  let cleanupTopNavScrollState = () => {};

  function applyAvatarStyle(style, mode, imageData) {
    const normalizedStyle = normalizeAvatarStyle(style);
    const normalizedMode = normalizeAvatarMode(mode);
    const safeImage = sanitizeAvatarImageData(imageData);

    if (normalizedMode === "custom" && safeImage) {
      setAvatarClass("avatar avatar-custom-image");
      setAvatarImageSrc(safeImage);
      return;
    }

    setAvatarClass(`avatar avatar-style-${normalizedStyle}`);
    setAvatarImageSrc("");
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
    cleanupTopNavScrollState = bindTopNavScrollState();
    applyAvatarStyle(
      getStoredAvatarStylePreference(),
      getStoredAvatarModePreference(),
      getStoredAvatarImagePreference(),
    );
    document.addEventListener("click", handleDocumentClick);
    document.addEventListener("keydown", handleDocumentKeydown);
  });

  onCleanup(() => {
    cleanupTopNavScrollState();
    document.removeEventListener("click", handleDocumentClick);
    document.removeEventListener("keydown", handleDocumentKeydown);
  });

  return <>
    <div data-solid-page-root="" class="solid-page-root">
      <div class="page home-page live-page" tabindex="0">
        <header class="top-nav">
          <div class="nav-left">
            <a href="/" class="nav-logo" aria-label="Go to homepage">
              <BrandWordmark class="brand-wordmark-arc--nav" />
            </a>
            <nav>
              <a href="/">Home</a>
              <a href="/live" class={liveNavClass("live")}>Live</a>
              <a href="/sports" class={sportsNavClass("")}>Sports</a>
              <a href="/#myListRow" class="optional">My List</a>
              <FeedbackNav />
            </nav>
          </div>
          <div class="nav-right">
            <button
              class="icon-btn"
              aria-label="Search"
              aria-expanded="false"
              onClick={() => {
                window.location.href = "/";
              }}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M14.33 12.9 19.71 18.28a1 1 0 0 1-1.42 1.42l-5.38-5.38a8 8 0 1 1 1.42-1.42Zm-6.33 1.1a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z"></path>
              </svg>
            </button>
            <div class="account-menu" ref={(el) => { accountMenuEl = el; }}>
              <button
                class="account-avatar-btn"
                aria-label="Account menu"
                aria-haspopup="menu"
                aria-controls="accountMenuPanel"
                aria-expanded={(accountMenuOpen() ? "true" : "false")}
                onClick={toggleAccountMenu}
              >
                <div
                  class={avatarClass()}
                  aria-hidden="true"
                >
                  {avatarImageSrc() ? (
                    <img class="avatar-custom-image-media" src={avatarImageSrc()} alt="" />
                  ) : null}
                </div>
              </button>
              <span
                class="icon-btn account-menu-toggle"
                aria-hidden="true"
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
              </span>
              <div
                id="accountMenuPanel"
                class="account-menu-panel"
                role="menu"
                hidden={!accountMenuOpen()}
              >
                <a class="account-menu-item account-menu-link" href="/settings" role="menuitem">
                  <span class="account-menu-icon" aria-hidden="true">
                    <svg viewBox="0 0 48 48">
                      <circle cx="24" cy="15.5" r="7.5"></circle>
                      <path d="M9.5 40.5c.9-9.2 6.4-14 14.5-14s13.6 4.8 14.5 14"></path>
                    </svg>
                  </span>
                  <span>Account</span>
                </a>
                <a class="account-menu-item account-menu-link" href="/help" role="menuitem">
                  <span class="account-menu-icon" aria-hidden="true">
                    <svg viewBox="0 0 48 48">
                      <circle cx="24" cy="24" r="19"></circle>
                      <path d="M18.5 18.2c.9-3.7 4.1-6 8-5.4 3.5.6 6 3.2 6 6.5 0 4.9-5.6 5.8-7.2 9.3"></path>
                      <circle cx="24" cy="35.5" r="1.5"></circle>
                    </svg>
                  </span>
                  <span>Help Centre</span>
                </a>
                <button
                  class="account-menu-item account-menu-signout"
                  type="button"
                  role="menuitem"
                  onClick={handleSignOut}
                >Sign out of StreamArena</button>
              </div>
            </div>
          </div>
        </header>

        <LiveChannelsView />
      </div>
    </div>
  </>;
}

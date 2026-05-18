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
import { signOut } from "../lib/auth.js";
import { LIVE_CHANNELS } from "../lib/live-channels.js";
import { saveWatchParams, slugifyTitle } from "../lib/watch-params.js";

function slugify(value) {
  return String(value || "live")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizePlaybackSource(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  if (/^(https?:)?\/\//i.test(raw) || raw.startsWith("/")) {
    return raw;
  }
  return raw.startsWith("assets/") ? `/${raw}` : raw;
}

function normalizeStreamOption(option, index = 0) {
  const source = normalizePlaybackSource(option?.source);
  if (!source) {
    return null;
  }
  const id =
    slugify(option?.id || option?.label || option?.quality || `stream-${index + 1}`) ||
    `stream-${index + 1}`;
  return {
    id,
    label: String(option?.label || option?.quality || `Stream ${index + 1}`).trim(),
    source,
    quality: String(option?.quality || "").trim(),
  };
}

function getChannelStreamOptions(channel) {
  const explicitStreams = Array.isArray(channel?.streams)
    ? channel.streams.map(normalizeStreamOption).filter(Boolean)
    : [];
  if (explicitStreams.length) {
    return explicitStreams;
  }
  const source = normalizePlaybackSource(channel?.source);
  if (!source) {
    return [];
  }
  return [
    {
      id: "default",
      label: "Default",
      source,
      quality: String(channel?.quality || "").trim(),
    },
  ];
}

function buildPlayerUrl(channel) {
  const streams = getChannelStreamOptions(channel);
  const defaultStream =
    streams.find((stream) => stream.id === channel?.defaultStreamId) ||
    streams[0] ||
    null;
  const source = normalizePlaybackSource(defaultStream?.source || channel?.source);
  const title = String(channel?.title || "Live").trim() || "Live";
  const params = new URLSearchParams({ title });

  if (source) {
    params.set("src", source);
  }
  if (streams.length > 0) {
    params.set("live", "1");
    params.set("liveStreamId", defaultStream?.id || streams[0].id);
    params.set("liveStreams", JSON.stringify(streams));
  }
  if (channel?.artwork) {
    params.set("thumb", channel.artwork);
  }
  params.set("episode", "Live");

  const slug = slugifyTitle(title);
  saveWatchParams(slug, params.toString());
  return `/watch/${slug}`;
}

export default function LivePage() {
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

  function openLiveChannel(channel) {
    window.location.href = buildPlayerUrl(channel);
  }

  async function handleSignOut(event) {
    event.preventDefault();
    await signOut();
  }

  function renderChannelCard(channel) {
    return html`
      <button
        class="live-channel-card"
        type="button"
        onClick=${() => openLiveChannel(channel)}
        aria-label=${`Play ${channel.title}`}
      >
        <img src=${channel.artwork} alt=${`${channel.title} artwork`} loading="lazy" />
        <span class="live-channel-play" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M5 3.5v17L20 12 5 3.5Z" /></svg>
        </span>
        <span class="live-channel-body">
          <span class="live-channel-title">${channel.title}</span>
          <span class="live-channel-meta">
            <span>Live</span>
            <span>${channel.region}</span>
            <span>${channel.genre}</span>
            <span>${channel.quality}</span>
          </span>
        </span>
      </button>
    `;
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
      <div class="page" tabindex="0">
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
              <a href="/live" class="is-active">Live</a>
              <a href="#" class="nav-secondary">Series</a>
              <a href="#" class="nav-secondary">Films</a>
              <a href="#" class="optional">Games</a>
              <a href="/new-popular" class="optional">New &amp; Popular</a>
              <a href="/#myListRow" class="optional">My List</a>
              <a href="#" class="optional">Browse by Language</a>
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
            <span class="kids">Kids</span>
            <button class="icon-btn" aria-label="Notifications">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 24a3 3 0 0 0 2.82-2H9.18A3 3 0 0 0 12 24Zm8-6-2-2V10a6 6 0 1 0-12 0v6l-2 2v2h16v-2Z"></path>
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
                class="icon-btn"
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

        <main class="live-main">
          <section class="live-channel-section">
            <h2>Live Channels</h2>
            <div class="live-channel-grid">
              ${LIVE_CHANNELS.map((channel) => renderChannelCard(channel))}
            </div>
          </section>
        </main>
      </div>
    </div>
  `;
}

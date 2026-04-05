import html from "solid-js/html";

export default function NewPopularPage() {
  return html`<div data-solid-page-root="" style="display: contents">
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
            <a href="#">Series</a>
            <a href="#">Films</a>
            <a href="#" class="optional">Games</a>
            <a href="/new-popular" class="optional is-active">New &amp; Popular</a>
            <a href="/#myListRow" class="optional">My List</a>
            <a href="#" class="optional">Browse by Language</a>
          </nav>
        </div>
        <div class="nav-right">
          <div id="navSearchBox" class="nav-search-box" hidden>
            <label class="nav-search-field" for="navSearchInput">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M14.33 12.9 19.71 18.28a1 1 0 0 1-1.42 1.42l-5.38-5.38a8 8 0 1 1 1.42-1.42Zm-6.33 1.1a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z"></path>
              </svg>
              <input
                id="navSearchInput"
                type="search"
                inputmode="search"
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
                spellcheck="false"
                placeholder="Titles, people, genres"
                aria-label="Search titles, people, genres"
              />
            </label>
            <button
              id="closeSearchButton"
              class="nav-search-close"
              type="button"
              aria-label="Close search"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="m6 6 12 12M18 6 6 18"
                  fill="none"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                ></path>
              </svg>
            </button>
          </div>
          <button
            id="openSearchButton"
            class="icon-btn"
            aria-label="Search"
            aria-expanded="false"
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
          <div id="accountMenu" class="account-menu">
            <button
              id="accountAvatarButton"
              class="account-avatar-btn"
              aria-label="Account menu"
              aria-haspopup="menu"
              aria-controls="accountMenuPanel"
              aria-expanded="false"
            >
              <div
                id="accountAvatar"
                class="avatar avatar-style-blue"
                aria-hidden="true"
              ></div>
            </button>
            <button
              id="accountMenuToggle"
              class="icon-btn"
              aria-label="Account menu"
              aria-haspopup="menu"
              aria-expanded="false"
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
              hidden
            >
              <a
                class="account-menu-item account-menu-item--muted"
                href="#"
                role="menuitem"
                tabindex="-1"
              >Erlin</a>
              <a class="account-menu-item" href="/upload" role="menuitem">Upload Media</a>
              <a class="account-menu-item" href="/settings" role="menuitem">Settings</a>
            </div>
          </div>
        </div>
      </header>

      <img
        id="heroBackdrop"
        class="hero-video new-popular-backdrop"
        src="assets/images/thumbnail.jpg"
        alt=""
      />

      <div class="hero-shade" aria-hidden="true"></div>

      <section class="hero-content">
        <img
          src="assets/icons/netflix-logo-clean.png"
          class="brand-mark-image"
          alt="Netflix"
        />
        <h1 id="heroTitle" tabindex="0" aria-label="Open featured title">Loading</h1>
        <div class="rank-line">
          <span class="top10">TOP 10</span>
          <p id="heroRank">Popular on TMDB today</p>
        </div>
        <p id="heroDescription" class="description">
          Loading the latest popular movies.
        </p>
        <div class="hero-actions">
          <button id="heroPlay" class="cta cta-play" type="button">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 3.5v17L20 12 5 3.5Z"></path>
            </svg>
            Play
          </button>
          <button id="heroInfo" class="cta cta-info" type="button">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle
                cx="12"
                cy="12"
                r="9.25"
                fill="none"
                stroke="currentColor"
                stroke-width="2.2"
              ></circle>
              <line
                x1="12"
                y1="10.5"
                x2="12"
                y2="16.25"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linecap="round"
              ></line>
              <circle cx="12" cy="7.5" r="1.25"></circle>
            </svg>
            Browse List
          </button>
        </div>
      </section>

      <div class="subtitle new-popular-subtitle">
        <strong id="heroSubtitleLabel">TRENDING NOW</strong>
        <em id="heroSubtitleText">Fresh from TMDB's popular movie list.</em>
      </div>

      <div class="hero-controls">
        <span id="heroRating" class="rating">13+</span>
      </div>

      <section id="featuredRow" class="continue-row">
        <h2>Popular Right Now</h2>
        <div id="featuredCards" class="cards"></div>
        <p id="featuredEmpty" class="continue-empty" hidden>
          No popular movies are available right now.
        </p>
      </section>
    </div>

    <section id="libraryMatchesRow" class="popular-row" hidden>
      <div class="popular-row-inner">
        <h2>In Your Library</h2>
        <div id="libraryMatchesCards" class="cards popular-cards"></div>
      </div>
    </section>

    <section id="popularRow" class="popular-row">
      <div class="popular-row-inner">
        <h2>More Popular Movies</h2>
        <div id="cardsContainer" class="cards popular-cards"></div>
      </div>
    </section>
  </div>`;
}

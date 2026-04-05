import html from "solid-js/html";

export default function HomePage() {
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
            <a href="#" class="is-active">Home</a>
            <a href="#">Series</a>
            <a href="#">Films</a>
            <a href="#" class="optional">Games</a>
            <a href="/new-popular" class="optional">New &amp; Popular</a>
            <a href="#" id="navMyList" class="optional">My List</a>
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

      <section id="searchExperience" class="search-experience" hidden>
        <p id="searchStatus" class="search-status">
          Start typing to search TMDB titles.
        </p>
        <div id="searchExplore" class="search-explore" hidden>
          <span class="search-explore-label">More to explore:</span>
          <div id="searchExploreLinks" class="search-explore-links"></div>
        </div>
        <div id="searchResultsGrid" class="search-results-grid"></div>
      </section>

      <video
        id="introVideo"
        class="hero-video"
        src="assets/videos/jeffrey-epstein-filthy-rich-official-trailer-netflix.mp4"
        autoplay
        loop
        playsinline
        preload="auto"
        aria-label="Jeffrey Epstein: Filthy Rich trailer"
      ></video>

      <div class="hero-shade" aria-hidden="true"></div>

      <section class="hero-content">
        <img
          src="assets/icons/netflix-logo-clean.png"
          class="brand-mark-image"
          alt="Netflix"
        />
        <h1
          id="heroTitle"
          tabindex="0"
          aria-label="Open Jeffrey Epstein player"
        >
          JEFFREY
          <br />
          EPSTEIN:
          <br />
          <span>FILTHY RICH</span>
        </h1>
        <div class="rank-line">
          <span class="top10">TOP 10</span>
          <p>No. 3 in Series Today</p>
        </div>
        <p class="description">
          Stories from survivors fuel this documentary series
          examining how convicted sex offender Jeffrey Epstein used
          wealth and power to carry out his abuses.
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
            More Info
          </button>
        </div>
      </section>

      <div class="subtitle">
        <strong>[newsman]</strong>
        <em>The disgraced financier<br />Jeffrey Epstein is dead.</em>
      </div>

      <div class="hero-controls">
        <button
          id="muteToggle"
          class="control-btn muted"
          type="button"
          aria-label="Unmute trailer"
        >
          <svg class="icon-on" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M14 5.2v13.6a1 1 0 0 1-1.68.74L7.6 15H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h2.6l4.72-4.54A1 1 0 0 1 14 5.2Zm3.72 2.18a1 1 0 1 1 1.56-1.24 10.25 10.25 0 0 1 0 11.72 1 1 0 1 1-1.56-1.24 8.25 8.25 0 0 0 0-9.24Zm-2.8 2.26a1 1 0 0 1 1.56-1.24 5.8 5.8 0 0 1 0 7.2 1 1 0 1 1-1.56-1.24 3.8 3.8 0 0 0 0-4.72Z"></path>
          </svg>
          <svg class="icon-off" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M14 5.2v13.6a1 1 0 0 1-1.68.74L7.6 15H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h2.6l4.72-4.54A1 1 0 0 1 14 5.2Zm6.3 3.1a1 1 0 0 1 0 1.4L18.01 12l2.3 2.3a1 1 0 0 1-1.42 1.4L16.6 13.4l-2.3 2.3a1 1 0 0 1-1.4-1.42l2.3-2.28-2.3-2.3a1 1 0 0 1 1.4-1.4l2.3 2.3 2.29-2.3a1 1 0 0 1 1.41 0Z"></path>
          </svg>
        </button>
        <span class="rating">15</span>
      </div>

      <section id="continueRow" class="continue-row">
        <h2>Continue watching for Erlin</h2>
        <div id="continueCards" class="cards"></div>
        <p id="continueEmpty" class="continue-empty" hidden>
          Start a movie and it will appear here.
        </p>
      </section>
    </div>

    <section id="popularRow" class="popular-row">
      <div class="popular-row-inner">
        <h2 id="popularRowTitle">Downloaded Titles</h2>
        <div id="cardsContainer" class="cards popular-cards"></div>
      </div>
    </section>

    <section id="myListRow" class="popular-row" hidden>
      <div class="popular-row-inner">
        <h2>My List</h2>
        <div id="myListCards" class="cards popular-cards"></div>
        <p id="myListEmpty" class="continue-empty" hidden>
          Add titles using the check icon.
        </p>
      </div>
    </section>

    <div id="detailsModal" class="details-modal" hidden>
      <div class="details-backdrop" data-close-modal></div>
      <article
        class="details-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detailsTitle"
      >
        <button
          id="detailsClose"
          class="details-close"
          type="button"
          aria-label="Close details"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="m6 6 12 12M18 6 6 18"
              fill="none"
              stroke-linecap="round"
            ></path>
          </svg>
        </button>

        <header class="details-hero">
          <img
            id="detailsImage"
            class="details-hero-image"
            src="assets/images/jeffrey-epstein-s01e01-thumb.jpg"
            alt="Title artwork"
          />
          <div class="details-hero-fade" aria-hidden="true"></div>
          <div class="details-hero-content">
            <h3 id="detailsTitle">JEFFREY EPSTEIN: FILTHY RICH</h3>
            <div class="details-actions">
              <button
                id="detailsPlay"
                class="cta cta-play details-play"
                type="button"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 3.5v17L20 12 5 3.5Z"></path>
                </svg>
                Play
              </button>
              <button
                id="detailsMyList"
                class="details-round"
                type="button"
                aria-label="Add to my list"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M12 5v14M5 12h14"
                    fill="none"
                    stroke-linecap="round"
                  ></path>
                </svg>
              </button>
              <button
                class="details-round"
                type="button"
                aria-label="Rate title"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M8 20H5.8A1.8 1.8 0 0 1 4 18.2V10a1.8 1.8 0 0 1 1.8-1.8H8V20Zm2 0h6a3.5 3.5 0 0 0 3.4-2.8l.8-4A2.5 2.5 0 0 0 17.75 10H14V6.6A2.6 2.6 0 0 0 11.4 4L10 9.3V20Z"></path>
                </svg>
              </button>
            </div>
          </div>
        </header>

        <div class="details-body">
          <section class="details-main">
            <div class="details-meta">
              <span id="detailsYear">2023</span>
              <span id="detailsRuntime">2h 40m</span>
              <span id="detailsMaturity" class="details-maturity">18</span>
              <span id="detailsQuality" class="meta-chip">HD</span>
              <span id="detailsAudio" class="details-audio">Spatial Audio</span>
            </div>
            <p id="detailsDescription" class="details-description">
              Survivors and investigators detail how Jeffrey
              Epstein built a system of abuse and influence for
              years.
            </p>
          </section>

          <aside class="details-side">
            <p>
              <span>Cast:</span>
              <strong id="detailsCast">Survivors, Journalists, Investigators</strong>
            </p>
            <p>
              <span>Genres:</span>
              <strong id="detailsGenres">Documentary, True Crime, Investigative</strong>
            </p>
            <p>
              <span>This title is:</span>
              <strong id="detailsVibe">Investigative, Dark, Emotional</strong>
            </p>
          </aside>
        </div>

        <section id="detailsMoreSection" class="details-more" hidden>
          <h4>More Like This</h4>
          <div id="detailsMoreGrid" class="details-grid"></div>
        </section>
      </article>
    </div>

    <div id="libraryEditModal" class="library-edit-modal" hidden>
      <div class="library-edit-backdrop" data-close-library-edit></div>
      <article
        class="library-edit-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="libraryEditModalTitle"
      >
        <button
          id="libraryEditClose"
          class="library-edit-close"
          type="button"
          aria-label="Close editor"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="m6 6 12 12M18 6 6 18"
              fill="none"
              stroke-linecap="round"
            ></path>
          </svg>
        </button>
        <header class="library-edit-modal-header">
          <p class="library-edit-kicker">Library Editor</p>
          <h3 id="libraryEditModalTitle">Edit Title</h3>
          <p id="libraryEditModalMeta" class="library-edit-modal-meta"></p>
        </header>
        <div id="libraryEditFields" class="library-edit-fields"></div>
        <div class="library-edit-modal-actions">
          <button
            id="libraryAddEpisodeBtn"
            class="library-edit-btn"
            type="button"
            hidden
          >
            Add Episode
          </button>
          <button
            id="librarySaveBtn"
            class="library-edit-btn library-edit-btn--primary"
            type="button"
          >
            Save Changes
          </button>
          <button
            id="libraryDeleteBtn"
            class="library-edit-btn library-edit-btn--danger"
            type="button"
          >
            Delete Title
          </button>
        </div>
        <p
          id="libraryEditModalStatus"
          class="library-edit-modal-status"
          role="status"
          aria-live="polite"
        ></p>
      </article>
    </div>

    <div id="searchContextMenu" class="search-context-menu" hidden>
      <button
        id="searchContextSaveButton"
        class="search-context-menu-item"
        type="button"
      >
        Save to gallery while streaming
      </button>
    </div>
  </div>`;
}

import html from "solid-js/html";
import { createSignal, onMount, onCleanup } from "solid-js";
import {
  STREAM_QUALITY_PREF_KEY,
  supportedStreamQualityPreferences,
  avatarStyleClassNames,
  normalizeAvatarStyle,
  normalizeAvatarMode,
  sanitizeAvatarImageData,
  getStoredAvatarStylePreference,
  getStoredAvatarModePreference,
  getStoredAvatarImagePreference,
  escapeHtml,
} from "../shared.js";

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";
const AUDIO_LANG_PREF_KEY_PREFIX = "netflix-audio-lang:movie:";
const DEFAULT_AUDIO_LANGUAGE_PREF_KEY = "netflix-default-audio-lang";

const supportedAudioLangs = new Set(["auto", "en", "fr", "es", "de"]);
const supportedDefaultAudioLanguages = new Set([
  "auto",
  "en",
  "ja",
  "ko",
  "zh",
  "fr",
  "es",
  "de",
  "it",
  "pt",
  "nl",
  "ro",
]);

// --- Pure utility functions (no DOM) ---

function normalizeTitleKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeStreamQualityPreference(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return "auto";
  if (normalized === "4k" || normalized === "uhd") return "2160p";
  if (normalized === "2160") return "2160p";
  if (normalized === "1080") return "1080p";
  if (normalized === "720") return "720p";
  if (supportedStreamQualityPreferences.has(normalized)) {
    return normalized;
  }
  return "auto";
}

function normalizeDefaultAudioLanguage(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (
    !normalized ||
    normalized === "en" ||
    normalized === "eng" ||
    normalized === "english"
  ) {
    return "en";
  }
  if (
    normalized === "auto" ||
    normalized === "default" ||
    normalized === "source" ||
    normalized === "original"
  ) {
    return "auto";
  }
  if (supportedDefaultAudioLanguages.has(normalized)) {
    return normalized;
  }
  return "en";
}

function getStoredAudioLangForTmdbMovie(tmdbId) {
  const normalizedTmdbId = String(tmdbId || "").trim();
  if (!normalizedTmdbId) {
    return "auto";
  }
  try {
    const raw = String(
      localStorage.getItem(
        `${AUDIO_LANG_PREF_KEY_PREFIX}${normalizedTmdbId}`,
      ) || "",
    )
      .trim()
      .toLowerCase();
    if (supportedAudioLangs.has(raw)) {
      return raw;
    }
  } catch {
    // Ignore localStorage failures.
  }
  return "auto";
}

function getStoredDefaultAudioLanguage() {
  try {
    return normalizeDefaultAudioLanguage(
      localStorage.getItem(DEFAULT_AUDIO_LANGUAGE_PREF_KEY),
    );
  } catch {
    return "en";
  }
}

function getStoredStreamQualityPreference() {
  try {
    return normalizeStreamQualityPreference(
      localStorage.getItem(STREAM_QUALITY_PREF_KEY),
    );
  } catch {
    return "auto";
  }
}

async function apiFetch(path, params = {}) {
  const query = new URLSearchParams(params);
  const url = query.size ? `${path}?${query.toString()}` : path;
  const response = await fetch(url);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `Request failed (${response.status})`);
  }
  return payload;
}

function buildPlayerUrl(details) {
  const params = new URLSearchParams({
    title: details.title || "Title",
    mediaType: "movie",
  });

  const normalizedSrc = String(details.src || "").trim();
  if (normalizedSrc) {
    if (/^(https?:)?\/\//i.test(normalizedSrc) || normalizedSrc.startsWith("/")) {
      params.set("src", normalizedSrc);
    } else if (normalizedSrc.startsWith("assets/")) {
      params.set("src", `/${normalizedSrc}`);
    } else {
      params.set("src", normalizedSrc);
    }
  }

  if (details.thumb) {
    params.set("thumb", details.thumb);
  }
  if (details.tmdbId) {
    params.set("tmdbId", details.tmdbId);
  }
  if (details.year) {
    params.set("year", details.year);
  }

  if (!normalizedSrc && details.tmdbId) {
    const preferredAudioLang = getStoredAudioLangForTmdbMovie(details.tmdbId);
    const defaultAudioLang = getStoredDefaultAudioLanguage();
    const preferredQuality = getStoredStreamQualityPreference();
    if (preferredAudioLang !== "auto") {
      params.set("audioLang", preferredAudioLang);
    } else if (defaultAudioLang !== "auto") {
      params.set("audioLang", defaultAudioLang);
    }
    if (preferredQuality !== "auto") {
      params.set("quality", preferredQuality);
    }
  }

  if (normalizedSrc && !params.has("audioLang")) {
    params.set("audioLang", "en");
  }

  return `player.html?${params.toString()}`;
}

function openPlayerPage(details) {
  window.location.href = buildPlayerUrl(details);
}

function buildCardDetails(item, genreMap, imageBase) {
  const title = item.title || "Untitled";
  const releaseDate = item.release_date || "";
  const year = releaseDate ? releaseDate.slice(0, 4) : "2024";
  const posterPath = item.poster_path || item.backdrop_path;
  const backdropPath = item.backdrop_path || item.poster_path;
  const posterUrl = posterPath
    ? `${imageBase}/w500${posterPath}`
    : "assets/images/thumbnail.jpg";
  const heroUrl = backdropPath
    ? `${imageBase}/original${backdropPath}`
    : posterUrl;
  const maturity = item.adult ? "18" : "13+";
  const genreNames = (item.genre_ids || [])
    .map((id) => genreMap.get(id))
    .filter(Boolean)
    .slice(0, 3);
  const tagLine = genreNames.length
    ? genreNames.map(escapeHtml).join(" <span>&bull;</span> ")
    : "Popular <span>&bull;</span> Trending";
  const safeTitle = escapeHtml(title);
  const details = {
    title,
    src: String(item.localSrc || "").trim(),
    thumb: heroUrl,
    tmdbId: String(item.id || "").trim(),
    year,
  };
  const progress = Math.max(10, Math.min(96, Math.round((item.vote_average || 6.5) * 10)));

  return { title, year, posterUrl, heroUrl, maturity, tagLine, safeTitle, details, progress };
}

// --- Component ---

export default function NewPopularPage() {
  // --- State signals ---
  const [featuredMovie, setFeaturedMovie] = createSignal(null);
  const [heroBackdropUrl, setHeroBackdropUrl] = createSignal("assets/images/thumbnail.jpg");
  const [heroTitleText, setHeroTitleText] = createSignal("Loading");
  const [heroRankText, setHeroRankText] = createSignal("Popular on TMDB today");
  const [heroDescriptionText, setHeroDescriptionText] = createSignal("Loading the latest popular movies.");
  const [heroSubtitleLabelText, setHeroSubtitleLabelText] = createSignal("TRENDING NOW");
  const [heroSubtitleTextVal, setHeroSubtitleTextVal] = createSignal("Fresh from TMDB's popular movie list.");
  const [heroRatingText, setHeroRatingText] = createSignal("13+");
  const [featuredItems, setFeaturedItems] = createSignal([]);
  const [moreItems, setMoreItems] = createSignal([]);
  const [localMatchItems, setLocalMatchItems] = createSignal([]);
  const [showFeaturedEmpty, setShowFeaturedEmpty] = createSignal(false);
  const [featuredEmptyText, setFeaturedEmptyText] = createSignal("No popular movies are available right now.");
  const [showLibraryRow, setShowLibraryRow] = createSignal(false);
  const [accountMenuOpen, setAccountMenuOpen] = createSignal(false);
  const [genreMapRef, setGenreMapRef] = createSignal(new Map());
  const [imageBaseRef, setImageBaseRef] = createSignal(TMDB_IMAGE_BASE);

  // Avatar state
  const [avatarClass, setAvatarClass] = createSignal("avatar avatar-style-blue");
  const [avatarCustomStyle, setAvatarCustomStyle] = createSignal("");

  // Refs
  let accountMenuEl;
  let popularRowEl;

  // --- Avatar logic ---
  function applyAvatarStyle(style, mode, imageData) {
    const normalizedStyle = normalizeAvatarStyle(style);
    const normalizedMode = normalizeAvatarMode(mode);
    const safeImage = sanitizeAvatarImageData(imageData);

    if (normalizedMode === "custom" && safeImage) {
      setAvatarClass("avatar avatar-custom-image");
      setAvatarCustomStyle(`--avatar-image: url("${safeImage}"); background-image: var(--avatar-image)`);
      return;
    }

    setAvatarClass(`avatar avatar-style-${normalizedStyle}`);
    setAvatarCustomStyle("");
  }

  // --- Account menu ---
  function toggleAccountMenu(event) {
    event.stopPropagation();
    setAccountMenuOpen((prev) => !prev);
  }

  function closeAccountMenu() {
    setAccountMenuOpen(false);
  }

  // --- Hero configuration ---
  function configureHero(item, genreMap, imageBase) {
    if (!item) return;

    const title = String(item.title || "Untitled").trim() || "Untitled";
    const releaseDate = String(item.release_date || "").trim();
    const year = releaseDate ? releaseDate.slice(0, 4) : "";
    const posterPath = item.poster_path || item.backdrop_path;
    const backdropPath = item.backdrop_path || item.poster_path;
    const heroUrl = backdropPath
      ? `${imageBase}/original${backdropPath}`
      : posterPath
        ? `${imageBase}/w780${posterPath}`
        : "assets/images/thumbnail.jpg";
    const genreNames = (item.genre_ids || [])
      .map((id) => genreMap.get(id))
      .filter(Boolean)
      .slice(0, 3);
    const rankText = `No. 1 in Movies Today${year ? ` \u2022 ${year}` : ""}`;
    const subtitleText = genreNames.length
      ? genreNames.join(" \u2022 ")
      : "Fresh from TMDB's popular movie list.";
    const details = {
      title,
      src: String(item.localSrc || "").trim(),
      thumb: heroUrl,
      tmdbId: String(item.id || "").trim(),
      year,
    };

    setFeaturedMovie(details);
    setHeroBackdropUrl(heroUrl);
    setHeroTitleText(title);
    setHeroRankText(rankText);
    setHeroDescriptionText(item.overview || "Browse the latest popular movie picks from TMDB.");
    setHeroSubtitleLabelText("POPULAR NOW");
    setHeroSubtitleTextVal(subtitleText);
    setHeroRatingText(item.adult ? "18" : "13+");
  }

  // --- Data loading ---
  async function loadNewPopularPage() {
    try {
      const [localLibrary, ...popularPayloads] = await Promise.all([
        apiFetch("/api/library").catch(() => ({ movies: [], series: [] })),
        apiFetch("/api/tmdb/popular-movies", { page: "1" }),
        apiFetch("/api/tmdb/popular-movies", { page: "2" }),
      ]);

      const genreMap = new Map();
      popularPayloads.forEach((payload) => {
        (payload?.genres || []).forEach((genre) => {
          genreMap.set(genre.id, genre.name);
        });
      });
      const imageBase =
        popularPayloads.find((payload) => payload?.imageBase)?.imageBase ||
        TMDB_IMAGE_BASE;
      const localMovies = Array.isArray(localLibrary?.movies)
        ? localLibrary.movies
        : [];
      const localMoviesByTmdbId = new Map(
        localMovies
          .map((entry) => [String(entry?.tmdbId || "").trim(), entry])
          .filter(([tmdbId]) => Boolean(tmdbId)),
      );
      const localMoviesByTitleYearKey = new Map(
        localMovies
          .map((entry) => {
            const titleKey = normalizeTitleKey(entry?.title || "");
            const yearKey = String(entry?.year || "").trim();
            return [titleKey ? `${titleKey}|${yearKey}` : "", entry];
          })
          .filter(([key]) => Boolean(key)),
      );

      const movies = [];
      const seenIds = new Set();
      popularPayloads.forEach((payload) => {
        const results = Array.isArray(payload?.results) ? payload.results : [];
        results.forEach((movie) => {
          const tmdbId = String(movie?.id || "").trim();
          if (!tmdbId || seenIds.has(tmdbId)) {
            return;
          }
          seenIds.add(tmdbId);
          const titleKey = normalizeTitleKey(movie?.title || movie?.name || "");
          const yearKey = String(
            movie?.release_date || movie?.first_air_date || "",
          ).slice(0, 4);
          const localMatch =
            localMoviesByTmdbId.get(tmdbId) ||
            (titleKey ? localMoviesByTitleYearKey.get(`${titleKey}|${yearKey}`) : null) ||
            null;
          movies.push({
            ...movie,
            localSrc: String(localMatch?.src || "").trim(),
          });
        });
      });

      if (!movies.length) {
        setShowFeaturedEmpty(true);
        return;
      }

      setGenreMapRef(genreMap);
      setImageBaseRef(imageBase);

      configureHero(movies[0], genreMap, imageBase);
      setFeaturedItems(movies.slice(0, 6));
      setMoreItems(movies.slice(6));

      const localMatches = movies.filter((movie) => movie.localSrc);
      if (localMatches.length) {
        setShowLibraryRow(true);
        setLocalMatchItems(localMatches.slice(0, 8));
      }
    } catch (error) {
      console.error("Failed to load new and popular page:", error);
      setShowFeaturedEmpty(true);
      setFeaturedEmptyText(
        error instanceof Error
          ? error.message
          : "Could not load popular movies right now.",
      );
    }
  }

  // --- Event handlers ---
  function handleHeroPlay() {
    const movie = featuredMovie();
    if (movie) openPlayerPage(movie);
  }

  function handleHeroTitleClick() {
    const movie = featuredMovie();
    if (movie) openPlayerPage(movie);
  }

  function handleHeroBrowseList() {
    popularRowEl?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function handleOpenSearch() {
    window.location.href = "/";
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

  // --- Card click handler ---
  function handleCardClick(details) {
    openPlayerPage(details);
  }

  function handleCardKeydown(event, details) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openPlayerPage(details);
    }
  }

  // --- Lifecycle ---
  onMount(() => {
    applyAvatarStyle(
      getStoredAvatarStylePreference(),
      getStoredAvatarModePreference(),
      getStoredAvatarImagePreference(),
    );

    document.addEventListener("click", handleDocumentClick);
    document.addEventListener("keydown", handleDocumentKeydown);

    void loadNewPopularPage();
  });

  onCleanup(() => {
    document.removeEventListener("click", handleDocumentClick);
    document.removeEventListener("keydown", handleDocumentKeydown);
  });

  // --- Card rendering helper ---
  function renderCard(item, index, totalCount) {
    const gm = genreMapRef();
    const ib = imageBaseRef();
    const { title, year, posterUrl, heroUrl, maturity, tagLine, safeTitle, details, progress } =
      buildCardDetails(item, gm, ib);
    const alignRight = index >= Math.max(1, totalCount - 2);

    return html`
      <article
        class=${`card${alignRight ? " card--align-right" : ""}`}
        tabindex="0"
        data-title=${title}
        data-tmdb-id=${details.tmdbId}
        data-src=${details.src}
        data-thumb=${details.thumb}
        data-year=${details.year}
        data-media-type="movie"
        onClick=${() => handleCardClick(details)}
        onKeyDown=${(e) => handleCardKeydown(e, details)}
      >
        <div class="card-base">
          <img src=${posterUrl} alt=${safeTitle} loading="lazy" />
          <div class="progress"><span style=${`width: ${progress}%`}></span></div>
        </div>
        <div class="card-hover">
          <img class="card-hover-image" src=${heroUrl} alt=${`${safeTitle} preview`} loading="lazy" />
          <div class="card-hover-body">
            <div class="card-hover-controls">
              <div class="card-hover-actions">
                <button
                  class="hover-round hover-play"
                  type="button"
                  aria-label=${`Play ${safeTitle}`}
                  onClick=${(e) => { e.stopPropagation(); openPlayerPage(details); }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5v17L20 12 5 3.5Z" /></svg>
                </button>
                <button
                  class="hover-round hover-details"
                  type="button"
                  aria-label=${`Open ${safeTitle}`}
                  onClick=${(e) => { e.stopPropagation(); openPlayerPage(details); }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </button>
                ${details.src ? html`<span class="popular-status">Local</span>` : ""}
              </div>
            </div>
            <div class="card-hover-meta">
              <span class="meta-age">${maturity}</span>
              <span>${year}</span>
              <span class="meta-chip">HD</span>
              <span class="meta-spatial">Movie</span>
            </div>
            <p class="card-hover-tags" innerHTML=${tagLine}></p>
          </div>
        </div>
      </article>
    `;
  }

  // --- Template ---
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
            class="icon-btn"
            aria-label="Search"
            aria-expanded="false"
            onClick=${handleOpenSearch}
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
              aria-expanded=${() => accountMenuOpen() ? "true" : "false"}
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
              aria-expanded=${() => accountMenuOpen() ? "true" : "false"}
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
              style=${() => accountMenuOpen() ? "" : "display:none"}
            >
              <a
                class="account-menu-item account-menu-item--muted"
                href="#"
                role="menuitem"
                tabindex="-1"
              >Erlin</a>
              <a class="account-menu-item" href="/settings" role="menuitem">Upload Media</a>
              <a class="account-menu-item" href="/settings" role="menuitem">Settings</a>
            </div>
          </div>
        </div>
      </header>

      <img
        class="hero-video new-popular-backdrop"
        src=${() => heroBackdropUrl()}
        alt=${() => `${heroTitleText()} artwork`}
      />

      <div class="hero-shade" aria-hidden="true"></div>

      <section class="hero-content">
        <img
          src="assets/icons/netflix-logo-clean.png"
          class="brand-mark-image"
          alt="Netflix"
        />
        <h1
          tabindex="0"
          aria-label=${() => `Open ${heroTitleText()} player`}
          onClick=${handleHeroTitleClick}
          style="cursor: pointer"
        >${() => heroTitleText()}</h1>
        <div class="rank-line">
          <span class="top10">TOP 10</span>
          <p>${() => heroRankText()}</p>
        </div>
        <p class="description">
          ${() => heroDescriptionText()}
        </p>
        <div class="hero-actions">
          <button class="cta cta-play" type="button" onClick=${handleHeroPlay}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 3.5v17L20 12 5 3.5Z"></path>
            </svg>
            Play
          </button>
          <button class="cta cta-info" type="button" onClick=${handleHeroBrowseList}>
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
        <strong>${() => heroSubtitleLabelText()}</strong>
        <em>${() => heroSubtitleTextVal()}</em>
      </div>

      <div class="hero-controls">
        <span class="rating">${() => heroRatingText()}</span>
      </div>

      <section class="continue-row">
        <h2>Popular Right Now</h2>
        <div class="cards">
          ${() => featuredItems().map((item, i) => renderCard(item, i, featuredItems().length))}
        </div>
        <p
          class="continue-empty"
          style=${() => showFeaturedEmpty() ? "" : "display:none"}
        >
          ${() => featuredEmptyText()}
        </p>
      </section>
    </div>

    <section
      class="popular-row"
      style=${() => showLibraryRow() ? "" : "display:none"}
    >
      <div class="popular-row-inner">
        <h2>In Your Library</h2>
        <div class="cards popular-cards">
          ${() => localMatchItems().map((item, i) => renderCard(item, i, localMatchItems().length))}
        </div>
      </div>
    </section>

    <section class="popular-row" ref=${(el) => { popularRowEl = el; }}>
      <div class="popular-row-inner">
        <h2>More Popular Movies</h2>
        <div class="cards popular-cards">
          ${() => moreItems().map((item, i) => renderCard(item, i, moreItems().length))}
        </div>
      </div>
    </section>
  </div>`;
}

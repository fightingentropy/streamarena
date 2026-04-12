import {
  STREAM_QUALITY_PREF_KEY,
  PROFILE_AVATAR_STYLE_PREF_KEY,
  PROFILE_AVATAR_MODE_PREF_KEY,
  PROFILE_AVATAR_IMAGE_PREF_KEY,
  supportedStreamQualityPreferences,
  supportedAvatarStyles,
  avatarStyleClassNames,
  normalizeAvatarStyle,
  normalizeAvatarMode,
  sanitizeAvatarImageData,
  getStoredAvatarStylePreference,
  getStoredAvatarModePreference,
  getStoredAvatarImagePreference,
  escapeHtml,
} from "./src-ui/shared.js";

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

const heroBackdrop = document.getElementById("heroBackdrop");
const heroTitle = document.getElementById("heroTitle");
const heroRank = document.getElementById("heroRank");
const heroDescription = document.getElementById("heroDescription");
const heroSubtitleLabel = document.getElementById("heroSubtitleLabel");
const heroSubtitleText = document.getElementById("heroSubtitleText");
const heroRating = document.getElementById("heroRating");
const heroPlayButton = document.getElementById("heroPlay");
const heroInfoButton = document.getElementById("heroInfo");
const featuredCards = document.getElementById("featuredCards");
const featuredEmpty = document.getElementById("featuredEmpty");
const cardsContainer = document.getElementById("cardsContainer");
const libraryMatchesRow = document.getElementById("libraryMatchesRow");
const libraryMatchesCards = document.getElementById("libraryMatchesCards");
const openSearchButton = document.getElementById("openSearchButton");
const closeSearchButton = document.getElementById("closeSearchButton");
const navSearchBox = document.getElementById("navSearchBox");
const navSearchInput = document.getElementById("navSearchInput");
const accountMenu = document.getElementById("accountMenu");
const accountMenuToggle = document.getElementById("accountMenuToggle");
const accountMenuPanel = document.getElementById("accountMenuPanel");
const accountAvatarButton = document.getElementById("accountAvatarButton");
const accountAvatar = document.getElementById("accountAvatar");

let featuredMovie = null;

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

function applyAvatarStyle(style, mode, imageData) {
  if (!accountAvatar) {
    return;
  }

  const normalizedStyle = normalizeAvatarStyle(style);
  const normalizedMode = normalizeAvatarMode(mode);
  const safeImage = sanitizeAvatarImageData(imageData);

  avatarStyleClassNames.forEach((className) => {
    accountAvatar.classList.remove(className);
  });
  accountAvatar.classList.remove("avatar-custom-image");
  accountAvatar.style.removeProperty("--avatar-image");
  accountAvatar.style.removeProperty("backgroundImage");

  if (normalizedMode === "custom" && safeImage) {
    accountAvatar.classList.add("avatar-custom-image");
    accountAvatar.style.setProperty("--avatar-image", `url("${safeImage}")`);
    accountAvatar.style.backgroundImage = "var(--avatar-image)";
    return;
  }

  accountAvatar.classList.add(`avatar-style-${normalizedStyle}`);
}

function openAccountMenu() {
  if (!accountMenu || !accountMenuToggle || !accountMenuPanel) {
    return;
  }
  accountMenuPanel.hidden = false;
  accountMenuToggle.setAttribute("aria-expanded", "true");
  accountAvatarButton?.setAttribute("aria-expanded", "true");
}

function closeAccountMenu() {
  if (!accountMenu || !accountMenuToggle || !accountMenuPanel) {
    return;
  }
  accountMenuPanel.hidden = true;
  accountMenuToggle.setAttribute("aria-expanded", "false");
  accountAvatarButton?.setAttribute("aria-expanded", "false");
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

function buildCardFromMovie(item, genreMap, imageBase = TMDB_IMAGE_BASE) {
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

  const card = document.createElement("article");
  card.className = "card";
  card.tabIndex = 0;
  card.dataset.title = title;
  card.dataset.tmdbId = details.tmdbId;
  card.dataset.src = details.src;
  card.dataset.thumb = details.thumb;
  card.dataset.year = details.year;
  card.dataset.mediaType = "movie";

  card.innerHTML = `
    <div class="card-base">
      <img src="${posterUrl}" alt="${safeTitle}" loading="lazy" />
      <div class="progress"><span style="width: ${Math.max(10, Math.min(96, Math.round((item.vote_average || 6.5) * 10)))}%"></span></div>
    </div>
    <div class="card-hover">
      <img class="card-hover-image" src="${heroUrl}" alt="${safeTitle} preview" loading="lazy" />
      <div class="card-hover-body">
        <div class="card-hover-controls">
          <div class="card-hover-actions">
            <button class="hover-round hover-play" type="button" aria-label="Play ${safeTitle}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5v17L20 12 5 3.5Z" /></svg>
            </button>
            <button class="hover-round hover-details" type="button" aria-label="Open ${safeTitle}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
            ${details.src ? '<span class="popular-status">Local</span>' : ""}
          </div>
        </div>
        <div class="card-hover-meta">
          <span class="meta-age">${maturity}</span>
          <span>${year}</span>
          <span class="meta-chip">HD</span>
          <span class="meta-spatial">Movie</span>
        </div>
        <p class="card-hover-tags">${tagLine}</p>
      </div>
    </div>
  `;

  card.addEventListener("click", () => {
    openPlayerPage(details);
  });
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openPlayerPage(details);
    }
  });
  card.querySelector(".hover-play")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openPlayerPage(details);
  });
  card.querySelector(".hover-details")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openPlayerPage(details);
  });

  return card;
}

function renderCardRow(container, items, genreMap, imageBase) {
  if (!container) {
    return;
  }
  container.innerHTML = "";
  const fragment = document.createDocumentFragment();
  items.forEach((item, index) => {
    const card = buildCardFromMovie(item, genreMap, imageBase);
    if (index >= Math.max(1, items.length - 2)) {
      card.classList.add("card--align-right");
    }
    fragment.appendChild(card);
  });
  container.appendChild(fragment);
}

function configureHero(item, genreMap, imageBase = TMDB_IMAGE_BASE) {
  if (!item) {
    return;
  }

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
  const rankText = `No. 1 in Movies Today${year ? ` • ${year}` : ""}`;
  const subtitleText = genreNames.length
    ? genreNames.join(" • ")
    : "Fresh from TMDB's popular movie list.";
  const details = {
    title,
    src: String(item.localSrc || "").trim(),
    thumb: heroUrl,
    tmdbId: String(item.id || "").trim(),
    year,
  };

  featuredMovie = details;
  if (heroBackdrop) {
    heroBackdrop.src = heroUrl;
    heroBackdrop.alt = `${title} artwork`;
  }
  if (heroTitle) {
    heroTitle.textContent = title;
    heroTitle.setAttribute("aria-label", `Open ${title} player`);
  }
  if (heroRank) {
    heroRank.textContent = rankText;
  }
  if (heroDescription) {
    heroDescription.textContent =
      item.overview || "Browse the latest popular movie picks from TMDB.";
  }
  if (heroSubtitleLabel) {
    heroSubtitleLabel.textContent = "POPULAR NOW";
  }
  if (heroSubtitleText) {
    heroSubtitleText.textContent = subtitleText;
  }
  if (heroRating) {
    heroRating.textContent = item.adult ? "18" : "13+";
  }
}

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
      if (featuredEmpty) {
        featuredEmpty.hidden = false;
      }
      return;
    }

    configureHero(movies[0], genreMap, imageBase);
    renderCardRow(featuredCards, movies.slice(0, 6), genreMap, imageBase);
    renderCardRow(cardsContainer, movies.slice(6), genreMap, imageBase);

    const localMatches = movies.filter((movie) => movie.localSrc);
    if (localMatches.length && libraryMatchesRow && libraryMatchesCards) {
      libraryMatchesRow.hidden = false;
      renderCardRow(
        libraryMatchesCards,
        localMatches.slice(0, 8),
        genreMap,
        imageBase,
      );
    }
  } catch (error) {
    console.error("Failed to load new and popular page:", error);
    if (featuredEmpty) {
      featuredEmpty.hidden = false;
      featuredEmpty.textContent =
        error instanceof Error
          ? error.message
          : "Could not load popular movies right now.";
    }
  }
}

heroPlayButton?.addEventListener("click", () => {
  if (featuredMovie) {
    openPlayerPage(featuredMovie);
  }
});

heroTitle?.addEventListener("click", () => {
  if (featuredMovie) {
    openPlayerPage(featuredMovie);
  }
});

heroInfoButton?.addEventListener("click", () => {
  document
    .getElementById("popularRow")
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
});

openSearchButton?.addEventListener("click", () => {
  window.location.href = "/";
});

closeSearchButton?.addEventListener("click", () => {
  if (navSearchBox) {
    navSearchBox.hidden = true;
  }
  if (navSearchInput instanceof HTMLInputElement) {
    navSearchInput.value = "";
  }
});

accountMenuToggle?.addEventListener("click", (event) => {
  event.stopPropagation();
  if (accountMenuPanel?.hidden) {
    openAccountMenu();
  } else {
    closeAccountMenu();
  }
});

accountAvatarButton?.addEventListener("click", (event) => {
  event.stopPropagation();
  if (accountMenuPanel?.hidden) {
    openAccountMenu();
  } else {
    closeAccountMenu();
  }
});

document.addEventListener("click", (event) => {
  if (!accountMenu || accountMenu.contains(event.target)) {
    return;
  }
  closeAccountMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeAccountMenu();
  }
});

applyAvatarStyle(
  getStoredAvatarStylePreference(),
  getStoredAvatarModePreference(),
  getStoredAvatarImagePreference(),
);
closeAccountMenu();
void loadNewPopularPage();

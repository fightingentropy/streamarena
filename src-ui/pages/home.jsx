import { createSignal, onMount, onCleanup } from "solid-js";
import {
  PROFILE_AVATAR_STYLE_PREF_KEY,
  PROFILE_AVATAR_MODE_PREF_KEY,
  PROFILE_AVATAR_IMAGE_PREF_KEY,
  LIBRARY_EDIT_MODE_PREF_KEY,
  supportedAvatarStyles,
  avatarStyleClassNames,
  normalizeAvatarStyle,
  normalizeAvatarMode,
  sanitizeAvatarImageData,
  getStoredAvatarStylePreference,
  getStoredAvatarModePreference,
  getStoredAvatarImagePreference,
  escapeHtml,
  TMDB_IMAGE_BASE,
} from "../shared.js";
import {
  getStoredAudioLangForTmdbMovie,
} from "../lib/preferences.js";
import { beginServerHydration, getHydrationState, hydrateFromServer, SERVER_HYDRATED_EVENT, signOut } from "../lib/auth.js";
import { getInitialTmdbResolvePreferences } from "../player/playback-preferences.js";
import { bindHorizontalRailScrollers } from "../lib/horizontal-rail-scroll.js";
import { bindTopNavScrollState } from "../lib/top-nav-scroll.js";
import {
  addCurrentReturnToParam,
  buildTmdbWatchPath,
  buildWatchUrl,
  saveWatchParams,
  slugifyTitle,
} from "../lib/watch-params.js";
import { setRuntimeStyleRule } from "../lib/runtime-styles.js";
import { createMovieResolvePrewarmer, buildResolvePrewarmUrl } from "../lib/hover-resolve-prewarm.js";
import {
  CONTINUE_WATCHING_META_KEY,
  DEFAULT_LOCAL_THUMBNAIL,
  RESUME_STORAGE_PREFIX,
  enrichContinueEntriesWithLocalLibrary,
  formatResumeTimestamp,
  formatRuntime,
  getContinueWatchingEntries,
  getFallbackThumbnailForSource,
  inferContinueMediaType,
  isLikelyLocalMediaSource,
  normalizeArtworkPath,
  normalizeLocalMovieDisplayTitle,
  removeContinueWatchingEntry,
} from "../lib/continue-watching.js";
import {
  attachArtworkImageFallbacks,
  buildTmdbArtworkSrcSet,
  handleArtworkImageError,
  revealDeferredArtwork,
  observeDeferredArtwork,
  stopObservingDeferredArtwork,
  unobserveDeferredArtwork,
} from "../lib/offline-artwork.js";
import { liveNavClass, sportsNavLinkClass } from "../lib/browse-nav.js";
import {
  FEATURED_HERO_CANDIDATE_LIMIT,
  HERO_PREVIEW_EMBED_ORIGIN,
  HERO_PREVIEW_MESSAGE_ORIGINS,
  HERO_PREVIEW_REDUCED_MOTION_QUERY,
  buildFeaturedHeroCandidates,
  buildYoutubeTrailerEmbedUrl,
  createDefaultFeaturedHero,
  getFeaturedHeroAutoAdvanceDelay,
  getFeaturedHeroCallouts,
  getFeaturedHeroMetaItems,
  getPopularRowTitle,
  normalizeHeroTitle,
  normalizeYoutubeVideoKey,
  selectFeaturedHeroCandidate,
  selectFeaturedHeroTrailerKey,
} from "../lib/featured-hero.js";
import TitleRecommendations from "../components/title-recommendations.jsx";
import TitleEpisodes from "../components/title-episodes.jsx";
import MyListView from "../components/my-list-view.jsx";
import { normalizeSearchState, readSearchLocation, searchLocation } from "../lib/search-state.js";
import { episodePlaybackTarget, findTitleResume, titlePlaybackTarget } from "../lib/title-playback.js";
import SearchExperience from "../components/search-experience.jsx";
import FeedbackNav from "../components/feedback-nav.jsx";
import { readInjectedHomeBootstrap } from "../lib/home-bootstrap.js";
import BrandWordmark from "../components/brand-wordmark.jsx";
import { addBrowseCardCaption } from "../lib/browse-card-presentation.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const STALE_HERO_PREVIEW_MUTED_PREF_KEY = "streamarena-hero-trailer-muted-v2";
const HERO_PREVIEW_ENTER_VISIBLE_RATIO = 0.3;
const HERO_PREVIEW_LEAVE_VISIBLE_RATIO = 0.08;
const MY_LIST_STORAGE_KEY = "streamarena-my-list-v1";
const POPULAR_TITLES_LIMIT = 14;
const BROWSE_RAIL_LIMIT = 14;
const TOP_TEN_RAIL_LIMIT = 10;
const HOME_BOOTSTRAP_FETCH_TIMEOUT_MS = 2500;
const HOME_BOOTSTRAP_WARM_RETRY_MS = 1200;
const HOME_BOOTSTRAP_WARM_RETRY_LIMIT = 8;
const UNRATED_CERTIFICATION_LABEL = "Unrated";
const MODAL_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function normalizeCertification(value) {
  return String(value || "").trim() || UNRATED_CERTIFICATION_LABEL;
}

function isWarmingHomeBootstrap(payload) {
  return String(payload?._meta?.status || "").trim() === "warming";
}

async function resolveHomeBootstrap() {
  const injectedBootstrap = readInjectedHomeBootstrap();
  if (injectedBootstrap && !isWarmingHomeBootstrap(injectedBootstrap)) {
    return injectedBootstrap;
  }
  if (window.__HOME_BOOTSTRAP_PROMISE__) {
    try {
      const payload = await window.__HOME_BOOTSTRAP_PROMISE__;
      if (payload && typeof payload === "object") {
        window.__HOME_BOOTSTRAP_PROMISE__ = null;
        if (!isWarmingHomeBootstrap(payload)) {
          window.__HOME_BOOTSTRAP__ = payload;
        }
        return payload;
      }
    } catch {
      // Fall through to direct fetch.
    }
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    HOME_BOOTSTRAP_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await fetch("/api/home/bootstrap", { signal: controller.signal });
    const payload = await response.json().catch(() => null);
    if (response.ok && payload && typeof payload === "object") {
      if (!isWarmingHomeBootstrap(payload)) {
        window.__HOME_BOOTSTRAP__ = payload;
      }
      return payload;
    }
  } catch {
    // Ignore bootstrap fetch failures.
  } finally {
    window.clearTimeout(timeout);
  }
  return null;
}

function toPopularMoviesPayload(bootstrap) {
  return {
    results: Array.isArray(bootstrap?.popular?.results) ? bootstrap.popular.results : [],
    genres: Array.isArray(bootstrap?.genres) ? bootstrap.genres : [],
    imageBase: bootstrap?.imageBase || TMDB_IMAGE_BASE,
  };
}

function buildGenreMapFromPayload(payload) {
  const genreMap = new Map();
  (Array.isArray(payload?.genres) ? payload.genres : []).forEach((genre) => {
    genreMap.set(genre.id, genre.name);
  });
  return genreMap;
}

function getTmdbItemMediaType(item) {
  const explicitType = String(item?.media_type || item?.mediaType || "")
    .trim()
    .toLowerCase();
  if (explicitType === "tv" || explicitType === "movie") {
    return explicitType;
  }
  return item?.name || item?.first_air_date || item?.firstAirDate ? "tv" : "movie";
}

function getTmdbItemTitle(item) {
  const mediaType = getTmdbItemMediaType(item);
  const primary = mediaType === "tv" ? item?.name || item?.title : item?.title || item?.name;
  return String(primary || "").trim() || (mediaType === "tv" ? "Series" : "Movie");
}

function getTmdbItemReleaseDate(item) {
  const mediaType = getTmdbItemMediaType(item);
  return String(
    mediaType === "tv"
      ? item?.first_air_date || item?.firstAirDate || item?.release_date || item?.releaseDate || ""
      : item?.release_date || item?.releaseDate || item?.first_air_date || item?.firstAirDate || "",
  ).trim();
}

function getTmdbItemIdentity(item) {
  const mediaType = getTmdbItemMediaType(item);
  const tmdbId = String(item?.id || "").trim();
  if (tmdbId) {
    return `${mediaType}:${tmdbId}`;
  }
  const titleKey = getTmdbItemTitle(item).toLowerCase().replace(/\s+/g, " ").trim();
  return titleKey ? `${mediaType}:title:${titleKey}` : "";
}

function getBootstrapResults(bootstrap, ...keys) {
  for (const key of keys) {
    const results = bootstrap?.[key]?.results;
    if (Array.isArray(results) && results.length > 0) {
      return results;
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Pure utility functions (no signals needed)
// ---------------------------------------------------------------------------

function clearStaleHeroPreviewMutedPreference() {
  try {
    localStorage.removeItem(STALE_HERO_PREVIEW_MUTED_PREF_KEY);
  } catch {
    // Ignore localStorage failures.
  }
}

function isLibraryEditModeEnabled() {
  try {
    const raw = String(localStorage.getItem(LIBRARY_EDIT_MODE_PREF_KEY) || "")
      .trim()
      .toLowerCase();
    return raw === "1" || raw === "true" || raw === "on";
  } catch {
    return false;
  }
}

function applyLibraryEditModeClass() {
  document.body.classList.toggle("library-edit-mode", isLibraryEditModeEnabled());
}

function getLibraryEditTargetFromCard(card) {
  const type = String(card?.dataset?.libraryType || "")
    .trim()
    .toLowerCase();
  const id = String(card?.dataset?.libraryId || "").trim();
  const src = String(card?.dataset?.librarySrc || card?.dataset?.src || "").trim();
  if ((type !== "movie" && type !== "series") || (!id && !src)) {
    return null;
  }
  return { type, id, src };
}

function normalizeLibraryPayloadForEdit(value) {
  const payload = value && typeof value === "object" ? value : {};
  const movies = Array.isArray(payload.movies)
    ? payload.movies.filter((entry) => entry && typeof entry === "object")
    : [];
  const series = Array.isArray(payload.series)
    ? payload.series.filter((entry) => entry && typeof entry === "object")
    : [];
  return { movies, series };
}

function normalizeLibrarySeriesContentKind(value) {
  return String(value || "")
    .trim()
    .toLowerCase() === "course"
    ? "course"
    : "series";
}

function normalizeLibraryEditCategory(itemType, value) {
  const normalizedItemType = String(itemType || "")
    .trim()
    .toLowerCase();
  const normalizedCategory = String(value || "")
    .trim()
    .toLowerCase();
  if (normalizedItemType === "series") {
    if (
      normalizedCategory === "title" ||
      normalizedCategory === "episodes"
    ) {
      return normalizedCategory;
    }
    return "title";
  }
  return "details";
}

function findLibraryEditEntry(library, target) {
  if (!library || !target) {
    return null;
  }

  if (target.type === "movie") {
    const movieIndex = library.movies.findIndex((entry) => {
      const entryId = String(entry?.id || "").trim();
      const entrySrc = String(entry?.src || "").trim();
      if (target.id && entryId === target.id) {
        return true;
      }
      if (target.src && entrySrc === target.src) {
        return true;
      }
      return false;
    });
    if (movieIndex >= 0) {
      return {
        itemType: "movie",
        itemIndex: movieIndex,
      };
    }
    return null;
  }

  const seriesIndex = library.series.findIndex((entry) => {
    const entryId = String(entry?.id || "").trim();
    if (target.id && entryId === target.id) {
      return true;
    }
    if (
      target.src &&
      Array.isArray(entry?.episodes) &&
      entry.episodes.some(
        (episode) => String(episode?.src || "").trim() === target.src,
      )
    ) {
      return true;
    }
    return false;
  });
  if (seriesIndex >= 0) {
    return {
      itemType: "series",
      itemIndex: seriesIndex,
    };
  }
  return null;
}

function renderLibraryEditMovieFieldsHtml(item = {}) {
  return `
    <div class="library-edit-grid" data-editor-type="movie">
      <div class="library-edit-field">
        <label>Title</label>
        <input data-field="title" type="text" value="${escapeHtml(item.title || "")}" />
      </div>
      <div class="library-edit-field">
        <label>Year</label>
        <input data-field="year" type="text" value="${escapeHtml(item.year || "")}" />
      </div>
      <div class="library-edit-field">
        <label>TMDB ID</label>
        <input data-field="tmdbId" type="text" value="${escapeHtml(item.tmdbId || "")}" />
      </div>
      <div class="library-edit-field">
        <label>Thumbnail</label>
        <input data-field="thumb" type="text" value="${escapeHtml(item.thumb || "")}" />
      </div>
      <div class="library-edit-field library-edit-field--full">
        <label>Source Path</label>
        <input data-field="src" type="text" value="${escapeHtml(item.src || "")}" />
      </div>
      <div class="library-edit-field library-edit-field--full">
        <label>Description</label>
        <textarea data-field="description">${escapeHtml(item.description || "")}</textarea>
      </div>
    </div>
  `;
}

function renderLibraryEditSeriesEpisodeHtml(episode = {}, index = 0, contentKind = "series") {
  const itemLabel = contentKind === "course" ? "Lesson" : "Episode";
  return `
    <article class="library-edit-episode" data-episode-index="${index}">
      <div class="library-edit-episode-head">
        <strong>${itemLabel} ${index + 1}</strong>
        <button type="button" class="library-edit-episode-delete" data-action="delete-episode" data-episode-index="${index}">Remove</button>
      </div>
      <div class="library-edit-grid">
        <div class="library-edit-field library-edit-field--full">
          <label>${itemLabel} Title</label>
          <input data-episode-field="title" type="text" value="${escapeHtml(episode.title || "")}" />
        </div>
        <div class="library-edit-field">
          <label>${contentKind === "course" ? "Module" : "Season"}</label>
          <input data-episode-field="seasonNumber" type="number" min="1" step="1" value="${escapeHtml(episode.seasonNumber || 1)}" />
        </div>
        <div class="library-edit-field">
          <label>${itemLabel} #</label>
          <input data-episode-field="episodeNumber" type="number" min="1" step="1" value="${escapeHtml(episode.episodeNumber || index + 1)}" />
        </div>
        <div class="library-edit-field library-edit-field--full">
          <label>Source Path</label>
          <input data-episode-field="src" type="text" value="${escapeHtml(episode.src || "")}" />
        </div>
        <div class="library-edit-field library-edit-field--full">
          <label>Thumbnail</label>
          <input data-episode-field="thumb" type="text" value="${escapeHtml(episode.thumb || "")}" />
        </div>
        <div class="library-edit-field library-edit-field--full">
          <label>Description</label>
          <textarea data-episode-field="description">${escapeHtml(episode.description || "")}</textarea>
        </div>
      </div>
    </article>
  `;
}

function renderLibraryEditSeriesFieldsHtml(item = {}, activeCat = "title") {
  const contentKind = normalizeLibrarySeriesContentKind(item?.contentKind || "");
  const episodes = Array.isArray(item?.episodes) ? item.episodes : [];
  const activeCategory = normalizeLibraryEditCategory("series", activeCat);
  const itemLabel = contentKind === "course" ? "Lesson" : "Episode";
  const categoryTabs = `
    <div class="library-edit-categories" role="tablist" aria-label="Series editor categories">
      <button type="button" class="library-edit-category-btn ${activeCategory === "title" ? "is-active" : ""}" data-library-edit-category="title" aria-pressed="${activeCategory === "title" ? "true" : "false"}">Series</button>
      <button type="button" class="library-edit-category-btn ${activeCategory === "episodes" ? "is-active" : ""}" data-library-edit-category="episodes" aria-pressed="${activeCategory === "episodes" ? "true" : "false"}">Episodes</button>
    </div>
  `;
  if (activeCategory === "title") {
    return `${categoryTabs}
      <section class="library-edit-category-panel is-active" data-library-edit-panel="title">
        <div class="library-edit-grid" data-editor-type="series">
          <div class="library-edit-field">
            <label>Title</label>
            <input data-field="title" type="text" value="${escapeHtml(item.title || "")}" />
          </div>
          <div class="library-edit-field">
            <label>Year</label>
            <input data-field="year" type="text" value="${escapeHtml(item.year || "")}" />
          </div>
          <div class="library-edit-field">
            <label>TMDB ID</label>
            <input data-field="tmdbId" type="text" value="${escapeHtml(item.tmdbId || "")}" />
          </div>
          <div class="library-edit-field">
            <label>Type</label>
            <select data-field="contentKind">
              <option value="series" ${contentKind === "series" ? "selected" : ""}>Series</option>
              <option value="course" ${contentKind === "course" ? "selected" : ""}>Course</option>
            </select>
          </div>
        </div>
      </section>`;
  }
  if (activeCategory === "episodes") {
    return `${categoryTabs}
      <section class="library-edit-category-panel is-active" data-library-edit-panel="episodes">
        <div class="library-edit-panel-header">
          <p>Edit existing ${itemLabel.toLowerCase()} metadata here.</p>
        </div>
        <section class="library-edit-episodes">
        ${episodes
          .map((episode, index) =>
            renderLibraryEditSeriesEpisodeHtml(episode, index, contentKind),
          )
          .join("")}
        </section>
      </section>`;
  }
  return `${categoryTabs}
    <section class="library-edit-category-panel is-active" data-library-edit-panel="episodes">
      <div class="library-edit-panel-header">
        <p>Edit existing ${itemLabel.toLowerCase()} metadata here.</p>
      </div>
      <section class="library-edit-episodes">
      ${episodes
        .map((episode, index) =>
          renderLibraryEditSeriesEpisodeHtml(episode, index, contentKind),
        )
        .join("")}
      </section>
    </section>`;
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

async function apiFetchWithTimeout(path, params = {}, timeoutMs = 2500) {
  const query = new URLSearchParams(params);
  const url = query.size ? `${path}?${query.toString()}` : path;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error || `Request failed (${response.status})`);
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function getFeaturedHeroMaturityLabel(feature) {
  return normalizeCertification(feature?.maturity);
}

function createFeaturedHeroFromLocalEntry(entry) {
  const source = entry && typeof entry === "object" ? entry : {};
  const item = source.item && typeof source.item === "object" ? source.item : {};
  const entryType = String(source.type || "").trim().toLowerCase();
  const isSeries = entryType === "series";
  const episodes = Array.isArray(item.episodes) ? item.episodes : [];
  const firstEpisode = isSeries
    ? episodes.find((episode) => String(episode?.src || "").trim()) ||
      episodes[0]
    : null;
  const contentKind = String(item.contentKind || "")
    .trim()
    .toLowerCase();
  const isCourse =
    isSeries &&
    (contentKind === "course" ||
      /\b(course|lesson|module|class|lecture|webinar)\b/i.test(
        `${item.title || ""} ${item.id || ""}`.trim(),
      ));
  const title = isSeries
    ? String(item.title || (isCourse ? "Local Course" : "Local Series")).trim()
    : normalizeLocalMovieDisplayTitle(item.title || "Local Movie");
  const src = String(isSeries ? firstEpisode?.src || "" : item.src || "").trim();
  const storedThumb = String(
    isSeries ? firstEpisode?.thumb || "" : item.thumb || "",
  ).trim();
  const fallbackThumb = getFallbackThumbnailForSource(src) || DEFAULT_LOCAL_THUMBNAIL;
  const poster = normalizeArtworkPath(storedThumb || fallbackThumb);
  const episodeIndex = isSeries
    ? Math.max(0, episodes.indexOf(firstEpisode))
    : -1;
  const runtime = isSeries ? (isCourse ? "Course" : "Series") : "Movie";
  const description =
    String(
      isSeries
        ? firstEpisode?.description || item.description || ""
        : item.description || "",
    ).trim() ||
    (isSeries
      ? isCourse
        ? "Uploaded lessons from your local library."
        : "Uploaded episodes from your local library."
      : "Uploaded from your local library.");
  const year = String(item.year || "").trim() || "Local";

  return {
    title,
    tmdbId: String(item.tmdbId || "").trim(),
    mediaType: isSeries ? "tv" : "movie",
    year,
    runtime,
    maturity: UNRATED_CERTIFICATION_LABEL,
    tagline: isSeries
      ? isCourse
        ? "Continue a saved course from your library."
        : "Continue a saved series from your library."
      : "Available from your local library.",
    description,
    poster,
    thumb: poster,
    src,
    seriesId: isSeries ? String(item.id || "").trim() : "",
    episode: isSeries ? String(firstEpisode?.title || "").trim() : "",
    episodeIndex,
    seasonNumber: isSeries ? Number(firstEpisode?.seasonNumber || 1) : 0,
    episodeNumber: isSeries ? Number(firstEpisode?.episodeNumber || episodeIndex + 1) : 0,
    previewSrc: "",
    trailerKey: "",
    callouts: [
      "Available locally",
      isSeries ? (isCourse ? "Course" : "Series") : "Movie",
    ],
    ready: true,
  };
}

// Local preview files are optional. The normal path is the official trailer key
// hydrated from TMDB details; these hooks keep the cached-file path available
// without making the page depend on a generated manifest.
function normalizeHeroPreviewPath(value) {
  return "";
}

async function fetchHeroPreviewManifest() {
  return new Map();
}

function createSearchResultDetails(item, imageBase = TMDB_IMAGE_BASE) {
  const mediaType =
    String(item?.mediaType || "")
      .trim()
      .toLowerCase() === "tv"
      ? "tv"
      : "movie";
  const title =
    String(item?.title || item?.name || "").trim() ||
    (mediaType === "tv" ? "Series" : "Movie");
  const releaseDate = String(
    mediaType === "tv"
      ? item?.firstAirDate || item?.releaseDate || ""
      : item?.releaseDate || item?.firstAirDate || "",
  ).trim();
  const year = releaseDate ? releaseDate.slice(0, 4) : "";
  const backdropPath = String(item?.backdropPath || item?.posterPath || "").trim();
  const posterPath = String(item?.posterPath || item?.backdropPath || "").trim();
  const heroUrl = backdropPath
    ? `${imageBase}/w780${backdropPath}`
    : posterPath
      ? `${imageBase}/w500${posterPath}`
      : "assets/images/thumbnail.jpg";
  const description =
    String(item?.overview || "").trim() || "No description available.";
  return {
    title,
    episode: "",
    src: "",
    thumb: heroUrl,
    tmdbId: String(item?.id || "").trim(),
    mediaType,
    year,
    runtime: "",
    maturity: normalizeCertification(item?.certification),
    quality: "",
    audio: "",
    description,
    cast: "Loading cast...",
    genres: "",
    vibe: "",
  };
}

function getCardDetails(card) {
  const rawEpisodeIndex = Number(card.dataset.episodeIndex || -1);
  const rawSeasonNumber = Number(card.dataset.seasonNumber || 0);
  const rawEpisodeNumber = Number(card.dataset.episodeNumber || 0);
  return {
    title: card.dataset.title || "Title",
    episode: card.dataset.episode || "",
    src: card.dataset.src || "",
    thumb:
      card.dataset.thumb ||
      card.querySelector("img")?.getAttribute("src") ||
      "",
    tmdbId: card.dataset.tmdbId || "",
    mediaType: card.dataset.mediaType || "",
    seriesId: card.dataset.seriesId || "",
    libraryType: card.dataset.libraryType || "",
    libraryId: card.dataset.libraryId || "",
    librarySrc: card.dataset.librarySrc || "",
    resumeSource: card.dataset.resumeSource || "",
    episodeIndex: Number.isFinite(rawEpisodeIndex) ? rawEpisodeIndex : -1,
    seasonNumber: Number.isFinite(rawSeasonNumber) ? rawSeasonNumber : 0,
    episodeNumber: Number.isFinite(rawEpisodeNumber) ? rawEpisodeNumber : 0,
    year: card.dataset.year || "",
  };
}

function getCardModalData(card) {
  const previewImage = card.querySelector("img");
  return {
    ...getCardDetails(card),
    thumb:
      card.dataset.thumb ||
      previewImage?.getAttribute("src") ||
      "assets/images/thumbnail.jpg",
    year: card.dataset.year || "",
    runtime: card.dataset.runtime || "",
    maturity: normalizeCertification(card.dataset.maturity),
    quality: card.dataset.quality || "",
    audio: card.dataset.audio || "",
    description: card.dataset.description || "No description available.",
    cast: card.dataset.cast || "",
    genres: card.dataset.genres || "",
    vibe: card.dataset.vibe || "",
  };
}

function getRecommendationIdentity(details) {
  const src = String(details?.src || "")
    .trim()
    .toLowerCase();
  if (src) {
    return `src:${src}`;
  }
  const mediaType = String(details?.mediaType || "")
    .trim()
    .toLowerCase();
  const tmdbId = String(details?.tmdbId || "").trim();
  if (mediaType && tmdbId) {
    return `tmdb:${mediaType}:${tmdbId}`;
  }
  const seriesId = String(details?.seriesId || "")
    .trim()
    .toLowerCase();
  if (seriesId) {
    const episodeIndex = Number(details?.episodeIndex);
    return Number.isFinite(episodeIndex) && episodeIndex >= 0
      ? `series:${seriesId}:episode:${Math.floor(episodeIndex)}`
      : `series:${seriesId}`;
  }
  const title = String(details?.title || "")
    .trim()
    .toLowerCase();
  const year = String(details?.year || "").trim();
  return title ? `title:${title}|${year}` : "";
}

function normalizeLibraryTitleKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeMyListEntry(entry) {
  const details = entry && typeof entry === "object" ? entry : {};
  const normalizedEpisodeIndex = Number(details.episodeIndex);
  const normalized = {
    title: String(details.title || "").trim() || "Untitled",
    episode: String(details.episode || "").trim(),
    src: String(details.src || "").trim(),
    thumb: String(details.thumb || "").trim() || "assets/images/thumbnail.jpg",
    tmdbId: String(details.tmdbId || "").trim(),
    mediaType: String(details.mediaType || "")
      .trim()
      .toLowerCase(),
    seriesId: String(details.seriesId || "").trim(),
    year: String(details.year || "").trim(),
    libraryType: String(details.libraryType || "").trim(),
    libraryId: String(details.libraryId || "").trim(),
    librarySrc: String(details.librarySrc || "").trim(),
    episodeIndex:
      Number.isFinite(normalizedEpisodeIndex) && normalizedEpisodeIndex >= 0
        ? Math.floor(normalizedEpisodeIndex)
        : -1,
    addedAt: Number(details.addedAt) || Date.now(),
  };
  normalized.itemIdentity =
    String(details.itemIdentity || "").trim() ||
    getRecommendationIdentity(normalized);
  return normalized;
}

function findLocalMovieForMyListEntry(entry, libraryEntries = []) {
  const details = normalizeMyListEntry(entry);
  const tmdbId = String(details.tmdbId || "").trim();
  const titleKey = normalizeLibraryTitleKey(details.title || "");
  const year = String(details.year || "").trim();
  return (
    (Array.isArray(libraryEntries) ? libraryEntries : [])
      .filter((candidate) => candidate?.type === "movie")
      .map((candidate) => candidate.item)
      .find((movie) => {
        const src = String(movie?.src || "").trim();
        if (!src) {
          return false;
        }
        const movieTmdbId = String(movie?.tmdbId || "").trim();
        if (tmdbId && movieTmdbId && tmdbId === movieTmdbId) {
          return true;
        }
        const movieTitleKey = normalizeLibraryTitleKey(movie?.title || "");
        const movieYear = String(movie?.year || "").trim();
        return Boolean(
          titleKey &&
            movieTitleKey &&
            titleKey === movieTitleKey &&
            (!year || !movieYear || year === movieYear),
        );
      }) || null
  );
}

function hydrateMyListEntryWithLocalLibrary(entry, libraryEntries = []) {
  const normalized = normalizeMyListEntry(entry);
  if (normalized.mediaType === "tv" || normalized.seriesId) {
    return normalized;
  }

  const localMovie = findLocalMovieForMyListEntry(normalized, libraryEntries);
  const localSrc = String(localMovie?.src || "").trim();
  if (!localSrc) {
    return normalized;
  }

  const hydrated = {
    ...normalized,
    title:
      String(localMovie?.title || "").trim() ||
      String(normalized.title || "").trim(),
    src: localSrc,
    thumb:
      String(localMovie?.thumb || "").trim() ||
      String(normalized.thumb || "").trim(),
    tmdbId:
      String(localMovie?.tmdbId || "").trim() ||
      String(normalized.tmdbId || "").trim(),
    mediaType: "movie",
    year:
      String(localMovie?.year || "").trim() ||
      String(normalized.year || "").trim(),
    libraryType: "movie",
    libraryId: String(localMovie?.id || normalized.libraryId || "").trim(),
    librarySrc: localSrc,
  };
  hydrated.itemIdentity = getRecommendationIdentity(hydrated);
  return hydrated;
}

function readMyListEntries() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MY_LIST_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.map(normalizeMyListEntry) : [];
  } catch {
    return [];
  }
}

async function writeMyListEntries(entries, owner) {
  const safeEntries = Array.isArray(entries)
    ? entries.map(normalizeMyListEntry)
    : [];
  const response = await fetch("/api/user/my-list", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries: safeEntries }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Couldn’t save your list. Please try again.");
  if (getHydrationState().authExpired || String(window.__currentUser?.id || "") !== owner) return null;
  localStorage.setItem(MY_LIST_STORAGE_KEY, JSON.stringify(safeEntries));
  return safeEntries;
}

function isMyListEntryActive(details) {
  const targetIdentity = getRecommendationIdentity(details);
  if (!targetIdentity) {
    return false;
  }
  return readMyListEntries().some(
    (entry) => getRecommendationIdentity(entry) === targetIdentity,
  );
}

async function toggleMyList(details) {
  const owner = String(window.__currentUser?.id || "");
  const hydration = getHydrationState();
  if (hydration.pending || !hydration.didLoadMyList) {
    const result = await beginServerHydration().myListReady;
    if (!result.didLoadMyList) throw new Error("Your list couldn’t sync. Try again before making changes.");
  }
  if (!owner || getHydrationState().authExpired || String(window.__currentUser?.id || "") !== owner) {
    return null;
  }
  const normalizedDetails = normalizeMyListEntry(details);
  const targetIdentity = getRecommendationIdentity(normalizedDetails);
  if (!targetIdentity) {
    return false;
  }
  const entries = readMyListEntries();
  const existingIndex = entries.findIndex(
    (entry) => getRecommendationIdentity(entry) === targetIdentity,
  );
  if (existingIndex >= 0) {
    entries.splice(existingIndex, 1);
    return await writeMyListEntries(entries, owner) ? false : null;
  }
  if (entries.length >= 100) throw new Error("Your list has 100 titles. Remove one before adding another.");
  entries.unshift({
    ...normalizedDetails,
    addedAt: Date.now(),
  });
  return await writeMyListEntries(entries, owner) ? true : null;
}

function readMyListViewState() {
  const params = new URLSearchParams(window.location.search);
  return {
    active: params.get("view") === "my-list" || window.location.hash === "#myListRow",
    type: ["movie", "tv"].includes(params.get("type")) ? params.get("type") : "all",
    sort: ["title", "year"].includes(params.get("sort")) ? params.get("sort") : "recent",
  };
}

function myListViewUrl(type = "all", sort = "recent") {
  const params = new URLSearchParams({ view: "my-list" });
  if (type !== "all") params.set("type", type);
  if (sort !== "recent") params.set("sort", sort);
  return `/?${params}`;
}

function mapDetailsToModalPatch(rawDetails, currentDetails, mediaType) {
  const castList = (rawDetails.credits?.cast || [])
    .slice(0, 4)
    .map((person) => person.name);
  const genresList = (rawDetails.genres || [])
    .slice(0, 4)
    .map((genre) => genre.name);
  const runtime =
    mediaType === "movie"
      ? formatRuntime(rawDetails.runtime)
      : formatRuntime(rawDetails.episode_run_time?.[0]);
  return {
    year: String(rawDetails.release_date || rawDetails.first_air_date || "").slice(0, 4) || currentDetails.year,
    runtime: mediaType === "tv" && rawDetails.number_of_seasons > 0
      ? `${rawDetails.number_of_seasons} ${rawDetails.number_of_seasons === 1 ? "season" : "seasons"}`
      : runtime || "",
    maturity: normalizeCertification(
      rawDetails.certification || currentDetails.maturity,
    ),
    description: rawDetails.overview || currentDetails.description,
    cast: castList.join(", "),
    genres: genresList.length ? genresList.join(", ") : currentDetails.genres,
    vibe: rawDetails.tagline ? rawDetails.tagline : currentDetails.vibe,
    seasons: mediaType === "tv" ? rawDetails.seasons || [] : [],
  };
}

function readRequiredLibraryInput(root, selector, errorMessage) {
  const value = String(root.querySelector(selector)?.value || "").trim();
  if (!value) {
    throw new Error(errorMessage);
  }
  return value;
}

function readLibraryPositiveInteger(root, selector, fallback = 1) {
  const value = Number(root.querySelector(selector)?.value || fallback);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

// ---------------------------------------------------------------------------
// TMDB details cache (module-level, not a signal since it's imperative)
// ---------------------------------------------------------------------------
const tmdbDetailsCache = new Map();
const TMDB_DETAILS_CACHE_MAX = 200;
const TMDB_DETAILS_ENRICHMENT_TIMEOUT_MS = 2500;
const TMDB_DETAILS_MODAL_TIMEOUT_MS = 6000;

function setTmdbDetailsCache(key, value) {
  tmdbDetailsCache.delete(key);
  if (tmdbDetailsCache.size >= TMDB_DETAILS_CACHE_MAX) {
    const firstKey = tmdbDetailsCache.keys().next().value;
    tmdbDetailsCache.delete(firstKey);
  }
  tmdbDetailsCache.set(key, value);
}

// ---------------------------------------------------------------------------
// HomePage SolidJS Component
// ---------------------------------------------------------------------------
export default function HomePage() {
  // ---- Refs ----
  let heroPreviewFrameRef;
  let heroSectionRef;
  let heroPreviewInViewport = true;
  let pageRootRef;
  let continueCardsRef;
  let cardsContainerRef;
  let trendingCardsContainerRef;
  let nowPlayingCardsContainerRef;
  let topRatedCardsContainerRef;
  let myListCardsRef;
  let libraryCardsRef;
  let myListLibraryEntries = [];
  let myListRenderSignature = "";
  let homeLibrarySnapshot = readInjectedHomeBootstrap()?.library || null;
  let continueEntriesSignature = "";
  const continueDetailsCache = new Map();
  const continueDetailsRequests = new Map();
  const initialHydration = getHydrationState();
  const initiallyPendingContinue = initialHydration.pending && !initialHydration.didLoadContinueWatching;
  let libraryEditFieldsRef;
  let navSearchInputRef;
  let detailsCloseButtonRef;
  let detailsSheetRef;
  let accountMenuPanelRef;
  let searchContextMenuRef;
  let liveViewLoadPromise = null;
  let accountHydratePromise = null;
  let captureSearchReturnState = null;
  const initialSearch = readSearchLocation(window.location.href);

  // ---- Signals ----
  const [isMuted, setIsMuted] = createSignal(true);
  const [heroMotionPaused, setHeroMotionPaused] = createSignal(false);
  const [isSearchModeActive, setIsSearchModeActive] = createSignal(false);
  const [searchState, setSearchState] = createSignal(initialSearch.state);
  const [searchRestoreFocus, setSearchRestoreFocus] = createSignal(false);
  const [showSearchExperience, setShowSearchExperience] = createSignal(false);
  const [showSearchBox, setShowSearchBox] = createSignal(false);
  const [searchBoxOpen, setSearchBoxOpen] = createSignal(false);
  const [accountMenuOpen, setAccountMenuOpen] = createSignal(false);
  const [featuredHero, setFeaturedHero] = createSignal(
    createDefaultFeaturedHero(UNRATED_CERTIFICATION_LABEL),
  );
  const [featuredHeroReady, setFeaturedHeroReady] = createSignal(false);
  const [featuredHeroCandidates, setFeaturedHeroCandidates] = createSignal([]);
  const [featuredHeroIndex, setFeaturedHeroIndex] = createSignal(0);
  const [heroPreviewActive, setHeroPreviewActive] = createSignal(false);
  const [heroPreviewPlaying, setHeroPreviewPlaying] = createSignal(false);

  const [continueRowVisible, setContinueRowVisible] = createSignal(
    initiallyPendingContinue || getContinueWatchingEntries().length > 0,
  );
  const [continueLoading, setContinueLoading] = createSignal(initiallyPendingContinue);
  const [continueEmptyVisible, setContinueEmptyVisible] = createSignal(false);
  const [popularRowVisible, setPopularRowVisible] = createSignal(false);
  const [popularRowTitle, setPopularRowTitle] = createSignal("Trending Now");
  const [trendingRowVisible, setTrendingRowVisible] = createSignal(false);
  const [nowPlayingRowVisible, setNowPlayingRowVisible] = createSignal(false);
  const [topRatedRowVisible, setTopRatedRowVisible] = createSignal(false);
  const [myListRowVisible, setMyListRowVisible] = createSignal(false);
  const [libraryRowVisible, setLibraryRowVisible] = createSignal(false);
  const [savedTitles, setSavedTitles] = createSignal([]);
  const [myListLoading, setMyListLoading] = createSignal(initialHydration.pending && !initialHydration.didLoadMyList);
  const [myListLoadError, setMyListLoadError] = createSignal(!initialHydration.pending && !initialHydration.didLoadMyList);
  const [myListSaving, setMyListSaving] = createSignal(false);
  const [myListNotice, setMyListNotice] = createSignal("");
  const [myListNoticeError, setMyListNoticeError] = createSignal(false);
  const initialListView = readMyListViewState();
  const [myListType, setMyListType] = createSignal(initialListView.type);
  const [myListSort, setMyListSort] = createSignal(initialListView.sort);
  const [activeView, setActiveView] = createSignal(initialListView.active ? "my-list" : "home");
  const [LiveChannelsComponent, setLiveChannelsComponent] = createSignal(null);

  const [detailsModalVisible, setDetailsModalVisible] = createSignal(false);
  const [detailsModalOpen, setDetailsModalOpen] = createSignal(false);
  const [detailsData, setDetailsData] = createSignal({
    thumb: DEFAULT_LOCAL_THUMBNAIL,
    title: "POPULAR MOVIES",
    year: "",
    runtime: "",
    maturity: UNRATED_CERTIFICATION_LABEL,
    quality: "",
    audio: "",
    description: "Pick a title to see details.",
    cast: "",
    genres: "",
    vibe: "",
  });
  const [detailsLoadState, setDetailsLoadState] = createSignal("ready");
  const [detailsMyListActive, setDetailsMyListActive] = createSignal(false);
  const [detailsResume, setDetailsResume] = createSignal(null);

  const [libraryEditModalVisible, setLibraryEditModalVisible] = createSignal(false);
  const [libraryEditModalOpen, setLibraryEditModalOpen] = createSignal(false);
  const [libraryEditModalTitleText, setLibraryEditModalTitleText] = createSignal("Edit Title");
  const [libraryEditModalMetaText, setLibraryEditModalMetaText] = createSignal("");
  const [libraryEditStatusText, setLibraryEditStatusText] = createSignal("");
  const [libraryEditStatusTone, setLibraryEditStatusTone] = createSignal("");
  const [libraryAddEpisodeVisible, setLibraryAddEpisodeVisible] = createSignal(false);
  const [libraryAddEpisodeBtnText, setLibraryAddEpisodeBtnText] = createSignal("Add Episode");
  const [librarySaveBtnVisible, setLibrarySaveBtnVisible] = createSignal(true);
  const [libraryDeleteBtnVisible, setLibraryDeleteBtnVisible] = createSignal(true);

  const [searchContextMenuVisible, setSearchContextMenuVisible] = createSignal(false);

  const [avatarClassName, setAvatarClassName] = createSignal("avatar avatar-style-blue");
  const [avatarImageSrc, setAvatarImageSrc] = createSignal("");


  // ---- Mutable state (not signals, imperative tracking) ----
  let activeDetails = null;
  let activeDetailsCard = null;
  let detailsTrigger = null;
  let closeModalTimer = null;
  let detailsRequestVersion = 0;
  let continueWatchingLoadVersion = 0;
  let featuredHeroDetailsRequestVersion = 0;
  let heroCarouselTimer = null;
  let heroPreviewStartedTrailerKey = "";
  let searchContextTarget = null;
  let searchBoxHideTimer = null;
  let myListNoticeTimer = null;
  let libraryEditModalCloseTimer = null;
  let activeLibraryEditContext = null;
  let isSavingLibraryEdit = false;
  let activeLibraryEditCategory = "title";
  let homeBrowseContentReady = false;
  const movieResolvePrewarmer = createMovieResolvePrewarmer({
    fetchFn: (url, options) => fetch(url, options),
    buildUrl: buildResolvePrewarmUrl,
  });

  function prewarmCardMovieSource(card) {
    if (document.hidden || isConstrainedConnection() || activeView() !== "home") return false;
    const details = getCardDetails(card);
    const tmdbId = String(details.tmdbId || "").trim();
    const mediaType = String(details.mediaType || "").trim();
    if (
      // Browsing a series doesn't choose an episode. Resolving S1 E1 here
      // wastes a provider request, especially when the viewer will resume later.
      mediaType !== "movie" ||
      !tmdbId ||
      details.resumeSource ||
      String(details.src || details.librarySrc || "").trim()
    ) {
      return false;
    }
    return movieResolvePrewarmer.prewarm({
      tmdbId,
      mediaType,
      title: details.title,
      year: details.year,
      seasonNumber: details.seasonNumber || 1,
      episodeNumber: details.episodeNumber || 1,
      ...getInitialTmdbResolvePreferences({
        tmdbId, mediaType,
        seasonNumber: details.seasonNumber || 1,
        episodeNumber: details.episodeNumber || 1,
      }),
    });
  }

  function markHomeBrowseContentReady() {
    homeBrowseContentReady = true;
  }

  function refreshAccountBackedCaches() {
    if (accountHydratePromise) {
      return accountHydratePromise;
    }
    accountHydratePromise = hydrateFromServer().finally(() => {
      accountHydratePromise = null;
    });
    return accountHydratePromise;
  }

  function isConstrainedConnection() {
    const connection = navigator.connection;
    return connection?.saveData || ["slow-2g", "2g", "3g"].includes(connection?.effectiveType);
  }

  // ---- Player navigation ----
  function openPlayerPage({
    title,
    episode,
    src,
    librarySrc,
    thumb,
    tmdbId,
    mediaType,
    year,
    seriesId,
    episodeIndex,
    seasonNumber,
    episodeNumber,
    resumeSource,
    saveToGallery = false,
  }) {
    if (isSearchModeActive()) captureSearchReturnState?.();
    movieResolvePrewarmer.pause();
    stopHeroPreview();
    const normalizePlaybackSource = (value) => {
      const raw = String(value || "").trim();
      if (!raw) {
        return "";
      }
      if (/^(https?:)?\/\//i.test(raw) || raw.startsWith("/")) {
        return raw;
      }
      if (raw.startsWith("assets/")) {
        return `/${raw}`;
      }
      return raw;
    };
    const normalizedSrc = normalizePlaybackSource(src);
    const normalizedLibrarySrc = normalizePlaybackSource(librarySrc);
    const playbackSrc = normalizedSrc || normalizedLibrarySrc;
    const normalizedMediaType = String(mediaType || "")
      .trim()
      .toLowerCase();
    const normalizedSeriesId = String(seriesId || "").trim();
    const parsedEpisodeIndex = Number(episodeIndex);
    const hasEpisodeIndex =
      Number.isFinite(parsedEpisodeIndex) && parsedEpisodeIndex >= 0;
    const parsedSeasonNumber = Number(seasonNumber);
    const parsedEpisodeNumber = Number(episodeNumber);
    const isSeriesLaunch =
      normalizedMediaType === "tv" ||
      (!normalizedMediaType && Boolean(normalizedSeriesId) && hasEpisodeIndex);

    const params = new URLSearchParams({
      title: title || "Title",
    });

    const normalizedEpisode = String(episode || "").trim();
    if (normalizedEpisode) {
      params.set("episode", normalizedEpisode);
    }

    if (playbackSrc) {
      params.set("src", playbackSrc);
    }
    if (thumb) {
      params.set("thumb", thumb);
    }

    if (tmdbId) {
      params.set("tmdbId", tmdbId);
    }

    if (normalizedMediaType === "movie" || normalizedMediaType === "tv") {
      params.set("mediaType", normalizedMediaType);
    } else if (isSeriesLaunch) {
      params.set("mediaType", "tv");
    }

    if (year) {
      params.set("year", year);
    }

    if (saveToGallery === true) {
      params.set("saveToGallery", "1");
    }
    if (String(resumeSource || "").trim()) {
      params.set("resumePlayback", "1");
    }

    if (isSeriesLaunch && normalizedSeriesId) {
      params.set("seriesId", normalizedSeriesId);
    }

    if (isSeriesLaunch && hasEpisodeIndex) {
      params.set("episodeIndex", String(Math.floor(parsedEpisodeIndex)));
    }

    if (
      isSeriesLaunch &&
      Number.isFinite(parsedSeasonNumber) &&
      parsedSeasonNumber > 0
    ) {
      params.set("seasonNumber", String(Math.floor(parsedSeasonNumber)));
    }

    if (
      isSeriesLaunch &&
      Number.isFinite(parsedEpisodeNumber) &&
      parsedEpisodeNumber > 0
    ) {
      params.set("episodeNumber", String(Math.floor(parsedEpisodeNumber)));
    }

    if (!playbackSrc && tmdbId && normalizedMediaType === "movie") {
      const preferredAudioLang = getStoredAudioLangForTmdbMovie(tmdbId);
      if (preferredAudioLang !== "auto") {
        params.set("audioLang", preferredAudioLang);
      }
    }

    const normalizedSource = String(playbackSrc || "")
      .trim()
      .toLowerCase();
    const isUploadedLocalMedia =
      normalizedSource.startsWith("/media/") ||
      normalizedSource.includes("/media/") ||
      normalizedSource.startsWith("/videos/") ||
      normalizedSource.startsWith("videos/") ||
      normalizedSource.includes("/videos/") ||
      normalizedSource.startsWith("assets/videos/") ||
      normalizedSource.includes("/assets/videos/");
    if (playbackSrc && isUploadedLocalMedia && !params.has("audioLang")) {
      params.set("audioLang", "en");
    }

    const _slug = slugifyTitle(title || "Title");
    addCurrentReturnToParam(params);
    // Full params (title, poster, audioLang, returnTo, …) are stashed so a warm
    // reload restores everything; the visible URL stays short.
    saveWatchParams(_slug, params.toString(), {
      tmdbId: params.get("tmdbId") || "",
      seriesId: params.get("seriesId") || "",
    });
    const _tmdbId = params.get("tmdbId") || "";
    const _urlMediaType = params.get("mediaType") || "";
    const _isTmdbCatalogTitle =
      Boolean(_tmdbId) &&
      (_urlMediaType === "movie" || _urlMediaType === "tv") &&
      !playbackSrc;
    const playerUrl = _isTmdbCatalogTitle
      ? buildTmdbWatchPath({
          mediaType: _urlMediaType,
          tmdbId: _tmdbId,
          title,
          seasonNumber:
            _urlMediaType === "tv" ? Number(params.get("seasonNumber")) || null : null,
          episodeNumber:
            _urlMediaType === "tv" ? Number(params.get("episodeNumber")) || null : null,
        })
      : buildWatchUrl(params);
    window.location.href = playerUrl;
  }

  function getHeroDestination() {
    const hero = featuredHero();
    if (!hero?.tmdbId && !hero?.src && !hero?.seriesId) {
      return null;
    }
    return {
      title: hero.title || "Popular Movie",
      episode: hero.episode || "",
      src: hero.src || "",
      mediaType: hero.mediaType || "movie",
      tmdbId: hero.tmdbId || "",
      year: hero.year || "",
      thumb: hero.thumb || hero.poster || "assets/images/thumbnail.jpg",
      seriesId: hero.seriesId || "",
      episodeIndex: Number.isFinite(Number(hero.episodeIndex))
        ? Number(hero.episodeIndex)
        : -1,
      seasonNumber: Number.isFinite(Number(hero.seasonNumber))
        ? Number(hero.seasonNumber)
        : 0,
      episodeNumber: Number.isFinite(Number(hero.episodeNumber))
        ? Number(hero.episodeNumber)
        : 0,
    };
  }

  // ---- Account avatar ----
  function applyAccountAvatarStyle({
    style = getStoredAvatarStylePreference(),
    mode = getStoredAvatarModePreference(),
    imageData = getStoredAvatarImagePreference(),
  } = {}) {
    const normalizedStyle = normalizeAvatarStyle(style);
    const normalizedMode = normalizeAvatarMode(mode);
    const safeImage = sanitizeAvatarImageData(imageData);

    if (normalizedMode === "custom" && safeImage) {
      setAvatarClassName("avatar avatar-custom-image");
      setAvatarImageSrc(safeImage);
      return;
    }

    setAvatarClassName(`avatar avatar-style-${normalizedStyle}`);
    setAvatarImageSrc("");
  }

  // ---- Sync body modal lock ----
  function syncBodyModalLock() {
    const hasDetailsOpen = detailsModalVisible() && !false;
    const hasLibraryEditOpen = libraryEditModalVisible();
    document.body.classList.toggle(
      "modal-open",
      hasDetailsOpen || hasLibraryEditOpen,
    );
  }

  // ---- Library edit modal status ----
  function setLibraryEditModalStatus(message, tone = "") {
    setLibraryEditStatusText(String(message || ""));
    setLibraryEditStatusTone(tone);
  }

  // ---- Library edit modal fields rendering ----
  function renderLibraryEditModalFields() {
    if (!libraryEditFieldsRef || !activeLibraryEditContext) {
      return;
    }
    const { library, itemType, itemIndex } = activeLibraryEditContext;
    const list = itemType === "movie" ? library.movies : library.series;
    const item = list[itemIndex];
    if (!item) {
      libraryEditFieldsRef.innerHTML = "";
      return;
    }
    activeLibraryEditCategory = normalizeLibraryEditCategory(
      itemType,
      activeLibraryEditCategory,
    );

    const title = String(item?.title || "Untitled").trim() || "Untitled";
    setLibraryEditModalTitleText(title);

    if (itemType === "movie") {
      const year = String(item?.year || "").trim() || "Local";
      setLibraryEditModalMetaText(`Movie \u2022 ${year}`);
    } else {
      const contentLabel =
        normalizeLibrarySeriesContentKind(item?.contentKind || "") === "course"
          ? "Course"
          : "Series";
      const episodeCount = Array.isArray(item?.episodes) ? item.episodes.length : 0;
      setLibraryEditModalMetaText(`${contentLabel} \u2022 ${episodeCount} episode${episodeCount === 1 ? "" : "s"}`);
    }

    setLibraryAddEpisodeVisible(itemType === "series");
    if (itemType === "series") {
      const contentKind = normalizeLibrarySeriesContentKind(item?.contentKind || "");
      setLibraryAddEpisodeBtnText(
        contentKind === "course" ? "Add Lesson" : "Add Episode",
      );
    } else {
      setLibraryAddEpisodeBtnText("Add Episode");
    }
    setLibrarySaveBtnVisible(true);
    setLibraryDeleteBtnVisible(true);

    libraryEditFieldsRef.innerHTML =
      itemType === "movie"
        ? renderLibraryEditMovieFieldsHtml(item)
        : renderLibraryEditSeriesFieldsHtml(item, activeLibraryEditCategory);
  }

  // ---- Library edit episode rows ----
  function addEpisodeToActiveSeries() {
    if (!activeLibraryEditContext || activeLibraryEditContext.itemType !== "series") {
      return;
    }
    const seriesItem =
      activeLibraryEditContext.library.series[activeLibraryEditContext.itemIndex];
    if (!seriesItem) {
      return;
    }

    const contentKind = normalizeLibrarySeriesContentKind(
      seriesItem.contentKind || "series",
    );
    const seriesId = String(seriesItem.id || "").trim();
    const seriesTitle = String(seriesItem.title || "").trim();
    const episodes = Array.isArray(seriesItem.episodes) ? seriesItem.episodes : [];
    const episodeLabel = contentKind === "course" ? "Lesson" : "Episode";
    const inheritedThumb =
      String(
        episodes.find((episode) => String(episode?.thumb || "").trim())?.thumb ||
          DEFAULT_LOCAL_THUMBNAIL,
      ).trim() || DEFAULT_LOCAL_THUMBNAIL;
    const nextEpisodeNumber =
      episodes.reduce((maxValue, episode) => {
        const value = Number(episode?.episodeNumber || 0);
        return Number.isFinite(value) && value > maxValue ? value : maxValue;
      }, 0) + 1;
    const seasonFallback = episodes.length
      ? Number(episodes[episodes.length - 1]?.seasonNumber || 1)
      : 1;
    const seasonNumber = Number.isFinite(seasonFallback)
      ? Math.max(1, Math.floor(seasonFallback))
      : 1;
    const nextEpisode = {
      title: `${episodeLabel} ${nextEpisodeNumber}`,
      src: "",
      contentKind,
      seasonNumber,
      episodeNumber: nextEpisodeNumber,
      thumb: inheritedThumb,
      description: "",
      uploadedAt: Date.now(),
    };
    activeLibraryEditContext.library.series[activeLibraryEditContext.itemIndex] = {
      ...seriesItem,
      id: seriesId || seriesItem.id,
      title: seriesTitle || seriesItem.title,
      episodes: [...episodes, nextEpisode],
    };
    activeLibraryEditCategory = "episodes";
    renderLibraryEditModalFields();
    setLibraryEditModalStatus(
      `${episodeLabel} ${nextEpisodeNumber} added. Fill in the source path, then Save Changes.`,
    );
  }

  // ---- Library edit collect ----
  function collectLibraryEditedMovie() {
    if (!libraryEditFieldsRef) {
      throw new Error("Editor form is unavailable.");
    }
    const title = readRequiredLibraryInput(
      libraryEditFieldsRef,
      'input[data-field="title"]',
      "Title is required.",
    );
    const src = readRequiredLibraryInput(
      libraryEditFieldsRef,
      'input[data-field="src"]',
      "Source path is required.",
    );
    return {
      ...activeLibraryEditContext.library.movies[activeLibraryEditContext.itemIndex],
      title,
      src,
      year: String(
        libraryEditFieldsRef.querySelector('input[data-field="year"]')?.value || "",
      ).trim(),
      tmdbId: String(
        libraryEditFieldsRef.querySelector('input[data-field="tmdbId"]')?.value || "",
      ).trim(),
      thumb: String(
        libraryEditFieldsRef.querySelector('input[data-field="thumb"]')?.value || "",
      ).trim(),
      description: String(
        libraryEditFieldsRef.querySelector('textarea[data-field="description"]')
          ?.value || "",
      ).trim(),
    };
  }

  function collectLibraryEditedSeries() {
    if (!libraryEditFieldsRef) {
      throw new Error("Editor form is unavailable.");
    }
    const currentSeries =
      activeLibraryEditContext.library.series[activeLibraryEditContext.itemIndex];
    const titleInput = libraryEditFieldsRef.querySelector('input[data-field="title"]');
    const title = titleInput
      ? readRequiredLibraryInput(
          libraryEditFieldsRef,
          'input[data-field="title"]',
          "Title is required.",
        )
      : String(currentSeries?.title || "").trim() || "Untitled Series";
    const typeSelect = libraryEditFieldsRef.querySelector('select[data-field="contentKind"]');
    const contentKind = normalizeLibrarySeriesContentKind(
      (typeSelect instanceof HTMLSelectElement
        ? typeSelect.value
        : currentSeries?.contentKind) || "series",
    );
    const episodeNodes = Array.from(
      libraryEditFieldsRef.querySelectorAll(".library-edit-episode"),
    );
    const existingEpisodes = Array.isArray(currentSeries?.episodes)
      ? currentSeries.episodes
      : [];
    let episodes = existingEpisodes.map((episode, index) => ({
      ...episode,
      contentKind,
      episodeNumber: Number.isFinite(Number(episode?.episodeNumber))
        ? Math.max(1, Math.floor(Number(episode.episodeNumber)))
        : index + 1,
      seasonNumber: Number.isFinite(Number(episode?.seasonNumber))
        ? Math.max(1, Math.floor(Number(episode.seasonNumber)))
        : 1,
    }));
    if (episodeNodes.length) {
      episodes = episodeNodes.map((episodeNode, index) => {
        const titleValue = readRequiredLibraryInput(
          episodeNode,
          'input[data-episode-field="title"]',
          `Episode ${index + 1} title is required.`,
        );
        const srcValue = readRequiredLibraryInput(
          episodeNode,
          'input[data-episode-field="src"]',
          `Episode ${index + 1} source path is required.`,
        );
        return {
          ...(existingEpisodes[index] || {}),
          title: titleValue,
          src: srcValue,
          contentKind,
          seasonNumber: readLibraryPositiveInteger(
            episodeNode,
            'input[data-episode-field="seasonNumber"]',
            1,
          ),
          episodeNumber: readLibraryPositiveInteger(
            episodeNode,
            'input[data-episode-field="episodeNumber"]',
            index + 1,
          ),
          thumb: String(
            episodeNode.querySelector('input[data-episode-field="thumb"]')?.value ||
              "",
          ).trim(),
          description: String(
            episodeNode.querySelector('textarea[data-episode-field="description"]')
              ?.value || "",
          ).trim(),
          uploadedAt: Number.isFinite(Number(existingEpisodes[index]?.uploadedAt))
            ? Math.floor(Number(existingEpisodes[index].uploadedAt))
            : Date.now(),
        };
      });
    }
    const currentCategory = normalizeLibraryEditCategory(
      "series",
      activeLibraryEditCategory,
    );
    if (currentCategory === "episodes" && !episodes.length) {
      throw new Error("Series must include at least one episode.");
    }

    return {
      ...currentSeries,
      title,
      contentKind,
      tmdbId: String(
        libraryEditFieldsRef.querySelector('input[data-field="tmdbId"]')?.value ||
          currentSeries?.tmdbId ||
          "",
      ).trim(),
      year: String(
        libraryEditFieldsRef.querySelector('input[data-field="year"]')?.value ||
          currentSeries?.year ||
          "",
      ).trim(),
      episodes,
    };
  }

  // ---- Library edit persist ----
  async function persistActiveLibraryEdit(successMessage = "Saved changes.") {
    if (!activeLibraryEditContext || isSavingLibraryEdit) {
      return false;
    }
    isSavingLibraryEdit = true;
    setLibraryEditModalStatus("Saving...");
    try {
      const response = await fetch("/api/library", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(activeLibraryEditContext.library),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          String(payload?.error || "Failed to save library changes."),
        );
      }
      activeLibraryEditContext.library = normalizeLibraryPayloadForEdit(
        payload?.library || payload || {},
      );
      const updatedEntry = findLibraryEditEntry(
        activeLibraryEditContext.library,
        activeLibraryEditContext.target,
      );
      if (updatedEntry) {
        activeLibraryEditContext.itemType = updatedEntry.itemType;
        activeLibraryEditContext.itemIndex = updatedEntry.itemIndex;
      }
      applyLibrarySnapshot(activeLibraryEditContext.library);
      if (window.__HOME_BOOTSTRAP__) window.__HOME_BOOTSTRAP__.library = homeLibrarySnapshot;
      renderLibraryEditModalFields();
      setLibraryEditModalStatus(successMessage, "success");
      void loadContinueWatching();
      void loadPopularTitles();
      return true;
    } catch (error) {
      setLibraryEditModalStatus(
        error instanceof Error ? error.message : "Failed to save library changes.",
        "error",
      );
      return false;
    } finally {
      isSavingLibraryEdit = false;
    }
  }

  // ---- Library edit modal open/close ----
  function closeLibraryEditModal() {
    if (!libraryEditModalVisible()) {
      return;
    }
    setLibraryEditModalOpen(false);
    if (libraryEditModalCloseTimer) {
      clearTimeout(libraryEditModalCloseTimer);
    }
    libraryEditModalCloseTimer = window.setTimeout(() => {
      setLibraryEditModalVisible(false);
      syncBodyModalLock();
      libraryEditModalCloseTimer = null;
      activeLibraryEditContext = null;
      activeLibraryEditCategory = "title";
      if (libraryEditFieldsRef) {
        libraryEditFieldsRef.innerHTML = "";
      }
      setLibraryEditModalStatus("");
      pageRootRef?.focus({ preventScroll: true });
    }, 170);
  }

  function showLibraryEditModal() {
    if (libraryEditModalCloseTimer) {
      clearTimeout(libraryEditModalCloseTimer);
      libraryEditModalCloseTimer = null;
    }
    setLibraryEditModalVisible(true);
    requestAnimationFrame(() => {
      setLibraryEditModalOpen(true);
    });
    syncBodyModalLock();
  }

  async function openLibraryEditModalForTarget(target) {
    if (!target) {
      return;
    }
    activeLibraryEditContext = null;
    setLibraryEditModalStatus("Loading title...");
    showLibraryEditModal();
    try {
      const response = await fetch("/api/library");
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          String(payload?.error || "Could not load local library."),
        );
      }
      const library = normalizeLibraryPayloadForEdit(payload || {});
      const entryMatch = findLibraryEditEntry(library, target);
      if (!entryMatch) {
        throw new Error("This title could not be found in the local library.");
      }
      activeLibraryEditContext = {
        target,
        library,
        itemType: entryMatch.itemType,
        itemIndex: entryMatch.itemIndex,
      };
      activeLibraryEditCategory = normalizeLibraryEditCategory(
        entryMatch.itemType,
        "title",
      );
      renderLibraryEditModalFields();
      setLibraryEditModalStatus("Edit and click Save Changes.");
    } catch (error) {
      activeLibraryEditContext = null;
      if (libraryEditFieldsRef) {
        libraryEditFieldsRef.innerHTML = "";
      }
      setLibraryEditModalStatus(
        error instanceof Error ? error.message : "Could not open editor.",
        "error",
      );
    }
  }

  function openLibraryEditTarget(card) {
    const target = getLibraryEditTargetFromCard(card);
    if (!target) {
      return;
    }
    void openLibraryEditModalForTarget(target);
  }

  // ---- Details modal ----
  function setDetailsModalBackgroundInert(isInert) {
    const modal = document.getElementById("detailsModal");
    const modalParent = modal?.parentElement;
    if (!modal || !modalParent) {
      return;
    }
    Array.from(modalParent.children).forEach((child) => {
      if (child === modal) {
        return;
      }
      child.toggleAttribute("inert", Boolean(isInert));
    });
  }

  function getDetailsModalFocusableElements() {
    if (!detailsSheetRef) {
      return [];
    }
    return Array.from(
      detailsSheetRef.querySelectorAll(MODAL_FOCUSABLE_SELECTOR),
    ).filter((element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      return (
        !element.hidden &&
        element.getAttribute("aria-hidden") !== "true" &&
        element.getClientRects().length > 0
      );
    });
  }

  function trapDetailsModalFocus(event) {
    if (event.key !== "Tab" || !detailsModalVisible()) {
      return false;
    }
    const focusableElements = getDetailsModalFocusableElements();
    if (!focusableElements.length) {
      event.preventDefault();
      detailsSheetRef?.focus({ preventScroll: true });
      return true;
    }
    const first = focusableElements[0];
    const last = focusableElements[focusableElements.length - 1];
    const activeElement = document.activeElement;
    if (event.shiftKey && (activeElement === first || !detailsSheetRef?.contains(activeElement))) {
      event.preventDefault();
      last.focus({ preventScroll: true });
      return true;
    }
    if (!event.shiftKey && (activeElement === last || !detailsSheetRef?.contains(activeElement))) {
      event.preventDefault();
      first.focus({ preventScroll: true });
      return true;
    }
    return false;
  }

  function applyCardCertification(card, value) {
    if (!(card instanceof HTMLElement)) {
      return;
    }
    const certification = normalizeCertification(value);
    card.dataset.maturity = certification;
    card.querySelectorAll(".meta-age").forEach((element) => {
      element.textContent = certification;
    });
  }

  function getDetailsFocusRestoreTarget(trigger) {
    if (!(trigger instanceof HTMLElement) || !trigger.isConnected) {
      return pageRootRef;
    }
    const hiddenContainer = trigger.closest('[inert], [aria-hidden="true"]');
    if (!hiddenContainer && trigger.getClientRects().length > 0) {
      return trigger;
    }
    const cardAction = trigger
      .closest(".card")
      ?.querySelector(":scope > .card-primary-action");
    return cardAction instanceof HTMLElement ? cardAction : pageRootRef;
  }

  function populateDetailsModal(details) {
    setDetailsData({
      seriesId: details.seriesId || "",
      seasonNumber: details.seasonNumber || 1,
      seasons: details.seasons,
      localEpisodes: homeLibrarySnapshot?.series?.find((series) =>
        details.seriesId && series.id === details.seriesId,
      )?.episodes?.map((episode, index) => ({
        ...episode,
        seasonNumber: Math.max(1, Number(episode.seasonNumber) || 1),
        episodeNumber: Math.max(1, Number(episode.episodeNumber) || index + 1),
        episodeIndex: index,
      })),
      tmdbId: details.tmdbId || "",
      mediaType: details.mediaType || "movie",
      thumb: details.thumb || DEFAULT_LOCAL_THUMBNAIL,
      title: details.title || "",
      year: details.year || "",
      runtime: details.runtime || "",
      maturity: normalizeCertification(details.maturity),
      quality: details.quality || "",
      audio: details.audio || "",
      description: details.description || "",
      cast: details.cast || "",
      genres: details.genres || "",
      vibe: details.vibe || "",
    });
    setDetailsResume(findTitleResume(details, getContinueWatchingEntries()));
  }

  async function hydrateModalFromTmdb(card) {
    const requestVersion = ++detailsRequestVersion;
    const tmdbId = activeDetails?.tmdbId;
    const mediaType = activeDetails?.mediaType;
    setDetailsLoadState("ready");
    if (!tmdbId || !mediaType) return;
    setDetailsLoadState("loading");

    const cacheKey = `${mediaType}:${tmdbId}`;

    if (tmdbDetailsCache.has(cacheKey)) {
      if (card) applyCardCertification(card, tmdbDetailsCache.get(cacheKey)?.maturity);
      activeDetails = {
        ...activeDetails,
        ...tmdbDetailsCache.get(cacheKey),
      };
      populateDetailsModal(activeDetails);
      setDetailsLoadState("ready");
      return;
    }

    try {
      const details = await apiFetchWithTimeout(
        "/api/tmdb/details",
        {
          tmdbId,
          mediaType,
        },
        TMDB_DETAILS_MODAL_TIMEOUT_MS,
      );
      if (card) applyCardCertification(card, details?.certification);

      if (
        requestVersion !== detailsRequestVersion ||
        !detailsModalVisible() ||
        !activeDetails
      ) {
        return;
      }

      const modalPatch = mapDetailsToModalPatch(
        details,
        activeDetails,
        mediaType,
      );
      setTmdbDetailsCache(cacheKey, modalPatch);
      activeDetails = { ...activeDetails, ...modalPatch };
      populateDetailsModal(activeDetails);
      setDetailsLoadState("ready");
    } catch {
      if (requestVersion !== detailsRequestVersion || !detailsModalVisible()) return;
      if (activeDetails.cast === "Loading cast...") activeDetails = { ...activeDetails, cast: "" };
      populateDetailsModal(activeDetails);
      setDetailsLoadState("error");
    }
  }

  function openDetailsModal(card, trigger, details = getCardModalData(card)) {
    if (closeModalTimer) {
      clearTimeout(closeModalTimer);
      closeModalTimer = null;
    }

    activeDetails = details;
    activeDetailsCard = card;
    suspendHeroPreviewForViewport();
    detailsTrigger = trigger || null;
    populateDetailsModal(activeDetails);
    setDetailsMyListActive(isMyListEntryActive(activeDetails));
    setDetailsModalVisible(true);
    if (detailsSheetRef) detailsSheetRef.scrollTop = 0;
    setDetailsModalBackgroundInert(true);
    requestAnimationFrame(() => {
      setDetailsModalOpen(true);
    });
    syncBodyModalLock();
    detailsCloseButtonRef?.focus({ preventScroll: true });
    hydrateModalFromTmdb(card);
  }

  function closeDetailsModal({ restoreFocus = true } = {}) {
    if (!detailsModalVisible()) return;

    setDetailsModalOpen(false);

    const focusTrigger = detailsTrigger;
    closeModalTimer = window.setTimeout(() => {
      setDetailsModalVisible(false);
      setDetailsModalBackgroundInert(false);
      syncBodyModalLock();
      if (restoreFocus) {
        const focusTarget = getDetailsFocusRestoreTarget(focusTrigger);
        if (focusTarget instanceof HTMLElement && focusTarget.isConnected) {
          focusTarget.focus({ preventScroll: true });
        }
      }
      detailsTrigger = null;
      closeModalTimer = null;
    }, 220);
  }

  // ---- My List ----
  function myListIconMarkup(isActive) {
    return isActive
      ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 9.2 16.7 19 7" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>`
      : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke-linecap="round" /></svg>`;
  }

  function setMyListButtonState(button, isActive) {
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    const itemTitle = String(button.dataset.itemTitle || "").trim();
    button.disabled = myListSaving();
    button.classList.toggle("is-active", Boolean(isActive));
    button.setAttribute(
      "aria-label",
      isActive
        ? itemTitle
          ? `Remove ${itemTitle} from My List`
          : "Remove from My List"
        : itemTitle
          ? `Add ${itemTitle} to My List`
          : "Add to My List",
    );
    button.dataset.tooltip = isActive ? "Remove from My List" : "Add to My List";
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
    button.innerHTML = myListIconMarkup(isActive);
  }

  function syncCardMyListButton(card) {
    if (!(card instanceof HTMLElement)) {
      return;
    }
    const isActive = isMyListEntryActive(getCardDetails(card));
    card
      .querySelectorAll(".hover-my-list, .card-touch-my-list")
      .forEach((button) => {
        if (button instanceof HTMLButtonElement) {
          setMyListButtonState(button, isActive);
        }
      });
  }

  function syncAllMyListButtons() {
    document.querySelectorAll(".card").forEach((card) => {
      syncCardMyListButton(card);
    });
    // Details modal my list button is handled reactively via signal
    if (activeDetails) {
      setDetailsMyListActive(isMyListEntryActive(activeDetails));
    }
  }

  function buildMyListCardElement(entry) {
    const details = normalizeMyListEntry(entry);
    const playableSrc = details.src || details.librarySrc;
    const contentTypeLabel =
      details.mediaType === "tv" || details.seriesId ? "Series" : "Movie";
    const displayYear = details.year || (details.tmdbId ? "" : "Local");
    const safeTitle = escapeHtml(details.title);
    const safeThumb = escapeHtml(details.thumb);

    const card = document.createElement("article");
    card.className = "card";
    card.dataset.title = details.title;
    card.dataset.episode = details.episode;
    card.dataset.src = playableSrc;
    card.dataset.thumb = details.thumb;
    card.dataset.tmdbId = details.tmdbId;
    card.dataset.mediaType = details.mediaType;
    card.dataset.seriesId = details.seriesId;
    card.dataset.episodeIndex = String(details.episodeIndex);
    card.dataset.year = displayYear;
    card.dataset.runtime = contentTypeLabel;
    card.dataset.maturity = UNRATED_CERTIFICATION_LABEL;
    card.dataset.quality = "";
    card.dataset.audio = "";
    card.dataset.description = "Saved in My List.";
    card.dataset.cast = "Local library";
    card.dataset.genres = contentTypeLabel;
    card.dataset.vibe = "Saved, Personal";
    card.dataset.libraryType = details.libraryType;
    card.dataset.libraryId = details.libraryId;
    card.dataset.librarySrc = details.librarySrc;

    card.innerHTML = `
      <div class="card-base">
        <img data-src="${safeThumb}" alt="${safeTitle}" loading="lazy" />
        <progress class="progress" value="100" max="100" aria-hidden="true"></progress>
      </div>
      <div class="card-hover">
        <img class="card-hover-image" data-src="${safeThumb}" alt="${safeTitle} preview" loading="lazy" />
        <div class="card-hover-body">
          <div class="card-hover-controls">
            <div class="card-hover-actions">
              <button class="hover-round hover-play" type="button" aria-label="Play ${safeTitle}">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5v17L20 12 5 3.5Z" /></svg>
              </button>
              <button class="hover-round hover-my-list" type="button" aria-label="Add to My List" aria-pressed="false" data-tooltip="Add to My List">
                ${myListIconMarkup(false)}
              </button>
            </div>
            <button class="hover-round hover-details" type="button" aria-label="More details">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
          </div>
          <div class="card-hover-meta">
            <span class="meta-age">${UNRATED_CERTIFICATION_LABEL}</span>
            <span>${escapeHtml(displayYear)}</span>
            <span class="meta-spatial">${contentTypeLabel}</span>
          </div>
          <p class="card-hover-tags">Saved <span>&bull;</span> My List</p>
        </div>
      </div>
    `;

    return card;
  }

  function renderMyListRow() {
    const seen = new Set();
    const savedEntries = readMyListEntries()
      .map((entry) => hydrateMyListEntryWithLocalLibrary(entry, myListLibraryEntries))
      .filter((entry) => {
        const identity = getRecommendationIdentity(entry);
        if (!identity || seen.has(identity)) return false;
        seen.add(identity);
        return true;
      })
      .sort((left, right) => Number(right.addedAt || 0) - Number(left.addedAt || 0));
    const signature = JSON.stringify([savedEntries, myListLibraryEntries]);
    if (signature === myListRenderSignature) return;
    myListRenderSignature = signature;
    // Local file availability enriches presentation; it must not rewrite the
    // account's saved list merely because Home rendered.
    setSavedTitles(savedEntries);
    const renderCards = (container, cards) => {
      if (!container) return;
      unobserveDeferredArtwork(container);
      container.replaceChildren();
      const fragment = document.createDocumentFragment();
      cards.forEach((card, index) => {
        if (index >= Math.max(1, cards.length - 2)) card.classList.add("card--align-right");
        fragment.appendChild(card);
        attachCardInteractions(card);
      });
      container.appendChild(fragment);
      attachArtworkImageFallbacks(container);
    };
    renderCards(myListCardsRef, savedEntries.slice(0, BROWSE_RAIL_LIMIT).map(buildMyListCardElement));
    renderCards(libraryCardsRef, myListLibraryEntries.map((entry) => entry.type === "series"
      ? buildCardFromLocalSeriesElement(entry.item)
      : buildCardFromLocalMovieElement(entry.item)));
    setMyListRowVisible(savedEntries.length > 0);
    setLibraryRowVisible(myListLibraryEntries.length > 0);
    syncAllMyListButtons();
  }

  async function handleMyListToggle(details, trigger = null) {
    if (myListSaving()) return;
    setMyListSaving(true);
    setMyListNotice("");
    if (myListNoticeTimer) clearTimeout(myListNoticeTimer);
    syncAllMyListButtons();
    const savedCard = trigger?.closest?.(".saved-title");
    const focusIndex = savedCard ? Array.from(savedCard.parentElement.children).indexOf(savedCard) : -1;
    try {
      const isAdded = await toggleMyList(details);
      if (isAdded === null) return;
      renderMyListRow();
      setMyListNoticeError(false);
      setMyListNotice(`${details.title} ${isAdded ? "added to" : "removed from"} My List.`);
      myListNoticeTimer = window.setTimeout(() => setMyListNotice(""), 5000);
      if (focusIndex >= 0 && activeView() === "my-list") {
        requestAnimationFrame(() => {
          const cards = document.querySelectorAll("#myListView .saved-title-open");
          (cards[Math.min(focusIndex, cards.length - 1)] || document.getElementById("myListHeading"))?.focus({ preventScroll: true });
        });
      }
    } catch (error) {
      setMyListNoticeError(true);
      setMyListNotice(error.name === "TimeoutError" ? "Saving took too long. Please try again." : error.name === "Error" ? error.message : "Couldn’t save your list. Check your connection and try again.");
    } finally {
      setMyListSaving(false);
      syncAllMyListButtons();
    }
  }

  // ---- Card interactions ----
  function ensureCardPrimaryAction(card) {
    if (!(card instanceof HTMLElement)) {
      return null;
    }
    const existing = card.querySelector(":scope > .card-primary-action");
    if (existing instanceof HTMLButtonElement) {
      return existing;
    }
    const title = String(card.dataset.title || "title").trim() || "title";
    const action = document.createElement("button");
    action.className = "card-primary-action";
    action.type = "button";
    const isContinue = Boolean(card.dataset.resumeSource);
    action.setAttribute("aria-label", `${isContinue ? "Resume" : "Details for"} ${title}`);
    if (!isContinue) action.setAttribute("aria-haspopup", "dialog");
    card.prepend(action);
    return action;
  }

  function ensureCardLibraryEditButton(card) {
    if (!card) {
      return;
    }
    const actions = card.querySelector(".card-hover-actions");
    if (!actions) {
      return;
    }
    const existingEditButton = actions.querySelector(".hover-edit");
    const hasEditableTarget = Boolean(getLibraryEditTargetFromCard(card));
    if (!hasEditableTarget) {
      existingEditButton?.remove();
      return;
    }
    if (existingEditButton) {
      return;
    }
    const title = String(card.dataset.title || "title").trim() || "title";
    const editButton = document.createElement("button");
    editButton.className = "hover-round hover-edit";
    editButton.type = "button";
    editButton.setAttribute("aria-label", `Edit ${title}`);
    editButton.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.5-1 9-9-3.5-3.5-9 9L4 20Zm10.5-12.5 3.5 3.5" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>';
    actions.appendChild(editButton);
  }

  function positionCardHover(card) {
    if (!(card instanceof HTMLElement)) {
      return;
    }
    const hover = card.querySelector(".card-hover");
    if (!(hover instanceof HTMLElement)) {
      return;
    }

    const cardRect = card.getBoundingClientRect();
    const hoverWidth = hover.offsetWidth || Math.min(470, window.innerWidth * 0.34);
    const hoverHeight = hover.offsetHeight || Math.round((hoverWidth * 9) / 16);
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const gutter = 12;

    const preferredLeft = card.classList.contains("card--align-right")
      ? cardRect.right - hoverWidth
      : cardRect.left;
    const maxLeft = Math.max(gutter, viewportWidth - hoverWidth - gutter);
    const left = Math.max(gutter, Math.min(preferredLeft, maxLeft));

    const preferredTop = cardRect.bottom - hoverHeight;
    const maxTop = Math.max(gutter, viewportHeight - hoverHeight - gutter);
    const top = Math.max(gutter, Math.min(preferredTop, maxTop));

    setRuntimeStyleRule(".card.is-hovering .card-hover", {
      left: `${left}px`,
      top: `${top}px`,
    });
  }

  // Wait for a brief lingering hover before expanding the preview, so a
  // pointer merely sweeping across a row never triggers the popup.
  const CARD_HOVER_INTENT_DELAY = 400;

  function showCardHover(card) {
    if (!(card instanceof HTMLElement)) {
      return;
    }
    card.closest(".continue-row, .popular-row")?.classList.add("is-card-hovering");
    const hover = card.querySelector(".card-hover");
    revealDeferredArtwork(hover);
    hover?.removeAttribute("inert");
    hover?.setAttribute("aria-hidden", "false");
    positionCardHover(card);
    card.classList.add("is-hovering");
    prewarmCardMovieSource(card);
    requestAnimationFrame(() => positionCardHover(card));
  }

  function hideCardHover(card, { force = false } = {}) {
    if (!(card instanceof HTMLElement) || (!force && card.matches(":focus-within"))) {
      return;
    }
    card.classList.remove("is-hovering");
    card.closest(".continue-row, .popular-row")?.classList.remove("is-card-hovering");
    const hover = card.querySelector(".card-hover");
    hover?.setAttribute("inert", "");
    hover?.setAttribute("aria-hidden", "true");
  }

  function shouldUseCardHover(event = null) {
    const pointerType = String(event?.pointerType || "").toLowerCase();
    if (pointerType && pointerType !== "mouse") {
      return false;
    }
    return window.matchMedia?.("(hover: hover) and (pointer: fine)").matches ?? true;
  }

  function prepareCardTouchSurfaces(card) {
    card.querySelectorAll("img").forEach((image) => {
      image.setAttribute("draggable", "false");
      image.draggable = false;
    });
  }

  function ensureCardTouchActions(card) {
    if (!(card instanceof HTMLElement) || card.querySelector(".card-touch-actions")) {
      return;
    }
    const cardBase = card.querySelector(".card-base");
    if (!(cardBase instanceof HTMLElement)) {
      return;
    }
    const title = String(card.dataset.title || "title").trim() || "title";
    const safeTitle = escapeHtml(title);
    const actions = document.createElement("div");
    actions.className = "card-touch-actions";
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", `Actions for ${title}`);
    actions.innerHTML = `
      <button
        class="card-touch-action card-touch-my-list"
        type="button"
        aria-label="Add ${safeTitle} to My List"
        aria-pressed="false"
        data-item-title="${safeTitle}"
      >
        ${myListIconMarkup(false)}
      </button>
      <button
        class="card-touch-action card-touch-details"
        type="button"
        aria-label="More details for ${safeTitle}"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="8.5" fill="none" />
          <path d="M12 10.5v6M12 7.5h.01" fill="none" stroke-linecap="round" />
        </svg>
      </button>
    `;
    cardBase.appendChild(actions);
  }

  function attachCardInteractions(card) {
    if (!card || card.dataset.interactionsBound === "true") {
      return;
    }
    addBrowseCardCaption(card);
    attachArtworkImageFallbacks(card);
    observeDeferredArtwork(card);
    ensureCardLibraryEditButton(card);
    prepareCardTouchSurfaces(card);
    ensureCardTouchActions(card);
    const primaryAction = ensureCardPrimaryAction(card);
    const hover = card.querySelector(".card-hover");
    hover?.setAttribute("inert", "");
    hover?.setAttribute("aria-hidden", "true");
    card.dataset.interactionsBound = "true";

    let pointerInside = false;
    let hoverIntentTimer = null;
    const clearHoverIntent = () => {
      if (hoverIntentTimer !== null) {
        window.clearTimeout(hoverIntentTimer);
        hoverIntentTimer = null;
      }
    };

    card.addEventListener("pointerenter", (event) => {
      if (!shouldUseCardHover(event)) {
        return;
      }
      pointerInside = true;
      clearHoverIntent();
      hoverIntentTimer = window.setTimeout(() => {
        hoverIntentTimer = null;
        if (pointerInside) {
          showCardHover(card);
        }
      }, CARD_HOVER_INTENT_DELAY);
    });
    card.addEventListener("pointerleave", () => {
      pointerInside = false;
      clearHoverIntent();
      hideCardHover(card);
    });
    card.addEventListener("focusin", () => {
      clearHoverIntent();
      if (shouldUseCardHover()) {
        showCardHover(card);
      }
    });
    card.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (!card.matches(":focus-within")) {
          hideCardHover(card, { force: true });
        }
      }, 0);
    });

    card.addEventListener("click", (event) => {
      if (event.target.closest("button")) {
        return;
      }
      if (card.dataset.resumeSource) openPlayerPage(getCardDetails(card));
      else openDetailsModal(card, primaryAction);
    });

    primaryAction?.addEventListener("click", (event) => {
      event.stopPropagation();
      if (card.dataset.resumeSource) openPlayerPage(getCardDetails(card));
      else openDetailsModal(card, primaryAction);
    });

    const hoverPlayButton = card.querySelector(".hover-play");
    hoverPlayButton?.addEventListener("click", (event) => {
      event.stopPropagation();
      const details = getCardDetails(card);
      openPlayerPage(titlePlaybackTarget(details, findTitleResume(details, getContinueWatchingEntries())));
    });

    card.querySelectorAll(".hover-details, .card-touch-details").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        event.preventDefault();
        openDetailsModal(card, button);
      });
    });

    const hoverEditButton = card.querySelector(".hover-edit");
    hoverEditButton?.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      openLibraryEditTarget(card);
    });

    const hoverRemoveButton = card.querySelector(".hover-remove");
    hoverRemoveButton?.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();

      const resumeSource =
        String(card.dataset.resumeSource || "").trim() ||
        (card.dataset.tmdbId && card.dataset.mediaType === "movie"
          ? `tmdb:movie:${String(card.dataset.tmdbId).trim()}`
          : String(card.dataset.src || "").trim());

      if (!resumeSource) {
        return;
      }

      void (async () => {
        const owner = String(window.__currentUser?.id || "");
        const hydration = getHydrationState();
        if (hydration.pending && (!hydration.didLoadProgress || !hydration.didLoadContinueWatching)) {
          const pending = beginServerHydration();
          await Promise.all([pending.progressReady, pending.continueWatchingReady]);
        }
        if (!owner || getHydrationState().authExpired || String(window.__currentUser?.id || "") !== owner) return;
        await removeContinueWatchingEntry(resumeSource, card.dataset.seriesId);
        await loadContinueWatching();
      })();
    });

    const isCardInMyList = isMyListEntryActive(getCardDetails(card));
    card
      .querySelectorAll(".hover-my-list, .card-touch-my-list")
      .forEach((button) => {
        if (!(button instanceof HTMLButtonElement)) return;
        setMyListButtonState(button, isCardInMyList);
        button.addEventListener("click", async (event) => {
          event.stopPropagation();
          event.preventDefault();
          await handleMyListToggle(getCardDetails(card), button);
        });
      });
  }

  // ---- Card building functions ----
  function buildContinueWatchingCardElement(entry, tmdbDetails = null) {
    const normalizedMediaType = inferContinueMediaType(
      entry.sourceIdentity,
      entry.mediaType,
      entry.seriesId,
    );
    const isSeriesEntry = normalizedMediaType === "tv";
    const title =
      (isSeriesEntry
        ? tmdbDetails?.name || tmdbDetails?.title
        : tmdbDetails?.title || tmdbDetails?.name) ||
      entry.title ||
      (isSeriesEntry ? "Series" : "Movie");
    const releaseDate = isSeriesEntry
      ? String(tmdbDetails?.first_air_date || tmdbDetails?.release_date || "")
      : String(tmdbDetails?.release_date || "");
    const year = releaseDate ? releaseDate.slice(0, 4) : entry.year || "";
    const posterPath =
      tmdbDetails?.poster_path || tmdbDetails?.backdrop_path || "";
    const backdropPath =
      tmdbDetails?.backdrop_path || tmdbDetails?.poster_path || "";
    const seriesBasePath =
      isSeriesEntry && backdropPath ? backdropPath : posterPath;
    const posterUrl = seriesBasePath
      ? `${TMDB_IMAGE_BASE}/${isSeriesEntry && backdropPath ? "w780" : "w500"}${seriesBasePath}`
      : entry.thumb ||
        getFallbackThumbnailForSource(entry.src || entry.sourceIdentity) ||
        "assets/images/thumbnail.jpg";
    const heroUrl = backdropPath
      ? `${TMDB_IMAGE_BASE}/w1280${backdropPath}`
      : posterUrl;
    const runtimeMinutes =
      Number(
        isSeriesEntry ? tmdbDetails?.episode_run_time?.[0] : tmdbDetails?.runtime,
      ) || 0;
    const estimatedDurationSeconds = runtimeMinutes > 0 ? runtimeMinutes * 60 : 0;
    const resumeSeconds = Math.max(0, Number(entry.resumeSeconds) || 0);
    const progressPercent = estimatedDurationSeconds > 0
      ? Math.min(100, Math.round((resumeSeconds / estimatedDurationSeconds) * 100))
      : null;
    const episodeLabel = isSeriesEntry
      ? entry.seasonNumber > 0 && entry.episodeNumber > 0
        ? `S${entry.seasonNumber} E${entry.episodeNumber}`
        : entry.episode || ""
      : "";
    const genreNames = (tmdbDetails?.genres || [])
      .map((genre) => String(genre?.name || "").trim())
      .filter(Boolean)
      .slice(0, 3);
    const tagLine = genreNames.length
      ? genreNames.map(escapeHtml).join(" <span>&bull;</span> ")
      : "Continue <span>&bull;</span> Resume";
    const safeTitle = escapeHtml(title);
    const artUrl = backdropPath
      ? `${TMDB_IMAGE_BASE}/w780${backdropPath}`
      : posterUrl;
    const safeDescription = tmdbDetails?.overview || "Resume where you left off.";
    const maturity = normalizeCertification(tmdbDetails?.certification);
    const qualityLabel = "";
    const contentTypeLabel = isSeriesEntry ? "Series" : "Movie";
    const cast = (tmdbDetails?.credits?.cast || [])
      .slice(0, 4)
      .map((person) => person?.name)
      .filter(Boolean)
      .join(", ");

    const card = document.createElement("article");
    card.className = "card";
    card.dataset.resumeSource = entry.sourceIdentity;
    card.dataset.title = title;
    card.dataset.episode = episodeLabel;
    card.dataset.src = entry.src || "";
    card.dataset.thumb = heroUrl;
    card.dataset.year = year;
    card.dataset.runtime = runtimeMinutes > 0 ? formatRuntime(runtimeMinutes) : "";
    card.dataset.maturity = maturity;
    card.dataset.quality = qualityLabel;
    card.dataset.audio = "";
    card.dataset.description = safeDescription;
    card.dataset.cast = cast;
    card.dataset.genres = genreNames.join(", ");
    card.dataset.vibe = "";
    card.dataset.tmdbId = entry.tmdbId || "";
    card.dataset.mediaType = normalizedMediaType || entry.mediaType || "";
    card.dataset.seriesId = entry.seriesId || "";
    card.dataset.episodeIndex = Number.isFinite(Number(entry.episodeIndex))
      ? String(Math.max(0, Math.floor(Number(entry.episodeIndex))))
      : "-1";
    card.dataset.seasonNumber = Number.isFinite(Number(entry.seasonNumber))
      ? String(Math.max(0, Math.floor(Number(entry.seasonNumber))))
      : "0";
    card.dataset.episodeNumber = Number.isFinite(Number(entry.episodeNumber))
      ? String(Math.max(0, Math.floor(Number(entry.episodeNumber))))
      : "0";
    const continueSeriesId = String(entry.seriesId || "").trim();
    const continueSrc = String(entry.src || "").trim();
    const continueSourceIdentity = String(entry.sourceIdentity || "").trim();
    if (continueSeriesId && continueSrc) {
      card.dataset.libraryType = "series";
      card.dataset.libraryId = continueSeriesId;
      card.dataset.librarySrc = continueSrc;
    } else if (
      !String(entry.tmdbId || "").trim() &&
      (isLikelyLocalMediaSource(continueSrc) ||
        isLikelyLocalMediaSource(continueSourceIdentity))
    ) {
      card.dataset.libraryType = "movie";
      card.dataset.librarySrc = continueSrc || continueSourceIdentity;
    }
    const hasEditTarget = Boolean(getLibraryEditTargetFromCard(card));
    const editButtonMarkup = hasEditTarget
      ? `<button class="hover-round hover-edit" type="button" aria-label="Edit ${safeTitle}">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.5-1 9-9-3.5-3.5-9 9L4 20Zm10.5-12.5 3.5 3.5" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
              </button>`
      : "";

    const progressTimeLabel = estimatedDurationSeconds > resumeSeconds
      ? `${isSeriesEntry ? "About " : ""}${Math.ceil((estimatedDurationSeconds - resumeSeconds) / 60)} min left`
      : resumeSeconds > 0 ? `${Math.floor(resumeSeconds / 60)} min watched` : "Ready to resume";
    const progressMarkup = progressPercent === null ? "" : `<progress class="progress" value="${progressPercent}" max="100" aria-hidden="true"></progress>`;
    const resumeCaption = [episodeLabel, progressTimeLabel].filter(Boolean).join(" · ");

    card.innerHTML = `
      <div class="card-base">
        <div class="card-rail-art">
          <img data-srcset="${escapeHtml(buildTmdbArtworkSrcSet(artUrl, [300, 780]))}" sizes="(max-width: 760px) 62vw, (max-width: 1100px) 33vw, 25vw" width="780" height="439" data-src="${escapeHtml(artUrl)}" alt="${safeTitle}" loading="lazy" decoding="async" fetchpriority="low" />
        </div>
        ${progressMarkup}
      </div>
      <p class="continue-caption">${escapeHtml(resumeCaption)}</p>
      <div class="card-hover">
        <img class="card-hover-image" data-src="${escapeHtml(heroUrl.replace("/w1280/", "/w780/"))}" alt="${safeTitle} preview" loading="lazy" />
        <div class="card-hover-body">
          <div class="card-hover-controls">
            <div class="card-hover-actions">
              <button class="hover-round hover-play" type="button" aria-label="Resume ${safeTitle}">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5v17L20 12 5 3.5Z" /></svg>
              </button>
              <button class="hover-round hover-my-list" type="button" aria-label="Add to My List" aria-pressed="false" data-tooltip="Add to My List">
                ${myListIconMarkup(false)}
              </button>
              <button class="hover-round hover-remove" type="button" aria-label="Remove ${safeTitle} from row" data-tooltip="Remove from row">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke-linecap="round" /></svg>
              </button>
              ${editButtonMarkup}
            </div>
            <button class="hover-round hover-details" type="button" aria-label="More details">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
          </div>
          <div class="card-hover-progress">
            ${progressMarkup}
            <span class="progress-time">${escapeHtml(resumeCaption)}</span>
          </div>
          <div class="card-hover-meta">
            <span class="meta-age">${maturity}</span>
            ${qualityLabel ? `<span class="meta-chip">${qualityLabel}</span>` : ""}
            <span class="meta-spatial">${contentTypeLabel}</span>
          </div>
          <p class="card-hover-tags">${tagLine}</p>
        </div>
      </div>
    `;

    return card;
  }

  function buildCardFromTmdbElement(item, genreMap, imageBase = TMDB_IMAGE_BASE) {
    const mediaType = getTmdbItemMediaType(item);
    const title = getTmdbItemTitle(item);
    const releaseDate = getTmdbItemReleaseDate(item);
    const year = releaseDate ? releaseDate.slice(0, 4) : "";
    const posterPath = item.poster_path || item.backdrop_path;
    const backdropPath = item.backdrop_path || item.poster_path;
    const posterUrl = backdropPath
      ? `${imageBase}/w780${backdropPath}`
      : posterPath
        ? `${imageBase}/w780${posterPath}`
      : "assets/images/thumbnail.jpg";
    const heroUrl = backdropPath
      ? `${imageBase}/w1280${backdropPath}`
      : posterUrl;
    const maturity = normalizeCertification(item?.certification);
    const mediaLabel = mediaType === "tv" ? "Series" : "Movie";
    const genreNames = (item.genre_ids || [])
      .map((id) => genreMap.get(id))
      .filter(Boolean)
      .slice(0, 3);
    const tagLine = genreNames.length
      ? genreNames.map(escapeHtml).join(" <span>&bull;</span> ")
      : "Popular <span>&bull;</span> Trending";
    const safeTitle = escapeHtml(title);
    const safeYear = escapeHtml(year);
    const posterPortraitPath = item.poster_path || item.backdrop_path;
    const posterPortraitUrl = posterPortraitPath
      ? `${imageBase}/w500${posterPortraitPath}`
      : "assets/images/thumbnail.jpg";

    const card = document.createElement("article");
    card.className = "card card--poster";
    card.dataset.title = title;
    card.dataset.episode = year || "";
    card.dataset.src = "";
    card.dataset.thumb = heroUrl;
    card.dataset.year = year;
    card.dataset.runtime = "";
    card.dataset.maturity = maturity;
    card.dataset.quality = "";
    card.dataset.audio = "";
    card.dataset.description = item.overview || "No description available.";
    card.dataset.cast = "Loading cast...";
    card.dataset.genres = genreNames.join(", ");
    card.dataset.vibe = "";
    card.dataset.tmdbId = String(item.id);
    card.dataset.mediaType = mediaType;

    card.innerHTML = `
      <div class="card-base">
        <img data-srcset="${escapeHtml(buildTmdbArtworkSrcSet(posterPortraitUrl, [185, 342, 500]))}" sizes="(max-width: 760px) 34vw, (max-width: 1100px) 20vw, (min-width: 1600px) 12.5vw, 17vw" data-src="${escapeHtml(posterPortraitUrl)}" width="500" height="750" alt="${safeTitle}" loading="lazy" decoding="async" fetchpriority="low" />
      </div>
      <div class="card-hover">
        <img class="card-hover-image" data-src="${escapeHtml(heroUrl.replace("/w1280/", "/w780/"))}" alt="${safeTitle} preview" loading="lazy" decoding="async" fetchpriority="low" />
        <div class="card-hover-body">
          <div class="card-hover-controls">
            <div class="card-hover-actions">
              <button class="hover-round hover-play" type="button" aria-label="Play ${safeTitle}">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5v17L20 12 5 3.5Z" /></svg>
              </button>
              <button class="hover-round hover-my-list" type="button" aria-label="Add to My List" aria-pressed="false" data-tooltip="Add to My List">
                ${myListIconMarkup(false)}
              </button>
            </div>
            <button class="hover-round hover-details" type="button" aria-label="More details">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
          </div>
          <div class="card-hover-meta">
            <span class="meta-age">${maturity}</span>
            <span>${safeYear}</span>
            <span class="meta-spatial">${mediaLabel}</span>
          </div>
          <p class="card-hover-tags">${tagLine}</p>
        </div>
      </div>
    `;

    return card;
  }

  function buildCardFromLocalMovieElement(item, tmdbDetails = null) {
    const title = normalizeLocalMovieDisplayTitle(item?.title || "Uploaded Movie");
    const id = String(item?.id || "").trim();
    const src = String(item?.src || "").trim();
    const looksLikeCourse =
      String(item?.contentKind || "")
        .trim()
        .toLowerCase() === "course" ||
      /\b(course|lesson|module|class|lecture|webinar)\b/i.test(
        `${title} ${id} ${src}`.trim(),
      );
    const year = String(item?.year || "").trim() || "Local";
    const maturity = normalizeCertification(tmdbDetails?.certification);
    const qualityLabel = "";
    const storedThumb = String(item?.thumb || "").trim();
    const sourceSpecificThumb = getFallbackThumbnailForSource(src);
    const tmdbPosterPath =
      String(tmdbDetails?.poster_path || tmdbDetails?.backdrop_path || "").trim();
    const tmdbBackdropPath =
      String(tmdbDetails?.backdrop_path || tmdbDetails?.poster_path || "").trim();
    const tmdbPosterUrl = tmdbPosterPath
      ? `${TMDB_IMAGE_BASE}/w500${tmdbPosterPath}`
      : "";
    const tmdbHeroUrl = tmdbBackdropPath
      ? `${TMDB_IMAGE_BASE}/w1280${tmdbBackdropPath}`
      : tmdbPosterUrl;
    const preferredThumb =
      sourceSpecificThumb &&
      (!storedThumb ||
        storedThumb === DEFAULT_LOCAL_THUMBNAIL ||
        storedThumb.endsWith("/thumbnail.jpg") ||
        storedThumb.endsWith("assets/images/thumbnail.jpg"))
        ? sourceSpecificThumb
        : storedThumb || sourceSpecificThumb || tmdbPosterUrl || DEFAULT_LOCAL_THUMBNAIL;
    const posterUrl = normalizeArtworkPath(preferredThumb);
    const heroUrl = tmdbHeroUrl || posterUrl;
    const safeTitle = escapeHtml(title);
    const safeYear = escapeHtml(year);
    const mediaLabel = looksLikeCourse ? "Course" : "Movie";
    const tagLine = looksLikeCourse
      ? "Uploaded <span>&bull;</span> Course"
      : "Uploaded <span>&bull;</span> Local Library";

    const card = document.createElement("article");
    card.className = "card";
    card.dataset.title = title;
    card.dataset.episode = year || "";
    card.dataset.src = src;
    card.dataset.thumb = heroUrl;
    card.dataset.year = year;
    card.dataset.runtime = mediaLabel;
    card.dataset.maturity = maturity;
    card.dataset.quality = qualityLabel;
    card.dataset.audio = "";
    card.dataset.description =
      String(item?.description || "").trim() ||
      "Uploaded from your local library.";
    card.dataset.cast = "Local file";
    card.dataset.genres = looksLikeCourse ? "Uploaded, Course" : "Uploaded, Local";
    card.dataset.vibe = looksLikeCourse ? "Learning, Local" : "Personal, Local";
    card.dataset.mediaType = "movie";
    card.dataset.libraryType = "movie";
    card.dataset.libraryId = String(item?.id || "").trim();
    card.dataset.librarySrc = src;
    if (item?.tmdbId) {
      card.dataset.tmdbId = String(item.tmdbId).trim();
    }
    const editButtonMarkup = `<button class="hover-round hover-edit" type="button" aria-label="Edit ${safeTitle}">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.5-1 9-9-3.5-3.5-9 9L4 20Zm10.5-12.5 3.5 3.5" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
              </button>`;

    card.innerHTML = `
      <div class="card-base">
        <img data-src="${escapeHtml(posterUrl)}" alt="${safeTitle}" loading="lazy" />
        <progress class="progress" value="90" max="100" aria-hidden="true"></progress>
      </div>
      <div class="card-hover">
        <img class="card-hover-image" data-src="${escapeHtml(heroUrl.replace("/w1280/", "/w780/"))}" alt="${safeTitle} preview" loading="lazy" />
        <div class="card-hover-body">
          <div class="card-hover-controls">
            <div class="card-hover-actions">
              <button class="hover-round hover-play" type="button" aria-label="Play ${safeTitle}">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5v17L20 12 5 3.5Z" /></svg>
              </button>
              <button class="hover-round hover-my-list" type="button" aria-label="Add to My List" aria-pressed="false" data-tooltip="Add to My List">
                ${myListIconMarkup(false)}
              </button>
              ${editButtonMarkup}
            </div>
            <button class="hover-round hover-details" type="button" aria-label="More details">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
          </div>
          <div class="card-hover-meta">
            <span class="meta-age">${maturity}</span>
            <span>${safeYear}</span>
            ${qualityLabel ? `<span class="meta-chip">${qualityLabel}</span>` : ""}
            <span class="meta-spatial">${mediaLabel}</span>
          </div>
          <p class="card-hover-tags">${tagLine}</p>
        </div>
      </div>
    `;

    const cardImage = card.querySelector(".card-base img");
    if (cardImage instanceof HTMLImageElement) {
      cardImage.addEventListener(
        "error",
        () => {
          const fallbackThumb = normalizeArtworkPath(
            getFallbackThumbnailForSource(src) || DEFAULT_LOCAL_THUMBNAIL,
          );
          if (cardImage.src !== new URL(fallbackThumb, window.location.origin).toString()) {
            cardImage.src = fallbackThumb;
          }
        },
        { once: true },
      );
    }

    return card;
  }

  function buildCardFromLocalSeriesElement(
    item,
    tmdbDetails = null,
    imageBase = TMDB_IMAGE_BASE,
  ) {
    const title =
      (String(tmdbDetails?.name || tmdbDetails?.title || "").trim() &&
        String(tmdbDetails?.name || tmdbDetails?.title || "").trim()) ||
      (String(item?.title || "Uploaded Series").trim() || "Uploaded Series");
    const firstAirDate = String(
      tmdbDetails?.first_air_date || tmdbDetails?.release_date || "",
    ).trim();
    const year = firstAirDate
      ? firstAirDate.slice(0, 4)
      : String(item?.year || "").trim() || "Local";
    const episodes = Array.isArray(item?.episodes) ? item.episodes : [];
    const firstEpisode = episodes[0] || null;
    const seriesId = String(item?.id || "").trim();
    const contentKind = String(item?.contentKind || "")
      .trim()
      .toLowerCase();
    const isCourse =
      contentKind === "course" ||
      /\bcourse\b/i.test(title) ||
      /\bcourse\b/i.test(seriesId);
    const mediaLabel = isCourse ? "Course" : "Series";
    const firstEpisodeTitle =
      String(firstEpisode?.title || "").trim() ||
      (isCourse ? "Lesson 1" : "Episode 1");
    const posterPath = tmdbDetails?.poster_path || tmdbDetails?.backdrop_path || "";
    const backdropPath =
      tmdbDetails?.backdrop_path || tmdbDetails?.poster_path || "";
    const localPosterUrl = normalizeArtworkPath(
      firstEpisode?.thumb ||
        getFallbackThumbnailForSource(firstEpisode?.src || "") ||
        DEFAULT_LOCAL_THUMBNAIL,
    );
    const seriesBasePath = backdropPath || posterPath;
    const posterUrl = seriesBasePath
      ? `${imageBase}/${backdropPath ? "w780" : "w500"}${seriesBasePath}`
      : localPosterUrl;
    const heroUrl = backdropPath
      ? `${imageBase}/w1280${backdropPath}`
      : posterUrl;
    const safeTitle = escapeHtml(title);
    const safeYear = escapeHtml(year);
    const maturity = normalizeCertification(tmdbDetails?.certification);
    const genreNames = (tmdbDetails?.genres || [])
      .map((genre) => String(genre?.name || "").trim())
      .filter(Boolean)
      .slice(0, 3);
    const tagLine = genreNames.length
      ? genreNames.map(escapeHtml).join(" <span>&bull;</span> ")
      : `Uploaded <span>&bull;</span> ${mediaLabel}`;
    const shouldHideEpisodePrefix =
      isCourse || /\b(webinar|lesson|module|class)\b/i.test(firstEpisodeTitle);

    const card = document.createElement("article");
    card.className = "card";
    card.dataset.title = title;
    card.dataset.episode = shouldHideEpisodePrefix
      ? firstEpisodeTitle
      : `E1 ${firstEpisodeTitle}`;
    card.dataset.src = "";
    card.dataset.thumb = heroUrl;
    card.dataset.year = year;
    card.dataset.runtime = mediaLabel;
    card.dataset.maturity = maturity;
    card.dataset.quality = "";
    card.dataset.audio = "";
    card.dataset.description =
      String(tmdbDetails?.overview || "").trim() ||
      String(firstEpisode?.description || "").trim() ||
      (isCourse
        ? "Uploaded lessons from your local library."
        : "Uploaded episodes from your local library.");
    card.dataset.cast = "Local file";
    card.dataset.genres = genreNames.length ? genreNames.join(", ") : mediaLabel;
    card.dataset.vibe = genreNames.length
      ? `Popular, ${mediaLabel}`
      : isCourse
        ? "Learning, Local"
        : "Personal, Local";
    card.dataset.mediaType = "tv";
    card.dataset.seriesId = String(item?.id || "").trim();
    card.dataset.libraryType = "series";
    card.dataset.libraryId = String(item?.id || "").trim();
    card.dataset.librarySrc = String(firstEpisode?.src || "").trim();
    card.dataset.episodeIndex = "0";
    if (item?.tmdbId) {
      card.dataset.tmdbId = String(item.tmdbId).trim();
    }
    const editButtonMarkup = `<button class="hover-round hover-edit" type="button" aria-label="Edit ${safeTitle}">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.5-1 9-9-3.5-3.5-9 9L4 20Zm10.5-12.5 3.5 3.5" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
              </button>`;

    card.innerHTML = `
      <div class="card-base">
        <img data-src="${escapeHtml(posterUrl)}" alt="${safeTitle}" loading="lazy" />
        <progress class="progress" value="94" max="100" aria-hidden="true"></progress>
      </div>
      <div class="card-hover">
        <img class="card-hover-image" data-src="${escapeHtml(heroUrl.replace("/w1280/", "/w780/"))}" alt="${safeTitle} preview" loading="lazy" />
        <div class="card-hover-body">
          <div class="card-hover-controls">
            <div class="card-hover-actions">
              <button class="hover-round hover-play" type="button" aria-label="Play ${safeTitle}">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5v17L20 12 5 3.5Z" /></svg>
              </button>
              <button class="hover-round hover-my-list" type="button" aria-label="Add to My List" aria-pressed="false" data-tooltip="Add to My List">
                ${myListIconMarkup(false)}
              </button>
              ${editButtonMarkup}
            </div>
            <button class="hover-round hover-details" type="button" aria-label="More details">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
          </div>
          <div class="card-hover-meta">
            <span class="meta-age">${maturity}</span>
            <span>${safeYear}</span>
            <span class="meta-spatial">${mediaLabel}</span>
          </div>
          <p class="card-hover-tags">${tagLine}</p>
        </div>
      </div>
    `;

    return card;
  }

  // ---- Render popular cards ----
  function getPopularCardsContainer() {
    if (cardsContainerRef instanceof HTMLElement) {
      return cardsContainerRef;
    }
    const container = document.getElementById("cardsContainer");
    if (container instanceof HTMLElement) {
      cardsContainerRef = container;
      return container;
    }
    return null;
  }

  function buildBrowseRailCards(
    results,
    genreMap,
    imageBase,
    { limit = BROWSE_RAIL_LIMIT, seenKeys = null } = {},
  ) {
    const seenIds = new Set();
    const sharedSeenKeys = seenKeys instanceof Set ? seenKeys : null;
    const cards = [];
    (Array.isArray(results) ? results : []).some((item) => {
      const identity = getTmdbItemIdentity(item);
      if (!identity || seenIds.has(identity) || sharedSeenKeys?.has(identity)) {
        return false;
      }
      seenIds.add(identity);
      sharedSeenKeys?.add(identity);
      cards.push(
        buildCardFromTmdbElement(
          item,
          genreMap,
          imageBase,
        ),
      );
      return cards.length >= limit;
    });
    return cards;
  }

  function renderBrowseRailContainer(container, cardsToRender) {
    if (!(container instanceof HTMLElement)) {
      return;
    }
    unobserveDeferredArtwork(container);
    container.innerHTML = "";
    const fragment = document.createDocumentFragment();
    cardsToRender.forEach((card, index) => {
      if (index >= Math.max(1, cardsToRender.length - 2)) {
        card.classList.add("card--align-right");
      }
      fragment.appendChild(card);
      attachCardInteractions(card);
    });
    container.appendChild(fragment);
    attachArtworkImageFallbacks(container);
  }

  function applyLibrarySnapshot(localLibrary) {
    if (!localLibrary || typeof localLibrary !== "object") {
      return;
    }
    homeLibrarySnapshot = localLibrary;
    myListLibraryEntries = buildLibraryMyListEntries(localLibrary);
    renderMyListRow();
  }

  function applyHomeBootstrapPayload(bootstrap, { heroPreviewMap = null } = {}) {
    if (!bootstrap || typeof bootstrap !== "object" || isWarmingHomeBootstrap(bootstrap)) {
      return false;
    }

    const popularPayload = toPopularMoviesPayload(bootstrap);
    const genreMap = buildGenreMapFromPayload({
      genres: Array.isArray(bootstrap?.genres)
        ? bootstrap.genres
        : popularPayload.genres,
    });
    const imageBase = popularPayload.imageBase || TMDB_IMAGE_BASE;
    const library = bootstrap.library || null;
    const seenHomeRailKeys = new Set();

    applyLibrarySnapshot(library);

    const popularCards = buildBrowseRailCards(
      getBootstrapResults(bootstrap, "bingeworthy", "nowPlaying", "popular"),
      genreMap,
      imageBase,
      { seenKeys: seenHomeRailKeys },
    );
    if (popularCards.length > 0) {
      applyFeaturedHeroFromPopularPayload(popularPayload, library, heroPreviewMap);
      setPopularRowTitle("Popular series");
      setPopularRowVisible(true);
      renderPopularCards(popularCards);
    } else if (Array.isArray(popularPayload.results) && popularPayload.results.length > 0) {
      applyFeaturedHeroFromPopularPayload(popularPayload, library, heroPreviewMap);
      setPopularRowVisible(false);
      renderPopularCards([]);
    } else {
      setPopularRowVisible(false);
      renderPopularCards([]);
    }

    const trendingCards = buildBrowseRailCards(
      getBootstrapResults(bootstrap, "crowdPleasers", "trending"),
      genreMap,
      imageBase,
      { seenKeys: seenHomeRailKeys },
    );
    setTrendingRowVisible(trendingCards.length > 0);
    renderBrowseRailContainer(trendingCardsContainerRef, trendingCards);

    const nowPlayingCards = buildBrowseRailCards(
      getBootstrapResults(bootstrap, "topSeries", "nowPlaying"),
      genreMap,
      imageBase,
      { limit: TOP_TEN_RAIL_LIMIT, seenKeys: seenHomeRailKeys },
    );
    setNowPlayingRowVisible(nowPlayingCards.length > 0);
    renderBrowseRailContainer(nowPlayingCardsContainerRef, nowPlayingCards);

    const topRatedCards = buildBrowseRailCards(
      getBootstrapResults(bootstrap, "criticallyAcclaimed", "topRated"),
      genreMap,
      imageBase,
      { seenKeys: seenHomeRailKeys },
    );
    setTopRatedRowVisible(topRatedCards.length > 0);
    renderBrowseRailContainer(topRatedCardsContainerRef, topRatedCards);

    const hasBrowseContent =
      popularCards.length > 0 ||
      trendingCards.length > 0 ||
      nowPlayingCards.length > 0 ||
      topRatedCards.length > 0;
    if (hasBrowseContent) {
      markHomeBrowseContentReady();
    }
    return hasBrowseContent;
  }

  async function initializeHomeContent() {
    const bootstrap = await resolveHomeBootstrap();
    if (bootstrap) {
      const previewResult = await fetchHeroPreviewManifest().catch(() => null);
      if (applyHomeBootstrapPayload(bootstrap, { heroPreviewMap: previewResult })) {
        return;
      }
    }
    void loadPopularTitles();
  }

  function renderPopularCards(cardsToRender) {
    const container = getPopularCardsContainer();
    if (!container) return;
    unobserveDeferredArtwork(container);
    container.innerHTML = "";
    const fragment = document.createDocumentFragment();
    cardsToRender.forEach((card, index) => {
      if (index >= Math.max(1, cardsToRender.length - 2)) {
        card.classList.add("card--align-right");
      }
      fragment.appendChild(card);
      attachCardInteractions(card);
    });
    container.appendChild(fragment);
    attachArtworkImageFallbacks(container);
  }

  function getLocalSeriesIdentity(item) {
    const explicitId = String(item?.id || "").trim();
    if (explicitId) {
      return explicitId;
    }
    const tmdbId = String(item?.tmdbId || "").trim();
    if (tmdbId) {
      return `tmdb:${tmdbId}`;
    }
    const titleKey = normalizeLibraryTitleKey(item?.title || "");
    const yearKey = String(item?.year || "").trim();
    return titleKey ? `${titleKey}|${yearKey}` : "";
  }

  function getLocalSeriesUploadedAt(item) {
    return Math.max(
      Number(item?.uploadedAt || 0),
      ...((Array.isArray(item?.episodes) ? item.episodes : []).map((episode) =>
        Number(episode?.uploadedAt || 0),
      )),
    );
  }

  function buildLibraryMyListEntries(localLibrary) {
    const localMoviesRaw = Array.isArray(localLibrary?.movies)
      ? localLibrary.movies
      : [];
    const localMoviesMap = new Map();
    localMoviesRaw.forEach((entry) => {
      const tmdbId = String(entry?.tmdbId || "").trim();
      const titleKey = normalizeLibraryTitleKey(entry?.title || "");
      const yearKey = String(entry?.year || "").trim();
      const key = tmdbId || (titleKey ? `${titleKey}|${yearKey}` : "");
      if (!key) {
        return;
      }
      const existing = localMoviesMap.get(key);
      const existingUploadedAt = Number(existing?.uploadedAt || 0);
      const nextUploadedAt = Number(entry?.uploadedAt || 0);
      if (!existing || nextUploadedAt >= existingUploadedAt) {
        localMoviesMap.set(key, entry);
      }
    });
    const localMovies = Array.from(localMoviesMap.values()).sort(
      (left, right) => Number(right?.uploadedAt || 0) - Number(left?.uploadedAt || 0),
    );

    const localSeriesRaw = Array.isArray(localLibrary?.series)
      ? localLibrary.series
      : [];
    const localSeriesMap = new Map();
    localSeriesRaw.forEach((entry) => {
      const key = getLocalSeriesIdentity(entry);
      if (!key) {
        return;
      }
      const existing = localSeriesMap.get(key);
      const existingUploadedAt = getLocalSeriesUploadedAt(existing);
      const nextUploadedAt = getLocalSeriesUploadedAt(entry);
      if (!existing || nextUploadedAt >= existingUploadedAt) {
        localSeriesMap.set(key, entry);
      }
    });
    const localSeries = Array.from(localSeriesMap.values()).sort(
      (left, right) => getLocalSeriesUploadedAt(right) - getLocalSeriesUploadedAt(left),
    );

    return [
      ...localMovies
        .filter((item) => String(item?.src || "").trim())
        .map((item) => ({
          type: "movie",
          uploadedAt: Number(item?.uploadedAt || 0),
          item,
        })),
      ...localSeries
        .filter((item) =>
          (Array.isArray(item?.episodes) ? item.episodes : []).some((episode) =>
            String(episode?.src || "").trim(),
          ),
        )
        .map((item) => ({
          type: "series",
          uploadedAt: getLocalSeriesUploadedAt(item),
          item,
        })),
    ].sort((left, right) => right.uploadedAt - left.uploadedAt);
  }

  function buildPopularTitleCards(payload) {
    const genreMap = new Map();
    (Array.isArray(payload?.genres) ? payload.genres : []).forEach((genre) => {
      genreMap.set(genre.id, genre.name);
    });
    const imageBase = payload?.imageBase || TMDB_IMAGE_BASE;
    const seenIds = new Set();
    return (Array.isArray(payload?.results) ? payload.results : [])
      .filter((item) => {
        const identity = getTmdbItemIdentity(item);
        if (!identity || seenIds.has(identity)) {
          return false;
        }
        seenIds.add(identity);
        return true;
      })
      .slice(0, POPULAR_TITLES_LIMIT)
      .map((item) => buildCardFromTmdbElement(item, genreMap, imageBase));
  }

  function buildLocalFallbackCards(entries) {
    return (Array.isArray(entries) ? entries : [])
      .slice(0, POPULAR_TITLES_LIMIT)
      .map((entry) =>
        entry.type === "series"
          ? buildCardFromLocalSeriesElement(entry.item)
          : buildCardFromLocalMovieElement(entry.item),
      );
  }

  function applyLocalLibraryFallbackHome(localLibrary) {
    if (homeBrowseContentReady) {
      return;
    }
    const localEntries = buildLibraryMyListEntries(localLibrary);
    const localHero = createFeaturedHeroFromLocalEntry(localEntries[0]);
    const localCards = buildLocalFallbackCards(localEntries);

    stopHeroCarouselTimer();
    setFeaturedHeroCandidates([]);
    setFeaturedHeroIndex(0);
    stopHeroPreview();

    if (localHero.title && (localHero.src || localHero.seriesId || localHero.tmdbId)) {
      setFeaturedHero(localHero);
      setFeaturedHeroReady(true);
    } else {
      setFeaturedHeroReady(false);
      setFeaturedHero(createDefaultFeaturedHero(UNRATED_CERTIFICATION_LABEL));
    }

    setPopularRowTitle("Recently Added");
    setPopularRowVisible(localCards.length > 0);
    renderPopularCards(localCards);
  }

  function applyFeaturedHeroCandidate(selected) {
    if (!selected) {
      setFeaturedHeroReady(false);
      setFeaturedHero(createDefaultFeaturedHero(UNRATED_CERTIFICATION_LABEL));
      stopHeroPreview();
      return;
    }
    const currentTmdbId = String(featuredHero()?.tmdbId || "").trim();
    if (currentTmdbId && currentTmdbId !== selected.tmdbId) {
      stopHeroPreview();
    }
    setFeaturedHeroReady(true);
    setFeaturedHero(selected);
    void hydrateFeaturedHeroFromTmdb(selected);
  }

  function selectFeaturedHeroByIndex(index) {
    const candidates = featuredHeroCandidates();
    if (!candidates.length) {
      return;
    }
    const normalizedIndex =
      ((Number(index) % candidates.length) + candidates.length) % candidates.length;
    setFeaturedHeroIndex(normalizedIndex);
    applyFeaturedHeroCandidate(candidates[normalizedIndex]);
    startHeroCarouselTimer();
  }

  function advanceFeaturedHeroCarousel() {
    const candidates = featuredHeroCandidates();
    if (candidates.length <= 1) {
      return;
    }
    selectFeaturedHeroByIndex(featuredHeroIndex() + 1);
  }

  function stopHeroCarouselTimer() {
    if (heroCarouselTimer) {
      window.clearTimeout(heroCarouselTimer);
      heroCarouselTimer = null;
    }
  }

  function startHeroCarouselTimer() {
    stopHeroCarouselTimer();
    if (heroMotionPaused() || prefersReducedHeroMotion() || featuredHeroCandidates().length <= 1) {
      return;
    }
    const delay = getFeaturedHeroAutoAdvanceDelay(featuredHero(), {
      reducedMotion: prefersReducedHeroMotion(),
    });
    heroCarouselTimer = window.setTimeout(() => {
      heroCarouselTimer = null;
      if (activeView() !== "home" || showSearchExperience() || document.hidden) {
        startHeroCarouselTimer();
        return;
      }
      advanceFeaturedHeroCarousel();
    }, delay);
  }

  function handleHeroCarouselDotClick(index) {
    selectFeaturedHeroByIndex(index);
  }

  function applyFeaturedHeroFromPopularPayload(
    payload,
    localLibrary = null,
    heroPreviewMap = null,
  ) {
    const candidates = buildFeaturedHeroCandidates(
      payload,
      localLibrary,
      heroPreviewMap,
      {
        imageBase: TMDB_IMAGE_BASE,
        unratedLabel: UNRATED_CERTIFICATION_LABEL,
      },
    );
    setFeaturedHeroCandidates(candidates);
    const selected = selectFeaturedHeroCandidate(candidates);
    const selectedIndex = candidates.findIndex(
      (item) => item.tmdbId === selected?.tmdbId,
    );
    setFeaturedHeroIndex(selectedIndex >= 0 ? selectedIndex : 0);
    applyFeaturedHeroCandidate(selected);
    startHeroCarouselTimer();
  }

  async function hydrateFeaturedHeroFromTmdb(hero) {
    const tmdbId = String(hero?.tmdbId || "").trim();
    if (!tmdbId) {
      return;
    }
    const requestVersion = ++featuredHeroDetailsRequestVersion;
    try {
      const details = await apiFetchWithTimeout(
        "/api/tmdb/details",
        {
          tmdbId,
          mediaType: "movie",
        },
        TMDB_DETAILS_MODAL_TIMEOUT_MS,
      );
      if (
        requestVersion !== featuredHeroDetailsRequestVersion ||
        String(featuredHero()?.tmdbId || "").trim() !== tmdbId
      ) {
        return;
      }
      const releaseDate = String(details?.release_date || "").trim();
      const year = releaseDate ? releaseDate.slice(0, 4) : hero.year;
      const genreNames = (Array.isArray(details?.genres) ? details.genres : [])
        .map((genre) => String(genre?.name || "").trim())
        .filter(Boolean)
        .slice(0, 2);
      const backdropPath = String(
        details?.backdrop_path || details?.poster_path || "",
      ).trim();
      const poster = backdropPath
        ? `${TMDB_IMAGE_BASE}/w1280${backdropPath}`
        : hero.poster;
      const trailerKey = selectFeaturedHeroTrailerKey(details);
      setFeaturedHero((current) => {
        if (String(current?.tmdbId || "").trim() !== tmdbId) {
          return current;
        }
        return {
          ...current,
          title: normalizeHeroTitle(details?.title || current.title),
          year,
          runtime: formatRuntime(details?.runtime) || current.runtime || "Movie",
          maturity: normalizeCertification(
            details?.certification || current.maturity,
          ),
          tagline:
            String(details?.tagline || "").trim() ||
            current.tagline ||
            "",
          description:
            String(details?.overview || "").trim() ||
            current.description ||
            "No description available.",
          poster,
          thumb: poster || current.thumb,
          trailerKey,
          callouts: [
            current.src ? "Available locally" : "Top global movie",
            genreNames.length ? genreNames.join(" / ") : current.callouts?.[1],
          ].filter(Boolean),
          ready: true,
        };
      });
      startHeroCarouselTimer();
      if (canPlayHeroPreview()) {
        playHeroPreview();
      } else {
        ensureHeroPreviewPreloadSource();
      }
    } catch (error) {
      console.error("Failed to load featured hero details:", error);
    }
  }

  // ---- Load popular titles ----
  async function loadPopularTitles({ allowRetry = true, warmingRetry = 0 } = {}) {
    const container = getPopularCardsContainer();
    if (!container) {
      if (allowRetry) {
        requestAnimationFrame(() => {
          void loadPopularTitles({ allowRetry: false, warmingRetry });
        });
      }
      return;
    }

    const libraryRequest = (homeLibrarySnapshot
      ? Promise.resolve(homeLibrarySnapshot)
      : apiFetch("/api/library")).then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    );
    const bootstrapRequest = resolveHomeBootstrap().then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    );
    const previewRequest = fetchHeroPreviewManifest().then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    );

    let hasLocalFallback = false;
    void libraryRequest.then((libraryResult) => {
      if (libraryResult.status !== "fulfilled") {
        console.error("Failed to load local library titles:", libraryResult.reason);
        myListLibraryEntries = [];
        renderMyListRow();
        return;
      }
      applyLibrarySnapshot(libraryResult.value);
      hasLocalFallback = myListLibraryEntries.length > 0;
      applyLocalLibraryFallbackHome(libraryResult.value);
    });

    const [bootstrapResult, previewResult] = await Promise.all([
      bootstrapRequest,
      previewRequest,
    ]);

    if (
      bootstrapResult.status === "fulfilled" &&
      isWarmingHomeBootstrap(bootstrapResult.value)
    ) {
      if (warmingRetry < HOME_BOOTSTRAP_WARM_RETRY_LIMIT) {
        window.setTimeout(() => {
          void loadPopularTitles({
            allowRetry,
            warmingRetry: warmingRetry + 1,
          });
        }, HOME_BOOTSTRAP_WARM_RETRY_MS);
      }
      return;
    }

    if (bootstrapResult.status === "fulfilled" && bootstrapResult.value) {
      const previewMap =
        previewResult.status === "fulfilled" ? previewResult.value : null;
      if (applyHomeBootstrapPayload(bootstrapResult.value, { heroPreviewMap: previewMap })) {
        return;
      }
    }

    const popularRequest = apiFetchWithTimeout(
      "/api/tmdb/popular-movies",
      { page: "1" },
      3500,
    ).then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    );
    const popularResult = await popularRequest;

    if (popularResult.status !== "fulfilled") {
      const logPopularFailure = hasLocalFallback ? console.warn : console.error;
      logPopularFailure(
        hasLocalFallback
          ? "Using local library because TMDB popular titles failed:"
          : "Failed to load TMDB popular titles:",
        popularResult.reason,
      );
      if (allowRetry) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        return loadPopularTitles({ allowRetry: false, warmingRetry });
      }
      if (!hasLocalFallback) {
        setFeaturedHeroReady(false);
        setPopularRowVisible(false);
        setTrendingRowVisible(false);
        setNowPlayingRowVisible(false);
        setTopRatedRowVisible(false);
        renderPopularCards([]);
      }
      return;
    }

    const libraryResult = await libraryRequest;
    const cardsToRender = buildPopularTitleCards(popularResult.value);
    if (!cardsToRender.length && hasLocalFallback) {
      return;
    }
    applyFeaturedHeroFromPopularPayload(
      popularResult.value,
      libraryResult.status === "fulfilled" ? libraryResult.value : null,
      previewResult.status === "fulfilled" ? previewResult.value : null,
    );
    setPopularRowTitle(
      getPopularRowTitle(popularResult.value, {
        popularTitlesLimit: POPULAR_TITLES_LIMIT,
      }),
    );
    setPopularRowVisible(cardsToRender.length > 0);
    markHomeBrowseContentReady();
    renderPopularCards(cardsToRender);
  }

  // ---- Load continue watching ----
  async function loadContinueWatching() {
    if (!continueCardsRef) {
      return;
    }
    const hydration = getHydrationState();
    setContinueLoading(hydration.pending && !hydration.didLoadContinueWatching);
    setContinueEmptyVisible(getContinueWatchingEntries().length === 0);
    // Authentication owns and clears these caches. Hydration already fetched the
    // authoritative row; using it here avoids a duplicate endpoint and render gate.
    const entries = enrichContinueEntriesWithLocalLibrary(
      getContinueWatchingEntries(),
      homeLibrarySnapshot,
    );
    const signature = JSON.stringify(entries);
    if (signature === continueEntriesSignature) return;
    continueEntriesSignature = signature;
    const loadVersion = ++continueWatchingLoadVersion;
    if (!entries.length) {
      unobserveDeferredArtwork(continueCardsRef);
      continueCardsRef.innerHTML = "";
      setContinueEmptyVisible(true);
      // Keep a reserved row's footprint when an empty response arrives after
      // paint. A known-empty offline session can still omit the row entirely.
      setContinueRowVisible(initiallyPendingContinue);
      renderMyListRow();
      return;
    }

    const tmdbDetailKeys = Array.from(
      new Set(
        entries
          .map((entry) => {
            const tmdbId = String(entry.tmdbId || "").trim();
            if (!tmdbId) {
              return "";
            }
            const mediaType =
              inferContinueMediaType(
                entry.sourceIdentity,
                entry.mediaType,
                entry.seriesId,
              ) || "movie";
            return `${mediaType}:${tmdbId}`;
          })
          .filter(Boolean),
      ),
    );

    const renderEntries = () => {
      if (loadVersion !== continueWatchingLoadVersion || !continueCardsRef) {
        return;
      }
      unobserveDeferredArtwork(continueCardsRef);
      continueCardsRef.innerHTML = "";
      const fragment = document.createDocumentFragment();
      entries.forEach((entry, index) => {
        const normalizedMediaType =
          inferContinueMediaType(
            entry.sourceIdentity,
            entry.mediaType,
            entry.seriesId,
          ) || "movie";
        const detailsLookupKey = entry.tmdbId
          ? `${normalizedMediaType}:${String(entry.tmdbId).trim()}`
          : "";
        const details = detailsLookupKey
          ? continueDetailsCache.get(detailsLookupKey) || null
          : null;
        const card = buildContinueWatchingCardElement(entry, details);
        if (index >= Math.max(1, entries.length - 2)) {
          card.classList.add("card--align-right");
        }
        fragment.appendChild(card);
        attachCardInteractions(card);
      });
      continueCardsRef.appendChild(fragment);
      attachArtworkImageFallbacks(continueCardsRef);

      setContinueRowVisible(true);
      setContinueEmptyVisible(false);
      renderMyListRow();
    };

    renderEntries();

    if (!tmdbDetailKeys.length) {
      return;
    }

    void (async () => {
      await Promise.allSettled(
        tmdbDetailKeys.map(async (detailKey) => {
          if (!continueDetailsCache.has(detailKey)) {
            let request = continueDetailsRequests.get(detailKey);
            if (!request) {
              const [mediaType, tmdbId] = detailKey.split(":");
              request = apiFetchWithTimeout(
                "/api/tmdb/details", { tmdbId, mediaType },
                TMDB_DETAILS_ENRICHMENT_TIMEOUT_MS,
              ).then((details) => {
                if (details && typeof details === "object") {
                  continueDetailsCache.set(detailKey, details);
                }
              }).finally(() => continueDetailsRequests.delete(detailKey));
              continueDetailsRequests.set(detailKey, request);
            }
            await request;
          }
          if (loadVersion !== continueWatchingLoadVersion || !continueCardsRef) return;
          const details = continueDetailsCache.get(detailKey);
          if (!details) return;
          entries.forEach((entry) => {
            const mediaType = inferContinueMediaType(
              entry.sourceIdentity, entry.mediaType, entry.seriesId,
            ) || "movie";
            if (`${mediaType}:${entry.tmdbId}` !== detailKey) return;
            const card = Array.from(continueCardsRef.children).find(
              (element) => element.dataset.resumeSource === entry.sourceIdentity,
            );
            if (!card) return;
            const enriched = buildContinueWatchingCardElement(entry, details);
            Object.assign(card.dataset, enriched.dataset);
            card.querySelector(".card-primary-action")?.setAttribute("aria-label", `Play ${card.dataset.title}`);
            card.querySelector(".hover-play")?.setAttribute("aria-label", `Resume ${card.dataset.title}`);
            card.querySelector(".hover-remove")?.setAttribute("aria-label", `Remove ${card.dataset.title} from row`);
            addBrowseCardCaption(enriched);
            // Preserve the existing artwork, focused controls and card geometry.
            // Only richer text/progress changes after the first render.
            [".continue-caption", ".browse-card-title", ".browse-card-meta", ".card-hover-title",
              ".card-hover-meta", ".card-hover-tags", ".card-hover-progress"].forEach((selector) => {
              const target = card.querySelector(selector);
              const source = enriched.querySelector(selector);
              if (target && source) target.innerHTML = source.innerHTML;
            });
            const progress = enriched.querySelector(".card-base > .progress");
            if (progress) {
              const existing = card.querySelector(".card-base > .progress");
              if (existing) existing.value = progress.value;
              else card.querySelector(".card-base")?.appendChild(progress);
            }
          });
        }),
      );
    })();
  }

  // ---- Search ----
  function hideSearchContextMenu() {
    searchContextTarget = null;
    setSearchContextMenuVisible(false);
  }

  function openSearchContextMenu(event, details) {
    const payload = details && typeof details === "object" ? details : null;
    if (!payload) {
      return;
    }
    event.preventDefault();
    searchContextTarget = payload;
    setSearchContextMenuVisible(true);

    requestAnimationFrame(() => {
      if (!searchContextMenuRef) return;
      const margin = 10;
      const menuRect = searchContextMenuRef.getBoundingClientRect();
      const maxLeft = Math.max(margin, window.innerWidth - menuRect.width - margin);
      const maxTop = Math.max(margin, window.innerHeight - menuRect.height - margin);
      const left = Math.max(margin, Math.min(event.clientX, maxLeft));
      const top = Math.max(margin, Math.min(event.clientY, maxTop));
      setRuntimeStyleRule("#searchContextMenu", {
        left: `${left}px`,
        top: `${top}px`,
      });
    });
  }

  function scheduleTmdbSearchFromInput() {
    if (!navSearchInputRef) return;
    if (!isSearchModeActive()) openSearchMode({ focusInput: false });
    updateSearchState({ query: navSearchInputRef.value, personId: "" });
  }

  function updateSearchState(patch) {
    const next = normalizeSearchState({ ...searchState(), ...patch });
    setSearchState(next);
    if (navSearchInputRef && "query" in patch && navSearchInputRef.value.trim() !== next.query) navSearchInputRef.value = next.query;
    if (isSearchModeActive()) {
      window.history.replaceState(window.history.state, "", searchLocation(window.location.href, next));
    }
  }

  function openSearchMode({ focusInput = true, push = true } = {}) {
    const wasActive = isSearchModeActive();
    setSearchRestoreFocus(!focusInput);
    if (push && !wasActive) {
      const origin = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      window.history.replaceState({ ...window.history.state, scrollY: window.scrollY }, "");
      window.history.pushState({ searchOrigin: origin }, "", searchLocation(window.location.href, searchState()));
    }
    if (searchBoxHideTimer) {
      clearTimeout(searchBoxHideTimer);
      searchBoxHideTimer = null;
    }
    stopHeroPreview();
    setIsSearchModeActive(true);
    hideSearchContextMenu();
    document.body.classList.add("is-search-mode");
    setShowSearchExperience(true);
    setShowSearchBox(true);
    if (navSearchInputRef) navSearchInputRef.value = searchState().query;
    if (push && !wasActive) window.scrollTo({ top: 0, behavior: "auto" });
    requestAnimationFrame(() => {
      setSearchBoxOpen(true);
    });

    if (focusInput && navSearchInputRef) {
      requestAnimationFrame(() => {
        navSearchInputRef.focus({ preventScroll: true });
        navSearchInputRef.select();
      });
    }
  }

  function closeSearchMode() {
    if (isSearchModeActive()) captureSearchReturnState?.();
    setIsSearchModeActive(false);
    hideSearchContextMenu();
    document.body.classList.remove("is-search-mode");
    setShowSearchExperience(false);
    setSearchBoxOpen(false);
    if (searchBoxHideTimer) {
      clearTimeout(searchBoxHideTimer);
    }
    searchBoxHideTimer = window.setTimeout(() => {
      setShowSearchBox(false);
      searchBoxHideTimer = null;
    }, 220);
  }

  function closeSearchAndReturn() {
    const origin = window.history.state?.searchOrigin;
    closeSearchMode();
    if (origin && window.history.length > 1) window.history.back();
    else window.history.replaceState(window.history.state, "", searchLocation(window.location.href, searchState(), false));
    pageRootRef?.focus({ preventScroll: true });
  }

  // ---- Account menu ----
  function openAccountMenu() {
    setAccountMenuOpen(true);
  }

  function closeAccountMenu() {
    setAccountMenuOpen(false);
  }

  function handleAccountMenuToggle(event) {
    event.preventDefault();
    event.stopPropagation();
    if (accountMenuOpen()) {
      closeAccountMenu();
    } else {
      openAccountMenu();
    }
  }

  // ---- Hero ----
  function getHeroPreviewFrame() {
    return heroPreviewFrameRef instanceof HTMLIFrameElement
      ? heroPreviewFrameRef
      : null;
  }

  function getHeroTrailerKey() {
    return normalizeYoutubeVideoKey(featuredHero()?.trailerKey);
  }

  function prefersReducedHeroMotion() {
    try {
      return window.matchMedia(HERO_PREVIEW_REDUCED_MOTION_QUERY).matches;
    } catch {
      return false;
    }
  }

  function canPlayHeroPreview() {
    return (
      !heroMotionPaused() &&
      !isConstrainedConnection() &&
      !detailsModalVisible() &&
      heroPreviewInViewport &&
      activeView() === "home" &&
      !showSearchExperience() &&
      !document.hidden &&
      !prefersReducedHeroMotion() &&
      Boolean(getHeroTrailerKey())
    );
  }

  function canPreloadHeroPreview() {
    return canPlayHeroPreview();
  }

  function sendHeroPreviewCommand(command, args = []) {
    const frame = getHeroPreviewFrame();
    if (!frame?.contentWindow || !frame.getAttribute("src")) {
      return false;
    }
    frame.contentWindow.postMessage(
      JSON.stringify({ event: "command", func: command, args }),
      HERO_PREVIEW_EMBED_ORIGIN,
    );
    return true;
  }

  function syncHeroPreviewAudio() {
    sendHeroPreviewCommand(isMuted() ? "mute" : "unMute");
    if (!isMuted()) {
      sendHeroPreviewCommand("setVolume", [100]);
    }
  }

  function ensureHeroPreviewFrameLoaded() {
    const frame = getHeroPreviewFrame();
    const previewSrc = buildYoutubeTrailerEmbedUrl(getHeroTrailerKey());
    if (!frame || !previewSrc || !canPreloadHeroPreview()) {
      return false;
    }
    if (frame.getAttribute("src") !== previewSrc) {
      setHeroPreviewPlaying(false);
      frame.setAttribute("src", previewSrc);
    }
    return true;
  }

  function applyHeroPreviewMutedState(nextMuted) {
    setIsMuted(nextMuted);
    if (heroPreviewActive() && canPlayHeroPreview()) {
      syncHeroPreviewAudio();
    }
  }

  function ensureHeroPreviewPreloadSource() {
    if (!ensureHeroPreviewFrameLoaded()) {
      return false;
    }
    setHeroPreviewActive(false);
    return true;
  }

  function suspendHeroPreviewForViewport() {
    sendHeroPreviewCommand("pauseVideo");
    setHeroPreviewPlaying(false);
  }

  function resumeHeroPreviewAfterViewport() {
    if (heroPreviewActive() && getHeroPreviewFrame()?.getAttribute("src")) {
      resumeHeroPreviewPlayback();
      return;
    }
    if (canPlayHeroPreview()) {
      playHeroPreview();
      return;
    }
    if (!heroPreviewActive()) {
      ensureHeroPreviewPreloadSource();
    }
  }

  function resumeHeroPreviewPlayback() {
    const frame = getHeroPreviewFrame();
    if (!frame || !canPlayHeroPreview()) {
      return false;
    }

    const hadLoadedSource = Boolean(frame.getAttribute("src"));
    if (!ensureHeroPreviewFrameLoaded()) {
      return false;
    }
    syncHeroPreviewAudio();
    sendHeroPreviewCommand("playVideo");
    if (hadLoadedSource) {
      setHeroPreviewPlaying(true);
    }
    return true;
  }

  function handleHeroPreviewFrameLoad() {
    const frame = getHeroPreviewFrame();
    if (!frame?.getAttribute("src") || !heroPreviewActive() || !canPlayHeroPreview()) {
      return;
    }
    syncHeroPreviewAudio();
    sendHeroPreviewCommand("playVideo");
    heroPreviewStartedTrailerKey = getHeroTrailerKey();
    stopHeroCarouselTimer();
    setHeroPreviewPlaying(true);
  }

  function handleHeroPreviewMessage(event) {
    const frame = getHeroPreviewFrame();
    if (
      !frame?.contentWindow ||
      event.source !== frame.contentWindow ||
      !HERO_PREVIEW_MESSAGE_ORIGINS.has(event.origin)
    ) {
      return;
    }
    let payload = event.data;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        return;
      }
    }
    if (!payload || typeof payload !== "object") {
      return;
    }
    if (!canPlayHeroPreview()) {
      sendHeroPreviewCommand("pauseVideo");
      return;
    }
    if (payload.event === "onReady") {
      syncHeroPreviewAudio();
      sendHeroPreviewCommand("playVideo");
      return;
    }
    if (payload.event === "onError") {
      stopHeroPreview();
      advanceFeaturedHeroCarousel();
      return;
    }
    const playerState = Number(
      payload.event === "onStateChange"
        ? payload.info
        : payload?.info?.playerState,
    );
    if (
      (payload.event === "onStateChange" || payload.event === "infoDelivery") &&
      Number.isFinite(playerState)
    ) {
      if (playerState === 1) {
        heroPreviewStartedTrailerKey = getHeroTrailerKey();
        stopHeroCarouselTimer();
        setHeroPreviewPlaying(true);
      } else if (playerState === 0) {
        const finishedTrailerKey = getHeroTrailerKey();
        const didFinishCurrentTrailer =
          Boolean(finishedTrailerKey) &&
          heroPreviewStartedTrailerKey === finishedTrailerKey;
        heroPreviewStartedTrailerKey = "";
        setHeroPreviewPlaying(false);
        if (didFinishCurrentTrailer) {
          advanceFeaturedHeroCarousel();
        }
      } else if (playerState === 2 || playerState === 5) {
        setHeroPreviewPlaying(false);
      }
    }
  }

  function stopHeroPreview() {
    const frame = getHeroPreviewFrame();
    heroPreviewStartedTrailerKey = "";
    sendHeroPreviewCommand("stopVideo");
    frame?.removeAttribute("src");
    setHeroPreviewActive(false);
    setHeroPreviewPlaying(false);
  }

  function updateHeroPreviewViewportState(entry) {
    const ratio = entry?.intersectionRatio ?? 0;
    const intersecting = Boolean(entry?.isIntersecting);
    let nextInViewport = heroPreviewInViewport;

    if (!intersecting || ratio <= HERO_PREVIEW_LEAVE_VISIBLE_RATIO) {
      nextInViewport = false;
    } else if (ratio >= HERO_PREVIEW_ENTER_VISIBLE_RATIO) {
      nextInViewport = true;
    }

    if (nextInViewport === heroPreviewInViewport) {
      return;
    }

    heroPreviewInViewport = nextInViewport;
    if (!heroPreviewInViewport) {
      if (heroPreviewActive() && getHeroPreviewFrame()?.getAttribute("src")) {
        suspendHeroPreviewForViewport();
      }
      return;
    }
    resumeHeroPreviewAfterViewport();
  }

  function playHeroPreview() {
    if (!canPlayHeroPreview()) {
      stopHeroPreview();
      return;
    }
    if (!getHeroTrailerKey()) {
      stopHeroPreview();
      return;
    }
    setHeroPreviewActive(true);
    if (!resumeHeroPreviewPlayback()) {
      setHeroPreviewActive(false);
      stopHeroPreview();
    }
  }

  function scheduleHeroPreviewPlayback() {
    if (!canPlayHeroPreview()) {
      return;
    }
    playHeroPreview();
  }

  function handleHeroMotionToggle() {
    setHeroMotionPaused(!heroMotionPaused());
    if (heroMotionPaused()) {
      stopHeroCarouselTimer();
      suspendHeroPreviewForViewport();
    } else {
      startHeroCarouselTimer();
      playHeroPreview();
    }
  }

  function handleMuteToggle() {
    applyHeroPreviewMutedState(!isMuted());
  }

  function handleHeroPlay() {
    const destination = getHeroDestination();
    if (destination) {
      openPlayerPage(titlePlaybackTarget(destination, findTitleResume(destination, getContinueWatchingEntries())));
    }
  }

  function handleHeroInfo(event) {
    const destination = getHeroDestination();
    if (!destination) {
      return;
    }
    const hero = featuredHero();
    openDetailsModal(null, event?.currentTarget, {
      ...destination,
      thumb: hero.poster || destination.thumb,
      runtime: hero.runtime || "",
      maturity: normalizeCertification(hero.maturity),
      description: hero.description || "",
      cast: "Loading cast...",
      genres: getFeaturedHeroCallouts(hero).slice(1).join(", "),
      vibe: hero.tagline || "",
    });
  }

  // ---- Sign out ----
  async function handleSignOut(e) {
    e.preventDefault();
    await signOut();
  }

  // ---- Search event handlers ----
  function handleOpenSearch(event) {
    event.preventDefault();
    event.stopPropagation();
    if (isSearchModeActive()) {
      navSearchInputRef?.focus({ preventScroll: true });
      return;
    }
    openSearchMode();
  }

  function handleCloseSearch(event) {
    event.preventDefault();
    event.stopPropagation();
    closeSearchAndReturn();
  }

  function handleSearchInput() {
    scheduleTmdbSearchFromInput();
  }

  function handleSearchFocus() {
    if (!isSearchModeActive()) {
      openSearchMode({ focusInput: false });
    }
  }

  function handleSearchSubmit() {
    scheduleTmdbSearchFromInput({ immediate: true });
  }

  function handleSearchKeydown(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      scheduleTmdbSearchFromInput({ immediate: true });
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearchAndReturn();
    }
  }

  function handleSearchContextSave(event) {
    event.preventDefault();
    const details =
      searchContextTarget && typeof searchContextTarget === "object"
        ? searchContextTarget
        : null;
    hideSearchContextMenu();
    if (!details) {
      return;
    }
    openPlayerPage({
      ...details,
      saveToGallery: true,
    });
  }

  function showHomeView({ push = true } = {}) {
    if (isSearchModeActive()) {
      closeSearchMode();
    }
    setActiveView("home");
    if (push && (window.location.pathname !== "/" || window.location.search || window.location.hash)) {
      window.history.replaceState({ ...window.history.state, scrollY: window.scrollY }, "");
      window.history.pushState({ view: "home" }, "", "/");
    }
    stopHeroPreview();
  }

  function ensureLiveViewLoaded() {
    if (!liveViewLoadPromise) {
      liveViewLoadPromise = Promise.all([
        import("../../live.css"),
        import("../components/live-channels-view.jsx"),
      ])
        .then(([, module]) => {
          if (typeof module.default === "function") {
            setLiveChannelsComponent(() => module.default);
          }
        })
        .catch((error) => {
          console.error("Failed to load live view assets:", error);
          liveViewLoadPromise = null;
        });
    }
    return liveViewLoadPromise;
  }

  function showLiveView({ push = true } = {}) {
    if (isSearchModeActive()) {
      closeSearchMode();
    }
    void ensureLiveViewLoaded();
    setActiveView("live");
    if (push && window.location.pathname !== "/live") {
      window.history.replaceState({ ...window.history.state, scrollY: window.scrollY }, "");
      window.history.pushState({ view: "live" }, "", "/live");
    }
    stopHeroPreview();
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }

  function handleHomeNavClick(event) {
    event.preventDefault();
    showHomeView();
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }

  function handleLiveNavClick(event) {
    event.preventDefault();
    showLiveView();
  }

  function showMyListView({ push = true } = {}) {
    if (isSearchModeActive()) closeSearchMode();
    const url = myListViewUrl(myListType(), myListSort());
    if (push && `${window.location.pathname}${window.location.search}` !== url) {
      window.history.replaceState({ ...window.history.state, scrollY: window.scrollY }, "");
      window.history.pushState({ view: "my-list" }, "", url);
    }
    setActiveView("my-list");
    stopHeroPreview();
    stopHeroCarouselTimer();
    document.querySelectorAll(".card.is-hovering").forEach((card) => hideCardHover(card, { force: true }));
    if (push) {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      document.getElementById("myListHeading")?.focus({ preventScroll: true });
    }
  }

  function handleMyListNavClick(event) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    showMyListView();
  }

  function handleMyListFilter(type, sort) {
    setMyListType(type);
    setMyListSort(sort);
    window.history.replaceState({ ...window.history.state, view: "my-list" }, "", myListViewUrl(type, sort));
  }

  // ---- Details modal handlers ----
  function handleDetailsPlay() {
    if (!activeDetails) return;
    openPlayerPage(titlePlaybackTarget(activeDetails, findTitleResume(activeDetails, getContinueWatchingEntries())));
  }

  function handleDetailsEpisodePlay(episode) {
    if (!activeDetails) return;
    const target = episodePlaybackTarget(activeDetails, episode);
    const resume = findTitleResume(activeDetails, getContinueWatchingEntries());
    const isCurrent = resume && Number(resume.seasonNumber) === Number(episode.seasonNumber) &&
      Number(resume.episodeNumber) === Number(episode.episodeNumber);
    openPlayerPage(isCurrent ? titlePlaybackTarget(target, resume) : target);
  }

  async function handleDetailsMyList() {
    if (!activeDetails) {
      return;
    }
    await handleMyListToggle(activeDetails);
  }

  function handleDetailsClose() {
    closeDetailsModal();
  }

  function handleDetailsBackdropClick(event) {
    if (event.target.closest("[data-close-modal]")) {
      closeDetailsModal();
    }
  }

  // ---- Library edit modal handlers ----
  function handleLibraryEditFieldsClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!activeLibraryEditContext) {
      return;
    }
    const categoryButton = target?.closest?.("[data-library-edit-category]");
    if (categoryButton instanceof HTMLButtonElement) {
      const nextCategory = normalizeLibraryEditCategory(
        activeLibraryEditContext.itemType,
        categoryButton.dataset.libraryEditCategory || "",
      );
      if (nextCategory !== activeLibraryEditCategory) {
        activeLibraryEditCategory = nextCategory;
        renderLibraryEditModalFields();
        if (activeLibraryEditContext.itemType === "series") {
          if (nextCategory === "episodes") {
            setLibraryEditModalStatus(
              "Episode mode: edit lessons here, then Save Changes.",
            );
          } else {
            setLibraryEditModalStatus(
              "Series mode: edit title/type/year, then Save Changes.",
            );
          }
        }
      }
      return;
    }
    const button = target?.closest?.('[data-action="delete-episode"]');
    if (!button) {
      return;
    }
    if (activeLibraryEditContext.itemType !== "series") {
      return;
    }
    const episodeIndex = Number(button.dataset.episodeIndex || -1);
    const seriesItem =
      activeLibraryEditContext.library.series[activeLibraryEditContext.itemIndex];
    const episodes = Array.isArray(seriesItem?.episodes) ? [...seriesItem.episodes] : [];
    if (
      !Number.isFinite(episodeIndex) ||
      episodeIndex < 0 ||
      episodeIndex >= episodes.length
    ) {
      return;
    }
    episodes.splice(episodeIndex, 1);
    activeLibraryEditContext.library.series[activeLibraryEditContext.itemIndex] = {
      ...seriesItem,
      episodes,
    };
    renderLibraryEditModalFields();
  }

  function handleLibraryAddEpisode() {
    addEpisodeToActiveSeries();
  }

  async function handleLibrarySave() {
    if (!activeLibraryEditContext) {
      return;
    }
    try {
      if (activeLibraryEditContext.itemType === "movie") {
        const nextMovie = collectLibraryEditedMovie();
        activeLibraryEditContext.library.movies[activeLibraryEditContext.itemIndex] =
          nextMovie;
      } else {
        const nextSeries = collectLibraryEditedSeries();
        activeLibraryEditContext.library.series[activeLibraryEditContext.itemIndex] =
          nextSeries;
      }
      await persistActiveLibraryEdit("Saved library changes.");
    } catch (error) {
      setLibraryEditModalStatus(
        error instanceof Error ? error.message : "Could not save changes.",
        "error",
      );
    }
  }

  async function handleLibraryDelete() {
    if (!activeLibraryEditContext) {
      return;
    }
    const list =
      activeLibraryEditContext.itemType === "movie"
        ? activeLibraryEditContext.library.movies
        : activeLibraryEditContext.library.series;
    const item = list[activeLibraryEditContext.itemIndex];
    const title = String(item?.title || "this title").trim() || "this title";
    const shouldDelete = window.confirm(`Delete "${title}" from your library?`);
    if (!shouldDelete) {
      return;
    }
    list.splice(activeLibraryEditContext.itemIndex, 1);
    const deleted = await persistActiveLibraryEdit(`Deleted "${title}".`);
    if (deleted) {
      closeLibraryEditModal();
    }
  }

  function handleLibraryEditClose() {
    closeLibraryEditModal();
  }

  function handleLibraryEditBackdropClick(event) {
    if (event.target.closest("[data-close-library-edit]")) {
      closeLibraryEditModal();
    }
  }

  // ---- onMount: initialize everything ----
  onMount(() => {
    clearStaleHeroPreviewMutedPreference();
    const cleanupHorizontalRailScrollers = bindHorizontalRailScrollers();
    const cleanupTopNavScrollState = bindTopNavScrollState();
    applyLibraryEditModeClass();
    renderMyListRow();
    if (pageRootRef) {
      attachArtworkImageFallbacks(pageRootRef);
    }
    void loadContinueWatching();
    let appliedInjectedBootstrap = false;
    const injectedBootstrap = readInjectedHomeBootstrap();
    if (injectedBootstrap) {
      appliedInjectedBootstrap = applyHomeBootstrapPayload(injectedBootstrap);
    }
    if (!appliedInjectedBootstrap) {
      void initializeHomeContent();
    }
    applyAccountAvatarStyle();
    closeAccountMenu();
    if (window.location.pathname === "/live") {
      showLiveView({ push: false });
    } else if (initialListView.active) {
      showMyListView({ push: false });
    }

    if (initialSearch.active) {
      openSearchMode({ focusInput: false, push: false });
    } else {
      pageRootRef?.focus();
    }

    let heroVisibilityObserver = null;

    if ("IntersectionObserver" in window && heroSectionRef) {
      heroVisibilityObserver = new IntersectionObserver(
        ([entry]) => {
          updateHeroPreviewViewportState(entry);
        },
        {
          threshold: [0, HERO_PREVIEW_LEAVE_VISIBLE_RATIO, HERO_PREVIEW_ENTER_VISIBLE_RATIO, 0.5, 1],
        },
      );
      heroVisibilityObserver.observe(heroSectionRef);
    }

    // Global event listeners
    const handleGlobalKeydown = (event) => {
      if (trapDetailsModalFocus(event)) {
        return;
      }
      if (event.key === "Escape") {
        if (searchContextMenuVisible()) {
          hideSearchContextMenu();
          return;
        }
        if (accountMenuOpen()) {
          closeAccountMenu();
          return;
        }
        if (detailsModalVisible()) {
          closeDetailsModal();
          return;
        }
        if (libraryEditModalVisible()) {
          closeLibraryEditModal();
          return;
        }
        if (isSearchModeActive()) {
          closeSearchAndReturn();
        }
      }
    };

    const handleGlobalPointerdownContextMenu = (event) => {
      if (searchContextMenuVisible() && searchContextMenuRef && !searchContextMenuRef.contains(event.target)) {
        hideSearchContextMenu();
      }
    };

    const handleGlobalPointerdownAccountMenu = (event) => {
      const accountMenuEl = document.getElementById("accountMenu");
      if (!accountMenuEl || !accountMenuOpen()) {
        return;
      }
      if (accountMenuEl.contains(event.target)) {
        return;
      }
      closeAccountMenu();
    };

    const handleGlobalResize = () => {
      hideSearchContextMenu();
      document
        .querySelectorAll(".card.is-hovering")
        .forEach((card) => positionCardHover(card));
    };

    const dismissCardHoversOnScroll = () => {
      document.querySelectorAll(".card.is-hovering").forEach((card) => {
        hideCardHover(card, { force: true });
      });
    };

    const handleStorage = (event) => {
      if (!event.key) {
        applyAccountAvatarStyle();
        applyLibraryEditModeClass();
        void loadContinueWatching();
        return;
      }

      if (
        event.key === PROFILE_AVATAR_STYLE_PREF_KEY ||
        event.key === PROFILE_AVATAR_MODE_PREF_KEY ||
        event.key === PROFILE_AVATAR_IMAGE_PREF_KEY
      ) {
        applyAccountAvatarStyle();
      }

      if (
        event.key === CONTINUE_WATCHING_META_KEY ||
        event.key.startsWith(RESUME_STORAGE_PREFIX)
      ) {
        void loadContinueWatching();
      }

      if (event.key === MY_LIST_STORAGE_KEY) {
        renderMyListRow();
        syncAllMyListButtons();
      }

      if (event.key === STALE_HERO_PREVIEW_MUTED_PREF_KEY) {
        clearStaleHeroPreviewMutedPreference();
        applyHeroPreviewMutedState(true);
        stopHeroPreview();
      }

      if (event.key === LIBRARY_EDIT_MODE_PREF_KEY) {
        applyLibraryEditModeClass();
      }
    };

    const handlePageshow = () => {
      movieResolvePrewarmer.resume();
      applyLibraryEditModeClass();
      stopHeroPreview();
      void refreshAccountBackedCaches();
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        movieResolvePrewarmer.pause();
        stopHeroPreview();
        return;
      }
      movieResolvePrewarmer.resume();
      void refreshAccountBackedCaches();
    };

    const handlePagehide = () => {
      movieResolvePrewarmer.pause();
      stopHeroPreview();
    };
    const handleConnectionChange = () => {
      if (isConstrainedConnection()) {
        movieResolvePrewarmer.pause();
        stopHeroPreview();
      } else if (!document.hidden) {
        movieResolvePrewarmer.resume();
      }
    };

    const handleServerHydrated = (event) => {
      const detail = event.detail || {};
      if (detail.didLoadContinueWatching || detail.didLoadProgress || !getHydrationState().pending) {
        void loadContinueWatching();
        if (detailsModalVisible() && activeDetails) {
          setDetailsResume(findTitleResume(activeDetails, getContinueWatchingEntries()));
        }
      }
      setMyListLoading(Boolean(detail.pending && !detail.didLoadMyList));
      setMyListLoadError(!detail.pending && !detail.didLoadMyList);
      if (detail.didLoadMyList) {
        renderMyListRow();
        syncAllMyListButtons();
      }
    };

    const handlePopstate = (event) => {
      const restoredSearch = readSearchLocation(window.location.href);
      const listState = readMyListViewState();
      if (window.location.pathname === "/live") {
        showLiveView({ push: false });
      } else if (listState.active) {
        setMyListType(listState.type);
        setMyListSort(listState.sort);
        showMyListView({ push: false });
      } else {
        showHomeView({ push: false });
      }
      if (restoredSearch.active) {
        setSearchState(restoredSearch.state);
        openSearchMode({ focusInput: false, push: false });
      } else {
        requestAnimationFrame(() => window.scrollTo({ top: Number(event.state?.scrollY) || 0, behavior: "auto" }));
      }
    };

    document.addEventListener("keydown", handleGlobalKeydown);
    document.addEventListener("pointerdown", handleGlobalPointerdownContextMenu);
    document.addEventListener("pointerdown", handleGlobalPointerdownAccountMenu);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("resize", handleGlobalResize);
    document.addEventListener("scroll", dismissCardHoversOnScroll, {
      passive: true,
      capture: true,
    });
    window.addEventListener("storage", handleStorage);
    window.addEventListener("pageshow", handlePageshow);
    window.addEventListener("pagehide", handlePagehide);
    navigator.connection?.addEventListener?.("change", handleConnectionChange);
    window.addEventListener("popstate", handlePopstate);
    window.addEventListener("message", handleHeroPreviewMessage);
    window.addEventListener(SERVER_HYDRATED_EVENT, handleServerHydrated);

    onCleanup(() => {
      movieResolvePrewarmer.cancelAll();
      stopObservingDeferredArtwork();
      cleanupHorizontalRailScrollers();
      cleanupTopNavScrollState();
      stopHeroCarouselTimer();
      stopHeroPreview();
      heroVisibilityObserver?.disconnect();
      document.removeEventListener("keydown", handleGlobalKeydown);
      document.removeEventListener("pointerdown", handleGlobalPointerdownContextMenu);
      document.removeEventListener("pointerdown", handleGlobalPointerdownAccountMenu);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("resize", handleGlobalResize);
      document.removeEventListener("scroll", dismissCardHoversOnScroll, true);
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("pageshow", handlePageshow);
      window.removeEventListener("pagehide", handlePagehide);
      navigator.connection?.removeEventListener?.("change", handleConnectionChange);
      window.removeEventListener("popstate", handlePopstate);
      window.removeEventListener("message", handleHeroPreviewMessage);
      window.removeEventListener(SERVER_HYDRATED_EVENT, handleServerHydrated);

      if (searchBoxHideTimer) clearTimeout(searchBoxHideTimer);
      if (myListNoticeTimer) clearTimeout(myListNoticeTimer);
      if (closeModalTimer) clearTimeout(closeModalTimer);
      if (libraryEditModalCloseTimer) clearTimeout(libraryEditModalCloseTimer);
    });
  });

  // ---- Template ----
  return <><div data-solid-page-root="" class="solid-page-root">
    <div class={`page home-page${continueRowVisible() ? " has-continue-watching" : ""}`} tabindex="0" ref={(el) => (pageRootRef = el)}>
      <header class="top-nav">
        <div class="nav-left">
          <a href="/" class="nav-logo" aria-label="Go to homepage">
            <BrandWordmark class="brand-wordmark--nav" />
          </a>
          <nav>
            <a href="/" class={activeView() === "home" ? "is-active" : ""} aria-current={activeView() === "home" ? "page" : undefined} onClick={handleHomeNavClick}>Home</a>
            <a href="/live" class={liveNavClass(activeView() === "live" ? "live" : "")} onClick={handleLiveNavClick}>Live</a>
            <a href="/sports" class={sportsNavLinkClass("")}>Sports</a>
            <a href="/?view=my-list" id="navMyList" class={`optional${activeView() === "my-list" ? " is-active" : ""}`} aria-current={activeView() === "my-list" ? "page" : undefined} onClick={handleMyListNavClick}>My List</a>
          </nav>
        </div>
        <div class="nav-right">
          <div
            id="navSearchBox"
            class={`nav-search-box${searchBoxOpen() ? " is-open" : ""}`}
            hidden={!showSearchBox()}
          >
            <label class="nav-search-field" for="navSearchInput">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M14.33 12.9 19.71 18.28a1 1 0 0 1-1.42 1.42l-5.38-5.38a8 8 0 1 1 1.42-1.42Zm-6.33 1.1a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z"></path>
              </svg>
              <input
                id="navSearchInput"
                ref={(el) => (navSearchInputRef = el)}
                type="search"
                inputmode="search"
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
                spellcheck="false"
                placeholder="Titles, people, genres"
                aria-label="Search titles, people, genres"
                onInput={handleSearchInput}
                onFocus={handleSearchFocus}
                onSearch={handleSearchSubmit}
                onKeydown={handleSearchKeydown}
              />
            </label>
            <button
              id="closeSearchButton"
              class="nav-search-close"
              type="button"
              aria-label="Close search"
              onClick={handleCloseSearch}
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
            aria-expanded={isSearchModeActive() ? "true" : "false"}
            onClick={handleOpenSearch}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M14.33 12.9 19.71 18.28a1 1 0 0 1-1.42 1.42l-5.38-5.38a8 8 0 1 1 1.42-1.42Zm-6.33 1.1a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z"></path>
            </svg>
          </button>
          <div id="accountMenu" class="account-menu">
            <button
              id="accountAvatarButton"
              class="account-avatar-btn"
              aria-label="Account menu"
              aria-haspopup="menu"
              aria-controls="accountMenuPanel"
              aria-expanded={accountMenuOpen() ? "true" : "false"}
              onClick={handleAccountMenuToggle}
            >
              <div
                id="accountAvatar"
                class={avatarClassName()}
                aria-hidden="true"
              >
                {avatarImageSrc() ? (
                  <img class="avatar-custom-image-media" src={avatarImageSrc()} alt="" />
                ) : null}
              </div>
            </button>
            <span
              id="accountMenuToggle"
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
              ref={(el) => (accountMenuPanelRef = el)}
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
              <FeedbackNav menu />
              <button
                id="signOutBtn"
                class="account-menu-item account-menu-signout"
                type="button"
                role="menuitem"
                onClick={handleSignOut}
              >Sign out of StreamArena</button>
            </div>
          </div>
        </div>
      </header>

      <SearchExperience
        active={showSearchExperience()}
        state={searchState()}
        restoreFocus={searchRestoreFocus()}
        onChange={updateSearchState}
        onCaptureReady={(capture) => { captureSearchReturnState = capture; }}
        onOpen={(item, imageBase, trigger) => openDetailsModal(null, trigger, createSearchResultDetails(item, imageBase))}
        onContext={(event, item, imageBase) => openSearchContextMenu(event, createSearchResultDetails(item, imageBase))}
      />

      <MyListView
        active={activeView() === "my-list" && !showSearchExperience()}
        entries={savedTitles()}
        loading={myListLoading()}
        error={myListLoadError()}
        saving={myListSaving()}
        type={myListType()}
        sort={myListSort()}
        onFilter={handleMyListFilter}
        onRetry={() => void refreshAccountBackedCaches()}
        onOpen={(entry, trigger) => openDetailsModal(null, trigger, getCardModalData(buildMyListCardElement(entry)))}
        onRemove={handleMyListToggle}
        onBrowse={() => openSearchMode()}
      />

      <div
        id="liveTabView"
        class="live-tab-view"
        hidden={activeView() !== "live" || showSearchExperience()}
      >
        {(() => {
          const Component = LiveChannelsComponent();
          return Component ? Component({}) : null;
        })()}
      </div>

      <section
        class={`featured-hero${featuredHeroReady() ? " is-hero-ready" : ""}${heroPreviewActive() ? " is-preview-active" : ""}${heroPreviewPlaying() ? " is-preview-playing" : ""}`}
        ref={(el) => (heroSectionRef = el)}
        aria-label="Featured title"
        hidden={activeView() !== "home"}
        onPointerEnter={scheduleHeroPreviewPlayback}
      >
        <img
          class="hero-poster"
          srcset={buildTmdbArtworkSrcSet(featuredHero().poster, [780, 1280])}
          sizes="(max-width: 760px) 100vw, 72vw"
          src={featuredHero().poster}
          alt=""
          aria-hidden="true"
          decoding="async"
          fetchpriority="high"
          loading="eager"
          onError={handleArtworkImageError}
        />
        <div class="hero-preview-stage" aria-hidden="true">
          <iframe
            id="heroPreview"
            ref={(el) => (heroPreviewFrameRef = el)}
            class="hero-trailer-frame"
            title={`${featuredHero().title || "Featured movie"} trailer preview`}
            allow="autoplay; encrypted-media; picture-in-picture"
            sandbox="allow-scripts allow-same-origin allow-presentation"
            referrerpolicy="strict-origin-when-cross-origin"
            tabindex="-1"
            aria-hidden="true"
            onLoad={handleHeroPreviewFrameLoad}
          ></iframe>
        </div>
        <div class="hero-preview-shield" aria-hidden="true"></div>

        <div class="hero-shade" aria-hidden="true"></div>
        <div class="hero-top-controls">
          <div class="hero-controls">
            <button id="heroMotionToggle" class="control-btn" type="button" aria-label={heroMotionPaused() ? "Resume previews" : "Pause previews"} aria-pressed={heroMotionPaused()} onClick={handleHeroMotionToggle}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d={heroMotionPaused() ? "M7 4v16l13-8z" : "M6 4h4v16H6zM14 4h4v16h-4z"} fill="currentColor" /></svg>
            </button>
            <button
              id="muteToggle"
              class={`control-btn${isMuted() ? " muted" : ""}`}
              type="button"
              aria-label={isMuted() ? "Unmute preview" : "Mute preview"}
              disabled={!getHeroTrailerKey() || prefersReducedHeroMotion()}
              onClick={handleMuteToggle}
            >
              <svg class="icon-on" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M14 5.2v13.6a1 1 0 0 1-1.68.74L7.6 15H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h2.6l4.72-4.54A1 1 0 0 1 14 5.2Zm3.72 2.18a1 1 0 1 1 1.56-1.24 10.25 10.25 0 0 1 0 11.72 1 1 0 1 1-1.56-1.24 8.25 8.25 0 0 0 0-9.24Zm-2.8 2.26a1 1 0 0 1 1.56-1.24 5.8 5.8 0 0 1 0 7.2 1 1 0 1 1-1.56-1.24 3.8 3.8 0 0 0 0-4.72Z"></path>
              </svg>
              <svg class="icon-off" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M14 5.2v13.6a1 1 0 0 1-1.68.74L7.6 15H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h2.6l4.72-4.54A1 1 0 0 1 14 5.2Zm6.3 3.1a1 1 0 0 1 0 1.4L18.01 12l2.3 2.3a1 1 0 0 1-1.42 1.4L16.6 13.4l-2.3 2.3a1 1 0 0 1-1.4-1.42l2.3-2.28-2.3-2.3a1 1 0 0 1 1.4-1.4l2.3 2.3 2.29-2.3a1 1 0 0 1 1.41 0Z"></path>
              </svg>
            </button>
          </div>
        </div>
        <div
          class="hero-carousel-dots"
          role="group"
          aria-label="Featured titles"
          hidden={featuredHeroCandidates().length <= 1}
        >
          {featuredHeroCandidates()
              .slice(0, FEATURED_HERO_CANDIDATE_LIMIT)
              .map((candidate, index) => <>
                <button
                  type="button"
                  class={`hero-carousel-dot${featuredHeroIndex() === index ? " is-active" : ""}`}
                  aria-label={`Show ${candidate.title || "featured title"}`}
                  aria-pressed={(featuredHeroIndex() === index ? "true" : "false")}
                  onClick={() => handleHeroCarouselDotClick(index)}
                ></button>
              </>)}
        </div>

        <section
          class={`hero-content${featuredHeroReady() ? "" : " is-loading"}`}
          aria-labelledby="heroTitle"
        >
          <p class="hero-eyebrow">Featured</p>
          <h1 id="heroTitle">{featuredHero().title}</h1>
          <div
            class="hero-meta"
            aria-label={`Title details: ${[
              ...getFeaturedHeroMetaItems(featuredHero()),
              getFeaturedHeroMaturityLabel(featuredHero()) !== UNRATED_CERTIFICATION_LABEL ? getFeaturedHeroMaturityLabel(featuredHero()) : "",
            ].filter(Boolean).join(", ")}`}
          >
            {(() => {
              const items = getFeaturedHeroMetaItems(featuredHero());
              return items.map((item) => <span>{item}</span>);
            })()}
            <span class="hero-meta-rating" hidden={getFeaturedHeroMaturityLabel(featuredHero()) === UNRATED_CERTIFICATION_LABEL}>
              {getFeaturedHeroMaturityLabel(featuredHero())}
            </span>
          </div>
          <p class="hero-synopsis">{featuredHero().description}</p>
          <div class="hero-actions">
            <button
              id="heroPlay"
              class="cta cta-play"
              type="button"
              disabled={!getHeroDestination()}
              onClick={handleHeroPlay}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 3.5v17L20 12 5 3.5Z"></path>
              </svg>
              Play
            </button>
            <button
              id="heroInfo"
              class="cta cta-info"
              type="button"
              disabled={!getHeroDestination()}
              onClick={handleHeroInfo}
            >
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
              Details
            </button>
          </div>
        </section>

      </section>

      <section
        id="continueRow"
        class={`continue-row${continueLoading() ? " is-loading" : ""}`}
        aria-busy={continueLoading()}
        hidden={activeView() !== "home" || !continueRowVisible()}
      >
        <h2>Continue watching</h2>
        <div
          id="continueCards"
          class="cards popular-cards continue-cards"
          ref={(el) => (continueCardsRef = el)}
        ></div>
        <p
          id="continueEmpty"
          class="continue-empty"
          hidden={!continueEmptyVisible()}
        >
          {continueLoading() ? "Loading your progress…" : "Start a movie and it will appear here."}
        </p>
      </section>

      <section
        id="popularRow"
        class="popular-row home-popular-row"
        hidden={activeView() !== "home" || !popularRowVisible()}
      >
        <div class="popular-row-inner">
          <div class="rail-header">
            <h2 id="popularRowTitle">{popularRowTitle()}</h2>
          </div>
          <div
            id="cardsContainer"
            class="cards popular-cards"
            ref={(el) => (cardsContainerRef = el)}
          ></div>
        </div>
      </section>

      <section
        id="trendingRow"
        class="popular-row home-popular-row"
        hidden={activeView() !== "home" || !trendingRowVisible()}
      >
        <div class="popular-row-inner">
          <div class="rail-header">
            <h2>Popular films</h2>
          </div>
          <div
            id="trendingCardsContainer"
            class="cards popular-cards"
            ref={(el) => (trendingCardsContainerRef = el)}
          ></div>
        </div>
      </section>

      <section
        id="nowPlayingRow"
        class="popular-row home-popular-row"
        hidden={activeView() !== "home" || !nowPlayingRowVisible()}
      >
        <div class="popular-row-inner">
          <div class="rail-header">
            <h2>Series worth watching</h2>
          </div>
          <div
            id="nowPlayingCardsContainer"
            class="cards popular-cards"
            ref={(el) => (nowPlayingCardsContainerRef = el)}
          ></div>
        </div>
      </section>

      <section
        id="topRatedRow"
        class="popular-row home-popular-row"
        hidden={activeView() !== "home" || !topRatedRowVisible()}
      >
        <div class="popular-row-inner">
          <div class="rail-header">
            <h2>Critically acclaimed</h2>
          </div>
          <div
            id="topRatedCardsContainer"
            class="cards popular-cards"
            ref={(el) => (topRatedCardsContainerRef = el)}
          ></div>
        </div>
      </section>
    </div>

    <section
      id="myListRow"
      class="popular-row"
      hidden={activeView() !== "home" || !myListRowVisible()}
    >
      <div class="popular-row-inner">
        <div class="rail-header"><h2>My List</h2><a class="rail-view-all" href="/?view=my-list" onClick={handleMyListNavClick}>View all</a></div>
        <div
          id="myListCards"
          class="cards popular-cards"
          ref={(el) => (myListCardsRef = el)}
        ></div>
      </div>
    </section>

    <section id="libraryRow" class="popular-row home-popular-row" hidden={activeView() !== "home" || !libraryRowVisible()}>
      <div class="popular-row-inner"><div class="rail-header"><h2>Local library</h2></div>
        <div id="libraryCards" class="cards popular-cards" ref={(el) => (libraryCardsRef = el)}></div>
      </div>
    </section>

    <div class={`my-list-notice${myListNoticeError() ? " is-error" : ""}`} hidden={!myListNotice() || detailsModalVisible()}>
      <p role="status">{myListNotice()}</p><button type="button" aria-label="Dismiss list message" onClick={() => setMyListNotice("")}>×</button>
    </div>

    <footer
      class="member-footer home-member-footer"
      aria-label="StreamArena footer"
      hidden={activeView() === "live"}
    >
      <ul class="member-footer-links">
        <li><a href="/help">Help Center</a></li>
        <li><a href="/privacy">Privacy Policy</a></li>
        <li><a href="/terms">Terms of Use</a></li>
        <li><a href="/privacy#cookies">Cookie Preferences</a></li>
      </ul>
      <p class="member-footer-copyright">&copy; 2026 StreamArena</p>
    </footer>

    <div
      id="detailsModal"
      class={`details-modal${detailsModalOpen() ? " is-open" : ""}`}
      hidden={!detailsModalVisible()}
      onClick={handleDetailsBackdropClick}
    >
      <div class="details-backdrop" data-close-modal></div>
      <article
        ref={(el) => (detailsSheetRef = el)}
        class="details-sheet"
        role="dialog"
        tabindex="-1"
        aria-modal="true"
        aria-labelledby="detailsTitle"
      >
        <div class="details-close-bar"><button
          id="detailsClose"
          ref={(el) => (detailsCloseButtonRef = el)}
          class="details-close"
          type="button"
          aria-label="Close details"
          onClick={handleDetailsClose}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="m6 6 12 12M18 6 6 18"
              fill="none"
              stroke-linecap="round"
            ></path>
          </svg>
        </button></div>

        <header class="details-hero">
          <img
            id="detailsImage"
            class="details-hero-image"
            src={detailsData().thumb}
            alt={`${detailsData().title} artwork`}
          />
          <div class="details-hero-fade" aria-hidden="true"></div>
          <div class="details-hero-content">
            <h3 id="detailsTitle">{detailsData().title}</h3>
            <div class="details-actions">
              <button
                id="detailsPlay"
                class="cta cta-play details-play"
                type="button"
                onClick={handleDetailsPlay}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 3.5v17L20 12 5 3.5Z"></path>
                </svg>
                {detailsResume() ? detailsResume().mediaType === "tv" && detailsResume().seasonNumber > 0 && detailsResume().episodeNumber > 0
                  ? `Resume S${detailsResume().seasonNumber} E${detailsResume().episodeNumber}` : "Resume" : "Play"}
              </button>
              <button
                id="detailsMyList"
                class={`details-round${detailsMyListActive() ? " is-active" : ""}`}
                type="button"
                disabled={myListSaving()}
                aria-label={detailsMyListActive() ? "Remove from My List" : "Add to My List"}
                aria-pressed={detailsMyListActive() ? "true" : "false"}
                onClick={handleDetailsMyList}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d={detailsMyListActive() ? "M5 12.5 9.2 16.7 19 7" : "M12 5v14M5 12h14"}
                    fill="none"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  ></path>
                </svg>
              </button>
            </div>
          </div>
        </header>

        <p class={`details-list-notice${myListNoticeError() ? " is-error" : ""}`} hidden={!myListNotice()} role="status">{myListNotice()}</p>
        <div class="details-body">
          <section class="details-main">
            <div class="details-meta">
              <span id="detailsYear" hidden={!detailsData().year}>{detailsData().year}</span>
              <span id="detailsRuntime" hidden={!detailsData().runtime}>{detailsData().runtime}</span>
              <span id="detailsMaturity" class="details-maturity">{detailsData().maturity}</span>
              <span id="detailsQuality" hidden={!detailsData().quality} class="meta-chip">{detailsData().quality}</span>
              <span id="detailsAudio" hidden={!detailsData().audio} class="details-audio">{detailsData().audio}</span>
            </div>
            <p id="detailsDescription" class="details-description">
              {detailsData().description}
            </p>
          </section>

          <aside class="details-side">
            <p hidden={!detailsData().cast}>
              <span>Cast:</span>
              <strong id="detailsCast">{detailsData().cast}</strong>
            </p>
            <p hidden={!detailsData().genres}>
              <span>Genres:</span>
              <strong id="detailsGenres">{detailsData().genres}</strong>
            </p>
            <p hidden={detailsLoadState() !== "error"} role="status">Some details couldn’t load. <button class="discovery-text-button" onClick={() => void hydrateModalFromTmdb(activeDetailsCard)}>Retry details</button></p>
          </aside>
        </div>

        <TitleEpisodes
          visible={detailsModalVisible()}
          title={detailsData()}
          metadataLoading={detailsLoadState() === "loading"}
          resume={detailsResume()}
          onPlay={handleDetailsEpisodePlay}
        />

        <TitleRecommendations
          visible={detailsModalVisible()}
          title={detailsData()}
          onOpen={(item, imageBase) => openDetailsModal(null, detailsTrigger, createSearchResultDetails(item, imageBase))}
        />
      </article>
    </div>

    <div
      id="libraryEditModal"
      class={`library-edit-modal${libraryEditModalOpen() ? " is-open" : ""}`}
      hidden={!libraryEditModalVisible()}
      onClick={handleLibraryEditBackdropClick}
    >
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
          onClick={handleLibraryEditClose}
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
          <h3 id="libraryEditModalTitle">{libraryEditModalTitleText()}</h3>
          <p id="libraryEditModalMeta" class="library-edit-modal-meta">{libraryEditModalMetaText()}</p>
        </header>
        <div
          id="libraryEditFields"
          class="library-edit-fields"
          ref={(el) => (libraryEditFieldsRef = el)}
          onClick={handleLibraryEditFieldsClick}
        ></div>
        <div class="library-edit-modal-actions">
          <button
            id="libraryAddEpisodeBtn"
            class="library-edit-btn"
            type="button"
            hidden={!libraryAddEpisodeVisible()}
            onClick={handleLibraryAddEpisode}
          >
            {libraryAddEpisodeBtnText()}
          </button>
          <button
            id="librarySaveBtn"
            class="library-edit-btn library-edit-btn--primary"
            type="button"
            hidden={!librarySaveBtnVisible()}
            onClick={handleLibrarySave}
          >
            Save Changes
          </button>
          <button
            id="libraryDeleteBtn"
            class="library-edit-btn library-edit-btn--danger"
            type="button"
            hidden={!libraryDeleteBtnVisible()}
            onClick={handleLibraryDelete}
          >
            Delete Title
          </button>
        </div>
        <p
          id="libraryEditModalStatus"
          class={(() => {
            const tone = libraryEditStatusTone();
            let cls = "library-edit-modal-status";
            if (tone === "success") cls += " status-success";
            if (tone === "error") cls += " status-error";
            return cls;
          })()}
          role="status"
          aria-live="polite"
        >{libraryEditStatusText()}</p>
      </article>
    </div>

    <div
      id="searchContextMenu"
      ref={(el) => (searchContextMenuRef = el)}
      class="search-context-menu"
      hidden={!searchContextMenuVisible()}
    >
      <button
        id="searchContextSaveButton"
        class="search-context-menu-item"
        type="button"
        onClick={handleSearchContextSave}
      >
        Save to gallery while streaming
      </button>
    </div>
  </div></>;
}

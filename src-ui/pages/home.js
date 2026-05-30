import html from "solid-js/html";
import { createSignal, onMount, onCleanup } from "solid-js";
import {
  STREAM_QUALITY_PREF_KEY,
  PROFILE_AVATAR_STYLE_PREF_KEY,
  PROFILE_AVATAR_MODE_PREF_KEY,
  PROFILE_AVATAR_IMAGE_PREF_KEY,
  LIBRARY_EDIT_MODE_PREF_KEY,
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
  TMDB_IMAGE_BASE,
} from "../shared.js";
import {
  DEFAULT_STREAM_QUALITY_PREFERENCE,
  supportedAudioLangs,
  normalizeStreamQualityPreference,
  getStoredStreamQualityPreference,
  getStoredAudioLangForTmdbMovie,
} from "../lib/preferences.js";
import { hydrateFromServer, SERVER_HYDRATED_EVENT } from "../lib/auth.js";
import { bindHorizontalRailScrollers } from "../lib/horizontal-rail-scroll.js";
import {
  addCurrentReturnToParam,
  buildWatchUrl,
  saveWatchParams,
  slugifyTitle,
} from "../lib/watch-params.js";
import {
  CONTINUE_WATCHING_META_KEY,
  DEFAULT_LOCAL_THUMBNAIL,
  RESUME_STORAGE_PREFIX,
  enrichContinueEntriesWithLocalLibrary,
  fetchServerContinueWatchingState,
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
import { liveNavClass, sportsNavLinkClass } from "../lib/browse-nav.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SEARCH_DEBOUNCE_MS = 280;
const SEARCH_MIN_QUERY_LENGTH = 2;
const SEARCH_RESULTS_LIMIT = 40;
const STALE_HERO_PREVIEW_MUTED_PREF_KEY = "netflix-hero-trailer-muted-v2";
const HERO_PREVIEW_ENTER_VISIBLE_RATIO = 0.3;
const HERO_PREVIEW_LEAVE_VISIBLE_RATIO = 0.08;
const FEATURED_HERO_ROTATION_MS = 24 * 60 * 60 * 1000;
const FEATURED_HERO_CAROUSEL_MS = 20000;
const FEATURED_HERO_STORAGE_KEY = "netflix-featured-hero-v2";
const FEATURED_HERO_CANDIDATE_LIMIT = 10;
const BLOCKED_FEATURED_HERO_TITLE_KEYS = new Set(["your heart will be broken"]);
const MY_LIST_STORAGE_KEY = "netflix-my-list-v1";
const JEFFREY_EPSTEIN_SERIES_ID = "jeffrey-epstein-filthy-rich";
const JEFFREY_EPSTEIN_EPISODE_1_SOURCE =
  "assets/videos/jeffrey-epstein-filthy-rich-s01e01-2160p-hevc.mp4";
const POPULAR_TITLES_LIMIT = 14;
const BROWSE_RAIL_LIMIT = 14;
const TOP_TEN_RAIL_LIMIT = 10;
const HOME_BOOTSTRAP_FETCH_TIMEOUT_MS = 2500;
const HOME_BOOTSTRAP_WARM_RETRY_MS = 1200;
const HOME_BOOTSTRAP_WARM_RETRY_LIMIT = 8;
const OFFLINE_ARTWORK_WARM_DELAY_MS = 300;
const OFFLINE_ARTWORK_WARM_LIMIT = 100;
const HOME_BOOTSTRAP_ARTWORK_KEYS = [
  "popular",
  "bingeworthy",
  "crowdPleasers",
  "topSeries",
  "criticallyAcclaimed",
  "trending",
  "nowPlaying",
  "topRated",
];

let offlineArtworkWarmTimer = null;
const pendingOfflineArtworkUrls = new Set();

function isWarmingHomeBootstrap(payload) {
  return String(payload?._meta?.status || "").trim() === "warming";
}

function toCacheableArtworkUrl(value) {
  try {
    const raw = String(value || "").trim();
    if (
      !raw ||
      raw.startsWith("data:") ||
      raw.startsWith("blob:") ||
      raw.startsWith("#")
    ) {
      return "";
    }
    const url = new URL(raw, window.location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }
    if (
      url.origin !== window.location.origin &&
      url.hostname !== "image.tmdb.org"
    ) {
      return "";
    }
    return url.href;
  } catch {
    return "";
  }
}

function queueOfflineArtworkCache(urls) {
  if (!("serviceWorker" in navigator) || !Array.isArray(urls)) {
    return;
  }
  urls
    .map(toCacheableArtworkUrl)
    .filter(Boolean)
    .forEach((url) => pendingOfflineArtworkUrls.add(url));
  if (!pendingOfflineArtworkUrls.size || offlineArtworkWarmTimer) {
    return;
  }
  offlineArtworkWarmTimer = window.setTimeout(() => {
    offlineArtworkWarmTimer = null;
    const urlsToCache = Array.from(pendingOfflineArtworkUrls).slice(0, OFFLINE_ARTWORK_WARM_LIMIT);
    urlsToCache.forEach((url) => pendingOfflineArtworkUrls.delete(url));
    navigator.serviceWorker.ready
      .then((registration) => {
        const worker = registration.active || navigator.serviceWorker.controller;
        worker?.postMessage({ type: "CACHE_URLS", urls: urlsToCache });
      })
      .catch(() => {});
    if (pendingOfflineArtworkUrls.size) {
      queueOfflineArtworkCache([]);
    }
  }, OFFLINE_ARTWORK_WARM_DELAY_MS);
}

function queueOfflineArtworkFromElement(root) {
  if (!(root instanceof Element)) {
    return;
  }
  const urls = [];
  root.querySelectorAll("img").forEach((image) => {
    urls.push(image.currentSrc || image.src || image.getAttribute("src") || "");
  });
  if (root instanceof HTMLElement) {
    urls.push(root.dataset.thumb || "");
  }
  root.querySelectorAll("[data-thumb]").forEach((element) => {
    if (element instanceof HTMLElement) {
      urls.push(element.dataset.thumb || "");
    }
  });
  queueOfflineArtworkCache(urls);
}

function collectLocalLibraryArtworkUrls(localLibrary) {
  const urls = [];
  (Array.isArray(localLibrary?.movies) ? localLibrary.movies : []).forEach((movie) => {
    urls.push(movie?.thumb || "");
  });
  (Array.isArray(localLibrary?.series) ? localLibrary.series : []).forEach((series) => {
    (Array.isArray(series?.episodes) ? series.episodes : []).forEach((episode) => {
      urls.push(episode?.thumb || "");
    });
  });
  return urls;
}

function collectTmdbItemArtworkUrls(item, imageBase = TMDB_IMAGE_BASE) {
  const posterPath = String(item?.poster_path || item?.posterPath || "").trim();
  const backdropPath = String(
    item?.backdrop_path || item?.backdropPath || "",
  ).trim();
  const urls = [];
  if (backdropPath) {
    urls.push(`${imageBase}/w1280${backdropPath}`);
    urls.push(`${imageBase}/w780${backdropPath}`);
  }
  if (posterPath) {
    urls.push(`${imageBase}/w780${posterPath}`);
    urls.push(`${imageBase}/w500${posterPath}`);
  }
  return urls;
}

function collectHomeBootstrapArtworkUrls(bootstrap, imageBase = TMDB_IMAGE_BASE) {
  const urls = [];
  HOME_BOOTSTRAP_ARTWORK_KEYS.forEach((key) => {
    const results = bootstrap?.[key]?.results;
    (Array.isArray(results) ? results : []).forEach((item) => {
      urls.push(...collectTmdbItemArtworkUrls(item, imageBase));
    });
  });
  urls.push(...collectLocalLibraryArtworkUrls(bootstrap?.library));
  return urls;
}

function setArtworkImageFallback(image) {
  if (!(image instanceof HTMLImageElement)) {
    return;
  }
  const fallbackPath = image.classList.contains("hero-poster")
    ? "assets/images/thumbnail-top10-h.jpg"
    : DEFAULT_LOCAL_THUMBNAIL;
  const fallbackUrl = new URL(fallbackPath, window.location.href).href;
  if (image.src !== fallbackUrl) {
    image.src = fallbackPath;
  }
}

function handleArtworkImageError(event) {
  setArtworkImageFallback(event.currentTarget);
}

function attachArtworkImageFallbacks(root) {
  if (!(root instanceof Element)) {
    return;
  }
  root.querySelectorAll("img").forEach((image) => {
    if (!(image instanceof HTMLImageElement)) {
      return;
    }
    if (!image.dataset.artworkFallbackAttached) {
      image.dataset.artworkFallbackAttached = "true";
      image.addEventListener("error", handleArtworkImageError);
    }
    if (image.complete && image.naturalWidth === 0) {
      setArtworkImageFallback(image);
    }
  });
}

async function resolveHomeBootstrap() {
  if (
    window.__HOME_BOOTSTRAP__ &&
    typeof window.__HOME_BOOTSTRAP__ === "object" &&
    !isWarmingHomeBootstrap(window.__HOME_BOOTSTRAP__)
  ) {
    return window.__HOME_BOOTSTRAP__;
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
      normalizedCategory === "episodes" ||
      normalizedCategory === "upload"
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
      <button type="button" class="library-edit-category-btn ${activeCategory === "upload" ? "is-active" : ""}" data-library-edit-category="upload" aria-pressed="${activeCategory === "upload" ? "true" : "false"}">Upload ${itemLabel}</button>
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
  const nextEpisodeNumber =
    episodes.reduce((maxValue, episode) => {
      const value = Number(episode?.episodeNumber || 0);
      return Number.isFinite(value) && value > maxValue ? value : maxValue;
    }, 0) + 1;
  return `${categoryTabs}
    <section class="library-edit-category-panel is-active" data-library-edit-panel="upload">
      <div class="library-edit-upload-panel">
        <h4>Upload New ${itemLabel}</h4>
        <p>This view is upload-only. Existing ${itemLabel.toLowerCase()} editors are hidden for clarity.</p>
        <p>Next default ${itemLabel.toLowerCase()}: ${nextEpisodeNumber}</p>
        <button type="button" class="library-edit-btn library-edit-btn--primary" data-action="open-upload-episode">Open Upload Flow</button>
      </div>
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

function normalizeSearchQuery(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function createDefaultFeaturedHero() {
  return {
    title: "Popular Movies",
    tmdbId: "",
    mediaType: "movie",
    year: "",
    runtime: "Movie",
    maturity: "13+",
    tagline: "Discover what everyone is watching right now.",
    description: "Current top movies from around the world.",
    poster: "assets/images/thumbnail-top10-h.jpg",
    thumb: "assets/images/thumbnail-top10-h.jpg",
    src: "",
    previewSrc: "",
    callouts: ["Top global movies", "Popular now"],
    ready: false,
  };
}

function normalizeHeroTitle(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHeroTitleKey(value) {
  return normalizeHeroTitle(value).toLowerCase();
}

function getFeaturedHeroDisplayTitle(feature) {
  return normalizeHeroTitle(feature?.title || "Popular Movies").toUpperCase();
}

function getFeaturedHeroTitleLines(feature) {
  const words = getFeaturedHeroDisplayTitle(feature)
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length <= 2) {
    return words.length ? words : ["POPULAR", "MOVIES"];
  }
  const maxLines = words.length > 4 ? 3 : 2;
  const lines = [];
  let cursor = 0;
  while (cursor < words.length && lines.length < maxLines) {
    const remainingWords = words.length - cursor;
    const remainingLines = maxLines - lines.length;
    const take = Math.ceil(remainingWords / remainingLines);
    lines.push(words.slice(cursor, cursor + take).join(" "));
    cursor += take;
  }
  return lines;
}

function getFeaturedHeroTagline(feature) {
  const tagline = String(feature?.tagline || "").trim();
  if (tagline) {
    return tagline;
  }
  const callouts = getFeaturedHeroCallouts(feature);
  return callouts[0] || "";
}

function getFeaturedHeroMaturityLabel(feature) {
  const maturity = String(feature?.maturity || "13+").trim();
  return maturity.replace(/\+$/, "");
}

function getPopularRowTitle(payload) {
  const genreMap = new Map();
  (Array.isArray(payload?.genres) ? payload.genres : []).forEach((genre) => {
    genreMap.set(genre.id, genre.name);
  });
  const genreCounts = new Map();
  (Array.isArray(payload?.results) ? payload.results : [])
    .slice(0, POPULAR_TITLES_LIMIT)
    .forEach((item) => {
      (Array.isArray(item?.genre_ids) ? item.genre_ids : []).forEach((id) => {
        const name = genreMap.get(id);
        if (!name) {
          return;
        }
        genreCounts.set(name, (genreCounts.get(name) || 0) + 1);
      });
    });
  const topGenre = [...genreCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
  if (topGenre === "Crime" || topGenre === "Thriller") {
    return "Relentless Crime Thrillers";
  }
  if (topGenre === "Action") {
    return "Adrenaline-Fueled Action";
  }
  if (topGenre === "Comedy") {
    return "Laugh Out Loud Comedies";
  }
  if (topGenre === "Horror") {
    return "Spine-Chilling Horror";
  }
  if (topGenre) {
    return `${topGenre} Picks`;
  }
  return "Trending Now";
}

function findLocalMovieForTmdbId(localLibrary, tmdbId) {
  const normalizedTmdbId = String(tmdbId || "").trim();
  if (!normalizedTmdbId) {
    return null;
  }
  return (
    (Array.isArray(localLibrary?.movies) ? localLibrary.movies : []).find(
      (movie) => String(movie?.tmdbId || "").trim() === normalizedTmdbId,
    ) || null
  );
}

function getFeaturedHeroCallouts(feature) {
  const values = Array.isArray(feature?.callouts) ? feature.callouts : [];
  return values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .slice(0, 2);
}

function createFeaturedHeroFromTmdbItem(
  item,
  genreMap,
  imageBase = TMDB_IMAGE_BASE,
  localLibrary = null,
  heroPreviewMap = null,
) {
  const tmdbId = String(item?.id || "").trim();
  const title = normalizeHeroTitle(item?.title || item?.name || "Popular Movie");
  const releaseDate = String(item?.release_date || item?.first_air_date || "").trim();
  const year = releaseDate ? releaseDate.slice(0, 4) : "";
  const posterPath = String(item?.poster_path || "").trim();
  const backdropPath = String(item?.backdrop_path || posterPath || "").trim();
  const poster = backdropPath
    ? `${imageBase}/w1280${backdropPath}`
    : posterPath
      ? `${imageBase}/w780${posterPath}`
      : "assets/images/thumbnail-top10-h.jpg";
  const genreNames = (Array.isArray(item?.genre_ids) ? item.genre_ids : [])
    .map((id) => genreMap.get(id))
    .filter(Boolean)
    .slice(0, 2);
  const localMovie = findLocalMovieForTmdbId(localLibrary, tmdbId);
  const localSrc = String(localMovie?.src || "").trim();
  const previewEntry =
    heroPreviewMap instanceof Map ? heroPreviewMap.get(tmdbId) : null;
  const previewSrc = String(previewEntry?.src || "").trim();
  return {
    title,
    tmdbId,
    mediaType: "movie",
    year,
    runtime: "Movie",
    maturity: item?.adult ? "18+" : "13+",
    tagline: String(item?.tagline || "").trim(),
    description:
      String(item?.overview || "").trim() || "No description available.",
    poster,
    thumb: poster,
    src: localSrc,
    previewSrc,
    callouts: [
      localSrc ? "Available locally" : "Top global movie",
      genreNames.length ? genreNames.join(" / ") : "Popular now",
    ],
    ready: true,
  };
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
    maturity: "13+",
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
    callouts: [
      "Available locally",
      isSeries ? (isCourse ? "Course" : "Series") : "Movie",
    ],
    ready: true,
  };
}

function buildFeaturedHeroCandidates(
  payload,
  localLibrary = null,
  heroPreviewMap = null,
) {
  const genreMap = new Map();
  (Array.isArray(payload?.genres) ? payload.genres : []).forEach((genre) => {
    genreMap.set(genre.id, genre.name);
  });
  const imageBase = payload?.imageBase || TMDB_IMAGE_BASE;
  const seenIds = new Set();
  const candidates = (Array.isArray(payload?.results) ? payload.results : [])
    .map((item) =>
      createFeaturedHeroFromTmdbItem(
        item,
        genreMap,
        imageBase,
        localLibrary,
        heroPreviewMap,
      ),
    )
    .filter((item) => {
      if (!item.tmdbId || seenIds.has(item.tmdbId)) {
        return false;
      }
      if (
        BLOCKED_FEATURED_HERO_TITLE_KEYS.has(normalizeHeroTitleKey(item.title))
      ) {
        return false;
      }
      seenIds.add(item.tmdbId);
      return Boolean(item.poster && item.title);
    })
    .slice(0, FEATURED_HERO_CANDIDATE_LIMIT);
  const previewCandidates = candidates.filter((item) => item.previewSrc);
  return previewCandidates.length ? previewCandidates : candidates;
}

function readFeaturedHeroRotation() {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(FEATURED_HERO_STORAGE_KEY) || "null",
    );
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const tmdbId = String(parsed.tmdbId || "").trim();
    const expiresAt = Number(parsed.expiresAt || 0);
    return tmdbId && Number.isFinite(expiresAt) ? { tmdbId, expiresAt } : null;
  } catch {
    return null;
  }
}

function writeFeaturedHeroRotation(tmdbId, expiresAt) {
  try {
    localStorage.setItem(
      FEATURED_HERO_STORAGE_KEY,
      JSON.stringify({ tmdbId: String(tmdbId || "").trim(), expiresAt }),
    );
  } catch {
    // Ignore storage failures; the wall-clock fallback still keeps reloads stable.
  }
}

function selectFeaturedHeroCandidate(candidates) {
  const validCandidates = Array.isArray(candidates) ? candidates : [];
  if (!validCandidates.length) {
    return null;
  }
  const now = Date.now();
  const stored = readFeaturedHeroRotation();
  const storedCandidate =
    stored && stored.expiresAt > now
      ? validCandidates.find((item) => item.tmdbId === stored.tmdbId)
      : null;
  if (storedCandidate) {
    return storedCandidate;
  }

  const nextPool =
    stored?.tmdbId && validCandidates.length > 1
      ? validCandidates.filter((item) => item.tmdbId !== stored.tmdbId)
      : validCandidates;
  const rotationIndex = Math.floor(now / FEATURED_HERO_ROTATION_MS);
  const selected = nextPool[rotationIndex % nextPool.length] || validCandidates[0];
  writeFeaturedHeroRotation(selected.tmdbId, now + FEATURED_HERO_ROTATION_MS);
  return selected;
}

function normalizeHeroPreviewPath(value) {
  return "";
}

function normalizeHeroPreviewManifest(payload) {
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  const previewMap = new Map();
  entries.forEach((entry) => {
    const tmdbId = String(entry?.tmdbId || "").trim();
    const src = normalizeHeroPreviewPath(entry?.src);
    if (!tmdbId || !src) {
      return;
    }
    previewMap.set(tmdbId, {
      src,
      title: String(entry?.title || "").trim(),
      updatedAt: String(entry?.updatedAt || payload?.updatedAt || "").trim(),
    });
  });
  return previewMap;
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
    runtime: mediaType === "tv" ? "Series" : "Movie",
    maturity: item?.adult ? "18+" : "13+",
    quality: "HD",
    audio: "Stereo",
    description,
    cast: "Loading cast...",
    genres: mediaType === "tv" ? "Series" : "Movie",
    vibe: "Search result",
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
    year: card.dataset.year || "2024",
    runtime: card.dataset.runtime || "1h 40m",
    maturity: card.dataset.maturity || "16+",
    quality: card.dataset.quality || "HD",
    audio: card.dataset.audio || "Spatial Audio",
    description: card.dataset.description || "No description available.",
    cast: card.dataset.cast || "Cast details unavailable.",
    genres: card.dataset.genres || "Genres unavailable.",
    vibe: card.dataset.vibe || "Atmosphere unavailable.",
  };
}

function hasPlayableDestination(details) {
  return Boolean(
    String(details?.src || "").trim() ||
    String(details?.tmdbId || "").trim() ||
    String(details?.seriesId || "").trim(),
  );
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

function writeMyListEntries(entries) {
  const safeEntries = Array.isArray(entries)
    ? entries.map(normalizeMyListEntry)
    : [];
  try {
    localStorage.setItem(MY_LIST_STORAGE_KEY, JSON.stringify(safeEntries));
  } catch {
    // Ignore storage write issues.
  }
  // Sync my-list to server in background
  fetch("/api/user/my-list", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries: safeEntries }),
  }).catch(() => {});
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

function toggleMyList(details) {
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
    writeMyListEntries(entries);
    return false;
  }
  entries.unshift({
    ...normalizedDetails,
    addedAt: Date.now(),
  });
  writeMyListEntries(entries.slice(0, 100));
  return true;
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
    ...currentDetails,
    runtime: runtime || currentDetails.runtime,
    maturity: rawDetails.adult ? "18" : currentDetails.maturity,
    description: rawDetails.overview || currentDetails.description,
    cast: castList.length ? castList.join(", ") : currentDetails.cast,
    genres: genresList.length ? genresList.join(", ") : currentDetails.genres,
    vibe: rawDetails.tagline ? rawDetails.tagline : currentDetails.vibe,
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
  let heroPreviewVideoRef;
  let heroSectionRef;
  let heroPreviewInViewport = true;
  let heroPreviewPlayRequestId = 0;
  let pageRootRef;
  let continueCardsRef;
  let cardsContainerRef;
  let trendingCardsContainerRef;
  let nowPlayingCardsContainerRef;
  let topRatedCardsContainerRef;
  let myListCardsRef;
  let myListLibraryEntries = [];
  let searchResultsGridRef;
  let searchExploreLinksRef;
  let detailsMoreGridRef;
  let libraryEditFieldsRef;
  let navSearchInputRef;
  let detailsCloseButtonRef;
  let accountMenuPanelRef;
  let searchContextMenuRef;
  let liveViewLoadPromise = null;
  let accountHydratePromise = null;

  // ---- Signals ----
  const [isMuted, setIsMuted] = createSignal(true);
  const [isSearchModeActive, setIsSearchModeActive] = createSignal(false);
  const [searchStatusText, setSearchStatusText] = createSignal("Start typing to search TMDB titles.");
  const [searchStatusTone, setSearchStatusTone] = createSignal("");
  const [showSearchExperience, setShowSearchExperience] = createSignal(false);
  const [showSearchBox, setShowSearchBox] = createSignal(false);
  const [searchBoxOpen, setSearchBoxOpen] = createSignal(false);
  const [accountMenuOpen, setAccountMenuOpen] = createSignal(false);
  const [featuredHero, setFeaturedHero] = createSignal(createDefaultFeaturedHero());
  const [featuredHeroReady, setFeaturedHeroReady] = createSignal(false);
  const [featuredHeroCandidates, setFeaturedHeroCandidates] = createSignal([]);
  const [featuredHeroIndex, setFeaturedHeroIndex] = createSignal(0);
  const [heroPreviewActive, setHeroPreviewActive] = createSignal(false);
  const [heroPreviewPlaying, setHeroPreviewPlaying] = createSignal(false);

  const [continueRowVisible, setContinueRowVisible] = createSignal(false);
  const [continueEmptyVisible, setContinueEmptyVisible] = createSignal(false);
  const [popularRowVisible, setPopularRowVisible] = createSignal(false);
  const [popularRowTitle, setPopularRowTitle] = createSignal("Trending Now");
  const [trendingRowVisible, setTrendingRowVisible] = createSignal(false);
  const [nowPlayingRowVisible, setNowPlayingRowVisible] = createSignal(false);
  const [topRatedRowVisible, setTopRatedRowVisible] = createSignal(false);
  const [myListRowVisible, setMyListRowVisible] = createSignal(false);
  const [myListEmptyVisible, setMyListEmptyVisible] = createSignal(false);
  const [activeView, setActiveView] = createSignal("home");
  const [LiveChannelsComponent, setLiveChannelsComponent] = createSignal(null);

  const [detailsModalVisible, setDetailsModalVisible] = createSignal(false);
  const [detailsModalOpen, setDetailsModalOpen] = createSignal(false);
  const [detailsData, setDetailsData] = createSignal({
    thumb: "assets/images/jeffrey-epstein-s01e01-thumb.jpg",
    title: "JEFFREY EPSTEIN: FILTHY RICH",
    year: "2023",
    runtime: "2h 40m",
    maturity: "18",
    quality: "HD",
    audio: "Spatial Audio",
    description: "Survivors and investigators detail how Jeffrey Epstein built a system of abuse and influence for years.",
    cast: "Survivors, Journalists, Investigators",
    genres: "Documentary, True Crime, Investigative",
    vibe: "Investigative, Dark, Emotional",
  });
  const [detailsMoreVisible, setDetailsMoreVisible] = createSignal(false);
  const [detailsMyListActive, setDetailsMyListActive] = createSignal(false);

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
  const [searchContextMenuStyle, setSearchContextMenuStyle] = createSignal("");

  const [avatarClassName, setAvatarClassName] = createSignal("avatar avatar-style-blue");
  const [avatarInlineStyle, setAvatarInlineStyle] = createSignal("");

  const displayName = window.__currentUser?.displayName || "";

  // ---- Mutable state (not signals, imperative tracking) ----
  let activeDetails = null;
  let detailsTrigger = null;
  let closeModalTimer = null;
  let detailsRequestVersion = 0;
  let continueWatchingLoadVersion = 0;
  let searchDebounceTimer = null;
  let activeSearchRequestToken = 0;
  let featuredHeroDetailsRequestVersion = 0;
  let heroCarouselTimer = null;
  let searchAbortController = null;
  let searchContextTarget = null;
  let searchBoxHideTimer = null;
  let libraryEditModalCloseTimer = null;
  let activeLibraryEditContext = null;
  let isSavingLibraryEdit = false;
  let activeLibraryEditCategory = "title";
  let homeBrowseContentReady = false;

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
    saveToGallery = false,
  }) {
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
      const preferredQuality = getStoredStreamQualityPreference();
      if (preferredAudioLang !== "auto") {
        params.set("audioLang", preferredAudioLang);
      }
      if (preferredQuality !== DEFAULT_STREAM_QUALITY_PREFERENCE) {
        params.set("quality", preferredQuality);
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

    if (!playbackSrc && !tmdbId && !normalizedSeriesId) {
      params.set("src", JEFFREY_EPSTEIN_EPISODE_1_SOURCE);
    }

    const _slug = slugifyTitle(title || "Title");
    addCurrentReturnToParam(params);
    const playerUrl = buildWatchUrl(params);
    saveWatchParams(_slug, params.toString(), {
      tmdbId: params.get("tmdbId") || "",
      seriesId: params.get("seriesId") || "",
    });
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
      setAvatarInlineStyle(`--avatar-image: url("${safeImage}"); background-image: var(--avatar-image);`);
      return;
    }

    setAvatarClassName(`avatar avatar-style-${normalizedStyle}`);
    setAvatarInlineStyle("");
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

    const isUploadOnlyView =
      itemType === "series" && activeLibraryEditCategory === "upload";
    setLibraryAddEpisodeVisible(itemType === "series" && !isUploadOnlyView);
    if (itemType === "series") {
      const contentKind = normalizeLibrarySeriesContentKind(item?.contentKind || "");
      setLibraryAddEpisodeBtnText(
        contentKind === "course" ? "Upload Lesson" : "Upload Episode",
      );
    } else {
      setLibraryAddEpisodeBtnText("Add Episode");
    }
    setLibrarySaveBtnVisible(
      !(itemType === "series" && activeLibraryEditCategory === "upload"),
    );
    setLibraryDeleteBtnVisible(
      !(itemType === "series" && activeLibraryEditCategory === "upload"),
    );

    libraryEditFieldsRef.innerHTML =
      itemType === "movie"
        ? renderLibraryEditMovieFieldsHtml(item)
        : renderLibraryEditSeriesFieldsHtml(item, activeLibraryEditCategory);
  }

  // ---- Library edit episode upload flow ----
  function openEpisodeUploadFlowForActiveSeries() {
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
    const params = new URLSearchParams({
      mode: "add-episode",
      contentType: contentKind === "course" ? "course" : "episode",
      seriesId,
      seriesTitle,
      thumb: inheritedThumb,
      seasonNumber: String(seasonNumber),
      episodeNumber: String(nextEpisodeNumber),
      episodeTitle: `${episodeLabel} ${nextEpisodeNumber}`,
    });
    window.location.href = `/settings?${params.toString()}`;
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
  function populateDetailsModal(details) {
    setDetailsData({
      thumb: details.thumb || "assets/images/jeffrey-epstein-s01e01-thumb.jpg",
      title: (details.title || "").toUpperCase(),
      year: details.year || "2023",
      runtime: details.runtime || "2h 40m",
      maturity: details.maturity || "18",
      quality: details.quality || "HD",
      audio: details.audio || "Spatial Audio",
      description: details.description || "",
      cast: details.cast || "",
      genres: details.genres || "",
      vibe: details.vibe || "",
    });
  }

  function renderDetailsRecommendations(currentCard) {
    if (!detailsMoreGridRef) {
      return;
    }
    const currentDetails = getCardDetails(currentCard);
    const currentIdentity = getRecommendationIdentity(currentDetails);
    const seen = new Set(currentIdentity ? [currentIdentity] : []);
    const recommendations = [];
    const allCards = Array.from(document.querySelectorAll(".card"));

    allCards.forEach((candidateCard) => {
      if (candidateCard === currentCard || recommendations.length >= 6) {
        return;
      }
      const details = getCardDetails(candidateCard);
      if (!hasPlayableDestination(details)) {
        return;
      }
      const identity = getRecommendationIdentity(details);
      if (!identity || seen.has(identity)) {
        return;
      }
      seen.add(identity);
      recommendations.push({
        details,
        title:
          String(candidateCard.dataset.title || "").trim() ||
          String(details.title || "").trim() ||
          "Untitled",
        thumb:
          String(candidateCard.dataset.thumb || "").trim() ||
          candidateCard.querySelector("img")?.getAttribute("src") ||
          "assets/images/thumbnail.jpg",
      });
    });

    detailsMoreGridRef.innerHTML = "";
    setDetailsMoreVisible(recommendations.length > 0);
    if (!recommendations.length) {
      return;
    }

    const fragment = document.createDocumentFragment();
    recommendations.forEach((entry) => {
      const safeTitle = String(entry.title || "").trim() || "Untitled";
      const item = document.createElement("article");
      item.className = "details-item";
      item.tabIndex = 0;
      item.setAttribute("role", "button");
      item.setAttribute("aria-label", `Open ${safeTitle}`);
      const img = document.createElement("img");
      img.src = String(entry.thumb || "").trim() || DEFAULT_LOCAL_THUMBNAIL;
      img.alt = `${safeTitle} artwork`;
      img.loading = "lazy";
      item.appendChild(img);
      const titleEl = document.createElement("p");
      titleEl.textContent = safeTitle;
      item.appendChild(titleEl);

      const openSuggestion = () => {
        activeDetails = {
          ...entry.details,
          title: safeTitle,
          thumb: entry.thumb,
        };
        closeDetailsModal({ restoreFocus: false });
        openPlayerPage(activeDetails);
      };

      item.addEventListener("click", openSuggestion);
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openSuggestion();
        }
      });
      fragment.appendChild(item);
    });
    detailsMoreGridRef.appendChild(fragment);
  }

  async function hydrateModalFromTmdb(card) {
    const tmdbId = card.dataset.tmdbId;
    const mediaType = card.dataset.mediaType;
    if (!tmdbId || !mediaType) return;

    const cacheKey = `${mediaType}:${tmdbId}`;
    const requestVersion = ++detailsRequestVersion;

    if (tmdbDetailsCache.has(cacheKey)) {
      activeDetails = {
        ...activeDetails,
        ...tmdbDetailsCache.get(cacheKey),
      };
      populateDetailsModal(activeDetails);
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
      activeDetails = modalPatch;
      populateDetailsModal(activeDetails);
    } catch (error) {
      console.error("Failed to load TMDB details:", error);
    }
  }

  function openDetailsModal(card, trigger) {
    if (closeModalTimer) {
      clearTimeout(closeModalTimer);
      closeModalTimer = null;
    }

    activeDetails = getCardModalData(card);
    detailsTrigger = trigger || null;
    populateDetailsModal(activeDetails);
    setDetailsMyListActive(isMyListEntryActive(activeDetails));
    renderDetailsRecommendations(card);
    setDetailsModalVisible(true);
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

    closeModalTimer = window.setTimeout(() => {
      setDetailsModalVisible(false);
      syncBodyModalLock();
      if (detailsTrigger) {
        detailsTrigger.blur();
      }
      if (restoreFocus && pageRootRef) {
        pageRootRef.focus({ preventScroll: true });
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
    button.classList.toggle("is-active", Boolean(isActive));
    button.setAttribute(
      "aria-label",
      isActive ? "Remove from My List" : "Add to My List",
    );
    button.dataset.tooltip = isActive ? "Remove from My List" : "Add to My List";
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
    button.innerHTML = myListIconMarkup(isActive);
  }

  function syncCardMyListButton(card) {
    if (!(card instanceof HTMLElement)) {
      return;
    }
    const button = card.querySelector(
      ".hover-my-list, button[aria-label*='my list' i]",
    );
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    button.classList.add("hover-my-list");
    setMyListButtonState(button, isMyListEntryActive(getCardDetails(card)));
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
    const displayYear = details.year || "Local";
    const safeTitle = escapeHtml(details.title);
    const safeThumb = escapeHtml(details.thumb);

    const card = document.createElement("article");
    card.className = "card";
    card.tabIndex = 0;
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
    card.dataset.maturity = "13+";
    card.dataset.quality = "HD";
    card.dataset.audio = "Stereo";
    card.dataset.description = "Saved in My List.";
    card.dataset.cast = "Local library";
    card.dataset.genres = contentTypeLabel;
    card.dataset.vibe = "Saved, Personal";
    card.dataset.libraryType = details.libraryType;
    card.dataset.libraryId = details.libraryId;
    card.dataset.librarySrc = details.librarySrc;

    card.innerHTML = `
      <div class="card-base">
        <img src="${safeThumb}" alt="${safeTitle}" loading="lazy" />
        <div class="progress"><span style="width: 100%"></span></div>
      </div>
      <div class="card-hover">
        <img class="card-hover-image" src="${safeThumb}" alt="${safeTitle} preview" loading="lazy" />
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
            <span class="meta-age">13+</span>
            <span>${escapeHtml(displayYear)}</span>
            <span class="meta-chip">HD</span>
            <span class="meta-spatial">${contentTypeLabel}</span>
          </div>
          <p class="card-hover-tags">Saved <span>&bull;</span> My List</p>
        </div>
      </div>
    `;

    return card;
  }

  function renderMyListRow() {
    if (!myListCardsRef) {
      return;
    }
    const storedEntries = readMyListEntries();
    const hydratedEntries = storedEntries.map((entry) =>
      hydrateMyListEntryWithLocalLibrary(entry, myListLibraryEntries),
    );
    if (JSON.stringify(storedEntries) !== JSON.stringify(hydratedEntries)) {
      writeMyListEntries(hydratedEntries);
    }
    const savedEntries = hydratedEntries.sort(
      (left, right) => Number(right.addedAt || 0) - Number(left.addedAt || 0),
    );
    myListCardsRef.innerHTML = "";

    const cards = [];
    const seenIdentities = new Set();
    const appendCard = (card) => {
      if (!(card instanceof HTMLElement)) {
        return;
      }
      const identity = getRecommendationIdentity(getCardDetails(card));
      if (identity && seenIdentities.has(identity)) {
        return;
      }
      if (identity) {
        seenIdentities.add(identity);
      }
      cards.push(card);
    };

    savedEntries.forEach((entry) => {
      appendCard(buildMyListCardElement(entry));
    });
    myListLibraryEntries.forEach((entry) => {
      appendCard(
        entry.type === "series"
          ? buildCardFromLocalSeriesElement(entry.item)
          : buildCardFromLocalMovieElement(entry.item),
      );
    });

    if (!cards.length) {
      setMyListRowVisible(true);
      setMyListEmptyVisible(true);
      return;
    }

    const fragment = document.createDocumentFragment();
    cards.forEach((card, index) => {
      if (index >= Math.max(1, cards.length - 2)) {
        card.classList.add("card--align-right");
      }
      fragment.appendChild(card);
      attachCardInteractions(card);
    });
    myListCardsRef.appendChild(fragment);
    attachArtworkImageFallbacks(myListCardsRef);
    queueOfflineArtworkFromElement(myListCardsRef);
    syncAllMyListButtons();
    setMyListRowVisible(true);
    setMyListEmptyVisible(false);
  }

  // ---- Card interactions ----
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

    hover.style.setProperty("--card-hover-left", `${left}px`);
    hover.style.setProperty("--card-hover-top", `${top}px`);
  }

  function showCardHover(card) {
    if (!(card instanceof HTMLElement)) {
      return;
    }
    card.closest(".continue-row, .popular-row")?.classList.add("is-card-hovering");
    positionCardHover(card);
    card.classList.add("is-hovering");
    requestAnimationFrame(() => positionCardHover(card));
  }

  function hideCardHover(card) {
    if (!(card instanceof HTMLElement) || card.matches(":focus-within")) {
      return;
    }
    card.classList.remove("is-hovering");
    card.closest(".continue-row, .popular-row")?.classList.remove("is-card-hovering");
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

  function attachCardInteractions(card) {
    if (!card || card.dataset.interactionsBound === "true") {
      return;
    }
    attachArtworkImageFallbacks(card);
    queueOfflineArtworkFromElement(card);
    ensureCardLibraryEditButton(card);
    prepareCardTouchSurfaces(card);
    card.dataset.interactionsBound = "true";

    card.addEventListener("pointerenter", (event) => {
      if (shouldUseCardHover(event)) {
        showCardHover(card);
      }
    });
    card.addEventListener("pointerleave", () => hideCardHover(card));
    card.addEventListener("focusin", () => {
      if (shouldUseCardHover()) {
        showCardHover(card);
      }
    });
    card.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (!card.matches(":focus-within")) {
          card.classList.remove("is-hovering");
          card.closest(".continue-row, .popular-row")?.classList.remove("is-card-hovering");
        }
      }, 0);
    });

    card.addEventListener("click", (event) => {
      if (event.target.closest("button")) {
        return;
      }
      openPlayerPage(getCardDetails(card));
    });

    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        if (event.target.closest("button")) {
          return;
        }
        event.preventDefault();
        openPlayerPage(getCardDetails(card));
      }
    });

    const hoverPlayButton = card.querySelector(".hover-play");
    hoverPlayButton?.addEventListener("click", (event) => {
      event.stopPropagation();
      openPlayerPage(getCardDetails(card));
    });

    const hoverDetailsButton = card.querySelector(".hover-details");
    hoverDetailsButton?.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      openDetailsModal(card, hoverDetailsButton);
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
        await removeContinueWatchingEntry(resumeSource, card.dataset.seriesId);
        await loadContinueWatching();
      })();
    });

    const hoverMyListButton = card.querySelector(
      ".hover-my-list, button[aria-label*='my list' i]",
    );
    if (hoverMyListButton instanceof HTMLButtonElement) {
      hoverMyListButton.classList.add("hover-my-list");
      setMyListButtonState(
        hoverMyListButton,
        isMyListEntryActive(getCardDetails(card)),
      );
      hoverMyListButton.addEventListener("click", (event) => {
        event.stopPropagation();
        event.preventDefault();
        toggleMyList(getCardDetails(card));
        renderMyListRow();
        syncAllMyListButtons();
      });
    }
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
    const progressPercent =
      estimatedDurationSeconds > 0
        ? Math.max(
            4,
            Math.min(
              96,
              Math.round((entry.resumeSeconds / estimatedDurationSeconds) * 100),
            ),
          )
        : 24;
    const genreNames = (tmdbDetails?.genres || [])
      .map((genre) => String(genre?.name || "").trim())
      .filter(Boolean)
      .slice(0, 3);
    const tagLine = genreNames.length
      ? genreNames.map(escapeHtml).join(" <span>&bull;</span> ")
      : "Continue <span>&bull;</span> Resume";
    const safeTitle = escapeHtml(title);
    const safeDescription = tmdbDetails?.overview || "Resume where you left off.";
    const maturity = tmdbDetails?.adult ? "18" : "13+";
    const qualityLabel = "HD";
    const contentTypeLabel = isSeriesEntry ? "Series" : "Movie";
    const cast = (tmdbDetails?.credits?.cast || [])
      .slice(0, 4)
      .map((person) => person?.name)
      .filter(Boolean)
      .join(", ");

    const card = document.createElement("article");
    card.className = "card";
    card.tabIndex = 0;
    card.dataset.resumeSource = entry.sourceIdentity;
    card.dataset.title = title;
    card.dataset.episode = "";
    card.dataset.src = entry.src || "";
    card.dataset.thumb = heroUrl;
    card.dataset.year = year || (isSeriesEntry ? "Series" : "Movie");
    card.dataset.runtime =
      runtimeMinutes > 0
        ? formatRuntime(runtimeMinutes)
        : isSeriesEntry
          ? "Series"
          : "Movie";
    card.dataset.maturity = maturity;
    card.dataset.quality = qualityLabel;
    card.dataset.audio = "Stereo";
    card.dataset.description = safeDescription;
    card.dataset.cast = cast || "Cast details unavailable.";
    card.dataset.genres = genreNames.length ? genreNames.join(", ") : "Movie";
    card.dataset.vibe = "Continue watching";
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

    const resumeMin = Math.floor((entry.resumeSeconds || 0) / 60);
    const totalMin = runtimeMinutes || (estimatedDurationSeconds > 0 ? Math.round(estimatedDurationSeconds / 60) : 0);
    const progressTimeLabel = totalMin > 0 ? `${resumeMin} of ${totalMin}m` : resumeMin > 0 ? `${resumeMin}m watched` : "";

    card.innerHTML = `
      <div class="card-base">
        <img src="${escapeHtml(posterUrl)}" alt="${safeTitle}" loading="lazy" />
        <div class="progress"><span style="width: ${progressPercent}%"></span></div>
      </div>
      <div class="card-hover">
        <img class="card-hover-image" src="${escapeHtml(heroUrl)}" alt="${safeTitle} preview" loading="lazy" />
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
            <div class="progress"><span style="width: ${progressPercent}%"></span></div>
            ${progressTimeLabel ? `<span class="progress-time">${progressTimeLabel}</span>` : ""}
          </div>
          <div class="card-hover-meta">
            <span class="meta-age">${maturity}</span>
            <span class="meta-chip">${qualityLabel}</span>
            <span class="meta-spatial">${contentTypeLabel}</span>
          </div>
          <p class="card-hover-tags">${tagLine}</p>
        </div>
      </div>
    `;

    return card;
  }

  function buildCardFromTmdbElement(item, genreMap, imageBase = TMDB_IMAGE_BASE, cardIndex = 0) {
    const mediaType = getTmdbItemMediaType(item);
    const title = getTmdbItemTitle(item);
    const releaseDate = getTmdbItemReleaseDate(item);
    const year = releaseDate ? releaseDate.slice(0, 4) : "2024";
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
    const maturity = item.adult ? "18" : "13+";
    const mediaLabel = mediaType === "tv" ? "Series" : "Movie";
    const genreNames = (item.genre_ids || [])
      .map((id) => genreMap.get(id))
      .filter(Boolean)
      .slice(0, 3);
    const tagLine = genreNames.length
      ? genreNames.map(escapeHtml).join(" <span>&bull;</span> ")
      : "Popular <span>&bull;</span> Trending";
    const safeTitle = escapeHtml(title);
    const displayTitle = escapeHtml(
      String(title || "Untitled")
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase(),
    );
    const top10BadgeMarkup =
      cardIndex >= 0 && cardIndex < TOP_TEN_RAIL_LIMIT
        ? `<span class="card-top10-badge" aria-hidden="true"><span class="card-top10-badge-label">TOP</span><span class="card-top10-badge-rank">${cardIndex + 1}</span></span>`
        : "";
    const recentBadgeMarkup =
      cardIndex >= 0 && cardIndex < TOP_TEN_RAIL_LIMIT
        ? `<span class="card-recent-badge">Recently Added</span>`
        : "";

    const card = document.createElement("article");
    card.className = "card";
    card.tabIndex = 0;
    card.dataset.title = title;
    card.dataset.episode = year || "";
    card.dataset.src = "";
    card.dataset.thumb = heroUrl;
    card.dataset.year = year;
    card.dataset.runtime = mediaLabel;
    card.dataset.maturity = maturity;
    card.dataset.quality = "HD";
    card.dataset.audio = "Stereo";
    card.dataset.description = item.overview || "No description available.";
    card.dataset.cast = "Loading cast...";
    card.dataset.genres = genreNames.length
      ? genreNames.join(", ")
      : mediaLabel;
    card.dataset.vibe =
      mediaType === "tv"
        ? "Binge-worthy, Popular, Series"
        : "Trending, Popular, High-energy";
    card.dataset.tmdbId = String(item.id);
    card.dataset.mediaType = mediaType;

    card.innerHTML = `
      <div class="card-base">
        <div class="card-rail-art">
          ${top10BadgeMarkup}
          <img src="${escapeHtml(posterUrl)}" alt="${safeTitle}" loading="lazy" decoding="async" />
          <div class="card-rail-shade" aria-hidden="true"></div>
          <span class="card-rail-title" aria-hidden="true">${displayTitle}</span>
        </div>
        ${recentBadgeMarkup}
      </div>
      <div class="card-hover">
        <img class="card-hover-image" src="${escapeHtml(heroUrl)}" alt="${safeTitle} preview" loading="lazy" decoding="async" />
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
            <span>${year}</span>
            <span class="meta-chip">HD</span>
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
    const maturity = "13+";
    const qualityLabel = "HD";
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
    const mediaLabel = looksLikeCourse ? "Course" : "Movie";
    const tagLine = looksLikeCourse
      ? "Uploaded <span>&bull;</span> Course"
      : "Uploaded <span>&bull;</span> Local Library";

    const card = document.createElement("article");
    card.className = "card";
    card.tabIndex = 0;
    card.dataset.title = title;
    card.dataset.episode = year || "";
    card.dataset.src = src;
    card.dataset.thumb = heroUrl;
    card.dataset.year = year;
    card.dataset.runtime = mediaLabel;
    card.dataset.maturity = maturity;
    card.dataset.quality = qualityLabel;
    card.dataset.audio = "Stereo";
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
        <img src="${escapeHtml(posterUrl)}" alt="${safeTitle}" loading="lazy" />
        <div class="progress"><span style="width: 90%"></span></div>
      </div>
      <div class="card-hover">
        <img class="card-hover-image" src="${escapeHtml(heroUrl)}" alt="${safeTitle} preview" loading="lazy" />
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
            <span>${year}</span>
            <span class="meta-chip">${qualityLabel}</span>
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
    const maturity = tmdbDetails?.adult ? "18" : "13+";
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
    card.tabIndex = 0;
    card.dataset.title = title;
    card.dataset.episode = shouldHideEpisodePrefix
      ? firstEpisodeTitle
      : `E1 ${firstEpisodeTitle}`;
    card.dataset.src = "";
    card.dataset.thumb = heroUrl;
    card.dataset.year = year;
    card.dataset.runtime = mediaLabel;
    card.dataset.maturity = maturity;
    card.dataset.quality = "HD";
    card.dataset.audio = "Stereo";
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
        <img src="${escapeHtml(posterUrl)}" alt="${safeTitle}" loading="lazy" />
        <div class="progress"><span style="width: 94%"></span></div>
      </div>
      <div class="card-hover">
        <img class="card-hover-image" src="${escapeHtml(heroUrl)}" alt="${safeTitle} preview" loading="lazy" />
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
            <span>${year}</span>
            <span class="meta-chip">HD</span>
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
    { limit = BROWSE_RAIL_LIMIT, top10 = false, seenKeys = null } = {},
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
          top10 ? cards.length : -1,
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
    queueOfflineArtworkFromElement(container);
  }

  function applyLibrarySnapshot(localLibrary) {
    if (!localLibrary || typeof localLibrary !== "object") {
      return;
    }
    queueOfflineArtworkCache(collectLocalLibraryArtworkUrls(localLibrary));
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

    queueOfflineArtworkCache(collectHomeBootstrapArtworkUrls(bootstrap, imageBase));
    applyLibrarySnapshot(library);

    const popularCards = buildBrowseRailCards(
      getBootstrapResults(bootstrap, "bingeworthy", "nowPlaying", "popular"),
      genreMap,
      imageBase,
      { seenKeys: seenHomeRailKeys },
    );
    if (popularCards.length > 0) {
      applyFeaturedHeroFromPopularPayload(popularPayload, library, heroPreviewMap);
      setPopularRowTitle("Bingeworthy Series");
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
      { limit: TOP_TEN_RAIL_LIMIT, top10: true, seenKeys: seenHomeRailKeys },
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
    queueOfflineArtworkFromElement(container);
  }

  function normalizeLibraryTitleKey(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
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
      .map((item, index) => buildCardFromTmdbElement(item, genreMap, imageBase, index));
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
      setFeaturedHero(createDefaultFeaturedHero());
    }

    setPopularRowTitle("Recently Added");
    setPopularRowVisible(localCards.length > 0);
    renderPopularCards(localCards);
  }

  function applyFeaturedHeroCandidate(selected) {
    if (!selected) {
      setFeaturedHeroReady(false);
      setFeaturedHero(createDefaultFeaturedHero());
      stopHeroPreview();
      return;
    }
    const currentTmdbId = String(featuredHero()?.tmdbId || "").trim();
    if (currentTmdbId && currentTmdbId !== selected.tmdbId) {
      stopHeroPreview();
    }
    setFeaturedHeroReady(true);
    setFeaturedHero(selected);
    queueOfflineArtworkCache([selected.poster, selected.thumb]);
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
      window.clearInterval(heroCarouselTimer);
      heroCarouselTimer = null;
    }
  }

  function startHeroCarouselTimer() {
    stopHeroCarouselTimer();
    if (featuredHeroCandidates().length <= 1) {
      return;
    }
    heroCarouselTimer = window.setInterval(() => {
      if (activeView() !== "home" || showSearchExperience() || document.hidden) {
        return;
      }
      advanceFeaturedHeroCarousel();
    }, FEATURED_HERO_CAROUSEL_MS);
  }

  function handleHeroCarouselDotClick(index) {
    selectFeaturedHeroByIndex(index);
    startHeroCarouselTimer();
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
      queueOfflineArtworkCache([poster]);
      setFeaturedHero((current) => {
        if (String(current?.tmdbId || "").trim() !== tmdbId) {
          return current;
        }
        return {
          ...current,
          title: normalizeHeroTitle(details?.title || current.title),
          year,
          runtime: formatRuntime(details?.runtime) || current.runtime || "Movie",
          maturity: details?.adult ? "18+" : current.maturity || "13+",
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
          callouts: [
            current.src ? "Available locally" : "Top global movie",
            genreNames.length ? genreNames.join(" / ") : current.callouts?.[1],
          ].filter(Boolean),
          ready: true,
        };
      });
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

    const libraryRequest = apiFetch("/api/library").then(
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
    setPopularRowTitle(getPopularRowTitle(popularResult.value));
    setPopularRowVisible(cardsToRender.length > 0);
    markHomeBrowseContentReady();
    renderPopularCards(cardsToRender);
  }

  // ---- Load continue watching ----
  async function loadContinueWatching() {
    if (!continueCardsRef) {
      return;
    }
    const loadVersion = ++continueWatchingLoadVersion;

    const [entriesRaw, serverState, localLibrary] = await Promise.all([
      Promise.resolve(getContinueWatchingEntries()),
      fetchServerContinueWatchingState(),
      apiFetch("/api/library").catch(() => ({ movies: [], series: [] })),
    ]);
    const accountEntries = serverState.ok ? serverState.entries : entriesRaw;
    const entries = enrichContinueEntriesWithLocalLibrary(
      accountEntries,
      localLibrary,
    );
    if (loadVersion !== continueWatchingLoadVersion) {
      return;
    }
    if (!entries.length) {
      continueCardsRef.innerHTML = "";
      setContinueEmptyVisible(true);
      setContinueRowVisible(false);
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

    const renderEntries = (detailsMap = new Map()) => {
      if (loadVersion !== continueWatchingLoadVersion || !continueCardsRef) {
        return;
      }
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
          ? detailsMap.get(detailsLookupKey) || null
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
      queueOfflineArtworkFromElement(continueCardsRef);

      setContinueRowVisible(true);
      setContinueEmptyVisible(false);
      renderMyListRow();
    };

    renderEntries();

    if (!tmdbDetailKeys.length) {
      return;
    }

    void (async () => {
      const detailsMap = new Map();
      await Promise.allSettled(
        tmdbDetailKeys.map(async (detailKey) => {
          const separatorIndex = detailKey.indexOf(":");
          if (separatorIndex <= 0) {
            return;
          }
          const mediaType = detailKey.slice(0, separatorIndex);
          const tmdbId = detailKey.slice(separatorIndex + 1);
          const details = await apiFetchWithTimeout(
            "/api/tmdb/details",
            {
              tmdbId,
              mediaType,
            },
            TMDB_DETAILS_ENRICHMENT_TIMEOUT_MS,
          );
          if (details && typeof details === "object") {
            detailsMap.set(detailKey, details);
          }
        }),
      );
      if (detailsMap.size > 0) {
        renderEntries(detailsMap);
      }
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
      setSearchContextMenuStyle(`left: ${left}px; top: ${top}px;`);
    });
  }

  function buildSearchResultCardElement(item, imageBase = TMDB_IMAGE_BASE) {
    const details = createSearchResultDetails(item, imageBase);
    const safeTitle = String(details.title || "").trim() || "Untitled";

    const card = document.createElement("article");
    card.className = "search-result-card";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Play ${details.title}`);
    const img = document.createElement("img");
    img.src = String(details.thumb || "").trim() || DEFAULT_LOCAL_THUMBNAIL;
    img.alt = safeTitle;
    img.loading = "lazy";
    img.addEventListener("error", handleArtworkImageError);
    card.appendChild(img);
    const titleEl = document.createElement("p");
    titleEl.className = "search-result-card-title";
    titleEl.textContent = safeTitle;
    card.appendChild(titleEl);

    const openTitle = () => {
      hideSearchContextMenu();
      openPlayerPage(details);
    };

    card.addEventListener("click", openTitle);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openTitle();
      }
    });
    card.addEventListener("contextmenu", (event) => {
      openSearchContextMenu(event, details);
    });

    queueOfflineArtworkCache([details.thumb]);
    return card;
  }

  function clearSearchResults() {
    if (searchResultsGridRef) {
      searchResultsGridRef.innerHTML = "";
    }
    if (searchExploreLinksRef) {
      searchExploreLinksRef.innerHTML = "";
    }
  }

  function setSearchStatus(message, tone = "") {
    setSearchStatusText(String(message || ""));
    setSearchStatusTone(tone);
  }

  function renderSearchExploreSuggestions(results) {
    if (!searchExploreLinksRef) {
      return;
    }
    const suggestions = Array.from(
      new Set(
        (Array.isArray(results) ? results : [])
          .map((entry) =>
            normalizeSearchQuery(entry?.title || entry?.name || entry?.displayTitle || ""),
          )
          .filter(Boolean),
      ),
    ).slice(0, 12);

    if (!suggestions.length) {
      searchExploreLinksRef.innerHTML = "";
      return;
    }

    searchExploreLinksRef.innerHTML = suggestions
      .map(
        (value) =>
          `<a class="search-explore-link" href="#" data-search-query="${escapeHtml(value)}">${escapeHtml(value)}</a>`,
      )
      .join("");
  }

  function renderSearchResults(results, rawQuery, imageBase = TMDB_IMAGE_BASE) {
    if (!searchResultsGridRef) {
      return;
    }
    const list = Array.isArray(results) ? results : [];
    searchResultsGridRef.innerHTML = "";
    renderSearchExploreSuggestions(list);
    const safeQuery = normalizeSearchQuery(rawQuery);

    if (!list.length) {
      setSearchStatus(`No results for "${safeQuery}".`, "error");
      return;
    }

    const fragment = document.createDocumentFragment();
    list.forEach((item) => {
      fragment.appendChild(buildSearchResultCardElement(item, imageBase));
    });
    searchResultsGridRef.appendChild(fragment);
    setSearchStatus(
      `Showing ${list.length} result${list.length === 1 ? "" : "s"} for "${safeQuery}".`,
      "success",
    );
  }

  async function runTmdbSearch(rawQuery) {
    const query = normalizeSearchQuery(rawQuery);
    const requestToken = ++activeSearchRequestToken;

    if (query.length < SEARCH_MIN_QUERY_LENGTH) {
      clearSearchResults();
      setSearchStatus("Type at least 2 characters to search.");
      return;
    }

    if (searchAbortController) {
      searchAbortController.abort();
    }
    searchAbortController = new AbortController();
    const signal = searchAbortController.signal;

    setSearchStatus(`Searching for "${query}"...`);
    try {
      const params = new URLSearchParams({ query, limit: String(SEARCH_RESULTS_LIMIT) });
      const url = `/api/tmdb/search?${params.toString()}`;
      const response = await fetch(url, { signal });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || `Request failed (${response.status})`);
      }
      if (requestToken !== activeSearchRequestToken) {
        return;
      }
      renderSearchResults(payload?.results || [], query, payload?.imageBase || TMDB_IMAGE_BASE);
    } catch (error) {
      if (error?.name === "AbortError") {
        return;
      }
      if (requestToken !== activeSearchRequestToken) {
        return;
      }
      clearSearchResults();
      setSearchStatus(
        error instanceof Error ? error.message : "Search failed.",
        "error",
      );
    }
  }

  function scheduleTmdbSearchFromInput({ immediate = false } = {}) {
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
    if (!navSearchInputRef) {
      return;
    }
    if (!isSearchModeActive()) {
      openSearchMode({ focusInput: false });
    }
    if (!isSearchModeActive()) {
      return;
    }

    if (immediate) {
      void runTmdbSearch(navSearchInputRef.value);
      return;
    }

    searchDebounceTimer = window.setTimeout(() => {
      searchDebounceTimer = null;
      void runTmdbSearch(navSearchInputRef.value);
    }, SEARCH_DEBOUNCE_MS);
  }

  function openSearchMode({ focusInput = true } = {}) {
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
    requestAnimationFrame(() => {
      setSearchBoxOpen(true);
    });

    if (focusInput && navSearchInputRef) {
      requestAnimationFrame(() => {
        navSearchInputRef.focus({ preventScroll: true });
        navSearchInputRef.select();
      });
    }

    if (navSearchInputRef && navSearchInputRef.value.trim()) {
      scheduleTmdbSearchFromInput({ immediate: true });
      return;
    }

    clearSearchResults();
    setSearchStatus("Start typing to search TMDB titles.");
  }

  function closeSearchMode({ clearInput = true } = {}) {
    setIsSearchModeActive(false);
    hideSearchContextMenu();
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
    activeSearchRequestToken += 1;
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
    if (clearInput && navSearchInputRef) {
      navSearchInputRef.value = "";
    }
    clearSearchResults();
    setSearchStatus("Start typing to search TMDB titles.");
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
  function getHeroPreviewVideo() {
    return heroPreviewVideoRef instanceof HTMLVideoElement
      ? heroPreviewVideoRef
      : null;
  }

  function getHeroPreviewSrc() {
    return normalizeHeroPreviewPath(featuredHero()?.previewSrc);
  }

  function canPlayHeroPreview() {
    return (
      heroPreviewInViewport &&
      activeView() === "home" &&
      !showSearchExperience() &&
      !document.hidden &&
      Boolean(getHeroPreviewSrc())
    );
  }

  function canPreloadHeroPreview() {
    return (
      heroPreviewInViewport &&
      activeView() === "home" &&
      !showSearchExperience() &&
      !document.hidden &&
      Boolean(getHeroPreviewSrc())
    );
  }

  function ensureHeroPreviewVideoLoaded() {
    const video = getHeroPreviewVideo();
    const previewSrc = getHeroPreviewSrc();
    if (!video || !previewSrc || !canPreloadHeroPreview()) {
      return false;
    }
    video.loop = true;
    video.playsInline = true;
    video.muted = isMuted();
    if (video.getAttribute("src") !== previewSrc) {
      video.pause();
      video.setAttribute("src", previewSrc);
      video.load();
    }
    return true;
  }

  function applyHeroPreviewMutedState(nextMuted) {
    setIsMuted(nextMuted);
    const video = getHeroPreviewVideo();
    if (!video) {
      return;
    }
    video.muted = nextMuted;
    if (heroPreviewActive() && canPlayHeroPreview()) {
      void resumeHeroPreviewPlayback();
    }
  }

  function ensureHeroPreviewPreloadSource() {
    if (!ensureHeroPreviewVideoLoaded()) {
      return false;
    }
    setHeroPreviewActive(false);
    return true;
  }

  function suspendHeroPreviewForViewport() {
    heroPreviewPlayRequestId += 1;
    getHeroPreviewVideo()?.pause();
    setHeroPreviewPlaying(false);
  }

  function resumeHeroPreviewAfterViewport() {
    if (heroPreviewActive() && getHeroPreviewVideo()?.getAttribute("src")) {
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
    const video = getHeroPreviewVideo();
    if (!video || !canPlayHeroPreview()) {
      return false;
    }

    heroPreviewPlayRequestId += 1;
    const requestId = heroPreviewPlayRequestId;
    if (!ensureHeroPreviewVideoLoaded()) {
      return false;
    }

    video.muted = isMuted();
    const playPromise = video.play();
    if (!playPromise || typeof playPromise.then !== "function") {
      setHeroPreviewPlaying(true);
      return true;
    }

    playPromise
      .then(() => {
        if (requestId === heroPreviewPlayRequestId) {
          setHeroPreviewPlaying(true);
        }
      })
      .catch(() => {
        if (requestId !== heroPreviewPlayRequestId) {
          return;
        }
        if (!video.muted) {
          setIsMuted(true);
          video.muted = true;
          void video.play().then(() => {
            if (requestId === heroPreviewPlayRequestId) {
              setHeroPreviewPlaying(true);
            }
          }).catch(() => {
            if (requestId === heroPreviewPlayRequestId) {
              stopHeroPreview();
            }
          });
          return;
        }
        stopHeroPreview();
      });
    return true;
  }

  function stopHeroPreview() {
    heroPreviewPlayRequestId += 1;
    const video = getHeroPreviewVideo();
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
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
      if (heroPreviewActive() && getHeroPreviewVideo()?.getAttribute("src")) {
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
    if (!getHeroPreviewSrc()) {
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

  function handleMuteToggle() {
    applyHeroPreviewMutedState(!isMuted());
  }

  function handleHeroPlay() {
    const destination = getHeroDestination();
    if (destination) {
      openPlayerPage(destination);
    }
  }

  function handleHeroInfo() {
    const destination = getHeroDestination();
    if (!destination) {
      return;
    }
    const hero = featuredHero();
    activeDetails = {
      ...destination,
      thumb: hero.poster || destination.thumb,
      runtime: hero.runtime || "Movie",
      maturity: hero.maturity || "13+",
      quality: "HD",
      audio: "Stereo",
      description: hero.description || "No description available.",
      cast: "Loading cast...",
      genres: getFeaturedHeroCallouts(hero).slice(1).join(", ") || "Popular title",
      vibe: getFeaturedHeroCallouts(hero).join(", "),
    };
    detailsTrigger = null;
    populateDetailsModal(activeDetails);
    setDetailsMyListActive(isMyListEntryActive(activeDetails));
    if (detailsMoreGridRef) {
      detailsMoreGridRef.innerHTML = "";
    }
    setDetailsMoreVisible(false);
    setDetailsModalVisible(true);
    requestAnimationFrame(() => {
      setDetailsModalOpen(true);
    });
    syncBodyModalLock();
    detailsCloseButtonRef?.focus({ preventScroll: true });
  }

  function handleHeroTitleClick() {
    const destination = getHeroDestination();
    if (destination) {
      openPlayerPage(destination);
    }
  }

  function handleHeroTitleKeydown(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      const destination = getHeroDestination();
      if (destination) {
        openPlayerPage(destination);
      }
    }
  }

  // ---- Sign out ----
  async function handleSignOut(e) {
    e.preventDefault();
    try { await fetch("/api/auth/logout", { method: "POST" }); } catch {}
    window.location.href = "/login.html";
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
    closeSearchMode({ clearInput: false });
    pageRootRef?.focus({ preventScroll: true });
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
      closeSearchMode();
      pageRootRef?.focus({ preventScroll: true });
    }
  }

  function handleSearchExploreClick(event) {
    const link = event.target instanceof Element ? event.target.closest("a") : null;
    if (!(link instanceof HTMLAnchorElement)) {
      return;
    }
    event.preventDefault();
    const query = normalizeSearchQuery(link.dataset.searchQuery || "");
    if (!query || !navSearchInputRef) {
      return;
    }
    navSearchInputRef.value = query;
    scheduleTmdbSearchFromInput({ immediate: true });
    navSearchInputRef.focus({ preventScroll: true });
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
      closeSearchMode({ clearInput: false });
    }
    setActiveView("home");
    if (push && window.location.pathname !== "/") {
      window.history.pushState({ view: "home" }, "", "/");
    }
    stopHeroPreview();
  }

  function ensureLiveViewLoaded() {
    if (!liveViewLoadPromise) {
      liveViewLoadPromise = Promise.all([
        import("../../live.css"),
        import("../components/live-channels-view.js"),
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
      closeSearchMode({ clearInput: false });
    }
    void ensureLiveViewLoaded();
    setActiveView("live");
    if (push && window.location.pathname !== "/live") {
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

  // ---- My List nav link ----
  function handleMyListNavClick(event) {
    event.preventDefault();
    if (isSearchModeActive()) {
      closeSearchMode({ clearInput: false });
    }
    if (activeView() !== "home") {
      showHomeView();
    }
    const myListRowEl = document.getElementById("myListRow");
    if (myListRowEl && !myListRowEl.hidden) {
      myListRowEl.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const popRow = document.getElementById("popularRow");
    popRow?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---- Details modal handlers ----
  function handleDetailsPlay() {
    if (!activeDetails) return;
    openPlayerPage(activeDetails);
  }

  function handleDetailsMyList() {
    if (!activeDetails) {
      return;
    }
    const isAdded = toggleMyList(activeDetails);
    setDetailsMyListActive(isAdded);
    renderMyListRow();
    syncAllMyListButtons();
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
          if (nextCategory === "upload") {
            setLibraryEditModalStatus(
              "Upload mode: editor fields are hidden. Use Open Upload Flow.",
            );
          } else if (nextCategory === "episodes") {
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
    const uploadButton = target?.closest?.('[data-action="open-upload-episode"]');
    if (uploadButton instanceof HTMLButtonElement) {
      openEpisodeUploadFlowForActiveSeries();
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
    openEpisodeUploadFlowForActiveSeries();
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
    applyLibraryEditModeClass();
    renderMyListRow();
    if (pageRootRef) {
      attachArtworkImageFallbacks(pageRootRef);
      queueOfflineArtworkFromElement(pageRootRef);
    }
    void loadContinueWatching();
    let appliedInjectedBootstrap = false;
    if (window.__HOME_BOOTSTRAP__ && typeof window.__HOME_BOOTSTRAP__ === "object") {
      appliedInjectedBootstrap = applyHomeBootstrapPayload(window.__HOME_BOOTSTRAP__);
    }
    if (!appliedInjectedBootstrap) {
      void initializeHomeContent();
    }
    applyAccountAvatarStyle();
    closeAccountMenu();
    if (window.location.pathname === "/live") {
      showLiveView({ push: false });
    }

    // Handle initial search query
    const initialSearchQuery = normalizeSearchQuery(
      new URLSearchParams(window.location.search).get("q") || "",
    );
    const shouldRestoreSearchMode = Boolean(
      initialSearchQuery ||
        (showSearchBox() && searchBoxOpen()),
    );
    if (shouldRestoreSearchMode && navSearchInputRef) {
      navSearchInputRef.value = initialSearchQuery;
      openSearchMode({ focusInput: false });
      if (initialSearchQuery) {
        scheduleTmdbSearchFromInput({ immediate: true });
      }
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
          closeSearchMode();
          pageRootRef?.focus({ preventScroll: true });
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

    const dismissCardHoversOnScroll = (event) => {
      if (
        event.target instanceof Element &&
        event.target.closest(".cards.popular-cards")
      ) {
        return;
      }
      document.querySelectorAll(".card.is-hovering").forEach((card) => {
        hideCardHover(card);
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
      applyLibraryEditModeClass();
      stopHeroPreview();
      void refreshAccountBackedCaches();
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopHeroPreview();
        return;
      }
      void refreshAccountBackedCaches();
    };

    const handleServerHydrated = (event) => {
      const detail = event.detail || {};
      if (detail.didLoadContinueWatching || detail.didLoadProgress) {
        void loadContinueWatching();
      }
      if (detail.didLoadMyList) {
        renderMyListRow();
        syncAllMyListButtons();
      }
    };

    const handlePopstate = () => {
      if (window.location.pathname === "/live") {
        showLiveView({ push: false });
      } else {
        showHomeView({ push: false });
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
    window.addEventListener("popstate", handlePopstate);
    window.addEventListener(SERVER_HYDRATED_EVENT, handleServerHydrated);

    onCleanup(() => {
      cleanupHorizontalRailScrollers();
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
      window.removeEventListener("popstate", handlePopstate);
      window.removeEventListener(SERVER_HYDRATED_EVENT, handleServerHydrated);

      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      if (searchBoxHideTimer) clearTimeout(searchBoxHideTimer);
      if (closeModalTimer) clearTimeout(closeModalTimer);
      if (libraryEditModalCloseTimer) clearTimeout(libraryEditModalCloseTimer);
    });
  });

  // ---- Template ----
  return html`<div data-solid-page-root="" style="display: contents">
    <div class="page home-page" tabindex="0" ref=${(el) => (pageRootRef = el)}>
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
            <a href="/" class=${() => activeView() === "home" ? "is-active" : ""} onClick=${handleHomeNavClick}>Home</a>
            <a href="/live" class=${() => liveNavClass(activeView() === "live" ? "live" : "")} onClick=${handleLiveNavClick}>Live</a>
            <a href="/sports" class=${sportsNavLinkClass("")}>Sports</a>
            <a href="#" id="navMyList" class="optional" onClick=${handleMyListNavClick}>My List</a>
          </nav>
        </div>
        <div class="nav-right">
          <div
            id="navSearchBox"
            class=${() => `nav-search-box${searchBoxOpen() ? " is-open" : ""}`}
            style=${() => showSearchBox() ? "" : "display:none"}
          >
            <label class="nav-search-field" for="navSearchInput">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M14.33 12.9 19.71 18.28a1 1 0 0 1-1.42 1.42l-5.38-5.38a8 8 0 1 1 1.42-1.42Zm-6.33 1.1a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z"></path>
              </svg>
              <input
                id="navSearchInput"
                ref=${(el) => (navSearchInputRef = el)}
                type="search"
                inputmode="search"
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
                spellcheck="false"
                placeholder="Titles, people, genres"
                aria-label="Search titles, people, genres"
                onInput=${handleSearchInput}
                onFocus=${handleSearchFocus}
                onSearch=${handleSearchSubmit}
                onKeydown=${handleSearchKeydown}
              />
            </label>
            <button
              id="closeSearchButton"
              class="nav-search-close"
              type="button"
              aria-label="Close search"
              onClick=${handleCloseSearch}
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
            aria-expanded=${() => isSearchModeActive() ? "true" : "false"}
            onClick=${handleOpenSearch}
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
          <div id="accountMenu" class="account-menu">
            <button
              id="accountAvatarButton"
              class="account-avatar-btn"
              aria-label="Account menu"
              aria-haspopup="menu"
              aria-controls="accountMenuPanel"
              aria-expanded=${() => accountMenuOpen() ? "true" : "false"}
              onClick=${handleAccountMenuToggle}
            >
              <div
                id="accountAvatar"
                class=${() => avatarClassName()}
                style=${() => avatarInlineStyle()}
                aria-hidden="true"
              ></div>
            </button>
            <button
              id="accountMenuToggle"
              class="icon-btn account-menu-toggle"
              aria-label="Account menu"
              aria-haspopup="menu"
              aria-expanded=${() => accountMenuOpen() ? "true" : "false"}
              onClick=${handleAccountMenuToggle}
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
              ref=${(el) => (accountMenuPanelRef = el)}
              class="account-menu-panel"
              role="menu"
              style=${() => accountMenuOpen() ? "" : "display:none"}
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
              <a class="account-menu-item account-menu-link" href="https://help.netflix.com/" target="_blank" rel="noreferrer" role="menuitem">
                <span class="account-menu-icon" aria-hidden="true">
                  <svg viewBox="0 0 48 48">
                    <circle cx="24" cy="24" r="19"></circle>
                    <path d="M18.5 18.2c.9-3.7 4.1-6 8-5.4 3.5.6 6 3.2 6 6.5 0 4.9-5.6 5.8-7.2 9.3"></path>
                    <circle cx="24" cy="35.5" r="1.5"></circle>
                  </svg>
                </span>
                <span>Help Centre</span>
              </a>
              <a
                id="signOutBtn"
                class="account-menu-item account-menu-signout"
                href="#"
                role="menuitem"
                onClick=${handleSignOut}
              >Sign out of Netflix</a>
            </div>
          </div>
        </div>
      </header>

      <section
        id="searchExperience"
        class="search-experience"
        style=${() => showSearchExperience() ? "" : "display:none"}
      >
        <p
          id="searchStatus"
          class=${() => {
            const tone = searchStatusTone();
            let cls = "search-status";
            if (tone === "error") cls += " is-error";
            if (tone === "success") cls += " is-success";
            return cls;
          }}
        >${() => searchStatusText()}</p>
        <div
          id="searchExplore"
          class="search-explore"
          style=${() => {
            if (!searchExploreLinksRef) return "display:none";
            return searchExploreLinksRef.innerHTML ? "" : "display:none";
          }}
        >
          <span class="search-explore-label">More to explore:</span>
          <div
            id="searchExploreLinks"
            class="search-explore-links"
            ref=${(el) => (searchExploreLinksRef = el)}
            onClick=${handleSearchExploreClick}
          ></div>
        </div>
        <div
          id="searchResultsGrid"
          class="search-results-grid"
          ref=${(el) => (searchResultsGridRef = el)}
        ></div>
      </section>

      <div
        id="liveTabView"
        class="live-tab-view"
        style=${() => activeView() === "live" && !showSearchExperience() ? "" : "display:none"}
      >
        ${() => {
          const Component = LiveChannelsComponent();
          return Component ? Component({}) : null;
        }}
      </div>

      <section
        class=${() =>
          `featured-hero${featuredHeroReady() ? " is-hero-ready" : ""}${heroPreviewActive() ? " is-preview-active" : ""}${heroPreviewPlaying() ? " is-preview-playing" : ""}`}
        ref=${(el) => (heroSectionRef = el)}
        aria-label="Featured title"
        style=${() => activeView() === "home" ? "" : "display:none"}
        onPointerEnter=${scheduleHeroPreviewPlayback}
      >
        <img
          class="hero-poster"
          src=${() => featuredHero().poster}
          alt=""
          aria-hidden="true"
          decoding="async"
          fetchpriority="high"
          loading="eager"
          onError=${handleArtworkImageError}
        />
        <div class="hero-preview-stage" aria-hidden="true">
          <video
            id="heroPreview"
            ref=${(el) => (heroPreviewVideoRef = el)}
            class="hero-preview-video"
            title=${() => `${featuredHero().title || "Featured movie"} preview`}
            preload="metadata"
            loop
            muted=${() => isMuted()}
            playsinline
            disablepictureinpicture
            tabindex="-1"
            aria-hidden="true"
            onPlay=${() => setHeroPreviewPlaying(true)}
            onPause=${() => setHeroPreviewPlaying(false)}
            onEnded=${() => setHeroPreviewPlaying(false)}
            onError=${() => stopHeroPreview()}
          ></video>
        </div>
        <div class="hero-preview-shield" aria-hidden="true"></div>

        <div class="hero-shade" aria-hidden="true"></div>

        <div class="hero-bottom-controls">
          <div class="hero-controls">
            <button
              id="muteToggle"
              class=${() => `control-btn${isMuted() ? " muted" : ""}`}
              type="button"
              aria-label=${() => isMuted() ? "Unmute preview" : "Mute preview"}
              disabled=${() => !featuredHero().previewSrc}
              onClick=${handleMuteToggle}
            >
              <svg class="icon-on" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M14 5.2v13.6a1 1 0 0 1-1.68.74L7.6 15H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h2.6l4.72-4.54A1 1 0 0 1 14 5.2Zm3.72 2.18a1 1 0 1 1 1.56-1.24 10.25 10.25 0 0 1 0 11.72 1 1 0 1 1-1.56-1.24 8.25 8.25 0 0 0 0-9.24Zm-2.8 2.26a1 1 0 0 1 1.56-1.24 5.8 5.8 0 0 1 0 7.2 1 1 0 1 1-1.56-1.24 3.8 3.8 0 0 0 0-4.72Z"></path>
              </svg>
              <svg class="icon-off" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M14 5.2v13.6a1 1 0 0 1-1.68.74L7.6 15H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h2.6l4.72-4.54A1 1 0 0 1 14 5.2Zm6.3 3.1a1 1 0 0 1 0 1.4L18.01 12l2.3 2.3a1 1 0 0 1-1.42 1.4L16.6 13.4l-2.3 2.3a1 1 0 0 1-1.4-1.42l2.3-2.28-2.3-2.3a1 1 0 0 1 1.4-1.4l2.3 2.3 2.29-2.3a1 1 0 0 1 1.41 0Z"></path>
              </svg>
            </button>
            <span class="hero-bottom-rating" aria-label=${() => `Rated ${featuredHero().maturity || "13+"}`}>
              ${() => getFeaturedHeroMaturityLabel(featuredHero())}
            </span>
          </div>
          <div
            class="hero-carousel-dots"
            role="tablist"
            aria-label="Featured titles"
            style=${() => featuredHeroCandidates().length <= 1 ? "display:none" : ""}
          >
            ${() =>
              featuredHeroCandidates()
                .slice(0, FEATURED_HERO_CANDIDATE_LIMIT)
                .map((candidate, index) => html`
                  <button
                    type="button"
                    class=${() =>
                      `hero-carousel-dot${featuredHeroIndex() === index ? " is-active" : ""}`}
                    aria-label=${`Show ${candidate.title || "featured title"}`}
                    aria-selected=${() => (featuredHeroIndex() === index ? "true" : "false")}
                    onClick=${() => handleHeroCarouselDotClick(index)}
                  ></button>
                `)}
          </div>
        </div>

        <section
          class=${() =>
            `hero-content${featuredHeroReady() ? "" : " is-loading"}`}
          aria-labelledby="heroTitle"
        >
          <img
            src="assets/icons/netflix-logo-clean.png"
            class="featured-logo-mark"
            alt="Netflix"
          />
          <h1
            id="heroTitle"
            class="hero-title-stacked"
            tabindex="0"
            aria-label=${() => `Open ${featuredHero().title || "featured movie"} player`}
            onClick=${handleHeroTitleClick}
            onKeydown=${handleHeroTitleKeydown}
          >
            ${() =>
              getFeaturedHeroTitleLines(featuredHero()).map(
                (line) => html`<span>${line}</span>`,
              )}
          </h1>
          <p
            class="hero-tagline"
            style=${() => (getFeaturedHeroTagline(featuredHero()) ? "" : "display:none")}
          >
            ${() => getFeaturedHeroTagline(featuredHero())}
          </p>
          <p class="description">
            ${() => featuredHero().description || "No description available."}
          </p>
          <div class="hero-actions">
            <button
              id="heroPlay"
              class="cta cta-play"
              type="button"
              disabled=${() => !getHeroDestination()}
              onClick=${handleHeroPlay}
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
              disabled=${() => !getHeroDestination()}
              onClick=${handleHeroInfo}
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
              More Info
            </button>
          </div>
        </section>

      </section>

      <section
        id="continueRow"
        class="continue-row"
        style=${() => activeView() === "home" && continueRowVisible() ? "" : "display:none"}
      >
        <h2>Continue watching for <span id="continueWatchingName">${displayName || "you"}</span></h2>
        <div
          id="continueCards"
          class="cards popular-cards continue-cards"
          ref=${(el) => (continueCardsRef = el)}
        ></div>
        <p
          id="continueEmpty"
          class="continue-empty"
          style=${() => continueEmptyVisible() ? "" : "display:none"}
        >
          Start a movie and it will appear here.
        </p>
      </section>

      <section
        id="popularRow"
        class="popular-row home-popular-row"
        style=${() => activeView() === "home" && popularRowVisible() ? "" : "display:none"}
      >
        <div class="popular-row-inner">
          <div class="rail-header">
            <h2 id="popularRowTitle">${() => popularRowTitle()}</h2>
          </div>
          <div
            id="cardsContainer"
            class="cards popular-cards"
            ref=${(el) => (cardsContainerRef = el)}
          ></div>
        </div>
      </section>

      <section
        id="trendingRow"
        class="popular-row home-popular-row"
        style=${() => activeView() === "home" && trendingRowVisible() ? "" : "display:none"}
      >
        <div class="popular-row-inner">
          <div class="rail-header">
            <h2>Crowd-pleasers</h2>
          </div>
          <div
            id="trendingCardsContainer"
            class="cards popular-cards"
            ref=${(el) => (trendingCardsContainerRef = el)}
          ></div>
        </div>
      </section>

      <section
        id="nowPlayingRow"
        class="popular-row home-popular-row"
        style=${() => activeView() === "home" && nowPlayingRowVisible() ? "" : "display:none"}
      >
        <div class="popular-row-inner">
          <div class="rail-header">
            <h2>Top 10 Series Worth Watching</h2>
          </div>
          <div
            id="nowPlayingCardsContainer"
            class="cards popular-cards"
            ref=${(el) => (nowPlayingCardsContainerRef = el)}
          ></div>
        </div>
      </section>

      <section
        id="topRatedRow"
        class="popular-row home-popular-row"
        style=${() => activeView() === "home" && topRatedRowVisible() ? "" : "display:none"}
      >
        <div class="popular-row-inner">
          <div class="rail-header">
            <h2>Critically Acclaimed</h2>
          </div>
          <div
            id="topRatedCardsContainer"
            class="cards popular-cards"
            ref=${(el) => (topRatedCardsContainerRef = el)}
          ></div>
        </div>
      </section>
    </div>

    <section
      id="myListRow"
      class="popular-row"
      style=${() => activeView() === "home" && myListRowVisible() ? "" : "display:none"}
    >
      <div class="popular-row-inner">
        <h2>My List</h2>
        <div
          id="myListCards"
          class="cards popular-cards"
          ref=${(el) => (myListCardsRef = el)}
        ></div>
        <p
          id="myListEmpty"
          class="continue-empty"
          style=${() => myListEmptyVisible() ? "" : "display:none"}
        >
          Add titles using the plus icon.
        </p>
      </div>
    </section>

    <footer
      class="member-footer home-member-footer"
      aria-label="Netflix footer"
      style=${() => activeView() === "home" ? "" : "display:none"}
    >
      <div class="member-footer-social">
        <a href="#" aria-label="Facebook">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M13.6 21v-7.7h2.6l.4-3h-3V8.4c0-.9.3-1.5 1.6-1.5h1.6V4.2c-.8-.1-1.7-.2-2.5-.2-2.5 0-4.2 1.5-4.2 4.3v2.4H7.8v3h2.8V21h3Z"></path>
          </svg>
        </a>
        <a href="#" aria-label="Instagram">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7.4 2.8h9.2a4.6 4.6 0 0 1 4.6 4.6v9.2a4.6 4.6 0 0 1-4.6 4.6H7.4a4.6 4.6 0 0 1-4.6-4.6V7.4a4.6 4.6 0 0 1 4.6-4.6Zm0 2A2.6 2.6 0 0 0 4.8 7.4v9.2a2.6 2.6 0 0 0 2.6 2.6h9.2a2.6 2.6 0 0 0 2.6-2.6V7.4a2.6 2.6 0 0 0-2.6-2.6H7.4Zm4.6 3a4.2 4.2 0 1 1 0 8.4 4.2 4.2 0 0 1 0-8.4Zm0 2a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4Zm4.5-2.35a1.05 1.05 0 1 1 0 2.1 1.05 1.05 0 0 1 0-2.1Z"></path>
          </svg>
        </a>
        <a href="#" aria-label="Twitter">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18.9 2.8h3.3l-7.3 8.3 8.5 10.1h-6.7l-5.2-6.2-6 6.2H2.2l7.8-8.2L1.8 2.8h6.8l4.7 5.8 5.6-5.8Zm-1.2 16.6h1.8L7.6 4.5H5.7l12 14.9Z"></path>
          </svg>
        </a>
        <a href="#" aria-label="YouTube">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M21.5 7.1a3 3 0 0 0-2.1-2.1C17.5 4.5 12 4.5 12 4.5s-5.5 0-7.4.5a3 3 0 0 0-2.1 2.1A31 31 0 0 0 2 12a31 31 0 0 0 .5 4.9 3 3 0 0 0 2.1 2.1c1.9.5 7.4.5 7.4.5s5.5 0 7.4-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 22 12a31 31 0 0 0-.5-4.9ZM10 15.4V8.6l5.8 3.4L10 15.4Z"></path>
          </svg>
        </a>
      </div>
      <ul class="member-footer-links">
        <li><a href="#">Audio Description</a></li>
        <li><a href="#">Help Centre</a></li>
        <li><a href="#">Gift Cards</a></li>
        <li><a href="#">Media Centre</a></li>
        <li><a href="#">Investor Relations</a></li>
        <li><a href="#">Jobs</a></li>
        <li><a href="#">Terms of Use</a></li>
        <li><a href="#">Privacy</a></li>
        <li><a href="#">Legal Notices</a></li>
        <li><a href="#">Cookie Preferences</a></li>
        <li><a href="#">Corporate Information</a></li>
        <li><a href="#">Contact Us</a></li>
        <li><a href="#">Speed Test</a></li>
        <li><a href="#">Only on Netflix</a></li>
      </ul>
      <p class="member-footer-copyright">&copy; 1997-2026 Netflix, Inc.</p>
    </footer>

    <div
      id="detailsModal"
      class=${() => `details-modal${detailsModalOpen() ? " is-open" : ""}`}
      style=${() => detailsModalVisible() ? "" : "display:none"}
      onClick=${handleDetailsBackdropClick}
    >
      <div class="details-backdrop" data-close-modal></div>
      <article
        class="details-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detailsTitle"
      >
        <button
          id="detailsClose"
          ref=${(el) => (detailsCloseButtonRef = el)}
          class="details-close"
          type="button"
          aria-label="Close details"
          onClick=${handleDetailsClose}
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
            src=${() => detailsData().thumb}
            alt=${() => `${detailsData().title} artwork`}
          />
          <div class="details-hero-fade" aria-hidden="true"></div>
          <div class="details-hero-content">
            <h3 id="detailsTitle">${() => detailsData().title}</h3>
            <div class="details-actions">
              <button
                id="detailsPlay"
                class="cta cta-play details-play"
                type="button"
                onClick=${handleDetailsPlay}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 3.5v17L20 12 5 3.5Z"></path>
                </svg>
                Play
              </button>
              <button
                id="detailsMyList"
                class=${() => `details-round${detailsMyListActive() ? " is-active" : ""}`}
                type="button"
                aria-label=${() => detailsMyListActive() ? "Remove from My List" : "Add to My List"}
                aria-pressed=${() => detailsMyListActive() ? "true" : "false"}
                onClick=${handleDetailsMyList}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d=${() => detailsMyListActive() ? "M5 12.5 9.2 16.7 19 7" : "M12 5v14M5 12h14"}
                    fill="none"
                    stroke-linecap="round"
                    stroke-linejoin="round"
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
              <span id="detailsYear">${() => detailsData().year}</span>
              <span id="detailsRuntime">${() => detailsData().runtime}</span>
              <span id="detailsMaturity" class="details-maturity">${() => detailsData().maturity}</span>
              <span id="detailsQuality" class="meta-chip">${() => detailsData().quality}</span>
              <span id="detailsAudio" class="details-audio">${() => detailsData().audio}</span>
            </div>
            <p id="detailsDescription" class="details-description">
              ${() => detailsData().description}
            </p>
          </section>

          <aside class="details-side">
            <p>
              <span>Cast:</span>
              <strong id="detailsCast">${() => detailsData().cast}</strong>
            </p>
            <p>
              <span>Genres:</span>
              <strong id="detailsGenres">${() => detailsData().genres}</strong>
            </p>
            <p>
              <span>This title is:</span>
              <strong id="detailsVibe">${() => detailsData().vibe}</strong>
            </p>
          </aside>
        </div>

        <section
          id="detailsMoreSection"
          class="details-more"
          style=${() => detailsMoreVisible() ? "" : "display:none"}
        >
          <h4>More Like This</h4>
          <div
            id="detailsMoreGrid"
            class="details-grid"
            ref=${(el) => (detailsMoreGridRef = el)}
          ></div>
        </section>
      </article>
    </div>

    <div
      id="libraryEditModal"
      class=${() => `library-edit-modal${libraryEditModalOpen() ? " is-open" : ""}`}
      style=${() => libraryEditModalVisible() ? "" : "display:none"}
      onClick=${handleLibraryEditBackdropClick}
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
          onClick=${handleLibraryEditClose}
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
          <h3 id="libraryEditModalTitle">${() => libraryEditModalTitleText()}</h3>
          <p id="libraryEditModalMeta" class="library-edit-modal-meta">${() => libraryEditModalMetaText()}</p>
        </header>
        <div
          id="libraryEditFields"
          class="library-edit-fields"
          ref=${(el) => (libraryEditFieldsRef = el)}
          onClick=${handleLibraryEditFieldsClick}
        ></div>
        <div class="library-edit-modal-actions">
          <button
            id="libraryAddEpisodeBtn"
            class="library-edit-btn"
            type="button"
            style=${() => libraryAddEpisodeVisible() ? "" : "display:none"}
            onClick=${handleLibraryAddEpisode}
          >
            ${() => libraryAddEpisodeBtnText()}
          </button>
          <button
            id="librarySaveBtn"
            class="library-edit-btn library-edit-btn--primary"
            type="button"
            style=${() => librarySaveBtnVisible() ? "" : "display:none"}
            onClick=${handleLibrarySave}
          >
            Save Changes
          </button>
          <button
            id="libraryDeleteBtn"
            class="library-edit-btn library-edit-btn--danger"
            type="button"
            style=${() => libraryDeleteBtnVisible() ? "" : "display:none"}
            onClick=${handleLibraryDelete}
          >
            Delete Title
          </button>
        </div>
        <p
          id="libraryEditModalStatus"
          class=${() => {
            const tone = libraryEditStatusTone();
            let cls = "library-edit-modal-status";
            if (tone === "success") cls += " status-success";
            if (tone === "error") cls += " status-error";
            return cls;
          }}
          role="status"
          aria-live="polite"
        >${() => libraryEditStatusText()}</p>
      </article>
    </div>

    <div
      id="searchContextMenu"
      ref=${(el) => (searchContextMenuRef = el)}
      class="search-context-menu"
      style=${() => {
        if (!searchContextMenuVisible()) return "display:none";
        return searchContextMenuStyle();
      }}
    >
      <button
        id="searchContextSaveButton"
        class="search-context-menu-item"
        type="button"
        onClick=${handleSearchContextSave}
      >
        Save to gallery while streaming
      </button>
    </div>
  </div>`;
}

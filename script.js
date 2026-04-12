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
} from "./src-ui/shared.js";

const introVideo = document.getElementById("introVideo");
const muteToggle = document.getElementById("muteToggle");
const playButton = document.getElementById("heroPlay");
const infoButton = document.getElementById("heroInfo");
const heroTitle = document.getElementById("heroTitle");
const pageRoot = document.querySelector(".page");
const continueRow = document.getElementById("continueRow");
const continueCardsContainer = document.getElementById("continueCards");
const continueEmpty = document.getElementById("continueEmpty");
const cardsContainer = document.getElementById("cardsContainer");
const myListNavLink = document.getElementById("navMyList");
const myListRow = document.getElementById("myListRow");
const myListCardsContainer = document.getElementById("myListCards");
const myListEmpty = document.getElementById("myListEmpty");
const popularRow = document.getElementById("popularRow");
const popularRowTitle = document.getElementById("popularRowTitle");
const accountMenu = document.getElementById("accountMenu");
const accountMenuToggle = document.getElementById("accountMenuToggle");
const accountMenuPanel = document.getElementById("accountMenuPanel");
const accountAvatarButton = document.getElementById("accountAvatarButton");
const accountAvatar = document.getElementById("accountAvatar");
const openSearchButton = document.getElementById("openSearchButton");
const closeSearchButton = document.getElementById("closeSearchButton");
const navSearchBox = document.getElementById("navSearchBox");
const navSearchInput = document.getElementById("navSearchInput");
const searchExperience = document.getElementById("searchExperience");
const searchStatus = document.getElementById("searchStatus");
const searchExplore = document.getElementById("searchExplore");
const searchExploreLinks = document.getElementById("searchExploreLinks");
const searchResultsGrid = document.getElementById("searchResultsGrid");
const searchContextMenu = document.getElementById("searchContextMenu");
const searchContextSaveButton = document.getElementById(
  "searchContextSaveButton",
);
const detailsModal = document.getElementById("detailsModal");
const detailsCloseButton = document.getElementById("detailsClose");
const detailsPlayButton = document.getElementById("detailsPlay");
const detailsMyListButton = document.getElementById("detailsMyList");
const detailsImage = document.getElementById("detailsImage");
const detailsTitle = document.getElementById("detailsTitle");
const detailsYear = document.getElementById("detailsYear");
const detailsRuntime = document.getElementById("detailsRuntime");
const detailsMaturity = document.getElementById("detailsMaturity");
const detailsQuality = document.getElementById("detailsQuality");
const detailsAudio = document.getElementById("detailsAudio");
const detailsDescription = document.getElementById("detailsDescription");
const detailsCast = document.getElementById("detailsCast");
const detailsGenres = document.getElementById("detailsGenres");
const detailsVibe = document.getElementById("detailsVibe");
const detailsMoreSection = document.getElementById("detailsMoreSection");
const detailsMoreGrid = document.getElementById("detailsMoreGrid");
const libraryEditModal = document.getElementById("libraryEditModal");
const libraryEditCloseButton = document.getElementById("libraryEditClose");
const libraryEditModalTitle = document.getElementById("libraryEditModalTitle");
const libraryEditModalMeta = document.getElementById("libraryEditModalMeta");
const libraryEditFields = document.getElementById("libraryEditFields");
const libraryAddEpisodeBtn = document.getElementById("libraryAddEpisodeBtn");
const librarySaveBtn = document.getElementById("librarySaveBtn");
const libraryDeleteBtn = document.getElementById("libraryDeleteBtn");
const libraryEditModalStatus = document.getElementById("libraryEditModalStatus");

let activeDetails = null;
let detailsTrigger = null;
let closeModalTimer = null;
let detailsRequestVersion = 0;
let isSearchModeActive = false;
let searchDebounceTimer = null;
let activeSearchRequestToken = 0;
let searchAbortController = null;
let searchContextTarget = null;
let searchBoxHideTimer = null;
let libraryEditModalCloseTimer = null;
let activeLibraryEditContext = null;
let isSavingLibraryEdit = false;
let activeLibraryEditCategory = "title";

const tmdbDetailsCache = new Map();
const TMDB_DETAILS_CACHE_MAX = 200;

function setTmdbDetailsCache(key, value) {
  tmdbDetailsCache.delete(key); // move to end (most recent)
  if (tmdbDetailsCache.size >= TMDB_DETAILS_CACHE_MAX) {
    const firstKey = tmdbDetailsCache.keys().next().value;
    tmdbDetailsCache.delete(firstKey);
  }
  tmdbDetailsCache.set(key, value);
}

const SEARCH_DEBOUNCE_MS = 280;
const SEARCH_MIN_QUERY_LENGTH = 2;
const SEARCH_RESULTS_LIMIT = 40;
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";
const AUDIO_LANG_PREF_KEY_PREFIX = "netflix-audio-lang:movie:";
const SUBTITLE_LANG_PREF_KEY_PREFIX = "netflix-subtitle-lang:movie:";
const SUBTITLE_STREAM_PREF_KEY_PREFIX = "netflix-subtitle-stream:movie:";
const HERO_TRAILER_MUTED_PREF_KEY = "netflix-hero-trailer-muted-v2";
const RESUME_STORAGE_PREFIX = "netflix-resume:";
const CONTINUE_WATCHING_META_KEY = "netflix-continue-watching-meta";
const DEFAULT_STREAM_QUALITY_PREFERENCE = "1080p";
const MY_LIST_STORAGE_KEY = "netflix-my-list-v1";
const JEFFREY_EPSTEIN_SERIES_ID = "jeffrey-epstein-filthy-rich";
const JEFFREY_EPSTEIN_EPISODE_1_SOURCE =
  "assets/videos/jeffrey-epstein-filthy-rich-s01e01-2160p-hevc.mp4";
const BREAKING_BAD_SERIES_ID = "breaking-bad";
const PRIDE_PREJUDICE_SOURCE =
  "assets/videos/Pride.Prejudice.2005.2160p.4K.WEB.x265.10bit.AAC5.1-[YTS.MX].mp4";
const PRIDE_PREJUDICE_THUMBNAIL = "assets/images/pride-prejudice-thumb.jpg";
const DEFAULT_LOCAL_THUMBNAIL = "assets/images/thumbnail.jpg";
const HIDDEN_LOCAL_SERIES_TMDB_IDS = new Set(["103506", "1396"]);
const supportedAudioLangs = new Set(["auto", "en", "fr", "es", "de"]);

function getStoredHeroTrailerMutedPreference() {
  try {
    const rawValue = String(
      localStorage.getItem(HERO_TRAILER_MUTED_PREF_KEY) || "",
    )
      .trim()
      .toLowerCase();
    if (
      rawValue === "true" ||
      rawValue === "1" ||
      rawValue === "yes" ||
      rawValue === "on"
    ) {
      return true;
    }
    if (
      rawValue === "false" ||
      rawValue === "0" ||
      rawValue === "no" ||
      rawValue === "off"
    ) {
      return false;
    }
  } catch {
    // Ignore localStorage failures.
  }
  // Default to sound on unless user explicitly muted.
  return false;
}

function setStoredHeroTrailerMutedPreference(isMuted) {
  try {
    localStorage.setItem(
      HERO_TRAILER_MUTED_PREF_KEY,
      isMuted ? "true" : "false",
    );
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

function isLikelyLocalMediaSource(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.startsWith("/media/") ||
    normalized.includes("/media/") ||
    normalized.startsWith("/videos/") ||
    normalized.startsWith("videos/") ||
    normalized.includes("/videos/") ||
    normalized.startsWith("assets/videos/") ||
    normalized.includes("/assets/videos/")
  );
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

function openLibraryEditTarget(card) {
  const target = getLibraryEditTargetFromCard(card);
  if (!target) {
    return;
  }
  void openLibraryEditModalForTarget(target);
}

function syncBodyModalLock() {
  const hasDetailsModalOpen = Boolean(detailsModal && !detailsModal.hidden);
  const hasLibraryEditModalOpen = Boolean(
    libraryEditModal && !libraryEditModal.hidden,
  );
  document.body.classList.toggle(
    "modal-open",
    hasDetailsModalOpen || hasLibraryEditModalOpen,
  );
}

function setLibraryEditModalStatus(message, tone = "") {
  if (!libraryEditModalStatus) {
    return;
  }
  libraryEditModalStatus.textContent = String(message || "");
  libraryEditModalStatus.classList.remove("status-success", "status-error");
  if (tone === "success") {
    libraryEditModalStatus.classList.add("status-success");
  } else if (tone === "error") {
    libraryEditModalStatus.classList.add("status-error");
  }
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

function renderLibraryEditMovieFields(item = {}) {
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

function renderLibraryEditSeriesEpisode(episode = {}, index = 0, contentKind = "series") {
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

function renderLibraryEditSeriesFields(item = {}) {
  const contentKind = normalizeLibrarySeriesContentKind(item?.contentKind || "");
  const episodes = Array.isArray(item?.episodes) ? item.episodes : [];
  const activeCategory = normalizeLibraryEditCategory(
    "series",
    activeLibraryEditCategory,
  );
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
            renderLibraryEditSeriesEpisode(episode, index, contentKind),
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

function renderLibraryEditModalFields() {
  if (!libraryEditFields || !activeLibraryEditContext) {
    return;
  }
  const { library, itemType, itemIndex } = activeLibraryEditContext;
  const list = itemType === "movie" ? library.movies : library.series;
  const item = list[itemIndex];
  if (!item) {
    libraryEditFields.innerHTML = "";
    return;
  }
  activeLibraryEditCategory = normalizeLibraryEditCategory(
    itemType,
    activeLibraryEditCategory,
  );

  const title = String(item?.title || "Untitled").trim() || "Untitled";
  if (libraryEditModalTitle) {
    libraryEditModalTitle.textContent = title;
  }
  if (libraryEditModalMeta) {
    if (itemType === "movie") {
      const year = String(item?.year || "").trim() || "Local";
      libraryEditModalMeta.textContent = `Movie • ${year}`;
    } else {
      const contentLabel =
        normalizeLibrarySeriesContentKind(item?.contentKind || "") === "course"
          ? "Course"
          : "Series";
      const episodeCount = Array.isArray(item?.episodes) ? item.episodes.length : 0;
      libraryEditModalMeta.textContent = `${contentLabel} • ${episodeCount} episode${episodeCount === 1 ? "" : "s"}`;
    }
  }
  if (libraryAddEpisodeBtn) {
    const isUploadOnlyView =
      itemType === "series" && activeLibraryEditCategory === "upload";
    libraryAddEpisodeBtn.hidden = itemType !== "series" || isUploadOnlyView;
    if (itemType === "series") {
      const contentKind = normalizeLibrarySeriesContentKind(item?.contentKind || "");
      libraryAddEpisodeBtn.textContent =
        contentKind === "course" ? "Upload Lesson" : "Upload Episode";
    } else {
      libraryAddEpisodeBtn.textContent = "Add Episode";
    }
  }
  if (librarySaveBtn) {
    librarySaveBtn.hidden =
      itemType === "series" && activeLibraryEditCategory === "upload";
  }
  if (libraryDeleteBtn) {
    libraryDeleteBtn.hidden =
      itemType === "series" && activeLibraryEditCategory === "upload";
  }

  libraryEditFields.innerHTML =
    itemType === "movie"
      ? renderLibraryEditMovieFields(item)
      : renderLibraryEditSeriesFields(item);
}

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
  window.location.href = `/upload?${params.toString()}`;
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

function collectLibraryEditedMovie() {
  if (!libraryEditFields) {
    throw new Error("Editor form is unavailable.");
  }
  const title = readRequiredLibraryInput(
    libraryEditFields,
    'input[data-field="title"]',
    "Title is required.",
  );
  const src = readRequiredLibraryInput(
    libraryEditFields,
    'input[data-field="src"]',
    "Source path is required.",
  );
  return {
    ...activeLibraryEditContext.library.movies[activeLibraryEditContext.itemIndex],
    title,
    src,
    year: String(
      libraryEditFields.querySelector('input[data-field="year"]')?.value || "",
    ).trim(),
    tmdbId: String(
      libraryEditFields.querySelector('input[data-field="tmdbId"]')?.value || "",
    ).trim(),
    thumb: String(
      libraryEditFields.querySelector('input[data-field="thumb"]')?.value || "",
    ).trim(),
    description: String(
      libraryEditFields.querySelector('textarea[data-field="description"]')
        ?.value || "",
    ).trim(),
  };
}

function collectLibraryEditedSeries() {
  if (!libraryEditFields) {
    throw new Error("Editor form is unavailable.");
  }
  const currentSeries =
    activeLibraryEditContext.library.series[activeLibraryEditContext.itemIndex];
  const titleInput = libraryEditFields.querySelector('input[data-field="title"]');
  const title = titleInput
    ? readRequiredLibraryInput(
        libraryEditFields,
        'input[data-field="title"]',
        "Title is required.",
      )
    : String(currentSeries?.title || "").trim() || "Untitled Series";
  const typeSelect = libraryEditFields.querySelector('select[data-field="contentKind"]');
  const contentKind = normalizeLibrarySeriesContentKind(
    (typeSelect instanceof HTMLSelectElement
      ? typeSelect.value
      : currentSeries?.contentKind) || "series",
  );
  const episodeNodes = Array.from(
    libraryEditFields.querySelectorAll(".library-edit-episode"),
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
      libraryEditFields.querySelector('input[data-field="tmdbId"]')?.value ||
        currentSeries?.tmdbId ||
        "",
    ).trim(),
    year: String(
      libraryEditFields.querySelector('input[data-field="year"]')?.value ||
        currentSeries?.year ||
        "",
    ).trim(),
    episodes,
  };
}

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

function closeLibraryEditModal() {
  if (!libraryEditModal || libraryEditModal.hidden) {
    return;
  }
  libraryEditModal.classList.remove("is-open");
  if (libraryEditModalCloseTimer) {
    clearTimeout(libraryEditModalCloseTimer);
  }
  libraryEditModalCloseTimer = window.setTimeout(() => {
    libraryEditModal.hidden = true;
    syncBodyModalLock();
    libraryEditModalCloseTimer = null;
    activeLibraryEditContext = null;
    activeLibraryEditCategory = "title";
    if (libraryEditFields) {
      libraryEditFields.innerHTML = "";
    }
    setLibraryEditModalStatus("");
    if (pageRoot) {
      pageRoot.focus({ preventScroll: true });
    }
  }, 170);
}

function showLibraryEditModal() {
  if (!libraryEditModal) {
    return;
  }
  if (libraryEditModalCloseTimer) {
    clearTimeout(libraryEditModalCloseTimer);
    libraryEditModalCloseTimer = null;
  }
  libraryEditModal.hidden = false;
  requestAnimationFrame(() => {
    libraryEditModal.classList.add("is-open");
  });
  syncBodyModalLock();
}

async function openLibraryEditModalForTarget(target) {
  if (!target || !libraryEditModal) {
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
    if (libraryEditFields) {
      libraryEditFields.innerHTML = "";
    }
    setLibraryEditModalStatus(
      error instanceof Error ? error.message : "Could not open editor.",
      "error",
    );
  }
}

function applyStoredHeroTrailerAudioPreference() {
  if (!(introVideo instanceof HTMLVideoElement)) {
    return;
  }
  const preferredMuted = getStoredHeroTrailerMutedPreference();
  introVideo.muted = preferredMuted;
  if (!introVideo.paused) {
    return;
  }

  void introVideo.play().catch(() => {
    // Ignore autoplay failures (e.g. sound autoplay restrictions) but keep
    // the preferred mute state unchanged.
  });
}

function applyAccountAvatarStyle({
  style = getStoredAvatarStylePreference(),
  mode = getStoredAvatarModePreference(),
  imageData = getStoredAvatarImagePreference(),
} = {}) {
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
    // Ignore storage access issues.
  }

  return "auto";
}

function normalizeStreamQualityPreference(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return DEFAULT_STREAM_QUALITY_PREFERENCE;
  if (normalized === "4k" || normalized === "uhd") return "2160p";
  if (normalized === "2160") return "2160p";
  if (normalized === "1080") return "1080p";
  if (normalized === "720") return "720p";
  if (supportedStreamQualityPreferences.has(normalized)) {
    return normalized;
  }
  return DEFAULT_STREAM_QUALITY_PREFERENCE;
}

function getStoredStreamQualityPreference() {
  try {
    const raw = localStorage.getItem(STREAM_QUALITY_PREF_KEY);
    return normalizeStreamQualityPreference(raw);
  } catch {
    return DEFAULT_STREAM_QUALITY_PREFERENCE;
  }
}

function formatRuntime(minutes) {
  if (!minutes || Number.isNaN(minutes)) return "";
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (!hours) return `${remainingMinutes}m`;
  if (!remainingMinutes) return `${hours}h`;
  return `${hours}h ${remainingMinutes}m`;
}

function createArtworkImage(src, altText, className = "") {
  const image = document.createElement("img");
  image.src = String(src || "").trim() || DEFAULT_LOCAL_THUMBNAIL;
  image.alt = altText;
  image.loading = "lazy";
  if (className) {
    image.className = className;
  }
  return image;
}

function formatResumeTimestamp(totalSeconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function readContinueWatchingMetaMap() {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(CONTINUE_WATCHING_META_KEY) || "{}",
    );
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function extractSeriesIdFromSourceIdentity(sourceIdentity) {
  const normalizedSource = String(sourceIdentity || "").trim();
  if (!normalizedSource) {
    return "";
  }

  const seriesMatch = /^series:([^:]+):episode:(\d+)$/i.exec(normalizedSource);
  return seriesMatch
    ? String(seriesMatch[1] || "")
        .trim()
        .toLowerCase()
    : "";
}

function parseTmdbSourceIdentity(sourceIdentity) {
  const normalizedSource = String(sourceIdentity || "").trim();
  if (!normalizedSource.toLowerCase().startsWith("tmdb:")) {
    return { tmdbId: "", mediaType: "" };
  }

  const typedMatch = /^tmdb:(movie|tv):(\d+)(?::s(\d+):e(\d+))?$/i.exec(
    normalizedSource,
  );
  if (typedMatch) {
    return {
      mediaType: String(typedMatch[1] || "")
        .trim()
        .toLowerCase(),
      tmdbId: String(typedMatch[2] || "").trim(),
    };
  }

  return { tmdbId: "", mediaType: "" };
}

function removeResumeEntriesForSource(
  sourceIdentity,
  seriesId = "",
  parsedTmdbSource = { tmdbId: "", mediaType: "" },
) {
  const normalizedSource = String(sourceIdentity || "").trim();
  if (!normalizedSource) {
    return;
  }

  const keysToDelete = new Set();
  keysToDelete.add(`${RESUME_STORAGE_PREFIX}${normalizedSource}`);

  const normalizedSeriesId = String(seriesId || "")
    .trim()
    .toLowerCase();
  if (normalizedSeriesId) {
    const seriesResumePrefix = `${RESUME_STORAGE_PREFIX}series:${normalizedSeriesId}:episode:`;
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && key.startsWith(seriesResumePrefix)) {
        keysToDelete.add(key);
      }
    }
  }

  const tmdbId = String(parsedTmdbSource?.tmdbId || "").trim();
  const mediaType = String(parsedTmdbSource?.mediaType || "")
    .trim()
    .toLowerCase();
  if (tmdbId) {
    if (mediaType === "tv") {
      const tvResumePrefix = `${RESUME_STORAGE_PREFIX}tmdb:tv:${tmdbId}`;
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (
          key &&
          (key === tvResumePrefix || key.startsWith(`${tvResumePrefix}:`))
        ) {
          keysToDelete.add(key);
        }
      }
    } else {
      keysToDelete.add(`${RESUME_STORAGE_PREFIX}tmdb:movie:${tmdbId}`);
    }
  }

  keysToDelete.forEach((key) => {
    localStorage.removeItem(key);
  });
}

function removeContinueMetaEntriesForSource(
  metaMap,
  sourceIdentity,
  seriesId = "",
  parsedTmdbSource = { tmdbId: "", mediaType: "" },
) {
  if (!metaMap || typeof metaMap !== "object") {
    return;
  }

  const normalizedSource = String(sourceIdentity || "").trim();
  const normalizedSeriesId = String(seriesId || "")
    .trim()
    .toLowerCase();
  if (normalizedSeriesId) {
    Object.keys(metaMap).forEach((key) => {
      if (extractSeriesIdFromSourceIdentity(key) === normalizedSeriesId) {
        delete metaMap[key];
      }
    });
    return;
  }

  const tmdbId = String(parsedTmdbSource?.tmdbId || "").trim();
  const mediaType = String(parsedTmdbSource?.mediaType || "")
    .trim()
    .toLowerCase();
  if (tmdbId) {
    Object.keys(metaMap).forEach((key) => {
      const parsed = parseTmdbSourceIdentity(key);
      if (String(parsed.tmdbId || "").trim() !== tmdbId) {
        return;
      }
      const parsedMediaType = String(parsed.mediaType || "")
        .trim()
        .toLowerCase();
      if (mediaType && parsedMediaType && parsedMediaType !== mediaType) {
        return;
      }
      delete metaMap[key];
    });
  }

  delete metaMap[normalizedSource];
}

function removeLocalTitleTrackPreferences(tmdbId, mediaType = "movie") {
  const normalizedTmdbId = String(tmdbId || "").trim();
  const normalizedMediaType = String(mediaType || "")
    .trim()
    .toLowerCase();
  if (normalizedMediaType === "tv" || !/^\d+$/.test(normalizedTmdbId)) {
    return;
  }
  localStorage.removeItem(`${AUDIO_LANG_PREF_KEY_PREFIX}${normalizedTmdbId}`);
  localStorage.removeItem(
    `${SUBTITLE_LANG_PREF_KEY_PREFIX}${normalizedTmdbId}`,
  );
  localStorage.removeItem(
    `${SUBTITLE_STREAM_PREF_KEY_PREFIX}${normalizedTmdbId}`,
  );
}

async function clearServerTitleMemory(tmdbId, mediaType = "movie") {
  const normalizedTmdbId = String(tmdbId || "").trim();
  const normalizedMediaType = String(mediaType || "")
    .trim()
    .toLowerCase();
  if (normalizedMediaType === "tv" || !/^\d+$/.test(normalizedTmdbId)) {
    return;
  }

  try {
    const query = new URLSearchParams({ tmdbId: normalizedTmdbId });
    await fetch(`/api/title/preferences?${query.toString()}`, {
      method: "DELETE",
    });
  } catch {
    // Best-effort server cleanup only.
  }
}

function inferContinueMediaType(
  sourceIdentity,
  explicitMediaType = "",
  explicitSeriesId = "",
) {
  const normalizedExplicitType = String(explicitMediaType || "")
    .trim()
    .toLowerCase();
  if (normalizedExplicitType === "movie" || normalizedExplicitType === "tv") {
    return normalizedExplicitType;
  }

  const seriesId =
    String(explicitSeriesId || "")
      .trim()
      .toLowerCase() || extractSeriesIdFromSourceIdentity(sourceIdentity);
  if (seriesId) {
    return "tv";
  }

  const parsedSource = parseTmdbSourceIdentity(sourceIdentity);
  if (parsedSource.mediaType === "movie" || parsedSource.mediaType === "tv") {
    return parsedSource.mediaType;
  }

  return "";
}

function normalizeLocalContinueEntry(entry) {
  const safeEntry = { ...entry };
  safeEntry.mediaType = String(safeEntry.mediaType || "")
    .trim()
    .toLowerCase();
  if (safeEntry.mediaType !== "movie" && safeEntry.mediaType !== "tv") {
    safeEntry.mediaType = "";
  }
  safeEntry.seriesId = String(safeEntry.seriesId || "").trim();
  safeEntry.episodeIndex = Number.isFinite(Number(safeEntry.episodeIndex))
    ? Math.max(0, Math.floor(Number(safeEntry.episodeIndex)))
    : -1;
  return safeEntry;
}

function removeContinueWatchingEntry(sourceIdentity) {
  const normalizedSource = String(sourceIdentity || "").trim();
  if (!normalizedSource) return;
  const normalizedSeriesId =
    extractSeriesIdFromSourceIdentity(normalizedSource);
  const parsedTmdbSource = parseTmdbSourceIdentity(normalizedSource);

  try {
    removeResumeEntriesForSource(
      normalizedSource,
      normalizedSeriesId,
      parsedTmdbSource,
    );

    const metaMap = readContinueWatchingMetaMap();
    if (metaMap && typeof metaMap === "object") {
      removeContinueMetaEntriesForSource(
        metaMap,
        normalizedSource,
        normalizedSeriesId,
        parsedTmdbSource,
      );

      const hasEntries = Object.keys(metaMap).length > 0;
      if (hasEntries) {
        localStorage.setItem(
          CONTINUE_WATCHING_META_KEY,
          JSON.stringify(metaMap),
        );
      } else {
        localStorage.removeItem(CONTINUE_WATCHING_META_KEY);
      }
    }

    removeLocalTitleTrackPreferences(
      parsedTmdbSource.tmdbId,
      parsedTmdbSource.mediaType,
    );
  } catch {
    // Ignore storage access issues.
  }

  void clearServerTitleMemory(
    parsedTmdbSource.tmdbId,
    parsedTmdbSource.mediaType,
  );
}

function getContinueWatchingEntries() {
  const entriesBySource = new Map();
  const metaMap = readContinueWatchingMetaMap();
  const dedupeKeyForSource = (sourceIdentity, explicitSeriesId = "") => {
    const normalizedSeriesId =
      String(explicitSeriesId || "")
        .trim()
        .toLowerCase() || extractSeriesIdFromSourceIdentity(sourceIdentity);
    if (normalizedSeriesId) {
      return `series:${normalizedSeriesId}`;
    }
    return String(sourceIdentity || "").trim();
  };

  Object.entries(metaMap).forEach(([sourceIdentity, value]) => {
    const normalizedSource = String(sourceIdentity || "").trim();
    if (!normalizedSource || typeof value !== "object" || value === null)
      return;

    const resumeKey = `${RESUME_STORAGE_PREFIX}${normalizedSource}`;
    const resumeSeconds = Number(localStorage.getItem(resumeKey));
    if (!Number.isFinite(resumeSeconds) || resumeSeconds < 1) {
      return;
    }

    const normalizedEntry = normalizeLocalContinueEntry({
      sourceIdentity: normalizedSource,
      resumeSeconds,
      updatedAt: Number(value.updatedAt) || 0,
      title: String(value.title || "").trim(),
      episode: String(value.episode || "").trim(),
      src: String(value.src || "").trim(),
      tmdbId:
        String(value.tmdbId || "").trim() ||
        parseTmdbSourceIdentity(normalizedSource).tmdbId,
      mediaType: inferContinueMediaType(
        normalizedSource,
        String(value.mediaType || "").trim(),
        String(value.seriesId || "").trim(),
      ),
      seriesId: String(value.seriesId || "").trim(),
      episodeIndex: Number.isFinite(Number(value.episodeIndex))
        ? Math.max(0, Math.floor(Number(value.episodeIndex)))
        : -1,
      year: String(value.year || "").trim(),
      thumb: String(value.thumb || "").trim(),
    });
    const dedupeKey = dedupeKeyForSource(
      normalizedSource,
      normalizedEntry.seriesId,
    );
    const existingEntry = entriesBySource.get(dedupeKey);
    if (
      !existingEntry ||
      Number(normalizedEntry.updatedAt || 0) >=
        Number(existingEntry.updatedAt || 0)
    ) {
      entriesBySource.set(dedupeKey, normalizedEntry);
    }
  });

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key || !key.startsWith(RESUME_STORAGE_PREFIX)) {
      continue;
    }

    const sourceIdentity = key.slice(RESUME_STORAGE_PREFIX.length).trim();
    const dedupeCandidateKey = dedupeKeyForSource(sourceIdentity);
    if (!sourceIdentity || entriesBySource.has(dedupeCandidateKey)) {
      continue;
    }

    const resumeSeconds = Number(localStorage.getItem(key));
    if (!Number.isFinite(resumeSeconds) || resumeSeconds < 1) {
      continue;
    }

    const parsedTmdbSource = parseTmdbSourceIdentity(sourceIdentity);
    const tmdbId = String(parsedTmdbSource.tmdbId || "").trim();
    const seriesMatch = /^series:([^:]+):episode:(\d+)$/i.exec(sourceIdentity);
    const inferredSeriesId = seriesMatch
      ? String(seriesMatch[1] || "").trim()
      : "";
    const inferredEpisodeIndex = seriesMatch ? Number(seriesMatch[2]) : -1;
    const normalizedEntry = normalizeLocalContinueEntry({
      sourceIdentity,
      resumeSeconds,
      updatedAt: 0,
      title: tmdbId ? "Movie" : "Continue Watching",
      episode: "",
      src: tmdbId || inferredSeriesId ? "" : sourceIdentity,
      tmdbId,
      mediaType: inferContinueMediaType(
        sourceIdentity,
        parsedTmdbSource.mediaType,
        inferredSeriesId,
      ),
      seriesId: inferredSeriesId,
      episodeIndex: Number.isFinite(inferredEpisodeIndex)
        ? Math.max(0, Math.floor(inferredEpisodeIndex))
        : -1,
      year: "",
      thumb: "",
    });
    const dedupeKey = dedupeKeyForSource(sourceIdentity, inferredSeriesId);
    const existingEntry = entriesBySource.get(dedupeKey);
    if (
      !existingEntry ||
      Number(normalizedEntry.updatedAt || 0) >=
        Number(existingEntry.updatedAt || 0)
    ) {
      entriesBySource.set(dedupeKey, normalizedEntry);
    }
  }

  return Array.from(entriesBySource.values())
    .sort((left, right) => {
      if (right.updatedAt !== left.updatedAt) {
        return right.updatedAt - left.updatedAt;
      }
      return right.resumeSeconds - left.resumeSeconds;
    })
    .slice(0, 12);
}

function normalizeLocalAssetPathForCompare(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  return normalized.replace(/^\/+/, "");
}

function enrichContinueEntriesWithLocalLibrary(entries, localLibrary) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  const movies = Array.isArray(localLibrary?.movies) ? localLibrary.movies : [];
  const seriesList = Array.isArray(localLibrary?.series) ? localLibrary.series : [];

  const localMoviesBySrc = new Map();
  movies.forEach((movie) => {
    const src = normalizeLocalAssetPathForCompare(movie?.src || "");
    if (!src) {
      return;
    }
    localMoviesBySrc.set(src, movie);
  });

  const localSeriesById = new Map();
  seriesList.forEach((series) => {
    const id = String(series?.id || "")
      .trim()
      .toLowerCase();
    if (!id) {
      return;
    }
    localSeriesById.set(id, series);
  });

  return safeEntries.map((entry) => {
    const normalizedSeriesId = String(
      entry?.seriesId || extractSeriesIdFromSourceIdentity(entry?.sourceIdentity || ""),
    )
      .trim()
      .toLowerCase();
    if (normalizedSeriesId && localSeriesById.has(normalizedSeriesId)) {
      const series = localSeriesById.get(normalizedSeriesId);
      const episodes = Array.isArray(series?.episodes) ? series.episodes : [];
      const episodeIndex = Number.isFinite(Number(entry?.episodeIndex))
        ? Math.max(0, Math.floor(Number(entry.episodeIndex)))
        : 0;
      const episodeEntry = episodes[episodeIndex] || episodes[0] || null;
      return {
        ...entry,
        mediaType: "tv",
        seriesId: String(series?.id || entry?.seriesId || "").trim(),
        title:
          String(series?.title || "").trim() ||
          String(entry?.title || "").trim(),
        year: String(series?.year || entry?.year || "").trim(),
        src: String(episodeEntry?.src || entry?.src || "").trim(),
        thumb: String(episodeEntry?.thumb || entry?.thumb || "").trim(),
      };
    }

    const tmdbId = String(entry?.tmdbId || "").trim();
    const likelyLocalMovie = !tmdbId;
    if (!likelyLocalMovie) {
      return entry;
    }

    const sourceCandidates = [
      normalizeLocalAssetPathForCompare(entry?.src || ""),
      normalizeLocalAssetPathForCompare(entry?.sourceIdentity || ""),
    ].filter(Boolean);
    const localMovieMatch = sourceCandidates
      .map((candidate) => localMoviesBySrc.get(candidate))
      .find(Boolean);
    if (!localMovieMatch) {
      return entry;
    }

    return {
      ...entry,
      mediaType: "movie",
      title:
        String(localMovieMatch?.title || "").trim() ||
        String(entry?.title || "").trim(),
      year: String(localMovieMatch?.year || entry?.year || "").trim(),
      src: String(localMovieMatch?.src || entry?.src || "").trim(),
      thumb: String(localMovieMatch?.thumb || entry?.thumb || "").trim(),
    };
  });
}

function buildContinueWatchingCard(entry, tmdbDetails = null) {
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
    ? `${TMDB_IMAGE_BASE}/original${backdropPath}`
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
  const continueSeriesId = String(entry.seriesId || "").trim();
  const continueSrc = String(entry.src || "").trim();
  const continueSourceIdentity = String(entry.sourceIdentity || "").trim();
  if (continueSeriesId) {
    card.dataset.libraryType = "series";
    card.dataset.libraryId = continueSeriesId;
    if (continueSrc) {
      card.dataset.librarySrc = continueSrc;
    }
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
      <img src="${posterUrl}" alt="${safeTitle}" loading="lazy" />
      <div class="progress"><span style="width: ${progressPercent}%"></span></div>
    </div>
    <div class="card-hover">
      <img class="card-hover-image" src="${heroUrl}" alt="${safeTitle} preview" loading="lazy" />
      <div class="card-hover-body">
        <div class="card-hover-controls">
          <div class="card-hover-actions">
            <button class="hover-round hover-play" type="button" aria-label="Resume ${safeTitle}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5v17L20 12 5 3.5Z" /></svg>
            </button>
            <button class="hover-round" type="button" aria-label="Added to my list">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4.5 12.5 5 5L19.5 7.5" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
            <button class="hover-round hover-remove" type="button" aria-label="Remove ${safeTitle} from continue watching">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke-linecap="round" /></svg>
            </button>
            <button class="hover-round" type="button" aria-label="Rate thumbs up">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 20H5.8A1.8 1.8 0 0 1 4 18.2V10a1.8 1.8 0 0 1 1.8-1.8H8V20Zm2 0h6a3.5 3.5 0 0 0 3.4-2.8l.8-4A2.5 2.5 0 0 0 17.75 10H14V6.6A2.6 2.6 0 0 0 11.4 4L10 9.3V20Z" /></svg>
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

function getFallbackThumbnailForSource(sourceValue) {
  const normalizedSource = normalizeLocalAssetPathForCompare(sourceValue || "");
  if (!normalizedSource) {
    return "";
  }
  const normalizedPrideSource = normalizeLocalAssetPathForCompare(
    PRIDE_PREJUDICE_SOURCE,
  );
  if (
    normalizedSource === normalizedPrideSource ||
    /pride[-._ ]?prejudice/i.test(normalizedSource)
  ) {
    return PRIDE_PREJUDICE_THUMBNAIL;
  }
  return "";
}

function normalizeArtworkPath(value, fallbackValue = DEFAULT_LOCAL_THUMBNAIL) {
  const raw = String(value || "").trim();
  const fallback = String(fallbackValue || DEFAULT_LOCAL_THUMBNAIL).trim() || DEFAULT_LOCAL_THUMBNAIL;
  const candidate = raw || fallback;
  if (!candidate) {
    return `/${DEFAULT_LOCAL_THUMBNAIL}`;
  }
  if (/^(https?:)?\/\//i.test(candidate) || candidate.startsWith("/")) {
    return candidate;
  }
  if (candidate.startsWith("assets/")) {
    return `/${candidate}`;
  }
  return candidate;
}

function normalizeLocalMovieDisplayTitle(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "Uploaded Movie";
  }

  const deTagged = raw
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[._]+/g, " ");
  const trimmedToYear = deTagged.split(/\b(19|20)\d{2}\b/)[0] || deTagged;
  const stripped = trimmedToYear
    .replace(
      /\b(2160p|1080p|720p|4k|web[- ]?dl|web|bluray|bdrip|bdremux|remux|x264|x265|h\.?264|h\.?265|hevc|hdr|10bit|aac(?:5\.1)?|ddp?\d\.\d|yts|mx)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();

  return stripped || raw;
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

function setSearchStatus(message, tone = "") {
  if (!searchStatus) {
    return;
  }
  searchStatus.textContent = String(message || "");
  searchStatus.classList.remove("is-error", "is-success");
  if (tone === "error") {
    searchStatus.classList.add("is-error");
    return;
  }
  if (tone === "success") {
    searchStatus.classList.add("is-success");
  }
}

function hideSearchContextMenu() {
  if (!searchContextMenu) {
    return;
  }
  searchContextTarget = null;
  searchContextMenu.hidden = true;
}

function openSearchContextMenu(event, details) {
  if (!searchContextMenu) {
    return;
  }
  const payload = details && typeof details === "object" ? details : null;
  if (!payload) {
    return;
  }
  event.preventDefault();
  searchContextTarget = payload;
  searchContextMenu.hidden = false;

  const margin = 10;
  const menuRect = searchContextMenu.getBoundingClientRect();
  const maxLeft = Math.max(margin, window.innerWidth - menuRect.width - margin);
  const maxTop = Math.max(margin, window.innerHeight - menuRect.height - margin);
  const left = Math.max(margin, Math.min(event.clientX, maxLeft));
  const top = Math.max(margin, Math.min(event.clientY, maxTop));
  searchContextMenu.style.left = `${left}px`;
  searchContextMenu.style.top = `${top}px`;
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

function buildSearchResultCard(item, imageBase = TMDB_IMAGE_BASE) {
  const details = createSearchResultDetails(item, imageBase);
  const safeTitle = String(details.title || "").trim() || "Untitled";

  const card = document.createElement("article");
  card.className = "search-result-card";
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `Play ${details.title}`);
  card.appendChild(createArtworkImage(details.thumb, safeTitle));
  const title = document.createElement("p");
  title.className = "search-result-card-title";
  title.textContent = safeTitle;
  card.appendChild(title);

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

  return card;
}

function clearSearchResults() {
  if (searchResultsGrid) {
    searchResultsGrid.innerHTML = "";
  }
  if (searchExplore) {
    searchExplore.hidden = true;
  }
  if (searchExploreLinks) {
    searchExploreLinks.innerHTML = "";
  }
}

function renderSearchExploreSuggestions(results) {
  if (!searchExplore || !searchExploreLinks) {
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
    searchExplore.hidden = true;
    searchExploreLinks.innerHTML = "";
    return;
  }

  searchExploreLinks.innerHTML = suggestions
    .map(
      (value) =>
        `<a class="search-explore-link" href="#" data-search-query="${escapeHtml(value)}">${escapeHtml(value)}</a>`,
    )
    .join("");
  searchExplore.hidden = false;
}

function renderSearchResults(results, rawQuery, imageBase = TMDB_IMAGE_BASE) {
  if (!searchResultsGrid) {
    return;
  }
  const list = Array.isArray(results) ? results : [];
  searchResultsGrid.innerHTML = "";
  renderSearchExploreSuggestions(list);
  const safeQuery = normalizeSearchQuery(rawQuery);

  if (!list.length) {
    setSearchStatus(`No results for "${safeQuery}".`, "error");
    return;
  }

  const fragment = document.createDocumentFragment();
  list.forEach((item) => {
    fragment.appendChild(buildSearchResultCard(item, imageBase));
  });
  searchResultsGrid.appendChild(fragment);
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

  // Abort any in-flight search request
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
  if (!(navSearchInput instanceof HTMLInputElement)) {
    return;
  }
  if (!isSearchModeActive) {
    openSearchMode({ focusInput: false });
  }
  if (!isSearchModeActive) {
    return;
  }

  if (immediate) {
    void runTmdbSearch(navSearchInput.value);
    return;
  }

  searchDebounceTimer = window.setTimeout(() => {
    searchDebounceTimer = null;
    void runTmdbSearch(navSearchInput.value);
  }, SEARCH_DEBOUNCE_MS);
}

function openSearchMode({ focusInput = true } = {}) {
  if (!searchExperience || !navSearchBox || !openSearchButton) {
    return;
  }
  if (searchBoxHideTimer) {
    clearTimeout(searchBoxHideTimer);
    searchBoxHideTimer = null;
  }
  isSearchModeActive = true;
  hideSearchContextMenu();
  document.body.classList.add("is-search-mode");
  searchExperience.hidden = false;
  navSearchBox.hidden = false;
  openSearchButton.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => {
    navSearchBox.classList.add("is-open");
  });

  if (focusInput && navSearchInput instanceof HTMLInputElement) {
    requestAnimationFrame(() => {
      navSearchInput.focus({ preventScroll: true });
      navSearchInput.select();
    });
  }

  if (navSearchInput instanceof HTMLInputElement && navSearchInput.value.trim()) {
    scheduleTmdbSearchFromInput({ immediate: true });
    return;
  }

  clearSearchResults();
  setSearchStatus("Start typing to search TMDB titles.");
}

function closeSearchMode({ clearInput = true } = {}) {
  isSearchModeActive = false;
  hideSearchContextMenu();
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }
  activeSearchRequestToken += 1;
  document.body.classList.remove("is-search-mode");
  if (searchExperience) {
    searchExperience.hidden = true;
  }
  if (navSearchBox) {
    navSearchBox.classList.remove("is-open");
    if (searchBoxHideTimer) {
      clearTimeout(searchBoxHideTimer);
    }
    searchBoxHideTimer = window.setTimeout(() => {
      navSearchBox.hidden = true;
      searchBoxHideTimer = null;
    }, 220);
  }
  openSearchButton?.setAttribute("aria-expanded", "false");
  if (clearInput && navSearchInput instanceof HTMLInputElement) {
    navSearchInput.value = "";
  }
  clearSearchResults();
  setSearchStatus("Start typing to search TMDB titles.");
}

function buildCardFromTmdb(item, genreMap, imageBase = TMDB_IMAGE_BASE) {
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

  const card = document.createElement("article");
  card.className = "card";
  card.tabIndex = 0;
  card.dataset.title = title;
  card.dataset.episode = year || "";
  card.dataset.src = "";
  card.dataset.thumb = heroUrl;
  card.dataset.year = year;
  card.dataset.runtime = "Movie";
  card.dataset.maturity = maturity;
  card.dataset.quality = "HD";
  card.dataset.audio = "Stereo";
  card.dataset.description = item.overview || "No description available.";
  card.dataset.cast = "Loading cast...";
  card.dataset.genres = genreNames.length
    ? genreNames.join(", ")
    : "Popular title";
  card.dataset.vibe = "Trending, Popular, High-energy";
  card.dataset.tmdbId = String(item.id);
  card.dataset.mediaType = "movie";

  card.innerHTML = `
    <div class="card-base">
      <img src="${posterUrl}" alt="${safeTitle}" loading="lazy" />
      <div class="progress"><span style="width: ${Math.max(10, Math.min(96, Math.round(item.vote_average * 10)))}%"></span></div>
    </div>
    <div class="card-hover">
      <img class="card-hover-image" src="${heroUrl}" alt="${safeTitle} preview" loading="lazy" />
      <div class="card-hover-body">
        <div class="card-hover-controls">
          <div class="card-hover-actions">
            <button class="hover-round hover-play" type="button" aria-label="Play ${safeTitle}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5v17L20 12 5 3.5Z" /></svg>
            </button>
            <button class="hover-round" type="button" aria-label="Added to my list">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4.5 12.5 5 5L19.5 7.5" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
            <button class="hover-round" type="button" aria-label="Remove from continue watching">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke-linecap="round" /></svg>
            </button>
            <button class="hover-round" type="button" aria-label="Rate thumbs up">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 20H5.8A1.8 1.8 0 0 1 4 18.2V10a1.8 1.8 0 0 1 1.8-1.8H8V20Zm2 0h6a3.5 3.5 0 0 0 3.4-2.8l.8-4A2.5 2.5 0 0 0 17.75 10H14V6.6A2.6 2.6 0 0 0 11.4 4L10 9.3V20Z" /></svg>
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
          <span class="meta-spatial">Movie</span>
        </div>
        <p class="card-hover-tags">${tagLine}</p>
      </div>
    </div>
  `;

  return card;
}

function buildCardFromTmdbSeries(item, imageBase = TMDB_IMAGE_BASE) {
  const title =
    String(item?.name || item?.title || "Untitled").trim() || "Untitled";
  const firstAirDate = String(
    item?.first_air_date || item?.release_date || "",
  ).trim();
  const year = firstAirDate ? firstAirDate.slice(0, 4) : "2008";
  const posterPath = item?.poster_path || item?.backdrop_path;
  const backdropPath = item?.backdrop_path || item?.poster_path;
  const posterUrl = posterPath
    ? `${imageBase}/w500${posterPath}`
    : "assets/images/thumbnail.jpg";
  const heroUrl = backdropPath
    ? `${imageBase}/original${backdropPath}`
    : posterUrl;
  const maturity = item?.adult ? "18" : "16+";
  const genreNames = Array.isArray(item?.genres)
    ? item.genres
        .map((genre) => String(genre?.name || "").trim())
        .filter(Boolean)
        .slice(0, 3)
    : [];
  const tagLine = genreNames.length
    ? genreNames.map(escapeHtml).join(" <span>&bull;</span> ")
    : "Crime <span>&bull;</span> Drama <span>&bull;</span> Thriller";
  const safeTitle = escapeHtml(title);

  const card = document.createElement("article");
  card.className = "card";
  card.tabIndex = 0;
  card.dataset.title = title;
  card.dataset.episode = "E1 Pilot";
  card.dataset.src = "";
  card.dataset.thumb = heroUrl;
  card.dataset.year = year;
  card.dataset.runtime = "Series";
  card.dataset.maturity = maturity;
  card.dataset.quality = "HD";
  card.dataset.audio = "Stereo";
  card.dataset.description =
    item?.overview ||
    "A high school chemistry teacher enters the meth trade and spirals into a dangerous double life.";
  card.dataset.cast = "Loading cast...";
  card.dataset.genres = genreNames.length
    ? genreNames.join(", ")
    : "Crime, Drama";
  card.dataset.vibe = "Dark, Tense, Character-driven";
  card.dataset.tmdbId = String(item?.id || "1396");
  card.dataset.mediaType = "tv";
  card.dataset.seriesId = BREAKING_BAD_SERIES_ID;
  card.dataset.episodeIndex = "0";

  card.innerHTML = `
    <div class="card-base">
      <img src="${posterUrl}" alt="${safeTitle}" loading="lazy" />
      <div class="progress"><span style="width: 96%"></span></div>
    </div>
    <div class="card-hover">
      <img class="card-hover-image" src="${heroUrl}" alt="${safeTitle} preview" loading="lazy" />
      <div class="card-hover-body">
        <div class="card-hover-controls">
          <div class="card-hover-actions">
            <button class="hover-round hover-play" type="button" aria-label="Play ${safeTitle}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5v17L20 12 5 3.5Z" /></svg>
            </button>
            <button class="hover-round" type="button" aria-label="Added to my list">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4.5 12.5 5 5L19.5 7.5" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
            <button class="hover-round" type="button" aria-label="Remove from continue watching">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke-linecap="round" /></svg>
            </button>
            <button class="hover-round" type="button" aria-label="Rate thumbs up">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 20H5.8A1.8 1.8 0 0 1 4 18.2V10a1.8 1.8 0 0 1 1.8-1.8H8V20Zm2 0h6a3.5 3.5 0 0 0 3.4-2.8l.8-4A2.5 2.5 0 0 0 17.75 10H14V6.6A2.6 2.6 0 0 0 11.4 4L10 9.3V20Z" /></svg>
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
          <span class="meta-spatial">Series</span>
        </div>
        <p class="card-hover-tags">${tagLine}</p>
      </div>
    </div>
  `;

  return card;
}

function buildPridePrejudiceCard() {
  const title = "Pride & Prejudice";
  const year = "2005";
  const maturity = "13+";
  const qualityLabel = "4K";
  const posterUrl = PRIDE_PREJUDICE_THUMBNAIL;
  const heroUrl = PRIDE_PREJUDICE_THUMBNAIL;
  const safeTitle = escapeHtml(title);
  const tagLine =
    "Romance <span>&bull;</span> Period Drama <span>&bull;</span> Classic";

  const card = document.createElement("article");
  card.className = "card";
  card.tabIndex = 0;
  card.dataset.title = title;
  card.dataset.episode = year || "";
  card.dataset.src = PRIDE_PREJUDICE_SOURCE;
  card.dataset.thumb = heroUrl;
  card.dataset.year = year;
  card.dataset.runtime = "2h 9m";
  card.dataset.maturity = maturity;
  card.dataset.quality = qualityLabel;
  card.dataset.audio = "5.1";
  card.dataset.description =
    "Sparks fly when Elizabeth Bennet meets Mr. Darcy in this sweeping adaptation of Jane Austen's beloved novel.";
  card.dataset.cast = "Keira Knightley, Matthew Macfadyen, Rosamund Pike";
  card.dataset.genres = "Romance, Drama";
  card.dataset.vibe = "Romantic, Witty, Period";
  card.dataset.mediaType = "movie";

  card.innerHTML = `
    <div class="card-base">
      <img src="${posterUrl}" alt="${safeTitle}" loading="lazy" />
      <div class="progress"><span style="width: 92%"></span></div>
    </div>
    <div class="card-hover">
      <img class="card-hover-image" src="${heroUrl}" alt="${safeTitle} preview" loading="lazy" />
      <div class="card-hover-body">
        <div class="card-hover-controls">
          <div class="card-hover-actions">
            <button class="hover-round hover-play" type="button" aria-label="Play ${safeTitle}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5v17L20 12 5 3.5Z" /></svg>
            </button>
            <button class="hover-round" type="button" aria-label="Added to my list">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4.5 12.5 5 5L19.5 7.5" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
            <button class="hover-round" type="button" aria-label="Remove from continue watching">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke-linecap="round" /></svg>
            </button>
            <button class="hover-round" type="button" aria-label="Rate thumbs up">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 20H5.8A1.8 1.8 0 0 1 4 18.2V10a1.8 1.8 0 0 1 1.8-1.8H8V20Zm2 0h6a3.5 3.5 0 0 0 3.4-2.8l.8-4A2.5 2.5 0 0 0 17.75 10H14V6.6A2.6 2.6 0 0 0 11.4 4L10 9.3V20Z" /></svg>
            </button>
          </div>
          <button class="hover-round hover-details" type="button" aria-label="More details">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </button>
        </div>
        <div class="card-hover-meta">
          <span class="meta-age">${maturity}</span>
          <span>${year}</span>
          <span class="meta-chip">${qualityLabel}</span>
          <span class="meta-spatial">Movie</span>
        </div>
        <p class="card-hover-tags">${tagLine}</p>
      </div>
    </div>
  `;

  return card;
}

function buildCardFromLocalMovie(item, tmdbDetails = null) {
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
    ? `${TMDB_IMAGE_BASE}/original${tmdbBackdropPath}`
    : tmdbPosterUrl;
  const preferredThumb =
    sourceSpecificThumb &&
    (!storedThumb ||
      storedThumb === DEFAULT_LOCAL_THUMBNAIL ||
      storedThumb.endsWith("/thumbnail.jpg") ||
      storedThumb.endsWith("assets/images/thumbnail.jpg"))
      ? sourceSpecificThumb
      : storedThumb || sourceSpecificThumb || tmdbPosterUrl || DEFAULT_LOCAL_THUMBNAIL;
  const posterUrl = normalizeArtworkPath(
    preferredThumb,
  );
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
      <img src="${posterUrl}" alt="${safeTitle}" loading="lazy" />
      <div class="progress"><span style="width: 90%"></span></div>
    </div>
    <div class="card-hover">
      <img class="card-hover-image" src="${heroUrl}" alt="${safeTitle} preview" loading="lazy" />
      <div class="card-hover-body">
        <div class="card-hover-controls">
          <div class="card-hover-actions">
            <button class="hover-round hover-play" type="button" aria-label="Play ${safeTitle}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5v17L20 12 5 3.5Z" /></svg>
            </button>
            <button class="hover-round" type="button" aria-label="Added to my list">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4.5 12.5 5 5L19.5 7.5" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
            <button class="hover-round" type="button" aria-label="Remove from continue watching">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke-linecap="round" /></svg>
            </button>
            <button class="hover-round" type="button" aria-label="Rate thumbs up">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 20H5.8A1.8 1.8 0 0 1 4 18.2V10a1.8 1.8 0 0 1 1.8-1.8H8V20Zm2 0h6a3.5 3.5 0 0 0 3.4-2.8l.8-4A2.5 2.5 0 0 0 17.75 10H14V6.6A2.6 2.6 0 0 0 11.4 4L10 9.3V20Z" /></svg>
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

function buildCardFromLocalSeries(
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
    ? `${imageBase}/original${backdropPath}`
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
      <img src="${posterUrl}" alt="${safeTitle}" loading="lazy" />
      <div class="progress"><span style="width: 94%"></span></div>
    </div>
    <div class="card-hover">
      <img class="card-hover-image" src="${heroUrl}" alt="${safeTitle} preview" loading="lazy" />
      <div class="card-hover-body">
        <div class="card-hover-controls">
          <div class="card-hover-actions">
            <button class="hover-round hover-play" type="button" aria-label="Play ${safeTitle}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5v17L20 12 5 3.5Z" /></svg>
            </button>
            <button class="hover-round" type="button" aria-label="Added to my list">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4.5 12.5 5 5L19.5 7.5" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
            <button class="hover-round" type="button" aria-label="Remove from continue watching">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke-linecap="round" /></svg>
            </button>
            <button class="hover-round" type="button" aria-label="Rate thumbs up">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 20H5.8A1.8 1.8 0 0 1 4 18.2V10a1.8 1.8 0 0 1 1.8-1.8H8V20Zm2 0h6a3.5 3.5 0 0 0 3.4-2.8l.8-4A2.5 2.5 0 0 0 17.75 10H14V6.6A2.6 2.6 0 0 0 11.4 4L10 9.3V20Z" /></svg>
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

function renderPopularCards(cardsToRender) {
  cardsContainer.innerHTML = "";
  const fragment = document.createDocumentFragment();
  cardsToRender.forEach((card, index) => {
    if (index >= Math.max(1, cardsToRender.length - 2)) {
      card.classList.add("card--align-right");
    }
    fragment.appendChild(card);
    attachCardInteractions(card);
  });
  cardsContainer.appendChild(fragment);
}

async function loadPopularTitles() {
  if (!cardsContainer) return;
  const cardsToRender = [];
  const normalizeTitleKey = (value) =>
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const getLocalMovieIdentity = (item) => {
    const explicitId = String(item?.id || "").trim();
    if (explicitId) {
      return explicitId;
    }
    const tmdbId = String(item?.tmdbId || "").trim();
    if (tmdbId) {
      return `tmdb:${tmdbId}`;
    }
    const titleKey = normalizeTitleKey(item?.title || "");
    const yearKey = String(item?.year || "").trim();
    return titleKey ? `${titleKey}|${yearKey}` : "";
  };
  const getLocalSeriesIdentity = (item) => {
    const explicitId = String(item?.id || "").trim();
    if (explicitId) {
      return explicitId;
    }
    const tmdbId = String(item?.tmdbId || "").trim();
    if (tmdbId) {
      return `tmdb:${tmdbId}`;
    }
    const titleKey = normalizeTitleKey(item?.title || "");
    const yearKey = String(item?.year || "").trim();
    return titleKey ? `${titleKey}|${yearKey}` : "";
  };
  const getLocalSeriesUploadedAt = (item) =>
    Math.max(
      Number(item?.uploadedAt || 0),
      ...((Array.isArray(item?.episodes) ? item.episodes : []).map((episode) =>
        Number(episode?.uploadedAt || 0),
      )),
    );

  try {
    const localLibrary = await apiFetch("/api/library").catch(() => ({
      movies: [],
      series: [],
    }));
    const localMoviesRaw = Array.isArray(localLibrary?.movies)
      ? localLibrary.movies
      : [];
    const localMoviesMap = new Map();
    localMoviesRaw.forEach((entry) => {
      const tmdbId = String(entry?.tmdbId || "").trim();
      const titleKey = normalizeTitleKey(entry?.title || "");
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
      (left, right) => {
        const leftUploadedAt = Number(left?.uploadedAt || 0);
        const rightUploadedAt = Number(right?.uploadedAt || 0);
        return rightUploadedAt - leftUploadedAt;
      },
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

    const localEntries = [
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

    localEntries.forEach((entry) => {
      cardsToRender.push(
        entry.type === "series"
          ? buildCardFromLocalSeries(entry.item)
          : buildCardFromLocalMovie(entry.item),
      );
    });

    if (popularRowTitle) {
      popularRowTitle.textContent = cardsToRender.length
        ? "Downloaded Titles"
        : "Downloaded Titles";
    }
    if (popularRow) {
      popularRow.hidden = cardsToRender.length === 0;
    }
  } catch (error) {
    console.error("Failed to load local downloaded titles:", error);
    if (popularRow) {
      popularRow.hidden = true;
    }
  }

  renderPopularCards(cardsToRender);
  renderMyListRow();
}

async function loadContinueWatching() {
  if (!continueRow || !continueCardsContainer) {
    return;
  }

  const [entriesRaw, localLibrary] = await Promise.all([
    Promise.resolve(getContinueWatchingEntries()),
    apiFetch("/api/library").catch(() => ({ movies: [], series: [] })),
  ]);
  const entries = enrichContinueEntriesWithLocalLibrary(entriesRaw, localLibrary);
  if (!entries.length) {
    continueCardsContainer.innerHTML = "";
    if (continueEmpty) {
      continueEmpty.hidden = false;
    }
    continueRow.hidden = true;
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

  const detailsMap = new Map();
  await Promise.all(
    tmdbDetailKeys.map(async (detailKey) => {
      try {
        const separatorIndex = detailKey.indexOf(":");
        if (separatorIndex <= 0) {
          return;
        }
        const mediaType = detailKey.slice(0, separatorIndex);
        const tmdbId = detailKey.slice(separatorIndex + 1);
        const details = await apiFetch("/api/tmdb/details", {
          tmdbId,
          mediaType,
        });
        if (details && typeof details === "object") {
          detailsMap.set(detailKey, details);
        }
      } catch {
        // Best-effort enrichment only.
      }
    }),
  );

  continueCardsContainer.innerHTML = "";
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
    const card = buildContinueWatchingCard(entry, details);
    if (index >= Math.max(1, entries.length - 2)) {
      card.classList.add("card--align-right");
    }
    fragment.appendChild(card);
    attachCardInteractions(card);
  });
  continueCardsContainer.appendChild(fragment);

  continueRow.hidden = false;
  if (continueEmpty) {
    continueEmpty.hidden = true;
  }
  renderMyListRow();
}

function syncMuteUI() {
  const isMuted = introVideo.muted;
  muteToggle.classList.toggle("muted", isMuted);
  muteToggle.setAttribute(
    "aria-label",
    isMuted ? "Unmute trailer" : "Mute trailer",
  );
}

function getJeffreyEpsteinHeroDestination() {
  return {
    title: "Jeffrey Epstein: Filthy Rich",
    episode: "E1 Hunting Grounds",
    src: JEFFREY_EPSTEIN_EPISODE_1_SOURCE,
    mediaType: "tv",
    seriesId: JEFFREY_EPSTEIN_SERIES_ID,
    episodeIndex: 0,
  };
}

muteToggle.addEventListener("click", async () => {
  introVideo.muted = !introVideo.muted;
  setStoredHeroTrailerMutedPreference(introVideo.muted);
  syncMuteUI();
  if (introVideo.paused) {
    try {
      await introVideo.play();
    } catch (error) {
      // Ignore autoplay restrictions when manually unmuting.
    }
  }
});

playButton?.addEventListener("click", () => {
  openPlayerPage(getJeffreyEpsteinHeroDestination());
});

infoButton.addEventListener("click", () => {
  document
    .getElementById("continueRow")
    .scrollIntoView({ behavior: "smooth", block: "center" });
});

function openPlayerPage({
  title,
  episode,
  src,
  thumb,
  tmdbId,
  mediaType,
  year,
  seriesId,
  episodeIndex,
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
  const normalizedMediaType = String(mediaType || "")
    .trim()
    .toLowerCase();
  const normalizedSeriesId = String(seriesId || "").trim();
  const parsedEpisodeIndex = Number(episodeIndex);
  const hasEpisodeIndex =
    Number.isFinite(parsedEpisodeIndex) && parsedEpisodeIndex >= 0;
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

  if (normalizedSrc) {
    params.set("src", normalizedSrc);
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

  if (!src && tmdbId && normalizedMediaType === "movie") {
    const preferredAudioLang = getStoredAudioLangForTmdbMovie(tmdbId);
    const preferredQuality = getStoredStreamQualityPreference();
    if (preferredAudioLang !== "auto") {
      params.set("audioLang", preferredAudioLang);
    }
    if (preferredQuality !== DEFAULT_STREAM_QUALITY_PREFERENCE) {
      params.set("quality", preferredQuality);
    }
  }

  const normalizedSource = String(normalizedSrc || "")
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
  if (normalizedSrc && isUploadedLocalMedia && !params.has("audioLang")) {
    params.set("audioLang", "en");
  }

  if (!normalizedSrc && !tmdbId && !normalizedSeriesId) {
    params.set("src", JEFFREY_EPSTEIN_EPISODE_1_SOURCE);
  }

  window.location.href = `player.html?${params.toString()}`;
}

function getCardDetails(card) {
  const rawEpisodeIndex = Number(card.dataset.episodeIndex || -1);
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

function normalizeMyListEntry(entry) {
  const details = entry && typeof entry === "object" ? entry : {};
  const normalizedEpisodeIndex = Number(details.episodeIndex);
  return {
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

function setMyListButtonState(button, isActive) {
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  button.classList.toggle("is-active", Boolean(isActive));
  button.setAttribute(
    "aria-label",
    isActive ? "Remove from my list" : "Add to my list",
  );
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
  if (detailsMyListButton && activeDetails) {
    setMyListButtonState(detailsMyListButton, isMyListEntryActive(activeDetails));
  }
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

function buildMyListCard(entry) {
  const details = normalizeMyListEntry(entry);
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
  card.dataset.src = details.src;
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
            <button class="hover-round hover-my-list" type="button" aria-label="Add to my list">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4.5 12.5 5 5L19.5 7.5" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
            <button class="hover-round" type="button" aria-label="Rate thumbs up">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 20H5.8A1.8 1.8 0 0 1 4 18.2V10a1.8 1.8 0 0 1 1.8-1.8H8V20Zm2 0h6a3.5 3.5 0 0 0 3.4-2.8l.8-4A2.5 2.5 0 0 0 17.75 10H14V6.6A2.6 2.6 0 0 0 11.4 4L10 9.3V20Z" /></svg>
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
  if (!myListRow || !myListCardsContainer) {
    return;
  }

  const entries = readMyListEntries().sort(
    (left, right) => Number(right.addedAt || 0) - Number(left.addedAt || 0),
  );
  myListCardsContainer.innerHTML = "";

  if (!entries.length) {
    myListRow.hidden = true;
    if (myListEmpty) {
      myListEmpty.hidden = false;
    }
    return;
  }

  const fragment = document.createDocumentFragment();
  entries.forEach((entry, index) => {
    const card = buildMyListCard(entry);
    if (index >= Math.max(1, entries.length - 2)) {
      card.classList.add("card--align-right");
    }
    fragment.appendChild(card);
    attachCardInteractions(card);
  });
  myListCardsContainer.appendChild(fragment);
  syncAllMyListButtons();
  myListRow.hidden = false;
  if (myListEmpty) {
    myListEmpty.hidden = true;
  }
}

function renderDetailsRecommendations(currentCard) {
  if (!detailsMoreSection || !detailsMoreGrid) {
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

  detailsMoreGrid.innerHTML = "";
  detailsMoreSection.hidden = recommendations.length === 0;
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
    item.appendChild(createArtworkImage(entry.thumb, `${safeTitle} artwork`));
    const title = document.createElement("p");
    title.textContent = safeTitle;
    item.appendChild(title);

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
  detailsMoreGrid.appendChild(fragment);
}

function populateDetailsModal(details) {
  if (!detailsModal) return;

  detailsImage.src = details.thumb;
  detailsImage.alt = `${details.title} artwork`;
  detailsTitle.textContent = details.title.toUpperCase();
  detailsYear.textContent = details.year;
  detailsRuntime.textContent = details.runtime;
  detailsMaturity.textContent = details.maturity;
  detailsQuality.textContent = details.quality;
  detailsAudio.textContent = details.audio;
  detailsDescription.textContent = details.description;
  detailsCast.textContent = details.cast;
  detailsGenres.textContent = details.genres;
  detailsVibe.textContent = details.vibe;
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
    const details = await apiFetch("/api/tmdb/details", {
      tmdbId,
      mediaType,
    });

    if (
      requestVersion !== detailsRequestVersion ||
      detailsModal?.hidden ||
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
  if (!detailsModal) return;

  if (closeModalTimer) {
    clearTimeout(closeModalTimer);
    closeModalTimer = null;
  }

  activeDetails = getCardModalData(card);
  detailsTrigger = trigger || null;
  populateDetailsModal(activeDetails);
  if (detailsMyListButton) {
    setMyListButtonState(detailsMyListButton, isMyListEntryActive(activeDetails));
  }
  renderDetailsRecommendations(card);
  detailsModal.hidden = false;
  requestAnimationFrame(() => {
    detailsModal.classList.add("is-open");
  });
  syncBodyModalLock();
  detailsCloseButton?.focus({ preventScroll: true });
  hydrateModalFromTmdb(card);
}

function closeDetailsModal({ restoreFocus = true } = {}) {
  if (!detailsModal || detailsModal.hidden) return;

  detailsModal.classList.remove("is-open");

  closeModalTimer = window.setTimeout(() => {
    detailsModal.hidden = true;
    syncBodyModalLock();
    if (detailsTrigger) {
      detailsTrigger.blur();
    }
    if (restoreFocus && pageRoot) {
      pageRoot.focus({ preventScroll: true });
    }
    detailsTrigger = null;
    closeModalTimer = null;
  }, 220);
}

if (heroTitle) {
  heroTitle.style.cursor = "pointer";
  heroTitle.addEventListener("click", () =>
    openPlayerPage(getJeffreyEpsteinHeroDestination()),
  );
  heroTitle.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      openPlayerPage(getJeffreyEpsteinHeroDestination());
    }
  });
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

function attachCardInteractions(card) {
  if (!card || card.dataset.interactionsBound === "true") {
    return;
  }
  ensureCardLibraryEditButton(card);
  card.dataset.interactionsBound = "true";

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

    removeContinueWatchingEntry(resumeSource);
    void loadContinueWatching();
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

document.querySelectorAll(".card").forEach(attachCardInteractions);

openSearchButton?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (isSearchModeActive) {
    navSearchInput?.focus({ preventScroll: true });
    return;
  }
  openSearchMode();
});

closeSearchButton?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  closeSearchMode({ clearInput: false });
  pageRoot?.focus({ preventScroll: true });
});

navSearchInput?.addEventListener("input", () => {
  scheduleTmdbSearchFromInput();
});

navSearchInput?.addEventListener("focus", () => {
  if (!isSearchModeActive) {
    openSearchMode({ focusInput: false });
  }
});

navSearchInput?.addEventListener("search", () => {
  scheduleTmdbSearchFromInput({ immediate: true });
});

navSearchInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    scheduleTmdbSearchFromInput({ immediate: true });
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeSearchMode();
    pageRoot?.focus({ preventScroll: true });
  }
});

searchExploreLinks?.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("a") : null;
  if (!(link instanceof HTMLAnchorElement)) {
    return;
  }
  event.preventDefault();
  const query = normalizeSearchQuery(link.dataset.searchQuery || "");
  if (!query || !(navSearchInput instanceof HTMLInputElement)) {
    return;
  }
  navSearchInput.value = query;
  scheduleTmdbSearchFromInput({ immediate: true });
  navSearchInput.focus({ preventScroll: true });
});

searchContextSaveButton?.addEventListener("click", (event) => {
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
});

document.addEventListener("pointerdown", (event) => {
  if (!searchContextMenu || searchContextMenu.hidden) {
    return;
  }
  if (searchContextMenu.contains(event.target)) {
    return;
  }
  hideSearchContextMenu();
});

window.addEventListener("resize", () => {
  hideSearchContextMenu();
});

myListNavLink?.addEventListener("click", (event) => {
  event.preventDefault();
  if (isSearchModeActive) {
    closeSearchMode({ clearInput: false });
  }
  if (myListRow && !myListRow.hidden) {
    myListRow.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  popularRow?.scrollIntoView({ behavior: "smooth", block: "start" });
});

libraryEditFields?.addEventListener("click", (event) => {
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
});

libraryAddEpisodeBtn?.addEventListener("click", () => {
  openEpisodeUploadFlowForActiveSeries();
});

librarySaveBtn?.addEventListener("click", async () => {
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
});

libraryDeleteBtn?.addEventListener("click", async () => {
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
});

libraryEditCloseButton?.addEventListener("click", () => {
  closeLibraryEditModal();
});

detailsPlayButton?.addEventListener("click", () => {
  if (!activeDetails) return;
  openPlayerPage(activeDetails);
});

detailsMyListButton?.addEventListener("click", () => {
  if (!activeDetails) {
    return;
  }
  const isAdded = toggleMyList(activeDetails);
  setMyListButtonState(detailsMyListButton, isAdded);
  renderMyListRow();
  syncAllMyListButtons();
});

detailsCloseButton?.addEventListener("click", () => {
  closeDetailsModal();
});

detailsModal?.addEventListener("click", (event) => {
  if (event.target.closest("[data-close-modal]")) {
    closeDetailsModal();
  }
});

libraryEditModal?.addEventListener("click", (event) => {
  if (event.target.closest("[data-close-library-edit]")) {
    closeLibraryEditModal();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (searchContextMenu && !searchContextMenu.hidden) {
      hideSearchContextMenu();
      return;
    }
    if (accountMenuPanel && !accountMenuPanel.hidden) {
      closeAccountMenu();
      return;
    }
    if (detailsModal && !detailsModal.hidden) {
      closeDetailsModal();
      return;
    }
    if (libraryEditModal && !libraryEditModal.hidden) {
      closeLibraryEditModal();
      return;
    }
    if (isSearchModeActive) {
      closeSearchMode();
      pageRoot?.focus({ preventScroll: true });
    }
  }
});

function openAccountMenu() {
  if (!accountMenu || !accountMenuToggle || !accountMenuPanel) {
    return;
  }
  accountMenu.setAttribute("aria-expanded", "true");
  accountMenuToggle.setAttribute("aria-expanded", "true");
  accountAvatarButton?.setAttribute("aria-expanded", "true");
  accountMenuPanel.hidden = false;
}

function closeAccountMenu() {
  if (!accountMenu || !accountMenuToggle || !accountMenuPanel) {
    return;
  }
  accountMenu.setAttribute("aria-expanded", "false");
  accountMenuToggle.setAttribute("aria-expanded", "false");
  accountAvatarButton?.setAttribute("aria-expanded", "false");
  accountMenuPanel.hidden = true;
}

function handleAccountMenuToggle(event) {
  event.preventDefault();
  event.stopPropagation();
  const shouldOpen = accountMenuPanel?.hidden !== false;
  if (shouldOpen) {
    openAccountMenu();
    return;
  }
  closeAccountMenu();
}

accountMenuToggle?.addEventListener("click", handleAccountMenuToggle);
accountAvatarButton?.addEventListener("click", handleAccountMenuToggle);

document.addEventListener("pointerdown", (event) => {
  if (!accountMenu || accountMenuPanel?.hidden !== false) {
    return;
  }

  if (accountMenu.contains(event.target)) {
    return;
  }

  closeAccountMenu();
});

applyStoredHeroTrailerAudioPreference();
syncMuteUI();
applyLibraryEditModeClass();
renderMyListRow();
void loadContinueWatching();
loadPopularTitles();
applyAccountAvatarStyle();
closeAccountMenu();

const initialSearchQuery = normalizeSearchQuery(
  new URLSearchParams(window.location.search).get("q") || "",
);
const shouldRestoreSearchMode = Boolean(
  initialSearchQuery ||
    (navSearchBox &&
      !navSearchBox.hidden &&
      navSearchBox.classList.contains("is-open")),
);
if (shouldRestoreSearchMode && navSearchInput instanceof HTMLInputElement) {
  navSearchInput.value = initialSearchQuery;
  openSearchMode({ focusInput: false });
  if (initialSearchQuery) {
    scheduleTmdbSearchFromInput({ immediate: true });
  }
} else {
  pageRoot?.focus();
}

window.addEventListener("storage", (event) => {
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

  if (event.key === HERO_TRAILER_MUTED_PREF_KEY) {
    applyStoredHeroTrailerAudioPreference();
    syncMuteUI();
  }

  if (event.key === LIBRARY_EDIT_MODE_PREF_KEY) {
    applyLibraryEditModeClass();
  }
});

window.addEventListener("pageshow", () => {
  applyLibraryEditModeClass();
});

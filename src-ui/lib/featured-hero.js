export const HERO_PREVIEW_EMBED_ORIGIN = "https://www.youtube-nocookie.com";
export const HERO_PREVIEW_MESSAGE_ORIGINS = new Set([
  HERO_PREVIEW_EMBED_ORIGIN,
  "https://www.youtube.com",
]);
export const HERO_PREVIEW_REDUCED_MOTION_QUERY =
  "(prefers-reduced-motion: reduce)";
export const FEATURED_HERO_POSTER_ROTATION_MS = 20_000;
export const FEATURED_HERO_TRAILER_LOAD_TIMEOUT_MS = 60_000;

export function normalizeYoutubeVideoKey(value) {
  const key = String(value || "").trim();
  return /^[A-Za-z0-9_-]{6,32}$/.test(key) ? key : "";
}

export function selectFeaturedHeroTrailerKey(details) {
  const videos = Array.isArray(details?.videos?.results)
    ? details.videos.results
    : [];
  const candidates = videos.filter((video) => {
    const site = String(video?.site || "").trim().toLowerCase();
    return site === "youtube" && Boolean(normalizeYoutubeVideoKey(video?.key));
  });
  if (!candidates.length) {
    return "";
  }

  const scoreVideo = (video) => {
    const type = String(video?.type || "").trim().toLowerCase();
    const name = String(video?.name || "").trim().toLowerCase();
    const language = String(video?.iso_639_1 || "").trim().toLowerCase();
    let score = 0;
    if (type === "trailer") score += 50;
    if (video?.official) score += 20;
    if (name.includes("official trailer")) score += 15;
    if (name.includes("trailer")) score += 8;
    if (type === "teaser") score += 4;
    if (language === "en") score += 3;
    return score;
  };

  const selected = [...candidates].sort(
    (left, right) => scoreVideo(right) - scoreVideo(left),
  )[0];
  return normalizeYoutubeVideoKey(selected?.key);
}

export function getFeaturedHeroAutoAdvanceDelay(feature, { reducedMotion = false } = {}) {
  return normalizeYoutubeVideoKey(feature?.trailerKey) && !reducedMotion
    ? FEATURED_HERO_TRAILER_LOAD_TIMEOUT_MS
    : FEATURED_HERO_POSTER_ROTATION_MS;
}

export function buildYoutubeTrailerEmbedUrl(key) {
  const trailerKey = normalizeYoutubeVideoKey(key);
  if (!trailerKey) {
    return "";
  }
  const params = new URLSearchParams({
    autoplay: "1",
    cc_load_policy: "0",
    controls: "0",
    disablekb: "1",
    enablejsapi: "1",
    fs: "0",
    iv_load_policy: "3",
    mute: "1",
    playsinline: "1",
    rel: "0",
  });
  try {
    params.set("origin", window.location.origin);
  } catch {
    // The embed still works without API commands in non-window test contexts.
  }
  return `${HERO_PREVIEW_EMBED_ORIGIN}/embed/${encodeURIComponent(trailerKey)}?${params.toString()}`;
}

function getFeaturedHeroDisplayTitle(feature) {
  return String(feature?.title || "Popular Movies")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function getFeaturedHeroTitleLines(feature) {
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

export function getFeaturedHeroCallouts(feature) {
  const values = Array.isArray(feature?.callouts) ? feature.callouts : [];
  return values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .slice(0, 2);
}

export const FEATURED_HERO_ROTATION_MS = 24 * 60 * 60 * 1000;
export const FEATURED_HERO_STORAGE_KEY = "streamarena-featured-hero-v2";
export const FEATURED_HERO_CANDIDATE_LIMIT = 10;
export const BLOCKED_FEATURED_HERO_TITLE_KEYS = new Set([
  "your heart will be broken",
]);

export function createDefaultFeaturedHero(unratedLabel = "Unrated") {
  return {
    title: "Popular Movies",
    tmdbId: "",
    mediaType: "movie",
    year: "",
    runtime: "Movie",
    maturity: unratedLabel,
    tagline: "Discover what everyone is watching right now.",
    description: "Current top movies from around the world.",
    poster: "assets/images/thumbnail-top10-h.jpg",
    thumb: "assets/images/thumbnail-top10-h.jpg",
    src: "",
    previewSrc: "",
    trailerKey: "",
    callouts: ["Top global movies", "Popular now"],
    ready: false,
  };
}

export function normalizeHeroTitle(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeHeroTitleKey(value) {
  return normalizeHeroTitle(value).toLowerCase();
}

export function getPopularRowTitle(payload, { popularTitlesLimit = 14 } = {}) {
  const genreMap = new Map();
  (Array.isArray(payload?.genres) ? payload.genres : []).forEach((genre) => {
    genreMap.set(genre.id, genre.name);
  });
  const genreCounts = new Map();
  (Array.isArray(payload?.results) ? payload.results : [])
    .slice(0, popularTitlesLimit)
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

export function findLocalMovieForTmdbId(localLibrary, tmdbId) {
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

export function createFeaturedHeroFromTmdbItem(
  item,
  genreMap,
  imageBase,
  localLibrary = null,
  heroPreviewMap = null,
  unratedLabel = "Unrated",
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
  const logoPath = String(item?.logo_path || "").trim();
  const logoUrl = logoPath ? `${imageBase}/w500${logoPath}` : "";
  const genreNames = (Array.isArray(item?.genre_ids) ? item.genre_ids : [])
    .map((id) => genreMap.get(id))
    .filter(Boolean)
    .slice(0, 2);
  const localMovie = findLocalMovieForTmdbId(localLibrary, tmdbId);
  const localSrc = String(localMovie?.src || "").trim();
  const previewEntry =
    heroPreviewMap instanceof Map ? heroPreviewMap.get(tmdbId) : null;
  const previewSrc = String(previewEntry?.src || "").trim();
  const maturity = String(item?.certification || "").trim() || unratedLabel;
  return {
    title,
    tmdbId,
    mediaType: "movie",
    year,
    runtime: "Movie",
    maturity,
    logoUrl,
    tagline: String(item?.tagline || "").trim(),
    description:
      String(item?.overview || "").trim() || "No description available.",
    poster,
    thumb: poster,
    src: localSrc,
    previewSrc,
    trailerKey: "",
    callouts: [
      localSrc ? "Available locally" : "Top global movie",
      genreNames.length ? genreNames.join(" / ") : "Popular now",
    ],
    ready: true,
  };
}

export function buildFeaturedHeroCandidates(
  payload,
  localLibrary = null,
  heroPreviewMap = null,
  {
    imageBase = "",
    unratedLabel = "Unrated",
    candidateLimit = FEATURED_HERO_CANDIDATE_LIMIT,
    blockedTitleKeys = BLOCKED_FEATURED_HERO_TITLE_KEYS,
  } = {},
) {
  const genreMap = new Map();
  (Array.isArray(payload?.genres) ? payload.genres : []).forEach((genre) => {
    genreMap.set(genre.id, genre.name);
  });
  const resolvedImageBase = payload?.imageBase || imageBase;
  const seenIds = new Set();
  const candidates = (Array.isArray(payload?.results) ? payload.results : [])
    .map((item) =>
      createFeaturedHeroFromTmdbItem(
        item,
        genreMap,
        resolvedImageBase,
        localLibrary,
        heroPreviewMap,
        unratedLabel,
      ),
    )
    .filter((item) => {
      if (!item.tmdbId || seenIds.has(item.tmdbId)) {
        return false;
      }
      if (blockedTitleKeys.has(normalizeHeroTitleKey(item.title))) {
        return false;
      }
      seenIds.add(item.tmdbId);
      return Boolean(item.poster && item.title);
    })
    .slice(0, candidateLimit);
  const previewCandidates = candidates.filter((item) => item.previewSrc);
  return previewCandidates.length ? previewCandidates : candidates;
}

export function readFeaturedHeroRotation(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(
      storage?.getItem(FEATURED_HERO_STORAGE_KEY) || "null",
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

export function writeFeaturedHeroRotation(
  tmdbId,
  expiresAt,
  storage = globalThis.localStorage,
) {
  try {
    storage?.setItem(
      FEATURED_HERO_STORAGE_KEY,
      JSON.stringify({ tmdbId: String(tmdbId || "").trim(), expiresAt }),
    );
  } catch {
    // Ignore storage failures; the wall-clock fallback still keeps reloads stable.
  }
}

export function selectFeaturedHeroCandidate(
  candidates,
  {
    now = Date.now(),
    storage = globalThis.localStorage,
    rotationMs = FEATURED_HERO_ROTATION_MS,
  } = {},
) {
  const validCandidates = Array.isArray(candidates) ? candidates : [];
  if (!validCandidates.length) {
    return null;
  }
  const stored = readFeaturedHeroRotation(storage);
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
  const rotationIndex = Math.floor(now / rotationMs);
  const selected = nextPool[rotationIndex % nextPool.length] || validCandidates[0];
  writeFeaturedHeroRotation(selected.tmdbId, now + rotationMs, storage);
  return selected;
}

export function getFeaturedHeroMetaItems(feature) {
  const mediaType = String(feature?.mediaType || "").trim().toLowerCase();
  const runtime = String(feature?.runtime || "").trim();
  const typeLabel =
    runtime.toLowerCase() === "course"
      ? "Course"
      : mediaType === "tv" || runtime.toLowerCase() === "series"
        ? "Series"
        : "Film";
  const genreLabel = getFeaturedHeroCallouts(feature)[1] || "";
  const year = String(feature?.year || "").trim();
  const values = [typeLabel, genreLabel, year, runtime];
  const seen = new Set();
  return values.filter((value) => {
    const normalized = String(value || "").trim();
    const key = normalized.toLowerCase();
    if (
      !normalized ||
      seen.has(key) ||
      key === "movie" ||
      key === "popular now"
    ) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

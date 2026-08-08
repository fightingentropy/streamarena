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

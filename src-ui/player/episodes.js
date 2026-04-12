/**
 * Series / episode library helpers.
 *
 * Contains the static series library data, normalisation helpers for local
 * library payloads, and the merge logic that combines static + local entries.
 * All functions are pure (no DOM or player-state references) so they can be
 * tree-shaken and unit-tested independently.
 */

export const DEFAULT_EPISODE_THUMBNAIL = "assets/images/thumbnail.jpg";

const JEFFREY_EPSTEIN_EPISODE_1_SOURCE =
  "assets/videos/jeffrey-epstein-filthy-rich-s01e01-2160p-hevc.mp4";

export const STATIC_SERIES_LIBRARY = {
  "jeffrey-epstein-filthy-rich": {
    id: "jeffrey-epstein-filthy-rich",
    title: "Jeffrey Epstein: Filthy Rich",
    tmdbId: "103506",
    year: "2020",
    preferredContainer: "mp4",
    requiresLocalEpisodeSources: true,
    episodes: [
      {
        title: "Hunting Grounds",
        description:
          'Survivors recount how Epstein abused, manipulated and silenced them as he ran a so-called molestation "pyramid scheme" out of his Palm Beach mansion.',
        thumb: "assets/images/jeffrey-epstein-s01e01-thumb.jpg",
        src: JEFFREY_EPSTEIN_EPISODE_1_SOURCE,
        seasonNumber: 1,
        episodeNumber: 1,
      },
      {
        title: "Follow the Money",
        description:
          "The survivors and journalists retrace how Epstein built influence, money and legal insulation for years.",
        thumb: "assets/images/thumbnail.jpg",
        seasonNumber: 1,
        episodeNumber: 2,
      },
      {
        title: "The Island",
        description:
          "Victims and insiders detail what happened at Epstein's private island and who enabled access.",
        thumb: "assets/images/thumbnail.jpg",
        seasonNumber: 1,
        episodeNumber: 3,
      },
      {
        title: "Finding Their Voice",
        description:
          "Women who were silenced for years step forward publicly and push for accountability.",
        thumb: "assets/images/thumbnail.jpg",
        seasonNumber: 1,
        episodeNumber: 4,
      },
    ],
  },
  "breaking-bad": {
    id: "breaking-bad",
    title: "Breaking Bad",
    tmdbId: "1396",
    year: "2008",
    episodes: [
      {
        title: "Pilot",
        description:
          "A chemistry teacher facing a life-changing diagnosis is pushed toward a dangerous new plan.",
        thumb: "assets/images/thumbnail.jpg",
        seasonNumber: 1,
        episodeNumber: 1,
      },
      {
        title: "Cat's in the Bag...",
        description:
          "Walt and Jesse scramble to cover their tracks while pressure builds at home and at work.",
        thumb: "assets/images/thumbnail.jpg",
        seasonNumber: 1,
        episodeNumber: 2,
      },
      {
        title: "...And the Bag's in the River",
        description:
          "A difficult decision tests Walt's limits as Jesse struggles with the fallout.",
        thumb: "assets/images/thumbnail.jpg",
        seasonNumber: 1,
        episodeNumber: 3,
      },
      {
        title: "Cancer Man",
        description:
          "Family tension grows as Walt keeps secrets and Jesse tries to steady his life.",
        thumb: "assets/images/thumbnail.jpg",
        seasonNumber: 1,
        episodeNumber: 4,
      },
      {
        title: "Gray Matter",
        description:
          "A job offer from Walt's past creates a conflict between pride, money and survival.",
        thumb: "assets/images/thumbnail.jpg",
        seasonNumber: 1,
        episodeNumber: 5,
      },
      {
        title: "Crazy Handful of Nothin'",
        description:
          "Walt adopts a new identity to send a message while family and law pressure increase.",
        thumb: "assets/images/thumbnail.jpg",
        seasonNumber: 1,
        episodeNumber: 6,
      },
      {
        title: "A No-Rough-Stuff-Type Deal",
        description:
          "A risky theft and a bigger distribution push leave Walt and Jesse in over their heads.",
        thumb: "assets/images/thumbnail.jpg",
        seasonNumber: 1,
        episodeNumber: 7,
      },
    ],
  },
};

/**
 * Normalise a content-kind value to either "course" or "series".
 *
 * @param {string} value
 * @param {string} [fallback="series"]
 * @returns {"course"|"series"}
 */
export function normalizeSeriesContentKind(value, fallback = "series") {
  return String(value || fallback || "")
    .trim()
    .toLowerCase() === "course"
    ? "course"
    : "series";
}

/**
 * Produce a clean, shallow copy of a single episode entry with all fields
 * normalised.
 *
 * @param {object} entry
 * @returns {object}
 */
export function cloneSeriesEpisode(entry = {}) {
  const contentKind = normalizeSeriesContentKind(entry?.contentKind);
  return {
    title: String(entry?.title || "").trim(),
    description: String(entry?.description || "").trim(),
    thumb: String(entry?.thumb || "").trim() || DEFAULT_EPISODE_THUMBNAIL,
    src: String(entry?.src || "").trim(),
    contentKind,
    seasonNumber: Math.max(1, Math.floor(Number(entry?.seasonNumber || 1))),
    episodeNumber: Math.max(1, Math.floor(Number(entry?.episodeNumber || 1))),
  };
}

/**
 * Merge a static series library with a local one, preferring local episode
 * sources where they exist.
 *
 * @param {object} staticLibrary
 * @param {object} localLibrary
 * @returns {object}
 */
export function mergeSeriesLibraries(staticLibrary = {}, localLibrary = {}) {
  const merged = {};
  const staticEntries = Object.entries(staticLibrary || {});
  const staticTmdbToSeriesId = new Map();

  staticEntries.forEach(([seriesId, series]) => {
    const tmdbId = String(series?.tmdbId || "").trim();
    const seriesContentKind = normalizeSeriesContentKind(series?.contentKind);
    if (tmdbId) {
      staticTmdbToSeriesId.set(tmdbId, seriesId);
    }
    merged[seriesId] = {
      ...series,
      contentKind: seriesContentKind,
      episodes: Array.isArray(series?.episodes)
        ? series.episodes.map((episode) =>
            cloneSeriesEpisode({
              ...episode,
              contentKind:
                episode?.contentKind || seriesContentKind || "series",
            }),
          )
        : [],
    };
  });

  const localEntries = Object.values(localLibrary || {});
  localEntries.forEach((series) => {
    const localTmdbId = String(series?.tmdbId || "").trim();
    const localSeriesContentKind = normalizeSeriesContentKind(
      series?.contentKind,
      /\bcourse\b/i.test(String(series?.id || "").trim()) ? "course" : "series",
    );
    const localId = String(series?.id || "")
      .trim()
      .toLowerCase();
    const mappedStaticId =
      localTmdbId && staticTmdbToSeriesId.has(localTmdbId)
        ? staticTmdbToSeriesId.get(localTmdbId)
        : "";
    const targetId = mappedStaticId || localId;
    if (!targetId) {
      return;
    }

    if (!merged[targetId]) {
      merged[targetId] = {
        id: targetId,
        title: String(series?.title || "Series").trim() || "Series",
        tmdbId: localTmdbId,
        year: String(series?.year || "").trim(),
        contentKind: localSeriesContentKind,
        preferredContainer: "mp4",
        requiresLocalEpisodeSources: true,
        episodes: [],
      };
    }

    const targetSeries = merged[targetId];
    const targetEpisodes = Array.isArray(targetSeries.episodes)
      ? targetSeries.episodes
      : [];
    const localEpisodes = Array.isArray(series?.episodes)
      ? series.episodes
      : [];

    localEpisodes.forEach((episode) => {
      const nextEpisode = cloneSeriesEpisode({
        ...episode,
        contentKind:
          episode?.contentKind ||
          targetSeries.contentKind ||
          localSeriesContentKind,
      });
      if (!nextEpisode.src) {
        return;
      }
      const existingIndex = targetEpisodes.findIndex(
        (entry) =>
          Number(entry?.seasonNumber || 1) === nextEpisode.seasonNumber &&
          Number(entry?.episodeNumber || 1) === nextEpisode.episodeNumber,
      );

      if (existingIndex >= 0) {
        targetEpisodes[existingIndex] = {
          ...targetEpisodes[existingIndex],
          src: nextEpisode.src,
          contentKind: nextEpisode.contentKind,
          thumb:
            String(nextEpisode.thumb || "").trim() ||
            String(targetEpisodes[existingIndex]?.thumb || "").trim() ||
            DEFAULT_EPISODE_THUMBNAIL,
          title:
            String(targetEpisodes[existingIndex]?.title || "").trim() ||
            nextEpisode.title,
          description:
            String(targetEpisodes[existingIndex]?.description || "").trim() ||
            nextEpisode.description,
        };
      } else {
        targetEpisodes.push(nextEpisode);
      }
    });

    targetEpisodes.sort((left, right) => {
      const seasonDelta =
        Number(left?.seasonNumber || 1) - Number(right?.seasonNumber || 1);
      if (seasonDelta !== 0) {
        return seasonDelta;
      }
      return (
        Number(left?.episodeNumber || 1) - Number(right?.episodeNumber || 1)
      );
    });

    targetSeries.episodes = targetEpisodes;
    targetSeries.contentKind = normalizeSeriesContentKind(
      targetSeries.contentKind || localSeriesContentKind,
      localSeriesContentKind,
    );
    targetSeries.requiresLocalEpisodeSources =
      Boolean(targetSeries.requiresLocalEpisodeSources) ||
      Boolean(series?.requiresLocalEpisodeSources);
    if (!String(targetSeries.tmdbId || "").trim() && localTmdbId) {
      targetSeries.tmdbId = localTmdbId;
    }
  });

  return merged;
}

/**
 * Normalise a raw local-library JSON payload into a keyed library object.
 *
 * @param {object} payload  The JSON body from `/api/library`.
 * @returns {object}
 */
export function normalizeLocalSeriesLibrary(payload) {
  const list = Array.isArray(payload?.series) ? payload.series : [];
  const nextLibrary = {};

  list.forEach((entry) => {
    const id = String(entry?.id || "")
      .trim()
      .toLowerCase();
    const title = String(entry?.title || "").trim();
    if (!id || !title) {
      return;
    }
    const contentKind = normalizeSeriesContentKind(
      entry?.contentKind,
      /\bcourse\b/i.test(`${id} ${title}`.trim()) ? "course" : "series",
    );
    const episodes = Array.isArray(entry?.episodes)
      ? entry.episodes
          .map((episode, index) => {
            const src = String(episode?.src || "").trim();
            if (!src) {
              return null;
            }
            const seasonNumber = Number(episode?.seasonNumber || 1);
            const episodeNumber = Number(episode?.episodeNumber || index + 1);
            const episodeContentKind = normalizeSeriesContentKind(
              episode?.contentKind,
              contentKind,
            );
            const fallbackTitlePrefix =
              episodeContentKind === "course" ? "Lesson" : "Episode";
            return {
              title:
                String(episode?.title || "").trim() ||
                `${fallbackTitlePrefix} ${index + 1}`,
              description: String(episode?.description || "").trim(),
              thumb:
                String(episode?.thumb || "").trim() ||
                DEFAULT_EPISODE_THUMBNAIL,
              src,
              contentKind: episodeContentKind,
              seasonNumber:
                Number.isFinite(seasonNumber) && seasonNumber > 0
                  ? Math.floor(seasonNumber)
                  : 1,
              episodeNumber:
                Number.isFinite(episodeNumber) && episodeNumber > 0
                  ? Math.floor(episodeNumber)
                  : index + 1,
            };
          })
          .filter(Boolean)
      : [];
    if (!episodes.length) {
      return;
    }
    episodes.sort((left, right) => {
      const seasonDelta = left.seasonNumber - right.seasonNumber;
      if (seasonDelta !== 0) {
        return seasonDelta;
      }
      return left.episodeNumber - right.episodeNumber;
    });

    nextLibrary[id] = {
      id,
      title,
      contentKind,
      tmdbId: /^\d+$/.test(String(entry?.tmdbId || "").trim())
        ? String(entry.tmdbId).trim()
        : "",
      year: String(entry?.year || "").trim(),
      preferredContainer: "mp4",
      requiresLocalEpisodeSources: true,
      episodes,
    };
  });

  return nextLibrary;
}

/**
 * Fetch the local series library from the server API.
 *
 * @returns {Promise<object>}
 */
export async function fetchLocalSeriesLibrary() {
  try {
    const response = await fetch("/api/library");
    if (!response.ok) {
      return {};
    }
    const payload = await response.json().catch(() => null);
    return normalizeLocalSeriesLibrary(payload || {});
  } catch {
    return {};
  }
}

/**
 * Determine whether episode-number prefixes (e.g. "E1") should be hidden for
 * a given series (typically courses/webinars).
 *
 * @param {object} seriesEntry
 * @returns {boolean}
 */
export function shouldHideSeriesEpisodePrefix(seriesEntry) {
  const seriesTitle = String(seriesEntry?.title || "").trim();
  const seriesId = String(seriesEntry?.id || "").trim();
  const contentKind = String(
    seriesEntry?.contentKind || seriesEntry?.episodes?.[0]?.contentKind || "",
  )
    .trim()
    .toLowerCase();
  const firstEpisodeTitle = String(seriesEntry?.episodes?.[0]?.title || "").trim();
  return (
    contentKind === "course" ||
    /\bcourse\b/i.test(seriesTitle) ||
    /\bcourse\b/i.test(seriesId) ||
    /\b(webinar|lesson|module|class)\b/i.test(firstEpisodeTitle)
  );
}

/**
 * Clean up course-style episode titles (remove boilerplate suffixes, etc.).
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeCourseEpisodeDisplayTitle(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  return raw
    .replace(/^webinar-\s*electrics\s*webinar\s*(\d+)\s*-\s*/i, "Webinar $1 - ")
    .replace(/\s+by\s+access\s+training\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build a human-readable label for a series episode (e.g. "E3 The Island" or
 * "Lesson 2").
 *
 * @param {number} index         Zero-based episode index.
 * @param {string} episodeTitle  The episode's own title.
 * @param {object} seriesEntry   The parent series object.
 * @param {number} [episodeNumber]  Override for the display ordinal.
 * @returns {string}
 */
export function getSeriesEpisodeLabel(
  index,
  episodeTitle,
  seriesEntry,
  episodeNumber = index + 1,
) {
  const safeEpisodeNumber =
    Number.isFinite(Number(episodeNumber)) && Number(episodeNumber) > 0
      ? Math.floor(Number(episodeNumber))
      : index + 1;
  const safeTitle = String(episodeTitle || "").trim();
  const isCourseEntry = shouldHideSeriesEpisodePrefix(seriesEntry);
  if (isCourseEntry) {
    const normalizedCourseTitle = normalizeCourseEpisodeDisplayTitle(safeTitle);
    return normalizedCourseTitle || `Lesson ${safeEpisodeNumber}`;
  }
  return safeTitle
    ? `E${safeEpisodeNumber} ${safeTitle}`
    : `E${safeEpisodeNumber}`;
}

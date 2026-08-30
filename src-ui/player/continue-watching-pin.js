import { CONTINUE_WATCHING_META_KEY, readContinueWatchingMetaMap } from "../shared.js";
import { normalizeSourceHash } from "./sources.js";
import { shouldIgnoreRememberedTorrentSource } from "./source-menu-tabs.js";

export function emptyRememberedTmdbSourceState() {
  return {
    sourceHash: "",
    sessionKey: "",
    resolverProvider: "",
    sourceInput: "",
    filename: "",
  };
}

export function normalizeRememberedResolverProvider(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (
    normalized === "real-debrid" ||
    normalized === "local-torrent" ||
    normalized === "external-embed"
  ) {
    return normalized;
  }
  return "";
}

export function isTorrentResolverProvider(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "real-debrid" || normalized === "local-torrent";
}

export function isRememberedIframeOnlyExternalEmbed(remembered) {
  if (remembered?.resolverProvider !== "external-embed") {
    return false;
  }
  const sourceText = `${remembered.sourceInput || ""} ${remembered.filename || ""}`
    .trim()
    .toLowerCase();
  if (
    !sourceText ||
    sourceText.includes("iframe") ||
    sourceText.includes("live-iframe:")
  ) {
    return true;
  }
  return !(
    sourceText.includes("player.videasy.net") ||
    sourceText.includes("vidlink.pro")
  );
}

export function parseTmdbTvSourceIdentity(value) {
  const match = /^tmdb:tv:(\d+)(?::s(\d+):e(\d+))?$/i.exec(
    String(value || "").trim(),
  );
  return match
    ? {
        tmdbId: String(match[1] || "").trim(),
        seasonNumber: Number(match[2] || 0) || 0,
        episodeNumber: Number(match[3] || 0) || 0,
      }
    : { tmdbId: "", seasonNumber: 0, episodeNumber: 0 };
}

export function getContinueWatchingSeriesKey(sourceValue, metadata = {}) {
  const seriesId = String(metadata?.seriesId || "")
    .trim()
    .toLowerCase();
  if (seriesId) {
    return `series:${seriesId}`;
  }
  const tmdbId = String(metadata?.tmdbId || "").trim();
  const mediaType = String(metadata?.mediaType || "")
    .trim()
    .toLowerCase();
  if (mediaType === "tv" && tmdbId) {
    return `tmdb:tv:${tmdbId}`;
  }
  const parsedTmdbSource = parseTmdbTvSourceIdentity(sourceValue);
  if (parsedTmdbSource.tmdbId) {
    return `tmdb:tv:${parsedTmdbSource.tmdbId}`;
  }
  const seriesMatch = /^series:([^:]+):episode:\d+$/i.exec(
    String(sourceValue || "").trim(),
  );
  return seriesMatch
    ? `series:${String(seriesMatch[1] || "")
        .trim()
        .toLowerCase()}`
    : "";
}

export function shouldIgnoreRememberedTmdbSourcePin({
  remembered,
  selectedSourceHash,
  hasDirectSourceHashParam,
  shouldResumeRememberedPlayback,
  torrentProviderEnabled,
  preferredResolverProvider,
  preferredTorrentEnabled,
}) {
  const hasRememberedPin = Boolean(
    normalizeSourceHash(selectedSourceHash) ||
      remembered.sourceHash ||
      remembered.sessionKey ||
      remembered.resolverProvider,
  );
  if (!hasRememberedPin) {
    return false;
  }
  // A source hash in the visible URL is an explicit user/deep-link choice.
  // Continue Watching is only a fallback and must never replace it, including
  // when the server entry arrives after the initial local-state hydration.
  if (hasDirectSourceHashParam) {
    return true;
  }
  if (isRememberedIframeOnlyExternalEmbed(remembered)) {
    return true;
  }
  if (isTorrentResolverProvider(remembered.resolverProvider)) {
    return shouldIgnoreRememberedTorrentSource(
      shouldResumeRememberedPlayback,
      torrentProviderEnabled,
    );
  }
  if (remembered.resolverProvider === "external-embed") return false;
  if (
    isTorrentResolverProvider(preferredResolverProvider) &&
    preferredTorrentEnabled
  ) {
    return false;
  }
  return true;
}

export function readRememberedContinueWatchingSourceState(sourceIdentity) {
  const normalizedSource = String(sourceIdentity || "").trim();
  if (!normalizedSource) {
    return emptyRememberedTmdbSourceState();
  }
  try {
    const metaMap = readContinueWatchingMetaMap();
    const entry = metaMap?.[normalizedSource];
    if (!entry || typeof entry !== "object") {
      return emptyRememberedTmdbSourceState();
    }
    return {
      sourceHash: normalizeSourceHash(entry.sourceHash || ""),
      sessionKey: String(entry.sessionKey || "").trim(),
      resolverProvider: normalizeRememberedResolverProvider(
        entry.resolverProvider,
      ),
      sourceInput: String(entry.sourceInput || "").trim(),
      filename: String(entry.filename || "").trim(),
    };
  } catch {
    return emptyRememberedTmdbSourceState();
  }
}

export function mergeRememberedServerContinueWatchingEntry(
  sourceIdentity,
  entry,
) {
  const normalizedSource = String(sourceIdentity || "").trim();
  const sourceFromEntry = String(entry?.sourceIdentity || "").trim();
  if (!normalizedSource || sourceFromEntry !== normalizedSource) {
    return false;
  }

  try {
    const metaMap = readContinueWatchingMetaMap();
    const existing =
      metaMap?.[normalizedSource] && typeof metaMap[normalizedSource] === "object"
        ? metaMap[normalizedSource]
        : {};
    const nextEntry = {
      ...existing,
      ...entry,
      sourceIdentity: normalizedSource,
      sourceHash: normalizeSourceHash(
        Object.prototype.hasOwnProperty.call(entry, "sourceHash")
          ? entry.sourceHash
          : existing.sourceHash || "",
      ),
      sessionKey: String(
        Object.prototype.hasOwnProperty.call(entry, "sessionKey")
          ? entry.sessionKey
          : existing.sessionKey || "",
      ).trim(),
      resolverProvider: normalizeRememberedResolverProvider(
        Object.prototype.hasOwnProperty.call(entry, "resolverProvider")
          ? entry.resolverProvider
          : existing.resolverProvider,
      ),
      sourceInput: String(
        Object.prototype.hasOwnProperty.call(entry, "sourceInput")
          ? entry.sourceInput
          : existing.sourceInput || "",
      ).trim(),
      filename: String(
        Object.prototype.hasOwnProperty.call(entry, "filename")
          ? entry.filename
          : existing.filename || "",
      ).trim(),
      resumeSeconds: Number(entry.resumeSeconds || existing.resumeSeconds || 0),
      updatedAt: Number(entry.updatedAt || existing.updatedAt || Date.now()),
    };
    metaMap[normalizedSource] = nextEntry;
    localStorage.setItem(CONTINUE_WATCHING_META_KEY, JSON.stringify(metaMap));
    return true;
  } catch {
    return false;
  }
}

export function writeContinueWatchingEntry(
  sourceIdentity,
  resumeSeconds,
  metadata = {},
) {
  const normalizedSource = String(sourceIdentity || "").trim();
  if (
    !normalizedSource ||
    !Number.isFinite(resumeSeconds) ||
    resumeSeconds < 1
  ) {
    return;
  }

  try {
    const metaMap = readContinueWatchingMetaMap();
    const nextSeriesKey = getContinueWatchingSeriesKey(
      normalizedSource,
      metadata,
    );
    if (nextSeriesKey) {
      Object.keys(metaMap).forEach((storedSource) => {
        if (
          storedSource !== normalizedSource &&
          getContinueWatchingSeriesKey(storedSource, metaMap[storedSource]) ===
            nextSeriesKey
        ) {
          delete metaMap[storedSource];
        }
      });
    }
    metaMap[normalizedSource] = {
      sourceIdentity: normalizedSource,
      title: metadata.title,
      episode: metadata.episode,
      src: metadata.src,
      tmdbId: metadata.tmdbId,
      mediaType: metadata.mediaType,
      seriesId: metadata.seriesId,
      episodeIndex: metadata.episodeIndex,
      seasonNumber: metadata.seasonNumber,
      episodeNumber: metadata.episodeNumber,
      year: metadata.year,
      thumb: metadata.thumb,
      sourceHash: metadata.sourceHash,
      sessionKey: metadata.sessionKey,
      resolverProvider: metadata.resolverProvider,
      sourceInput: metadata.sourceInput,
      filename: metadata.filename,
      resumeSeconds: Number(resumeSeconds),
      updatedAt: Date.now(),
    };
    localStorage.setItem(CONTINUE_WATCHING_META_KEY, JSON.stringify(metaMap));
  } catch {
    // Ignore storage access issues.
  }
}

export function removeContinueWatchingMeta(sourceIdentity) {
  const normalizedSource = String(sourceIdentity || "").trim();
  if (!normalizedSource) {
    return false;
  }

  try {
    const metaMap = readContinueWatchingMetaMap();
    if (metaMap && typeof metaMap === "object") {
      delete metaMap[normalizedSource];
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
    return true;
  } catch {
    return false;
  }
}

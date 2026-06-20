import type { Href } from "expo-router";
import { titleHref, watchHref } from "@/lib/nav";
import type { ContinueWatchingItem, MediaType } from "@/lib/streamarena";
import type { PlayRequest } from "@/video/types";

// Pull season/episode out of a TV continue-watching entry. sourceIdentity is the canonical
// resume key (tmdb:tv:<id>:s<season>:e<episode>); fall back to the display "S1 E5" label.
// Returns null when neither yields a season+episode.
export function tvSeasonEpisode(item: ContinueWatchingItem): { season: number; episode: number } | null {
  const fromId = /:s(\d+):e(\d+)\b/i.exec(item.sourceIdentity ?? "");
  if (fromId) return { season: Number(fromId[1]), episode: Number(fromId[2]) };
  const fromLabel = /\bS(\d+)\s*E(\d+)\b/i.exec(item.episode ?? "");
  if (fromLabel) return { season: Number(fromLabel[1]), episode: Number(fromLabel[2]) };
  return null;
}

function cwMediaType(item: ContinueWatchingItem): MediaType {
  return item.mediaType === "tv" ? "tv" : "movie";
}

// Resume straight into the player from a continue-watching row (these are mid-title, so
// skip the detail page). TV needs a concrete season+episode; if we can't determine one,
// fall back to the detail page rather than open a player that can't pick an episode.
// `seasonCount` (when known) lets the player roll into the next season on finish.
export function buildResumeHref(item: ContinueWatchingItem, seasonCount?: number): Href | null {
  if (!item.tmdbId) return null;
  const mediaType = cwMediaType(item);
  const extra: Record<string, string> = { mediaType };
  if (item.title) extra.title = item.title;
  if (item.year) extra.year = item.year;
  if (item.thumb) extra.poster = item.thumb;
  if (mediaType === "tv") {
    const se = tvSeasonEpisode(item);
    if (!se) return titleHref(mediaType, item.tmdbId);
    extra.seasonNumber = String(se.season);
    extra.episodeNumber = String(se.episode);
    if (seasonCount) extra.seasonCount = String(seasonCount);
  }
  return watchHref(item.tmdbId, extra);
}

// The PlayRequest a continue-watching row represents — used to key downloads (assetId =
// progressIdentity(req)) and to resolve a source for an offline export. Null without a tmdbId.
export function playRequestFromCW(item: ContinueWatchingItem): PlayRequest | null {
  if (!item.tmdbId) return null;
  const mediaType = cwMediaType(item);
  const req: PlayRequest = { tmdbId: item.tmdbId, mediaType, title: item.title, year: item.year };
  if (mediaType === "tv") {
    const se = tvSeasonEpisode(item);
    if (se) {
      req.seasonNumber = se.season;
      req.episodeNumber = se.episode;
    }
  }
  return req;
}

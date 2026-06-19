import type { PlayRequest } from "./types";

// Compute the next episode to roll into after one finishes. Advances within the season
// while episodes remain, then into the next season's first episode. Returns null for
// movies, missing season/episode, or the end of the series. When counts are unknown the
// next episode is offered optimistically (a single step) — a non-existent episode just
// fails to resolve and stops there.
export function computeNextEpisode(
  req: PlayRequest,
  episodeCount?: number,
  seasonCount?: number,
): PlayRequest | null {
  if (req.mediaType !== "tv" || req.seasonNumber == null || req.episodeNumber == null) return null;
  const season = req.seasonNumber;
  const episode = req.episodeNumber;

  if (episodeCount == null || episode < episodeCount) {
    return { ...req, seasonNumber: season, episodeNumber: episode + 1 };
  }
  if (seasonCount != null && season < seasonCount) {
    return { ...req, seasonNumber: season + 1, episodeNumber: 1 };
  }
  return null;
}

// The query params that re-launch the watch route for a (next) episode request.
export function watchParamsFor(req: PlayRequest): Record<string, string> {
  const params: Record<string, string> = { mediaType: req.mediaType };
  if (req.title) params.title = req.title;
  if (req.year) params.year = req.year;
  if (req.poster) params.poster = req.poster;
  if (req.seasonNumber != null) params.seasonNumber = String(req.seasonNumber);
  if (req.episodeNumber != null) params.episodeNumber = String(req.episodeNumber);
  return params;
}

import type { PlayRequest } from "./types";

// The continue-watching / watch-progress key. Must match the web player exactly so a
// title watched on the web resumes on mobile and vice-versa (src-ui/pages/player.js:9719):
//   movie → tmdb:movie:<id>
//   tv    → tmdb:tv:<id>:s<season>:e<episode>
export function progressIdentity(req: PlayRequest): string {
  const base = `tmdb:${req.mediaType}:${req.tmdbId}`;
  if (req.mediaType === "tv" && req.seasonNumber != null && req.episodeNumber != null) {
    return `${base}:s${req.seasonNumber}:e${req.episodeNumber}`;
  }
  return base;
}

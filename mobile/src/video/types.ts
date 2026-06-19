import type { MediaType } from "@/lib/streamarena";

// What the watch screen asks the player to play.
export type PlayRequest = {
  tmdbId: string;
  mediaType: MediaType;
  title?: string;
  year?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  // Poster/thumb to stamp onto the Continue Watching row (optional).
  poster?: string;
};

// A routed, ready-to-load video source. `isHls` distinguishes an HLS playlist (live
// edge / remux proxy / embed) from a progressive file, which affects control affordances.
export type VideoSource = {
  uri: string;
  isHls: boolean;
};

// High-level player phase for the UI. Transport (paused/buffering) is tracked
// separately so the controls can show a spinner over a loaded-but-stalled video.
export type PlayerStatus = "idle" | "resolving" | "loading" | "playing" | "paused" | "ended" | "error";

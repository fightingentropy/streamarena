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
// `engine:"vlc"` routes playback through libVLC (MobileVLCKit) instead of AVPlayer — used
// for the on-device strip-proxy stream, which AVPlayer rejects (computes dur=0 and never
// fetches segments) but libVLC's software demuxer plays cleanly.
export type VideoSource = {
  uri: string;
  isHls: boolean;
  engine?: "native" | "vlc";
};

// High-level player phase for the UI. Transport (paused/buffering) is tracked
// separately so the controls can show a spinner over a loaded-but-stalled video.
export type PlayerStatus = "idle" | "resolving" | "loading" | "playing" | "paused" | "ended" | "error";

import {
  type ContinueWatchingItem,
  deleteContinueWatching,
  postSessionProgress,
  putContinueWatching,
  putWatchProgress,
  type ResolvedSource,
  sessionKeyOf,
} from "@/lib/streamarena";
import type { PlayRequest } from "./types";

// Write progress at most this often during steady playback; pause/seek/end/unmount
// force an immediate flush regardless.
const REPORT_INTERVAL_MS = 10_000;
// Don't persist trivially-short positions (avoids junk "Continue Watching" rows).
const MIN_REPORT_SECONDS = 5;
// At/after this fraction the title counts as finished → drop it from Continue Watching.
const FINISHED_RATIO = 0.93;

export type ReportContext = {
  request: PlayRequest;
  resolved: ResolvedSource | null;
  identity: string;
  scope: string | null;
  title?: string;
  year?: string;
  poster?: string;
};

let ctx: ReportContext | null = null;
let lastFlushMs = 0;

export function beginReporting(next: ReportContext) {
  ctx = next;
  // Start the clock now so the first periodic write lands one interval into playback
  // rather than the instant we cross MIN_REPORT_SECONDS.
  lastFlushMs = Date.now();
}

export function stopReporting() {
  ctx = null;
  lastFlushMs = 0;
}

function buildContinueItem(c: ReportContext, position: number): ContinueWatchingItem {
  const isTv = c.request.mediaType === "tv" && c.request.seasonNumber != null;
  return {
    sourceIdentity: c.identity,
    title: c.title,
    tmdbId: String(c.request.tmdbId),
    mediaType: c.request.mediaType,
    year: c.year,
    episode: isTv ? `S${c.request.seasonNumber} E${c.request.episodeNumber}` : undefined,
    sourceHash: c.resolved?.sourceHash,
    sessionKey: c.resolved ? sessionKeyOf(c.resolved) : undefined,
    resolverProvider: c.resolved?.resolverProvider,
    filename: c.resolved?.filename,
    sourceInput: c.resolved?.sourceInput,
    thumb: c.poster,
    resumeSeconds: Math.floor(position),
  };
}

function flush(position: number, duration: number, finished: boolean) {
  if (!ctx) return;
  const c = ctx;
  const pos = Math.floor(position);
  // Health/telemetry ping (best-effort; swallows its own errors).
  void postSessionProgress(
    { tmdbId: c.request.tmdbId, mediaType: c.request.mediaType, sessionKey: c.resolved ? sessionKeyOf(c.resolved) : undefined },
    { positionSeconds: pos, sourceHash: c.resolved?.sourceHash, eventType: "success" },
  );
  if (finished) {
    void deleteContinueWatching(c.identity, undefined, c.scope ?? undefined).catch(() => {});
    void putWatchProgress(c.identity, 0, c.scope ?? undefined).catch(() => {});
    return;
  }
  void putWatchProgress(c.identity, pos, c.scope ?? undefined).catch(() => {});
  void putContinueWatching(buildContinueItem(c, position), c.scope ?? undefined).catch(() => {});
}

function isFinished(position: number, duration: number): boolean {
  return duration > 0 && position / duration >= FINISHED_RATIO;
}

// Called on every progress tick. Throttled; no-op when signed out or barely started.
export function reportProgress(position: number, duration: number) {
  if (!ctx || !ctx.scope || position < MIN_REPORT_SECONDS) return;
  const now = Date.now();
  if (now - lastFlushMs < REPORT_INTERVAL_MS) return;
  lastFlushMs = now;
  flush(position, duration, isFinished(position, duration));
}

// Force an immediate write (pause / seek / unmount / ended). `ended` marks finished.
export function reportNow(position: number, duration: number, ended = false) {
  if (!ctx || !ctx.scope) return;
  const finished = ended || isFinished(position, duration);
  if (!finished && position < MIN_REPORT_SECONDS) return;
  lastFlushMs = Date.now();
  flush(position, duration, finished);
}

// Report a playback failure to the session-health endpoint (drives backend source
// health). Best-effort; never throws.
export function reportPlaybackError(message?: string) {
  if (!ctx) return;
  const c = ctx;
  void postSessionProgress(
    { tmdbId: c.request.tmdbId, mediaType: c.request.mediaType, sessionKey: c.resolved ? sessionKeyOf(c.resolved) : undefined },
    { positionSeconds: 0, sourceHash: c.resolved?.sourceHash, eventType: "playback_error", lastError: message },
  );
}

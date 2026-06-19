import { resolveTitle, type ResolvedSource } from "@/lib/streamarena";
import { decideSource } from "./routing";
import { ensureStripProxy } from "./strip-proxy";
import type { PlayRequest, VideoSource } from "./types";

export type ResolveOptions = {
  audioLang?: string;
  subtitleLang?: string;
  quality?: string;
  sourceHash?: string;
  // Force a specific audio stream (re-mux). Falls back to the resolver's choice.
  audioStreamIndex?: number;
  // Ask the backend to re-discover sources (used by the error-fallback walk).
  refresh?: boolean;
  signal?: AbortSignal;
};

// Resolve a title to a concrete source and route it to a playable URI in one step.
// Keeps the resolved metadata (tracks, fallbackUrls, sessionKey) for the player layer.
export async function resolveAndRoute(
  req: PlayRequest,
  opts: ResolveOptions = {},
): Promise<{ resolved: ResolvedSource; source: VideoSource }> {
  const resolved = await resolveTitle(
    {
      tmdbId: req.tmdbId,
      mediaType: req.mediaType,
      title: req.title,
      year: req.year,
      seasonNumber: req.seasonNumber,
      episodeNumber: req.episodeNumber,
      audioLang: opts.audioLang,
      subtitleLang: opts.subtitleLang,
      quality: opts.quality,
      sourceHash: opts.sourceHash,
      refreshResolve: opts.refresh,
    },
    opts.signal,
  );
  const audioIdx = opts.audioStreamIndex ?? resolved.selectedAudioStreamIndex;
  // External-embed VOD plays through the on-device strip proxy; make sure it's listening
  // before routing so decideSource picks it up (it otherwise falls back to the transcode).
  if (/\/api\/live\//i.test(resolved.playableUrl || "")) {
    try {
      await ensureStripProxy();
    } catch {
      // Proxy failed to start — decideSource falls back to the backend transcode.
    }
  }
  const source = decideSource(resolved, audioIdx);
  return { resolved, source };
}

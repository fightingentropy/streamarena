import { resolveTitle } from "@/lib/streamarena";
import { buildSubtitleUrl } from "@/lib/streamarena";
import type { OfflineMeta, OfflineSubtitleSpec } from "@/store/offline";
import { progressIdentity } from "./identity";
import type { PlayRequest } from "./types";

// Display fields the resolver doesn't return — supplied by the screen that already
// loaded TMDB details (poster/backdrop URLs are absolute, fetched as sidecars).
export type OfflineDisplay = {
  title: string;
  year?: string;
  episodeTitle?: string;
  posterUrl?: string;
  backdropUrl?: string;
  runtimeSeconds?: number;
};

const MAX_OFFLINE_SUBTITLES = 8;

// Resolve a title to a concrete source and assemble the OfflineMeta a download needs:
// the export `input` (resolved sourceInput/playableUrl), the baked audio stream, and the
// sidecar subtitle list (text-based tracks only — image subs can't render offline). The
// audio language is fixed at download time because audio is server-muxed; a second
// language is a second download. Throws if no playable source resolves.
export async function resolveOfflineMeta(
  req: PlayRequest,
  display: OfflineDisplay,
  opts: { audioLang?: string; subtitleLang?: string; signal?: AbortSignal } = {},
): Promise<OfflineMeta> {
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
    },
    opts.signal,
  );

  // Embed sources resolve to a signed `/api/live/hls.m3u8` proxy URL in `playableUrl` (the
  // raw `sourceInput` embed is SSRF-rejected by the export); the server remuxes that HLS
  // stream to MP4. Direct (real-debrid/local) sources copy straight from their raw input.
  const playable = resolved.playableUrl || "";
  const isHlsProxy = /\/api\/live\/hls\.m3u8/.test(playable);
  const exportInput = isHlsProxy ? playable : resolved.sourceInput || playable;
  if (!exportInput) {
    throw new Error("This title has no downloadable source.");
  }

  // Subtitle sidecars build from the underlying source input (the subtitles endpoint wants
  // the raw input, not the HLS proxy); each track's own vttUrl is preferred when present.
  const subtitleInput = resolved.sourceInput || playable;
  const subtitles: OfflineSubtitleSpec[] = [];
  for (const t of resolved.tracks?.subtitleTracks ?? []) {
    if (t.isTextBased === false) continue; // image-based subs can't be sidecar VTTs
    const url = t.vttUrl || buildSubtitleUrl(subtitleInput, t.streamIndex);
    if (!url) continue;
    subtitles.push({
      lang: t.language || `track${t.streamIndex}`,
      title: t.label || t.title || (t.language ? t.language.toUpperCase() : `Track ${t.streamIndex}`),
      url,
    });
    if (subtitles.length >= MAX_OFFLINE_SUBTITLES) break;
  }

  return {
    assetId: progressIdentity(req),
    tmdbId: req.tmdbId,
    mediaType: req.mediaType,
    seasonNumber: req.seasonNumber,
    episodeNumber: req.episodeNumber,
    title: display.title,
    episodeTitle: display.episodeTitle,
    year: display.year,
    posterUrl: display.posterUrl,
    backdropUrl: display.backdropUrl,
    runtimeSeconds: display.runtimeSeconds,
    exportInput,
    audioStreamIndex: resolved.selectedAudioStreamIndex,
    sourceHash: resolved.sourceHash,
    subtitles: subtitles.length ? subtitles : undefined,
  };
}

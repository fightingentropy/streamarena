import { TextTrackType } from "react-native-video";
import { toAbsoluteApiUrl } from "@/lib/config";
import { buildSubtitleUrl, type ResolvedSource } from "@/lib/streamarena";

// A subtitle track shaped for both the <Video textTracks> prop and the picker UI.
export type PlayerTextTrack = {
  title: string;
  language: string;
  type: TextTrackType;
  uri: string;
  streamIndex: number;
};

function subtitleInput(resolved: ResolvedSource): string {
  return resolved.sourceInput || resolved.playableUrl || "";
}

// Build the sideloaded VTT track list. Prefers an explicit vttUrl; otherwise points at
// the backend subtitle extractor (/api/subtitles.vtt?input=&streamIndex=). Tracks we
// can't form a URL for are dropped.
export function buildTextTracks(resolved: ResolvedSource | null): PlayerTextTrack[] {
  if (!resolved) return [];
  const input = subtitleInput(resolved);
  const out: PlayerTextTrack[] = [];
  for (const t of resolved.tracks?.subtitleTracks ?? []) {
    const uri = t.vttUrl ? toAbsoluteApiUrl(t.vttUrl) : input ? toAbsoluteApiUrl(buildSubtitleUrl(input, t.streamIndex)) : "";
    if (!uri) continue;
    out.push({
      title: t.label || t.title || (t.language ? t.language.toUpperCase() : `Track ${t.streamIndex}`),
      language: t.language || "und",
      type: TextTrackType.VTT,
      uri,
      streamIndex: t.streamIndex,
    });
  }
  return out;
}

export function findSelectedTextTrackIndex(resolved: ResolvedSource | null): number | null {
  const selectedStreamIndex = Number(resolved?.selectedSubtitleStreamIndex);
  if (!Number.isInteger(selectedStreamIndex) || selectedStreamIndex < 0) return null;
  const selectedIndex = buildTextTracks(resolved).findIndex((track) => track.streamIndex === selectedStreamIndex);
  return selectedIndex >= 0 ? selectedIndex : null;
}

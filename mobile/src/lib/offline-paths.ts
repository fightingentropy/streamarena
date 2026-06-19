import * as FileSystem from "expo-file-system/legacy";

// Downloaded video + sidecars live under `${documentDirectory}offline-media/`. On iOS the
// app's Documents container UUID is rewritten on reinstall (and can change between dev
// builds), so a persisted *absolute* file:// path goes stale on the next launch even
// though the file still sits on disk under the new prefix — the launch verify then reads
// it as "missing" and re-downloads. So SQLite stores the container-relative tail
// ("offline-media/<asset>/video.mp4") and we re-anchor it to the live documentDirectory
// every time we actually touch the filesystem.
export const OFFLINE_SUBDIR = "offline-media/";

// Absolute (or already-relative) → relative tail for storage. Slices from the
// offline-media marker, so legacy rows holding a full absolute path normalize too.
export function toRelativeOfflinePath(path: string | null | undefined): string | null {
  if (!path) return null;
  const marker = path.indexOf(OFFLINE_SUBDIR);
  return marker >= 0 ? path.slice(marker) : path;
}

// Relative (or legacy absolute) → absolute file:// under the *current* container. Any
// "offline-media/…" tail is re-anchored to the live documentDirectory.
export function toAbsoluteOfflinePath(path: string | null | undefined): string | null {
  if (!path) return null;
  const rel = toRelativeOfflinePath(path);
  if (!rel) return null;
  // No marker and already absolute → not one of our managed files; leave it untouched.
  if (rel === path && path.startsWith("file://")) return path;
  return `${FileSystem.documentDirectory ?? ""}${rel}`;
}

// The subtitle sidecar blob is a Record<lang, path>; convert each value.
export function relativizeSubtitlePaths(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [lang, p] of Object.entries(map)) {
    const rel = toRelativeOfflinePath(p);
    if (rel) out[lang] = rel;
  }
  return out;
}
export function absolutizeSubtitlePaths(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [lang, p] of Object.entries(map)) {
    const abs = toAbsoluteOfflinePath(p);
    if (abs) out[lang] = abs;
  }
  return out;
}

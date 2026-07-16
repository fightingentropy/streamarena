import { useMemo } from "react";
import { AppState } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import { create } from "zustand";
import { toAbsoluteApiUrl } from "@/lib/config";
import { buildExportUrl, type MediaType, type ResolvedSource } from "@/lib/streamarena";
import {
  dbAllRows,
  dbDeleteRow,
  dbUpsertRow,
  readAllDownloadedRecords,
  verifyOrRepairRecord,
  type DownloadRow,
} from "@/lib/offline-db";
import { getIsOnline, isMeteredConnection, subscribeOnline } from "@/lib/connectivity";
import {
  absolutizeSubtitlePaths,
  relativizeSubtitlePaths,
  toAbsoluteOfflinePath,
  toRelativeOfflinePath,
} from "@/lib/offline-paths";
import { storage } from "@/lib/storage";

// Offline downloads for video. Ports the proven Spotify offline engine (serial pump,
// expo-file-system createDownloadResumable, ref-counted scopes, account scoping,
// launch verify, orphan purge, and transport-aware queueing) to a video record,
// and adds three things the audio store lacked: a Wi-Fi-only gate, a storage cap, and
// light per-download auto-retry. Files: file:// MP4 + sidecars in documentDirectory.

export type DownloadScope = "manual" | `season:${string}`;
export type DownloadStatus = "queued" | "downloading" | "ready" | "error";

// Everything a downloaded asset needs to render its card and play offline. Denormalized
// onto the record (like the audio store's `song`) so a download is self-describing.
export type OfflineSubtitleSpec = { lang: string; title?: string; url: string };
export type OfflineMeta = {
  assetId: string; // stable id, == progressIdentity(req): "tmdb:movie:603" | "tmdb:tv:1399:s1:e1"
  tmdbId: string;
  mediaType: MediaType;
  seasonNumber?: number;
  episodeNumber?: number;
  title: string; // movie or series title
  episodeTitle?: string;
  year?: string;
  posterUrl?: string; // absolute TMDB poster URL (fetched to poster.jpg)
  backdropUrl?: string;
  runtimeSeconds?: number;
  exportInput: string; // `input` for /api/download/export.mp4 (resolved sourceInput/playableUrl)
  audioStreamIndex?: number; // baked audio language (server-muxed at export)
  sourceHash?: string;
  subtitles?: OfflineSubtitleSpec[]; // sidecar VTTs to fetch (text-based tracks)
};

export type OfflineDownloadRecord = {
  assetId: string;
  accountScope: string;
  scopes: DownloadScope[]; // ref-counted pins; record removed when empty
  status: DownloadStatus;
  meta: OfflineMeta;
  videoPath?: string; // file:// in documentDirectory
  posterPath?: string;
  backdropPath?: string;
  subtitlePaths?: Record<string, string>; // lang -> file://
  bytes: number;
  addedAt: number;
  updatedAt: number;
  error?: string;
  // NSURLSession resume blob captured on a deliberate pause (for example, when a
  // Wi-Fi-only transfer moves to cellular). The next attempt resumeAsync()s the partial.
  // In-memory only — omitted from recordToRow because it is valid only in this process.
  resumeData?: string;
};

const OFFLINE_DIR = `${FileSystem.documentDirectory ?? ""}offline-media/`;
const MAX_DOWNLOAD_RETRIES = 2;

// Storage settings (MMKV-backed flags).
const WIFI_ONLY_KEY = "streamarena_wifi_only";
const MAX_STORAGE_KEY = "streamarena_max_storage_bytes";

// Floor for a "real" download — below this the export yielded only an MP4 header (or
// nothing), which means the source couldn't be remuxed. Even a few seconds of video is
// hundreds of KB, so 32 KB never rejects legitimate content.
const MIN_VALID_VIDEO_BYTES = 32 * 1024;

// --- Account scope -----------------------------------------------------------
let accountScope = "anonymous";
export function getOfflineAccountScope(): string {
  return accountScope;
}
export function setOfflineAccountScope(scope: string | null | undefined): void {
  accountScope = scope?.trim() || "anonymous";
}

export function keyFor(scope: string, assetId: string): string {
  return `${scope}:${assetId}`;
}
function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function readWifiOnly(): boolean {
  return storage.getItem(WIFI_ONLY_KEY) === "1";
}
function readMaxStorageBytes(): number {
  const raw = storage.getItem(MAX_STORAGE_KEY);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function recordToRow(record: OfflineDownloadRecord): DownloadRow {
  return {
    key: keyFor(record.accountScope, record.assetId),
    accountScope: record.accountScope,
    assetId: record.assetId,
    tmdbId: record.meta.tmdbId,
    mediaType: record.meta.mediaType,
    scopes: JSON.stringify(record.scopes),
    status: record.status,
    meta: JSON.stringify(record.meta),
    // Store container-relative paths — the iOS Documents UUID changes across reinstalls,
    // so an absolute file:// path would go stale and trigger a needless re-download.
    videoPath: toRelativeOfflinePath(record.videoPath),
    posterPath: toRelativeOfflinePath(record.posterPath),
    backdropPath: toRelativeOfflinePath(record.backdropPath),
    subtitlePaths: record.subtitlePaths ? JSON.stringify(relativizeSubtitlePaths(record.subtitlePaths)) : null,
    bytes: record.bytes,
    addedAt: record.addedAt,
    updatedAt: record.updatedAt,
  };
}

function rowToRecord(row: DownloadRow): OfflineDownloadRecord {
  return {
    assetId: row.assetId,
    accountScope: row.accountScope,
    scopes: JSON.parse(row.scopes) as DownloadScope[],
    status: row.status as DownloadStatus,
    meta: JSON.parse(row.meta) as OfflineMeta,
    // Re-anchor the stored relative paths to the current container's documentDirectory.
    videoPath: toAbsoluteOfflinePath(row.videoPath) ?? undefined,
    posterPath: toAbsoluteOfflinePath(row.posterPath) ?? undefined,
    backdropPath: toAbsoluteOfflinePath(row.backdropPath) ?? undefined,
    subtitlePaths: row.subtitlePaths
      ? absolutizeSubtitlePaths(JSON.parse(row.subtitlePaths) as Record<string, string>)
      : undefined,
    bytes: row.bytes,
    addedAt: row.addedAt,
    updatedAt: row.updatedAt,
  };
}

export type OfflineVerificationStatus = "idle" | "checking" | "ok" | "repair-needed" | "failed";

type OfflineState = {
  records: Record<string, OfflineDownloadRecord>;
  hydrated: boolean;
  // Live download fraction (0..1) per record key — only while "downloading". Ephemeral,
  // never persisted; drives the progress ring. Indeterminate (no Content-Length on the
  // chunked export stream) → stays at a small value; `downloadedBytes` carries the count.
  progress: Record<string, number>;
  downloadedBytes: Record<string, number>; // live bytes-so-far per key
  // Storage / settings.
  wifiOnly: boolean;
  maxStorageBytes: number;
  storageBytes: number;
  storageLimited: boolean; // a queued download is blocked by the storage cap
  // Verification.
  verificationStatus: OfflineVerificationStatus;
  verificationCheckedAt: number | null;
  verifiedDownloads: number;
  missingDownloads: number;
  verificationError: string | null;

  queueDownload: (meta: OfflineMeta, scope?: DownloadScope) => Promise<void>;
  unpinScope: (assetId: string, scope: DownloadScope) => Promise<void>;
  removeDownload: (assetId: string) => Promise<void>;
  isDownloaded: (assetId: string) => boolean;
  hydrate: () => Promise<void>;
  verifyDownloads: () => Promise<void>;
  retryFailedDownloads: () => Promise<void>;
  clearDownloads: () => Promise<void>;
  refreshStorage: () => Promise<void>;
  pauseActiveDownload: () => Promise<void>;
  setWifiOnly: (enabled: boolean) => void;
  setMaxStorageBytes: (bytes: number) => void;
};

export const useOfflineStore = create<OfflineState>((set, get) => {
  const persist = (record: OfflineDownloadRecord) => {
    set((s) => ({ records: { ...s.records, [keyFor(record.accountScope, record.assetId)]: record } }));
    void dbUpsertRow(recordToRow(record)).catch(() => {});
  };

  // Progress ring throttle (~2% steps, guaranteed emit at 1.0). For the indeterminate
  // chunked stream there's no expected total, so we mostly surface bytes; when a total
  // is known (rare), this drives the fraction. Closure-scoped so it survives re-renders.
  const lastEmit: Record<string, number> = {};
  const setProgress = (key: string, frac: number, bytes?: number) => {
    const clamped = frac < 0 ? 0 : frac > 1 ? 1 : frac;
    const prev = lastEmit[key];
    const fracChanged = clamped === 1 || prev === undefined || Math.abs(clamped - prev) >= 0.02;
    if (fracChanged) lastEmit[key] = clamped;
    if (!fracChanged && bytes === undefined) return;
    set((s) => ({
      progress: fracChanged ? { ...s.progress, [key]: clamped } : s.progress,
      downloadedBytes: bytes === undefined ? s.downloadedBytes : { ...s.downloadedBytes, [key]: bytes },
    }));
  };
  const clearProgress = (key: string) => {
    delete lastEmit[key];
    set((s) => {
      const progress = { ...s.progress };
      const downloadedBytes = { ...s.downloadedBytes };
      delete progress[key];
      delete downloadedBytes[key];
      return { progress, downloadedBytes };
    });
  };

  // Serial download pump — one asset at a time.
  let pumping = false;
  let activeDownload: { resumable: FileSystem.DownloadResumable; key: string } | null = null;
  let pausedKey: string | null = null;

  const cancelActiveDownload = async (key?: string) => {
    const active = activeDownload;
    if (!active || (key && active.key !== key)) return;
    activeDownload = null;
    if (pausedKey === active.key) pausedKey = null;
    try {
      await active.resumable.cancelAsync();
    } catch {}
  };

  const removeRecord = async (record: OfflineDownloadRecord) => {
    const key = keyFor(record.accountScope, record.assetId);
    clearProgress(key);
    set((s) => {
      const next = { ...s.records };
      delete next[key];
      return { records: next };
    });
    // A background URLSession outlives React state. Cancel it explicitly before deleting
    // its destination so removing a download never leaves a hidden transfer running.
    await cancelActiveDownload(key);
    await dbDeleteRow(key).catch(() => {});
    try {
      await FileSystem.deleteAsync(`${OFFLINE_DIR}${safeName(record.assetId)}/`, { idempotent: true });
    } catch {}
  };

  // Per-asset retry counter for the current process (not persisted): a transient failure
  // re-queues up to MAX_DOWNLOAD_RETRIES before it sticks as "error".
  const retryCounts: Record<string, number> = {};

  const runPump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      try {
        await FileSystem.makeDirectoryAsync(OFFLINE_DIR, { intermediates: true });
      } catch {}
      while (true) {
        // The iOS download uses a background NSURLSession, so do not gate the pump on
        // AppState: the active transfer can continue while the screen is locked or the
        // app is suspended. Keep the connectivity and Wi-Fi-only gates before starting
        // queued work; the background session itself waits through temporary outages.
        if (!getIsOnline()) break;
        if (get().wifiOnly && isMeteredConnection()) break;
        const queued = Object.values(get().records).find(
          (r) => r.accountScope === accountScope && r.status === "queued",
        );
        if (!queued) break;
        const key = keyFor(accountScope, queued.assetId);

        // Storage cap: stop before starting a new download once the budget is exhausted.
        // The row stays "queued" and resumes after the user frees space (delete re-kicks).
        const cap = get().maxStorageBytes;
        if (cap > 0 && get().storageBytes >= cap) {
          set({ storageLimited: true });
          break;
        }

        const resumeData = queued.resumeData;
        persist({ ...queued, status: "downloading", updatedAt: Date.now() });
        setProgress(key, 0, 0);
        try {
          const dir = `${OFFLINE_DIR}${safeName(queued.assetId)}/`;
          await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
          const videoPath = `${dir}video.mp4`;
          const downloadUrl = toAbsoluteApiUrl(
            buildExportUrl(queued.meta.exportInput, queued.meta.audioStreamIndex),
          );
          const resumable = FileSystem.createDownloadResumable(
            downloadUrl,
            videoPath,
            { sessionType: FileSystem.FileSystemSessionType.BACKGROUND },
            ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
              const frac = totalBytesExpectedToWrite > 0 ? totalBytesWritten / totalBytesExpectedToWrite : 0;
              setProgress(key, frac, totalBytesWritten);
            },
            resumeData,
          );
          activeDownload = { resumable, key };
          const result = resumeData ? await resumable.resumeAsync() : await resumable.downloadAsync();
          activeDownload = null;
          if (!result) {
            // Deliberate Wi-Fi-only pause — already re-queued with a resume blob.
            pausedKey = null;
            clearProgress(key);
            continue;
          }
          if (result.status >= 400) {
            // expo resolves (doesn't throw) on a bad status and writes the body to the
            // file — guard so we never mark a garbage file "ready".
            throw new Error(`Download failed with HTTP ${result.status}`);
          }
          setProgress(key, 1);
          const info = await FileSystem.getInfoAsync(videoPath);
          const bytes = info.exists && !info.isDirectory ? info.size : 0;
          // A hostile/un-remuxable source (e.g. PNG-stego HLS) makes the server's ffmpeg
          // emit nothing or just an empty-moov header under a 200. Reject anything below a
          // real-video floor so we never mark a stub "ready"; it flips to error → retry.
          if (bytes < MIN_VALID_VIDEO_BYTES) {
            await FileSystem.deleteAsync(videoPath, { idempotent: true }).catch(() => {});
            throw new Error("Download produced no usable video (source may not be downloadable).");
          }

          // Best-effort sidecars: poster, backdrop, subtitle VTTs.
          let posterPath: string | undefined;
          if (queued.meta.posterUrl) {
            try {
              const p = `${dir}poster.jpg`;
              await FileSystem.downloadAsync(queued.meta.posterUrl, p);
              posterPath = p;
            } catch {}
          }
          let backdropPath: string | undefined;
          if (queued.meta.backdropUrl) {
            try {
              const p = `${dir}backdrop.jpg`;
              await FileSystem.downloadAsync(queued.meta.backdropUrl, p);
              backdropPath = p;
            } catch {}
          }
          const subtitlePaths: Record<string, string> = {};
          for (const sub of queued.meta.subtitles ?? []) {
            try {
              const p = `${dir}sub_${safeName(sub.lang)}.vtt`;
              await FileSystem.downloadAsync(toAbsoluteApiUrl(sub.url), p);
              subtitlePaths[sub.lang] = p;
            } catch {}
          }

          // The record may have gained/lost scopes while downloading; re-read.
          const latest = get().records[key];
          clearProgress(key);
          delete retryCounts[key];
          if (!latest) continue; // unpinned mid-download
          persist({
            ...latest,
            status: "ready",
            videoPath,
            posterPath,
            backdropPath,
            subtitlePaths: Object.keys(subtitlePaths).length ? subtitlePaths : undefined,
            bytes,
            resumeData: undefined,
            updatedAt: Date.now(),
            error: undefined,
          });
          void refreshStorage();
        } catch (e) {
          activeDownload = null;
          clearProgress(key);
          if (pausedKey === key) {
            pausedKey = null;
            continue;
          }
          const latest = get().records[key];
          if (!latest) continue;
          if (!getIsOnline()) {
            // Connectivity dropped and raced ahead of our pause — keep it queued to retry
            // from scratch on reconnect rather than stranding it as a manual-retry error.
            persist({ ...latest, status: "queued", resumeData: undefined, updatedAt: Date.now() });
          } else {
            const attempts = (retryCounts[key] ?? 0) + 1;
            if (attempts <= MAX_DOWNLOAD_RETRIES) {
              retryCounts[key] = attempts;
              persist({ ...latest, status: "queued", resumeData: undefined, updatedAt: Date.now() });
            } else {
              delete retryCounts[key];
              persist({
                ...latest,
                status: "error",
                resumeData: undefined,
                updatedAt: Date.now(),
                error: e instanceof Error ? e.message : "Download failed",
              });
            }
          }
        }
      }
    } finally {
      pumping = false;
    }
  };

  const pauseActiveDownload = async () => {
    const active = activeDownload;
    if (!active) return;
    activeDownload = null;
    pausedKey = active.key;
    let resumeData: string | undefined;
    try {
      const state = await active.resumable.pauseAsync();
      resumeData = state.resumeData;
    } catch {}
    clearProgress(active.key);
    const latest = get().records[active.key];
    if (latest) persist({ ...latest, status: "queued", resumeData, updatedAt: Date.now() });
  };

  const refreshStorage = async () => {
    try {
      const { getDiskUsage } = await import("@/lib/disk-usage");
      const usage = await getDiskUsage();
      const cap = get().maxStorageBytes;
      set({
        storageBytes: usage.usedByDownloads,
        storageLimited: cap > 0 && usage.usedByDownloads >= cap && hasQueued(),
      });
    } catch {}
  };

  const hasQueued = () =>
    Object.values(get().records).some((r) => r.accountScope === accountScope && r.status === "queued");

  return {
    records: {},
    hydrated: false,
    progress: {},
    downloadedBytes: {},
    wifiOnly: readWifiOnly(),
    maxStorageBytes: readMaxStorageBytes(),
    storageBytes: 0,
    storageLimited: false,
    verificationStatus: "idle",
    verificationCheckedAt: null,
    verifiedDownloads: 0,
    missingDownloads: 0,
    verificationError: null,

    queueDownload: async (meta, scope = "manual") => {
      const key = keyFor(accountScope, meta.assetId);
      const existing = get().records[key];
      if (existing) {
        const addScope = !existing.scopes.includes(scope);
        const requeue = existing.status === "error";
        if (addScope || requeue) {
          delete retryCounts[key];
          persist({
            ...existing,
            // Refresh the baked source/subtitles on a retry (a stale resolve may have expired).
            meta: requeue ? meta : existing.meta,
            scopes: addScope ? [...existing.scopes, scope] : existing.scopes,
            status: requeue ? "queued" : existing.status,
            error: requeue ? undefined : existing.error,
            updatedAt: Date.now(),
          });
        }
      } else {
        persist({
          assetId: meta.assetId,
          accountScope,
          scopes: [scope],
          status: "queued",
          meta,
          bytes: 0,
          addedAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      void runPump();
    },

    unpinScope: async (assetId, scope) => {
      const record = get().records[keyFor(accountScope, assetId)];
      if (!record) return;
      const scopes = record.scopes.filter((s) => s !== scope);
      if (scopes.length === 0) {
        await removeRecord(record);
        void refreshStorage();
      } else {
        persist({ ...record, scopes, updatedAt: Date.now() });
      }
    },

    removeDownload: async (assetId) => {
      const record = get().records[keyFor(accountScope, assetId)];
      if (!record) return;
      await removeRecord(record);
      void refreshStorage();
      // Freeing space may unblock a capped queue.
      if (get().storageLimited) {
        set({ storageLimited: false });
        void runPump();
      }
    },

    isDownloaded: (assetId) => get().records[keyFor(accountScope, assetId)]?.status === "ready",

    hydrate: async () => {
      if (get().hydrated) return;
      try {
        const rows = await dbAllRows();
        const records: Record<string, OfflineDownloadRecord> = {};
        for (const row of rows) {
          const record = rowToRecord(row);
          // A row left "downloading" means the app died mid-download; its resume blob was
          // in-memory only, so restart from scratch as "queued".
          if (record.status === "downloading") record.status = "queued";
          records[row.key] = record;
        }
        set({ records, hydrated: true });
        await purgeOrphanedDownloadArtifacts();
        if (Object.values(records).some((r) => r.status === "queued" || r.status === "downloading")) {
          void runPump();
        }
      } catch {
        set({ hydrated: true });
      }
      void refreshStorage();
      if (!quietVerifyScheduled) {
        quietVerifyScheduled = true;
        setTimeout(() => void quietVerifyDownloads(), 12_000);
      }
    },

    verifyDownloads: async () => {
      await get().hydrate();
      set({ verificationStatus: "checking", verificationError: null });
      try {
        const rows = await readAllDownloadedRecords(accountScope);
        let verified = 0;
        let missing = 0;
        for (const row of rows) {
          const result = await verifyOrRepairRecord(row);
          if (result.ok) {
            verified += 1;
          } else {
            missing += 1;
            const current = get().records[row.key];
            if (current) persist({ ...current, status: "queued", videoPath: undefined, updatedAt: Date.now() });
          }
        }
        set({
          verificationStatus: missing > 0 ? "repair-needed" : "ok",
          verificationCheckedAt: Date.now(),
          verifiedDownloads: verified,
          missingDownloads: missing,
          verificationError: null,
        });
        if (missing > 0) void runPump();
        void refreshStorage();
      } catch (e) {
        set({
          verificationStatus: "failed",
          verificationCheckedAt: Date.now(),
          verificationError: e instanceof Error ? e.message : "Download verification failed",
        });
      }
    },

    retryFailedDownloads: async () => {
      const failed = Object.values(get().records).filter(
        (r) => r.accountScope === accountScope && r.status === "error",
      );
      for (const record of failed) {
        delete retryCounts[keyFor(record.accountScope, record.assetId)];
        persist({ ...record, status: "queued", error: undefined, updatedAt: Date.now() });
      }
      if (failed.length > 0) void runPump();
    },

    clearDownloads: async () => {
      const records = Object.values(get().records).filter((r) => r.accountScope === accountScope);
      const keys = records.map((r) => keyFor(r.accountScope, r.assetId));
      set((s) => {
        const nextRecords = { ...s.records };
        const nextProgress = { ...s.progress };
        const nextBytes = { ...s.downloadedBytes };
        for (const key of keys) {
          delete nextRecords[key];
          delete nextProgress[key];
          delete nextBytes[key];
        }
        return { records: nextRecords, progress: nextProgress, downloadedBytes: nextBytes };
      });
      for (const key of keys) delete lastEmit[key];
      set({
        verificationStatus: "idle",
        verificationCheckedAt: null,
        verifiedDownloads: 0,
        missingDownloads: 0,
        verificationError: null,
        storageLimited: false,
      });
      const activeKey = activeDownload?.key;
      if (activeKey && keys.includes(activeKey)) await cancelActiveDownload(activeKey);
      for (const record of records) {
        await dbDeleteRow(keyFor(record.accountScope, record.assetId)).catch(() => {});
        await FileSystem.deleteAsync(`${OFFLINE_DIR}${safeName(record.assetId)}/`, { idempotent: true }).catch(
          () => {},
        );
      }
      await purgeOrphanedDownloadArtifacts();
      await refreshStorage();
    },

    refreshStorage,
    pauseActiveDownload,

    setWifiOnly: (enabled) => {
      try {
        storage.setItem(WIFI_ONLY_KEY, enabled ? "1" : "0");
      } catch {}
      set({ wifiOnly: enabled });
      if (enabled && isMeteredConnection()) {
        void pauseActiveDownload();
      } else if (!enabled) {
        void runPump(); // disabling the gate may release held downloads
      }
    },

    setMaxStorageBytes: (bytes) => {
      const value = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
      try {
        storage.setItem(MAX_STORAGE_KEY, String(value));
      } catch {}
      set({ maxStorageBytes: value });
      // Raising/clearing the cap may unblock the queue.
      if (value === 0 || get().storageBytes < value) {
        set({ storageLimited: false });
        void runPump();
      }
      void refreshStorage();
    },
  };
});

// --- Launch integrity + orphan reclamation -----------------------------------
let quietVerifyScheduled = false;
let quietVerifyStarted = false;
async function quietVerifyDownloads(): Promise<void> {
  if (quietVerifyStarted) return;
  quietVerifyStarted = true;
  try {
    const rows = await readAllDownloadedRecords(accountScope);
    let repaired = 0;
    for (const row of rows) {
      const result = await verifyOrRepairRecord(row);
      if (result.ok) continue;
      repaired += 1;
      const current = useOfflineStore.getState().records[row.key];
      if (current) {
        useOfflineStore.setState((s) => ({
          records: {
            ...s.records,
            [row.key]: { ...current, status: "queued", videoPath: undefined, updatedAt: Date.now() },
          },
        }));
      }
    }
    if (repaired > 0) void useOfflineStore.getState().hydrate().then(() => kickPump());
  } catch {}
}

// Kick the serial pump for any queued rows (used after a quiet repair). queueDownload
// always ends in runPump(); reuse a no-op pin to trigger it without adding a record.
function kickPump(): void {
  const anyQueued = Object.values(useOfflineStore.getState().records).some(
    (r) => r.accountScope === accountScope && r.status === "queued",
  );
  if (!anyQueued) return;
  const first = Object.values(useOfflineStore.getState().records).find(
    (r) => r.accountScope === accountScope && r.status === "queued",
  );
  if (first) void useOfflineStore.getState().queueDownload(first.meta, first.scopes[0] ?? "manual");
}

// Reclaim only app-owned offline-media folders with no backing "ready" record.
// NSURLSession's Library/Caches data is system-managed and may belong to an active
// background transfer, so it must never be traversed or deleted here.
// Best-effort, idempotent; never breaks launch.
async function purgeOrphanedDownloadArtifacts(): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(OFFLINE_DIR);
    if (info.exists) {
      const folders = await FileSystem.readDirectoryAsync(OFFLINE_DIR);
      if (folders.length > 0) {
        const readyFolders = new Set(
          Object.values(useOfflineStore.getState().records)
            .filter((r) => r.status === "ready")
            .map((r) => safeName(r.assetId)),
        );
        await Promise.all(
          folders
            .filter((folder) => !readyFolders.has(folder))
            .map((folder) => FileSystem.deleteAsync(`${OFFLINE_DIR}${folder}`, { idempotent: true }).catch(() => {})),
        );
      }
    }
  } catch {}
}

// Keep the active background NSURLSession running across AppState and temporary offline
// changes. iOS waits and retries background transfers itself. Returning to the foreground
// re-kicks deferred queue work; transport edges also enforce the Wi-Fi-only preference.
// Returns an unsubscribe fn; the root layout owns the single call site.
export function initOfflineSync(): () => void {
  void useOfflineStore.getState().hydrate();
  const subscription = AppState.addEventListener("change", (next) => {
    if (next === "active") kickPump();
  });
  const unsubscribeOnline = subscribeOnline((isOnline) => {
    const state = useOfflineStore.getState();
    if (state.wifiOnly && isMeteredConnection()) {
      void state.pauseActiveDownload();
    } else if (isOnline) {
      kickPump();
    }
  });
  return () => {
    subscription.remove();
    unsubscribeOnline();
  };
}

// --- Offline playback seam ---------------------------------------------------
// A ready record for an asset id (== progressIdentity(req)), or null.
export function getReadyOfflineRecord(assetId: string): OfflineDownloadRecord | null {
  const record = useOfflineStore.getState().records[keyFor(accountScope, assetId)];
  return record && record.status === "ready" && record.videoPath ? record : null;
}

// Shape a downloaded record as a ResolvedSource so the player plumbing (subtitle picker,
// reporting, controls) works unchanged. The local video plays directly; sidecar VTTs are
// file:// URLs that toAbsoluteApiUrl passes through verbatim. No audio-track list (the
// language was baked at export); no alternate sources offline.
export function buildOfflineResolved(record: OfflineDownloadRecord): ResolvedSource {
  const subtitleTracks = Object.entries(record.subtitlePaths ?? {}).map(([lang, path], i) => ({
    streamIndex: i,
    language: lang,
    isTextBased: true,
    isExternal: true,
    vttUrl: path,
    label: lang.toUpperCase(),
  }));
  return {
    playableUrl: record.videoPath ?? "",
    sourceHash: record.meta.sourceHash ?? "offline",
    sourceInput: record.meta.exportInput,
    filename: record.meta.title,
    tracks: { audioTracks: [], subtitleTracks },
    selectedAudioStreamIndex: record.meta.audioStreamIndex,
  };
}

// --- Selector hooks ----------------------------------------------------------
export type TitleDownloadState = {
  status: "idle" | "queued" | "downloading" | "ready" | "error";
  progress: number; // 0..1 (indeterminate streams report ~0 until done)
  bytes: number; // live bytes downloaded so far (or final size when ready)
  error?: string;
};

export function useTitleDownload(assetId: string): TitleDownloadState {
  const record = useOfflineStore((s) => s.records[keyFor(accountScope, assetId)]);
  const progress = useOfflineStore((s) => s.progress[keyFor(accountScope, assetId)]);
  const liveBytes = useOfflineStore((s) => s.downloadedBytes[keyFor(accountScope, assetId)]);
  return useMemo(() => {
    if (!record) return { status: "idle", progress: 0, bytes: 0 };
    return {
      status: record.status,
      progress: record.status === "ready" ? 1 : (progress ?? 0),
      bytes: record.status === "ready" ? record.bytes : (liveBytes ?? 0),
      error: record.error,
    };
  }, [record, progress, liveBytes]);
}

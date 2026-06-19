import * as FileSystem from "expo-file-system/legacy";
import { getOfflineAccountScope } from "@/store/offline";
import { readAllDownloadedRecords } from "@/lib/offline-db";
import { toAbsoluteOfflinePath } from "@/lib/offline-paths";

// Storage accounting for the Downloads / Storage screens. RN has no
// navigator.storage.estimate(), so this sums the actual on-disk size of every
// downloaded asset and reads the device's free/total disk from expo-file-system's
// legacy API (feature-tested so it degrades to just the downloads total if absent).

export type DiskUsage = {
  usedByDownloads: number;
  free?: number;
  total?: number;
};

export function formatBytes(value: number | null | undefined): string {
  if (!value || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`;
}

async function fileSize(path: string | null | undefined): Promise<number> {
  if (!path) return 0;
  try {
    const info = await FileSystem.getInfoAsync(path);
    return info.exists && !info.isDirectory ? info.size : 0;
  } catch {
    return 0;
  }
}

// Sum video + poster + backdrop + every subtitle sidecar across each ready download
// for the current account. Stats run in parallel; any unreadable file contributes 0.
async function sumDownloadedBytes(accountScope: string): Promise<number> {
  const rows = await readAllDownloadedRecords(accountScope).catch(() => []);
  const paths: (string | null)[] = [];
  for (const row of rows) {
    // Stored paths are container-relative; resolve against the live documentDirectory.
    paths.push(
      toAbsoluteOfflinePath(row.videoPath),
      toAbsoluteOfflinePath(row.posterPath),
      toAbsoluteOfflinePath(row.backdropPath),
    );
    if (row.subtitlePaths) {
      try {
        const subs = JSON.parse(row.subtitlePaths) as Record<string, string>;
        for (const p of Object.values(subs)) paths.push(toAbsoluteOfflinePath(p));
      } catch {}
    }
  }
  const sizes = await Promise.all(paths.map((p) => fileSize(p)));
  return sizes.reduce((total, size) => total + size, 0);
}

async function maybeNumber(fn: (() => Promise<number>) | undefined): Promise<number | undefined> {
  if (typeof fn !== "function") return undefined;
  try {
    const value = await fn();
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function getDiskUsage(): Promise<DiskUsage> {
  const accountScope = getOfflineAccountScope();
  const fs = FileSystem as typeof FileSystem & {
    getFreeDiskStorageAsync?: () => Promise<number>;
    getTotalDiskCapacityAsync?: () => Promise<number>;
  };
  const [usedByDownloads, free, total] = await Promise.all([
    sumDownloadedBytes(accountScope),
    maybeNumber(fs.getFreeDiskStorageAsync),
    maybeNumber(fs.getTotalDiskCapacityAsync),
  ]);
  return { usedByDownloads, free, total };
}

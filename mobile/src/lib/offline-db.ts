import * as FileSystem from "expo-file-system/legacy";
import * as SQLite from "expo-sqlite";

// expo-sqlite store for offline video download records. Adapted from the Spotify
// app's audio store: a single TEXT primary key (`${accountScope}:${assetId}`),
// status/updatedAt for queries, plus `tmdbId`/`mediaType` columns so "is this title
// downloaded?" is an index hit. The big `meta` JSON blob denormalizes everything the
// card + offline player need (export input, titles, subtitle sidecars) so a download
// is fully self-describing on disk. The NSURLSession resume blob is in-memory only
// (see store/offline.ts) and is deliberately NOT a column.
export type DownloadRow = {
  key: string; // `${accountScope}:${assetId}`
  accountScope: string;
  assetId: string;
  tmdbId: string;
  mediaType: string;
  scopes: string; // JSON string[]
  status: string;
  meta: string; // JSON OfflineMeta
  videoPath: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  subtitlePaths: string | null; // JSON Record<lang, file://path>
  bytes: number;
  addedAt: number;
  updatedAt: number;
};

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync("streamarena-offline.db");
      // No migration framework (matches the Spotify store): the schema is created
      // idempotently. Adding a column later needs an explicit PRAGMA user_version
      // migration — plan for it before shipping a v2 column.
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS downloads (
          key TEXT PRIMARY KEY NOT NULL,
          accountScope TEXT NOT NULL,
          assetId TEXT NOT NULL,
          tmdbId TEXT NOT NULL,
          mediaType TEXT NOT NULL,
          scopes TEXT NOT NULL,
          status TEXT NOT NULL,
          meta TEXT NOT NULL,
          videoPath TEXT,
          posterPath TEXT,
          backdropPath TEXT,
          subtitlePaths TEXT,
          bytes INTEGER NOT NULL DEFAULT 0,
          addedAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_downloads_account ON downloads (accountScope);
        CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads (status);
        CREATE INDEX IF NOT EXISTS idx_downloads_title ON downloads (tmdbId, mediaType);
      `);
      return db;
    })();
  }
  return dbPromise;
}

export async function dbAllRows(): Promise<DownloadRow[]> {
  const db = await getDb();
  return db.getAllAsync<DownloadRow>("SELECT * FROM downloads ORDER BY updatedAt DESC");
}

export async function dbUpsertRow(row: DownloadRow): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO downloads
      (key, accountScope, assetId, tmdbId, mediaType, scopes, status, meta, videoPath, posterPath, backdropPath, subtitlePaths, bytes, addedAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.key,
      row.accountScope,
      row.assetId,
      row.tmdbId,
      row.mediaType,
      row.scopes,
      row.status,
      row.meta,
      row.videoPath,
      row.posterPath,
      row.backdropPath,
      row.subtitlePaths,
      row.bytes,
      row.addedAt,
      row.updatedAt,
    ],
  );
}

export async function dbDeleteRow(key: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("DELETE FROM downloads WHERE key = ?", [key]);
}

// All "ready" rows for an account — used by the verify pass and the storage total.
// SQLite is the authoritative set; the store's in-memory map is the same data today.
export async function readAllDownloadedRecords(accountScope: string): Promise<DownloadRow[]> {
  const db = await getDb();
  return db.getAllAsync<DownloadRow>(
    "SELECT * FROM downloads WHERE accountScope = ? AND status = 'ready' ORDER BY updatedAt DESC",
    [accountScope],
  );
}

// Check that a ready record's video file still exists with a non-empty size. A
// missing/empty file can't be repaired in place (no source to re-stage from), so the
// row is flipped back to "queued" (videoPath cleared) for the serial pump to
// re-download. Poster/backdrop/subtitle sidecars are best-effort and not gated here.
export async function verifyOrRepairRecord(row: DownloadRow): Promise<{ ok: boolean }> {
  const videoPath = row.videoPath;
  if (videoPath) {
    try {
      const info = await FileSystem.getInfoAsync(videoPath);
      if (info.exists && !info.isDirectory && info.size > 0) return { ok: true };
    } catch {
      // fall through to repair
    }
  }
  await dbUpsertRow({
    ...row,
    status: "queued",
    videoPath: null,
    updatedAt: Date.now(),
  });
  return { ok: false };
}

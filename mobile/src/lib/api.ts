import { useCallback, useEffect, useRef, useState } from "react";
import { markOffline, markOnline } from "@/lib/connectivity";
import { API_AUTH_REQUIRED_EVENT, API_CACHE_CLEARED_EVENT, emit, on } from "@/lib/events";
import { apiFetch } from "@/lib/http";
import {
  readOfflineApiSnapshot,
  readOfflineApiSnapshotSync,
  removeOfflineApiSnapshots,
  writeOfflineApiSnapshot,
} from "@/lib/offline-snapshots";

export { API_AUTH_REQUIRED_EVENT } from "@/lib/events";

// Ported from spotify/mobile/src/lib/api.ts. The cache / ETag / in-flight-dedup /
// timeout / useApiData / snapshot machinery is preserved verbatim; the Spotify
// like-cache patchers and payload types are dropped, and isPersistableApiUrl now
// lists streamarena read endpoints. One-shot getJson/mutateJson helpers are added
// for always-fresh resolves and PUT/POST user-data writes.

type ApiCacheEntry<T = unknown> = {
  data?: T;
  etag?: string | null;
  fetchedAt: number;
  promise?: Promise<T>;
  promiseStartedAt?: number;
};

const API_FETCH_TIMEOUT_MS = 5_000;
const API_SNAPSHOT_READ_TIMEOUT_MS = 1_000;
const apiCache = new Map<string, ApiCacheEntry>();

function getApiPath(url: string): string {
  try {
    return new URL(url, "http://streamarena.local").pathname;
  } catch {
    return url.split("?")[0] || url;
  }
}

function getApiAuthScope(url: string): string {
  try {
    return new URL(url, "http://streamarena.local").searchParams.get("auth")?.trim() || "legacy";
  } catch {
    return "legacy";
  }
}

export function withAccountScope(url: string, scope: string | null | undefined): string {
  const value = scope?.trim() || "anonymous";
  try {
    const parsed = new URL(url, "http://streamarena.local");
    parsed.searchParams.set("auth", value);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    const [path, query = ""] = url.split("?");
    const params = new URLSearchParams(query);
    params.set("auth", value);
    const serialized = params.toString();
    return serialized ? `${path}?${serialized}` : path;
  }
}

// Reads worth persisting for offline browse. The `?auth=` scope is part of the
// cache key, so each account's snapshots stay isolated.
function isPersistableApiUrl(url: string): boolean {
  const path = getApiPath(url);
  return (
    path === "/api/home/bootstrap" ||
    path === "/api/user/continue-watching" ||
    path === "/api/user/my-list" ||
    path === "/api/user/preferences" ||
    /^\/api\/[a-z-]+\/matches$/.test(path)
  );
}

function getCacheEntry<T>(url: string): ApiCacheEntry<T> | undefined {
  const memory = apiCache.get(url) as ApiCacheEntry<T> | undefined;
  if (!memory) return undefined;
  if (memory.promise) {
    const startedAt = memory.promiseStartedAt ?? (memory.fetchedAt > 0 ? memory.fetchedAt : 0);
    if (!startedAt || Date.now() - startedAt > API_FETCH_TIMEOUT_MS + API_SNAPSHOT_READ_TIMEOUT_MS + 1_000) {
      apiCache.set(url, { data: memory.data, etag: memory.etag, fetchedAt: memory.fetchedAt });
      return memory.data === undefined ? undefined : getCacheEntry<T>(url);
    }
    return memory;
  }
  if (memory.data !== undefined) return memory;
  return undefined;
}

async function readStoredApiCache<T>(url: string): Promise<ApiCacheEntry<T> | undefined> {
  if (!isPersistableApiUrl(url)) return undefined;
  const snapshot = await withClientTimeout(
    readOfflineApiSnapshot<T>(url),
    API_SNAPSHOT_READ_TIMEOUT_MS,
    "Offline snapshot read timed out",
  ).catch(() => undefined);
  if (!snapshot || snapshot.data === undefined || typeof snapshot.fetchedAt !== "number") return undefined;
  return { data: snapshot.data, etag: snapshot.etag ?? null, fetchedAt: snapshot.fetchedAt };
}

async function getCacheEntryAsync<T>(url: string): Promise<ApiCacheEntry<T> | undefined> {
  const memory = getCacheEntry<T>(url);
  if (memory?.data !== undefined || memory?.promise) return memory;
  const stored = await readStoredApiCache<T>(url);
  if (stored) apiCache.set(url, stored);
  return stored;
}

function getCachedData<T>(url: string): T | undefined {
  return getCacheEntry<T>(url)?.data;
}

// Synchronous read of an API url's cached value (memory, then MMKV snapshot for
// persistable urls). Lets non-hook callers (e.g. the player store) apply cached reads
// like preferences without a render-cycle race. Returns undefined when nothing is cached.
export function readCachedApiData<T>(url: string): T | undefined {
  return getCachedData<T>(url) ?? primeFromSnapshotSync<T>(url);
}

// Synchronously hydrate from a persisted MMKV snapshot so useApiData paints cached
// data on its first render instead of flashing empty.
function primeFromSnapshotSync<T>(url: string): T | undefined {
  const existing = getCacheEntry<T>(url);
  if (existing?.data !== undefined) return existing.data;
  if (apiCache.has(url) || !isPersistableApiUrl(url)) return undefined;
  const snapshot = readOfflineApiSnapshotSync<T>(url);
  if (!snapshot || snapshot.data === undefined) return undefined;
  apiCache.set(url, { data: snapshot.data, etag: snapshot.etag ?? null, fetchedAt: snapshot.fetchedAt });
  return snapshot.data;
}

function writeApiCache<T>(url: string, data: T, etag?: string | null): T {
  const entry: ApiCacheEntry<T> = { data, etag: etag ?? null, fetchedAt: Date.now() };
  apiCache.set(url, entry);
  if (isPersistableApiUrl(url)) {
    void writeOfflineApiSnapshot(url, data, entry.etag, entry.fetchedAt);
  }
  return data;
}

// Wipe every API cache layer (memory + ETags + persisted snapshots) and notify
// mounted useApiData hooks to re-fetch. Does not touch downloads/auth/settings.
export async function clearApiDataCache(): Promise<void> {
  apiCache.clear();
  await removeOfflineApiSnapshots();
  emit(API_CACHE_CLEARED_EVENT);
}

function canSyncApiData(): boolean {
  return true;
}

function offlineCacheMissMessage(url: string): string {
  const path = getApiPath(url);
  if (path === "/api/home/bootstrap") return "Home hasn't been cached for offline use yet.";
  if (path === "/api/user/my-list") return "Your list hasn't been cached for offline use yet.";
  if (path === "/api/user/continue-watching") return "Continue watching hasn't been cached for offline use yet.";
  return "This data hasn't been cached for offline use yet.";
}

function apiErrorMessage(url: string, error: unknown): string {
  const message = error instanceof Error ? error.message : "Request failed";
  if (/request timed out|abort/i.test(message)) return "Taking too long to load — please retry.";
  if (/offline|network and cache miss|failed to fetch|load failed|network request failed/i.test(message)) {
    return offlineCacheMissMessage(url);
  }
  return message;
}

function dispatchApiAuthRequired(url: string): void {
  emit(API_AUTH_REQUIRED_EVENT, { url });
}

async function withClientTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = API_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = apiFetch(url, { ...init, signal: controller?.signal ?? init?.signal }).then(
      (response) => {
        markOnline();
        return response;
      },
      (error: unknown) => {
        if ((error as { name?: string })?.name !== "AbortError") markOffline();
        throw error;
      },
    );
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller?.abort();
        reject(new Error("Request timed out"));
      }, timeoutMs);
    });
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function fetchApiData<T>(url: string): Promise<T> {
  const cached = await getCacheEntryAsync<T>(url);
  if (cached?.promise) return cached.promise;

  const promise = (async () => {
    const headers = new Headers({ accept: "application/json" });
    if (cached?.etag && cached.data !== undefined) headers.set("if-none-match", cached.etag);

    const response = await fetchWithTimeout(url, { cache: "no-cache", headers });
    if (response.status === 304 && cached?.data !== undefined) {
      const live = apiCache.get(url) as ApiCacheEntry<T> | undefined;
      const current = live?.data !== undefined ? live : cached;
      return writeApiCache(url, current.data as T, current.etag ?? null);
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string; offline?: boolean };
      if (response.status === 401) dispatchApiAuthRequired(url);
      if (payload.offline) throw new Error(offlineCacheMissMessage(url));
      throw new Error(payload.error || `Request failed with ${response.status}`);
    }
    return writeApiCache(url, (await response.json()) as T, response.headers.get("etag"));
  })();

  apiCache.set(url, {
    data: cached?.data,
    etag: cached?.etag,
    fetchedAt: cached?.fetchedAt ?? 0,
    promise,
    promiseStartedAt: Date.now(),
  });

  try {
    return await promise;
  } finally {
    const next = apiCache.get(url);
    if (next?.promise === promise) {
      apiCache.set(url, { data: next.data, etag: next.etag, fetchedAt: next.fetchedAt });
      if (next.data !== undefined && isPersistableApiUrl(url)) {
        void writeOfflineApiSnapshot(url, next.data, next.etag, next.fetchedAt);
      }
    }
  }
}

export function invalidateApiCache(match?: string | RegExp | ((url: string) => boolean)): void {
  if (!match) {
    apiCache.clear();
    void removeOfflineApiSnapshots();
    return;
  }
  for (const key of Array.from(apiCache.keys())) {
    const shouldDelete =
      typeof match === "string"
        ? key === match || key.startsWith(match)
        : match instanceof RegExp
          ? match.test(key)
          : match(key);
    if (shouldDelete) apiCache.delete(key);
  }
  void removeOfflineApiSnapshots(match);
}

// Invalidate the user-data + home reads after a my-list / progress / preferences
// write, optionally scoped to one account.
export function invalidateUserDataCache(accountScope?: string): void {
  const scopedAccount = accountScope?.trim();
  invalidateApiCache((url) => {
    if (scopedAccount && getApiAuthScope(url) !== scopedAccount) return false;
    const path = getApiPath(url);
    return (
      path === "/api/home/bootstrap" ||
      path === "/api/user/my-list" ||
      path === "/api/user/continue-watching" ||
      path === "/api/user/preferences"
    );
  });
}

// One-shot JSON GET with a generous default timeout. Used for always-fresh calls
// that must NOT be cached: source resolution and search. Resolution can take many
// seconds (torrent/embed discovery), hence the long default.
export async function getJson<T>(path: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T> {
  const response = await fetchWithTimeout(
    path,
    { cache: "no-store", headers: new Headers({ accept: "application/json" }), signal: options?.signal },
    options?.timeoutMs ?? 45_000,
  );
  if (response.status === 401) dispatchApiAuthRequired(path);
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

// One-shot JSON mutation (POST/PUT/DELETE) for user-data writes.
export async function mutateJson<T = unknown>(
  path: string,
  method: "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<T> {
  const response = await fetchWithTimeout(
    path,
    {
      method,
      cache: "no-store",
      headers: new Headers({ "content-type": "application/json", accept: "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    15_000,
  );
  if (response.status === 401) dispatchApiAuthRequired(path);
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }
  return (await response.json().catch(() => ({}))) as T;
}

export function useApiData<T>(
  url: string,
  initialValue: T,
  options?: { enabled?: boolean; keepPreviousData?: boolean },
) {
  const enabled = options?.enabled ?? true;
  const keepPreviousData = options?.keepPreviousData ?? false;
  const cachedInitial = getCachedData<T>(url) ?? primeFromSnapshotSync<T>(url);
  const [data, setDataState] = useState<T>(cachedInitial ?? initialValue);
  const [loading, setLoading] = useState(enabled && !cachedInitial);
  const [error, setError] = useState<string | null>(null);
  const dataUrlRef = useRef(cachedInitial !== undefined ? url : "");
  const initialValueRef = useRef(initialValue);

  useEffect(() => {
    initialValueRef.current = initialValue;
  }, [initialValue]);

  const startLoad = useCallback(
    (background = false) => {
      if (!enabled) {
        setLoading(false);
        return undefined;
      }
      let cancelled = false;

      async function run() {
        const cached = await getCacheEntryAsync<T>(url);
        const cachedData = cached?.data;
        const hasVisibleData = dataUrlRef.current !== "";
        const canReuseCurrentData = dataUrlRef.current === url || (keepPreviousData && hasVisibleData);

        if (cancelled) return;
        if (cachedData !== undefined) {
          setDataState(cachedData);
          dataUrlRef.current = url;
          setLoading(false);
          setError(null);
        } else if (!background && !canReuseCurrentData) {
          setDataState(initialValueRef.current);
          dataUrlRef.current = "";
          setLoading(true);
        } else {
          setLoading(false);
        }

        if (!canSyncApiData()) {
          if (cachedData === undefined && !canReuseCurrentData) setError(offlineCacheMissMessage(url));
          setLoading(false);
          return;
        }

        if (!background || cachedData !== undefined) setError(null);
        try {
          const payload = await fetchApiData<T>(url);
          if (!cancelled) {
            setDataState(payload);
            dataUrlRef.current = url;
            setError(null);
          }
        } catch (err) {
          if (!cancelled) {
            setError(cachedData === undefined && !canReuseCurrentData ? apiErrorMessage(url, err) : null);
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      }
      void run();
      return () => {
        cancelled = true;
      };
    },
    [enabled, keepPreviousData, url],
  );

  useEffect(() => startLoad(false), [startLoad]);
  useEffect(() => on(API_CACHE_CLEARED_EVENT, () => startLoad(false)), [startLoad]);

  // Background re-fetch that keeps the current data visible (for pull-to-refresh / retry).
  const refetch = useCallback(() => {
    startLoad(true);
  }, [startLoad]);

  return { data, loading, error, refetch };
}

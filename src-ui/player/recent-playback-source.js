import { normalizeSourceHash } from "./sources.js";

const STORAGE_KEY = "streamarena-recent-working-sources-v1";
const PROVIDERS = new Set(["external-embed", "real-debrid", "local-torrent"]);

/** A short-lived resume hint, recorded only after media advances. It stores a
 * source identity, never a signed playback URL or a persistent Server choice. */
export function createRecentPlaybackSourceCache({
  storage = globalThis.localStorage, owner = "", getOwner = () => owner,
  now = Date.now, ttlMs = 30 * 60 * 1000, maxEntries = 48,
} = {}) {
  const ownsState = () => Boolean(owner && getOwner() === owner);
  function read() {
    if (!ownsState()) return {};
    try {
      const value = JSON.parse(storage?.getItem(STORAGE_KEY) || "null");
      return value?.owner === owner && value.entries && typeof value.entries === "object" ? value.entries : {};
    } catch { return {}; }
  }
  function write(entries) {
    if (!ownsState()) return;
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify({ owner, entries }));
    } catch { /* Resume still works if storage is unavailable. */ }
  }
  function forget(sourceIdentity) {
    const entries = read();
    if (Object.hasOwn(entries, sourceIdentity)) {
      delete entries[sourceIdentity];
      write(entries);
    }
  }
  return {
    get({ sourceIdentity, preferences = "", resumeSeconds = 0, explicitSourceHash = "", providerAllowed = () => true } = {}) {
      if (!ownsState() || !(resumeSeconds > 1) || explicitSourceHash) return null;
      const entry = read()[sourceIdentity];
      if (!entry || !normalizeSourceHash(entry.sourceHash) || !PROVIDERS.has(entry.provider)) return null;
      if (entry.preferences !== preferences || !providerAllowed(entry.provider)) return null;
      if (!(now() >= entry.updatedAt && now() - entry.updatedAt < ttlMs)) {
        forget(sourceIdentity);
        return null;
      }
      return { sourceHash: entry.sourceHash, provider: entry.provider };
    },
    remember({ sourceIdentity, preferences = "", sourceHash, provider } = {}) {
      sourceHash = normalizeSourceHash(sourceHash);
      if (!ownsState() || !sourceIdentity || !sourceHash || !PROVIDERS.has(provider)) return false;
      const entries = read();
      entries[sourceIdentity] = { sourceHash, provider, preferences, updatedAt: now() };
      const ordered = Object.entries(entries).sort((a, b) => b[1].updatedAt - a[1].updatedAt);
      write(Object.fromEntries(ordered.slice(0, maxEntries)));
      return true;
    },
    forget,
  };
}

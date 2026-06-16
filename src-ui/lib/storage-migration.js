// One-time migration of legacy "netflix-" localStorage keys to the
// "streamarena-" namespace introduced by the rebrand. This keeps every user's
// resume positions, My List, and saved settings across the rename instead of
// silently resetting them.
//
// Suffix-preserving (netflix-<x> → streamarena-<x>) so it pairs exactly with the
// server-side user_preferences key migration in persistence.rs: after both run,
// a hydrate from the server writes streamarena-* keys and stays consistent.
//
// Runs once per browser, guarded by a flag, and is safe to call on every page
// load. All failures are swallowed — if storage is unavailable the legacy keys
// simply stay put and nothing breaks.
const LEGACY_PREFIX = "netflix-";
const NEW_PREFIX = "streamarena-";
const MIGRATION_FLAG = "streamarena-storage-migrated-v1";

export function migrateLegacyStorageKeys() {
  let storage;
  try {
    storage = window.localStorage;
  } catch {
    return;
  }
  if (!storage) return;

  try {
    if (storage.getItem(MIGRATION_FLAG)) return;

    const legacyKeys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && key.startsWith(LEGACY_PREFIX)) legacyKeys.push(key);
    }

    for (const oldKey of legacyKeys) {
      const newKey = NEW_PREFIX + oldKey.slice(LEGACY_PREFIX.length);
      const value = storage.getItem(oldKey);
      // Never clobber a value already written under the new key.
      if (value !== null && storage.getItem(newKey) === null) {
        storage.setItem(newKey, value);
      }
      storage.removeItem(oldKey);
    }

    storage.setItem(MIGRATION_FLAG, "1");
  } catch {
    // Storage full or disabled — leave legacy keys in place.
  }
}

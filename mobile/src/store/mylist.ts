import { create } from "zustand";
import { getJson, withAccountScope } from "@/lib/api";
import { type MediaType, type MyListItem, type Title, putMyList, tmdbImage } from "@/lib/streamarena";

// Optimistic, replace-all My List store. `useApiData`/`useMyList` don't auto-refetch
// after a mutation (invalidateUserDataCache clears the cache but emits no event), so
// this store — not the hook — is the UI source of truth once mounted.
//
// Scope contract: callers pass the *account scope or null* (see useAccountScopeOrNull
// in auth.tsx) — null means signed out. The store never receives the
// "unauthenticated"/"loading" sentinels, so its null-guards work as written.
//
// Writes are single-flighted: a mutation updates `items` immediately and schedules a
// sync that PUTs the *latest* full list (replace-all). Overlapping toggles coalesce
// via `dirty` (the server converges to the final local state — no stale-snapshot
// clobber), and every async resolution is guarded by the captured scope so a
// logout/account-switch mid-flight can't leak one account's list into another. On a
// failed PUT the store reconciles from the server (authoritative) instead of reverting
// to a possibly-stale snapshot.

type EntriesEnvelope = { entries: MyListItem[] };

type MyListState = {
  scope: string | null;
  hydrated: boolean;
  loading: boolean;
  syncing: boolean;
  dirty: boolean;
  items: MyListItem[];
  hydrate: (scope: string | null | undefined) => void;
  toggle: (item: MyListItem) => void;
  remove: (itemIdentity: string) => void;
};

// Fetch the server list for `scope` and apply it iff the scope is still current.
function loadList(scope: string, set: SetFn, get: GetFn): Promise<void> {
  const url = withAccountScope("/api/user/my-list", scope);
  return getJson<EntriesEnvelope>(url, { timeoutMs: 12_000 })
    .then((res) => {
      if (get().scope !== scope) return;
      set({ items: Array.isArray(res.entries) ? res.entries : [], hydrated: true, loading: false });
    })
    .catch(() => {
      if (get().scope !== scope) return;
      set({ hydrated: true, loading: false });
    });
}

// Single-flight replace-all PUT of the current list. Coalesces rapid mutations and
// reconciles from the server on failure. Scope-guarded throughout.
function scheduleSync(scope: string, set: SetFn, get: GetFn): void {
  if (get().syncing) {
    set({ dirty: true });
    return;
  }
  set({ syncing: true, dirty: false });
  putMyList(get().items, scope)
    .then(() => {
      if (get().scope !== scope) {
        set({ syncing: false, dirty: false });
        return;
      }
      set({ syncing: false });
      if (get().dirty) scheduleSync(scope, set, get); // flush coalesced changes
    })
    .catch(() => {
      if (get().scope !== scope) {
        set({ syncing: false, dirty: false });
        return;
      }
      // Reconcile with server truth rather than reverting to a stale snapshot.
      set({ syncing: false, dirty: false });
      void loadList(scope, set, get);
    });
}

type SetFn = (partial: Partial<MyListState>) => void;
type GetFn = () => MyListState;

export const useMyListStore = create<MyListState>((set, get) => ({
  scope: null,
  hydrated: false,
  loading: false,
  syncing: false,
  dirty: false,
  items: [],

  hydrate(rawScope) {
    const scope = rawScope?.trim() || null;
    const state = get();
    if (state.scope === scope && (state.hydrated || state.loading)) return;

    if (!scope) {
      set({ scope: null, items: [], hydrated: true, loading: false, syncing: false, dirty: false });
      return;
    }

    set({ scope, loading: true, hydrated: false, items: [], syncing: false, dirty: false });
    void loadList(scope, set, get);
  },

  toggle(item) {
    const scope = get().scope;
    if (!scope) return; // not signed in
    const id = item.itemIdentity;
    const wasSaved = get().items.some((i) => i.itemIdentity === id);
    set({
      items: wasSaved
        ? get().items.filter((i) => i.itemIdentity !== id)
        : [{ ...item, addedAt: item.addedAt || Date.now() }, ...get().items],
    });
    scheduleSync(scope, set, get);
  },

  remove(itemIdentity) {
    const scope = get().scope;
    if (!scope) return;
    if (!get().items.some((i) => i.itemIdentity === itemIdentity)) return;
    set({ items: get().items.filter((i) => i.itemIdentity !== itemIdentity) });
    scheduleSync(scope, set, get);
  },
}));

// Reactive "is this title saved?" selector — re-renders when items change.
export function useIsSaved(itemIdentity: string): boolean {
  return useMyListStore((s) => s.items.some((i) => i.itemIdentity === itemIdentity));
}

// The canonical My List identity for a VOD title (matches the web's
// getRecommendationIdentity: `tmdb:<mediaType>:<tmdbId>`), so mobile-saved titles
// dedupe against and interop with the web client and the backend PK.
export function myListIdentity(mediaType: MediaType, tmdbId: string | number): string {
  return `tmdb:${mediaType}:${tmdbId}`;
}

// Build a backend-shaped My List entry from a title. `thumb` is stored as an absolute
// poster URL so the My List grid can render it without an image base. `addedAt` is
// intentionally left unset here — toggle() stamps it at the moment of the save.
export function buildMyListItem(opts: {
  tmdbId: string | number;
  mediaType: MediaType;
  title: string;
  year?: string | number;
  posterPath?: string | null;
  imageBase?: string;
}): MyListItem {
  return {
    itemIdentity: myListIdentity(opts.mediaType, opts.tmdbId),
    tmdbId: String(opts.tmdbId),
    mediaType: opts.mediaType,
    title: opts.title,
    year: opts.year ? String(opts.year) : "",
    thumb: tmdbImage(opts.posterPath, "w342", opts.imageBase) || "",
  };
}

// Convert a stored My List entry back into a normalized Title for poster rendering.
// `thumb` is an absolute URL; tmdbImage passes absolute URLs through unchanged.
export function myListItemToTitle(item: MyListItem): Title {
  return {
    id: String(item.tmdbId || ""),
    mediaType: item.mediaType === "tv" ? "tv" : "movie",
    title: item.title || "",
    posterPath: item.thumb || null,
    backdropPath: null,
    overview: "",
    voteAverage: 0,
    year: item.year || "",
  };
}

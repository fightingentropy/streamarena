import { create } from "zustand";
import { getCachedPreferences, type ResolvedSource } from "@/lib/streamarena";
import { buildOfflineResolved, getReadyOfflineRecord } from "@/store/offline";
import { progressIdentity } from "./identity";
import { type LivePlayRequest, type LiveSourceOption, resolveLiveSourceUrl } from "./live";
import { buildFallbackCandidates } from "./refresh";
import { beginReporting, reportNow, reportPlaybackError, reportProgress, stopReporting } from "./report";
import { resolveAndRoute } from "./resolve";
import { loadResumeSeconds } from "./resume";
import type { PlayRequest, PlayerStatus, VideoSource } from "./types";

// The <Video> ref lives in the watch screen; the store reaches it for imperative seeks
// through this seam. Registration is identity-guarded so a departing screen (during a
// next-episode transition where the new screen mounts first) can't null the seam out
// from under the incoming screen.
let seekImpl: ((seconds: number) => void) | null = null;
export function registerSeek(fn: (seconds: number) => void) {
  seekImpl = fn;
}
export function clearSeek(fn: (seconds: number) => void) {
  if (seekImpl === fn) seekImpl = null;
}

// One in-flight resolve at a time; opening a new request aborts the previous.
let resolveAbort: AbortController | null = null;
// Give up the in-place fallback walk after this many failed sources per resolved source.
const MAX_ERRORS = 3;
// Genuine playback past this many seconds clears the accumulated error budget.
const HEALTHY_PLAYBACK_SECONDS = 30;
// Live drops happen fast and a working feed proves itself in seconds, so a shorter
// window restores the fallback budget — a source that sustains this long shouldn't be
// charged a later transient blip. (Resetting on resolve/load instead would let a row of
// load-then-immediately-end embeds loop forever, since resolve success ≠ real playback.)
const LIVE_HEALTHY_PLAYBACK_SECONDS = 6;

type ResolveExtra = { refresh?: boolean; audioStreamIndex?: number; sourceHash?: string };

type PlayerState = {
  status: PlayerStatus;
  request: PlayRequest | null;
  scope: string | null;
  resolved: ResolvedSource | null;
  source: VideoSource | null;
  paused: boolean;
  position: number;
  duration: number;
  buffering: boolean;
  error: string | null;
  errorCount: number;
  reresolved: boolean;
  // Resume bookkeeping: seek to `resumeSeconds` exactly once, when both the saved
  // position and the loaded duration are known. `resumeFor` stamps which request the
  // value belongs to so a late onLoad can't apply it to a different target.
  resumeSeconds: number;
  resumeApplied: boolean;
  resumeFor: PlayRequest | null;
  loaded: boolean;
  selectedSubtitle: number | null;
  selectedAudioStreamIndex?: number;
  selectedSourceHash?: string;
  // Live mode (set by openLive): resume/reporting/offline are skipped, the controls hide
  // scrub/skip and show a LIVE badge, and liveSources powers the in-player source switcher.
  live: boolean;
  liveSources: LiveSourceOption[];
  selectedLiveSourceId: string | null;
  // Player volume (0..1), driven by the right-edge vertical pan gesture; persists across
  // opens within a session. Brightness is OS-level (expo-brightness), so it isn't stored here.
  volume: number;

  open: (req: PlayRequest, scope?: string | null) => Promise<void>;
  openLive: (req: LivePlayRequest) => Promise<void>;
  switchLiveSource: (sourceId: string) => void;
  reopenWith: (opts: { audioStreamIndex?: number; sourceHash?: string }) => void;
  retry: () => void;
  setSubtitle: (index: number | null) => void;
  onLoad: (duration: number) => void;
  setProgress: (position: number, duration: number) => void;
  onBuffer: (buffering: boolean) => void;
  onEnd: () => void;
  onError: (message?: string) => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  seekTo: (seconds: number) => void;
  seekBy: (delta: number) => void;
  setVolume: (v: number) => void;
  close: () => void;
};

// Resolve a request, route it, and prime reporting. Shared by open(), the re-resolve
// recovery path, and track switching. Bails quietly if superseded/aborted.
async function runResolve(
  req: PlayRequest,
  scope: string | null,
  extra: ResolveExtra,
  ac: AbortController,
  set: (partial: Partial<PlayerState>) => void,
) {
  const identity = progressIdentity(req);
  try {
    // Apply the user's synced playback defaults on a plain open; an explicit audio-track or
    // source pick (reopenWith) wins over them so the choice isn't re-overridden.
    const prefs = getCachedPreferences(scope);
    const { resolved, source } = await resolveAndRoute(req, {
      refresh: extra.refresh,
      audioStreamIndex: extra.audioStreamIndex,
      sourceHash: extra.sourceHash,
      audioLang: extra.audioStreamIndex == null ? prefs.audioLang : undefined,
      subtitleLang: prefs.subtitleLang,
      quality: extra.sourceHash == null ? prefs.quality : undefined,
      signal: ac.signal,
    });
    if (ac.signal.aborted) return;
    beginReporting({ request: req, resolved, identity, scope, title: req.title, year: req.year, poster: req.poster });
    set({
      status: "loading",
      resolved,
      source,
      buffering: true,
      selectedAudioStreamIndex: extra.audioStreamIndex ?? resolved.selectedAudioStreamIndex,
      selectedSourceHash: extra.sourceHash ?? resolved.sourceHash,
    });
  } catch (e) {
    if (ac.signal.aborted) return;
    set({ status: "error", error: (e as Error)?.message || "Couldn't find a source for this title.", buffering: false });
  }
}

export const usePlayerStore = create<PlayerState>((set, get) => {
  // Resolve a live source option to a concrete HLS URL and load it; bails if superseded.
  // On resolve failure, walks to the next source (bounded, one pass over the list).
  async function loadLiveSource(opt: LiveSourceOption, ac: AbortController) {
    try {
      const uri = await resolveLiveSourceUrl(opt, ac.signal);
      if (ac.signal.aborted) return;
      set({ status: "loading", source: { uri, isHls: true }, buffering: true, error: null, selectedLiveSourceId: opt.id });
    } catch (e) {
      if (ac.signal.aborted) return;
      set({ selectedLiveSourceId: opt.id });
      failLiveSource((e as Error)?.message);
    }
  }

  // Advance to the next live source after a resolve/playback failure, or surface the error
  // once every source has been tried once (bounded by the source count — no infinite loop).
  function failLiveSource(message?: string) {
    const { liveSources, selectedLiveSourceId, errorCount } = get();
    const attempt = errorCount + 1;
    const idx = liveSources.findIndex((s) => s.id === selectedLiveSourceId);
    const next = liveSources.length > 1 && attempt < liveSources.length ? liveSources[(idx + 1) % liveSources.length] : null;
    if (next) {
      resolveAbort?.abort();
      const ac = new AbortController();
      resolveAbort = ac;
      set({ errorCount: attempt, status: "resolving", buffering: true, error: null, selectedLiveSourceId: next.id });
      void loadLiveSource(next, ac);
    } else {
      set({ status: "error", error: message || "No working stream found for this channel.", buffering: false });
    }
  }

  // Apply the saved resume position once both it and the duration are known, and only
  // if the value belongs to the request that's currently loaded.
  function maybeApplyResume() {
    const s = get();
    if (s.resumeApplied || !s.loaded || s.resumeFor !== s.request) return;
    const target = s.resumeSeconds;
    const fits = target > 5 && (s.duration <= 0 || target < s.duration - 10);
    if (fits) {
      seekImpl?.(target);
      set({ position: target, resumeApplied: true });
    } else {
      set({ resumeApplied: true });
    }
  }

  return {
    status: "idle",
    request: null,
    scope: null,
    resolved: null,
    source: null,
    paused: false,
    position: 0,
    duration: 0,
    buffering: false,
    error: null,
    errorCount: 0,
    reresolved: false,
    resumeSeconds: 0,
    resumeApplied: false,
    resumeFor: null,
    loaded: false,
    selectedSubtitle: null,
    selectedAudioStreamIndex: undefined,
    selectedSourceHash: undefined,
    live: false,
    liveSources: [],
    selectedLiveSourceId: null,
    volume: 1,

    async open(req, scope = null) {
      resolveAbort?.abort();
      const ac = new AbortController();
      resolveAbort = ac;
      stopReporting();
      set({
        status: "resolving",
        request: req,
        scope,
        resolved: null,
        source: null,
        error: null,
        errorCount: 0,
        reresolved: false,
        position: 0,
        duration: 0,
        paused: false,
        buffering: true,
        resumeSeconds: 0,
        resumeApplied: false,
        resumeFor: null,
        loaded: false,
        selectedSubtitle: null,
        selectedAudioStreamIndex: undefined,
        selectedSourceHash: undefined,
        live: false,
        liveSources: [],
        selectedLiveSourceId: null,
      });
      // Fetch the saved resume position in parallel with resolving the source.
      void loadResumeSeconds(progressIdentity(req), scope, ac.signal).then((seconds) => {
        if (ac.signal.aborted || get().request !== req) return;
        set({ resumeSeconds: seconds, resumeFor: req });
        maybeApplyResume();
      });

      // Offline-first: a ready download plays from the local file with sidecar subtitles,
      // skipping the network resolve entirely. Reporting still runs (it no-ops offline and
      // updates Continue Watching when a connection is available).
      const offline = getReadyOfflineRecord(progressIdentity(req));
      if (offline?.videoPath) {
        const resolved = buildOfflineResolved(offline);
        beginReporting({
          request: req,
          resolved,
          identity: progressIdentity(req),
          scope,
          title: req.title,
          year: req.year,
          poster: req.poster,
        });
        set({
          status: "loading",
          resolved,
          source: { uri: offline.videoPath, isHls: false },
          buffering: true,
          selectedAudioStreamIndex: offline.meta.audioStreamIndex,
          selectedSourceHash: resolved.sourceHash,
        });
        return;
      }

      await runResolve(req, scope, { refresh: false }, ac, set);
    },

    // Re-resolve the current title with a different audio stream or source, keeping the
    // current position (re-seeks once the new source loads). Drops the subtitle choice —
    // the new source's track list may differ, so a stale index could show the wrong one.
    reopenWith(opts) {
      const { request, scope, position, selectedAudioStreamIndex, selectedSourceHash } = get();
      if (!request) return;
      resolveAbort?.abort();
      const ac = new AbortController();
      resolveAbort = ac;
      stopReporting();
      const audioStreamIndex = opts.audioStreamIndex ?? selectedAudioStreamIndex;
      const sourceHash = opts.sourceHash ?? selectedSourceHash;
      set({
        status: "resolving",
        buffering: true,
        error: null,
        errorCount: 0,
        reresolved: false,
        resolved: null,
        source: null,
        loaded: false,
        resumeApplied: false,
        resumeSeconds: position,
        resumeFor: request,
        selectedSubtitle: null,
      });
      void runResolve(request, scope, { audioStreamIndex, sourceHash }, ac, set);
    },

    // Open a live stream: no TMDB resolve, no resume, no reporting, no offline. Resolves
    // the chosen source option to a concrete HLS URL (sports/twitch resolve via the backend;
    // direct channels play as-is) and loads it; failures walk the source list.
    async openLive(req) {
      resolveAbort?.abort();
      const ac = new AbortController();
      resolveAbort = ac;
      stopReporting();
      const initial = req.sources.find((s) => s.id === req.initialSourceId) ?? req.sources[0];
      set({
        status: "resolving",
        request: null,
        scope: null,
        resolved: null,
        source: null,
        error: null,
        errorCount: 0,
        reresolved: false,
        position: 0,
        duration: 0,
        paused: false,
        buffering: true,
        resumeSeconds: 0,
        resumeApplied: false,
        resumeFor: null,
        loaded: false,
        selectedSubtitle: null,
        selectedAudioStreamIndex: undefined,
        selectedSourceHash: undefined,
        live: true,
        liveSources: req.sources,
        selectedLiveSourceId: initial?.id ?? null,
      });
      if (!initial) {
        set({ status: "error", error: "This channel has no playable stream.", buffering: false });
        return;
      }
      await loadLiveSource(initial, ac);
    },

    // Switch to a specific live source from the in-player picker (resets the fallback budget).
    switchLiveSource(sourceId) {
      const opt = get().liveSources.find((s) => s.id === sourceId);
      if (!opt) return;
      resolveAbort?.abort();
      const ac = new AbortController();
      resolveAbort = ac;
      set({ status: "resolving", buffering: true, error: null, errorCount: 0, paused: false, source: null, selectedLiveSourceId: sourceId });
      void loadLiveSource(opt, ac);
    },

    retry() {
      if (get().live) {
        const id = get().selectedLiveSourceId;
        const opt = get().liveSources.find((s) => s.id === id) ?? get().liveSources[0];
        if (opt) get().switchLiveSource(opt.id);
        return;
      }
      const req = get().request;
      if (req) void get().open(req, get().scope);
    },

    setSubtitle(index) {
      set({ selectedSubtitle: index });
    },

    onLoad(duration) {
      if (get().status === "idle" || (!get().request && !get().live)) return;
      set({
        duration: Number.isFinite(duration) && duration > 0 ? duration : get().duration,
        loaded: true,
        status: get().paused ? "paused" : "playing",
        buffering: false,
      });
      maybeApplyResume();
    },

    setProgress(position, duration) {
      if (get().status === "idle" || (!get().request && !get().live)) return;
      const next: Partial<PlayerState> = { position };
      if (Number.isFinite(duration) && duration > 0) next.duration = duration;
      // Sustained playback means the current source genuinely works — clear the error
      // budget so a later transient failure gets a fresh walk (and can't loop forever
      // between two flaky-but-loadable candidates). Live uses a shorter window so a
      // proven feed isn't declared dead over an early blip.
      const healthySeconds = get().live ? LIVE_HEALTHY_PLAYBACK_SECONDS : HEALTHY_PLAYBACK_SECONDS;
      if (position > healthySeconds && (get().errorCount > 0 || get().reresolved)) {
        next.errorCount = 0;
        next.reresolved = false;
      }
      set(next);
      // Live playback has no resume/Continue-Watching, so it never reports progress.
      if (!get().live) reportProgress(position, next.duration ?? get().duration);
    },

    onBuffer(buffering) {
      set({ buffering });
    },

    onEnd() {
      if (get().status === "idle") return;
      // A live stream "ending" means the feed dropped — walk to the next source.
      if (get().live) {
        get().onError("The live stream ended.");
        return;
      }
      if (!get().request) return;
      const { position, duration } = get();
      // A genuine finish lands near the end. Some dead/empty HLS embeds fire onEnd
      // immediately at position ~0 — treat that as a failed source (fallback walk),
      // never as "finished", so TV autoplay can't rapidly skip whole episodes.
      const realEnd = duration > 0 ? position >= duration * 0.85 : position > 60;
      if (realEnd) {
        reportNow(position, duration, true);
        // Stop reporting so the unmount's close()→reportNow can't re-create the
        // Continue-Watching row this finish just removed.
        stopReporting();
        set({ status: "ended", paused: true, buffering: false });
      } else {
        get().onError("This source ended before it played.");
      }
    },

    onError(message) {
      if (get().status === "idle" || (!get().request && !get().live)) return;
      // Live: walk the source list (no TMDB re-resolve / VOD fallback candidates).
      if (get().live) {
        failLiveSource(message);
        return;
      }
      const { resolved, errorCount, request, scope, reresolved } = get();
      reportPlaybackError(message);
      const attempt = errorCount + 1;

      // 1) Walk the in-place fallback candidates for the current resolved source.
      if (resolved && attempt <= MAX_ERRORS) {
        const candidates = buildFallbackCandidates(resolved);
        if (attempt <= candidates.length) {
          set({ errorCount: attempt, status: "loading", buffering: true, error: null, source: candidates[attempt - 1] });
          return;
        }
      }

      // 2) One fresh re-resolve (its own candidates get a new error budget).
      if (request && resolved && !reresolved) {
        resolveAbort?.abort();
        const ac = new AbortController();
        resolveAbort = ac;
        set({ reresolved: true, errorCount: 0, status: "resolving", buffering: true, error: null });
        void runResolve(request, scope, { refresh: true }, ac, set);
        return;
      }

      // 3) Out of options.
      set({ status: "error", error: message || "Playback error", buffering: false });
    },

    play() {
      set({ paused: false, status: "playing" });
    },
    pause() {
      if (!get().live) reportNow(get().position, get().duration);
      set({ paused: true, status: "paused" });
    },
    togglePlay() {
      get().paused ? get().play() : get().pause();
    },

    seekTo(seconds) {
      const duration = get().duration;
      const clamped = Math.max(0, duration > 0 ? Math.min(seconds, duration) : seconds);
      seekImpl?.(clamped);
      set({ position: clamped });
    },
    seekBy(delta) {
      get().seekTo(get().position + delta);
    },
    setVolume(v) {
      set({ volume: Math.max(0, Math.min(1, v)) });
    },

    close() {
      if (!get().live) reportNow(get().position, get().duration);
      stopReporting();
      resolveAbort?.abort();
      resolveAbort = null;
      set({
        status: "idle",
        request: null,
        scope: null,
        resolved: null,
        source: null,
        paused: false,
        position: 0,
        duration: 0,
        buffering: false,
        error: null,
        errorCount: 0,
        reresolved: false,
        resumeSeconds: 0,
        resumeApplied: false,
        resumeFor: null,
        loaded: false,
        selectedSubtitle: null,
        selectedAudioStreamIndex: undefined,
        selectedSourceHash: undefined,
        live: false,
        liveSources: [],
        selectedLiveSourceId: null,
      });
    },
  };
});

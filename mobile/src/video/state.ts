import { create } from "zustand";
import { getCachedPreferences, getSources, type ResolvedSource, type SourceSummary } from "@/lib/streamarena";
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

// If a freshly-loaded VOD source produces no playback (no onLoad / no progress) within
// this window, treat it as a dead/stalled server and auto-advance to the next one. This
// catches the silent-hang case — PNG-stego embeds that never emit a clean onError, so the
// error-driven fallback walk alone can't rescue them. Mirrors the web player's 6s bounded
// retry (src-ui/player/live-streams.js `createBoundedRetryController`).
// The transcode path needs ~10-15s to spin up (probe -> ffmpeg spawn -> first segments)
// before AVPlayer can render a frame, so the silent-stall window must outlast that — a
// shorter fuse skips even servers that DO work from the backend before they ever start.
// Hard failures (a 502 segment -> onError) still skip fast; this only backstops a source
// that loads its playlist but never produces video.
const STALL_FALLBACK_MS = 15000;
// A source still buffering when the fuse fires is loading, not hung: a cold transcode
// seeking to a deep resume offset (the exact case the web player's progress-aware switch
// watchdog protects — src-ui/pages/player.js) can take longer than the base window to render
// its first frame. Once a source has shown buffering activity, grant a bounded extra budget
// before walking, so a working-but-slow source isn't abandoned. Capped so a source that
// loads its playlist but never produces a frame is still walked (~30s worst case). VLC's
// bridge exposes no buffer-% stream, so "is it still loading" can only be "did it ever
// buffer" — hence a bounded extension rather than the web's re-arm-on-each-byte.
const STALL_EXTENSION_MS = 7500;
const MAX_STALL_EXTENSIONS = 2;
let stallTimer: ReturnType<typeof setTimeout> | null = null;
// Set once per armed window when VLC reports buffering; the only pre-first-frame "still
// loading" signal the engine surfaces. Reset on a fresh arm (new source), not on extension.
let sawBufferingSinceArm = false;
let stallExtensions = 0;
// Baseline for detecting *real* playback advancement (position actually climbing), which
// is the only trustworthy "this source works" signal. onLoad merely means the playlist
// parsed — a blocked/stego source still reaches onLoad and then sits frozen at 0:00. Reset
// whenever the timer (re)arms so each attempt is judged on its own progress.
let lastProgressSample: number | null = null;
function clearStallTimer() {
  if (stallTimer != null) {
    clearTimeout(stallTimer);
    stallTimer = null;
  }
}
function armStallTimer() {
  clearStallTimer();
  lastProgressSample = null;
  sawBufferingSinceArm = false;
  stallExtensions = 0;
  stallTimer = setTimeout(() => usePlayerStore.getState().onStall(), STALL_FALLBACK_MS);
}
// Re-arm for a shorter follow-on window after a stall fired while the source was still
// loading. Keeps the progress baseline (lastProgressSample) and the buffering flag so real
// advancement during the extension still clears via setProgress.
function extendStallTimer() {
  clearStallTimer();
  stallTimer = setTimeout(() => usePlayerStore.getState().onStall(), STALL_EXTENSION_MS);
}

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
  // Full server list for the title (lazily fetched on the first auto-fallback), and the
  // set of server hashes already attempted this run — the watchdog walks these so a dead
  // default server is skipped until one plays, and can't loop (each tried at most once).
  sources: SourceSummary[] | null;
  triedHashes: string[];
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
  onEnd: (info?: { fraction?: number }) => void;
  onError: (message?: string) => void;
  onStall: () => void;
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
    armStallTimer();
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
    // If playback has already advanced meaningfully past the saved point — e.g. a slow
    // continue-watching read resolves after the user has manually scrubbed ahead — applying
    // it now would yank them backward. Skip it. (The fallback re-seek paths set
    // resumeSeconds≈position, so position ≈ target there and this guard doesn't fire.)
    if (s.position > target + 5) {
      set({ resumeApplied: true });
      return;
    }
    const fits = target > 5 && (s.duration <= 0 || target < s.duration - 10);
    if (fits) {
      seekImpl?.(target);
      set({ position: target, resumeApplied: true });
    } else {
      set({ resumeApplied: true });
    }
  }

  // Auto-advance to the next untried server from the full source list (lazily fetched —
  // the same list the manual picker shows). Drives the stall watchdog and the exhausted
  // error path: a dead/blocked/stego default server is skipped until one actually plays.
  // Bounded by triedHashes (each server tried at most once) so it can't loop.
  async function advanceToNextServer(message?: string) {
    const { request, scope, position, sources, triedHashes, selectedSourceHash } = get();
    if (!request) {
      set({ status: "error", error: message || "Playback error", buffering: false });
      return;
    }
    const tried = new Set(triedHashes);
    if (selectedSourceHash) tried.add(selectedSourceHash);

    resolveAbort?.abort();
    const ac = new AbortController();
    resolveAbort = ac;
    stopReporting();

    let list = sources;
    if (!list) {
      try {
        const res = await getSources({
          tmdbId: request.tmdbId,
          mediaType: request.mediaType,
          title: request.title,
          year: request.year,
          seasonNumber: request.seasonNumber,
          episodeNumber: request.episodeNumber,
        });
        if (ac.signal.aborted) return;
        list = res.sources ?? [];
        set({ sources: list });
      } catch {
        list = [];
      }
    }
    if (ac.signal.aborted) return;

    const next = (list ?? []).find((src) => src.sourceHash && !tried.has(src.sourceHash));
    if (next?.sourceHash) {
      set({
        triedHashes: [...tried],
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
      await runResolve(request, scope, { sourceHash: next.sourceHash }, ac, set);
    } else {
      set({ status: "error", error: message || "No working server found for this title.", buffering: false });
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
    sources: null,
    triedHashes: [],
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
        sources: null,
        triedHashes: [],
        live: false,
        liveSources: [],
        selectedLiveSourceId: null,
      });
      clearStallTimer();
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
        triedHashes: [],
      });
      clearStallTimer();
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
      // onLoad means the playlist parsed — NOT that frames are flowing. A stalled source
      // (blocked CDN, or stego segments AVPlayer can't demux) still fires onLoad, then sits
      // at 0:00. So DON'T clear the watchdog here — leave the loading-armed window running so
      // the full ~15s startup budget applies; only real position advancement (setProgress)
      // clears it. Live keeps its own failLiveSource recovery.
      if (get().live) clearStallTimer();
      maybeApplyResume();
    },

    setProgress(position, duration) {
      if (get().status === "idle" || (!get().request && !get().live)) return;
      // Real advancement (position climbing past the previous sample) proves the source
      // actually plays — disarm the stall watchdog. A source frozen at 0:00 never advances,
      // so the watchdog survives to fire. The first sample only sets the baseline, which
      // makes this robust to a resume-seek jumping the position before playback begins.
      if (!get().live) {
        if (lastProgressSample != null && position > lastProgressSample + 0.3) {
          clearStallTimer();
        }
        lastProgressSample = position;
      }
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
      // Buffering while the stall watchdog is armed (VOD startup) is the "still loading"
      // signal that lets onStall grant an extension instead of walking a slow-but-working
      // source. Sticky for the window so a single transition still counts.
      if (buffering && stallTimer != null && !get().live) sawBufferingSinceArm = true;
      set({ buffering });
    },

    onEnd(info) {
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
      // The VLC path supplies a duration-independent 0..1 finish fraction (high-water mark
      // over playback); trust >= 0.85 as a real finish even when media length stayed 0,
      // which the position/duration heuristic alone would misread on those streams.
      const frac = info?.fraction;
      const realEnd =
        (frac != null && frac >= 0.85) || (duration > 0 ? position >= duration * 0.85 : position > 60);
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
      clearStallTimer();
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
          armStallTimer();
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

      // 3) In-place options exhausted — auto-advance to the next untried server (the same
      //    list the manual picker uses) before surfacing an error.
      void advanceToNextServer(message);
    },

    // Stall watchdog fired: a VOD source produced no playback within STALL_FALLBACK_MS.
    // Skip straight to the next server — a hung source rarely recovers via its own
    // fallbackUrls (they share the same dead upstream). Guarded so a late timer can't
    // act after playback actually began, or during live.
    onStall() {
      const s = get();
      // Fire only while genuinely stuck: VOD, a request is live, and the user hasn't paused
      // or stopped. Crucially do NOT skip on loaded/"playing" — onLoad flips status to
      // "playing" before a single frame plays, and that frozen-at-0:00 case is exactly what
      // we must escape. The timer only survives to here when no real progress happened.
      if (s.live || !s.request || s.paused) return;
      if (s.status === "idle" || s.status === "ended" || s.status === "error") return;
      // Showed buffering activity and budget remains? It's a slow start, not a hung source —
      // extend instead of walking, so a cold transcode spinning up to a deep resume offset
      // isn't abandoned. A frozen source that never buffered (or has run out of extensions)
      // falls through and is walked.
      if (sawBufferingSinceArm && stallExtensions < MAX_STALL_EXTENSIONS) {
        stallExtensions += 1;
        extendStallTimer();
        return;
      }
      clearStallTimer();
      reportPlaybackError("Source stalled before playback.");
      void advanceToNextServer("This title's servers aren't responding right now.");
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
      clearStallTimer();
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
        sources: null,
        triedHashes: [],
        live: false,
        liveSources: [],
        selectedLiveSourceId: null,
      });
    },
  };
});

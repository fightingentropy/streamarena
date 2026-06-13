/**
 * Subtitle timing offset.
 *
 * Lets the viewer nudge subtitle cues earlier or later when a track drifts
 * against the video (common with externally-sourced VTT subtitles).
 *
 * Sign convention: a **positive** offset *delays* subtitles (they appear
 * later); a **negative** offset advances them (they appear earlier).
 *
 * The offset is honoured two different ways depending on how the active
 * subtitle track renders:
 *   - Custom VTT overlay: the render loop looks up cues at
 *     `currentTime - offsetSeconds` (see `getOffsetSeconds`).
 *   - Native <track> cues: each cue's start/end time is shifted in place
 *     (see `applyToNativeTracks`).
 *
 * The value is persisted per source hash in localStorage so a correction
 * survives reloads and source re-resolution, mirroring the audio-sync feature.
 */
import { normalizeSourceHash } from "./sources.js";

export const SUBTITLE_OFFSET_STEP_MS = 250;
const SUBTITLE_OFFSET_MIN_MS = -30000;
const SUBTITLE_OFFSET_MAX_MS = 30000;
const STORAGE_KEY_PREFIX = "netflix-source-subtitle-offset:";

// Properties stashed on a native cue so repeated applications stay idempotent:
// the original (unshifted) timing is captured once, then every application
// recomputes start/end from that base rather than compounding.
const CUE_BASE_START = "__subtitleOffsetBaseStart";
const CUE_BASE_END = "__subtitleOffsetBaseEnd";

/**
 * Clamp + round an arbitrary value into a valid offset in milliseconds.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeSubtitleOffsetMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(
    SUBTITLE_OFFSET_MIN_MS,
    Math.min(SUBTITLE_OFFSET_MAX_MS, Math.round(parsed)),
  );
}

/**
 * Render a signed, human-friendly label for an offset, e.g. `+0.25s`,
 * `-1.5s`, or `0s`.
 *
 * @param {unknown} value  Offset in milliseconds.
 * @returns {string}
 */
export function formatSubtitleOffsetLabel(value) {
  const normalized = normalizeSubtitleOffsetMs(value);
  if (normalized === 0) {
    return "0s";
  }
  const seconds = (Math.abs(normalized) / 1000)
    .toFixed(2)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
  return `${normalized > 0 ? "+" : "-"}${seconds}s`;
}

function storageKeyForSource(sourceHash) {
  const normalizedHash = normalizeSourceHash(sourceHash);
  return normalizedHash ? `${STORAGE_KEY_PREFIX}${normalizedHash}` : "";
}

function readStoredOffsetMs(sourceHash) {
  const key = storageKeyForSource(sourceHash);
  if (!key) {
    return 0;
  }
  try {
    return normalizeSubtitleOffsetMs(window.localStorage.getItem(key));
  } catch {
    return 0;
  }
}

function writeStoredOffsetMs(sourceHash, offsetMs) {
  const key = storageKeyForSource(sourceHash);
  if (!key) {
    return;
  }
  try {
    if (offsetMs === 0) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, String(offsetMs));
    }
  } catch {
    // Ignore storage access issues (private mode, quota, etc.).
  }
}

/**
 * Create a stateful subtitle-offset controller. The current offset lives in
 * the closure so the player only has to hold a single reference.
 */
export function createSubtitleOffsetController() {
  let offsetMs = 0;
  // Tracks whether we've ever shifted native cues. Lets `applyToNativeTracks`
  // bail out cheaply on the common path (no offset, nothing ever shifted)
  // while still restoring base times after a reset back to zero.
  let hasShiftedNativeCues = false;

  function markNativeDirtyIfNeeded() {
    if (offsetMs !== 0) {
      hasShiftedNativeCues = true;
    }
  }

  return {
    getOffsetMs: () => offsetMs,
    getOffsetSeconds: () => offsetMs / 1000,
    getLabel: () => formatSubtitleOffsetLabel(offsetMs),

    /** Load the persisted offset for a freshly-activated source. */
    applyForSource(sourceHash) {
      offsetMs = readStoredOffsetMs(sourceHash);
      markNativeDirtyIfNeeded();
      return offsetMs;
    },

    /**
     * Nudge the offset by `deltaMs`, persisting the result. Returns `true`
     * when the value actually changed (i.e. not already at a clamp limit).
     */
    adjust(deltaMs, sourceHash) {
      const next = normalizeSubtitleOffsetMs(offsetMs + Number(deltaMs || 0));
      if (next === offsetMs) {
        return false;
      }
      offsetMs = next;
      markNativeDirtyIfNeeded();
      writeStoredOffsetMs(sourceHash, offsetMs);
      return true;
    },

    /** Reset to zero and clear persistence. Returns `true` if it changed. */
    reset(sourceHash) {
      if (offsetMs === 0) {
        return false;
      }
      offsetMs = 0;
      writeStoredOffsetMs(sourceHash, 0);
      return true;
    },

    /**
     * Shift native <track> cue times in place to honour the current offset.
     * Idempotent: each cue's original timing is captured once, then every
     * application recomputes start/end from that base.
     *
     * @param {TextTrackList|TextTrack[]|null} textTracks
     */
    applyToNativeTracks(textTracks) {
      if (offsetMs === 0 && !hasShiftedNativeCues) {
        return;
      }
      const offsetSeconds = offsetMs / 1000;
      let restoredToBase = offsetMs === 0;
      Array.from(textTracks || []).forEach((textTrack) => {
        const cues = textTrack && textTrack.cues;
        if (!cues) {
          return;
        }
        Array.from(cues).forEach((cue) => {
          if (!cue) {
            return;
          }
          try {
            if (typeof cue[CUE_BASE_START] !== "number") {
              cue[CUE_BASE_START] = cue.startTime;
              cue[CUE_BASE_END] = cue.endTime;
            }
            const nextStart = Math.max(0, cue[CUE_BASE_START] + offsetSeconds);
            const nextEnd = Math.max(
              nextStart + 0.05,
              cue[CUE_BASE_END] + offsetSeconds,
            );
            // Assign in the order that never transiently puts start past end,
            // which some cue implementations reject.
            if (offsetSeconds >= 0) {
              cue.endTime = nextEnd;
              cue.startTime = nextStart;
            } else {
              cue.startTime = nextStart;
              cue.endTime = nextEnd;
            }
          } catch {
            // Ignore cues that don't support time mutation.
          }
        });
      });
      // Once cues are back at their base timing there's nothing left to undo.
      if (restoredToBase) {
        hasShiftedNativeCues = false;
      }
    },
  };
}

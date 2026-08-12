import { parseWebVttCues } from "./subtitles.js";

export function findSubtitleCueAtTime(cues, timeSeconds) {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const cue = cues[mid];
    if (timeSeconds < cue.startSeconds) {
      hi = mid - 1;
    } else if (timeSeconds > cue.endSeconds) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
}

export function splitCustomSubtitleLines(value) {
  const normalized = String(value || "").replace(/\r/g, "").trim();
  if (!normalized) {
    return [];
  }
  let lines = normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 2) {
    lines = [lines.slice(0, -1).join(" "), lines[lines.length - 1]];
  }
  return lines;
}

export function applyCustomSubtitleText(
  overlay,
  value,
  createElement = (tag) => document.createElement(tag),
) {
  if (!overlay) {
    return;
  }
  const lines = splitCustomSubtitleLines(value);
  if (!lines.length) {
    overlay.hidden = true;
    overlay.textContent = "";
    return;
  }

  overlay.hidden = false;
  overlay.textContent = "";
  lines.forEach((line, lineIndex) => {
    const span = createElement("span");
    span.textContent = line;
    overlay.appendChild(span);
    if (lineIndex < lines.length - 1) {
      overlay.appendChild(createElement("br"));
    }
  });
}

export function createCustomSubtitleOverlay({
  getOverlay,
  getSelectedSubtitleStreamIndex,
  getCurrentTimeSeconds,
  getOffsetSeconds,
  isVideoPlaying,
  parseCues = parseWebVttCues,
  fetchFn = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  requestAnimationFrameFn = (callback) =>
    globalThis.requestAnimationFrame(callback),
  cancelAnimationFrameFn = (frameId) =>
    globalThis.cancelAnimationFrame(frameId),
  createElement = (tag) => document.createElement(tag),
} = {}) {
  let cues = [];
  let cueCursor = 0;
  let loadToken = 0;
  let rafId = 0;
  let lastRenderedCueIndex = -1;

  function setText(value) {
    applyCustomSubtitleText(getOverlay?.(), value, createElement);
  }

  function clear({ invalidateToken = false } = {}) {
    if (invalidateToken) {
      loadToken += 1;
    }
    cues = [];
    cueCursor = 0;
    lastRenderedCueIndex = -1;
    setText("");
  }

  function invalidateRenderedCue() {
    lastRenderedCueIndex = -1;
  }

  function render() {
    const overlay = getOverlay?.();
    const selectedIndex = Number(getSelectedSubtitleStreamIndex?.() ?? -1);
    if (!overlay || selectedIndex < 0) {
      if (lastRenderedCueIndex !== -1) {
        lastRenderedCueIndex = -1;
        setText("");
      }
      return;
    }
    if (!cues.length) {
      if (lastRenderedCueIndex !== -1) {
        lastRenderedCueIndex = -1;
        setText("");
      }
      return;
    }

    const currentTimeSeconds = Number(getCurrentTimeSeconds?.() || 0);
    if (!Number.isFinite(currentTimeSeconds) || currentTimeSeconds < 0) {
      return;
    }
    // Honour the viewer's subtitle delay: a positive offset makes cues appear
    // later, so we look them up against an earlier-shifted clock.
    const lookupSeconds =
      currentTimeSeconds - Number(getOffsetSeconds?.() || 0);

    let cueIndex =
      cueCursor >= 0 && cueCursor < cues.length ? cueCursor : -1;
    if (
      cueIndex >= 0 &&
      lookupSeconds >= cues[cueIndex].startSeconds &&
      lookupSeconds <= cues[cueIndex].endSeconds
    ) {
      if (lastRenderedCueIndex !== cueIndex) {
        lastRenderedCueIndex = cueIndex;
        setText(cues[cueIndex].text);
      }
      return;
    }

    const nextIndex = (cueCursor || 0) + 1;
    if (
      nextIndex < cues.length &&
      lookupSeconds >= cues[nextIndex].startSeconds &&
      lookupSeconds <= cues[nextIndex].endSeconds
    ) {
      cueCursor = nextIndex;
      if (lastRenderedCueIndex !== nextIndex) {
        lastRenderedCueIndex = nextIndex;
        setText(cues[nextIndex].text);
      }
      return;
    }

    cueIndex = findSubtitleCueAtTime(cues, lookupSeconds);
    if (cueIndex >= 0) {
      cueCursor = cueIndex;
      if (lastRenderedCueIndex !== cueIndex) {
        lastRenderedCueIndex = cueIndex;
        setText(cues[cueIndex].text);
      }
      return;
    }

    if (lastRenderedCueIndex !== -1) {
      lastRenderedCueIndex = -1;
      setText("");
    }
  }

  function startRafLoop() {
    if (rafId) {
      return;
    }
    function tick() {
      render();
      rafId = requestAnimationFrameFn(tick);
    }
    rafId = requestAnimationFrameFn(tick);
  }

  function stopRafLoop() {
    if (rafId) {
      cancelAnimationFrameFn(rafId);
      rafId = 0;
    }
  }

  async function loadFromTrack(track) {
    const vttUrl = String(track?.vttUrl || "").trim();
    if (!vttUrl) {
      clear({ invalidateToken: true });
      return false;
    }

    const requestToken = loadToken + 1;
    loadToken = requestToken;
    cues = [];
    cueCursor = 0;
    setText("");
    const overlay = getOverlay?.();
    if (overlay) {
      overlay.lang = String(track?.language || "en").trim() || "en";
    }

    try {
      const requestUrl = `${vttUrl}${vttUrl.includes("?") ? "&" : "?"}ts=${now()}`;
      const response = await fetchFn(requestUrl, { cache: "no-store" });
      if (!response.ok) {
        return false;
      }
      const rawVtt = await response.text();
      if (requestToken !== loadToken) {
        return false;
      }
      cues = parseCues(rawVtt);
      cueCursor = 0;
      lastRenderedCueIndex = -1;
      render();
      if (isVideoPlaying?.()) {
        startRafLoop();
      }
      return cues.length > 0;
    } catch {
      if (requestToken === loadToken) {
        clear();
      }
      return false;
    }
  }

  return {
    setText,
    clear,
    invalidateRenderedCue,
    render,
    startRafLoop,
    stopRafLoop,
    loadFromTrack,
  };
}

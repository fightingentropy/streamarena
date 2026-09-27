const EXPORT_PATH = "/api/download/export.mp4";
const MAX_EXPORT_FILENAME_CHARS = 80;

const MEDIA_EXTENSIONS = new Set([
  "mp4",
  "m4v",
  "mkv",
  "mk3d",
  "webm",
  "avi",
  "wmv",
  "ts",
  "m2ts",
  "mov",
  "mpg",
]);

export function sanitizeExportFilename(name) {
  const trimmed = String(name || "")
    .split(/[?#]/, 1)[0]
    .split(/[/\\]/)
    .pop()
    .trim();
  const dot = trimmed.lastIndexOf(".");
  const ext = dot >= 0 ? trimmed.slice(dot + 1).toLowerCase() : "";
  const stem = MEDIA_EXTENSIONS.has(ext) ? trimmed.slice(0, dot) : trimmed;
  const safe = stem
    .replace(/[^A-Za-z0-9 ._-]/g, "_")
    .replace(/_+/g, "_")
    .trim()
    .slice(0, MAX_EXPORT_FILENAME_CHARS);
  return safe;
}

export function buildSourceExportUrl(
  input,
  { audioStreamIndex = -1, filename = "" } = {},
) {
  const params = new URLSearchParams({ input: String(input || "") });
  if (Number.isFinite(audioStreamIndex) && audioStreamIndex >= 0) {
    params.set("audioStream", String(Math.floor(audioStreamIndex)));
  }
  const safeName = sanitizeExportFilename(filename);
  if (safeName) {
    params.set("filename", safeName);
  }
  return `${EXPORT_PATH}?${params.toString()}`;
}

export function pickCurrentPlaybackExportInput({
  activeTrackSourceInput = "",
  lastRequestedPlaybackSource = "",
  extractPlaybackSourceInput = (value) => String(value || "").trim(),
  parseLiveIframePlaybackSource = () => "",
} = {}) {
  const active = String(activeTrackSourceInput || "").trim();
  if (active) {
    return active;
  }
  const iframeInner = String(
    parseLiveIframePlaybackSource(lastRequestedPlaybackSource) || "",
  ).trim();
  if (iframeInner) {
    return iframeInner;
  }
  return extractPlaybackSourceInput(lastRequestedPlaybackSource);
}

export function startBrowserFileDownload(url, doc = globalThis.document) {
  if (!url || !doc?.createElement || !doc.body) {
    return false;
  }
  const link = doc.createElement("a");
  link.href = url;
  link.rel = "noopener";
  link.setAttribute("download", "");
  doc.body.appendChild(link);
  link.click();
  if (typeof link.remove === "function") {
    link.remove();
  } else {
    doc.body.removeChild(link);
  }
  return true;
}

export async function ensureExportUrlReady(url, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") {
    return true;
  }
  const response = await fetchImpl(url, {
    method: "HEAD",
    credentials: "same-origin",
  });
  if (response.status === 405 || response.status === 501) {
    return true;
  }
  if (!response.ok) {
    throw new Error("This source isn't ready to download yet.");
  }
  return true;
}

// Capture the current video and audio selection before the readiness request.
// Downloading never resolves another provider or changes playback.
export function createSourceDownloadController({
  getCurrentPlayback,
  onStateChange = () => {},
  fetchImpl = globalThis.fetch,
  documentRef = globalThis.document,
} = {}) {
  let state = "idle";
  let message = "";

  function setState(next, detail) {
    state = next;
    message = detail;
    onStateChange();
  }

  async function download() {
    if (state === "preparing") return;
    const playback = getCurrentPlayback();
    if (!playback?.input) {
      setState("error", "Wait for the video to load, then try again.");
      return;
    }
    const exportUrl = buildSourceExportUrl(playback.input, playback);
    setState("preparing", "Your video keeps playing while we prepare the MP4.");
    try {
      await ensureExportUrlReady(exportUrl, fetchImpl);
      if (!startBrowserFileDownload(exportUrl, documentRef)) {
        throw new Error("Unable to start the download. Please try again.");
      }
      // The browser owns the transfer; a link click is not completion proof.
      setState("handedOff", "Track progress in your browser’s downloads.");
    } catch (error) {
      setState("error", error?.message || "Unable to download this video.");
    }
  }

  return {
    download,
    getState: () => state,
    getStatusMessage: () => message,
  };
}

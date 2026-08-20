import { pickTorrentResolverProvider } from "../lib/real-debrid-settings.js";

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

export function pickResolvedExportInput(
  resolved,
  extractPlaybackSourceInput = (value) => String(value || "").trim(),
) {
  const sourceInput = String(resolved?.sourceInput || "").trim();
  if (sourceInput) {
    return sourceInput;
  }
  return extractPlaybackSourceInput(resolved?.playableUrl || "");
}

export function pickExportFilename(option = {}, resolved = null) {
  return String(
    resolved?.filename || option?.filename || option?.primary || "",
  ).trim();
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

function currentExportAudioStreamIndex(
  resolved,
  activeAudioStreamIndex,
  selectedAudioStreamIndex,
) {
  const resolvedIndex = Number(resolved?.selectedAudioStreamIndex);
  if (Number.isFinite(resolvedIndex) && resolvedIndex >= 0) {
    return resolvedIndex;
  }
  if (activeAudioStreamIndex >= 0) {
    return activeAudioStreamIndex;
  }
  return selectedAudioStreamIndex;
}

export function createSourceDownloadController({
  normalizeSourceHash,
  getSelectedSourceHash,
  getPendingSourceSwitchHash,
  getActiveTrackSourceInput,
  getLastRequestedPlaybackSource,
  extractPlaybackSourceInput,
  parseLiveIframePlaybackSource,
  isTmdbResolvedPlayback,
  getSourceOptionByHash,
  isSourceOptionEmbed,
  getManualSourceSwitchTimeouts,
  getUserLocalTorrentEnabled,
  getUserRealDebridConfigured,
  getPreferredResolverProvider,
  setPreferredResolverProvider,
  resolveTmdbSourcesAndPlay,
  getActiveAudioStreamIndex,
  getSelectedAudioStreamIndex,
  getCurrentTmdbResolvedFilename,
  normalizeResolverFailureMessage,
  syncSourceSelectionState,
  renderSelectedSourceDetails,
  fetchImpl = globalThis.fetch,
  documentRef = globalThis.document,
} = {}) {
  let downloadingSourceHash = "";
  let requestToken = 0;
  let statusMessage = "";

  async function resolveSourceExportInput(sourceHash, option) {
    const isCurrentPlayingSource =
      sourceHash === normalizeSourceHash(getSelectedSourceHash()) &&
      !getPendingSourceSwitchHash();
    if (isCurrentPlayingSource) {
      const currentInput = pickCurrentPlaybackExportInput({
        activeTrackSourceInput: getActiveTrackSourceInput(),
        lastRequestedPlaybackSource: getLastRequestedPlaybackSource(),
        extractPlaybackSourceInput,
        parseLiveIframePlaybackSource,
      });
      if (currentInput) {
        return { input: currentInput, resolved: null };
      }
    }
    if (!isTmdbResolvedPlayback()) {
      throw new Error("This source isn't ready to download yet.");
    }
    const switchingToEmbed = Boolean(option && isSourceOptionEmbed(option));
    const timeouts = getManualSourceSwitchTimeouts({
      isEmbed: switchingToEmbed,
      localTorrentEnabled: getUserLocalTorrentEnabled(),
      realDebridConfigured: getUserRealDebridConfigured(),
      resolverProvider: getPreferredResolverProvider(),
    });
    const result = await resolveTmdbSourcesAndPlay({
      allowSourceFallback: false,
      applyPlayback: false,
      requiredSourceHash: sourceHash,
      requestSourceHash: sourceHash,
      resolveTimeoutMs: timeouts.resolveTimeoutMs,
      skipExternalEmbed:
        !switchingToEmbed && (
          getUserRealDebridConfigured() || getUserLocalTorrentEnabled()
        ),
    });
    const input = pickResolvedExportInput(
      result?.resolved,
      extractPlaybackSourceInput,
    );
    if (!input) {
      throw new Error("This source isn't ready to download yet.");
    }
    return { input, resolved: result.resolved };
  }

  function applyStatus(detailsEl) {
    if (!detailsEl || !statusMessage) {
      return false;
    }
    detailsEl.hidden = false;
    detailsEl.textContent = statusMessage;
    return true;
  }

  function syncButtons(container) {
    if (!container || typeof container.querySelectorAll !== "function") {
      return;
    }
    const downloadingHash = normalizeSourceHash(downloadingSourceHash);
    container.querySelectorAll(".source-option-download").forEach((button) => {
      const optionHash = normalizeSourceHash(button.dataset.sourceHash || "");
      const isDownloading =
        Boolean(downloadingHash) && optionHash === downloadingHash;
      button.classList.toggle("is-loading", isDownloading);
      button.disabled = Boolean(downloadingHash);
      button.setAttribute("aria-busy", isDownloading ? "true" : "false");
      const idleLabel = button.dataset.downloadLabel || "Download";
      button.setAttribute(
        "aria-label",
        isDownloading ? "Preparing download" : idleLabel,
      );
      button.title = isDownloading ? "Preparing download" : "Download";
    });
  }

  async function download(nextSourceHash) {
    const sourceHash = normalizeSourceHash(nextSourceHash);
    if (!sourceHash) {
      return;
    }
    const token = ++requestToken;
    const option = getSourceOptionByHash(sourceHash);
    const previousResolverProvider = getPreferredResolverProvider();
    setPreferredResolverProvider(pickTorrentResolverProvider({
      currentProvider: previousResolverProvider,
      isEmbed: Boolean(option && isSourceOptionEmbed(option)),
      realDebridActive: getUserRealDebridConfigured(),
      localTorrentEnabled: getUserLocalTorrentEnabled(),
    }));
    downloadingSourceHash = sourceHash;
    statusMessage = "Preparing download — current stream keeps playing.";
    syncSourceSelectionState();
    renderSelectedSourceDetails();
    try {
      const { input, resolved } = await resolveSourceExportInput(
        sourceHash,
        option,
      );
      if (token !== requestToken) {
        return;
      }
      const exportUrl = buildSourceExportUrl(input, {
        audioStreamIndex: currentExportAudioStreamIndex(
          resolved,
          getActiveAudioStreamIndex(),
          getSelectedAudioStreamIndex(),
        ),
        filename: pickExportFilename(option || {}, {
          filename: resolved?.filename || getCurrentTmdbResolvedFilename(),
        }),
      });
      await ensureExportUrlReady(exportUrl, fetchImpl);
      if (token !== requestToken) {
        return;
      }
      startBrowserFileDownload(exportUrl, documentRef);
      statusMessage = "";
    } catch (error) {
      if (token !== requestToken) {
        return;
      }
      statusMessage = normalizeResolverFailureMessage(
        error,
        "Unable to download this source.",
      );
    } finally {
      if (token === requestToken) {
        downloadingSourceHash = "";
        setPreferredResolverProvider(previousResolverProvider);
        syncSourceSelectionState();
        renderSelectedSourceDetails();
      }
    }
  }

  return {
    download,
    applyStatus,
    syncButtons,
    getDownloadingSourceHash: () => downloadingSourceHash,
    getStatusMessage: () => statusMessage,
  };
}

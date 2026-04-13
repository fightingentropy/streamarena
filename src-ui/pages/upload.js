import html from "solid-js/html";
import { onMount } from "solid-js";
import { escapeHtml } from "../shared.js";
import {
  formatBytes,
  formatDuration,
  normalizeFileExtension,
  detectCompatibilityInfoFromFilename,
} from "../lib/format.js";

export default function UploadPage() {
  // ─── Ref declarations (replacing document.getElementById) ───
  let fileInput, dropZone, uploadForm, submitButton, statusNode;
  let uploadProgressWrap, uploadProgressText, uploadProgressBytes, uploadProgressBar;
  let compatibilityActions, transcodeAudioToAacCheckbox;
  let selectedMediaCard, selectedMediaThumb, selectedMediaName, selectedMediaMeta, selectedMediaPlan;
  let changeFileButton, processingTimeline;
  let seriesTitleFieldLabel, seasonNumberFieldLabel, episodeNumberFieldLabel, episodeTitleFieldLabel;
  let uploadSeriesContext, uploadSeriesContextTitle, uploadSeriesContextMeta;

let selectedFile = null;
let pendingCompatibilityWarning = "";
let pendingCanOfferAudioTranscode = false;
let selectedPreviewRequestVersion = 0;
let isProcessingUpload = false;
let activeSeriesUploadContext = null;

function setDropzoneState(hasFile) {
  if (dropZone) {
    dropZone.hidden = Boolean(hasFile);
  }
  if (selectedMediaCard) {
    selectedMediaCard.hidden = !hasFile;
  }
}

function setUploadProgress(uploadedBytes, totalBytes) {
  const safeTotal = Math.max(1, Number(totalBytes) || 1);
  const safeUploaded = Math.max(
    0,
    Math.min(safeTotal, Math.floor(Number(uploadedBytes) || 0)),
  );
  const percent = Math.max(
    0,
    Math.min(100, Math.round((safeUploaded / safeTotal) * 100)),
  );

  if (uploadProgressWrap) {
    uploadProgressWrap.hidden = false;
  }
  if (uploadProgressBar) {
    uploadProgressBar.style.width = `${percent}%`;
  }
  if (uploadProgressText) {
    uploadProgressText.textContent = `Uploading... ${percent}%`;
  }
  if (uploadProgressBytes) {
    uploadProgressBytes.textContent = `${formatBytes(safeUploaded)} / ${formatBytes(safeTotal)}`;
  }
}

function hideUploadProgress() {
  if (uploadProgressWrap) {
    uploadProgressWrap.hidden = true;
  }
}

function setStatus(message, type = "") {
  statusNode.textContent = String(message || "");
  statusNode.classList.remove("error", "success", "warning");
  if (type) {
    statusNode.classList.add(type);
  }
}


function updateCompatibilityActions() {
  const shouldShow =
    pendingCanOfferAudioTranscode &&
    transcodeAudioToAacCheckbox instanceof HTMLInputElement;
  if (compatibilityActions) {
    compatibilityActions.hidden = !shouldShow;
  }
  if (!shouldShow && transcodeAudioToAacCheckbox instanceof HTMLInputElement) {
    transcodeAudioToAacCheckbox.checked = false;
  }
}

function withCompatibilityWarning(message) {
  const base = String(message || "").trim();
  const warning = String(pendingCompatibilityWarning || "").trim();
  if (!warning) {
    return base;
  }
  return `${base} Warning: ${warning}`.trim();
}


function getTranscodeAudioSetting() {
  if (!(transcodeAudioToAacCheckbox instanceof HTMLInputElement)) {
    return true;
  }
  if (pendingCanOfferAudioTranscode) {
    return transcodeAudioToAacCheckbox.checked;
  }
  return true;
}

function buildSelectedFilePlan(file) {
  const ext = normalizeFileExtension(file?.name || "");
  const steps = [];
  if (ext === ".mkv") {
    steps.push("MKV will be remuxed to MP4 during processing.");
  } else {
    steps.push("MP4 container will be kept.");
  }
  steps.push("Codec compatibility will be checked after upload.");
  if (getTranscodeAudioSetting()) {
    steps.push(
      "If audio codec is unsupported in Chrome, audio will transcode to AAC.",
    );
  } else {
    steps.push("Audio transcode is disabled for this upload.");
  }
  return steps.join(" ");
}

function updateSelectedFilePlan() {
  if (!selectedMediaPlan || !(selectedFile instanceof File)) {
    return;
  }
  selectedMediaPlan.textContent = buildSelectedFilePlan(selectedFile);
}

function renderProcessingTimeline(steps = []) {
  if (!processingTimeline) {
    return;
  }
  const list = Array.isArray(steps) ? steps : [];
  processingTimeline.hidden = list.length === 0;
  processingTimeline.innerHTML = list
    .map((step) => {
      const state = String(step?.state || "pending");
      const text = escapeHtml(step?.text || "");
      return `<div class="processing-step" data-state="${escapeHtml(state)}">${text}</div>`;
    })
    .join("");
}

function renderIdleProcessingTimeline(file) {
  const ext = normalizeFileExtension(file?.name || "");
  const willRemux = ext === ".mkv";
  renderProcessingTimeline([
    { state: "pending", text: "Step 1: Upload file in chunks." },
    {
      state: "pending",
      text: willRemux
        ? "Step 2: Remux MKV -> MP4 (video/audio stream copy)."
        : "Step 2: Validate MP4 and probe codecs.",
    },
    {
      state: "pending",
      text: getTranscodeAudioSetting()
        ? "Step 3: If needed, transcode audio to AAC for Chrome playback."
        : "Step 3: Audio transcode disabled.",
    },
  ]);
}

function resetSelectedMediaCard() {
  setDropzoneState(false);
  if (selectedMediaThumb instanceof HTMLImageElement) {
    selectedMediaThumb.removeAttribute("src");
  }
  if (selectedMediaName) {
    selectedMediaName.textContent = "Selected file";
  }
  if (selectedMediaMeta) {
    selectedMediaMeta.textContent = "File details";
  }
  if (selectedMediaPlan) {
    selectedMediaPlan.textContent = "Processing plan";
  }
}

function getObjectUrlImageDataUrl(file, width = 960) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.src = objectUrl;

    const cleanup = () => {
      URL.revokeObjectURL(objectUrl);
      video.removeAttribute("src");
      video.load();
    };

    video.onerror = () => {
      cleanup();
      reject(new Error("Could not read selected video metadata."));
    };

    video.onloadedmetadata = async () => {
      try {
        const durationSeconds = Number(video.duration) || 0;
        const videoWidth = Number(video.videoWidth) || 0;
        const videoHeight = Number(video.videoHeight) || 0;
        const seekTime =
          durationSeconds > 2
            ? Math.max(
                0,
                Math.min(durationSeconds - 0.2, durationSeconds * 0.1),
              )
            : 0;
        if (seekTime > 0) {
          await new Promise((resolveSeek) => {
            video.onseeked = () => resolveSeek();
            video.currentTime = seekTime;
          });
        }
        const renderWidth = Math.max(320, Math.min(width, videoWidth || width));
        const renderHeight = videoHeight
          ? Math.max(
              180,
              Math.round((renderWidth * videoHeight) / Math.max(1, videoWidth)),
            )
          : Math.round(renderWidth * (9 / 16));
        const canvas = document.createElement("canvas");
        canvas.width = renderWidth;
        canvas.height = renderHeight;
        const context = canvas.getContext("2d");
        if (context) {
          context.drawImage(video, 0, 0, renderWidth, renderHeight);
        }
        const thumbnailDataUrl = canvas.toDataURL("image/jpeg", 0.82);
        cleanup();
        resolve({
          durationSeconds,
          width: videoWidth,
          height: videoHeight,
          thumbnailDataUrl,
        });
      } catch (error) {
        cleanup();
        reject(
          error instanceof Error
            ? error
            : new Error("Could not render thumbnail."),
        );
      }
    };
  });
}

async function hydrateSelectedMediaCard(file) {
  if (!(file instanceof File)) {
    return;
  }
  const requestVersion = ++selectedPreviewRequestVersion;
  setDropzoneState(true);
  if (selectedMediaThumb instanceof HTMLImageElement) {
    selectedMediaThumb.src = "assets/images/thumbnail.jpg";
  }
  if (selectedMediaName) {
    selectedMediaName.textContent = file.name;
  }
  if (selectedMediaMeta) {
    const ext = normalizeFileExtension(file.name)
      .replace(".", "")
      .toUpperCase();
    selectedMediaMeta.textContent = `${ext || "VIDEO"} • ${formatBytes(file.size)} • Reading metadata...`;
  }
  updateSelectedFilePlan();
  renderIdleProcessingTimeline(file);

  try {
    const preview = await getObjectUrlImageDataUrl(file);
    if (requestVersion !== selectedPreviewRequestVersion) {
      return;
    }
    const resolutionText =
      preview.width && preview.height
        ? `${preview.width}x${preview.height}`
        : "Unknown resolution";
    const durationText = preview.durationSeconds
      ? formatDuration(preview.durationSeconds)
      : "Unknown duration";
    const ext = normalizeFileExtension(file.name)
      .replace(".", "")
      .toUpperCase();
    if (selectedMediaMeta) {
      selectedMediaMeta.textContent = `${ext || "VIDEO"} • ${formatBytes(file.size)} • ${resolutionText} • ${durationText}`;
    }
    if (
      selectedMediaThumb instanceof HTMLImageElement &&
      preview.thumbnailDataUrl
    ) {
      selectedMediaThumb.src = preview.thumbnailDataUrl;
    }
  } catch {
    if (requestVersion !== selectedPreviewRequestVersion) {
      return;
    }
    if (selectedMediaThumb instanceof HTMLImageElement) {
      selectedMediaThumb.src = "assets/images/thumbnail.jpg";
    }
    if (selectedMediaMeta) {
      const ext = normalizeFileExtension(file.name)
        .replace(".", "")
        .toUpperCase();
      selectedMediaMeta.textContent = `${ext || "VIDEO"} • ${formatBytes(file.size)} • Metadata unavailable`;
    }
  }
}

function updateSubmitState() {
  if (isProcessingUpload) {
    submitButton.disabled = true;
    return;
  }
  submitButton.disabled = !(selectedFile instanceof File);
}

function setUploadBusyState(isBusy) {
  isProcessingUpload = Boolean(isBusy);
  const controls = uploadForm?.querySelectorAll(
    "input, textarea, button, select",
  );
  controls?.forEach((control) => {
    if (control instanceof HTMLInputElement && control.type === "hidden") {
      return;
    }
    control.disabled = isProcessingUpload;
  });
  if (fileInput instanceof HTMLInputElement) {
    fileInput.disabled = isProcessingUpload;
  }
  if (changeFileButton instanceof HTMLButtonElement) {
    changeFileButton.disabled = isProcessingUpload;
  }
  if (isProcessingUpload) {
    submitButton.disabled = true;
  } else {
    updateSubmitState();
  }
}

function normalizeContentType(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "episode" || normalized === "course") {
    return normalized;
  }
  return "movie";
}

function parseSeriesUploadContextFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const mode = String(params.get("mode") || "")
    .trim()
    .toLowerCase();
  if (mode !== "add-episode" && mode !== "series-episode") {
    return null;
  }

  const contentType = normalizeContentType(
    params.get("contentType") || "episode",
  );
  if (contentType === "movie") {
    return null;
  }

  const seriesId = String(params.get("seriesId") || "").trim();
  const seriesTitle = String(params.get("seriesTitle") || "").trim();
  if (!seriesId && !seriesTitle) {
    return null;
  }
  const seasonNumber = Number(params.get("seasonNumber") || 1);
  const episodeNumber = Number(params.get("episodeNumber") || 1);
  const defaultEpisodeLabel = contentType === "course" ? "Lesson" : "Episode";

  return {
    contentType,
    seriesId,
    seriesTitle,
    thumb: String(params.get("thumb") || "").trim(),
    seasonNumber:
      Number.isFinite(seasonNumber) && seasonNumber >= 1
        ? Math.floor(seasonNumber)
        : 1,
    episodeNumber:
      Number.isFinite(episodeNumber) && episodeNumber >= 1
        ? Math.floor(episodeNumber)
        : 1,
    episodeTitle:
      String(params.get("episodeTitle") || "").trim() ||
      `${defaultEpisodeLabel} ${Number.isFinite(episodeNumber) && episodeNumber >= 1 ? Math.floor(episodeNumber) : 1}`,
  };
}

function setInputPlaceholderForContentType(input, contentType) {
  if (!(input instanceof HTMLInputElement)) {
    return;
  }
  const seriesPlaceholder = String(input.dataset.seriesPlaceholder || "").trim();
  const coursePlaceholder = String(input.dataset.coursePlaceholder || "").trim();
  if (contentType === "course" && coursePlaceholder) {
    input.placeholder = coursePlaceholder;
    return;
  }
  if (seriesPlaceholder) {
    input.placeholder = seriesPlaceholder;
  }
}

function updateSeriesFieldCopy(contentType) {
  const isCourse = contentType === "course";
  if (seriesTitleFieldLabel) {
    seriesTitleFieldLabel.textContent = isCourse ? "Course Title" : "Series Title";
  }
  if (seasonNumberFieldLabel) {
    seasonNumberFieldLabel.textContent = isCourse ? "Module" : "Season";
  }
  if (episodeNumberFieldLabel) {
    episodeNumberFieldLabel.textContent = isCourse ? "Lesson" : "Episode";
  }
  if (episodeTitleFieldLabel) {
    episodeTitleFieldLabel.textContent = isCourse
      ? "Lesson Title"
      : "Episode Title";
  }

  const seriesTitleInput = uploadForm?.elements?.namedItem("seriesTitle");
  const episodeTitleInput = uploadForm?.elements?.namedItem("episodeTitle");
  setInputPlaceholderForContentType(seriesTitleInput, contentType);
  setInputPlaceholderForContentType(episodeTitleInput, contentType);
}

function getSelectedContentType() {
  const selected = uploadForm.querySelector(
    'input[name="contentType"]:checked',
  );
  return normalizeContentType(selected?.value || "movie");
}

function updateFormForContentType() {
  const contentType = getSelectedContentType();
  const isSeriesLike = contentType === "episode" || contentType === "course";
  document.querySelectorAll(".movie-only").forEach((node) => {
    node.hidden = isSeriesLike;
  });
  document.querySelectorAll(".episode-only").forEach((node) => {
    node.hidden = !isSeriesLike;
  });
  if (contentType === "course") {
    const tmdbField = uploadForm?.elements?.namedItem("tmdbId");
    if (tmdbField instanceof HTMLInputElement) {
      tmdbField.value = "";
    }
  }
  if (isSeriesLike) {
    const titleField = uploadForm?.elements?.namedItem("title");
    const seriesTitleField = uploadForm?.elements?.namedItem("seriesTitle");
    if (
      titleField instanceof HTMLInputElement &&
      seriesTitleField instanceof HTMLInputElement &&
      !String(seriesTitleField.value || "").trim() &&
      String(titleField.value || "").trim()
    ) {
      seriesTitleField.value = String(titleField.value || "").trim();
    }
  }
  updateSeriesFieldCopy(contentType);
}

function selectFile(file) {
  if (!(file instanceof File)) {
    return;
  }
  const ext = normalizeFileExtension(file.name);
  if (!ext) {
    selectedFile = null;
    selectedPreviewRequestVersion += 1;
    dropZone.classList.remove("has-file");
    resetSelectedMediaCard();
    hideUploadProgress();
    renderProcessingTimeline([]);
    pendingCompatibilityWarning = "";
    pendingCanOfferAudioTranscode = false;
    updateCompatibilityActions();
    setStatus("Only .mp4 and .mkv files are supported.", "error");
    updateSubmitState();
    return;
  }

  selectedFile = file;
  dropZone.classList.add("has-file");
  hideUploadProgress();
  setDropzoneState(true);
  const compatibilityInfo = detectCompatibilityInfoFromFilename(file.name);
  pendingCompatibilityWarning = compatibilityInfo.warning;
  pendingCanOfferAudioTranscode = compatibilityInfo.canOfferAudioTranscode;
  updateCompatibilityActions();
  if (
    pendingCanOfferAudioTranscode &&
    transcodeAudioToAacCheckbox instanceof HTMLInputElement
  ) {
    transcodeAudioToAacCheckbox.checked = true;
  }
  setStatus(
    withCompatibilityWarning(`Selected: ${file.name}`),
    pendingCompatibilityWarning ? "warning" : "",
  );
  updateSubmitState();
  void hydrateSelectedMediaCard(file);
  void inferAndPopulateMetadata(file);
}

fileInput?.addEventListener("change", (event) => {
  const file = event.target.files?.[0] || null;
  selectFile(file);
});

dropZone?.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("is-active");
});

dropZone?.addEventListener("dragleave", () => {
  dropZone.classList.remove("is-active");
});

dropZone?.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("is-active");
  const file = event.dataTransfer?.files?.[0] || null;
  selectFile(file);
});

changeFileButton?.addEventListener("click", () => {
  fileInput?.click();
});

transcodeAudioToAacCheckbox?.addEventListener("change", () => {
  updateSelectedFilePlan();
  if (selectedFile instanceof File) {
    renderIdleProcessingTimeline(selectedFile);
  }
});

uploadForm?.addEventListener("change", (event) => {
  if (
    event.target instanceof HTMLInputElement &&
    event.target.name === "contentType"
  ) {
    updateFormForContentType();
  }
});

uploadForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!(selectedFile instanceof File)) {
    setStatus("Choose a file first.", "error");
    return;
  }

  setUploadBusyState(true);
  setUploadProgress(0, selectedFile.size);
  renderProcessingTimeline([
    { state: "active", text: "Step 1: Uploading file chunks..." },
    {
      state: "pending",
      text: "Step 2: Finalizing container and probing codecs...",
    },
    { state: "pending", text: "Step 3: Updating library metadata..." },
  ]);
  setStatus("Uploading and processing file...", "");

  let shouldRedirectHome = false;
  try {
    const payload = await uploadViaChunkSession(selectedFile);

    const converted = payload?.convertedFromMkv ? " (MKV remuxed to MP4)" : "";
    const audioConverted = payload?.audioTranscodedToAac
      ? " (Audio transcoded to AAC)"
      : "";
    const conversionSummary = `${converted}${audioConverted}`;
    const chromeCompatibility = payload?.chromeCompatibility || null;
    const compatibilityWarning = String(
      chromeCompatibility?.warning || "",
    ).trim();
    if (
      chromeCompatibility &&
      chromeCompatibility.isLikelyCompatible === false
    ) {
      renderProcessingTimeline([
        { state: "done", text: "Step 1: Upload complete." },
        {
          state: "done",
          text: payload?.convertedFromMkv
            ? "Step 2: MKV remuxed to MP4."
            : "Step 2: Container finalized.",
        },
        {
          state: payload?.audioTranscodedToAac ? "done" : "error",
          text: payload?.audioTranscodedToAac
            ? "Step 3: Audio transcoded to AAC."
            : "Step 3: Audio remains potentially incompatible.",
        },
      ]);
      setStatus(
        `Upload complete${conversionSummary}. Warning: ${compatibilityWarning || "This file is likely not Chrome-compatible (codec/container)."} Refresh Home to see it.`,
        "warning",
      );
      shouldRedirectHome = true;
      window.setTimeout(() => {
        window.location.href = "/";
      }, 900);
    } else if (chromeCompatibility && chromeCompatibility.checked === false) {
      renderProcessingTimeline([
        { state: "done", text: "Step 1: Upload complete." },
        {
          state: "done",
          text: payload?.convertedFromMkv
            ? "Step 2: MKV remuxed to MP4."
            : "Step 2: Container finalized.",
        },
        {
          state: "pending",
          text: "Step 3: Compatibility check could not be verified.",
        },
      ]);
      setStatus(
        `Upload complete${conversionSummary}. Note: could not verify Chrome compatibility. Refresh Home to see it.`,
        "warning",
      );
      shouldRedirectHome = true;
      window.setTimeout(() => {
        window.location.href = "/";
      }, 900);
    } else {
      renderProcessingTimeline([
        { state: "done", text: "Step 1: Upload complete." },
        {
          state: "done",
          text: payload?.convertedFromMkv
            ? "Step 2: MKV remuxed to MP4."
            : "Step 2: Container finalized.",
        },
        {
          state: "done",
          text: payload?.audioTranscodedToAac
            ? "Step 3: Audio transcoded to AAC for Chrome."
            : "Step 3: Codec compatibility verified.",
        },
      ]);
      setStatus(
        `Upload complete${conversionSummary}. Chrome compatibility looks good. Refresh Home to see it.`,
        "success",
      );
      shouldRedirectHome = true;
      window.setTimeout(() => {
        window.location.href = "/";
      }, 900);
    }
  } catch (error) {
    renderProcessingTimeline([
      { state: "done", text: "Step 1: Upload attempt finished." },
      {
        state: "error",
        text: "Step 2: Processing failed before library update.",
      },
    ]);
    setStatus(
      error instanceof Error ? error.message : "Upload failed.",
      "error",
    );
  } finally {
    if (!shouldRedirectHome) {
      hideUploadProgress();
      setUploadBusyState(false);
      updateSubmitState();
    }
  }
});

function readUploadMetadataFromForm() {
  const formData = new FormData(uploadForm);
  const contextContentType = normalizeContentType(
    activeSeriesUploadContext?.contentType || "",
  );
  const contentType = activeSeriesUploadContext
    ? contextContentType
    : normalizeContentType(formData.get("contentType"));
  const transcodeAudioToAac = getTranscodeAudioSetting();
  const isSeriesLike = contentType === "episode" || contentType === "course";
  const contextSeriesId = String(activeSeriesUploadContext?.seriesId || "").trim();
  const contextSeriesTitle = String(
    activeSeriesUploadContext?.seriesTitle || "",
  ).trim();
  const contextSeasonNumber = Number(activeSeriesUploadContext?.seasonNumber || 1);
  const contextEpisodeNumber = Number(
    activeSeriesUploadContext?.episodeNumber || 1,
  );
  const contextEpisodeTitle = String(
    activeSeriesUploadContext?.episodeTitle || "",
  ).trim();
  const contextThumb = String(activeSeriesUploadContext?.thumb || "").trim();
  return {
    contentType,
    title: isSeriesLike ? "" : String(formData.get("title") || ""),
    year: isSeriesLike ? "" : String(formData.get("year") || ""),
    description: String(formData.get("description") || ""),
    thumb: String(formData.get("thumb") || contextThumb || ""),
    tmdbId: String(formData.get("tmdbId") || ""),
    seriesId: isSeriesLike
      ? contextSeriesId || String(formData.get("seriesId") || "")
      : "",
    seriesTitle: isSeriesLike
      ? contextSeriesTitle || String(formData.get("seriesTitle") || "")
      : "",
    seasonNumber: isSeriesLike
      ? contextSeasonNumber || Number(formData.get("seasonNumber") || 1)
      : 1,
    episodeNumber: isSeriesLike
      ? contextEpisodeNumber || Number(formData.get("episodeNumber") || 1)
      : 1,
    episodeTitle: isSeriesLike
      ? contextEpisodeTitle || String(formData.get("episodeTitle") || "")
      : "",
    transcodeAudioToAac,
  };
}

async function uploadViaChunkSession(file) {
  const metadata = readUploadMetadataFromForm();
  const ext = normalizeFileExtension(file?.name || "");
  const willRemux = ext === ".mkv";
  const startResponse = await fetch("/api/upload/session/start", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...metadata,
      fileName: file.name,
      fileSize: file.size,
    }),
  });
  const startPayload = await startResponse.json().catch(() => null);
  if (!startResponse.ok) {
    throw new Error(
      startPayload?.error || `Failed to start upload (${startResponse.status})`,
    );
  }
  const sessionId = String(startPayload?.sessionId || "").trim();
  if (!sessionId) {
    throw new Error("Upload session did not return a sessionId.");
  }

  const chunkSize = 32 * 1024 * 1024;
  let uploadedBytes = 0;
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const chunk = file.slice(offset, Math.min(file.size, offset + chunkSize));
    const chunkBuffer = await chunk.arrayBuffer();
    const chunkResponse = await fetch(
      `/api/upload/session/chunk?sessionId=${encodeURIComponent(sessionId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
        },
        body: chunkBuffer,
      },
    );
    const chunkPayload = await chunkResponse.json().catch(() => null);
    if (!chunkResponse.ok) {
      throw new Error(
        chunkPayload?.error || `Chunk upload failed (${chunkResponse.status})`,
      );
    }
    const receivedBytes = Number(chunkPayload?.receivedBytes);
    if (Number.isFinite(receivedBytes) && receivedBytes >= 0) {
      uploadedBytes = Math.min(file.size, Math.floor(receivedBytes));
    } else {
      uploadedBytes = Math.min(file.size, offset + chunk.size);
    }
    const uploadPercent = Math.round(
      (uploadedBytes / Math.max(1, file.size)) * 100,
    );
    setUploadProgress(uploadedBytes, file.size);
    renderProcessingTimeline([
      {
        state: "active",
        text: `Step 1: Uploading file chunks... ${uploadPercent}%`,
      },
      {
        state: "pending",
        text: willRemux
          ? "Step 2: Remux MKV -> MP4 and probe codecs."
          : "Step 2: Probe codecs and validate MP4.",
      },
      {
        state: "pending",
        text: metadata.transcodeAudioToAac
          ? "Step 3: If needed, transcode audio to AAC."
          : "Step 3: Audio transcode disabled.",
      },
    ]);
    setStatus(`Uploading... ${uploadPercent}%`, "");
  }

  setUploadProgress(file.size, file.size);
  renderProcessingTimeline([
    { state: "done", text: "Step 1: Upload complete." },
    {
      state: "active",
      text: willRemux
        ? "Step 2: Finalizing: remuxing MKV to MP4 and probing codecs..."
        : "Step 2: Finalizing: validating MP4 and probing codecs...",
    },
    {
      state: "pending",
      text: metadata.transcodeAudioToAac
        ? "Step 3: Will transcode audio to AAC if codec is unsupported."
        : "Step 3: Audio transcode disabled.",
    },
  ]);
  setStatus("Upload sent. Finalizing and processing...", "");

  const finishResponse = await fetch("/api/upload/session/finish", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sessionId,
      ...metadata,
    }),
  });
  const finishPayload = await finishResponse.json().catch(() => null);
  if (!finishResponse.ok) {
    throw new Error(
      finishPayload?.error ||
        `Failed to finalize upload (${finishResponse.status})`,
    );
  }
  return finishPayload;
}

function setContentType(type) {
  const normalized = normalizeContentType(type);
  const target = uploadForm.querySelector(
    `input[name="contentType"][value="${normalized}"]`,
  );
  if (target instanceof HTMLInputElement) {
    target.checked = true;
    updateFormForContentType();
  }
}

function setFormValue(name, value) {
  const field = uploadForm.elements.namedItem(name);
  if (
    !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)
  ) {
    return;
  }
  field.value = String(value || "");
}

function applySeriesUploadContext(context) {
  if (!context) {
    return;
  }
  activeSeriesUploadContext = context;
  setContentType(context.contentType);
  setFormValue("seriesId", context.seriesId);
  setFormValue("seriesTitle", context.seriesTitle);
  setFormValue("seasonNumber", context.seasonNumber);
  setFormValue("episodeNumber", context.episodeNumber);
  setFormValue("episodeTitle", context.episodeTitle);
  if (String(context.thumb || "").trim()) {
    setFormValue("thumb", context.thumb);
  }

  uploadForm
    ?.querySelectorAll('input[name="contentType"]')
    .forEach((input) => {
      if (input instanceof HTMLInputElement) {
        input.disabled = true;
      }
    });

  const seriesTitleField = uploadForm?.elements?.namedItem("seriesTitle");
  if (seriesTitleField instanceof HTMLInputElement) {
    seriesTitleField.readOnly = true;
  }

  if (uploadSeriesContext) {
    uploadSeriesContext.hidden = false;
  }
  if (uploadSeriesContextTitle) {
    uploadSeriesContextTitle.textContent =
      context.contentType === "course"
        ? `Adding lesson to ${context.seriesTitle || "course"}`
        : `Adding episode to ${context.seriesTitle || "series"}`;
  }
  if (uploadSeriesContextMeta) {
    const unitLabel = context.contentType === "course" ? "Lesson" : "Episode";
    uploadSeriesContextMeta.textContent = `Upload uses full processing (upload, remux/convert checks, metadata update). This will be saved under the same title and series id. Next default ${unitLabel.toLowerCase()} is ${context.episodeNumber}. Thumbnail is prefilled from the course and can be changed.`;
  }
}

async function inferAndPopulateMetadata(file) {
  if (!(file instanceof File)) {
    return;
  }

  setStatus(
    withCompatibilityWarning(
      "Inferring title and movie/series/course info from filename...",
    ),
    pendingCompatibilityWarning ? "warning" : "",
  );

  try {
    const response = await fetch("/api/upload/infer", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fileName: file.name,
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        payload?.error || `Inference failed (${response.status})`,
      );
    }

    const inferred = payload?.inferred || {};
    if (activeSeriesUploadContext) {
      const episodeTitleField = uploadForm?.elements?.namedItem("episodeTitle");
      const hasExistingEpisodeTitle = String(
        episodeTitleField instanceof HTMLInputElement
          ? episodeTitleField.value
          : "",
      ).trim();
      if (!hasExistingEpisodeTitle) {
        setFormValue("episodeTitle", inferred.episodeTitle || "");
      }
      setStatus(
        withCompatibilityWarning(
          `Selected: ${file.name} • Series context locked to "${activeSeriesUploadContext.seriesTitle || activeSeriesUploadContext.seriesId}".`,
        ),
        pendingCompatibilityWarning ? "warning" : "success",
      );
      return;
    }

    setContentType(inferred.contentType || "movie");
    setFormValue("title", inferred.title || "");
    setFormValue("year", inferred.year || "");
    setFormValue("tmdbId", inferred.tmdbId || "");

    const inferredContentType = normalizeContentType(inferred.contentType);
    if (inferredContentType === "episode" || inferredContentType === "course") {
      setFormValue("seriesTitle", inferred.seriesTitle || inferred.title || "");
      setFormValue("seasonNumber", inferred.seasonNumber || 1);
      setFormValue("episodeNumber", inferred.episodeNumber || 1);
      setFormValue("episodeTitle", inferred.episodeTitle || "");
    }

    const confidence = Number(inferred.confidence || 0);
    const confidencePct = Math.round(
      Math.max(0, Math.min(1, confidence)) * 100,
    );
    setStatus(
      withCompatibilityWarning(
        `Selected: ${file.name} • Auto-filled metadata (${confidencePct}% confidence)`,
      ),
      pendingCompatibilityWarning ? "warning" : "success",
    );
  } catch (error) {
    setStatus(
      withCompatibilityWarning(
        `Selected: ${file.name} • Metadata inference failed: ${error instanceof Error ? error.message : "unknown error"}`,
      ),
      "error",
    );
  }
}


  onMount(() => {
    updateFormForContentType();
    applySeriesUploadContext(parseSeriesUploadContextFromQuery());
    updateSubmitState();
    hideUploadProgress();
    updateCompatibilityActions();
    resetSelectedMediaCard();
    renderProcessingTimeline([]);
  });

  // No onCleanup needed: all addEventListener calls target local DOM refs
  // (fileInput, dropZone, uploadForm, etc.) which are destroyed when the
  // component unmounts, automatically removing their listeners.

  return html`<div data-solid-page-root="" style="display: contents">
    <main class="upload-page">
      <header class="upload-topbar">
        <a class="back-link" href="/">Back to Browse</a>
        <p class="upload-topbar-label">Library Ingestion</p>
      </header>

      <section class="upload-hero" aria-labelledby="uploadPageTitle">
        <div class="upload-hero-copy">
          <p class="upload-kicker">Local Media</p>
          <h1 id="uploadPageTitle">Upload Local Media</h1>
          <p class="upload-hero-description">
            Bring a local movie, episode, or course lesson into the
            library. Drop an <code>.mp4</code> or <code>.mkv</code>,
            review the file, then set the metadata once before it
            lands in the catalog.
          </p>
        </div>

        <aside class="upload-hero-panel" aria-label="Upload overview">
          <div class="upload-hero-row">
            <span>Containers</span>
            <strong>MP4 / MKV</strong>
          </div>
          <div class="upload-hero-row">
            <span>Fallback</span>
            <strong>AAC audio repair</strong>
          </div>
          <div class="upload-hero-row">
            <span>Targets</span>
            <strong>Movie, episode, course</strong>
          </div>
        </aside>
      </section>

      <div class="upload-shell">
        <aside class="upload-sidebar">
          <section id="uploadSeriesContext" ref=${el => uploadSeriesContext = el} class="upload-context" hidden>
            <h2 id="uploadSeriesContextTitle" ref=${el => uploadSeriesContextTitle = el}>Adding episode upload</h2>
            <p id="uploadSeriesContextMeta" ref=${el => uploadSeriesContextMeta = el}>
              This upload is linked to an existing series/course.
            </p>
          </section>

          <section class="upload-note-card">
            <p class="upload-note-kicker">Workflow</p>
            <h2 class="upload-note-title">Browser-first ingest</h2>
            <ul class="upload-note-list">
              <li>Choose the source file first.</li>
              <li>Review the preview and processing plan.</li>
              <li>Classify the title and add metadata once.</li>
            </ul>
          </section>

          <div
            id="compatibilityActions"
            ref=${el => compatibilityActions = el}
            class="compatibility-actions"
            hidden
          >
            <label class="compatibility-toggle">
              <input
                id="transcodeAudioToAac"
                ref=${el => transcodeAudioToAacCheckbox = el}
                name="transcodeAudioToAac"
                type="checkbox"
                checked
              />
              <span>
                Audio not browser-compatible? Fast-fix by
                transcoding audio to <code>AAC</code> while keeping
                original video codec, including H.265/HEVC.
              </span>
            </label>
          </div>

          <div class="upload-status-stack">
            <div
              id="uploadProgressWrap"
              ref=${el => uploadProgressWrap = el}
              class="upload-progress"
              hidden
              aria-live="polite"
            >
              <div class="upload-progress-label">
                <span id="uploadProgressText" ref=${el => uploadProgressText = el}>Uploading... 0%</span>
                <span id="uploadProgressBytes" ref=${el => uploadProgressBytes = el}>0 B / 0 B</span>
              </div>
              <div class="upload-progress-track" role="presentation">
                <div
                  id="uploadProgressBar"
                  ref=${el => uploadProgressBar = el}
                  class="upload-progress-bar"
                  style="width: 0%"
                ></div>
              </div>
            </div>

            <div
              id="processingTimeline"
              ref=${el => processingTimeline = el}
              class="processing-timeline"
              hidden
              aria-live="polite"
            ></div>

            <p id="status" ref=${el => statusNode = el} class="status" aria-live="polite"></p>
          </div>
        </aside>

        <section class="upload-panel">
          <div class="upload-workspace-intro">
            <p class="upload-section-kicker">Source File</p>
            <h2 class="upload-section-title">Choose the asset</h2>
            <p class="upload-section-copy">
              Start with the local file. Once the preview is ready,
              the metadata form stays below in the same workspace.
            </p>
          </div>

          <label id="dropZone" ref=${el => dropZone = el} class="drop-zone" for="fileInput">
            <input
              id="fileInput"
              ref=${el => fileInput = el}
              type="file"
              accept=".mp4,.mkv"
              hidden
            />
            <strong>Drag and drop a file here</strong>
            <span>or click to browse</span>
          </label>

          <section id="selectedMediaCard" ref=${el => selectedMediaCard = el} class="selected-media" hidden>
            <div class="selected-media-thumb-wrap">
              <img
                id="selectedMediaThumb"
                ref=${el => selectedMediaThumb = el}
                class="selected-media-thumb"
                alt="Selected video thumbnail"
              />
            </div>
            <div class="selected-media-body">
              <p class="selected-media-kicker">Selected Asset</p>
              <h2 id="selectedMediaName" ref=${el => selectedMediaName = el} class="selected-media-name">
                Selected file
              </h2>
              <p id="selectedMediaMeta" ref=${el => selectedMediaMeta = el} class="selected-media-meta">
                File details
              </p>
              <p id="selectedMediaPlan" ref=${el => selectedMediaPlan = el} class="selected-media-plan">
                Processing plan
              </p>
              <button
                id="changeFileButton"
                ref=${el => changeFileButton = el}
                type="button"
                class="change-file-btn"
              >
                Choose another file
              </button>
            </div>
          </section>

          <form id="uploadForm" ref=${el => uploadForm = el} class="metadata-form" autocomplete="off">
            <input name="tmdbId" type="hidden" />
            <input name="seriesId" type="hidden" />

            <section class="upload-form-section">
              <div class="upload-form-head">
                <p class="upload-section-kicker">Classification</p>
                <h2 class="upload-section-title">Type and routing</h2>
              </div>

              <fieldset class="content-type-fieldset">
                <legend>Content Type</legend>
                <div class="content-type-grid">
                  <label class="content-type-option">
                    <input type="radio" name="contentType" value="movie" checked />
                    <span>Movie</span>
                  </label>
                  <label class="content-type-option">
                    <input type="radio" name="contentType" value="episode" />
                    <span>Series Episode</span>
                  </label>
                  <label class="content-type-option">
                    <input type="radio" name="contentType" value="course" />
                    <span>Course Lesson</span>
                  </label>
                </div>
              </fieldset>

              <div class="grid">
                <label class="upload-field movie-only">
                  <span>Title</span>
                  <input name="title" type="text" placeholder="Movie title" />
                </label>
                <label class="upload-field movie-only">
                  <span>Year</span>
                  <input name="year" type="text" inputmode="numeric" placeholder="2024" />
                </label>
                <label class="upload-field episode-only" hidden>
                  <span id="seriesTitleFieldLabel" ref=${el => seriesTitleFieldLabel = el}>Series Title</span>
                  <input name="seriesTitle" type="text" placeholder="Series name" data-series-placeholder="Series name" data-course-placeholder="Course title" />
                </label>
                <label class="upload-field episode-only" hidden>
                  <span id="seasonNumberFieldLabel" ref=${el => seasonNumberFieldLabel = el}>Season</span>
                  <input name="seasonNumber" type="number" min="1" value="1" />
                </label>
                <label class="upload-field episode-only" hidden>
                  <span id="episodeNumberFieldLabel" ref=${el => episodeNumberFieldLabel = el}>Episode</span>
                  <input name="episodeNumber" type="number" min="1" value="1" />
                </label>
                <label class="upload-field episode-only" hidden>
                  <span id="episodeTitleFieldLabel" ref=${el => episodeTitleFieldLabel = el}>Episode Title</span>
                  <input name="episodeTitle" type="text" placeholder="Episode title" data-series-placeholder="Episode title" data-course-placeholder="Lesson title" />
                </label>
              </div>
            </section>

            <section class="upload-form-section">
              <div class="upload-form-head">
                <p class="upload-section-kicker">Metadata</p>
                <h2 class="upload-section-title">Poster and description</h2>
              </div>

              <label class="upload-field">
                <span>Thumbnail</span>
                <input name="thumb" type="text" placeholder="assets/images/thumbnail.jpg" />
                <small class="field-hint">
                  In series/course upload mode this is prefilled from
                  the course thumbnail. You can override it.
                </small>
              </label>

              <label class="upload-field">
                <span>Description</span>
                <textarea name="description" rows="4" placeholder="Optional"></textarea>
              </label>
            </section>

            <div class="upload-actions">
              <button id="submitButton" ref=${el => submitButton = el} type="submit" disabled>
                Add to Library
              </button>
            </div>
          </form>
        </section>
      </div>
    </main>
  </div>`;
}

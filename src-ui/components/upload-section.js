import html from "solid-js/html";
import { createSignal, onMount } from "solid-js";

// ─── Pure utility functions (no reactivity needed) ───

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let unitIndex = -1;
  let scaled = bytes;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[unitIndex]}`;
}

function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
}

function normalizeFileExtension(name) {
  const value = String(name || "")
    .toLowerCase()
    .trim();
  if (value.endsWith(".mp4")) return ".mp4";
  if (value.endsWith(".mkv")) return ".mkv";
  return "";
}

function normalizeContentType(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "episode" || normalized === "course") return normalized;
  return "movie";
}

function detectCompatibilityInfoFromFilename(fileName) {
  const tokens = String(fileName || "")
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
  const tokenSet = new Set(tokens);
  const reasons = [];
  let canOfferAudioTranscode = false;

  if (
    tokenSet.has("dts") ||
    tokenSet.has("dtshd") ||
    tokenSet.has("dtsma") ||
    tokenSet.has("dca")
  ) {
    reasons.push("Audio codec(s) 'dts' are likely not Chrome-compatible.");
    canOfferAudioTranscode = true;
  }

  return { warning: reasons.join(" "), canOfferAudioTranscode };
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
              Math.round(
                (renderWidth * videoHeight) / Math.max(1, videoWidth),
              ),
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
        resolve({ durationSeconds, width: videoWidth, height: videoHeight, thumbnailDataUrl });
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

function parseSeriesUploadContextFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const mode = String(params.get("mode") || "")
    .trim()
    .toLowerCase();
  if (mode !== "add-episode" && mode !== "series-episode") return null;

  const contentType = normalizeContentType(
    params.get("contentType") || "episode",
  );
  if (contentType === "movie") return null;

  const seriesId = String(params.get("seriesId") || "").trim();
  const seriesTitle = String(params.get("seriesTitle") || "").trim();
  if (!seriesId && !seriesTitle) return null;

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

// ─── SolidJS Component ───

export default function UploadSection() {
  // ── Refs ──
  let fileInputRef;
  let uploadFormRef;

  // ── Signals: file selection state ──
  const [selectedFile, setSelectedFile] = createSignal(null);
  const [hasFile, setHasFile] = createSignal(false);
  const [dropZoneActive, setDropZoneActive] = createSignal(false);

  // ── Signals: selected media card ──
  const [thumbSrc, setThumbSrc] = createSignal("");
  const [mediaName, setMediaName] = createSignal("Selected file");
  const [mediaMeta, setMediaMeta] = createSignal("File details");
  const [mediaPlan, setMediaPlan] = createSignal("Processing plan");

  // ── Signals: compatibility ──
  const [pendingCompatibilityWarning, setPendingCompatibilityWarning] =
    createSignal("");
  const [pendingCanOfferAudioTranscode, setPendingCanOfferAudioTranscode] =
    createSignal(false);
  const [transcodeAudioToAac, setTranscodeAudioToAac] = createSignal(true);

  // ── Signals: content type and form fields ──
  const [contentType, setContentType] = createSignal("movie");
  const [formTitle, setFormTitle] = createSignal("");
  const [formYear, setFormYear] = createSignal("");
  const [formSeriesTitle, setFormSeriesTitle] = createSignal("");
  const [formSeasonNumber, setFormSeasonNumber] = createSignal("1");
  const [formEpisodeNumber, setFormEpisodeNumber] = createSignal("1");
  const [formEpisodeTitle, setFormEpisodeTitle] = createSignal("");
  const [formThumb, setFormThumb] = createSignal("");
  const [formDescription, setFormDescription] = createSignal("");
  const [formTmdbId, setFormTmdbId] = createSignal("");
  const [formSeriesId, setFormSeriesId] = createSignal("");

  // ── Signals: upload progress ──
  const [showUploadProgress, setShowUploadProgress] = createSignal(false);
  const [uploadProgressPercent, setUploadProgressPercent] = createSignal(0);
  const [uploadProgressText, setUploadProgressText] =
    createSignal("Uploading... 0%");
  const [uploadProgressBytesText, setUploadProgressBytesText] =
    createSignal("0 B / 0 B");

  // ── Signals: processing timeline ──
  const [timelineSteps, setTimelineSteps] = createSignal([]);

  // ── Signals: status ──
  const [statusMessage, setStatusMessage] = createSignal("");
  const [statusType, setStatusType] = createSignal("");

  // ── Signals: busy / submit state ──
  const [isProcessingUpload, setIsProcessingUpload] = createSignal(false);

  // ── Signals: series upload context ──
  const [activeSeriesUploadContext, setActiveSeriesUploadContext] =
    createSignal(null);
  const [seriesContextTitle, setSeriesContextTitle] = createSignal("");
  const [seriesContextMeta, setSeriesContextMeta] = createSignal("");
  const [contentTypeDisabled, setContentTypeDisabled] = createSignal(false);
  const [seriesTitleReadOnly, setSeriesTitleReadOnly] = createSignal(false);

  // ── Track stale preview requests ──
  let selectedPreviewRequestVersion = 0;

  // ── Derived values ──
  const isSeriesLike = () => {
    const ct = contentType();
    return ct === "episode" || ct === "course";
  };

  const isCourse = () => contentType() === "course";

  const submitDisabled = () =>
    isProcessingUpload() || !selectedFile();

  const formDisabled = () => isProcessingUpload();

  const showCompatibilityActions = () => pendingCanOfferAudioTranscode();

  const showSeriesContext = () => activeSeriesUploadContext() !== null;

  const seriesTitleLabel = () =>
    isCourse() ? "Course Title" : "Series Title";

  const seasonNumberLabel = () => (isCourse() ? "Module" : "Season");

  const episodeNumberLabel = () => (isCourse() ? "Lesson" : "Episode");

  const episodeTitleLabel = () =>
    isCourse() ? "Lesson Title" : "Episode Title";

  const seriesTitlePlaceholder = () =>
    isCourse() ? "Course title" : "Series name";

  const episodeTitlePlaceholder = () =>
    isCourse() ? "Lesson title" : "Episode title";

  // ── Helper: set status ──
  function setStatus(message, type = "") {
    setStatusMessage(String(message || ""));
    setStatusType(type);
  }

  function withCompatibilityWarning(message) {
    const base = String(message || "").trim();
    const warning = String(pendingCompatibilityWarning() || "").trim();
    if (!warning) return base;
    return `${base} Warning: ${warning}`.trim();
  }

  // ── Helper: upload progress ──
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
    setShowUploadProgress(true);
    setUploadProgressPercent(percent);
    setUploadProgressText(`Uploading... ${percent}%`);
    setUploadProgressBytesText(
      `${formatBytes(safeUploaded)} / ${formatBytes(safeTotal)}`,
    );
  }

  function hideUploadProgress() {
    setShowUploadProgress(false);
  }

  // ── Helper: build processing plan text ──
  function getTranscodeAudioSetting() {
    if (pendingCanOfferAudioTranscode()) {
      return transcodeAudioToAac();
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
    const file = selectedFile();
    if (!file) return;
    setMediaPlan(buildSelectedFilePlan(file));
  }

  // ── Helper: idle processing timeline ──
  function renderIdleProcessingTimeline(file) {
    const ext = normalizeFileExtension(file?.name || "");
    const willRemux = ext === ".mkv";
    setTimelineSteps([
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

  // ── Helper: reset selected media card ──
  function resetSelectedMediaCard() {
    setHasFile(false);
    setThumbSrc("");
    setMediaName("Selected file");
    setMediaMeta("File details");
    setMediaPlan("Processing plan");
  }

  // ── Hydrate selected media card with thumbnail and metadata ──
  async function hydrateSelectedMediaCard(file) {
    if (!(file instanceof File)) return;
    const requestVersion = ++selectedPreviewRequestVersion;
    setHasFile(true);
    setThumbSrc("assets/images/thumbnail.jpg");
    setMediaName(file.name);
    const ext = normalizeFileExtension(file.name)
      .replace(".", "")
      .toUpperCase();
    setMediaMeta(
      `${ext || "VIDEO"} • ${formatBytes(file.size)} • Reading metadata...`,
    );
    updateSelectedFilePlan();
    renderIdleProcessingTimeline(file);

    try {
      const preview = await getObjectUrlImageDataUrl(file);
      if (requestVersion !== selectedPreviewRequestVersion) return;
      const resolutionText =
        preview.width && preview.height
          ? `${preview.width}x${preview.height}`
          : "Unknown resolution";
      const durationText = preview.durationSeconds
        ? formatDuration(preview.durationSeconds)
        : "Unknown duration";
      const extUpper = normalizeFileExtension(file.name)
        .replace(".", "")
        .toUpperCase();
      setMediaMeta(
        `${extUpper || "VIDEO"} • ${formatBytes(file.size)} • ${resolutionText} • ${durationText}`,
      );
      if (preview.thumbnailDataUrl) {
        setThumbSrc(preview.thumbnailDataUrl);
      }
    } catch {
      if (requestVersion !== selectedPreviewRequestVersion) return;
      setThumbSrc("assets/images/thumbnail.jpg");
      const extUpper = normalizeFileExtension(file.name)
        .replace(".", "")
        .toUpperCase();
      setMediaMeta(
        `${extUpper || "VIDEO"} • ${formatBytes(file.size)} • Metadata unavailable`,
      );
    }
  }

  // ── Content type switching ──
  function updateFormForContentType(ct) {
    setContentType(ct);
    if (ct === "course") {
      setFormTmdbId("");
    }
    if (ct === "episode" || ct === "course") {
      // If movie title was filled, copy to series title if empty
      if (!formSeriesTitle().trim() && formTitle().trim()) {
        setFormSeriesTitle(formTitle().trim());
      }
    }
  }

  // ── Set form values programmatically ──
  function setFormValue(name, value) {
    const val = String(value || "");
    switch (name) {
      case "title":
        setFormTitle(val);
        break;
      case "year":
        setFormYear(val);
        break;
      case "seriesTitle":
        setFormSeriesTitle(val);
        break;
      case "seasonNumber":
        setFormSeasonNumber(val);
        break;
      case "episodeNumber":
        setFormEpisodeNumber(val);
        break;
      case "episodeTitle":
        setFormEpisodeTitle(val);
        break;
      case "thumb":
        setFormThumb(val);
        break;
      case "description":
        setFormDescription(val);
        break;
      case "tmdbId":
        setFormTmdbId(val);
        break;
      case "seriesId":
        setFormSeriesId(val);
        break;
    }
  }

  function setContentTypeRadio(type) {
    const normalized = normalizeContentType(type);
    updateFormForContentType(normalized);
  }

  // ── Select file ──
  function selectFile(file) {
    if (!(file instanceof File)) return;
    const ext = normalizeFileExtension(file.name);
    if (!ext) {
      setSelectedFile(null);
      selectedPreviewRequestVersion += 1;
      resetSelectedMediaCard();
      hideUploadProgress();
      setTimelineSteps([]);
      setPendingCompatibilityWarning("");
      setPendingCanOfferAudioTranscode(false);
      setTranscodeAudioToAac(true);
      setStatus("Only .mp4 and .mkv files are supported.", "error");
      return;
    }

    setSelectedFile(file);
    hideUploadProgress();
    setHasFile(true);
    const compatibilityInfo = detectCompatibilityInfoFromFilename(file.name);
    setPendingCompatibilityWarning(compatibilityInfo.warning);
    setPendingCanOfferAudioTranscode(compatibilityInfo.canOfferAudioTranscode);
    if (compatibilityInfo.canOfferAudioTranscode) {
      setTranscodeAudioToAac(true);
    }
    setStatus(
      withCompatibilityWarning(`Selected: ${file.name}`),
      compatibilityInfo.warning ? "warning" : "",
    );
    void hydrateSelectedMediaCard(file);
    void inferAndPopulateMetadata(file);
  }

  // ── Read form metadata for upload ──
  function readUploadMetadataFromForm() {
    const context = activeSeriesUploadContext();
    const contextContentType = normalizeContentType(
      context?.contentType || "",
    );
    const ct = context
      ? contextContentType
      : normalizeContentType(contentType());
    const transcodeAudio = getTranscodeAudioSetting();
    const isSeriesType = ct === "episode" || ct === "course";
    const contextSeriesId = String(context?.seriesId || "").trim();
    const contextSeriesTitle = String(context?.seriesTitle || "").trim();
    const contextSeasonNumber = Number(context?.seasonNumber || 1);
    const contextEpisodeNumber = Number(context?.episodeNumber || 1);
    const contextEpisodeTitle = String(context?.episodeTitle || "").trim();
    const contextThumb = String(context?.thumb || "").trim();
    return {
      contentType: ct,
      title: isSeriesType ? "" : formTitle(),
      year: isSeriesType ? "" : formYear(),
      description: formDescription(),
      thumb: formThumb() || contextThumb || "",
      tmdbId: formTmdbId(),
      seriesId: isSeriesType
        ? contextSeriesId || formSeriesId()
        : "",
      seriesTitle: isSeriesType
        ? contextSeriesTitle || formSeriesTitle()
        : "",
      seasonNumber: isSeriesType
        ? contextSeasonNumber || Number(formSeasonNumber() || 1)
        : 1,
      episodeNumber: isSeriesType
        ? contextEpisodeNumber || Number(formEpisodeNumber() || 1)
        : 1,
      episodeTitle: isSeriesType
        ? contextEpisodeTitle || formEpisodeTitle()
        : "",
      transcodeAudioToAac: transcodeAudio,
    };
  }

  // ── Chunked upload ──
  async function uploadViaChunkSession(file) {
    const metadata = readUploadMetadataFromForm();
    const ext = normalizeFileExtension(file?.name || "");
    const willRemux = ext === ".mkv";
    const startResponse = await fetch("/api/upload/session/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...metadata,
        fileName: file.name,
        fileSize: file.size,
      }),
    });
    const startPayload = await startResponse.json().catch(() => null);
    if (!startResponse.ok) {
      throw new Error(
        startPayload?.error ||
          `Failed to start upload (${startResponse.status})`,
      );
    }
    const sessionId = String(startPayload?.sessionId || "").trim();
    if (!sessionId) {
      throw new Error("Upload session did not return a sessionId.");
    }

    const chunkSize = 32 * 1024 * 1024;
    let uploadedBytes = 0;
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      const chunk = file.slice(
        offset,
        Math.min(file.size, offset + chunkSize),
      );
      const chunkBuffer = await chunk.arrayBuffer();
      const chunkResponse = await fetch(
        `/api/upload/session/chunk?sessionId=${encodeURIComponent(sessionId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: chunkBuffer,
        },
      );
      const chunkPayload = await chunkResponse.json().catch(() => null);
      if (!chunkResponse.ok) {
        throw new Error(
          chunkPayload?.error ||
            `Chunk upload failed (${chunkResponse.status})`,
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
      setTimelineSteps([
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
    setTimelineSteps([
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, ...metadata }),
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

  // ── Infer metadata from filename via API ──
  async function inferAndPopulateMetadata(file) {
    if (!(file instanceof File)) return;

    setStatus(
      withCompatibilityWarning(
        "Inferring title and movie/series/course info from filename...",
      ),
      pendingCompatibilityWarning() ? "warning" : "",
    );

    try {
      const response = await fetch("/api/upload/infer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          payload?.error || `Inference failed (${response.status})`,
        );
      }

      const inferred = payload?.inferred || {};
      const context = activeSeriesUploadContext();

      if (context) {
        if (!formEpisodeTitle().trim()) {
          setFormValue("episodeTitle", inferred.episodeTitle || "");
        }
        setStatus(
          withCompatibilityWarning(
            `Selected: ${file.name} • Series context locked to "${context.seriesTitle || context.seriesId}".`,
          ),
          pendingCompatibilityWarning() ? "warning" : "success",
        );
        return;
      }

      setContentTypeRadio(inferred.contentType || "movie");
      setFormValue("title", inferred.title || "");
      setFormValue("year", inferred.year || "");
      setFormValue("tmdbId", inferred.tmdbId || "");

      const inferredContentType = normalizeContentType(inferred.contentType);
      if (
        inferredContentType === "episode" ||
        inferredContentType === "course"
      ) {
        setFormValue(
          "seriesTitle",
          inferred.seriesTitle || inferred.title || "",
        );
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
        pendingCompatibilityWarning() ? "warning" : "success",
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

  // ── Apply series upload context (from URL params) ──
  function applySeriesUploadContext(context) {
    if (!context) return;
    setActiveSeriesUploadContext(context);
    setContentTypeRadio(context.contentType);
    setFormValue("seriesId", context.seriesId);
    setFormValue("seriesTitle", context.seriesTitle);
    setFormValue("seasonNumber", context.seasonNumber);
    setFormValue("episodeNumber", context.episodeNumber);
    setFormValue("episodeTitle", context.episodeTitle);
    if (String(context.thumb || "").trim()) {
      setFormValue("thumb", context.thumb);
    }

    setContentTypeDisabled(true);
    setSeriesTitleReadOnly(true);

    setSeriesContextTitle(
      context.contentType === "course"
        ? `Adding lesson to ${context.seriesTitle || "course"}`
        : `Adding episode to ${context.seriesTitle || "series"}`,
    );
    const unitLabel = context.contentType === "course" ? "Lesson" : "Episode";
    setSeriesContextMeta(
      `Upload uses full processing (upload, remux/convert checks, metadata update). This will be saved under the same title and series id. Next default ${unitLabel.toLowerCase()} is ${context.episodeNumber}. Thumbnail is prefilled from the course and can be changed.`,
    );
  }

  // ── Event handlers ──
  function handleFileInputChange(event) {
    const file = event.target.files?.[0] || null;
    selectFile(file);
  }

  function handleDragOver(event) {
    event.preventDefault();
    setDropZoneActive(true);
  }

  function handleDragLeave() {
    setDropZoneActive(false);
  }

  function handleDrop(event) {
    event.preventDefault();
    setDropZoneActive(false);
    const file = event.dataTransfer?.files?.[0] || null;
    selectFile(file);
  }

  function handleChangeFile() {
    fileInputRef?.click();
  }

  function handleTranscodeCheckboxChange(event) {
    setTranscodeAudioToAac(event.target.checked);
    updateSelectedFilePlan();
    const file = selectedFile();
    if (file) {
      renderIdleProcessingTimeline(file);
    }
  }

  function handleContentTypeChange(event) {
    if (event.target.name === "contentType") {
      updateFormForContentType(normalizeContentType(event.target.value));
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const file = selectedFile();
    if (!file) {
      setStatus("Choose a file first.", "error");
      return;
    }

    setIsProcessingUpload(true);
    setUploadProgress(0, file.size);
    setTimelineSteps([
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
      const payload = await uploadViaChunkSession(file);

      const converted = payload?.convertedFromMkv
        ? " (MKV remuxed to MP4)"
        : "";
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
        setTimelineSteps([
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
      } else if (
        chromeCompatibility &&
        chromeCompatibility.checked === false
      ) {
        setTimelineSteps([
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
        setTimelineSteps([
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
      setTimelineSteps([
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
        setIsProcessingUpload(false);
      }
    }
  }

  // ── Initialization ──
  onMount(() => {
    applySeriesUploadContext(parseSeriesUploadContextFromQuery());
    hideUploadProgress();
    resetSelectedMediaCard();
    setTimelineSteps([]);
  });

  // ── Template ──
  return html`
    <section
      class="settings-card upload-section"
      aria-labelledby="uploadTitle"
    >
      <h2 id="uploadTitle" class="settings-section-title">Upload Media</h2>

      <div
        class="upload-series-context"
        style=${() => (showSeriesContext() ? "" : "display:none")}
      >
        <p class="upload-series-context-title">
          ${() => seriesContextTitle()}
        </p>
        <p class="upload-series-context-meta">
          ${() => seriesContextMeta()}
        </p>
      </div>

      <label
        class=${() =>
          `upload-drop-zone${hasFile() ? " has-file" : ""}${dropZoneActive() ? " is-active" : ""}`}
        for="fileInput"
        style=${() => (hasFile() ? "display:none" : "")}
        onDragOver=${handleDragOver}
        onDragLeave=${handleDragLeave}
        onDrop=${handleDrop}
      >
        <input
          id="fileInput"
          type="file"
          accept=".mp4,.mkv"
          hidden
          ref=${(el) => {
            fileInputRef = el;
          }}
          onChange=${handleFileInputChange}
          disabled=${formDisabled}
        />
        <span class="upload-drop-label">Drop .mp4 / .mkv here</span>
        <span class="upload-drop-hint">or click to browse</span>
      </label>

      <section
        class="upload-selected"
        style=${() => (hasFile() ? "" : "display:none")}
      >
        <div class="upload-thumb-wrap">
          <img
            class="upload-thumb"
            alt="Selected video thumbnail"
            src=${() => thumbSrc()}
          />
        </div>
        <div class="upload-selected-body">
          <p class="upload-file-name">${() => mediaName()}</p>
          <p class="upload-file-meta">${() => mediaMeta()}</p>
          <p class="upload-file-plan">${() => mediaPlan()}</p>
          <button
            type="button"
            class="upload-change-btn"
            onClick=${handleChangeFile}
            disabled=${formDisabled}
          >
            Change file
          </button>
        </div>
      </section>

      <div
        class="upload-compat"
        style=${() => (showCompatibilityActions() ? "" : "display:none")}
      >
        <label class="upload-compat-toggle">
          <input
            name="transcodeAudioToAac"
            type="checkbox"
            checked=${() => transcodeAudioToAac()}
            onChange=${handleTranscodeCheckboxChange}
            disabled=${formDisabled}
          />
          <span>Transcode incompatible audio to AAC</span>
        </label>
      </div>

      <form
        class="upload-meta-form"
        autocomplete="off"
        ref=${(el) => {
          uploadFormRef = el;
        }}
        onSubmit=${handleSubmit}
        onChange=${handleContentTypeChange}
      >
        <input name="tmdbId" type="hidden" value=${() => formTmdbId()} />
        <input name="seriesId" type="hidden" value=${() => formSeriesId()} />

        <fieldset class="upload-type-fieldset" disabled=${formDisabled}>
          <legend>Content Type</legend>
          <div class="upload-type-grid">
            <label class="upload-type-option">
              <input
                type="radio"
                name="contentType"
                value="movie"
                checked=${() => contentType() === "movie"}
                disabled=${() => contentTypeDisabled()}
              />
              <span>Movie</span>
            </label>
            <label class="upload-type-option">
              <input
                type="radio"
                name="contentType"
                value="episode"
                checked=${() => contentType() === "episode"}
                disabled=${() => contentTypeDisabled()}
              />
              <span>Episode</span>
            </label>
            <label class="upload-type-option">
              <input
                type="radio"
                name="contentType"
                value="course"
                checked=${() => contentType() === "course"}
                disabled=${() => contentTypeDisabled()}
              />
              <span>Course</span>
            </label>
          </div>
        </fieldset>

        <div class="upload-fields">
          <label
            class="upload-field movie-only"
            style=${() => (isSeriesLike() ? "display:none" : "")}
          >
            <span>Title</span>
            <input
              name="title"
              type="text"
              placeholder="Movie title"
              value=${() => formTitle()}
              onInput=${(e) => setFormTitle(e.target.value)}
              disabled=${formDisabled}
            />
          </label>
          <label
            class="upload-field movie-only"
            style=${() => (isSeriesLike() ? "display:none" : "")}
          >
            <span>Year</span>
            <input
              name="year"
              type="text"
              inputmode="numeric"
              placeholder="2024"
              value=${() => formYear()}
              onInput=${(e) => setFormYear(e.target.value)}
              disabled=${formDisabled}
            />
          </label>
          <label
            class="upload-field episode-only"
            style=${() => (isSeriesLike() ? "" : "display:none")}
          >
            <span>${seriesTitleLabel}</span>
            <input
              name="seriesTitle"
              type="text"
              placeholder=${seriesTitlePlaceholder}
              value=${() => formSeriesTitle()}
              onInput=${(e) => setFormSeriesTitle(e.target.value)}
              disabled=${formDisabled}
              readOnly=${() => seriesTitleReadOnly()}
            />
          </label>
          <label
            class="upload-field episode-only"
            style=${() => (isSeriesLike() ? "" : "display:none")}
          >
            <span>${seasonNumberLabel}</span>
            <input
              name="seasonNumber"
              type="number"
              min="1"
              value=${() => formSeasonNumber()}
              onInput=${(e) => setFormSeasonNumber(e.target.value)}
              disabled=${formDisabled}
            />
          </label>
          <label
            class="upload-field episode-only"
            style=${() => (isSeriesLike() ? "" : "display:none")}
          >
            <span>${episodeNumberLabel}</span>
            <input
              name="episodeNumber"
              type="number"
              min="1"
              value=${() => formEpisodeNumber()}
              onInput=${(e) => setFormEpisodeNumber(e.target.value)}
              disabled=${formDisabled}
            />
          </label>
          <label
            class="upload-field episode-only"
            style=${() => (isSeriesLike() ? "" : "display:none")}
          >
            <span>${episodeTitleLabel}</span>
            <input
              name="episodeTitle"
              type="text"
              placeholder=${episodeTitlePlaceholder}
              value=${() => formEpisodeTitle()}
              onInput=${(e) => setFormEpisodeTitle(e.target.value)}
              disabled=${formDisabled}
            />
          </label>
          <label class="upload-field">
            <span>Thumbnail</span>
            <input
              name="thumb"
              type="text"
              placeholder="assets/images/thumbnail.jpg"
              value=${() => formThumb()}
              onInput=${(e) => setFormThumb(e.target.value)}
              disabled=${formDisabled}
            />
          </label>
          <label class="upload-field upload-field--full">
            <span>Description</span>
            <textarea
              name="description"
              rows="3"
              placeholder="Optional"
              disabled=${formDisabled}
              onInput=${(e) => setFormDescription(e.target.value)}
            >
              ${() => formDescription()}
            </textarea>
          </label>
        </div>

        <div class="upload-submit-row">
          <button
            class="save-btn"
            type="submit"
            disabled=${submitDisabled}
          >
            Add to Library
          </button>
        </div>
      </form>

      <div class="upload-status-stack">
        <div
          class="upload-progress-wrap"
          style=${() => (showUploadProgress() ? "" : "display:none")}
          aria-live="polite"
        >
          <div class="upload-progress-label">
            <span>${() => uploadProgressText()}</span>
            <span>${() => uploadProgressBytesText()}</span>
          </div>
          <div class="upload-progress-track">
            <div
              class="upload-progress-bar"
              style=${() => `width: ${uploadProgressPercent()}%`}
            ></div>
          </div>
        </div>

        <div
          class="upload-timeline"
          style=${() => (timelineSteps().length > 0 ? "" : "display:none")}
          aria-live="polite"
        >
          ${() =>
            timelineSteps().map(
              (step) =>
                html`<div
                  class="processing-step"
                  data-state=${step.state}
                >
                  ${step.text}
                </div>`,
            )}
        </div>

        <p
          class=${() => {
            const type = statusType();
            const classes = ["upload-status-text"];
            if (type) classes.push(type);
            return classes.join(" ");
          }}
          aria-live="polite"
        >
          ${() => statusMessage()}
        </p>
      </div>
    </section>
  `;
}

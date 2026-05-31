import { isHlsPlaybackSource } from "./hls-playback.js";

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function normalizePlaybackSourceValue(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  if (/^(https?:)?\/\//i.test(raw) || raw.startsWith("/")) {
    return raw;
  }
  return raw.startsWith("assets/") ? `/${raw}` : raw;
}

function normalizeLiveStreamId(value, fallback = "") {
  return slugify(value) || slugify(fallback) || "";
}

function normalizeLiveStreamOption(option = {}, index = 0) {
  const source = normalizePlaybackSourceValue(option?.source);
  if (!source) {
    return null;
  }
  const label = String(
    option?.label || option?.name || option?.quality || `Stream ${index + 1}`,
  ).trim();
  const id =
    normalizeLiveStreamId(option?.id || label, `stream-${index + 1}`) ||
    `stream-${index + 1}`;
  return {
    id,
    label: label || `Stream ${index + 1}`,
    source,
    provider: String(option?.provider || "").trim().toLowerCase(),
    playbackType: String(option?.playbackType || "").trim().toLowerCase(),
    playerPage: normalizePlaybackSourceValue(option?.playerPage || option?.referer || ""),
    quality: String(option?.quality || option?.meta || "").trim(),
  };
}

function readLiveStreamOptionsFromParams(
  queryParams,
  fallbackSource = "",
  includeFallbackSource = false,
) {
  const parsedOptions = [];
  const rawStreams = String(queryParams.get("liveStreams") || "").trim();
  if (rawStreams) {
    try {
      const decoded = JSON.parse(rawStreams);
      if (Array.isArray(decoded)) {
        decoded.forEach((option, index) => {
          const normalized = normalizeLiveStreamOption(option, index);
          if (normalized) {
            parsedOptions.push(normalized);
          }
        });
      }
    } catch {
      // Ignore malformed live stream metadata.
    }
  }

  const seenSources = new Set();
  const seenIds = new Set();
  const uniqueOptions = parsedOptions.filter((option) => {
    const key = option.source;
    if (!key || seenSources.has(key)) {
      return false;
    }
    seenSources.add(key);
    if (seenIds.has(option.id)) {
      option.id = `${option.id}-${seenIds.size + 1}`;
    }
    seenIds.add(option.id);
    return true;
  });
  const normalizedFallback = includeFallbackSource
    ? normalizePlaybackSourceValue(fallbackSource)
    : "";
  if (
    normalizedFallback &&
    !uniqueOptions.some((option) => option.source === normalizedFallback)
  ) {
    uniqueOptions.unshift({
      id: "default",
      label: "Default",
      source: normalizedFallback,
      quality: "",
    });
  }
  return uniqueOptions;
}

export function deriveLiveStreamStateFromParams(queryParams, fallbackSource = "") {
  let selectedStreamId = normalizeLiveStreamId(queryParams.get("liveStreamId"));
  const liveParam = String(queryParams.get("live") || "")
    .trim()
    .toLowerCase();
  const hasLiveFlag =
    liveParam === "1" ||
    liveParam === "true" ||
    liveParam === "yes" ||
    liveParam === "on";
  const hasLiveStreamMetadata = Boolean(
    String(queryParams.get("liveStreams") || "").trim(),
  );
  const options = readLiveStreamOptionsFromParams(
    queryParams,
    fallbackSource,
    hasLiveFlag || hasLiveStreamMetadata,
  );
  const isLivePlayback =
    hasLiveFlag ||
    options.length > 0;

  const selectedStream =
    options.find((option) => option.id === selectedStreamId) ||
    options.find((option) => option.source === fallbackSource) ||
    options[0] ||
    null;
  if (selectedStream) {
    selectedStreamId = selectedStream.id;
  }

  return {
    options,
    selectedStreamId,
    selectedSource: selectedStream?.source || "",
    isLivePlayback,
  };
}

export function getSelectedLiveStreamOption(options, selectedStreamId) {
  if (!options.length) {
    return null;
  }
  return (
    options.find((option) => option.id === selectedStreamId) ||
    options[0] ||
    null
  );
}

export function shouldShowLiveStreamControls(isLivePlayback, options) {
  return Boolean(isLivePlayback && options.length > 1);
}

export function getLivePlaybackSource(source, isLivePlayback, options = {}) {
  const normalizedSource = normalizePlaybackSourceValue(source);
  const shouldProxy =
    isLivePlayback &&
    isHlsPlaybackSource(normalizedSource) &&
    /^https?:\/\//i.test(normalizedSource);
  if (!shouldProxy) {
    return normalizedSource;
  }
  const query = new URLSearchParams({ input: normalizedSource });
  const referer = normalizePlaybackSourceValue(options?.referer);
  if (/^https?:\/\//i.test(referer)) {
    query.set("referer", referer);
  }
  return `/api/live/hls.m3u8?${query.toString()}`;
}

export function syncLiveStreamControls({
  liveStreamControl,
  toggleLiveStream,
  liveStreamMenu,
  liveStreamOptionsContainer,
  liveStreamOptions,
  selectedLiveStreamId,
  isLivePlayback,
}) {
  const shouldShow = shouldShowLiveStreamControls(isLivePlayback, liveStreamOptions);
  if (liveStreamControl) {
    liveStreamControl.hidden = !shouldShow;
  }
  if (toggleLiveStream) {
    const selectedOption = getSelectedLiveStreamOption(
      liveStreamOptions,
      selectedLiveStreamId,
    );
    const label = selectedOption?.label || "Live stream";
    toggleLiveStream.setAttribute("aria-label", `Live stream (${label})`);
    toggleLiveStream.setAttribute("title", `Live stream (${label})`);
    toggleLiveStream.setAttribute(
      "aria-expanded",
      liveStreamControl?.classList.contains("is-open") ? "true" : "false",
    );
  }
  if (liveStreamMenu) {
    liveStreamMenu.setAttribute(
      "aria-label",
      `Live stream (${getSelectedLiveStreamOption(liveStreamOptions, selectedLiveStreamId)?.label || "Default"})`,
    );
  }
  if (liveStreamOptionsContainer) {
    Array.from(
      liveStreamOptionsContainer.querySelectorAll(".live-stream-option"),
    ).forEach((optionButton) => {
      optionButton.setAttribute(
        "aria-selected",
        optionButton.dataset.streamId === selectedLiveStreamId ? "true" : "false",
      );
    });
  }
}

export function renderLiveStreamOptions(
  liveStreamOptionsContainer,
  liveStreamOptions,
  selectedLiveStreamId,
  { getStatus = () => null } = {},
) {
  if (!(liveStreamOptionsContainer instanceof HTMLElement)) {
    return;
  }

  liveStreamOptionsContainer.innerHTML = "";
  liveStreamOptions.forEach((option) => {
    const status = getStatus(option) || null;
    const button = document.createElement("button");
    button.className = "audio-option live-stream-option";
    button.type = "button";
    button.setAttribute("role", "option");
    button.dataset.streamId = option.id;
    if (status?.state) {
      button.classList.add(`is-${status.state}`);
      button.dataset.streamStatus = status.state;
    }
    button.setAttribute(
      "aria-selected",
      option.id === selectedLiveStreamId ? "true" : "false",
    );
    if (status?.label) {
      button.setAttribute(
        "aria-label",
        `${option.label}${option.quality ? ` ${option.quality}` : ""} ${status.label}`,
      );
      if (status.detail) {
        button.setAttribute("title", status.detail);
      }
    }

    const name = document.createElement("span");
    name.className = "live-stream-option-name";
    name.textContent = option.label;
    button.appendChild(name);

    const metaParts = [];
    if (option.quality) {
      metaParts.push(option.quality);
    }
    if (status?.label) {
      metaParts.push(status.label);
    }
    if (metaParts.length > 0) {
      const meta = document.createElement("span");
      meta.className = "live-stream-option-meta";
      meta.textContent = metaParts.join(" / ");
      button.appendChild(meta);
    }

    liveStreamOptionsContainer.appendChild(button);
  });
}

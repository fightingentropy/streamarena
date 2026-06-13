import { isHlsPlaybackSource } from "./hls-playback.js";

/// Server-rack glyph shared by the VOD server menu and the live stream menu so
/// "pick a source" reads the same everywhere in the player.
export const SOURCE_OPTION_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="3.25" y="3.75" width="17.5" height="7" rx="1.8"></rect>
  <rect x="3.25" y="13.25" width="17.5" height="7" rx="1.8"></rect>
  <path d="M6.8 7.25h.01"></path>
  <path d="M6.8 16.75h.01"></path>
  <path d="M13.5 7.25h3.7"></path>
  <path d="M13.5 16.75h3.7"></path>
</svg>`;

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

export function isLiveHlsProxyPlaybackSource(source) {
  const normalized = normalizePlaybackSourceValue(source);
  return normalized.includes("/api/live/hls.m3u8");
}

export function isBrowserBoundLiveHlsHost(source) {
  const normalized = normalizePlaybackSourceValue(source);
  if (!/^https?:\/\//i.test(normalized)) {
    return false;
  }
  try {
    const host = new URL(normalized).hostname.toLowerCase();
    return (
      host === "strmd.st" ||
      host.endsWith(".strmd.st") ||
      host === "strmd.top" ||
      host.endsWith(".strmd.top")
    );
  } catch {
    return false;
  }
}

export function normalizeBrowserBoundLiveHlsReferer(referer) {
  const normalized = normalizePlaybackSourceValue(referer);
  if (!/^https?:\/\//i.test(normalized)) {
    return "";
  }
  try {
    const url = new URL(normalized);
    const host = url.hostname.toLowerCase();
    if (host === "embed.st" || host === "www.embed.st") {
      return `${url.origin}/`;
    }
    return url.toString();
  } catch {
    return "";
  }
}

export function getLivePlaybackSource(source, isLivePlayback, options = {}) {
  const normalizedSource = normalizePlaybackSourceValue(source);
  if (isLiveHlsProxyPlaybackSource(normalizedSource)) {
    return normalizedSource;
  }
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

    const iconBadge = document.createElement("span");
    iconBadge.className = "live-stream-option-icon";
    iconBadge.setAttribute("aria-hidden", "true");
    iconBadge.innerHTML = SOURCE_OPTION_ICON_SVG;

    const textWrap = document.createElement("span");
    textWrap.className = "live-stream-option-text";

    const name = document.createElement("span");
    name.className = "live-stream-option-name";
    name.textContent = option.label;
    textWrap.appendChild(name);

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
      textWrap.appendChild(meta);
    }

    button.append(iconBadge, textWrap);
    liveStreamOptionsContainer.appendChild(button);
  });
}

// A live "stalled / trying another source" status overlay is stale once playback
// is advancing again — a late stall-recovery timer or a brief hiccup can paint it
// over a stream that has since recovered. Clear it, unless a real fallback is
// mid-switch (it owns the status) or the overlay is an actionable error.
export function hideStaleLiveResolverWhilePlaying({
  isLivePlayback,
  resolverOverlay,
  liveAutoFallbackInFlight,
  hideResolver,
}) {
  if (!isLivePlayback || !resolverOverlay || resolverOverlay.hidden) {
    return;
  }
  if (liveAutoFallbackInFlight || resolverOverlay.classList.contains("has-actions")) {
    return;
  }
  hideResolver();
}

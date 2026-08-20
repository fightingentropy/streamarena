import { normalizeRemuxVideoMode } from "../lib/preferences.js";
import { normalizeSourceHash } from "./sources.js";

const AUDIO_SYNC_MIN_MS = -2500;
const AUDIO_SYNC_MAX_MS = 2500;
const REMUX_VIDEO_CODEC_PROBES = [
  ["h264", 'video/mp4; codecs="avc1.42E01E"'],
  ["hevc", 'video/mp4; codecs="hvc1.1.6.L93.B0"'],
  ["av1", 'video/mp4; codecs="av01.0.05M.08"'],
  ["vp9", 'video/mp4; codecs="vp09.00.10.08"'],
];

export function getBrowserSupportedRemuxVideoCodecs(video) {
  if (!video || typeof video.canPlayType !== "function") {
    return ["h264"];
  }
  const supported = [];
  for (const [codec, contentType] of REMUX_VIDEO_CODEC_PROBES) {
    try {
      const result = String(video.canPlayType(contentType) || "").toLowerCase();
      if (result === "maybe" || result === "probably") {
        supported.push(codec);
      }
    } catch {
      // One unsupported codec probe must not suppress the safe baseline.
    }
  }
  if (!supported.includes("h264")) {
    supported.unshift("h264");
  }
  return supported;
}

export function normalizeAudioSyncMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(
    AUDIO_SYNC_MIN_MS,
    Math.min(AUDIO_SYNC_MAX_MS, Math.round(parsed)),
  );
}

function normalizedBrowserVideoCodecHint(getBrowserVideoCodecs) {
  const values = getBrowserVideoCodecs?.();
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean)
    .join(",");
}

function resolvedTrackIndex(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function buildResolvedRemuxVariantSource(
  resolved,
  {
    startSeconds = null,
    sourceHash = "",
    audioSyncMs = 0,
    remuxVideoMode = "auto",
    parseTranscodeSource = () => null,
    buildSoftwareDecodeUrl = () => "",
  } = {},
) {
  const candidates = [
    resolved?.playableUrl,
    ...(Array.isArray(resolved?.fallbackUrls) ? resolved.fallbackUrls : []),
  ];
  for (const candidate of candidates) {
    const meta = parseTranscodeSource(String(candidate || "").trim());
    if (!meta?.input) continue;
    const effectiveStartSeconds =
      startSeconds === null || startSeconds === undefined || startSeconds === ""
        ? meta.startSeconds
        : Number(startSeconds);
    return buildSoftwareDecodeUrl(
      meta.input,
      Number.isFinite(effectiveStartSeconds) ? effectiveStartSeconds : 0,
      resolvedTrackIndex(
        resolved?.selectedAudioStreamIndex,
        meta.audioStreamIndex,
      ),
      audioSyncMs,
      resolvedTrackIndex(
        resolved?.selectedSubtitleStreamIndex,
        meta.subtitleStreamIndex,
      ),
      sourceHash || resolved?.sourceHash || meta.sourceHash || "",
      remuxVideoMode,
    );
  }
  return "";
}

function remuxInputOrSource(source, parseTranscodeSource) {
  const normalized = String(source || "").trim();
  if (!normalized) return "";
  return String(parseTranscodeSource(normalized)?.input || normalized).trim();
}

export function buildOrderedRemuxFallbacks({
  normalizeSource = "",
  nativePreferredSource = "",
  fallbackUrls = [],
  skipRemuxFallback = false,
  parseTranscodeSource = () => null,
} = {}) {
  const normalizedFallbacks = Array.isArray(fallbackUrls) ? fallbackUrls : [];
  const normalizeInput = remuxInputOrSource(normalizeSource, parseTranscodeSource);
  const nativeInput = remuxInputOrSource(
    nativePreferredSource,
    parseTranscodeSource,
  );
  const nativeDuplicatesNormalize = Boolean(
    normalizeInput && nativeInput && normalizeInput === nativeInput,
  );
  const candidates = skipRemuxFallback
    ? normalizedFallbacks
    : [
        normalizeSource,
        ...(nativeDuplicatesNormalize ? [] : [nativePreferredSource]),
        ...normalizedFallbacks,
      ];
  return candidates
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter(
      (value) =>
        !skipRemuxFallback || !parseTranscodeSource(value),
    )
    .filter((value, index, values) => values.indexOf(value) === index);
}

export function createRemuxRouting({
  getOrigin = () => window.location.origin,
  getSelectedSourceHash = () => "",
  getAvailableAudioTracks = () => [],
  getSelectedAudioStreamIndex = () => -1,
  getSelectedSubtitleStreamIndex = () => -1,
  getPreferredAudioSyncMs = () => 0,
  getPreferredRemuxVideoMode = () => "auto",
  getBrowserVideoCodecs = () => ["h264"],
  isBrowserSafeAudioCodec = () => true,
  shouldMapSubtitleStreamIndex = () => false,
} = {}) {
  function getDefaultEmbeddedAudioTrack() {
    const availableAudioTracks = getAvailableAudioTracks();
    return (
      availableAudioTracks.find((track) => Boolean(track?.isDefault)) ||
      availableAudioTracks[0] ||
      null
    );
  }

  function getSelectedEmbeddedAudioTrack() {
    const selectedAudioStreamIndex = getSelectedAudioStreamIndex();
    if (selectedAudioStreamIndex >= 0) {
      return (
        getAvailableAudioTracks().find(
          (track) => Number(track?.streamIndex) === selectedAudioStreamIndex,
        ) || null
      );
    }
    return getDefaultEmbeddedAudioTrack();
  }

  function shouldForceRemuxForEmbeddedAudio() {
    const selectedTrack = getSelectedEmbeddedAudioTrack();
    if (!selectedTrack) {
      return false;
    }

    if (!isBrowserSafeAudioCodec(selectedTrack.codec)) {
      return true;
    }

    const defaultTrack = getDefaultEmbeddedAudioTrack();
    if (!defaultTrack) {
      return false;
    }

    return Number(selectedTrack.streamIndex) !== Number(defaultTrack.streamIndex);
  }

  function withPreferredAudioSyncForRemuxSource(
    source,
    audioSyncMs = getPreferredAudioSyncMs(),
    remuxVideoMode = getPreferredRemuxVideoMode(),
  ) {
    try {
      const url = new URL(source, getOrigin());
      if (url.pathname !== "/api/remux") {
        return source;
      }
      const normalizedSync = normalizeAudioSyncMs(audioSyncMs);
      if (normalizedSync === 0) {
        url.searchParams.delete("audioSyncMs");
      } else {
        url.searchParams.set("audioSyncMs", String(normalizedSync));
      }
      const normalizedSourceHash = normalizeSourceHash(getSelectedSourceHash());
      if (normalizedSourceHash) {
        url.searchParams.set("sourceHash", normalizedSourceHash);
      } else {
        url.searchParams.delete("sourceHash");
      }
      url.searchParams.set("videoMode", normalizeRemuxVideoMode(remuxVideoMode));
      const videoCodecs = normalizedBrowserVideoCodecHint(getBrowserVideoCodecs);
      if (videoCodecs) {
        url.searchParams.set("videoCodecs", videoCodecs);
      } else {
        url.searchParams.delete("videoCodecs");
      }
      return `${url.pathname}?${url.searchParams.toString()}`;
    } catch {
      return source;
    }
  }

  function buildSoftwareDecodeUrl(
    source,
    startSeconds = 0,
    audioStreamIndex = -1,
    audioSyncMs = getPreferredAudioSyncMs(),
    subtitleStreamIndex = getSelectedSubtitleStreamIndex(),
    sourceHash = getSelectedSourceHash(),
    remuxVideoMode = getPreferredRemuxVideoMode(),
  ) {
    const params = new URLSearchParams({ input: String(source || "") });
    if (Number.isFinite(startSeconds) && startSeconds > 0) {
      params.set("start", String(Math.floor(startSeconds)));
    }
    if (Number.isFinite(audioStreamIndex) && audioStreamIndex >= 0) {
      params.set("audioStream", String(Math.floor(audioStreamIndex)));
    }
    if (shouldMapSubtitleStreamIndex(subtitleStreamIndex)) {
      params.set("subtitleStream", String(Math.floor(subtitleStreamIndex)));
    }
    const normalizedSync = normalizeAudioSyncMs(audioSyncMs);
    if (normalizedSync !== 0) {
      params.set("audioSyncMs", String(normalizedSync));
    }
    const normalizedSourceHash = normalizeSourceHash(sourceHash);
    if (normalizedSourceHash) {
      params.set("sourceHash", normalizedSourceHash);
    }
    params.set("videoMode", normalizeRemuxVideoMode(remuxVideoMode));
    const videoCodecs = normalizedBrowserVideoCodecHint(getBrowserVideoCodecs);
    if (videoCodecs) {
      params.set("videoCodecs", videoCodecs);
    }
    return `/api/remux?${params.toString()}`;
  }

  function parseTranscodeSource(source) {
    if (!source) {
      return null;
    }

    try {
      const url = new URL(source, getOrigin());
      if (url.pathname !== "/api/remux") {
        return null;
      }

      const input = url.searchParams.get("input");
      if (!input) {
        return null;
      }

      const rawStart = Number(url.searchParams.get("start") || 0);
      const startSeconds =
        Number.isFinite(rawStart) && rawStart > 0 ? rawStart : 0;
      const rawAudioStreamIndex = Number(
        url.searchParams.get("audioStream") || -1,
      );
      const audioStreamIndex =
        Number.isFinite(rawAudioStreamIndex) && rawAudioStreamIndex >= 0
          ? Math.floor(rawAudioStreamIndex)
          : -1;
      const rawSubtitleStreamIndex = Number(
        url.searchParams.get("subtitleStream") || -1,
      );
      const subtitleStreamIndex =
        Number.isFinite(rawSubtitleStreamIndex) && rawSubtitleStreamIndex >= 0
          ? Math.floor(rawSubtitleStreamIndex)
          : -1;
      const rawAudioSyncMs = Number(url.searchParams.get("audioSyncMs") || 0);
      const audioSyncMs = normalizeAudioSyncMs(rawAudioSyncMs);
      const sourceHash = normalizeSourceHash(
        url.searchParams.get("sourceHash") || "",
      );
      const remuxVideoMode = normalizeRemuxVideoMode(
        url.searchParams.get("videoMode") || "auto",
      );
      const browserVideoCodecs = String(
        url.searchParams.get("videoCodecs") || "",
      )
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      return {
        input,
        startSeconds,
        audioStreamIndex,
        subtitleStreamIndex,
        audioSyncMs,
        sourceHash,
        remuxVideoMode,
        browserVideoCodecs,
      };
    } catch {
      return null;
    }
  }

  return {
    normalizeAudioSyncMs,
    getDefaultEmbeddedAudioTrack,
    getSelectedEmbeddedAudioTrack,
    shouldForceRemuxForEmbeddedAudio,
    withPreferredAudioSyncForRemuxSource,
    buildSoftwareDecodeUrl,
    parseTranscodeSource,
  };
}

import { normalizeRemuxVideoMode } from "../lib/preferences.js";
import { normalizeSourceHash } from "./sources.js";

const AUDIO_SYNC_MIN_MS = -2500;
const AUDIO_SYNC_MAX_MS = 2500;

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

export function createRemuxRouting({
  getOrigin = () => window.location.origin,
  getSelectedSourceHash = () => "",
  getAvailableAudioTracks = () => [],
  getSelectedAudioStreamIndex = () => -1,
  getSelectedSubtitleStreamIndex = () => -1,
  getPreferredAudioSyncMs = () => 0,
  getPreferredRemuxVideoMode = () => "auto",
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
      return {
        input,
        startSeconds,
        audioStreamIndex,
        subtitleStreamIndex,
        audioSyncMs,
        sourceHash,
        remuxVideoMode,
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

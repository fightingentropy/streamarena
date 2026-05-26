import { isHlsPlaybackSource, shouldUseHlsJsForPlayback } from "./hls-playback.js";
import {
  getDetectedSourceOptionLanguages,
  getSourceDisplayName,
  isSourceOptionEmbed,
  isSourceOptionLikelyContainer,
  normalizeSourceHash,
  parseSourceOptionVerticalResolution,
} from "./sources.js";

export { isHlsPlaybackSource, shouldUseHlsJsForPlayback };

function getDefaultOrigin() {
  return typeof window !== "undefined" ? window.location.origin : "http://localhost";
}

export function parseHlsMasterSource(source, origin = getDefaultOrigin()) {
  if (!source) {
    return null;
  }

  try {
    const url = new URL(source, origin);
    if (url.pathname !== "/api/hls/master.m3u8") {
      return null;
    }
    const input = url.searchParams.get("input");
    if (!input) {
      return null;
    }

    const rawAudio = Number(url.searchParams.get("audioStream") || -1);
    const rawSubtitle = Number(url.searchParams.get("subtitleStream") || -1);
    return {
      input,
      audioStreamIndex: Number.isFinite(rawAudio) ? rawAudio : -1,
      subtitleStreamIndex: Number.isFinite(rawSubtitle) ? rawSubtitle : -1,
    };
  } catch {
    return null;
  }
}

export function parseSourceSizeGb(sizeLabel) {
  const match = /([\d.]+)\s*(tb|gb|mb)\b/i.exec(String(sizeLabel || ""));
  if (!match) {
    return 0;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  const unit = match[2].toLowerCase();
  if (unit === "tb") {
    return value * 1024;
  }
  if (unit === "mb") {
    return value / 1024;
  }
  return value;
}

function normalizeSourceLanguage(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized || normalized === "eng" || normalized === "english") {
    return "en";
  }
  if (
    normalized === "any" ||
    normalized === "all" ||
    normalized === "auto" ||
    normalized === "*"
  ) {
    return "any";
  }
  return /^[a-z]{2}$/.test(normalized) ? normalized : "en";
}

function buildSourceOptionSearchText(option = {}) {
  return [
    option?.primary,
    option?.filename,
    option?.provider,
    option?.qualityLabel,
    option?.container,
    option?.size,
    option?.releaseGroup,
  ]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");
}

function getNormalizedPlaybackSourceText(source) {
  return String(source || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function looksLikeBrowserUnsafeVideoSource(source) {
  const normalizedText = getNormalizedPlaybackSourceText(source);
  return /\b(hevc|x265|h265|h 265|10bit|10 bit|hdr|dolby vision|dv|av1)\b/.test(
    normalizedText,
  );
}

function isAppleMobileOrTabletVideoEnvironment() {
  const nav = window.navigator || {};
  const userAgent = String(nav.userAgent || "");
  const platform = String(nav.platform || "");
  return (
    /\b(iPad|iPhone|iPod)\b/i.test(userAgent) ||
    (platform === "MacIntel" && Number(nav.maxTouchPoints || 0) > 1)
  );
}

function isDesktopSafariVideoEnvironment() {
  const nav = window.navigator || {};
  const userAgent = String(nav.userAgent || "");
  const vendor = String(nav.vendor || "");
  const platform = String(nav.platform || "");
  const isSafari =
    /\bSafari\//i.test(userAgent) &&
    /\bApple\b/i.test(vendor) &&
    !/\b(Chrome|Chromium|CriOS|FxiOS|Edg|EdgiOS|OPR|Opera)\b/i.test(userAgent);
  const isDesktopApple = /\bMac\b/i.test(platform) || /\bMacintosh\b/i.test(userAgent);
  return isSafari && isDesktopApple && !isAppleMobileOrTabletVideoEnvironment();
}

function isMobileOrTabletVideoEnvironment() {
  if (isAppleMobileOrTabletVideoEnvironment()) {
    return true;
  }

  const nav = window.navigator || {};
  const userAgent = String(nav.userAgent || "");
  const platform = String(nav.platform || "");
  if (/\b(Android|Mobile|Phone|Tablet|Silk|Kindle)\b/i.test(userAgent)) {
    return true;
  }
  if (/\b(Android|iPad|iPhone|iPod)\b/i.test(platform)) {
    return true;
  }

  try {
    return Boolean(
      window.matchMedia?.("(hover: none) and (pointer: coarse)")?.matches &&
        window.matchMedia?.("(max-width: 1180px)")?.matches,
    );
  } catch {
    return false;
  }
}

function getNativeHlsSupport(video) {
  try {
    return String(video?.canPlayType?.("application/vnd.apple.mpegURL") || "");
  } catch {
    return "";
  }
}

function isAppleNativeHlsEnvironment() {
  return (
    isAppleMobileOrTabletVideoEnvironment() ||
    isDesktopSafariVideoEnvironment()
  );
}

function hasNativeHlsPlaybackSupport(video) {
  const support = getNativeHlsSupport(video);
  return (
    isAppleNativeHlsEnvironment() &&
    (support === "maybe" ||
      support === "probably" ||
      isAppleMobileOrTabletVideoEnvironment())
  );
}

function hasHlsJsPlaybackSupport() {
  try {
    const MediaSourceCtor = window.MediaSource || window.WebKitMediaSource;
    return Boolean(
      MediaSourceCtor &&
        typeof MediaSourceCtor.isTypeSupported === "function" &&
        MediaSourceCtor.isTypeSupported(
          'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
        ),
    );
  } catch {
    return false;
  }
}

export function createPlaybackRouting({
  getVideo = () => null,
  getOrigin = () => getDefaultOrigin(),
  getSelectedAudioStreamIndex = () => -1,
  getSelectedSubtitleStreamIndex = () => -1,
  getPreferredSourceLanguage = () => "en",
  getPreferredContainer = () => "",
  getPreferredSourceFormats = () => [],
  getPreferredResolverProvider = () => "fastest",
  getSupportedSourceFormatSet = () => new Set(),
  shouldPreferMobileLightTmdbSources = () => false,
  shouldMapSubtitleStreamIndex = () => false,
  parseTranscodeSource = () => null,
  getSubtitleTrackByStreamIndex = () => null,
  shouldUseNativeEmbeddedSubtitleTrack = () => false,
} = {}) {
  function buildHlsPlaybackUrl(
    input,
    audioStreamIndex = -1,
    subtitleStreamIndex = -1,
  ) {
    const query = new URLSearchParams({ input: String(input || "") });
    if (Number.isFinite(audioStreamIndex) && audioStreamIndex >= 0) {
      query.set("audioStream", String(Math.floor(audioStreamIndex)));
    }
    if (shouldMapSubtitleStreamIndex(subtitleStreamIndex)) {
      query.set("subtitleStream", String(Math.floor(subtitleStreamIndex)));
    }
    return `/api/hls/master.m3u8?${query.toString()}`;
  }

  function extractPlaybackSourceInput(source) {
    if (!source) {
      return "";
    }
    const transcodeMeta = parseTranscodeSource(source);
    if (transcodeMeta?.input) {
      return transcodeMeta.input;
    }
    const hlsMeta = parseHlsMasterSource(source, getOrigin());
    if (hlsMeta?.input) {
      return hlsMeta.input;
    }
    return String(source || "").trim();
  }

  function hasNativeHlsSupportForPlayer() {
    return hasNativeHlsPlaybackSupport(getVideo());
  }

  function hasHlsPlaybackSupport() {
    return hasNativeHlsSupportForPlayer() || hasHlsJsPlaybackSupport();
  }

  function shouldUseHlsJsForSource(source) {
    return shouldUseHlsJsForPlayback(source, {
      hasNativeHlsPlaybackSupport: hasNativeHlsSupportForPlayer,
      hasHlsJsPlaybackSupport,
      origin: getOrigin(),
    });
  }

  function shouldPreferBrowserHlsPlayback(
    source,
    subtitleStreamIndex = getSelectedSubtitleStreamIndex(),
  ) {
    if (!hasHlsPlaybackSupport()) {
      return false;
    }
    const normalizedSource = String(source || "").toLowerCase();
    const isRemuxCandidate = normalizedSource.includes("/api/remux");
    const sourceInput = extractPlaybackSourceInput(source).toLowerCase();
    const shouldConvertUnsafeVideo =
      isMobileOrTabletVideoEnvironment() &&
      looksLikeBrowserUnsafeVideoSource(sourceInput);
    if (
      !sourceInput ||
      (!shouldConvertUnsafeVideo &&
        ![".mkv", ".mk3d", ".webm", ".avi", ".wmv", ".ts"].some((needle) =>
          sourceInput.includes(needle),
        ))
    ) {
      return false;
    }
    const selectedSubtitleTrack = getSubtitleTrackByStreamIndex(subtitleStreamIndex);
    if (shouldUseNativeEmbeddedSubtitleTrack(selectedSubtitleTrack)) {
      return false;
    }

    const normalizedText = getNormalizedPlaybackSourceText(sourceInput);
    if (!normalizedText) {
      return false;
    }

    if (shouldConvertUnsafeVideo) {
      return true;
    }

    if (isRemuxCandidate) {
      return true;
    }

    if (/\b(bdrip x264|bluray x264|h264|x264|avc)\b/.test(normalizedText)) {
      return false;
    }

    return /\b(hevc|x265|h265|h 265|10bit|10 bit|hdr|dolby vision|dv|av1)\b/.test(
      normalizedText,
    );
  }

  function buildPreferredBrowserPlaybackSource(
    source,
    sourceInput = "",
    audioStreamIndex = getSelectedAudioStreamIndex(),
    subtitleStreamIndex = getSelectedSubtitleStreamIndex(),
  ) {
    const normalizedSource = String(source || "").trim();
    if (!normalizedSource) {
      return "";
    }
    const normalizedSourceInput = String(
      sourceInput || extractPlaybackSourceInput(normalizedSource),
    ).trim();
    if (
      !normalizedSourceInput ||
      !shouldPreferBrowserHlsPlayback(normalizedSourceInput, subtitleStreamIndex)
    ) {
      return normalizedSource;
    }
    return buildHlsPlaybackUrl(normalizedSourceInput, audioStreamIndex, -1);
  }

  function shouldUseSoftwareDecode(source) {
    if (isHlsPlaybackSource(source, getOrigin())) {
      return !hasHlsPlaybackSupport();
    }
    const value = String(source || "").toLowerCase();
    return (
      (isMobileOrTabletVideoEnvironment() &&
        looksLikeBrowserUnsafeVideoSource(value)) ||
      value.includes(".mkv") ||
      value.includes(".avi") ||
      value.includes(".wmv") ||
      value.includes(".ts")
    );
  }

  function scoreSourceOptionLanguageForDefault(option = {}) {
    const normalizedPreferred = normalizeSourceLanguage(getPreferredSourceLanguage());
    if (normalizedPreferred === "any") {
      return 0;
    }

    const detected = getDetectedSourceOptionLanguages(option);
    if (detected.has(normalizedPreferred)) {
      return detected.size === 1 ? 4 : 2;
    }
    if (detected.size === 0 && normalizedPreferred === "en") {
      return 1;
    }
    return -5;
  }

  function scoreMobileLightSourceOption(option = {}) {
    if (isSourceOptionEmbed(option)) {
      return 10000;
    }

    const resolution = parseSourceOptionVerticalResolution(option);
    const sizeGb = parseSourceSizeGb(option?.size);
    const text = buildSourceOptionSearchText(option);
    let score = 0;

    if (isSourceOptionLikelyContainer(option, "mp4")) score += 320;
    if (isSourceOptionLikelyContainer(option, "mkv")) score -= 80;

    if (resolution === 720) score += 280;
    else if (resolution > 0 && resolution < 720) score += 120;
    else if (resolution === 1080) score += 40;
    else if (resolution >= 2160) score -= 260;

    if (sizeGb > 0) {
      if (sizeGb <= 2.5) score += 190;
      else if (sizeGb <= 5) score += 140;
      else if (sizeGb <= 8) score += 60;
      else if (sizeGb > 18) score -= 220;
      else if (sizeGb > 12) score -= 120;
    }

    if (/\b(h\.?264|x264|avc)\b/.test(text)) score += 120;
    if (/\b(hevc|h\.?265|x265|10bit|10-bit|hdr|dolby\s*vision|dv|av1)\b/.test(text)) {
      score -= 240;
    }

    const seeders = Number.isFinite(Number(option?.seeders))
      ? Math.max(0, Math.floor(Number(option.seeders)))
      : 0;
    return score + Math.min(seeders, 200) * 0.2;
  }

  function isLikelySourcePack(sourceOption) {
    const text = [
      sourceOption?.primary,
      sourceOption?.filename,
      sourceOption?.provider,
      sourceOption?.releaseGroup,
    ]
      .map((value) => String(value || "").toLowerCase())
      .join(" ");
    return /\b(pack|collection|top\s*\d+|gdrive|movies)\b/.test(text);
  }

  function scoreResolverAlternateSource(sourceOption) {
    if (isSourceOptionEmbed(sourceOption)) {
      return 100000;
    }
    const seeders = Math.max(0, Number(sourceOption?.seeders) || 0);
    const sizeGb = parseSourceSizeGb(sourceOption?.size);
    const resolution = parseSourceOptionVerticalResolution(sourceOption);
    const backendScore = Number(sourceOption?.score);
    let score = Number.isFinite(backendScore) ? backendScore / 100 : 0;
    if (shouldPreferMobileLightTmdbSources()) {
      score += scoreMobileLightSourceOption(sourceOption);
    }

    score += Math.min(seeders, 300) * 0.25;
    if (sizeGb > 0) {
      if (sizeGb <= 3) score += 85;
      else if (sizeGb <= 6) score += 70;
      else if (sizeGb <= 10) score += 50;
      else if (sizeGb <= 16) score += 20;
      else if (sizeGb > 60) score -= 120;
      else if (sizeGb > 30) score -= 80;
    }
    if (resolution === 1080) score += 35;
    else if (resolution === 720) score += 15;
    else if (resolution >= 2160) score += sizeGb > 0 && sizeGb <= 10 ? 8 : -30;

    if (isSourceOptionLikelyContainer(sourceOption, "mp4")) score += 25;
    if (isSourceOptionLikelyContainer(sourceOption, "mkv")) score -= 5;
    if (isLikelySourcePack(sourceOption)) score -= 110;

    return score;
  }

  function pickResolverAlternateSourceHash({
    availablePlaybackSources = [],
    resolverFailedSourceHashes = new Set(),
    selectedSourceHash = "",
    allowPreviouslyFailedFallback = true,
  } = {}) {
    const currentHash = normalizeSourceHash(selectedSourceHash);
    const options = availablePlaybackSources
      .map((option, index) => ({
        option,
        index,
        sourceHash: normalizeSourceHash(option?.sourceHash || option?.infoHash || ""),
      }))
      .filter((item) => item.sourceHash);
    if (!options.length) {
      return "";
    }

    const unfailed = options.filter(
      (item) =>
        item.sourceHash !== currentHash &&
        !resolverFailedSourceHashes.has(item.sourceHash),
    );
    const candidates = unfailed.length
      ? unfailed
      : allowPreviouslyFailedFallback
        ? options.filter((item) => item.sourceHash !== currentHash)
        : [];
    if (!candidates.length) {
      return "";
    }

    if (getPreferredResolverProvider() !== "real-debrid") {
      candidates.sort((left, right) => {
        const scoreDelta =
          scoreResolverAlternateSource(right.option) -
          scoreResolverAlternateSource(left.option);
        if (scoreDelta !== 0) {
          return scoreDelta > 0 ? 1 : -1;
        }
        return left.index - right.index;
      });
      return candidates[0].sourceHash;
    }

    return candidates[0].sourceHash;
  }

  function compareSourceOptionsForDefault(left = {}, right = {}) {
    if (shouldPreferMobileLightTmdbSources()) {
      const leftMobileScore = scoreMobileLightSourceOption(left);
      const rightMobileScore = scoreMobileLightSourceOption(right);
      if (leftMobileScore !== rightMobileScore) {
        return rightMobileScore - leftMobileScore;
      }
    }

    const leftLangScore = scoreSourceOptionLanguageForDefault(left);
    const rightLangScore = scoreSourceOptionLanguageForDefault(right);
    if (leftLangScore !== rightLangScore) {
      return rightLangScore - leftLangScore;
    }

    const leftResolution = parseSourceOptionVerticalResolution(left);
    const rightResolution = parseSourceOptionVerticalResolution(right);
    if (leftResolution !== rightResolution) {
      return rightResolution - leftResolution;
    }

    const leftSeeders = Number.isFinite(Number(left?.seeders))
      ? Math.max(0, Math.floor(Number(left.seeders)))
      : 0;
    const rightSeeders = Number.isFinite(Number(right?.seeders))
      ? Math.max(0, Math.floor(Number(right.seeders)))
      : 0;
    if (leftSeeders !== rightSeeders) {
      return rightSeeders - leftSeeders;
    }

    return getSourceDisplayName(left).localeCompare(
      getSourceDisplayName(right),
      undefined,
      { sensitivity: "base" },
    );
  }

  function getSourceListPreferredContainer() {
    const preferredContainer = String(getPreferredContainer() || "").trim();
    if (preferredContainer) {
      return preferredContainer;
    }
    const preferredSourceFormats = getPreferredSourceFormats();
    if (preferredSourceFormats.length === 1) {
      return preferredSourceFormats[0];
    }
    return "";
  }

  function getDefaultSourceContainerPreference() {
    if (shouldPreferMobileLightTmdbSources()) {
      return "";
    }
    const explicitPreference = getSourceListPreferredContainer();
    if (explicitPreference) {
      return explicitPreference;
    }
    return getSupportedSourceFormatSet().has("mp4") ? "mp4" : "";
  }

  function getPreferredDefaultSourceHash(options = []) {
    const preferredContainerOption =
      [...options]
        .filter((option) =>
          isSourceOptionLikelyContainer(
            option,
            getDefaultSourceContainerPreference(),
          ),
        )
        .sort(compareSourceOptionsForDefault)[0] || null;
    const defaultOption = preferredContainerOption || options[0] || null;
    return normalizeSourceHash(defaultOption?.sourceHash || defaultOption?.infoHash || "");
  }

  return {
    parseHlsMasterSource: (source) => parseHlsMasterSource(source, getOrigin()),
    buildHlsPlaybackUrl,
    extractPlaybackSourceInput,
    hasNativeHlsPlaybackSupport: hasNativeHlsSupportForPlayer,
    hasHlsJsPlaybackSupport,
    hasHlsPlaybackSupport,
    shouldUseHlsJsForSource,
    shouldAvoidRemuxFallbackForHls: isAppleMobileOrTabletVideoEnvironment,
    isMobileOrTabletVideoEnvironment,
    buildPreferredBrowserPlaybackSource,
    shouldUseSoftwareDecode,
    scoreMobileLightSourceOption,
    getSourceListPreferredContainer,
    pickResolverAlternateSourceHash,
    getPreferredDefaultSourceHash,
  };
}

/**
 * Source option display, sorting, and analysis utilities.
 *
 * Every function here operates solely on the `option` / `sources` objects
 * passed to it -- no DOM access, no player-state globals.  This makes them
 * safe for tree-shaking and straightforward to unit-test.
 */

/**
 * Normalise a torrent-style info/source hash to a lowercase 40-char hex
 * string, or return the empty string if the value is invalid.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeSourceHash(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return /^[a-f0-9]{40}$/.test(normalized) ? normalized : "";
}

/**
 * Tokens used to detect what natural language a source belongs to based on
 * its filename / title.
 */
export const SOURCE_LANGUAGE_TOKENS = {
  en: ["english", " eng ", "en audio", "dubbed english", " dual audio eng"],
  fr: ["french", " fran", "vf", "vff", " fra "],
  es: ["spanish", "espanol", "castellano", " spa ", " esp "],
  de: ["german", " deutsch", " ger ", " deu "],
  it: ["italian", " italiano", " ita "],
  pt: ["portuguese", " portugues", " por ", " pt-br ", " brazilian "],
};

// -------------------------------------------------------------------------
// Display helpers
// -------------------------------------------------------------------------

/**
 * Derive a human-readable name for a playback source option.
 *
 * @param {object} option
 * @returns {string}
 */
export function getSourceDisplayName(option = {}) {
  const primary = String(option.primary || "").trim();
  if (primary) {
    return primary;
  }

  const fallback = String(option.filename || "").trim();
  if (fallback) {
    return fallback;
  }

  return "Stream source";
}

/**
 * Derive a short "provider - quality - container" hint string.
 *
 * @param {object} option
 * @returns {string}
 */
export function getSourceDisplayHint(option = {}) {
  const hintParts = [];
  const provider = String(option.provider || "").trim();
  const quality = String(option.qualityLabel || "").trim();
  const container = String(option.container || "")
    .trim()
    .toUpperCase();

  if (provider) {
    hintParts.push(provider);
  }
  if (quality) {
    hintParts.push(quality);
  }
  if (container) {
    hintParts.push(container);
  }

  return hintParts.join(" \u2022 ");
}

/**
 * Derive a metadata string (seeders, size, release group).
 *
 * @param {object} option
 * @returns {string}
 */
export function getSourceDisplayMeta(option = {}) {
  const meta = [];
  const seeders = Number.isFinite(Number(option.seeders))
    ? Math.max(0, Math.floor(Number(option.seeders)))
    : 0;
  const size = String(option.size || "").trim();
  const releaseGroup = String(option.releaseGroup || "").trim();

  if (Number.isFinite(seeders) && seeders > 0) {
    meta.push(`\uD83D\uDC64 ${seeders}`);
  }
  if (size) {
    meta.push(`\uD83D\uDCBE ${size}`);
  }
  if (releaseGroup) {
    meta.push(`\u2699 ${releaseGroup}`);
  }

  return meta.join(" ");
}

// -------------------------------------------------------------------------
// Container / format detection
// -------------------------------------------------------------------------

/**
 * Heuristically determine whether a source option matches a container format
 * (e.g. "mkv" or "mp4") based on its explicit container field or filename.
 *
 * @param {object} option
 * @param {string} container  e.g. "mp4", "mkv"
 * @returns {boolean}
 */
export function isSourceOptionLikelyContainer(option = {}, container = "") {
  const safeContainer = String(container || "")
    .trim()
    .toLowerCase();
  if (!safeContainer) {
    return false;
  }
  const explicitContainer = String(option?.container || "")
    .trim()
    .toLowerCase();
  if (explicitContainer) {
    return explicitContainer === safeContainer;
  }

  const sourceText = [
    option?.filename,
    option?.primary,
    option?.title,
    option?.name,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!sourceText) {
    return false;
  }
  if (safeContainer === "mkv") {
    return /\.mkv\b/.test(sourceText);
  }
  if (safeContainer === "mp4") {
    return /\.mp4\b/.test(sourceText);
  }
  return false;
}

// -------------------------------------------------------------------------
// Resolution / quality parsing
// -------------------------------------------------------------------------

/**
 * Extract a numeric vertical resolution (e.g. 1080, 2160) from a source
 * option's quality label or filename.
 *
 * @param {object} option
 * @returns {number}  0 when no resolution can be detected.
 */
export function parseSourceOptionVerticalResolution(option = {}) {
  const labelMatch = String(option?.qualityLabel || "")
    .toLowerCase()
    .match(/(\d{3,4})p/);
  if (labelMatch) {
    const parsed = Number(labelMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  const text = [
    option?.filename,
    option?.primary,
    option?.title,
    option?.name,
    option?.qualityLabel,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!text) {
    return 0;
  }
  if (/\b(2160p|4k|uhd)\b/.test(text)) return 2160;
  if (/\b1080p\b/.test(text)) return 1080;
  if (/\b720p\b/.test(text)) return 720;
  if (/\b480p\b/.test(text)) return 480;
  return 0;
}

// -------------------------------------------------------------------------
// Language detection
// -------------------------------------------------------------------------

/**
 * Detect natural-language tags present in a source option's filename / title.
 *
 * @param {object} option
 * @returns {Set<string>}
 */
export function getDetectedSourceOptionLanguages(option = {}) {
  const text = ` ${[
    option?.filename,
    option?.primary,
    option?.title,
    option?.name,
    option?.provider,
    option?.releaseGroup,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")} `;

  const matched = new Set();
  if (!text.trim()) {
    return matched;
  }

  Object.entries(SOURCE_LANGUAGE_TOKENS).forEach(([lang, tokens]) => {
    if (
      tokens.some((token) => {
        const normalizedToken = String(token || "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim()
          .replace(/\s+/g, " ");
        if (!normalizedToken) {
          return false;
        }
        return text.includes(` ${normalizedToken} `);
      })
    ) {
      matched.add(lang);
    }
  });

  return matched;
}

// -------------------------------------------------------------------------
// Sorting / ranking
// -------------------------------------------------------------------------

/**
 * Sort a list of source options by seeder count (descending), optionally
 * boosting entries that match a preferred container.
 *
 * @param {Array} sources
 * @param {object} [opts]
 * @param {string} [opts.preferContainer]
 * @returns {Array}
 */
export function sortSourcesBySeeders(sources = [], { preferContainer = "" } = {}) {
  const normalizedPreferredContainer = String(preferContainer || "")
    .trim()
    .toLowerCase();
  return [...sources].sort((left, right) => {
    if (normalizedPreferredContainer) {
      const rightPreferred = isSourceOptionLikelyContainer(
        right,
        normalizedPreferredContainer,
      );
      const leftPreferred = isSourceOptionLikelyContainer(
        left,
        normalizedPreferredContainer,
      );
      if (rightPreferred !== leftPreferred) {
        return Number(rightPreferred) - Number(leftPreferred);
      }
    }

    const rightSeeders = Number.isFinite(Number(right?.seeders))
      ? Math.max(0, Math.floor(Number(right.seeders)))
      : 0;
    const leftSeeders = Number.isFinite(Number(left?.seeders))
      ? Math.max(0, Math.floor(Number(left.seeders)))
      : 0;
    if (rightSeeders !== leftSeeders) {
      return rightSeeders - leftSeeders;
    }
    return getSourceDisplayName(left).localeCompare(
      getSourceDisplayName(right),
      undefined,
      { sensitivity: "base" },
    );
  });
}

// -------------------------------------------------------------------------
// Audio codec detection
// -------------------------------------------------------------------------

const browserSafeAudioCodecSet = new Set([
  "aac",
  "mp3",
  "mp2",
  "opus",
  "vorbis",
  "flac",
  "alac",
]);

const browserUnsafeAudioCodecPrefixes = [
  "ac3",
  "eac3",
  "dts",
  "dca",
  "truehd",
  "mlp",
  "pcm_",
  "wma",
];

/**
 * Return `true` when the given audio codec is expected to work in browser
 * `<video>` playback without server-side transcoding.
 *
 * @param {string} codec
 * @returns {boolean}
 */
export function isBrowserSafeAudioCodec(codec) {
  const normalized = String(codec || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return false;
  }
  if (browserSafeAudioCodecSet.has(normalized)) {
    return true;
  }
  return !browserUnsafeAudioCodecPrefixes.some((prefix) =>
    normalized.startsWith(prefix),
  );
}

/**
 * Subtitle parsing utilities.
 *
 * Pure functions for parsing WebVTT/SRT subtitle text into structured cue
 * arrays.  These have zero dependency on the player DOM or any global state,
 * which makes them safe to tree-shake and test in isolation.
 */

/**
 * Parse a single VTT/SRT timestamp string into seconds.
 *
 * Accepted formats:
 *   HH:MM:SS.mmm
 *   MM:SS.mmm
 *   MM:SS
 *
 * @param {string} value
 * @returns {number} Seconds (may be NaN on invalid input).
 */
export function parseVttTimestampToSeconds(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^((\d{1,2}):)?(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) {
    return NaN;
  }

  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);
  const milliseconds = Number((match[5] || "0").padEnd(3, "0"));
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds) ||
    !Number.isFinite(milliseconds)
  ) {
    return NaN;
  }

  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

/**
 * Decode common HTML entities found in subtitle payloads.
 *
 * @param {string} value
 * @returns {string}
 */
export function decodeSubtitleHtmlEntities(value) {
  const text = String(value || "");
  if (!text || !text.includes("&")) {
    return text;
  }
  const textarea = document.createElement("textarea");
  textarea.innerHTML = text;
  return textarea.value;
}

/**
 * Return `true` when a line looks like a VTT timing line (contains "-->").
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isVttTimingLine(value) {
  return String(value || "").trim().includes("-->");
}

/**
 * Parse a raw WebVTT (or SRT-like) text blob into an array of cue objects.
 *
 * Each cue has the shape `{ startSeconds: number, endSeconds: number, text: string }`.
 *
 * @param {string} rawText  The full contents of a .vtt or .srt file.
 * @returns {Array<{startSeconds: number, endSeconds: number, text: string}>}
 */
export function parseWebVttCues(rawText) {
  const normalized = String(rawText || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (!normalized.trim()) {
    return [];
  }

  const lines = normalized.split("\n");
  const cues = [];
  let index = 0;
  while (index < lines.length) {
    const line = String(lines[index] || "");
    const trimmed = line.trim();

    if (!trimmed || /^WEBVTT\b/i.test(trimmed)) {
      index += 1;
      continue;
    }

    if (/^STYLE\b/i.test(trimmed) || /^NOTE\b/i.test(trimmed)) {
      index += 1;
      while (index < lines.length) {
        const blockLine = String(lines[index] || "");
        const blockTrimmed = blockLine.trim();
        if (!blockTrimmed) {
          break;
        }
        const nextTrimmed = String(lines[index + 1] || "").trim();
        if (
          isVttTimingLine(blockTrimmed) ||
          (nextTrimmed && isVttTimingLine(nextTrimmed))
        ) {
          break;
        }
        index += 1;
      }
      continue;
    }

    if (/^REGION\b/i.test(trimmed) || /^X-TIMESTAMP-MAP=/i.test(trimmed)) {
      index += 1;
      continue;
    }

    let timingLine = trimmed;
    if (!isVttTimingLine(timingLine)) {
      const nextLine = String(lines[index + 1] || "").trim();
      if (isVttTimingLine(nextLine)) {
        index += 1;
        timingLine = nextLine;
      } else {
        index += 1;
        continue;
      }
    }

    const [startPart, endPart] = timingLine
      .split("-->", 2)
      .map((part) => String(part || "").trim());
    const startToken = startPart.split(/\s+/)[0];
    const endToken = endPart.split(/\s+/)[0];
    const startSeconds = parseVttTimestampToSeconds(startToken);
    const endSeconds = parseVttTimestampToSeconds(endToken);
    index += 1;

    const cueLines = [];
    while (index < lines.length && String(lines[index] || "").trim()) {
      cueLines.push(String(lines[index] || ""));
      index += 1;
    }

    const rawCueText = cueLines.join("\n");
    const cueText = decodeSubtitleHtmlEntities(
      rawCueText
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/?[^>]+>/g, "")
        .replace(/\u200b/g, ""),
    ).trim();
    if (
      !cueText ||
      !Number.isFinite(startSeconds) ||
      !Number.isFinite(endSeconds) ||
      endSeconds <= startSeconds
    ) {
      continue;
    }

    cues.push({ startSeconds, endSeconds, text: cueText });
  }

  return cues;
}

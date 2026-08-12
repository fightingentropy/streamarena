export const SUBTITLE_LINE_FROM_BOTTOM = -4;
export const SUBTITLE_FALLBACK_LINE_PERCENT = 80;
export const SUBTITLE_CUE_SIZE_PERCENT = 88;
export const SUBTITLE_CUE_POSITION_PERCENT = 50;
export const SUBTITLE_MATTE_LINE_LIFT_PERCENT = 8;
export const SUBTITLE_MATTE_MIN_HEIGHT_PX = 18;
export const SUBTITLE_MATTE_TOP_PADDING_PX = 6;
export const SUBTITLE_MATTE_BOTTOM_PADDING_PX = 14;
export const SUBTITLE_MATTE_BOTTOM_TARGET_OFFSET_PX = 82;
export const SUBTITLE_MATTE_TOP_GUARD_RATIO = 0.35;

export function computeSubtitleLinePercentInBottomMatte({
  viewportWidth = 0,
  viewportHeight = 0,
  mediaWidth = 0,
  mediaHeight = 0,
} = {}) {
  const viewWidth = Number(viewportWidth || 0);
  const viewHeight = Number(viewportHeight || 0);
  const sourceWidth = Number(mediaWidth || 0);
  const sourceHeight = Number(mediaHeight || 0);
  if (viewWidth <= 0 || viewHeight <= 0 || sourceWidth <= 0 || sourceHeight <= 0) {
    return null;
  }

  const scale = Math.min(viewWidth / sourceWidth, viewHeight / sourceHeight);
  if (!Number.isFinite(scale) || scale <= 0) {
    return null;
  }
  const renderedHeight = sourceHeight * scale;
  const matteHeight = Math.max(0, (viewHeight - renderedHeight) / 2);
  if (!Number.isFinite(matteHeight) || matteHeight < SUBTITLE_MATTE_MIN_HEIGHT_PX) {
    return null;
  }

  const bottomMatteTop = viewHeight - matteHeight;
  const matteTopBoundary = bottomMatteTop + SUBTITLE_MATTE_TOP_PADDING_PX;
  const matteBottomBoundary = viewHeight - SUBTITLE_MATTE_BOTTOM_PADDING_PX;
  if (matteBottomBoundary <= matteTopBoundary) {
    return null;
  }

  const guardedTopTarget =
    matteTopBoundary + matteHeight * SUBTITLE_MATTE_TOP_GUARD_RATIO;
  const preferredBottomTarget = viewHeight - SUBTITLE_MATTE_BOTTOM_TARGET_OFFSET_PX;
  const targetY = Math.min(
    matteBottomBoundary,
    Math.max(matteTopBoundary, Math.max(guardedTopTarget, preferredBottomTarget)),
  );
  const linePercent = (targetY / viewHeight) * 100;
  return Math.max(0, Math.min(100, Number(linePercent.toFixed(2))));
}

export function resolveSubtitleTrackLinePercent(matteCenteredLinePercent) {
  return matteCenteredLinePercent !== null
    ? Math.max(
        0,
        Math.min(100, matteCenteredLinePercent - SUBTITLE_MATTE_LINE_LIFT_PERCENT),
      )
    : SUBTITLE_FALLBACK_LINE_PERCENT;
}

export function applySubtitleCuePlacement(
  cue,
  linePercent,
  {
    fallbackLine = SUBTITLE_LINE_FROM_BOTTOM,
    positionPercent = SUBTITLE_CUE_POSITION_PERCENT,
    sizePercent = SUBTITLE_CUE_SIZE_PERCENT,
  } = {},
) {
  if (!cue) {
    return false;
  }

  try {
    if ("snapToLines" in cue) {
      cue.snapToLines = false;
    }
    if ("line" in cue) {
      cue.line = Number(Number(linePercent).toFixed(2));
    } else {
      cue.line = fallbackLine;
    }
    if ("position" in cue) {
      cue.position = positionPercent;
    }
    if ("size" in cue) {
      cue.size = sizePercent;
    }
    if ("align" in cue) {
      cue.align = "center";
    }
    return true;
  } catch {
    return false;
  }
}

export function nudgeSubtitleTrackPlacementUp(textTrack, matteCenteredLinePercent) {
  if (!textTrack || !textTrack.cues) {
    return;
  }
  const resolvedLinePercent = resolveSubtitleTrackLinePercent(matteCenteredLinePercent);
  Array.from(textTrack.cues).forEach((cue) => {
    applySubtitleCuePlacement(cue, resolvedLinePercent);
  });
}

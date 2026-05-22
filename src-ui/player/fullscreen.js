/**
 * Fullscreen control for the player shell and native video element modes.
 */

/**
 * @param {Document} [doc]
 * @returns {Element|null}
 */
export function getFullscreenElement(doc = document) {
  return doc.fullscreenElement || doc.webkitFullscreenElement || null;
}

/**
 * @param {HTMLVideoElement|null|undefined} video
 * @returns {boolean}
 */
export function isNativeVideoFullscreenActive(video) {
  return Boolean(
    video?.webkitDisplayingFullscreen ||
      video?.webkitPresentationMode === "fullscreen",
  );
}

/**
 * @param {{ video?: HTMLVideoElement|null, document?: Document }} [context]
 * @returns {boolean}
 */
export function isFullscreenActive({ video, document: doc = document } = {}) {
  return Boolean(getFullscreenElement(doc) || isNativeVideoFullscreenActive(video));
}

/**
 * @param {Element|null|undefined} element
 * @returns {((options?: FullscreenOptions) => Promise<void>)|null}
 */
function getFullscreenRequest(element) {
  return (
    element?.requestFullscreen ||
    element?.webkitRequestFullscreen ||
    null
  );
}

/**
 * @param {{ playerShell?: HTMLElement|null, document?: Document }} context
 * @returns {Promise<boolean>}
 */
async function requestPlayerFullscreen({ playerShell, document: doc = document }) {
  const target = playerShell || doc.documentElement;
  const requestFullscreen = getFullscreenRequest(target);
  if (!requestFullscreen) {
    return false;
  }

  try {
    const result = requestFullscreen.call(target);
    if (result && typeof result.then === "function") {
      await result;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {Document} [doc]
 * @returns {Promise<boolean>}
 */
async function exitDocumentFullscreen(doc = document) {
  const exitFullscreen = doc.exitFullscreen || doc.webkitExitFullscreen;
  if (!exitFullscreen) {
    return false;
  }

  try {
    const result = exitFullscreen.call(doc);
    if (result && typeof result.then === "function") {
      await result;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {HTMLVideoElement|null|undefined} video
 * @returns {boolean}
 */
function enterNativeVideoFullscreen(video) {
  try {
    if (typeof video?.webkitEnterFullscreen === "function") {
      video.webkitEnterFullscreen();
      return true;
    }
    if (
      typeof video?.webkitSetPresentationMode === "function" &&
      video.webkitPresentationMode !== "fullscreen"
    ) {
      video.webkitSetPresentationMode("fullscreen");
      return true;
    }
  } catch {
    // Ignore fullscreen errors in restricted environments.
  }
  return false;
}

/**
 * @param {HTMLVideoElement|null|undefined} video
 * @returns {boolean}
 */
function exitNativeVideoFullscreen(video) {
  try {
    if (typeof video?.webkitExitFullscreen === "function") {
      video.webkitExitFullscreen();
      return true;
    }
    if (
      typeof video?.webkitSetPresentationMode === "function" &&
      video.webkitPresentationMode === "fullscreen"
    ) {
      video.webkitSetPresentationMode("inline");
      return true;
    }
  } catch {
    // Ignore fullscreen errors in restricted environments.
  }
  return false;
}

/**
 * @param {HTMLButtonElement|null|undefined} toggleFullscreen
 * @param {{ video?: HTMLVideoElement|null, document?: Document }} context
 */
export function syncFullscreenControlState(
  toggleFullscreen,
  { video, document: doc = document } = {},
) {
  if (!toggleFullscreen) {
    return;
  }
  const label = isFullscreenActive({ video, document: doc })
    ? "Exit fullscreen"
    : "Fullscreen";
  toggleFullscreen.setAttribute("aria-label", label);
  toggleFullscreen.setAttribute("title", label);
}

/**
 * @param {{
 *   video?: HTMLVideoElement|null,
 *   playerShell?: HTMLElement|null,
 *   toggleFullscreen?: HTMLButtonElement|null,
 *   document?: Document,
 * }} context
 * @returns {Promise<void>}
 */
export async function toggleFullscreenMode(context) {
  const { video, playerShell, toggleFullscreen, document: doc = document } = context;

  if (isNativeVideoFullscreenActive(video)) {
    exitNativeVideoFullscreen(video);
    syncFullscreenControlState(toggleFullscreen, { video, document: doc });
    return;
  }

  if (getFullscreenElement(doc)) {
    await exitDocumentFullscreen(doc);
    syncFullscreenControlState(toggleFullscreen, { video, document: doc });
    return;
  }

  const supportsElementFullscreen = Boolean(
    getFullscreenRequest(playerShell || doc.documentElement),
  );
  if (!supportsElementFullscreen && enterNativeVideoFullscreen(video)) {
    syncFullscreenControlState(toggleFullscreen, { video, document: doc });
    return;
  }

  const enteredDocumentFullscreen = await requestPlayerFullscreen({
    playerShell,
    document: doc,
  });
  if (!enteredDocumentFullscreen) {
    enterNativeVideoFullscreen(video);
  }
  syncFullscreenControlState(toggleFullscreen, { video, document: doc });
}

/**
 * @param {{
 *   getContext: () => {
 *     video?: HTMLVideoElement|null,
 *     playerShell?: HTMLElement|null,
 *     toggleFullscreen?: HTMLButtonElement|null,
 *   },
 *   trackListener: (target: EventTarget|null|undefined, event: string, handler: EventListener, options?: AddEventListenerOptions) => void,
 *   onLayoutChange?: () => void,
 * }} options
 */
export function attachFullscreenControl({ getContext, trackListener, onLayoutChange }) {
  const handleLayoutChange = () => {
    onLayoutChange?.();
    syncFullscreenControlState(getContext().toggleFullscreen, getContext());
  };

  trackListener(getContext().toggleFullscreen, "click", async () => {
    await toggleFullscreenMode(getContext());
  });
  trackListener(document, "fullscreenchange", handleLayoutChange);
  trackListener(document, "webkitfullscreenchange", handleLayoutChange);
  trackListener(getContext().video, "webkitbeginfullscreen", handleLayoutChange);
  trackListener(getContext().video, "webkitendfullscreen", handleLayoutChange);

  syncFullscreenControlState(getContext().toggleFullscreen, getContext());
}

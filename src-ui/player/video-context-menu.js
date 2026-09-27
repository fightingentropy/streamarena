export function getCopyableVideoLink(source, baseUrl) {
  if (!source) return "";
  try {
    const url = new URL(source, baseUrl);
    return /^(https?:)$/.test(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

export function createVideoContextMenu({
  getElements,
  getCurrentPlayback,
  download,
  listen,
  onOpen,
  onClose,
}) {
  let anchor = { x: 0, y: 0 };
  let copyState = "";
  let copying = false;

  function isOpen() {
    return getElements().menu?.hidden === false;
  }

  function position() {
    const { shell, menu } = getElements();
    if (!isOpen()) return;
    menu.style.left = `${Math.max(8, Math.min(anchor.x, shell.clientWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(anchor.y, shell.clientHeight - menu.offsetHeight - 8))}px`;
  }

  function sync() {
    const { menu } = getElements();
    if (!menu) return;
    const playback = getCurrentPlayback();
    const state = download.getState();
    const preparing = state === "preparing";
    const copyButton = menu.querySelector('[data-video-action="copy"]');
    const downloadButton = menu.querySelector('[data-video-action="download"]');
    copyButton.setAttribute("aria-disabled", String(copying || !playback?.link));
    downloadButton.setAttribute("aria-disabled", String(preparing || !playback?.input));
    downloadButton.setAttribute("aria-busy", String(preparing));
    downloadButton.classList.toggle("is-loading", preparing);
    menu.querySelector("[data-video-download-label]").textContent = preparing
      ? "Preparing download…" : state === "error" ? "Retry download" : "Download video";
    const status = menu.querySelector(".video-action-status");
    status.hidden = !copyState && state === "idle";
    status.dataset.state = copyState ? "copy" : state;
    menu.querySelector("[data-video-action-title]").textContent = copyState || ({
      preparing: "Preparing your MP4…",
      handedOff: "Sent to your browser",
      error: "Download unavailable",
    }[state] || "");
    const detail = menu.querySelector("[data-video-action-detail]");
    detail.textContent = copyState ? "" : download.getStatusMessage();
    detail.hidden = !detail.textContent;
    position();
  }

  function close(restoreFocus = false) {
    const { shell, menu } = getElements();
    if (!isOpen()) return;
    menu.hidden = true;
    if (restoreFocus) shell.focus({ preventScroll: true });
    onClose();
  }

  function open(x, y) {
    const { menu } = getElements();
    anchor = { x, y };
    copyState = "";
    onOpen();
    menu.hidden = false;
    sync();
    (menu.querySelector('[role="menuitem"][aria-disabled="false"]') || menu)
      .focus({ preventScroll: true });
  }

  // Called before player shortcuts, including Escape's navigate-back action.
  function handleKeydown(event) {
    const { shell, menu } = getElements();
    if (!isOpen()) {
      if ((event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) &&
          (event.target === shell || event.target?.tagName === "VIDEO")) {
        event.preventDefault();
        event.stopPropagation();
        open(shell.clientWidth / 2, shell.clientHeight / 2);
        return true;
      }
      return false;
    }
    if (event.key === "Escape" || event.key === "Tab") {
      close(true);
      if (event.key === "Escape") event.preventDefault();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const items = [...menu.querySelectorAll('[role="menuitem"][aria-disabled="false"]')];
      const index = items.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
      items[next]?.focus({ preventScroll: true });
    }
    event.stopPropagation();
    return true;
  }

  function mount() {
    const { shell, menu } = getElements();
    const interactive = "button, input, textarea, select, a, [contenteditable='true'], [role='dialog'], [role='menu']";
    listen(shell, "contextmenu", (event) => {
      if (event.target?.closest(interactive)) return;
      event.preventDefault();
      const bounds = shell.getBoundingClientRect();
      open(event.clientX - bounds.left, event.clientY - bounds.top);
    });
    listen(menu, "contextmenu", (event) => event.preventDefault());
    listen(menu, "click", async (event) => {
      event.stopPropagation();
      const button = event.target.closest("[data-video-action]");
      if (!button || button.getAttribute("aria-disabled") === "true") return;
      if (button.dataset.videoAction === "download") {
        copyState = "";
        await download.download();
      } else {
        const link = getCurrentPlayback()?.link;
        if (!link || copying) return;
        copying = true;
        sync();
        try {
          await navigator.clipboard.writeText(link);
          copyState = "Video link copied";
        } catch {
          copyState = "Couldn’t copy the link. Try again.";
        } finally {
          copying = false;
          sync();
        }
      }
    });
    listen(document, "click", (event) => {
      // The temporary download link is clicked programmatically. Keep its
      // progress message visible; only an outside user click dismisses it.
      if (!event.isTrusted || !isOpen() || menu.contains(event.target)) return;
      close();
      // A click on the picture dismisses the menu without pausing the video.
      if (shell.contains(event.target) && !event.target.closest(interactive)) {
        event.preventDefault();
        event.stopPropagation();
        shell.focus({ preventScroll: true });
      }
    }, { capture: true });
    listen(document, "focusin", (event) => {
      if (isOpen() && !menu.contains(event.target)) close();
    });
    listen(window, "resize", () => close(true));
    listen(document, "fullscreenchange", () => close(true));
    const video = shell.querySelector("video");
    listen(video, "loadedmetadata", sync);
    listen(video, "emptied", sync);
  }

  return { mount, sync, isOpen, handleKeydown };
}

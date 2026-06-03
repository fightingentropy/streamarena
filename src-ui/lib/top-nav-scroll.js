const NAV_SCROLLED_CLASS = "is-nav-scrolled";

export function bindTopNavScrollState(threshold = 24) {
  if (typeof window === "undefined" || typeof document === "undefined" || !document.body) {
    return () => {};
  }

  let frameRequested = false;

  const update = () => {
    frameRequested = false;
    document.body.classList.toggle(NAV_SCROLLED_CLASS, window.scrollY > threshold);
  };

  const requestUpdate = () => {
    if (frameRequested) return;
    frameRequested = true;
    window.requestAnimationFrame(update);
  };

  update();
  window.addEventListener("scroll", requestUpdate, { passive: true });
  window.addEventListener("resize", requestUpdate, { passive: true });

  return () => {
    window.removeEventListener("scroll", requestUpdate);
    window.removeEventListener("resize", requestUpdate);
    document.body.classList.remove(NAV_SCROLLED_CLASS);
  };
}

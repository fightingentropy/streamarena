const DRAG_START_PX = 6;
const CLICK_SUPPRESSION_MS = 250;

function getMaxScrollLeft(rail) {
  return Math.max(0, rail.scrollWidth - rail.clientWidth);
}

function canScrollBy(rail, amount) {
  const maxScrollLeft = getMaxScrollLeft(rail);
  if (maxScrollLeft <= 1 || Math.abs(amount) < 0.01) {
    return false;
  }
  if (amount < 0) {
    return rail.scrollLeft > 0;
  }
  return rail.scrollLeft < maxScrollLeft - 1;
}

function getWheelPixels(event, rail) {
  const unit =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? rail.clientWidth
        : 1;
  return unit;
}

function getHorizontalWheelDelta(event, rail) {
  const unit = getWheelPixels(event, rail);
  if (event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
    return event.deltaY * unit;
  }
  return event.deltaX * unit;
}

function isInteractiveControl(target) {
  return Boolean(
    target?.closest?.(
      "a, button, input, textarea, select, summary, [role='button'], [contenteditable='true']",
    ),
  );
}

function shouldUseNativeTouchScroll(event) {
  const pointerType = String(event.pointerType || "").toLowerCase();
  return pointerType === "touch" || pointerType === "pen";
}

export function bindHorizontalRailScroll(rail) {
  if (!(rail instanceof HTMLElement)) {
    return () => {};
  }

  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let startScrollLeft = 0;
  let isDragging = false;
  let suppressClickUntil = 0;

  const stopDragging = () => {
    if (isDragging) {
      suppressClickUntil = Date.now() + CLICK_SUPPRESSION_MS;
    }
    isDragging = false;
    pointerId = null;
    rail.classList.remove("is-rail-dragging");
  };

  const handleWheel = (event) => {
    const absX = Math.abs(event.deltaX);
    const absY = Math.abs(event.deltaY);
    const horizontalDelta = getHorizontalWheelDelta(event, rail);
    const isHorizontalGesture =
      (event.shiftKey && absY > absX) ||
      (absX > absY && absX > 1);

    // Let vertical trackpad scrolling reach the page when the pointer is over a rail.
    if (!isHorizontalGesture || !canScrollBy(rail, horizontalDelta)) {
      return;
    }

    event.preventDefault();
    rail.scrollLeft += horizontalDelta;
  };

  const handlePointerDown = (event) => {
    if (shouldUseNativeTouchScroll(event)) {
      stopDragging();
      return;
    }
    if (event.button !== 0 || isInteractiveControl(event.target) || getMaxScrollLeft(rail) <= 1) {
      return;
    }

    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    startScrollLeft = rail.scrollLeft;
    isDragging = false;
  };

  const handlePointerMove = (event) => {
    if (event.pointerId !== pointerId) {
      return;
    }

    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;

    if (!isDragging) {
      if (
        Math.abs(deltaX) < DRAG_START_PX ||
        Math.abs(deltaX) < Math.abs(deltaY) * 1.1
      ) {
        return;
      }
      isDragging = true;
      rail.classList.add("is-rail-dragging");
      rail.setPointerCapture?.(event.pointerId);
    }

    event.preventDefault();
    rail.scrollLeft = startScrollLeft - deltaX;
  };

  const handlePointerUp = (event) => {
    if (event.pointerId !== pointerId) {
      return;
    }
    rail.releasePointerCapture?.(event.pointerId);
    stopDragging();
  };

  const handlePointerCancel = (event) => {
    if (event.pointerId === pointerId) {
      stopDragging();
    }
  };

  const handleClick = (event) => {
    if (Date.now() > suppressClickUntil) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  rail.addEventListener("wheel", handleWheel, { passive: false });
  rail.addEventListener("pointerdown", handlePointerDown);
  rail.addEventListener("pointermove", handlePointerMove);
  rail.addEventListener("pointerup", handlePointerUp);
  rail.addEventListener("pointercancel", handlePointerCancel);
  rail.addEventListener("click", handleClick, true);

  return () => {
    rail.removeEventListener("wheel", handleWheel);
    rail.removeEventListener("pointerdown", handlePointerDown);
    rail.removeEventListener("pointermove", handlePointerMove);
    rail.removeEventListener("pointerup", handlePointerUp);
    rail.removeEventListener("pointercancel", handlePointerCancel);
    rail.removeEventListener("click", handleClick, true);
    rail.classList.remove("is-rail-dragging");
  };
}

export function bindHorizontalRailScrollers(root = document) {
  const cleanups = [...root.querySelectorAll(".cards.popular-cards")].map(
    bindHorizontalRailScroll,
  );
  return () => {
    cleanups.forEach((cleanup) => cleanup());
  };
}

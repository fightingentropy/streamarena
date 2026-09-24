export function isAppleMobileOrTabletVideoEnvironment() {
  const nav = globalThis.window?.navigator || globalThis.navigator || {};
  return (
    /\b(iPad|iPhone|iPod)\b/i.test(String(nav.userAgent || "")) ||
    (nav.platform === "MacIntel" && Number(nav.maxTouchPoints || 0) > 1)
  );
}

export function isMobileOrTabletVideoEnvironment() {
  if (isAppleMobileOrTabletVideoEnvironment()) return true;
  const nav = globalThis.window?.navigator || globalThis.navigator || {};
  if (/\b(Android|Mobile|Phone|Tablet|Silk|Kindle)\b/i.test(String(nav.userAgent || ""))) return true;
  if (/\b(Android|iPad|iPhone|iPod)\b/i.test(String(nav.platform || ""))) return true;
  try {
    return Boolean(
      globalThis.window?.matchMedia?.("(hover: none) and (pointer: coarse)")?.matches &&
      globalThis.window?.matchMedia?.("(max-width: 1180px)")?.matches,
    );
  } catch {
    return false;
  }
}

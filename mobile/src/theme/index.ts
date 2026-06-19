// Design-system tokens for non-className contexts (icon colors, gradients,
// reanimated, video player chrome). Mirror of tailwind.config.js.
//
// StreamArena is a Netflix-flavored skin of the Spotify port: dark base, a single
// red accent. The legacy `green`/`emerald` keys are kept (aliased to the red
// accent) so components ported verbatim from spotify/mobile compile and render
// in-brand without per-file edits.

export const colors = {
  background: "#0a0a0a",
  surface: "#181818",
  foreground: "#ffffff",
  muted: "#b3b3b3",
  dim: "rgba(255,255,255,0.46)",
  // Netflix red.
  accent: "#e50914",
  accentPressed: "#b20710",
  // Legacy aliases (ported Spotify components reference these).
  green: "#e50914",
  emerald: "#e50914",
  emeraldDarkCheck: "#2b0a0a",
  card: "rgba(255,255,255,0.08)",
  cardHover: "rgba(255,255,255,0.09)",
  cardActive: "rgba(255,255,255,0.12)",
  line: "rgba(255,255,255,0.10)",
  iconIdle: "rgba(255,255,255,0.70)",
  backdrop: "rgba(0,0,0,0.60)",
  // Gradient scrim stops over backdrops/posters.
  scrimTop: "rgba(10,10,10,0)",
  scrimMid: "rgba(10,10,10,0.55)",
  scrimBottom: "rgba(10,10,10,0.97)",
  skeletonBase: "rgba(255,255,255,0.08)",
  skeletonShimmer: "rgba(255,255,255,0.13)",
  white: "#ffffff",
} as const;

export const layout = {
  mobileNavHeight: 52, // bottom tab bar
  listRowMinHeight: 64,
  // Poster (2:3) geometry for rails/grids.
  posterWidth: 120,
  posterHeight: 180,
  posterWidthLg: 140,
  posterHeightLg: 210,
  // Landscape still (16:9-ish) for continue-watching / episodes.
  stillWidth: 220,
  stillHeight: 124,
  heroHeight: 520, // billboard hero
  // Legacy aliases used by ported components.
  cardWidthSm: 144,
  cardWidthMd: 160,
} as const;

// Easing curves (cubic-bezier control points) for Reanimated `Easing.bezier(...)`.
// Keys match the Spotify port so ported components (Sheet, PressableScale, …)
// reference them unchanged.
export const motion = {
  routeEnter: { ms: 220, bezier: [0.16, 1, 0.3, 1] as const },
  coverSettle: { ms: 520, bezier: [0.16, 1, 0.3, 1] as const },
  skeleton: { ms: 1250 },
  pressScale: { ms: 160, scale: 0.985 },
  cardPress: { ms: 220, scale: 0.985, bezier: [0.2, 0.8, 0.2, 1] as const },
  listRow: { ms: 170 },
  sheetBackdrop: { ms: 280 },
  npOpen: { ms: 360, bezier: [0.16, 1, 0.3, 1] as const, opacityMs: 260 },
  npClose: { ms: 360, bezier: [0.4, 0, 1, 1] as const, opacityMs: 260, opacityDelayMs: 120 },
  marquee: { ms: 9000, startDelayMs: 1500, edgeFadePx: 14 },
} as const;

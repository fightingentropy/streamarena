// Design-system tokens for non-className contexts (icon colors, artwork scrims,
// reanimated motion, and player chrome). Mirror of tailwind.config.js.
//
// The app chrome is deliberately monochrome: artwork is the expressive colour,
// while red is reserved for live/destructive semantics. The legacy
// `green`/`emerald` aliases remain so older ported components keep compiling while
// inheriting the neutral selection colour.

export const colors = {
  background: "#000000",
  surface: "#0c0c0d",
  surfaceRaised: "#151516",
  foreground: "#f2f2f2",
  muted: "rgba(255,255,255,0.60)",
  dim: "rgba(255,255,255,0.40)",
  accent: "#f2f2f2",
  accentPressed: "#d8d8da",
  live: "#ff453a",
  danger: "#ff6961",
  warning: "#ff9f0a",
  // Legacy aliases used by a few ported components.
  green: "#f2f2f2",
  emerald: "#f2f2f2",
  emeraldDarkCheck: "#111113",
  card: "rgba(255,255,255,0.045)",
  cardHover: "rgba(255,255,255,0.065)",
  cardActive: "rgba(255,255,255,0.09)",
  line: "rgba(255,255,255,0.08)",
  hairline: "rgba(255,255,255,0.12)",
  iconIdle: "rgba(255,255,255,0.58)",
  backdrop: "rgba(0,0,0,0.66)",
  // Functional artwork/video scrim stops.
  scrimTop: "rgba(0,0,0,0)",
  scrimMid: "rgba(0,0,0,0.46)",
  scrimBottom: "rgba(0,0,0,0.96)",
  skeletonBase: "rgba(255,255,255,0.055)",
  skeletonShimmer: "rgba(255,255,255,0.09)",
  white: "#ffffff",
  black: "#000000",
} as const;

export const layout = {
  mobileNavHeight: 58, // bottom tab bar
  listRowMinHeight: 64,
  // Poster (2:3) geometry for rails/grids.
  posterWidth: 132,
  posterHeight: 198,
  posterWidthLg: 148,
  posterHeightLg: 222,
  // Landscape still (16:9-ish) for continue-watching / episodes.
  stillWidth: 240,
  stillHeight: 135,
  heroHeight: 528, // cinematic billboard hero
  // Legacy aliases used by ported components.
  cardWidthSm: 144,
  cardWidthMd: 160,
} as const;

export const radius = {
  control: 12,
  card: 14,
  artwork: 16,
  sheet: 28,
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

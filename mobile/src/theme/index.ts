// Design-system tokens for non-className contexts (icon colors, artwork scrims,
// reanimated motion, and player chrome). Mirror of tailwind.config.js.
//
// Match the web's Geist / ink / coral theme. Keep the video canvas black and
// preserve distinct live, warning and destructive colors.

export const colors = {
  background: "#0b1017",
  surface: "#151c26",
  surfaceRaised: "#202a37",
  foreground: "#f1f4f8",
  muted: "#a8b3c3",
  dim: "#8995a7",
  accent: "#f2a38b",
  accentPressed: "#ffc0ab",
  accentSoft: "#f2a38b16",
  accentLine: "#f2a38b70",
  onAccent: "#291911",
  header: "#0b1017f5",
  live: "#ff453a",
  danger: "#ff6961",
  warning: "#ff9f0a",
  // Legacy aliases used by a few ported components.
  green: "#f2a38b",
  emerald: "#f2a38b",
  emeraldDarkCheck: "#291911",
  card: "#d9e5ff0b",
  cardHover: "#d9e5ff11",
  cardActive: "#d9e5ff17",
  line: "#d9e5ff1c",
  hairline: "#d9e5ff33",
  iconIdle: "#a8b3c3",
  backdrop: "rgba(0,0,0,0.66)",
  // Functional artwork/video scrim stops.
  scrimTop: "rgba(0,0,0,0)",
  scrimMid: "rgba(11,16,23,0.46)",
  scrimBottom: "rgba(11,16,23,0.96)",
  skeletonBase: "#d9e5ff0e",
  skeletonShimmer: "#d9e5ff17",
  white: "#ffffff",
  black: "#000000",
} as const;

// Static weights are embedded by expo-font at build time, so iOS can select the
// correct face immediately without a startup fetch or a font-swap layout shift.
export const typography = { fontFamily: "Geist" } as const;

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

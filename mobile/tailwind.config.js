/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        // Page / surfaces — Netflix-dark
        background: "#0a0a0a", // near-black page bg
        surface: "#181818", // elevated card surface
        foreground: "#ffffff", // primary text
        muted: "#b3b3b3", // secondary text
        dim: "rgba(255,255,255,0.46)", // captions
        // Netflix red accent. The legacy Spotify `green`/`emerald` keys are aliased
        // to the same red so ported components render in-brand without edits.
        accent: "#e50914",
        accentPressed: "#b20710",
        green: "#e50914",
        emerald: "#e50914",
        emeraldDarkCheck: "#2b0a0a",
        card: "rgba(255,255,255,0.08)",
        cardHover: "rgba(255,255,255,0.09)",
        cardActive: "rgba(255,255,255,0.12)",
        line: "rgba(255,255,255,0.10)", // hairline border
        iconIdle: "rgba(255,255,255,0.70)",
        backdrop: "rgba(0,0,0,0.60)",
      },
      borderRadius: {
        card: "8px",
        row: "12px",
        art: "16px",
        poster: "8px",
        still: "6px",
        pill: "9999px",
      },
    },
  },
  plugins: [],
};

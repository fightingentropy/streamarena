// Arched brand wordmark: flat top edge, the baseline bowing up in the middle
// with the outer letters slightly taller (Netflix-logo style). Shared by the
// top-nav and the hero on the browse pages so they stay identical.
//
// The arch is COMPUTED from the word below — to rebrand, change WORD only.
// Fill/font come from `.brand-wordmark-arc text` in style.css; pass a sizing
// modifier class via `props.class` (e.g. "brand-wordmark-arc--nav").

// Change this one line to rebrand.
const WORD = "StreamArena";

const BASE_FONT = 42; // middle-letter font size, in viewBox units
const ARCH = 0.14; // outer letters grow to (1 + ARCH)x → taller ends
const CAP = 0.71; // baseline drop per unit of size growth (keeps the top flat)
const FIRST_BASELINE = 40.3; // baseline y of the first (tallest) letter

// For each letter: a font size that grows toward the ends, and a baseline delta
// (dy) that drops bigger letters just enough to keep every cap-top on one line —
// so only the bottom edge forms the arch.
function archLetters(word) {
  const chars = [...word];
  const center = (chars.length - 1) / 2;
  const sizes = chars.map((_, i) => {
    const t = center === 0 ? 0 : (i - center) / center; // -1..1
    return BASE_FONT * (1 + ARCH * t * t);
  });
  return chars.map((ch, i) => ({
    ch,
    fontSize: Math.round(sizes[i] * 10) / 10,
    dy: i === 0 ? 0 : Math.round(CAP * (sizes[i] - sizes[i - 1]) * 10) / 10,
  }));
}

const LETTERS = archLetters(WORD);

export default function BrandWordmark(props) {
  return (
    <svg
      class={`brand-wordmark-arc${props.class ? ` ${props.class}` : ""}`}
      viewBox="0 -9 268 63"
      role="img"
      aria-label={WORD}
      xmlns="http://www.w3.org/2000/svg"
    >
      <text x="0" y={FIRST_BASELINE} text-anchor="start">
        {LETTERS.map((l, i) => (
          <tspan font-size={l.fontSize} dy={i === 0 ? undefined : l.dy}>
            {l.ch}
          </tspan>
        ))}
      </text>
    </svg>
  );
}

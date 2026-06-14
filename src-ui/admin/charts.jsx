// Reusable, CSP-safe SVG chart primitives for the admin dashboard.
//
// CSP rules on this app forbid inline `style` attributes and `<style>` blocks
// (see csp-no-inline-styles). Everything here is therefore drawn with SVG
// *presentation attributes* (x/y/width/height/d/fill-opacity/…), which are not
// the `style` attribute and are allowed, and colored with CSS classes from
// admin.css. The accent colour of a chart is driven by a single tone class on
// the root <svg>: the class sets `color`, and shapes use `fill="currentColor"` /
// `stroke="currentColor"` so one class themes the whole thing — including
// gradient stops via `stop-color="currentColor"`.
//
// All data comes in through props accessors so charts re-render reactively.

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";

// Unique ids for gradient/clip defs so multiple chart instances never collide.
let uidCounter = 0;
function nextUid() {
  uidCounter += 1;
  return uidCounter;
}

const defaultNumberFormat = new Intl.NumberFormat();
function fmt(value) {
  return defaultNumberFormat.format(Math.round(Number(value) || 0));
}

// Round a max value up to a "nice" axis ceiling that leaves a little headroom
// (~10%) without wasting half the chart — peaks should fill most of the height.
function niceMax(value) {
  const v = Number(value) || 0;
  if (v <= 0) return 1;
  if (v <= 12) return Math.ceil(v * 1.12);
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const step = pow / 5;
  return Math.ceil((v * 1.08) / step) * step;
}

// Catmull-Rom → cubic-bezier smoothing for line/area charts. `points` is an
// array of [x, y]. Returns an SVG path `d` string. Straight when smoothing = 0.
function smoothLine(points, smoothing = 0.16) {
  if (!points.length) return "";
  if (points.length < 3 || smoothing <= 0) {
    return points
      .map((p, i) => `${i ? "L" : "M"} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`)
      .join(" ");
  }
  const control = (cur, prev, next, reverse) => {
    const p = prev || cur;
    const n = next || cur;
    const dx = n[0] - p[0];
    const dy = n[1] - p[1];
    const angle = Math.atan2(dy, dx) + (reverse ? Math.PI : 0);
    const len = Math.hypot(dx, dy) * smoothing;
    return [cur[0] + Math.cos(angle) * len, cur[1] + Math.sin(angle) * len];
  };
  return points.reduce((acc, point, i, arr) => {
    if (i === 0) return `M ${point[0].toFixed(2)} ${point[1].toFixed(2)}`;
    const cps = control(arr[i - 1], arr[i - 2], point, false);
    const cpe = control(point, arr[i - 1], arr[i + 1], true);
    return `${acc} C ${cps[0].toFixed(2)} ${cps[1].toFixed(2)}, ${cpe[0].toFixed(2)} ${cpe[1].toFixed(2)}, ${point[0].toFixed(2)} ${point[1].toFixed(2)}`;
  }, "");
}

// Donut/pie arc path between two angles (radians, 0 = 3 o'clock).
function arcPath(cx, cy, rOuter, rInner, a0, a1) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const x0 = cx + rOuter * Math.cos(a0);
  const y0 = cy + rOuter * Math.sin(a0);
  const x1 = cx + rOuter * Math.cos(a1);
  const y1 = cy + rOuter * Math.sin(a1);
  const xi1 = cx + rInner * Math.cos(a1);
  const yi1 = cy + rInner * Math.sin(a1);
  const xi0 = cx + rInner * Math.cos(a0);
  const yi0 = cy + rInner * Math.sin(a0);
  return [
    `M ${x0.toFixed(2)} ${y0.toFixed(2)}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`,
    `L ${xi1.toFixed(2)} ${yi1.toFixed(2)}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${xi0.toFixed(2)} ${yi0.toFixed(2)}`,
    "Z",
  ].join(" ");
}

const toneClass = (tone) => (tone ? `t-${tone}` : "t-blue");

// Map a pointer event to a fractional x position (0..1) inside an SVG, robust to
// the uniform scaling we apply via CSS (viewBox + width:100%).
function pointerFraction(event, svg) {
  const rect = svg.getBoundingClientRect();
  if (!rect.width) return 0;
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
}

// ── TrendChart ────────────────────────────────────────────────────────────────
// The workhorse: a daily series rendered as bars *or* a smoothed area, with
// gridlines, y/x axis labels, an optional overlay line (e.g. moving average),
// and a hover crosshair + focus highlight + value bubble. Calls `onFocus(point
// | null)` so a parent can mirror the hovered value in a panel header.
export function TrendChart(props) {
  // The chart is width-aware: the viewBox width tracks the container's pixel
  // width (1 unit = 1px) and the height is fixed, so the SVG fills the panel at
  // a constant height with no scaling distortion of text or strokes.
  const H = 300;
  const padL = 46;
  const padR = 16;
  const padTop = 20;
  const padBottom = 32;
  const [vw, setVw] = createSignal(760);
  const W = () => vw();
  const innerW = () => W() - padL - padR;
  const innerH = H - padTop - padBottom;
  const uid = nextUid();
  const gradId = `tc-grad-${uid}`;

  let host;
  onMount(() => {
    if (!host) return;
    if (host.clientWidth) setVw(host.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width;
      if (width && Math.abs(width - vw()) > 1) setVw(Math.round(width));
    });
    ro.observe(host);
    onCleanup(() => ro.disconnect());
  });

  const [focus, setFocus] = createSignal(-1);

  const data = () => props.data || [];
  const mode = () => props.mode || "area";
  const overlay = () => props.overlay || null;
  const valueFmt = (v) => (props.format ? props.format(v) : fmt(v));
  const xLabel = (d) => (props.xFormat ? props.xFormat(d.label) : d.label);

  const max = createMemo(() => {
    const vals = data().map((d) => Number(d.value) || 0);
    const ov = overlay() ? overlay().map((v) => Number(v) || 0) : [];
    return niceMax(Math.max(1, ...vals, ...ov));
  });

  const x = (i) => {
    const n = data().length;
    if (mode() === "bars") {
      const slot = innerW() / Math.max(1, n);
      return padL + i * slot + slot / 2;
    }
    const step = innerW() / Math.max(1, n - 1);
    return padL + i * step;
  };
  const y = (v) => padTop + innerH - (Math.max(0, v) / max()) * innerH;

  const barW = createMemo(() => {
    const slot = innerW() / Math.max(1, data().length);
    return Math.max(2, Math.min(46, slot * 0.62));
  });

  const linePts = createMemo(() =>
    data().map((d, i) => [x(i), y(Number(d.value) || 0)]),
  );
  const linePath = createMemo(() => smoothLine(linePts(), 0.16));
  const areaPath = createMemo(() => {
    const line = linePath();
    if (!line) return "";
    const pts = linePts();
    const x0 = pts[0][0];
    const xN = pts[pts.length - 1][0];
    const base = padTop + innerH;
    return `${line} L ${xN.toFixed(2)} ${base} L ${x0.toFixed(2)} ${base} Z`;
  });
  const overlayPath = createMemo(() => {
    const ov = overlay();
    if (!ov || ov.length < 2) return "";
    return smoothLine(
      ov.map((v, i) => [x(i), y(Number(v) || 0)]),
      0.2,
    );
  });

  // Gridlines + y labels at 0, ¼, ½, ¾, max.
  const gridLines = createMemo(() =>
    [0, 0.25, 0.5, 0.75, 1].map((f) => ({
      yy: padTop + innerH - f * innerH,
      label: valueFmt(Math.round(max() * f)),
    })),
  );

  // ~6 evenly spaced x labels.
  const xTicks = createMemo(() => {
    const n = data().length;
    if (!n) return [];
    const want = Math.min(7, n);
    const stepI = Math.max(1, Math.round((n - 1) / (want - 1 || 1)));
    const out = [];
    for (let i = 0; i < n; i += stepI) out.push(i);
    if (out[out.length - 1] !== n - 1) out.push(n - 1);
    return out;
  });

  const onMove = (event) => {
    const n = data().length;
    if (!n) return;
    const frac = pointerFraction(event, event.currentTarget);
    const px = frac * W();
    let idx;
    if (mode() === "bars") {
      const slot = innerW() / n;
      idx = Math.floor((px - padL) / slot);
    } else {
      const step = innerW() / Math.max(1, n - 1);
      idx = Math.round((px - padL) / step);
    }
    idx = Math.min(n - 1, Math.max(0, idx));
    if (idx !== focus()) {
      setFocus(idx);
      props.onFocus?.({ index: idx, ...data()[idx] });
    }
  };
  const onLeave = () => {
    setFocus(-1);
    props.onFocus?.(null);
  };

  const bubble = createMemo(() => {
    const i = focus();
    if (i < 0 || i >= data().length) return null;
    const d = data()[i];
    const valStr = valueFmt(d.value);
    const dateStr = xLabel(d);
    const w = Math.max(48, Math.max(valStr.length, dateStr.length) * 7.4 + 18);
    let bx = x(i) - w / 2;
    bx = Math.min(W() - padR - w, Math.max(padL, bx));
    const py = y(Number(d.value) || 0);
    let by = py - 50;
    const flip = by < padTop;
    if (flip) by = py + 14;
    return { bx, by, w, valStr, dateStr, cx: x(i), cy: py, flip };
  });

  return (
    <div class="admin-trend-host" ref={host}>
    <Show
      when={data().length}
      fallback={<div class="admin-chart-empty">No data yet.</div>}
    >
      <svg
        class={`admin-trend ${toneClass(props.tone)}`}
        viewBox={`0 0 ${W()} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={props.label || "trend chart"}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="currentColor" stop-opacity="0.34" />
            <stop offset="0.6" stop-color="currentColor" stop-opacity="0.08" />
            <stop offset="1" stop-color="currentColor" stop-opacity="0" />
          </linearGradient>
        </defs>

        <For each={gridLines()}>
          {(g) => (
            <>
              <line
                class="admin-grid-line"
                x1={padL}
                y1={g.yy}
                x2={W() - padR}
                y2={g.yy}
              />
              <text class="admin-axis-label" x={padL - 8} y={g.yy + 3.5} text-anchor="end">
                {g.label}
              </text>
            </>
          )}
        </For>

        <Show when={mode() === "bars"}>
          <g class="admin-trend-bars">
            <For each={data()}>
              {(d, i) => {
                const v = Number(d.value) || 0;
                const h = v > 0 ? Math.max(2, (v / max()) * innerH) : 0;
                return (
                  <rect
                    class="admin-trend-bar"
                    classList={{ "is-focus": focus() === i() }}
                    x={x(i()) - barW() / 2}
                    y={padTop + innerH - h}
                    width={barW()}
                    height={h}
                    rx="3"
                  />
                );
              }}
            </For>
          </g>
        </Show>

        <Show when={mode() !== "bars"}>
          <path class="admin-trend-area" d={areaPath()} fill={`url(#${gradId})`} />
          <path class="admin-trend-line" d={linePath()} />
        </Show>

        <Show when={overlayPath()}>
          <path class="admin-trend-overlay" d={overlayPath()} />
        </Show>

        <For each={xTicks()}>
          {(i) => (
            <text
              class="admin-axis-label"
              classList={{ "is-focus": focus() === i }}
              x={x(i)}
              y={H - 10}
              text-anchor="middle"
            >
              {xLabel(data()[i])}
            </text>
          )}
        </For>

        <Show when={bubble()}>
          {(b) => (
            <g class="admin-trend-focus">
              <line
                class="admin-crosshair"
                x1={b().cx}
                y1={padTop}
                x2={b().cx}
                y2={padTop + innerH}
              />
              <Show when={mode() !== "bars"}>
                <circle class="admin-focus-dot" cx={b().cx} cy={b().cy} r="4.5" />
              </Show>
              <g class="admin-bubble">
                <rect x={b().bx} y={b().by} width={b().w} height="38" rx="7" />
                <text class="admin-bubble-val" x={b().bx + b().w / 2} y={b().by + 17} text-anchor="middle">
                  {b().valStr}
                </text>
                <text class="admin-bubble-sub" x={b().bx + b().w / 2} y={b().by + 31} text-anchor="middle">
                  {b().dateStr}
                </text>
              </g>
            </g>
          )}
        </Show>
      </svg>
    </Show>
    </div>
  );
}

// ── DonutChart ──────────────────────────────────────────────────────────────
// Segments with a center readout and an interactive legend. `segments` is
// [{ label, value, tone }]. Hovering a segment or legend row highlights it and
// shows its share in the center.
export function DonutChart(props) {
  const S = 220;
  const cx = S / 2;
  const cy = S / 2;
  const rOuter = 96;
  const rInner = 64;
  const [hover, setHover] = createSignal(-1);

  const segments = () => (props.segments || []).filter((s) => Number(s.value) > 0);
  const total = createMemo(() =>
    segments().reduce((sum, s) => sum + (Number(s.value) || 0), 0),
  );

  const arcs = createMemo(() => {
    const t = total();
    if (t <= 0) return [];
    let angle = -Math.PI / 2;
    const gap = segments().length > 1 ? 0.022 : 0;
    return segments().map((s, i) => {
      const frac = (Number(s.value) || 0) / t;
      const a0 = angle + gap / 2;
      const a1 = angle + frac * Math.PI * 2 - gap / 2;
      angle += frac * Math.PI * 2;
      return { i, seg: s, d: arcPath(cx, cy, rOuter, rInner, a0, Math.max(a0, a1)) };
    });
  });

  const center = createMemo(() => {
    const i = hover();
    if (i >= 0 && i < segments().length) {
      const s = segments()[i];
      const pct = total() ? Math.round(((Number(s.value) || 0) / total()) * 100) : 0;
      return { value: `${pct}%`, label: s.label };
    }
    return {
      value: props.centerValue != null ? props.centerValue : fmt(total()),
      label: props.centerLabel || "total",
    };
  });

  return (
    <Show
      when={segments().length}
      fallback={<div class="admin-chart-empty">No data yet.</div>}
    >
      <div class="admin-donut-wrap">
        <svg class="admin-donut" viewBox={`0 0 ${S} ${S}`} role="img" aria-label={props.label || "donut chart"}>
          <circle class="admin-donut-track" cx={cx} cy={cy} r={(rOuter + rInner) / 2} stroke-width={rOuter - rInner} />
          <For each={arcs()}>
            {(a) => (
              <path
                class={`admin-donut-seg ${toneClass(a.seg.tone)}`}
                classList={{ "is-dim": hover() >= 0 && hover() !== a.i }}
                d={a.d}
                onPointerEnter={() => setHover(a.i)}
                onPointerLeave={() => setHover(-1)}
              />
            )}
          </For>
          <text class="admin-donut-center-val" x={cx} y={cy - 2} text-anchor="middle">
            {center().value}
          </text>
          <text class="admin-donut-center-label" x={cx} y={cy + 16} text-anchor="middle">
            {center().label}
          </text>
        </svg>
        <ul class="admin-legend">
          <For each={segments()}>
            {(s, i) => (
              <li
                class="admin-legend-item"
                classList={{ "is-dim": hover() >= 0 && hover() !== i() }}
                onPointerEnter={() => setHover(i())}
                onPointerLeave={() => setHover(-1)}
              >
                <span class={`admin-legend-dot ${toneClass(s.tone)}`} />
                <span class="admin-legend-label">{s.label}</span>
                <span class="admin-legend-value">{fmt(s.value)}</span>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
}

// ── HBars ─────────────────────────────────────────────────────────────────────
// Horizontal bar comparison / leaderboard. `items` is
// [{ label, value, sub, tone }]. Bars grow in via a CSS animation; the fill
// width is a presentation attribute. `max` defaults to the largest value.
export function HBars(props) {
  const items = () => props.items || [];
  const max = createMemo(() => {
    const m = props.max || Math.max(1, ...items().map((it) => Number(it.value) || 0));
    return m > 0 ? m : 1;
  });
  const valueFmt = (v) => (props.format ? props.format(v) : fmt(v));
  return (
    <Show when={items().length} fallback={<div class="admin-chart-empty">No data yet.</div>}>
      <ul class="admin-hbars">
        <For each={items()}>
          {(it) => (
            <li class="admin-hbar">
              <div class="admin-hbar-top">
                <span class="admin-hbar-label" title={it.label}>
                  <Show when={it.rank != null}>
                    <span class="admin-hbar-rank">{it.rank}</span>
                  </Show>
                  {it.label}
                </span>
                <span class="admin-hbar-value">{valueFmt(it.value)}</span>
              </div>
              <div class="admin-hbar-track">
                <div class={`admin-hbar-fillwrap ${toneClass(it.tone)}`}>
                  {/* Width via SVG so it's a presentation attribute, not inline style. */}
                  <svg class="admin-hbar-svg" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
                    <rect
                      class="admin-hbar-fill"
                      x="0"
                      y="0"
                      height="8"
                      rx="4"
                      width={Math.max(0.6, ((Number(it.value) || 0) / max()) * 100)}
                    />
                  </svg>
                </div>
              </div>
              <Show when={it.sub}>
                <span class="admin-hbar-sub">{it.sub}</span>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

// ── MiniSpark ─────────────────────────────────────────────────────────────────
// Tiny inline sparkline for KPI cards. Pure trend shape, no axes.
export function MiniSpark(props) {
  const W = 120;
  const H = 34;
  const pad = 3;
  const uid = nextUid();
  const gradId = `ms-grad-${uid}`;
  const values = () => props.values || [];
  const max = createMemo(() => Math.max(1, ...values().map((v) => Number(v) || 0)));
  const min = createMemo(() => Math.min(0, ...values().map((v) => Number(v) || 0)));
  const pts = createMemo(() => {
    const vs = values();
    const span = max() - min() || 1;
    const stepX = (W - pad * 2) / Math.max(1, vs.length - 1);
    return vs.map((v, i) => [
      pad + i * stepX,
      H - pad - ((Number(v) || 0) - min()) / span * (H - pad * 2),
    ]);
  });
  const linePath = createMemo(() => smoothLine(pts(), 0.18));
  const areaPath = createMemo(() => {
    const line = linePath();
    if (!line) return "";
    const p = pts();
    return `${line} L ${p[p.length - 1][0].toFixed(2)} ${H - pad} L ${p[0][0].toFixed(2)} ${H - pad} Z`;
  });
  return (
    <Show when={values().length > 1} fallback={<div class="admin-mini-empty" />}>
      <svg class={`admin-mini ${toneClass(props.tone)}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="currentColor" stop-opacity="0.30" />
            <stop offset="1" stop-color="currentColor" stop-opacity="0" />
          </linearGradient>
        </defs>
        <path class="admin-mini-area" d={areaPath()} fill={`url(#${gradId})`} />
        <path class="admin-mini-line" d={linePath()} />
      </svg>
    </Show>
  );
}

// ── Heatmap ───────────────────────────────────────────────────────────────────
// A single labelled row of intensity cells (e.g. activity by hour of day).
// `cells` is [{ label, value, title }]. Intensity is value / max mapped to one
// of five opacity steps via a class (CSP-safe — no inline style).
export function Heatmap(props) {
  const cells = () => props.cells || [];
  const max = createMemo(() => Math.max(1, ...cells().map((c) => Number(c.value) || 0)));
  const level = (v) => {
    const r = (Number(v) || 0) / max();
    if (r <= 0) return 0;
    if (r < 0.25) return 1;
    if (r < 0.5) return 2;
    if (r < 0.75) return 3;
    return 4;
  };
  return (
    <Show when={cells().length} fallback={<div class="admin-chart-empty">No data yet.</div>}>
      <div class={`admin-heatmap ${toneClass(props.tone)}`}>
        <For each={cells()}>
          {(c) => (
            <div class="admin-heat-col">
              <div class={`admin-heat-cell lvl-${level(c.value)}`} title={c.title || `${c.label}: ${fmt(c.value)}`} />
              {/* Always render the tick row (empty when not a tick) so every
                  column is the same height and the cells stay aligned. */}
              <span class="admin-heat-tick">{c.tick ? c.label : ""}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

// ── StatusRibbon ──────────────────────────────────────────────────────────────
// A horizontal timeline of health status (green/amber/red) over time.
// `samples` is [{ ts, status }] where status is 0/1/2. Renders proportionally
// spaced segments; hover shows the timestamp + state.
const STATUS_TONE = ["ok", "warn", "down"];
const STATUS_WORD = ["healthy", "degraded", "issues"];
export function StatusRibbon(props) {
  const samples = () => props.samples || [];
  const span = createMemo(() => {
    const s = samples();
    if (s.length < 2) return { t0: 0, t1: 1 };
    return { t0: s[0].ts, t1: s[s.length - 1].ts };
  });
  const segs = createMemo(() => {
    const s = samples();
    const { t0, t1 } = span();
    const total = Math.max(1, t1 - t0);
    return s.map((sample, i) => {
      const start = sample.ts;
      const end = i < s.length - 1 ? s[i + 1].ts : t1;
      const x = ((start - t0) / total) * 100;
      const w = Math.max(0.2, ((end - start) / total) * 100);
      return { x, w, status: Number(sample.status) || 0, ts: sample.ts };
    });
  });
  const tFmt = (ts) => (props.timeFormat ? props.timeFormat(ts) : String(ts));
  return (
    <Show when={samples().length} fallback={<div class="admin-chart-empty">No samples yet.</div>}>
      <svg class="admin-ribbon" viewBox="0 0 100 12" preserveAspectRatio="none" role="img" aria-label="status timeline">
        <For each={segs()}>
          {(s) => (
            <rect class={`admin-ribbon-seg is-${STATUS_TONE[s.status]}`} x={s.x} y="0" width={s.w} height="12">
              <title>{`${tFmt(s.ts)} · ${STATUS_WORD[s.status]}`}</title>
            </rect>
          )}
        </For>
      </svg>
    </Show>
  );
}

// ── Gauge ─────────────────────────────────────────────────────────────────────
// A 270° radial gauge for a 0–100% utilisation reading. Tone is chosen by
// thresholds unless overridden. Center shows the percentage; a caption sits
// below the arc.
export function Gauge(props) {
  const S = 130;
  const cx = S / 2;
  const cy = S / 2 + 6;
  const r = 50;
  const a0 = Math.PI * 0.75; // 135°
  const a1 = Math.PI * 2.25; // 405° (i.e. -135°), sweeping 270°
  const pct = createMemo(() => Math.min(100, Math.max(0, Number(props.value) || 0)));
  const tone = createMemo(() => {
    if (props.tone) return props.tone;
    const p = pct();
    const warn = props.warnAt ?? 75;
    const danger = props.dangerAt ?? 90;
    if (p >= danger) return "red";
    if (p >= warn) return "amber";
    return "green";
  });
  const track = arcPath(cx, cy, r + 7, r - 7, a0, a1);
  const fill = createMemo(() => arcPath(cx, cy, r + 7, r - 7, a0, a0 + (a1 - a0) * (pct() / 100)));
  return (
    <div class="admin-gauge-card">
      <svg class={`admin-gauge ${toneClass(tone())}`} viewBox={`0 0 ${S} ${S}`} role="img" aria-label={props.label || "gauge"}>
        <path class="admin-gauge-track" d={track} />
        <Show when={pct() > 0}>
          <path class="admin-gauge-fill" d={fill()} />
        </Show>
        <text class="admin-gauge-val" x={cx} y={cy + 2} text-anchor="middle">
          {props.display != null ? props.display : `${Math.round(pct())}%`}
        </text>
      </svg>
      <div class="admin-gauge-label">{props.label}</div>
      <Show when={props.sub}>
        <div class="admin-gauge-sub">{props.sub}</div>
      </Show>
    </div>
  );
}

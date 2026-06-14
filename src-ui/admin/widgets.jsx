// Shared formatters, constants, and small presentational widgets for the admin
// dashboard. Split out of admin.jsx to keep that file focused on data
// orchestration and layout. Charts live in charts.jsx.

import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";

import { MiniSpark } from "./charts.jsx";

const numberFormat = new Intl.NumberFormat();

export function fmtNum(value) {
  return numberFormat.format(Math.round(Number(value) || 0));
}

export function fmtPct(part, whole) {
  const w = Number(whole) || 0;
  if (w <= 0) return "0%";
  return `${Math.round(((Number(part) || 0) / w) * 100)}%`;
}

export function fmtDate(ms) {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

// "Jun 14" from an ISO yyyy-mm-dd day string (the growth endpoint's labels).
export function monthDay(iso) {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Compact hour-of-day label: "12a", "6a", "12p", "6p".
export function hourLabel(h) {
  const suffix = h < 12 ? "a" : "p";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${suffix}`;
}

export function clockTime(ms) {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

export function relTime(ms) {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

export const sum = (arr) => arr.reduce((acc, v) => acc + (Number(v) || 0), 0);

export function movingAverage(arr, window) {
  return arr.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = arr.slice(start, i + 1);
    return slice.length ? sum(slice) / slice.length : 0;
  });
}

export function feedText(event) {
  if (event.kind === "login") return "signed in";
  if (event.kind === "signup") return "created an account";
  if (event.kind === "watch") return "watched";
  return event.detail || "";
}

export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v <= 0) return "—";
  const gb = v / 1e9;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  return `${(v / 1e6).toFixed(0)} MB`;
}

export function fmtUptime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function ratioPct(part, whole) {
  const w = Number(whole) || 0;
  if (w <= 0) return 0;
  return ((Number(part) || 0) / w) * 100;
}

export const STATUS_LABEL = {
  green: "All systems smooth",
  amber: "Running degraded",
  red: "Service issues",
};

export function statusClass(status) {
  if (status === "red") return "is-down";
  if (status === "amber") return "is-warn";
  return "is-ok";
}

export function healthSummary(h) {
  if (!h) return "";
  const bad = (h.checks || []).filter((c) => c.status !== "green");
  if (!bad.length) return "All checks passing.";
  return bad.map((c) => c.detail).join(" · ");
}

// Health-timeline metric definitions: each maps a 24h sample row to a number.
export const HEALTH_METRICS = [
  { key: "req5xx", label: "HTTP 5xx", tone: "red", unit: "%", get: (s) => Number(s.req5xxRate) || 0 },
  { key: "playback", label: "Playback fails", tone: "amber", unit: "%", get: (s) => Number(s.playbackFailureRate) || 0 },
  { key: "fd", label: "File descriptors", tone: "cyan", unit: "%", get: (s) => ratioPct(s.fdCount, s.fdLimit) },
  { key: "mem", label: "Memory", tone: "violet", unit: "%", get: (s) => ratioPct(s.memUsed, s.memTotal) },
  { key: "load", label: "CPU load", tone: "blue", unit: "", get: (s) => Number(s.load1) || 0 },
];

// Animated number that eases from its previous value to the new one whenever
// `value` changes. CSP-safe — it only ever updates text content.
export function CountUp(props) {
  const [shown, setShown] = createSignal(Number(props.value) || 0);
  let raf = 0;
  let from = Number(props.value) || 0;
  createEffect(() => {
    const to = Number(props.value) || 0;
    const startVal = from;
    const startTs = performance.now();
    const dur = 650;
    cancelAnimationFrame(raf);
    const tick = (now) => {
      const t = Math.min(1, (now - startTs) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(startVal + (to - startVal) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else from = to;
    };
    raf = requestAnimationFrame(tick);
  });
  onCleanup(() => cancelAnimationFrame(raf));
  return <>{props.format ? props.format(shown()) : fmtNum(shown())}</>;
}

// Up/down delta chip. `delta` positive → up. `pct` formats as a percentage.
// `invert` flips the colour semantics (for metrics where up is bad).
export function TrendChip(props) {
  const dir = () => (props.delta > 0 ? "up" : props.delta < 0 ? "down" : "flat");
  const arrow = () => (dir() === "up" ? "▲" : dir() === "down" ? "▼" : "•");
  const text = () => {
    if (dir() === "flat") return "no change";
    if (props.pct) return `${Math.abs(Math.round(props.delta))}%`;
    return `${props.delta > 0 ? "+" : "−"}${fmtNum(Math.abs(props.delta))}`;
  };
  return (
    <span
      class="admin-trendchip"
      classList={{
        "is-up": dir() === "up",
        "is-down": dir() === "down",
        "is-flat": dir() === "flat",
        invert: props.invert,
      }}
    >
      <span class="admin-trendchip-arrow">{arrow()}</span>
      {text()}
      <Show when={props.label}>
        <span class="admin-trendchip-label">{props.label}</span>
      </Show>
    </span>
  );
}

export function KpiCard(props) {
  return (
    <div class={`admin-kpi t-${props.tone || "blue"}`}>
      <div class="admin-kpi-top">
        <span class="admin-kpi-label">{props.label}</span>
        <Show when={props.trend}>
          <TrendChip {...props.trend} />
        </Show>
      </div>
      <div class="admin-kpi-mid">
        <span class="admin-kpi-value">
          <CountUp value={props.value} format={fmtNum} />
        </span>
        <Show when={props.spark && props.spark.length > 1}>
          <span class="admin-kpi-spark">
            <MiniSpark values={props.spark} tone={props.tone} />
          </span>
        </Show>
      </div>
      <Show when={props.sub}>
        <span class="admin-kpi-sub">{props.sub}</span>
      </Show>
    </div>
  );
}

export function StatTile(props) {
  return (
    <div class={`admin-stat t-${props.tone || "blue"}`}>
      <span class="admin-stat-value">{props.value}</span>
      <span class="admin-stat-label">{props.label}</span>
      <Show when={props.sub}>
        <span class="admin-stat-sub">{props.sub}</span>
      </Show>
    </div>
  );
}

export function Segmented(props) {
  return (
    <div class="admin-seg" role="group">
      <For each={props.options}>
        {(o) => (
          <button
            class="admin-seg-btn"
            classList={{ "is-active": props.value === o.value }}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}

export function Toggle(props) {
  return (
    <button
      class="admin-toggle"
      classList={{ "is-on": props.checked }}
      role="switch"
      aria-checked={props.checked}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="admin-toggle-track">
        <span class="admin-toggle-knob" />
      </span>
      <span class="admin-toggle-text">{props.label}</span>
    </button>
  );
}

export function ActivityFeed(props) {
  return (
    <Show
      when={(props.events || []).length}
      fallback={<div class="admin-empty">No recent activity.</div>}
    >
      <ul class="admin-feed">
        <For each={props.events}>
          {(event) => (
            <li class="admin-feed-item">
              <span class={`admin-feed-dot is-${event.kind}`} />
              <div class="admin-feed-body">
                <span class="admin-feed-main">
                  <strong>{event.displayName || event.email}</strong> {feedText(event)}
                  <Show when={event.title}>
                    {" "}
                    <span class="admin-feed-titletext">{event.title}</span>
                  </Show>
                </span>
                <span class="admin-feed-meta">
                  {event.email} · {relTime(event.ts)}
                </span>
              </div>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

export function SkeletonKpis() {
  return (
    <div class="admin-kpis">
      <For each={[0, 1, 2, 3, 4, 5]}>
        {() => (
          <div class="admin-kpi is-skeleton">
            <div class="admin-skel admin-skel-line short" />
            <div class="admin-skel admin-skel-line big" />
            <div class="admin-skel admin-skel-line" />
          </div>
        )}
      </For>
    </div>
  );
}

export function Unauthorized(props) {
  return (
    <div class="admin-denied">
      <div class="admin-denied-card">
        <span class="admin-brand-mark">NETFLIX</span>
        <h1>Admin access required</h1>
        <p>
          {props.email
            ? `${props.email} isn’t an admin account.`
            : "Sign in with an admin account to continue."}
        </p>
        <a class="admin-cta" href="/">
          Back to Netflix
        </a>
      </div>
    </div>
  );
}

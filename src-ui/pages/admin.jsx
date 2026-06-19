import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

import { signOut } from "../lib/auth.js";
import {
  DonutChart,
  Gauge,
  HBars,
  Heatmap,
  StatusRibbon,
  TrendChart,
} from "../admin/charts.jsx";
import { UserDetailDrawer } from "../admin/user-detail.jsx";
import ProvidersPanel from "../admin/providers.jsx";
import {
  ActivityFeed,
  clockTime,
  fmtBytes,
  fmtDate,
  fmtNum,
  fmtPct,
  fmtUptime,
  HEALTH_METRICS,
  healthSummary,
  hourLabel,
  KpiCard,
  monthDay,
  movingAverage,
  ratioPct,
  relTime,
  Segmented,
  SkeletonKpis,
  StatTile,
  STATUS_LABEL,
  statusClass,
  sum,
  Toggle,
  Unauthorized,
} from "../admin/widgets.jsx";

async function getJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = await response.json();
      message = data.error || message;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

// Outline glyphs for the sidebar nav. Stroke-based (Lucide-style) and coloured
// with `currentColor`, so the active/hover state on the link themes the icon —
// CSP-safe (presentation attributes only, no inline style).
const NAV_ICONS = {
  overview: (
    <>
      <rect x="3" y="3" width="7.5" height="8" rx="1.6" />
      <rect x="13.5" y="3" width="7.5" height="5" rx="1.6" />
      <rect x="13.5" y="12.5" width="7.5" height="8.5" rx="1.6" />
      <rect x="3" y="14.5" width="7.5" height="6.5" rx="1.6" />
    </>
  ),
  users: (
    <>
      <path d="M16 19v-1.4a3.6 3.6 0 0 0-3.6-3.6H7.6A3.6 3.6 0 0 0 4 17.6V19" />
      <circle cx="10" cy="8" r="3.4" />
      <path d="M20 19v-1.4a3.6 3.6 0 0 0-2.7-3.5" />
      <path d="M15.5 4.6a3.4 3.4 0 0 1 0 6.6" />
    </>
  ),
  activity: <path d="M22 12h-4l-3 8-4-16-3 8H2" />,
  feedback: <path d="M20 14.4a2 2 0 0 1-2 2H8l-4 3.4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />,
  health: (
    <>
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z" />
      <path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h4.78" />
    </>
  ),
  providers: (
    <>
      <path d="M12 3 3 8l9 5 9-5-9-5Z" />
      <path d="M3 12l9 5 9-5" />
      <path d="M3 16l9 5 9-5" />
    </>
  ),
};

function NavIcon(props) {
  return (
    <svg
      class="admin-side-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {NAV_ICONS[props.name]}
    </svg>
  );
}

// The StreamArena play-mark (same geometry as the favicon) for the sidebar.
function BrandMark() {
  return (
    <svg class="admin-side-logo" viewBox="0 0 512 512" aria-hidden="true">
      <defs>
        <mask id="admin-brand-play">
          <rect width="512" height="512" fill="white" />
          <path
            d="M210 270 L210 394 L346 332 Z"
            fill="black"
            stroke="black"
            stroke-width="22"
            stroke-linejoin="round"
            stroke-linecap="round"
          />
        </mask>
      </defs>
      <g stroke="#e50914" stroke-width="32" stroke-linecap="round" fill="none">
        <line x1="96" y1="40" x2="304" y2="176" />
        <line x1="416" y1="40" x2="208" y2="176" />
      </g>
      <rect x="40" y="176" width="432" height="312" rx="52" fill="#e50914" mask="url(#admin-brand-play)" />
    </svg>
  );
}

const NAV = [
  { key: "overview", label: "Overview", icon: "overview" },
  { key: "users", label: "Users", icon: "users" },
  { key: "activity", label: "Activity", icon: "activity" },
  { key: "feedback", label: "Feedback", icon: "feedback" },
  { key: "health", label: "Health", icon: "health" },
  { key: "providers", label: "Providers", icon: "providers" },
];

// Title + one-line subtitle shown in the content top bar per section.
const PAGE_META = {
  overview: { title: "Overview", sub: "Your platform at a glance" },
  users: { title: "Users", sub: "Accounts, access & engagement" },
  activity: { title: "Activity", sub: "Sign-ins, watches & live across StreamArena" },
  feedback: { title: "Feedback", sub: "Messages from your users" },
  health: { title: "Service health", sub: "Live infrastructure & streaming pipeline" },
  providers: { title: "Providers", sub: "Stream sources & origins — view, test & swap" },
};

export default function AdminPage() {
  const currentUser = window.__currentUser || {};
  if (!currentUser.isAdmin) {
    return <Unauthorized email={currentUser.email} />;
  }

  const accountInitial = (currentUser.displayName || currentUser.email || "A")
    .trim()
    .charAt(0)
    .toUpperCase();

  const [tab, setTab] = createSignal("overview");
  const [overview, setOverview] = createSignal(null);
  const [growthAll, setGrowthAll] = createSignal([]);
  const [activity, setActivity] = createSignal([]);
  const [feedback, setFeedback] = createSignal([]);
  const [topLive, setTopLive] = createSignal([]);
  const [users, setUsers] = createSignal([]);
  const [search, setSearch] = createSignal("");
  const [userSort, setUserSort] = createSignal({ key: "createdAt", dir: "desc" });
  const [status, setStatus] = createSignal("loading");
  const [error, setError] = createSignal("");
  const [flash, setFlash] = createSignal(null);
  const [pwTarget, setPwTarget] = createSignal(null);
  const [pwValue, setPwValue] = createSignal("");
  const [pwError, setPwError] = createSignal("");
  const [detailUser, setDetailUser] = createSignal(null);
  const [detail, setDetail] = createSignal(null);
  const [detailStatus, setDetailStatus] = createSignal("idle");
  const [detailError, setDetailError] = createSignal("");
  const [health, setHealth] = createSignal(null);
  const [healthHistory, setHealthHistory] = createSignal([]);
  const [healthStatus, setHealthStatus] = createSignal("idle");
  const [healthError, setHealthError] = createSignal("");

  // Overview interactivity.
  const [growthRange, setGrowthRange] = createSignal(30);
  const [growthMode, setGrowthMode] = createSignal("area");
  const [signupFocus, setSignupFocus] = createSignal(null);
  const [autoRefresh, setAutoRefresh] = createSignal(true);
  const [lastSync, setLastSync] = createSignal(0);
  const [healthMetric, setHealthMetric] = createSignal("req5xx");

  let searchTimer;
  let flashTimer;
  let healthTimer;
  let overviewTimer;

  function showFlash(text, isError = false) {
    setFlash({ text, isError });
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => setFlash(null), 4200);
  }

  async function loadUsers() {
    const query = search().trim();
    const url = `/api/admin/users?limit=200${
      query ? `&search=${encodeURIComponent(query)}` : ""
    }`;
    const data = await getJson(url);
    setUsers(data.users || []);
  }

  async function loadAll() {
    setStatus("loading");
    setError("");
    try {
      const [ov, gr, ac, fb, lt] = await Promise.all([
        getJson("/api/admin/overview"),
        getJson("/api/admin/growth?days=90"),
        getJson("/api/admin/activity?limit=120"),
        getJson("/api/admin/feedback?limit=200"),
        getJson("/api/admin/live-top?days=7"),
      ]);
      setOverview(ov);
      setGrowthAll(gr.days || []);
      setActivity(ac.events || []);
      setFeedback(fb.feedback || []);
      setTopLive(lt.streams || []);
      await loadUsers();
      setStatus("ready");
      setLastSync(Date.now());
      getJson("/api/admin/health")
        .then(setHealth)
        .catch(() => {});
    } catch (e) {
      setError(e.message || "Unknown error");
      setStatus("error");
    }
  }

  // Lightweight live refresh used by the auto-refresh timer: the dashboard data
  // only, never the users table (would clobber an in-progress search).
  async function refreshLive() {
    try {
      const [ov, gr, ac, lt] = await Promise.all([
        getJson("/api/admin/overview"),
        getJson("/api/admin/growth?days=90"),
        getJson("/api/admin/activity?limit=120"),
        getJson("/api/admin/live-top?days=7"),
      ]);
      setOverview(ov);
      setGrowthAll(gr.days || []);
      setActivity(ac.events || []);
      setTopLive(lt.streams || []);
      setLastSync(Date.now());
      getJson("/api/admin/health").then(setHealth).catch(() => {});
    } catch {
      /* transient; the next tick will retry */
    }
  }

  async function loadHealth(initial = false) {
    if (initial) setHealthStatus("loading");
    try {
      const [snap, hist] = await Promise.all([
        getJson("/api/admin/health"),
        getJson("/api/admin/health/history?hours=24"),
      ]);
      setHealth(snap);
      setHealthHistory(hist.samples || []);
      setHealthError("");
      setHealthStatus("ready");
    } catch (e) {
      setHealthError(e.message || "Couldn’t load service health.");
      if (initial) setHealthStatus("error");
    }
  }

  async function refreshAfterAction() {
    try {
      const [ov, ac] = await Promise.all([
        getJson("/api/admin/overview"),
        getJson("/api/admin/activity?limit=120"),
      ]);
      setOverview(ov);
      setActivity(ac.events || []);
      await loadUsers();
    } catch (e) {
      showFlash(e.message || "Refresh failed", true);
    }
  }

  function onSearchInput(value) {
    setSearch(value);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      loadUsers().catch((e) => showFlash(e.message, true));
    }, 250);
  }

  function toggleSort(key) {
    setUserSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "name" ? "asc" : "desc" },
    );
  }

  function openPwModal(user) {
    setPwTarget(user);
    setPwValue("");
    setPwError("");
  }

  // ── User drill-down drawer ───────────────────────────────────────────────
  async function openUser(user) {
    if (!user) return;
    setDetailUser(user);
    setDetail(null);
    setDetailError("");
    setDetailStatus("loading");
    try {
      const data = await getJson(`/api/admin/users/detail?id=${user.id}`);
      setDetail(data);
      setDetailStatus("ready");
    } catch (e) {
      setDetailError(e.message || "Failed to load this user.");
      setDetailStatus("error");
    }
  }

  function closeUser() {
    setDetailUser(null);
    setDetail(null);
    setDetailStatus("idle");
  }

  // Re-fetch the open drawer after an action so its header + stats stay current.
  async function reloadDetail() {
    const user = detailUser();
    if (!user) return;
    try {
      const data = await getJson(`/api/admin/users/detail?id=${user.id}`);
      setDetail(data);
    } catch {
      /* keep the stale detail; the flash already reported any failure */
    }
  }

  function drawerReset() {
    const user = detailUser();
    if (user) openPwModal(user);
  }

  async function drawerToggleDisabled() {
    const user = detailUser();
    if (!user) return;
    await toggleDisabled(user);
    await reloadDetail();
  }

  async function drawerToggleAdmin() {
    const user = detailUser();
    if (!user) return;
    await toggleAdmin(user);
    await reloadDetail();
  }

  async function drawerDelete() {
    const user = detailUser();
    if (!user) return;
    if (await deleteUser(user)) closeUser();
  }

  async function submitPassword() {
    const target = pwTarget();
    if (!target) return;
    if (pwValue().length < 6) {
      setPwError("Password must be at least 6 characters.");
      return;
    }
    try {
      await postJson("/api/admin/users/reset-password", {
        userId: target.id,
        password: pwValue(),
      });
      setPwTarget(null);
      setPwValue("");
      showFlash(`Password reset for ${target.email}.`);
    } catch (e) {
      setPwError(e.message || "Failed to reset password.");
    }
  }

  async function toggleDisabled(user) {
    const next = !user.isDisabled;
    if (!window.confirm(`${next ? "Disable" : "Enable"} ${user.email}?`)) return;
    try {
      await postJson("/api/admin/users/set-disabled", {
        userId: user.id,
        disabled: next,
      });
      showFlash(`${user.email} ${next ? "disabled" : "enabled"}.`);
      await refreshAfterAction();
    } catch (e) {
      showFlash(e.message, true);
    }
  }

  async function toggleAdmin(user) {
    const next = !user.isAdmin;
    if (!window.confirm(`${next ? "Grant admin to" : "Remove admin from"} ${user.email}?`))
      return;
    try {
      await postJson("/api/admin/users/set-admin", {
        userId: user.id,
        isAdmin: next,
      });
      showFlash(`${user.email} ${next ? "is now an admin" : "is no longer an admin"}.`);
      await refreshAfterAction();
    } catch (e) {
      showFlash(e.message, true);
    }
  }

  async function deleteUser(user) {
    if (
      !window.confirm(
        `Permanently delete ${user.email}? This removes their account and all of their data.`,
      )
    )
      return false;
    try {
      await postJson("/api/admin/users/delete", { userId: user.id });
      showFlash(`${user.email} deleted.`);
      await refreshAfterAction();
      return true;
    } catch (e) {
      showFlash(e.message, true);
      return false;
    }
  }

  // ── Derived overview data ─────────────────────────────────────────────────
  const daily = createMemo(() => growthAll().map((d) => Number(d.signups) || 0));

  const trendStats = createMemo(() => {
    const a = daily();
    const n = a.length;
    const lastN = (k) => sum(a.slice(Math.max(0, n - k)));
    const prevN = (k) => sum(a.slice(Math.max(0, n - 2 * k), Math.max(0, n - k)));
    const pct = (cur, prev) => (prev > 0 ? ((cur - prev) / prev) * 100 : cur > 0 ? 100 : 0);
    const today = a[n - 1] || 0;
    const yest = a[n - 2] || 0;
    const l7 = lastN(7);
    const l30 = lastN(30);
    return {
      today,
      deltaToday: today - yest,
      l7,
      d7: pct(l7, prevN(7)),
      l30,
      d30: pct(l30, prevN(30)),
    };
  });

  // Real total-users-over-time line: anchor at the current total and subtract
  // each day's sign-ups walking backwards.
  const totalSpark = createMemo(() => {
    const ov = overview();
    if (!ov) return [];
    const a = daily();
    let running = ov.totalUsers;
    const out = new Array(a.length);
    for (let i = a.length - 1; i >= 0; i--) {
      out[i] = running;
      running -= a[i];
    }
    return out.slice(-30);
  });

  const chartData = createMemo(() => {
    const all = growthAll();
    const r = Math.min(all.length, growthRange());
    return all.slice(-r).map((d) => ({ label: d.date, value: Number(d.signups) || 0 }));
  });

  const chartOverlay = createMemo(() => {
    if (growthRange() < 14) return null; // 7-day average isn't meaningful at 7d.
    const ma = movingAverage(daily(), 7);
    const r = Math.min(ma.length, growthRange());
    return ma.slice(-r);
  });

  const signupSummary = createMemo(() => {
    const d = chartData();
    return {
      total: sum(d.map((x) => x.value)),
      peak: Math.max(0, ...d.map((x) => x.value)),
    };
  });

  const composition = createMemo(() => {
    const o = overview();
    if (!o) return [];
    const verified = Number(o.verifiedUsers) || 0;
    const unverified = Math.max(0, (Number(o.totalUsers) || 0) - verified);
    return [
      { label: "Verified", value: verified, tone: "green" },
      { label: "Unverified", value: unverified, tone: "amber" },
    ];
  });

  const engagement = createMemo(() => {
    const o = overview();
    if (!o) return [];
    return [
      { label: "Continue watching", value: o.continueWatchingItems, tone: "red" },
      { label: "My List", value: o.myListItems, tone: "violet" },
      { label: "Watch progress", value: o.watchProgressItems, tone: "cyan" },
      { label: "Active sessions", value: o.activeSessions, tone: "green" },
    ];
  });

  const activityByHour = createMemo(() => {
    const counts = new Array(24).fill(0);
    for (const e of activity()) {
      const d = new Date(e.ts);
      if (!Number.isNaN(d.getTime())) counts[d.getHours()] += 1;
    }
    return counts.map((v, h) => ({
      label: hourLabel(h),
      value: v,
      tick: h % 6 === 0,
      title: `${hourLabel(h)} – ${v} event${v === 1 ? "" : "s"}`,
    }));
  });

  const activityByKind = createMemo(() => {
    const tones = { login: "blue", watch: "red", signup: "green", live: "violet" };
    const labels = { login: "Logins", watch: "Watches", signup: "Sign-ups", live: "Live" };
    const counts = {};
    for (const e of activity()) counts[e.kind] = (counts[e.kind] || 0) + 1;
    return ["login", "watch", "live", "signup"]
      .filter((k) => counts[k])
      .map((k) => ({ key: k, label: labels[k], value: counts[k], tone: tones[k] }));
  });

  const topLiveBars = createMemo(() =>
    topLive().map((s, i) => ({
      rank: i + 1,
      label: s.title,
      value: s.plays,
      sub: `${fmtNum(s.viewers)} viewer${s.viewers === 1 ? "" : "s"} · ${s.category || "live"}`,
      tone: s.category === "sports" ? "red" : "cyan",
    })),
  );

  const topUsers = createMemo(() =>
    [...users()]
      .map((u) => ({ u, score: (u.continueWatchingCount || 0) + (u.myListCount || 0) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((x, i) => ({
        rank: i + 1,
        label: x.u.displayName || x.u.email,
        value: x.score,
        sub: `${fmtNum(x.u.continueWatchingCount)} watching · ${fmtNum(x.u.myListCount)} in list`,
        tone: "blue",
        user: x.u,
      })),
  );

  const sortedUsers = createMemo(() => {
    const { key, dir } = userSort();
    const mul = dir === "asc" ? 1 : -1;
    const score = (u) => (u.continueWatchingCount || 0) + (u.myListCount || 0);
    const val = (u) => {
      switch (key) {
        case "name":
          return (u.displayName || u.email || "").toLowerCase();
        case "sessions":
          return u.sessionCount || 0;
        case "engagement":
          return score(u);
        case "lastActive":
          return u.lastActiveAt || 0;
        default:
          return u.createdAt || 0;
      }
    };
    return [...users()].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av < bv) return -1 * mul;
      if (av > bv) return 1 * mul;
      return 0;
    });
  });

  const usersSummary = createMemo(() => {
    const list = users();
    return {
      shown: list.length,
      verified: list.filter((u) => u.emailVerifiedAt).length,
      admins: list.filter((u) => u.isAdmin).length,
      disabled: list.filter((u) => u.isDisabled).length,
    };
  });

  // ── Derived health data ───────────────────────────────────────────────────
  const gauges = createMemo(() => {
    const h = health();
    if (!h) return [];
    const host = h.host || {};
    return [
      {
        label: "Memory",
        value: ratioPct(host.memUsed, host.memTotal),
        sub: `${fmtBytes(host.memUsed)} / ${fmtBytes(host.memTotal)}`,
      },
      {
        label: "Disk used",
        value: host.diskTotal > 0 ? 100 - ratioPct(host.diskFree, host.diskTotal) : 0,
        sub: `${fmtBytes(host.diskFree)} free`,
      },
      {
        label: "File descriptors",
        value: host.fdLimit > 0 ? ratioPct(host.fdCount, host.fdLimit) : 0,
        sub:
          host.fdCount >= 0 ? `${fmtNum(host.fdCount)} / ${fmtNum(host.fdLimit)}` : "unknown",
      },
      {
        label: "CPU load",
        value: host.numCpus > 0 ? Math.min(100, ((Number(host.load1) || 0) / host.numCpus) * 100) : 0,
        display: (Number(host.load1) || 0).toFixed(2),
        sub: `${fmtNum(host.numCpus)} cores`,
      },
    ];
  });

  const healthStats = createMemo(() => {
    const h = health();
    if (!h) return [];
    const http = (h.http && h.http.counters) || {};
    const restarts = h.restarts || {};
    const playback = h.playback || {};
    return [
      { label: "Uptime", value: fmtUptime(h.uptimeSeconds), tone: "green" },
      { label: "Requests served", value: fmtNum(http.reqTotal), tone: "blue" },
      {
        label: "HTTP 5xx rate",
        value: `${(Number(h.http?.req5xxRate) || 0).toFixed(1)}%`,
        tone: "red",
        sub: `${fmtNum(http.req5xx)} of ${fmtNum(http.reqTotal)}`,
      },
      {
        label: "Playback fails",
        value: `${(Number(playback.failureRate) || 0).toFixed(0)}%`,
        tone: "amber",
        sub: `${fmtNum(playback.windowTotal)} recent plays`,
      },
      {
        label: "Restarts · 1h",
        value: fmtNum(restarts.lastHour),
        tone: "violet",
        sub:
          restarts.minutesSinceLast != null
            ? `last ${restarts.minutesSinceLast}m ago`
            : "none recently",
      },
    ];
  });

  const activeMetric = createMemo(
    () => HEALTH_METRICS.find((m) => m.key === healthMetric()) || HEALTH_METRICS[0],
  );

  const healthTimeline = createMemo(() => {
    const m = activeMetric();
    return healthHistory().map((s) => ({ label: clockTime(s.ts), value: m.get(s) }));
  });

  const requestMix = createMemo(() => {
    const c = (health() && health().http && health().http.counters) || {};
    const total = Number(c.reqTotal) || 0;
    const c4 = Number(c.req4xx) || 0;
    const c5 = Number(c.req5xx) || 0;
    const ok = Math.max(0, total - c4 - c5);
    return {
      total,
      segments: [
        { label: "2xx · 3xx", value: ok, tone: "green" },
        { label: "4xx", value: c4, tone: "amber" },
        { label: "5xx", value: c5, tone: "red" },
      ],
    };
  });

  const streaming = createMemo(() => {
    const s = (health() && health().streaming) || {};
    const remux = s.remux || {};
    const hls = s.hls || {};
    const cacheTotal = (Number(hls.segmentCacheHits) || 0) + (Number(hls.segmentCacheMisses) || 0);
    return {
      remux,
      hls,
      cacheTotal,
      cacheHitRate: cacheTotal ? (Number(hls.segmentCacheHits) || 0) / cacheTotal * 100 : 0,
    };
  });

  const resolver = createMemo(() => (health() && health().resolver) || {});
  const resolverOutcomes = createMemo(() => {
    const r = resolver();
    return [
      { label: "Completed", value: Number(r.externalCompleted) || 0, tone: "green" },
      { label: "Failed", value: Number(r.externalFailed) || 0, tone: "red" },
      { label: "Rejected", value: Number(r.externalRejected) || 0, tone: "amber" },
    ];
  });

  const providers = createMemo(() => {
    const list = (health() && health().providers && health().providers.providers) || [];
    return [...list].sort((a, b) => (b.consecutiveFailures || 0) - (a.consecutiveFailures || 0));
  });

  // Poll the Health tab while it's open.
  createEffect(() => {
    clearInterval(healthTimer);
    if (tab() === "health") {
      loadHealth(true);
      healthTimer = setInterval(() => loadHealth(false), 20_000);
    }
  });
  onCleanup(() => clearInterval(healthTimer));

  // Auto-refresh the dashboard data (not the Health tab — it self-polls).
  createEffect(() => {
    clearInterval(overviewTimer);
    if (autoRefresh() && tab() !== "health") {
      overviewTimer = setInterval(() => {
        if (document.visibilityState !== "hidden") refreshLive();
      }, 30_000);
    }
  });
  onCleanup(() => clearInterval(overviewTimer));

  // Esc closes the user drawer (and falls through to the reset modal if open).
  function onKeyDown(event) {
    if (event.key !== "Escape") return;
    if (pwTarget()) return; // the modal handles its own Esc
    if (detailUser()) closeUser();
  }
  onMount(() => document.addEventListener("keydown", onKeyDown));
  onCleanup(() => document.removeEventListener("keydown", onKeyDown));

  // Lock the page behind the drawer so the drawer scrolls on its own.
  createEffect(() => {
    document.body.classList.toggle("admin-noscroll", Boolean(detailUser()));
  });
  onCleanup(() => document.body.classList.remove("admin-noscroll"));

  onMount(loadAll);

  const sortIndicator = (key) => {
    const s = userSort();
    if (s.key !== key) return "";
    return s.dir === "asc" ? " ↑" : " ↓";
  };

  return (
    <div class="admin-layout">
      <aside class="admin-sidebar">
        <a class="admin-side-brand" href="/" title="Back to StreamArena">
          <BrandMark />
          <span class="admin-side-brandtext">
            <span class="admin-side-brandname">StreamArena</span>
            <span class="admin-side-brandtag">Admin console</span>
          </span>
        </a>

        <nav class="admin-side-nav" aria-label="Admin sections">
          <For each={NAV}>
            {(t) => (
              <button
                type="button"
                classList={{ "admin-side-link": true, "is-active": tab() === t.key }}
                onClick={() => setTab(t.key)}
              >
                <NavIcon name={t.icon} />
                <span class="admin-side-label">{t.label}</span>
                <Show when={t.key === "feedback" && feedback().length}>
                  <span class="admin-side-badge">{fmtNum(feedback().length)}</span>
                </Show>
              </button>
            )}
          </For>
        </nav>

        <div class="admin-side-foot">
          <Show when={health()}>
            <button
              type="button"
              classList={{ "admin-side-status": true, [statusClass(health().status)]: true }}
              onClick={() => setTab("health")}
              title="View service health"
            >
              <span classList={{ "admin-status-dot": true, [statusClass(health().status)]: true }} />
              <span class="admin-side-status-text">
                {STATUS_LABEL[health().status] || "Service health"}
              </span>
            </button>
          </Show>
          <div class="admin-side-account">
            <span class="admin-avatar admin-avatar-sm">{accountInitial}</span>
            <span class="admin-side-accountid">
              <span class="admin-side-accountname">{currentUser.displayName || "Admin"}</span>
              <span class="admin-side-accountmail">{currentUser.email}</span>
            </span>
          </div>
          <div class="admin-side-links">
            <a class="admin-side-ghost" href="/">
              View site
            </a>
            <button class="admin-side-ghost" type="button" onClick={() => signOut()}>
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <div class="admin-content">
        <header class="admin-topbar">
          <div class="admin-topbar-titles">
            <h1 class="admin-topbar-title">{PAGE_META[tab()].title}</h1>
            <p class="admin-topbar-sub">{PAGE_META[tab()].sub}</p>
          </div>
          <div class="admin-topbar-actions">
            <Show when={tab() !== "health"}>
              <span class="admin-synced">
                <Show when={autoRefresh()}>
                  <span class="admin-live-dot" />
                </Show>
                Updated {clockTime(lastSync())}
              </span>
              <Toggle checked={autoRefresh()} onChange={setAutoRefresh} label="Live" />
            </Show>
            <button
              class="admin-btn admin-refresh"
              onClick={() => loadAll()}
              disabled={status() === "loading"}
            >
              Refresh
            </button>
          </div>
        </header>

        <Show when={flash()}>
          <div classList={{ "admin-flash": true, "is-error": flash().isError }}>
            {flash().text}
          </div>
        </Show>

        <Show when={status() === "error"}>
          <div class="admin-error">Couldn’t load the dashboard: {error()}</div>
        </Show>

        <main class="admin-main">
        {/* ── Overview ─────────────────────────────────────────────── */}
        <Show when={tab() === "overview"}>
          <Show when={overview()} fallback={<SkeletonKpis />}>
            <div class="admin-kpis">
              <KpiCard
                tone="green"
                label="Active now"
                value={overview().activeUsers}
                sub={`${fmtNum(overview().activeSessions)} live session${overview().activeSessions === 1 ? "" : "s"}`}
              />
              <KpiCard
                tone="steel"
                label="Total users"
                value={overview().totalUsers}
                trend={{ delta: trendStats().l7, label: "7d" }}
                spark={totalSpark()}
              />
              <KpiCard
                tone="steel"
                label="New · 24h"
                value={overview().newUsers24h}
                trend={{ delta: trendStats().deltaToday, label: "vs yest" }}
                spark={daily().slice(-14)}
              />
              <KpiCard
                tone="steel"
                label="New · 7d"
                value={trendStats().l7}
                trend={{ delta: trendStats().d7, pct: true, label: "vs prev" }}
                spark={daily().slice(-30)}
              />
              <KpiCard
                tone="green"
                label="Email verified"
                value={overview().verifiedUsers}
                sub={`${fmtPct(overview().verifiedUsers, overview().totalUsers)} of all users`}
              />
            </div>

            <section class="admin-panel">
              <div class="admin-panel-head">
                <div>
                  <h2 class="admin-panel-title">New sign-ups</h2>
                  <span class="admin-panel-sub">
                    <Show
                      when={signupFocus()}
                      fallback={
                        <>
                          {fmtNum(signupSummary().total)} total · peak {fmtNum(signupSummary().peak)}/day
                        </>
                      }
                    >
                      <strong class="admin-readout-val">{fmtNum(signupFocus().value)}</strong> sign-ups
                      on {monthDay(signupFocus().label)}
                    </Show>
                  </span>
                </div>
                <div class="admin-panel-controls">
                  <Segmented
                    value={growthMode()}
                    onChange={setGrowthMode}
                    options={[
                      { value: "area", label: "Area" },
                      { value: "bars", label: "Bars" },
                    ]}
                  />
                  <Segmented
                    value={growthRange()}
                    onChange={setGrowthRange}
                    options={[
                      { value: 7, label: "7d" },
                      { value: 30, label: "30d" },
                      { value: 90, label: "90d" },
                    ]}
                  />
                </div>
              </div>
              <TrendChart
                data={chartData()}
                overlay={chartOverlay()}
                mode={growthMode()}
                tone="steel"
                xFormat={monthDay}
                onFocus={setSignupFocus}
                label="New sign-ups per day"
              />
              <Show when={chartOverlay()}>
                <div class="admin-chart-legend">
                  <span class="admin-chart-legend-item">
                    <span class="admin-legend-swatch t-steel" /> Daily sign-ups
                  </span>
                  <span class="admin-chart-legend-item">
                    <span class="admin-legend-swatch is-dashed" /> 7-day average
                  </span>
                </div>
              </Show>
            </section>

            <div class="admin-grid-2">
              <section class="admin-panel">
                <div class="admin-panel-head">
                  <h2 class="admin-panel-title">What’s being watched</h2>
                  <span class="admin-panel-sub">Live &amp; sports · last 7 days</span>
                </div>
                <Show
                  when={topLiveBars().length}
                  fallback={<div class="admin-empty">No live views recorded yet.</div>}
                >
                  <HBars items={topLiveBars()} />
                </Show>
              </section>

              <section class="admin-panel">
                <div class="admin-panel-head">
                  <h2 class="admin-panel-title">Engagement</h2>
                  <span class="admin-panel-sub">Saved &amp; in-progress items</span>
                </div>
                <HBars items={engagement()} />
              </section>
            </div>

            <div class="admin-grid-2">
              <section class="admin-panel">
                <div class="admin-panel-head">
                  <h2 class="admin-panel-title">Most engaged users</h2>
                  <button class="admin-link-btn" onClick={() => setTab("users")}>
                    All users
                  </button>
                </div>
                <Show
                  when={topUsers().length}
                  fallback={<div class="admin-empty">No engagement data yet.</div>}
                >
                  <HBars items={topUsers()} onSelect={(it) => openUser(it.user)} />
                </Show>
              </section>

              <section class="admin-panel">
                <div class="admin-panel-head">
                  <h2 class="admin-panel-title">User base</h2>
                  <span class="admin-panel-sub">Verification mix</span>
                </div>
                <DonutChart
                  segments={composition()}
                  centerValue={fmtNum(overview().totalUsers)}
                  centerLabel="users"
                  label="User verification mix"
                />
                <div class="admin-meta-row">
                  <span class="admin-meta-chip">
                    <span class="admin-meta-dot t-red" /> {fmtNum(overview().adminUsers)} admins
                  </span>
                  <span class="admin-meta-chip">
                    <span class="admin-meta-dot t-amber" /> {fmtNum(overview().disabledUsers)} disabled
                  </span>
                </div>
              </section>
            </div>

            <section class="admin-panel">
              <div class="admin-panel-head">
                <div>
                  <h2 class="admin-panel-title">Activity by hour</h2>
                  <span class="admin-panel-sub">When your users are active (last {fmtNum(activity().length)} events)</span>
                </div>
                <div class="admin-kindchips">
                  <For each={activityByKind()}>
                    {(k) => (
                      <span class="admin-meta-chip">
                        <span class={`admin-meta-dot t-${k.tone}`} /> {fmtNum(k.value)} {k.label.toLowerCase()}
                      </span>
                    )}
                  </For>
                </div>
              </div>
              <Heatmap cells={activityByHour()} tone="steel" />
            </section>

            <section class="admin-panel">
              <div class="admin-panel-head">
                <h2 class="admin-panel-title">Latest activity</h2>
                <button class="admin-link-btn" onClick={() => setTab("activity")}>
                  View all
                </button>
              </div>
              <ActivityFeed events={activity().slice(0, 10)} />
            </section>
          </Show>
        </Show>

        {/* ── Users ────────────────────────────────────────────────── */}
        <Show when={tab() === "users"}>
          <div class="admin-toolbar">
            <input
              class="admin-search"
              type="search"
              placeholder="Search name or email…"
              value={search()}
              onInput={(e) => onSearchInput(e.currentTarget.value)}
            />
            <div class="admin-toolbar-stats">
              <span class="admin-count">{fmtNum(usersSummary().shown)} shown</span>
              <span class="admin-count-sep">·</span>
              <span class="admin-count">{fmtNum(usersSummary().verified)} verified</span>
              <span class="admin-count-sep">·</span>
              <span class="admin-count">{fmtNum(usersSummary().admins)} admins</span>
            </div>
          </div>
          <div class="admin-tablewrap">
            <table class="admin-table">
              <thead>
                <tr>
                  <th class="admin-sortable" onClick={() => toggleSort("name")}>
                    User{sortIndicator("name")}
                  </th>
                  <th class="admin-sortable" onClick={() => toggleSort("createdAt")}>
                    Joined{sortIndicator("createdAt")}
                  </th>
                  <th>Status</th>
                  <th class="admin-num admin-sortable" onClick={() => toggleSort("sessions")}>
                    Sessions{sortIndicator("sessions")}
                  </th>
                  <th class="admin-sortable" onClick={() => toggleSort("engagement")}>
                    Engagement{sortIndicator("engagement")}
                  </th>
                  <th class="admin-sortable" onClick={() => toggleSort("lastActive")}>
                    Last active{sortIndicator("lastActive")}
                  </th>
                  <th class="admin-chevron-col" aria-hidden="true"></th>
                </tr>
              </thead>
              <tbody>
                <For each={sortedUsers()}>
                  {(u) => (
                    <tr
                      class="admin-rowlink"
                      classList={{
                        "is-disabled": u.isDisabled,
                        "is-open": detailUser()?.id === u.id,
                      }}
                      onClick={() => openUser(u)}
                    >
                      <td>
                        <div class="admin-user-cell">
                          <span class="admin-user-name">{u.displayName || "—"}</span>
                          <span class="admin-user-email">{u.email}</span>
                        </div>
                      </td>
                      <td>{fmtDate(u.createdAt)}</td>
                      <td>
                        <div class="admin-badges">
                          <Show when={u.isAdmin}>
                            <span class="admin-badge is-admin">Admin</span>
                          </Show>
                          <Show when={u.isDisabled}>
                            <span class="admin-badge is-off">Disabled</span>
                          </Show>
                          <Show
                            when={u.emailVerifiedAt}
                            fallback={<span class="admin-badge is-muted">Unverified</span>}
                          >
                            <span class="admin-badge is-ok">Verified</span>
                          </Show>
                        </div>
                      </td>
                      <td class="admin-num">{fmtNum(u.sessionCount)}</td>
                      <td>
                        <div class="admin-engage-cell">
                          <span class="admin-engage-num">
                            {fmtNum((u.continueWatchingCount || 0) + (u.myListCount || 0))}
                          </span>
                          <span class="admin-engage-detail">
                            {fmtNum(u.continueWatchingCount)} watching · {fmtNum(u.myListCount)} list
                          </span>
                        </div>
                      </td>
                      <td>{u.lastActiveAt ? relTime(u.lastActiveAt) : "—"}</td>
                      <td class="admin-chevron-col" aria-hidden="true">
                        <span class="admin-chevron">›</span>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
          <Show when={!users().length && status() !== "loading"}>
            <div class="admin-empty">No users match “{search()}”.</div>
          </Show>
        </Show>

        {/* ── Activity ─────────────────────────────────────────────── */}
        <Show when={tab() === "activity"}>
          <section class="admin-panel">
            <div class="admin-panel-head">
              <h2 class="admin-panel-title">Activity by hour</h2>
              <span class="admin-panel-sub">When your users are active (last {fmtNum(activity().length)} events)</span>
            </div>
            <Heatmap cells={activityByHour()} tone="blue" />
          </section>
          <div class="admin-grid-2 admin-grid-tight">
            <section class="admin-panel">
              <div class="admin-panel-head">
                <h2 class="admin-panel-title">Breakdown</h2>
                <span class="admin-panel-sub">By type</span>
              </div>
              <DonutChart
                segments={activityByKind()}
                centerValue={fmtNum(activity().length)}
                centerLabel="events"
                label="Activity by type"
              />
            </section>
            <section class="admin-panel admin-panel-scroll">
              <div class="admin-panel-head">
                <h2 class="admin-panel-title">Top live streams</h2>
                <span class="admin-panel-sub">Sports &amp; channels · last 7 days</span>
              </div>
              <Show
                when={topLiveBars().length}
                fallback={<div class="admin-empty">No live views recorded yet.</div>}
              >
                <HBars items={topLiveBars()} />
              </Show>
            </section>
          </div>
          <section class="admin-panel">
            <div class="admin-panel-head">
              <h2 class="admin-panel-title">Activity feed</h2>
              <span class="admin-panel-sub">Sign-ins, watches, live &amp; sign-ups</span>
            </div>
            <ActivityFeed events={activity()} />
          </section>
        </Show>

        {/* ── Feedback ─────────────────────────────────────────────── */}
        <Show when={tab() === "feedback"}>
          <section class="admin-panel">
            <div class="admin-panel-head">
              <h2 class="admin-panel-title">User feedback</h2>
              <span class="admin-panel-sub">
                {fmtNum(feedback().length)} message{feedback().length === 1 ? "" : "s"}
              </span>
            </div>
            <Show
              when={feedback().length}
              fallback={<div class="admin-empty">No feedback yet.</div>}
            >
              <ul class="admin-feedback-list">
                <For each={feedback()}>
                  {(item) => (
                    <li class="admin-feedback-item">
                      <div class="admin-feedback-head">
                        <strong class="admin-feedback-author">
                          {item.displayName || item.email || "Anonymous"}
                        </strong>
                        <span class="admin-feedback-meta">
                          {item.email}
                          <Show when={item.email && item.createdAt}> · </Show>
                          {relTime(item.createdAt)}
                        </span>
                      </div>
                      <p class="admin-feedback-message">{item.message}</p>
                      <Show when={item.hasImage}>
                        <a
                          class="admin-feedback-image-link"
                          href={`/api/admin/feedback/${item.id}/image`}
                          target="_blank"
                          rel="noopener"
                        >
                          <img
                            class="admin-feedback-image"
                            src={`/api/admin/feedback/${item.id}/image`}
                            alt="Feedback attachment"
                            loading="lazy"
                          />
                        </a>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>
        </Show>

        {/* ── Health ───────────────────────────────────────────────── */}
        <Show when={tab() === "health"}>
          <Show
            when={health()}
            fallback={
              <Show
                when={healthError() && healthStatus() === "error"}
                fallback={<div class="admin-loading">Checking service health…</div>}
              >
                <div class="admin-error">{healthError()}</div>
              </Show>
            }
          >
            <section class={`admin-status ${statusClass(health().status)}`}>
              <span class={`admin-status-dot ${statusClass(health().status)}`} />
              <div class="admin-status-body">
                <h2 class="admin-status-title">{STATUS_LABEL[health().status]}</h2>
                <p class="admin-status-sub">{healthSummary(health())}</p>
              </div>
              <span class="admin-status-meta">
                <span class="admin-live-dot" />
                uptime {fmtUptime(health().uptimeSeconds)} · refreshes every 20s
              </span>
            </section>

            <div class="admin-gauges">
              <For each={gauges()}>
                {(g) => (
                  <Gauge
                    label={g.label}
                    value={g.value}
                    display={g.display}
                    sub={g.sub}
                  />
                )}
              </For>
            </div>

            <div class="admin-stats-row">
              <For each={healthStats()}>
                {(s) => <StatTile label={s.label} value={s.value} sub={s.sub} tone={s.tone} />}
              </For>
            </div>

            <section class="admin-panel">
              <div class="admin-panel-head">
                <h2 class="admin-panel-title">24-hour uptime</h2>
                <span class="admin-panel-sub">{fmtNum(healthHistory().length)} samples</span>
              </div>
              <StatusRibbon samples={healthHistory()} timeFormat={clockTime} />
              <div class="admin-ribbon-legend">
                <span class="admin-chart-legend-item"><span class="admin-legend-swatch is-ok" /> Healthy</span>
                <span class="admin-chart-legend-item"><span class="admin-legend-swatch is-warn" /> Degraded</span>
                <span class="admin-chart-legend-item"><span class="admin-legend-swatch is-down" /> Issues</span>
              </div>
            </section>

            <section class="admin-panel">
              <div class="admin-panel-head">
                <div>
                  <h2 class="admin-panel-title">Metrics · last 24h</h2>
                  <span class="admin-panel-sub">{activeMetric().label}</span>
                </div>
                <Segmented
                  value={healthMetric()}
                  onChange={setHealthMetric}
                  options={HEALTH_METRICS.map((m) => ({ value: m.key, label: m.label }))}
                />
              </div>
              <TrendChart
                data={healthTimeline()}
                mode="area"
                tone={activeMetric().tone}
                format={(v) => `${v.toFixed(activeMetric().unit ? 1 : 2)}${activeMetric().unit}`}
                label={`${activeMetric().label} over 24 hours`}
              />
            </section>

            <div class="admin-grid-2">
              <section class="admin-panel">
                <div class="admin-panel-head">
                  <h2 class="admin-panel-title">Request mix</h2>
                  <span class="admin-panel-sub">{fmtNum(requestMix().total)} total</span>
                </div>
                <DonutChart
                  segments={requestMix().segments}
                  centerValue={fmtNum(requestMix().total)}
                  centerLabel="requests"
                  label="HTTP request mix"
                />
              </section>

              <section class="admin-panel">
                <div class="admin-panel-head">
                  <h2 class="admin-panel-title">Checks</h2>
                  <span class="admin-panel-sub">Live status checks</span>
                </div>
                <div class="admin-checks">
                  <For each={health().checks || []}>
                    {(c) => (
                      <div class="admin-check">
                        <span class={`admin-status-dot ${statusClass(c.status)}`} />
                        <div class="admin-check-body">
                          <div class="admin-check-label">{c.label}</div>
                          <div class="admin-check-detail">{c.detail}</div>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </section>
            </div>

            <section class="admin-panel">
              <div class="admin-panel-head">
                <h2 class="admin-panel-title">Streaming pipeline</h2>
                <span class="admin-panel-sub">Remux &amp; HLS transcode workers</span>
              </div>
              <div class="admin-stats-row">
                <StatTile label="Remux active" value={fmtNum(streaming().remux.active)} tone="blue" sub={`${fmtNum(streaming().remux.maxConcurrent)} max`} />
                <StatTile label="Remux done" value={fmtNum(streaming().remux.completed)} tone="green" sub={`${fmtNum(streaming().remux.failed)} failed`} />
                <StatTile label="Transcodes active" value={fmtNum(streaming().hls.activeTranscodes)} tone="violet" sub={`${fmtNum(streaming().hls.maxTranscodeJobs)} max`} />
                <StatTile label="Transcodes done" value={fmtNum(streaming().hls.transcodeCompleted)} tone="green" sub={`${fmtNum(streaming().hls.transcodeFailed)} failed`} />
                <StatTile label="Segment cache" value={`${streaming().cacheHitRate.toFixed(0)}%`} tone="cyan" sub={`${fmtNum(streaming().cacheTotal)} lookups`} />
                <StatTile label="On-demand renders" value={fmtNum(streaming().hls.onDemandRenders)} tone="amber" sub={`${fmtNum(streaming().hls.segmentRenderFailed)} failed`} />
              </div>
            </section>

            <section class="admin-panel">
              <div class="admin-panel-head">
                <h2 class="admin-panel-title">Resolver</h2>
                <span class="admin-panel-sub">Source resolution &amp; external lookups</span>
              </div>
              <div class="admin-grid-2">
                <div class="admin-stats-row admin-stats-grid">
                  <StatTile label="Movie requests" value={fmtNum(resolver().movieRequests)} tone="red" />
                  <StatTile label="TV requests" value={fmtNum(resolver().tvRequests)} tone="violet" />
                  <StatTile label="External active" value={fmtNum(resolver().externalActive)} tone="blue" sub={`${fmtNum(resolver().maxExternalConcurrent)} max`} />
                  <StatTile label="Coalesced waits" value={fmtNum(resolver().coalescedWaits)} tone="cyan" />
                </div>
                <Show when={resolverOutcomes().some((o) => o.value > 0)} fallback={<div class="admin-empty">No external lookups yet.</div>}>
                  <DonutChart
                    segments={resolverOutcomes()}
                    centerValue={fmtNum(sum(resolverOutcomes().map((o) => o.value)))}
                    centerLabel="lookups"
                    label="External resolve outcomes"
                  />
                </Show>
              </div>
            </section>

            <Show when={providers().length}>
              <section class="admin-panel">
                <div class="admin-panel-head">
                  <h2 class="admin-panel-title">Providers</h2>
                  <span class="admin-panel-sub">Sports &amp; live stream sources</span>
                </div>
                <div class="admin-tablewrap">
                  <table class="admin-table">
                    <thead>
                      <tr>
                        <th>Provider</th>
                        <th>Health</th>
                        <th class="admin-num">OK</th>
                        <th class="admin-num">Fail</th>
                        <th class="admin-num">Streak</th>
                        <th class="admin-num">Latency</th>
                        <th>Last error</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={providers()}>
                        {(p) => {
                          const total = (p.successes || 0) + (p.failures || 0);
                          const rate = total ? (p.successes / total) * 100 : 100;
                          const tone = p.consecutiveFailures >= 3 ? "red" : rate < 80 ? "amber" : "green";
                          return (
                            <tr>
                              <td class="admin-provider-name">{p.key}</td>
                              <td>
                                <div class="admin-health-bar">
                                  <div class={`admin-health-fillwrap t-${tone}`}>
                                    <svg class="admin-hbar-svg" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true">
                                      <rect class="admin-hbar-fill" x="0" y="0" height="6" rx="3" width={Math.max(1, rate)} />
                                    </svg>
                                  </div>
                                  <span class="admin-health-pct">{rate.toFixed(0)}%</span>
                                </div>
                              </td>
                              <td class="admin-num">{fmtNum(p.successes)}</td>
                              <td class="admin-num">{fmtNum(p.failures)}</td>
                              <td class="admin-num">
                                <span classList={{ "admin-streak-bad": p.consecutiveFailures >= 3 }}>
                                  {fmtNum(p.consecutiveFailures)}
                                </span>
                              </td>
                              <td class="admin-num">
                                {p.lastLatencyMs >= 0 ? `${fmtNum(p.lastLatencyMs)}ms` : "—"}
                              </td>
                              <td class="admin-provider-err">{p.lastError || "—"}</td>
                            </tr>
                          );
                        }}
                      </For>
                    </tbody>
                  </table>
                </div>
              </section>
            </Show>
          </Show>
        </Show>

        {/* ── Providers ────────────────────────────────────────────── */}
        <Show when={tab() === "providers"}>
          <ProvidersPanel onFlash={showFlash} />
        </Show>
        </main>
      </div>

      <Show when={detailUser()}>
        <UserDetailDrawer
          user={detailUser()}
          detail={detail()}
          status={detailStatus()}
          error={detailError()}
          isSelf={detailUser()?.id === currentUser.id}
          onClose={closeUser}
          onResetPassword={drawerReset}
          onToggleDisabled={drawerToggleDisabled}
          onToggleAdmin={drawerToggleAdmin}
          onDelete={drawerDelete}
        />
      </Show>

      <Show when={pwTarget()}>
        <div class="admin-modal-overlay" onClick={() => setPwTarget(null)}>
          <div class="admin-modal" onClick={(e) => e.stopPropagation()}>
            <h3 class="admin-modal-title">Reset password</h3>
            <p class="admin-modal-sub">
              Set a new password for <strong>{pwTarget().email}</strong>. This signs them
              out of all active sessions.
            </p>
            <input
              class="admin-input"
              type="text"
              autocomplete="off"
              placeholder="New password (min 6 characters)"
              value={pwValue()}
              onInput={(e) => setPwValue(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitPassword();
                if (e.key === "Escape") setPwTarget(null);
              }}
            />
            <Show when={pwError()}>
              <div class="admin-modal-error">{pwError()}</div>
            </Show>
            <div class="admin-modal-actions">
              <button class="admin-btn" onClick={() => setPwTarget(null)}>
                Cancel
              </button>
              <button class="admin-btn is-primary" onClick={() => submitPassword()}>
                Set password
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}

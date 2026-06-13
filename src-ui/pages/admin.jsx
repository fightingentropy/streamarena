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

const numberFormat = new Intl.NumberFormat();

function fmtNum(value) {
  return numberFormat.format(Number(value) || 0);
}

function fmtDate(ms) {
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

function relTime(ms) {
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

function feedText(event) {
  if (event.kind === "login") return "signed in";
  if (event.kind === "signup") return "created an account";
  if (event.kind === "watch") return "watched";
  return event.detail || "";
}

// SVG bar chart. Geometry uses presentation attributes (CSP-safe — no inline
// `style`), fills come from admin.css. All values are accessors so the chart
// re-renders reactively when `props.data` arrives.
function GrowthChart(props) {
  const W = 740;
  const H = 200;
  const padX = 10;
  const padTop = 18;
  const padBottom = 28;
  const innerH = H - padTop - padBottom;
  const data = () => props.data || [];
  const max = () => Math.max(1, ...data().map((d) => d.signups));
  const slot = () => (W - padX * 2) / Math.max(1, data().length);
  const barW = () => Math.max(2, slot() * 0.62);
  return (
    <Show
      when={data().length}
      fallback={<div class="admin-chart-empty">No sign-up data yet.</div>}
    >
      <svg
        class="admin-chart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="New sign-ups per day"
      >
        <line
          class="admin-chart-axis"
          x1={padX}
          y1={H - padBottom}
          x2={W - padX}
          y2={H - padBottom}
        />
        <For each={data()}>
          {(d, i) => {
            const h = () =>
              d.signups > 0 ? Math.max(2, Math.round((d.signups / max()) * innerH)) : 0;
            const x = () => padX + i() * slot() + (slot() - barW()) / 2;
            const y = () => H - padBottom - h();
            return (
              <rect
                class="admin-chart-bar"
                x={x()}
                y={y()}
                width={barW()}
                height={h()}
                rx="2"
              >
                <title>{`${d.date}: ${d.signups} sign-up${d.signups === 1 ? "" : "s"}`}</title>
              </rect>
            );
          }}
        </For>
      </svg>
    </Show>
  );
}

const STATUS_LABEL = {
  green: "All systems smooth",
  amber: "Running degraded",
  red: "Service issues",
};

// Map a backend status ("green"/"amber"/"red") to the CSS state class shared by
// the status card, dots, and pill.
function statusClass(status) {
  if (status === "red") return "is-down";
  if (status === "amber") return "is-warn";
  return "is-ok";
}

// One-line summary for the status card: the failing checks' details, or a
// reassuring all-clear.
function healthSummary(h) {
  if (!h) return "";
  const bad = (h.checks || []).filter((c) => c.status !== "green");
  if (!bad.length) return "All checks passing.";
  return bad.map((c) => c.detail).join(" · ");
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v <= 0) return "—";
  const gb = v / 1e9;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  return `${(v / 1e6).toFixed(0)} MB`;
}

function fmtUptime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function ratioPct(part, whole) {
  const w = Number(whole) || 0;
  if (w <= 0) return 0;
  return ((Number(part) || 0) / w) * 100;
}

// CSP-safe sparkline (same approach as GrowthChart): geometry via presentation
// attributes, colors via CSS classes — no inline `style`. `preserveAspectRatio`
// stretches it to the card; `non-scaling-stroke` (in admin.css) keeps the line
// crisp. `max` is a floor so an all-zero series doesn't amplify noise.
function Sparkline(props) {
  const W = 240;
  const H = 48;
  const pad = 3;
  const values = () => props.values || [];
  const max = () => Math.max(props.max || 0, 1, ...values());
  const stepX = () => (W - pad * 2) / Math.max(1, values().length - 1);
  const linePoints = () =>
    values()
      .map((v, i) => {
        const x = pad + i * stepX();
        const y = H - pad - (Math.max(0, v) / max()) * (H - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  const areaPoints = () => {
    const line = linePoints();
    if (!line) return "";
    const lastX = pad + (values().length - 1) * stepX();
    return `${pad.toFixed(1)},${H - pad} ${line} ${lastX.toFixed(1)},${H - pad}`;
  };
  const toneClass = () =>
    props.tone === "red" ? "is-red" : props.tone === "amber" ? "is-amber" : "";
  return (
    <Show
      when={values().length > 1}
      fallback={<div class="admin-spark-empty">collecting…</div>}
    >
      <svg
        class={`admin-spark ${toneClass()}`}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={props.label || "trend"}
      >
        <polygon class="admin-spark-fill" points={areaPoints()} />
        <polyline class="admin-spark-line" points={linePoints()} />
      </svg>
    </Show>
  );
}

function ActivityFeed(props) {
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

function Unauthorized(props) {
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

export default function AdminPage() {
  const currentUser = window.__currentUser || {};
  if (!currentUser.isAdmin) {
    return <Unauthorized email={currentUser.email} />;
  }

  const [tab, setTab] = createSignal("overview");
  const [overview, setOverview] = createSignal(null);
  const [growth, setGrowth] = createSignal([]);
  const [activity, setActivity] = createSignal([]);
  const [feedback, setFeedback] = createSignal([]);
  const [users, setUsers] = createSignal([]);
  const [search, setSearch] = createSignal("");
  const [status, setStatus] = createSignal("loading");
  const [error, setError] = createSignal("");
  const [flash, setFlash] = createSignal(null);
  const [pwTarget, setPwTarget] = createSignal(null);
  const [pwValue, setPwValue] = createSignal("");
  const [pwError, setPwError] = createSignal("");
  const [health, setHealth] = createSignal(null);
  const [healthHistory, setHealthHistory] = createSignal([]);
  const [healthStatus, setHealthStatus] = createSignal("idle");
  const [healthError, setHealthError] = createSignal("");

  let searchTimer;
  let flashTimer;
  let healthTimer;

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
      const [ov, gr, ac, fb] = await Promise.all([
        getJson("/api/admin/overview"),
        getJson("/api/admin/growth?days=30"),
        getJson("/api/admin/activity?limit=40"),
        getJson("/api/admin/feedback?limit=200"),
      ]);
      setOverview(ov);
      setGrowth(gr.days || []);
      setActivity(ac.events || []);
      setFeedback(fb.feedback || []);
      await loadUsers();
      setStatus("ready");
      // Populate the at-a-glance status pill on the overview without blocking
      // the main load; the Health tab does the full fetch + 20s polling.
      getJson("/api/admin/health")
        .then(setHealth)
        .catch(() => {});
    } catch (e) {
      setError(e.message || "Unknown error");
      setStatus("error");
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

  // Refresh the data that an action can change, without the full-page spinner.
  async function refreshAfterAction() {
    try {
      const [ov, ac] = await Promise.all([
        getJson("/api/admin/overview"),
        getJson("/api/admin/activity?limit=40"),
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

  function openPwModal(user) {
    setPwTarget(user);
    setPwValue("");
    setPwError("");
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
      return;
    try {
      await postJson("/api/admin/users/delete", { userId: user.id });
      showFlash(`${user.email} deleted.`);
      await refreshAfterAction();
    } catch (e) {
      showFlash(e.message, true);
    }
  }

  const kpis = createMemo(() => {
    const o = overview();
    if (!o) return [];
    return [
      { label: "Total users", value: o.totalUsers, sub: `${fmtNum(o.verifiedUsers)} email-verified` },
      { label: "New · 24h", value: o.newUsers24h, sub: `${fmtNum(o.newUsers7d)} in last 7 days` },
      { label: "New · 30d", value: o.newUsers30d, sub: "rolling month" },
      { label: "Active now", value: o.activeUsers, sub: `${fmtNum(o.activeSessions)} live sessions` },
      { label: "Admins", value: o.adminUsers, sub: `${fmtNum(o.disabledUsers)} disabled` },
      {
        label: "Continue watching",
        value: o.continueWatchingItems,
        sub: `${fmtNum(o.myListItems)} My-List items`,
      },
    ];
  });

  const healthKpis = createMemo(() => {
    const h = health();
    if (!h) return [];
    const host = h.host || {};
    const http = (h.http && h.http.counters) || {};
    const restarts = h.restarts || {};
    const playback = h.playback || {};
    return [
      {
        label: "Uptime",
        value: fmtUptime(h.uptimeSeconds),
        sub: `${fmtNum(http.reqTotal)} requests served`,
      },
      {
        label: "Restarts · 1h",
        value: fmtNum(restarts.lastHour),
        sub:
          restarts.minutesSinceLast != null
            ? `last ${restarts.minutesSinceLast}m ago`
            : "none recently",
      },
      {
        label: "File descriptors",
        value: host.fdCount >= 0 ? fmtNum(host.fdCount) : "—",
        sub:
          host.fdLimit > 0
            ? `of ${fmtNum(host.fdLimit)} · ${ratioPct(host.fdCount, host.fdLimit).toFixed(0)}%`
            : "limit unknown",
      },
      {
        label: "Memory",
        value: `${ratioPct(host.memUsed, host.memTotal).toFixed(0)}%`,
        sub: `${fmtBytes(host.memUsed)} / ${fmtBytes(host.memTotal)}`,
      },
      {
        label: "Disk free",
        value: host.diskTotal > 0 ? `${ratioPct(host.diskFree, host.diskTotal).toFixed(0)}%` : "—",
        sub: `${fmtBytes(host.diskFree)} free`,
      },
      {
        label: "CPU load",
        value: (Number(host.load1) || 0).toFixed(2),
        sub: `${fmtNum(host.numCpus)} cores`,
      },
      {
        label: "HTTP 5xx",
        value: `${(Number(h.http?.req5xxRate) || 0).toFixed(1)}%`,
        sub: `${fmtNum(http.req5xx)} of ${fmtNum(http.reqTotal)}`,
      },
      {
        label: "Playback fails",
        value: `${(Number(playback.failureRate) || 0).toFixed(0)}%`,
        sub: `${fmtNum(playback.windowTotal)} recent plays`,
      },
    ];
  });

  const sparkSpecs = createMemo(() => {
    const samples = healthHistory();
    const last = samples.length ? samples[samples.length - 1] : null;
    return [
      {
        label: "HTTP 5xx rate",
        tone: "red",
        max: 5,
        values: samples.map((s) => Number(s.req5xxRate) || 0),
        current: last ? `${(Number(last.req5xxRate) || 0).toFixed(1)}%` : "—",
      },
      {
        label: "Playback fail rate",
        tone: "amber",
        max: 10,
        values: samples.map((s) => Number(s.playbackFailureRate) || 0),
        current: last ? `${(Number(last.playbackFailureRate) || 0).toFixed(0)}%` : "—",
      },
      {
        label: "FD usage",
        tone: "blue",
        max: 100,
        values: samples.map((s) => ratioPct(s.fdCount, s.fdLimit)),
        current: last ? `${ratioPct(last.fdCount, last.fdLimit).toFixed(0)}%` : "—",
      },
      {
        label: "Memory usage",
        tone: "blue",
        max: 100,
        values: samples.map((s) => ratioPct(s.memUsed, s.memTotal)),
        current: last ? `${ratioPct(last.memUsed, last.memTotal).toFixed(0)}%` : "—",
      },
    ];
  });

  // Poll the Health tab while it's open; stop when the user navigates away.
  createEffect(() => {
    clearInterval(healthTimer);
    if (tab() === "health") {
      loadHealth(true);
      healthTimer = setInterval(() => loadHealth(false), 20_000);
    }
  });
  onCleanup(() => clearInterval(healthTimer));

  onMount(loadAll);

  return (
    <div class="admin-shell">
      <header class="admin-header">
        <div class="admin-brand">
          <span class="admin-brand-mark">NETFLIX</span>
          <span class="admin-brand-tag">Admin</span>
        </div>
        <div class="admin-header-right">
          <span class="admin-whoami">{currentUser.email}</span>
          <a class="admin-link" href="/">
            View site
          </a>
          <button class="admin-btn" onClick={() => signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <nav class="admin-tabnav">
        <button
          classList={{ "admin-tab": true, "is-active": tab() === "overview" }}
          onClick={() => setTab("overview")}
        >
          Overview
        </button>
        <button
          classList={{ "admin-tab": true, "is-active": tab() === "users" }}
          onClick={() => setTab("users")}
        >
          Users
        </button>
        <button
          classList={{ "admin-tab": true, "is-active": tab() === "activity" }}
          onClick={() => setTab("activity")}
        >
          Activity
        </button>
        <button
          classList={{ "admin-tab": true, "is-active": tab() === "feedback" }}
          onClick={() => setTab("feedback")}
        >
          Feedback
          <Show when={feedback().length}>
            <span class="admin-tab-count">{fmtNum(feedback().length)}</span>
          </Show>
        </button>
        <button
          classList={{ "admin-tab": true, "is-active": tab() === "health" }}
          onClick={() => setTab("health")}
        >
          Health
        </button>
        <span class="admin-tabnav-spacer" />
        <button
          class="admin-btn admin-refresh"
          onClick={() => loadAll()}
          disabled={status() === "loading"}
        >
          Refresh
        </button>
      </nav>

      <Show when={flash()}>
        <div classList={{ "admin-flash": true, "is-error": flash().isError }}>
          {flash().text}
        </div>
      </Show>

      <Show when={status() === "error"}>
        <div class="admin-error">Couldn’t load the dashboard: {error()}</div>
      </Show>

      <main class="admin-main">
        <Show when={tab() === "overview"}>
          <Show when={overview()} fallback={<div class="admin-loading">Loading metrics…</div>}>
            <Show when={health()}>
              <button
                class={`admin-status-pill ${statusClass(health().status)}`}
                onClick={() => setTab("health")}
              >
                <span class={`admin-status-dot ${statusClass(health().status)}`} />
                {STATUS_LABEL[health().status] || "Service health"}
                <span class="admin-status-pill-go">View health →</span>
              </button>
            </Show>
            <div class="admin-kpis">
              <For each={kpis()}>
                {(k) => (
                  <div class="admin-kpi">
                    <span class="admin-kpi-label">{k.label}</span>
                    <span class="admin-kpi-value">{fmtNum(k.value)}</span>
                    <span class="admin-kpi-sub">{k.sub}</span>
                  </div>
                )}
              </For>
            </div>

            <section class="admin-panel">
              <div class="admin-panel-head">
                <h2 class="admin-panel-title">New sign-ups</h2>
                <span class="admin-panel-sub">Last 30 days</span>
              </div>
              <GrowthChart data={growth()} />
            </section>

            <section class="admin-panel">
              <div class="admin-panel-head">
                <h2 class="admin-panel-title">Latest activity</h2>
                <button class="admin-link-btn" onClick={() => setTab("activity")}>
                  View all
                </button>
              </div>
              <ActivityFeed events={activity().slice(0, 8)} />
            </section>
          </Show>
        </Show>

        <Show when={tab() === "users"}>
          <div class="admin-toolbar">
            <input
              class="admin-search"
              type="search"
              placeholder="Search name or email…"
              value={search()}
              onInput={(e) => onSearchInput(e.currentTarget.value)}
            />
            <span class="admin-count">{users().length} shown</span>
          </div>
          <div class="admin-tablewrap">
            <table class="admin-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Joined</th>
                  <th>Status</th>
                  <th class="admin-num">Sessions</th>
                  <th>Last active</th>
                  <th class="admin-actions-col">Actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={users()}>
                  {(u) => (
                    <tr classList={{ "is-disabled": u.isDisabled }}>
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
                      <td class="admin-num">{u.sessionCount}</td>
                      <td>{u.lastActiveAt ? relTime(u.lastActiveAt) : "—"}</td>
                      <td>
                        <div class="admin-row-actions">
                          <button
                            class="admin-btn admin-btn-sm"
                            onClick={() => openPwModal(u)}
                          >
                            Reset
                          </button>
                          <Show when={u.id !== currentUser.id}>
                            <button
                              class="admin-btn admin-btn-sm"
                              onClick={() => toggleDisabled(u)}
                            >
                              {u.isDisabled ? "Enable" : "Disable"}
                            </button>
                            <button
                              class="admin-btn admin-btn-sm"
                              onClick={() => toggleAdmin(u)}
                            >
                              {u.isAdmin ? "Unadmin" : "Make admin"}
                            </button>
                            <button
                              class="admin-btn admin-btn-sm is-danger"
                              onClick={() => deleteUser(u)}
                            >
                              Delete
                            </button>
                          </Show>
                        </div>
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

        <Show when={tab() === "activity"}>
          <section class="admin-panel">
            <div class="admin-panel-head">
              <h2 class="admin-panel-title">Activity feed</h2>
              <span class="admin-panel-sub">Recent sign-ins, watches &amp; sign-ups</span>
            </div>
            <ActivityFeed events={activity()} />
          </section>
        </Show>

        <Show when={tab() === "feedback"}>
          <section class="admin-panel">
            <div class="admin-panel-head">
              <h2 class="admin-panel-title">User feedback</h2>
              <span class="admin-panel-sub">{fmtNum(feedback().length)} message{feedback().length === 1 ? "" : "s"}</span>
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
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>
        </Show>

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
              <span class="admin-status-meta">uptime {fmtUptime(health().uptimeSeconds)}</span>
            </section>

            <div class="admin-kpis">
              <For each={healthKpis()}>
                {(k) => (
                  <div class="admin-kpi">
                    <span class="admin-kpi-label">{k.label}</span>
                    <span class="admin-kpi-value">{k.value}</span>
                    <span class="admin-kpi-sub">{k.sub}</span>
                  </div>
                )}
              </For>
            </div>

            <section class="admin-panel">
              <div class="admin-panel-head">
                <h2 class="admin-panel-title">Checks</h2>
                <span class="admin-panel-sub">Live · refreshes every 20s</span>
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

            <section class="admin-panel">
              <div class="admin-panel-head">
                <h2 class="admin-panel-title">Last 24 hours</h2>
                <span class="admin-panel-sub">{fmtNum(healthHistory().length)} samples</span>
              </div>
              <div class="admin-sparks">
                <For each={sparkSpecs()}>
                  {(s) => (
                    <div class="admin-spark-card">
                      <div class="admin-spark-head">
                        <span class="admin-spark-label">{s.label}</span>
                        <span class="admin-spark-value">{s.current}</span>
                      </div>
                      <Sparkline values={s.values} tone={s.tone} max={s.max} label={s.label} />
                    </div>
                  )}
                </For>
              </div>
            </section>

            <Show when={(health().providers?.providers || []).length}>
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
                        <th class="admin-num">OK</th>
                        <th class="admin-num">Fail</th>
                        <th class="admin-num">Streak</th>
                        <th class="admin-num">Latency</th>
                        <th>Last error</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={health().providers.providers}>
                        {(p) => (
                          <tr>
                            <td>{p.key}</td>
                            <td class="admin-num">{fmtNum(p.successes)}</td>
                            <td class="admin-num">{fmtNum(p.failures)}</td>
                            <td class="admin-num">{fmtNum(p.consecutiveFailures)}</td>
                            <td class="admin-num">
                              {p.lastLatencyMs >= 0 ? `${fmtNum(p.lastLatencyMs)}ms` : "—"}
                            </td>
                            <td class="admin-provider-err">{p.lastError || "—"}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </section>
            </Show>
          </Show>
        </Show>
      </main>

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

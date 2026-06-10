import { createMemo, createSignal, For, onMount, Show } from "solid-js";

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
  const [users, setUsers] = createSignal([]);
  const [search, setSearch] = createSignal("");
  const [status, setStatus] = createSignal("loading");
  const [error, setError] = createSignal("");
  const [flash, setFlash] = createSignal(null);
  const [pwTarget, setPwTarget] = createSignal(null);
  const [pwValue, setPwValue] = createSignal("");
  const [pwError, setPwError] = createSignal("");

  let searchTimer;
  let flashTimer;

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
      const [ov, gr, ac] = await Promise.all([
        getJson("/api/admin/overview"),
        getJson("/api/admin/growth?days=30"),
        getJson("/api/admin/activity?limit=40"),
      ]);
      setOverview(ov);
      setGrowth(gr.days || []);
      setActivity(ac.events || []);
      await loadUsers();
      setStatus("ready");
    } catch (e) {
      setError(e.message || "Unknown error");
      setStatus("error");
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

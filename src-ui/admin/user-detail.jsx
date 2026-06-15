// The per-user drill-down drawer: slides in from the right when an admin picks
// a user (from the Users table or the "most engaged" panel) and shows their
// profile, derived viewing sessions, watch history, live views, saved list, and
// sign-ins. Account actions live here too, so the table itself stays clean.
//
// CSP-safe: no inline styles — everything is class-driven (see admin.css).

import { createMemo, For, Show } from "solid-js";

import {
  clockTime,
  fmtClock,
  fmtDate,
  fmtDuration,
  fmtNum,
  relTime,
  sessionize,
  StatTile,
} from "./widgets.jsx";

function initialOf(user) {
  const source = (user.displayName || user.email || "?").trim();
  return source ? source[0].toUpperCase() : "?";
}

function DrawerSkeleton() {
  return (
    <div class="admin-drawer-skeleton">
      <div class="admin-drawer-stats">
        <For each={[0, 1, 2, 3, 4, 5]}>
          {() => <div class="admin-skel admin-skel-tile" />}
        </For>
      </div>
      <div class="admin-skel admin-skel-block" />
      <div class="admin-skel admin-skel-block" />
    </div>
  );
}

export function UserDetailDrawer(props) {
  // `detail` is the fully-loaded payload (null while fetching); `user` is the
  // lightweight table row we already have, so the header paints instantly.
  const detail = () => props.detail;
  const header = () => props.detail || props.user || {};

  // Viewing sessions: cluster the union of watch / live / sign-in timestamps.
  const sessions = createMemo(() => {
    const d = detail();
    if (!d) return [];
    const stamps = [
      ...(d.watches || []).map((w) => w.updatedAt),
      ...(d.live || []).map((l) => l.createdAt),
      ...(d.sessions || []).map((s) => s.createdAt),
    ];
    return sessionize(stamps);
  });

  const sessionStats = createMemo(() => {
    const list = sessions();
    if (!list.length) return { count: 0, avg: 0, longest: 0 };
    const spans = list.map((s) => Math.max(0, s.end - s.start) / 1000);
    return {
      count: list.length,
      avg: spans.reduce((a, b) => a + b, 0) / list.length,
      longest: Math.max(...spans),
    };
  });

  const activeSignins = createMemo(() => {
    const d = detail();
    if (!d) return 0;
    const now = Date.now();
    return (d.sessions || []).filter((s) => s.expiresAt > now).length;
  });

  return (
    <div class="admin-drawer-overlay" onClick={() => props.onClose?.()}>
      <aside
        class="admin-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Details for ${header().email || "user"}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header class="admin-drawer-head">
          <div class="admin-drawer-id">
            <span class="admin-avatar">{initialOf(header())}</span>
            <div class="admin-drawer-idtext">
              <h2 class="admin-drawer-name">{header().displayName || "—"}</h2>
              <span class="admin-drawer-email">{header().email}</span>
            </div>
          </div>
          <button class="admin-drawer-close" onClick={() => props.onClose?.()} aria-label="Close">
            ×
          </button>
        </header>

        <div class="admin-drawer-badges">
          <Show when={header().isAdmin}>
            <span class="admin-badge is-admin">Admin</span>
          </Show>
          <Show when={header().isDisabled}>
            <span class="admin-badge is-off">Disabled</span>
          </Show>
          <Show
            when={header().emailVerifiedAt}
            fallback={<span class="admin-badge is-muted">Unverified</span>}
          >
            <span class="admin-badge is-ok">Verified</span>
          </Show>
          <span class="admin-drawer-meta">Joined {fmtDate(header().createdAt)}</span>
          <Show when={header().lastActiveAt}>
            <span class="admin-drawer-meta">· Active {relTime(header().lastActiveAt)}</span>
          </Show>
          <span class="admin-drawer-meta">· ID {header().id}</span>
        </div>

        <div class="admin-drawer-actions">
          <button class="admin-btn admin-btn-sm" onClick={() => props.onResetPassword?.()}>
            Reset password
          </button>
          <Show when={!props.isSelf}>
            <button class="admin-btn admin-btn-sm" onClick={() => props.onToggleDisabled?.()}>
              {header().isDisabled ? "Enable" : "Disable"}
            </button>
            <button class="admin-btn admin-btn-sm" onClick={() => props.onToggleAdmin?.()}>
              {header().isAdmin ? "Remove admin" : "Make admin"}
            </button>
            <button class="admin-btn admin-btn-sm is-danger" onClick={() => props.onDelete?.()}>
              Delete
            </button>
          </Show>
        </div>

        <div class="admin-drawer-body">
          <Show
            when={props.status !== "error"}
            fallback={<div class="admin-error">{props.error || "Couldn’t load this user."}</div>}
          >
            <Show when={detail()} fallback={<DrawerSkeleton />}>
              <div class="admin-drawer-stats">
                <StatTile
                  tone="blue"
                  label="Viewing sessions"
                  value={fmtNum(sessionStats().count)}
                  sub={`${fmtNum(activeSignins())} active sign-in${activeSignins() === 1 ? "" : "s"}`}
                />
                <StatTile tone="blue" label="Avg session" value={fmtDuration(sessionStats().avg)} />
                <StatTile tone="blue" label="Longest" value={fmtDuration(sessionStats().longest)} />
                <StatTile
                  tone="green"
                  label="In progress"
                  value={fmtNum(detail().continueWatchingCount)}
                />
                <StatTile tone="violet" label="Live views" value={fmtNum(detail().liveWatchCount)} />
                <StatTile tone="amber" label="In My List" value={fmtNum(detail().myListCount)} />
              </div>

              <section class="admin-drawer-section">
                <div class="admin-drawer-sectionhead">
                  <h3>Viewing sessions</h3>
                  <span class="admin-panel-sub">Inferred from activity · 30-min idle splits a session</span>
                </div>
                <Show
                  when={sessions().length}
                  fallback={<div class="admin-empty">No activity recorded yet.</div>}
                >
                  <ul class="admin-sesslist">
                    <For each={sessions().slice(0, 14)}>
                      {(s) => (
                        <li class="admin-sessrow">
                          <span class="admin-sess-when">
                            {fmtDate(s.start)} · {clockTime(s.start)}
                          </span>
                          <span class="admin-sess-dur">
                            {s.end > s.start ? fmtDuration((s.end - s.start) / 1000) : "single hit"}
                          </span>
                          <span class="admin-sess-count">
                            {fmtNum(s.count)} event{s.count === 1 ? "" : "s"}
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </section>

              <section class="admin-drawer-section">
                <div class="admin-drawer-sectionhead">
                  <h3>Continue watching</h3>
                  <span class="admin-panel-sub">
                    {fmtNum(detail().continueWatchingCount)} title
                    {detail().continueWatchingCount === 1 ? "" : "s"}
                  </span>
                </div>
                <Show
                  when={(detail().watches || []).length}
                  fallback={<div class="admin-empty">Nothing in progress.</div>}
                >
                  <ul class="admin-watchlist">
                    <For each={detail().watches}>
                      {(w) => (
                        <li class="admin-watchrow">
                          <Show when={w.thumb} fallback={<span class="admin-watchthumb is-empty" />}>
                            <img class="admin-watchthumb" src={w.thumb} alt="" loading="lazy" />
                          </Show>
                          <div class="admin-watchbody">
                            <span class="admin-watchtitle">{w.title || "Untitled"}</span>
                            <span class="admin-watchsub">
                              <Show when={w.mediaType}>
                                <span class="admin-tag">{w.mediaType}</span>{" "}
                              </Show>
                              <Show when={w.episode}>{w.episode} · </Show>
                              resumed at {fmtClock(w.resumeSeconds)}
                            </span>
                          </div>
                          <span class="admin-watchwhen">{relTime(w.updatedAt)}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </section>

              <Show when={(detail().live || []).length}>
                <section class="admin-drawer-section">
                  <div class="admin-drawer-sectionhead">
                    <h3>Live &amp; sports</h3>
                    <span class="admin-panel-sub">
                      {fmtNum(detail().liveWatchCount)} view{detail().liveWatchCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <ul class="admin-watchlist">
                    <For each={detail().live}>
                      {(l) => (
                        <li class="admin-watchrow is-compact">
                          <div class="admin-watchbody">
                            <span class="admin-watchtitle">{l.title || "Live"}</span>
                            <span class="admin-watchsub">
                              <span class="admin-tag">{l.category || "live"}</span>
                            </span>
                          </div>
                          <span class="admin-watchwhen">{relTime(l.createdAt)}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              </Show>

              <Show when={(detail().myList || []).length}>
                <section class="admin-drawer-section">
                  <div class="admin-drawer-sectionhead">
                    <h3>My List</h3>
                    <span class="admin-panel-sub">{fmtNum(detail().myListCount)} saved</span>
                  </div>
                  <ul class="admin-watchlist">
                    <For each={detail().myList}>
                      {(m) => (
                        <li class="admin-watchrow is-compact">
                          <div class="admin-watchbody">
                            <span class="admin-watchtitle">{m.title || "Untitled"}</span>
                            <span class="admin-watchsub">
                              <Show when={m.mediaType}>
                                <span class="admin-tag">{m.mediaType}</span>{" "}
                              </Show>
                              <Show when={m.year}>{m.year}</Show>
                            </span>
                          </div>
                          <span class="admin-watchwhen">{relTime(m.addedAt)}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              </Show>

              <section class="admin-drawer-section">
                <div class="admin-drawer-sectionhead">
                  <h3>Sign-ins</h3>
                  <span class="admin-panel-sub">
                    {fmtNum((detail().sessions || []).length)} on record · {fmtNum(activeSignins())} active
                  </span>
                </div>
                <Show
                  when={(detail().sessions || []).length}
                  fallback={<div class="admin-empty">No open sessions.</div>}
                >
                  <ul class="admin-sesslist">
                    <For each={detail().sessions.slice(0, 14)}>
                      {(s) => {
                        const active = s.expiresAt > Date.now();
                        return (
                          <li class="admin-sessrow">
                            <span class="admin-sess-when">
                              {fmtDate(s.createdAt)} · {clockTime(s.createdAt)}
                            </span>
                            <span classList={{ "admin-sess-tag": true, "is-active": active }}>
                              {active ? "active" : "expired"}
                            </span>
                          </li>
                        );
                      }}
                    </For>
                  </ul>
                </Show>
              </section>
            </Show>
          </Show>
        </div>
      </aside>
    </div>
  );
}

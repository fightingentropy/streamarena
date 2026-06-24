import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js";

import { LIVE_CHANNELS } from "../lib/live-channels.js";
import { Toggle } from "./widgets.jsx";

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

// Each group is its own sub-tab so the page is a short focused view instead of one
// endless scroll. `tabLabel` is the short chip; `title`/`sub` head the active view.
// The "live" rows are derived on the client from the compiled channel list (the
// backend only stores their overrides); the rest come straight from the catalog.
const GROUPS = [
  {
    key: "embed",
    tabLabel: "Rankings",
    title: "VOD source ranking",
    sub: "Enable, disable & rank external movie / show sources",
    hint: "Listed top-to-bottom in the order they appear in the in-app Server menu. Reorder with the arrows or set a weight directly (higher = shown first). Live per-title health can still nudge the final order by a small amount on top of this baseline.",
  },
  {
    key: "live",
    tabLabel: "Live TV",
    title: "Live TV channels",
    sub: "Direct HLS / embed source per channel stream",
  },
  {
    key: "sports",
    tabLabel: "Sports",
    title: "Sports stream APIs",
    sub: "Match discovery & schedule endpoints",
  },
  { key: "infra", tabLabel: "Infrastructure", title: "Infrastructure", sub: "App origin & upstream bases" },
];

// Build the live-channel rows from the compiled channel list + the override map.
// On the admin page `LIVE_CHANNELS` is never mutated by loadLiveChannelOverrides,
// so `stream.source` here is always the true compiled default.
function buildLiveRows(liveOverrides) {
  const rows = [];
  for (const channel of LIVE_CHANNELS) {
    for (const stream of channel.streams || []) {
      const key = `live:${channel.id}:${stream.id}`;
      const defaultUrl = String(stream.source || "");
      const override = liveOverrides[key];
      rows.push({
        key,
        group: "live",
        label: `${channel.title} · ${stream.label || stream.id}`,
        defaultUrl,
        effectiveUrl: override || defaultUrl,
        overridden: Boolean(override),
        editable: true,
        toggle: false,
        enabled: true,
        note: [channel.region, stream.quality].filter(Boolean).join(" · "),
      });
    }
  }
  return rows;
}

export default function ProvidersPanel(props) {
  const [providers, setProviders] = createSignal([]);
  const [liveOverrides, setLiveOverrides] = createSignal({});
  const [status, setStatus] = createSignal("loading");
  const [error, setError] = createSignal("");
  const [edits, setEdits] = createSignal({});
  const [rankEdits, setRankEdits] = createSignal({});
  const [tests, setTests] = createSignal({});
  const [busy, setBusy] = createSignal({});
  const [subTab, setSubTab] = createSignal("embed");
  const [filter, setFilter] = createSignal("");
  const [newUrl, setNewUrl] = createSignal("");
  const [newLabel, setNewLabel] = createSignal("");
  const [adding, setAdding] = createSignal(false);

  const flash = (text, isError = false) => props.onFlash && props.onFlash(text, isError);

  async function load() {
    setStatus("loading");
    setError("");
    try {
      const data = await getJson("/api/admin/providers");
      setProviders(data.providers || []);
      setLiveOverrides(data.liveOverrides || {});
      setEdits({});
      setRankEdits({});
      setStatus("ready");
    } catch (e) {
      setError(e.message || "Failed to load providers");
      setStatus("error");
    }
  }
  onMount(load);

  const rowsByGroup = createMemo(() => {
    const map = { live: buildLiveRows(liveOverrides()), sports: [], embed: [], infra: [] };
    for (const provider of providers()) {
      (map[provider.group] || (map[provider.group] = [])).push(provider);
    }
    // Embed providers display in their effective ranked order — the same order the
    // in-app Server menu shows — so the reorder arrows read top-to-bottom.
    map.embed.sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0) || a.label.localeCompare(b.label));
    return map;
  });

  const embedCount = createMemo(() => (rowsByGroup().embed || []).length);

  const overrideCount = createMemo(() => {
    let count = Object.keys(liveOverrides()).length;
    for (const provider of providers()) {
      if (provider.overridden) count += 1;
      if (provider.rankOverridden) count += 1;
    }
    return count;
  });

  // Sub-tabs: one chip per non-empty group, with a row count.
  const tabs = createMemo(() =>
    GROUPS.map((group) => ({ ...group, count: (rowsByGroup()[group.key] || []).length })).filter(
      (group) => group.count > 0,
    ),
  );
  // Keep the active sub-tab valid once the catalog has loaded (or if its group
  // empties out). Gated on the catalog so the default lands on Rankings rather than
  // flipping to Live TV during the brief window where only the compiled live rows
  // exist.
  createEffect(() => {
    if (!providers().length) return;
    const list = tabs();
    if (list.length && !list.some((t) => t.key === subTab())) setSubTab(list[0].key);
  });
  const selectTab = (key) => {
    setSubTab(key);
    setFilter("");
  };
  // Stable group identity (by key) so switching tabs swaps the view but a save/
  // reload doesn't churn the whole block.
  const activeGroup = createMemo(() => GROUPS.find((group) => group.key === subTab()) || null);
  // Rankings keeps its full sorted list (positions + reorder arrows depend on it);
  // the longer URL lists (Live TV especially) get a client-side filter so the page
  // isn't an endless scroll.
  const filterable = createMemo(() => {
    const group = activeGroup();
    return Boolean(group) && group.key !== "embed" && (rowsByGroup()[group.key] || []).length > 8;
  });
  const visibleRows = createMemo(() => {
    const group = activeGroup();
    if (!group) return [];
    const rows = rowsByGroup()[group.key] || [];
    const query = filter().trim().toLowerCase();
    if (!query || !filterable()) return rows;
    return rows.filter((row) =>
      `${row.label} ${row.key} ${row.note || ""}`.toLowerCase().includes(query),
    );
  });

  const editValue = (row) => {
    const current = edits();
    return row.key in current ? current[row.key] : row.effectiveUrl;
  };
  const setEdit = (key, value) => setEdits((prev) => ({ ...prev, [key]: value }));
  const markBusy = (key, value) => setBusy((prev) => ({ ...prev, [key]: value }));

  async function saveUrl(row, explicitValue) {
    const value =
      explicitValue !== undefined ? explicitValue : String(editValue(row) || "").trim();
    markBusy(row.key, true);
    try {
      await postJson("/api/admin/providers/set", { key: row.key, value });
      flash(value ? `Saved ${row.label}` : `Reset ${row.label} to default`);
      await load();
    } catch (e) {
      flash(e.message || "Save failed", true);
    } finally {
      markBusy(row.key, false);
    }
  }

  // Embed rank overrides live under `embed:<id>:rank` (the row key is the sibling
  // `:enabled` flag), so derive one from the other.
  const rankKey = (row) => row.key.replace(/:enabled$/, ":rank");
  const rankEditValue = (row) => {
    const current = rankEdits();
    return row.key in current ? current[row.key] : row.rank ?? "";
  };
  const setRankEdit = (key, value) => setRankEdits((prev) => ({ ...prev, [key]: value }));

  async function saveRank(row, explicitValue) {
    const value =
      explicitValue !== undefined ? explicitValue : String(rankEditValue(row) ?? "").trim();
    markBusy(row.key, true);
    try {
      await postJson("/api/admin/providers/set", { key: rankKey(row), value });
      flash(value === "" ? `Reset ${row.label} rank to default` : `Saved ${row.label} rank`);
      await load();
    } catch (e) {
      flash(e.message || "Save failed", true);
    } finally {
      markBusy(row.key, false);
    }
  }

  // Reorder by swapping a provider's weight with its neighbour's, so the move is
  // exactly one position and the displayed order updates predictably.
  async function moveRank(row, dir) {
    const list = rowsByGroup().embed || [];
    const i = list.findIndex((r) => r.key === row.key);
    const j = dir === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= list.length) return;
    const neighbor = list[j];
    let self;
    let other;
    if (row.rank === neighbor.rank) {
      // Equal weights: nudge past the neighbour to force the swap.
      self = dir === "up" ? neighbor.rank + 1 : neighbor.rank - 1;
      other = neighbor.rank;
    } else {
      self = neighbor.rank;
      other = row.rank;
    }
    markBusy(row.key, true);
    markBusy(neighbor.key, true);
    try {
      await postJson("/api/admin/providers/set", { key: rankKey(row), value: String(self) });
      await postJson("/api/admin/providers/set", { key: rankKey(neighbor), value: String(other) });
      flash(`Moved ${row.label} ${dir}`);
      await load();
    } catch (e) {
      flash(e.message || "Reorder failed", true);
    } finally {
      markBusy(row.key, false);
      markBusy(neighbor.key, false);
    }
  }

  async function toggleEnabled(row) {
    markBusy(row.key, true);
    try {
      await postJson("/api/admin/providers/set", { key: row.key, value: row.enabled ? "0" : "1" });
      flash(`${row.label} ${row.enabled ? "disabled" : "enabled"}`);
      await load();
    } catch (e) {
      flash(e.message || "Update failed", true);
    } finally {
      markBusy(row.key, false);
    }
  }

  // Register a new custom Stremio stream-addon provider from a manifest/install URL.
  async function addProvider(event) {
    event?.preventDefault?.();
    const url = String(newUrl() || "").trim();
    if (!url) return;
    const name = String(newLabel() || "").trim();
    setAdding(true);
    try {
      const data = await postJson("/api/admin/providers/add", {
        url,
        ...(name ? { label: name } : {}),
      });
      flash(`Added ${data.label || "provider"}`);
      setNewUrl("");
      setNewLabel("");
      setSubTab("embed");
      await load();
    } catch (e) {
      flash(e.message || "Add failed", true);
    } finally {
      setAdding(false);
    }
  }

  // Custom providers carry `removable`; their row key is `embed:<id>:enabled`.
  async function removeProvider(row) {
    if (!window.confirm(`Remove ${row.label}? This deletes the custom provider.`)) return;
    const id = row.key.replace(/^embed:/, "").replace(/:enabled$/, "");
    markBusy(row.key, true);
    try {
      await postJson("/api/admin/providers/remove", { id });
      flash(`Removed ${row.label}`);
      await load();
    } catch (e) {
      flash(e.message || "Remove failed", true);
    } finally {
      markBusy(row.key, false);
    }
  }

  async function testRow(row) {
    const url = row.editable ? String(editValue(row) || "").trim() : row.effectiveUrl;
    if (!url) {
      setTests((prev) => ({ ...prev, [row.key]: { ok: false, error: "No URL set" } }));
      return;
    }
    setTests((prev) => ({ ...prev, [row.key]: { pending: true } }));
    try {
      const result = await postJson("/api/admin/providers/test", { url });
      setTests((prev) => ({ ...prev, [row.key]: result }));
    } catch (e) {
      setTests((prev) => ({ ...prev, [row.key]: { ok: false, error: e.message || "Test failed" } }));
    }
  }

  function ProviderRow(props2) {
    const row = props2.row;
    const result = () => tests()[row.key];
    const isBusy = () => Boolean(busy()[row.key]);
    const position = () => props2.index() + 1;
    return (
      <div classList={{ "admin-provider-row": true, "is-off": row.toggle && !row.enabled }}>
        <div class="admin-provider-rowtop">
          <div class="admin-provider-meta">
            <span class="admin-provider-label">
              {row.label}
              <Show when={row.overridden}>
                <span class="admin-provider-tag">overridden</span>
              </Show>
              <Show when={row.rankOverridden}>
                <span class="admin-provider-tag">re-ranked</span>
              </Show>
            </span>
            <span class="admin-provider-key">{row.key}</span>
          </div>
          <Show when={row.toggle}>
            <Toggle
              checked={row.enabled}
              onChange={() => toggleEnabled(row)}
              label={row.enabled ? "Enabled" : "Disabled"}
            />
          </Show>
        </div>

        <Show when={row.rank != null}>
          <div class="admin-rank-row">
            <span class="admin-rank-pos">#{position()}</span>
            <div class="admin-rank-arrows">
              <button
                class="admin-btn admin-rank-arrow"
                disabled={isBusy() || position() === 1}
                title="Move up"
                aria-label={`Move ${row.label} up`}
                onClick={() => moveRank(row, "up")}
              >
                ↑
              </button>
              <button
                class="admin-btn admin-rank-arrow"
                disabled={isBusy() || position() === embedCount()}
                title="Move down"
                aria-label={`Move ${row.label} down`}
                onClick={() => moveRank(row, "down")}
              >
                ↓
              </button>
            </div>
            <label class="admin-rank-weight">
              <span class="admin-rank-weight-cap">Weight</span>
              <input
                class="admin-input admin-rank-input"
                type="number"
                min="0"
                max="10000"
                step="10"
                value={rankEditValue(row)}
                onInput={(e) => setRankEdit(row.key, e.currentTarget.value)}
              />
            </label>
            <button class="admin-btn is-primary" disabled={isBusy()} onClick={() => saveRank(row)}>
              Save
            </button>
            <Show when={row.rankOverridden}>
              <button class="admin-btn" disabled={isBusy()} onClick={() => saveRank(row, "")}>
                Reset
              </button>
            </Show>
            <span class="admin-rank-default">default {row.rankDefault}</span>
          </div>
        </Show>

        <Show
          when={row.editable}
          fallback={<div class="admin-provider-url-readonly">{row.effectiveUrl || "—"}</div>}
        >
          <input
            class="admin-input admin-provider-input"
            type="text"
            spellcheck={false}
            autocomplete="off"
            value={editValue(row)}
            placeholder={row.defaultUrl || "https://…"}
            onInput={(e) => setEdit(row.key, e.currentTarget.value)}
          />
        </Show>

        <div class="admin-provider-actions">
          <button class="admin-btn" disabled={isBusy() || result()?.pending} onClick={() => testRow(row)}>
            {result()?.pending ? "Testing…" : "Test"}
          </button>
          <Show when={row.editable}>
            <button class="admin-btn is-primary" disabled={isBusy()} onClick={() => saveUrl(row)}>
              Save
            </button>
            <Show when={row.overridden}>
              <button class="admin-btn" disabled={isBusy()} onClick={() => saveUrl(row, "")}>
                Reset
              </button>
            </Show>
          </Show>
          <Show when={row.removable}>
            <button
              class="admin-btn"
              disabled={isBusy()}
              title="Delete this custom provider"
              onClick={() => removeProvider(row)}
            >
              Remove
            </button>
          </Show>
          <Show when={result() && !result().pending}>
            <span
              classList={{
                "admin-test-badge": true,
                "is-ok": Boolean(result().ok),
                "is-bad": !result().ok,
              }}
            >
              {result().ok
                ? `OK · ${result().status} · ${result().latencyMs}ms`
                : result().error || `HTTP ${result().status}`}
            </span>
          </Show>
        </div>

        <Show when={row.note}>
          <div class="admin-provider-note">{row.note}</div>
        </Show>
        <Show when={row.editable && row.overridden}>
          <div class="admin-provider-default">default: {row.defaultUrl || "—"}</div>
        </Show>
      </div>
    );
  }

  return (
    <section class="admin-panel">
      <div class="admin-panel-head admin-provider-head">
        <div>
          <h2 class="admin-panel-title">Stream providers</h2>
          <span class="admin-panel-sub">
            View, test &amp; swap source URLs live — changes apply without a redeploy
          </span>
        </div>
        <div class="admin-provider-headactions">
          <Show when={overrideCount()}>
            <span class="admin-provider-tag">{overrideCount()} active override(s)</span>
          </Show>
          <button class="admin-btn" disabled={status() === "loading"} onClick={() => load()}>
            Reload
          </button>
        </div>
      </div>

      <p class="admin-provider-hint">
        “Test” is a reachability probe from the server. Some hosts block non-browser clients or
        geo-gate, so a failure here doesn’t always mean the stream is dead in the app.
      </p>

      <Show when={status() === "error"}>
        <div class="admin-error">Couldn’t load providers: {error()}</div>
      </Show>

      <Show when={status() === "loading" && !providers().length}>
        <p class="admin-provider-empty">Loading providers…</p>
      </Show>

      <Show when={providers().length}>
        <div class="admin-subtabs" role="tablist">
          <For each={tabs()}>
            {(t) => (
              <button
                type="button"
                role="tab"
                aria-selected={subTab() === t.key}
                classList={{ "admin-subtab": true, "is-active": subTab() === t.key }}
                onClick={() => selectTab(t.key)}
              >
                {t.tabLabel}
                <span class="admin-subtab-count">{t.count}</span>
              </button>
            )}
          </For>
        </div>

        <Show when={activeGroup()} keyed>
          {(group) => (
            <div class="admin-provider-group">
              <div class="admin-provider-grouphead">
                <h3 class="admin-provider-grouptitle">{group.title}</h3>
                <span class="admin-provider-groupsub">{group.sub}</span>
              </div>
              <Show when={group.hint}>
                <p class="admin-provider-grouphint">{group.hint}</p>
              </Show>
              <Show when={group.key === "embed"}>
                <form
                  class="admin-provider-add"
                  style={{ display: "flex", gap: "8px", "flex-wrap": "wrap", "margin-bottom": "14px" }}
                  onSubmit={addProvider}
                >
                  <input
                    class="admin-input"
                    style={{ flex: "1 1 320px" }}
                    type="text"
                    spellcheck={false}
                    autocomplete="off"
                    placeholder="Stremio stream-addon URL (https://…/manifest.json)"
                    value={newUrl()}
                    onInput={(e) => setNewUrl(e.currentTarget.value)}
                  />
                  <input
                    class="admin-input"
                    style={{ flex: "0 1 180px" }}
                    type="text"
                    spellcheck={false}
                    autocomplete="off"
                    placeholder="Name (optional)"
                    value={newLabel()}
                    onInput={(e) => setNewLabel(e.currentTarget.value)}
                  />
                  <button
                    class="admin-btn is-primary"
                    type="submit"
                    disabled={adding() || !newUrl().trim()}
                  >
                    {adding() ? "Adding…" : "Add provider"}
                  </button>
                </form>
              </Show>
              <Show when={filterable()}>
                <input
                  class="admin-input admin-provider-filter"
                  type="search"
                  spellcheck={false}
                  autocomplete="off"
                  placeholder={`Filter ${group.tabLabel.toLowerCase()}…`}
                  value={filter()}
                  onInput={(e) => setFilter(e.currentTarget.value)}
                />
              </Show>
              <Show
                when={visibleRows().length}
                fallback={<p class="admin-provider-empty">No matches for “{filter()}”.</p>}
              >
                <div class="admin-provider-list">
                  <For each={visibleRows()}>
                    {(row, index) => <ProviderRow row={row} index={index} />}
                  </For>
                </div>
              </Show>
            </div>
          )}
        </Show>
      </Show>
    </section>
  );
}

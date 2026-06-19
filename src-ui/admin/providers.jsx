import { createMemo, createSignal, For, onMount, Show } from "solid-js";

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

// Group order + headings. The "live" rows are derived on the client from the
// compiled channel list (the backend only stores their overrides); the rest come
// straight from the backend catalog.
const GROUPS = [
  {
    key: "live",
    title: "Live TV channels",
    sub: "Direct HLS / embed source per channel stream",
  },
  { key: "sports", title: "Sports stream APIs", sub: "Match discovery & schedule endpoints" },
  {
    key: "embed",
    title: "VOD embed providers",
    sub: "Enable or disable external movie / show sources",
  },
  { key: "infra", title: "Infrastructure", sub: "App origin & upstream bases" },
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
  const [tests, setTests] = createSignal({});
  const [busy, setBusy] = createSignal({});

  const flash = (text, isError = false) => props.onFlash && props.onFlash(text, isError);

  async function load() {
    setStatus("loading");
    setError("");
    try {
      const data = await getJson("/api/admin/providers");
      setProviders(data.providers || []);
      setLiveOverrides(data.liveOverrides || {});
      setEdits({});
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
    return map;
  });

  const overrideCount = createMemo(() => {
    let count = Object.keys(liveOverrides()).length;
    for (const provider of providers()) {
      if (provider.overridden) count += 1;
    }
    return count;
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
    return (
      <div classList={{ "admin-provider-row": true, "is-off": row.toggle && !row.enabled }}>
        <div class="admin-provider-rowtop">
          <div class="admin-provider-meta">
            <span class="admin-provider-label">
              {row.label}
              <Show when={row.overridden}>
                <span class="admin-provider-tag">overridden</span>
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

      <Show when={status() !== "error"}>
        <For each={GROUPS}>
          {(group) => (
            <Show when={(rowsByGroup()[group.key] || []).length}>
              <div class="admin-provider-group">
                <div class="admin-provider-grouphead">
                  <h3 class="admin-provider-grouptitle">{group.title}</h3>
                  <span class="admin-provider-groupsub">{group.sub}</span>
                </div>
                <div class="admin-provider-list">
                  <For each={rowsByGroup()[group.key]}>{(row) => <ProviderRow row={row} />}</For>
                </div>
              </div>
            </Show>
          )}
        </For>
      </Show>
    </section>
  );
}

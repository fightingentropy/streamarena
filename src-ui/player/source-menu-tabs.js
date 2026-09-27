import {
  getSourceDisplayHint,
  getSourceDisplayMeta,
  getSourceDisplayName,
  isSourceOptionEmbed,
  normalizeSourceHash,
  parseSourceOptionVerticalResolution,
} from "./sources.js";

export const SOURCE_MENU_HLS_TAB = "hls";
export const SOURCE_MENU_TORRENTS_TAB = "torrents";

function getSourceMenuTab(option) {
  return isSourceOptionEmbed(option)
    ? SOURCE_MENU_HLS_TAB
    : SOURCE_MENU_TORRENTS_TAB;
}

export function buildSourceMenuView({
  sources = [],
  selectedSourceHash = "",
  requestedTab = "",
  torrentsEnabled = false,
} = {}) {
  const safeSources = Array.isArray(sources) ? sources : [];
  const selectedHash = normalizeSourceHash(selectedSourceHash);
  const selectedSource = safeSources.find(
    (source) =>
      normalizeSourceHash(source?.sourceHash || source?.infoHash || "") ===
      selectedHash,
  );
  const fallbackTab = selectedSource
    ? getSourceMenuTab(selectedSource)
    : safeSources.some((source) => isSourceOptionEmbed(source))
      ? SOURCE_MENU_HLS_TAB
      : SOURCE_MENU_TORRENTS_TAB;
  const activeTab =
    requestedTab === SOURCE_MENU_HLS_TAB ||
    requestedTab === SOURCE_MENU_TORRENTS_TAB
      ? requestedTab
      : safeSources.length > 0
        ? fallbackTab
        : "";
  const counts = safeSources.reduce(
    (result, source) => {
      result[getSourceMenuTab(source)] += 1;
      return result;
    },
    { [SOURCE_MENU_HLS_TAB]: 0, [SOURCE_MENU_TORRENTS_TAB]: 0 },
  );
  const showTabs = Boolean(torrentsEnabled);
  return {
    activeTab,
    counts,
    showTabs,
    sources: showTabs
      ? safeSources.filter((source) => getSourceMenuTab(source) === activeTab)
      : safeSources,
    emptyMessage:
      activeTab === SOURCE_MENU_TORRENTS_TAB
        ? "No torrent sources available."
        : "No HLS sources available.",
  };
}

export function syncSourceMenuTabs(tabList, view) {
  if (!(tabList instanceof HTMLElement)) return;
  tabList.hidden = !view.showTabs;
  tabList.querySelectorAll("[data-source-tab]").forEach((button) => {
    const tab = String(button.dataset.sourceTab || "");
    const selected = tab === view.activeTab;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
    button.tabIndex = selected ? 0 : -1;
    const count = view.counts[tab] || 0;
    button.dataset.count = String(count);
    button.setAttribute("aria-label", `${tab === SOURCE_MENU_HLS_TAB ? "Streaming" : "Torrents"}, ${count} ${count === 1 ? "source" : "sources"}`);
  });
}

const SOURCE_OPTION_DOWNLOAD_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 3v12"></path>
  <path d="M7 11l5 5 5-5"></path>
  <path d="M5 21h14"></path>
</svg>`;

// HLS provider/container labels describe the delivery plumbing, not quality.
// Only show resolution when the source actually supplies that metadata.
export function getSourceMenuHint(option) {
  if (!isSourceOptionEmbed(option)) {
    return [getSourceDisplayHint(option), getSourceDisplayMeta(option)]
      .filter(Boolean).join(" · ");
  }
  const resolution = parseSourceOptionVerticalResolution(option);
  return resolution ? `${resolution}p` : "";
}

export function syncSourceOptionState(button, { selected, loading }) {
  button.classList.toggle("is-loading", loading);
  button.setAttribute("aria-pressed", selected && !loading ? "true" : "false");
  button.setAttribute("aria-busy", loading ? "true" : "false");
  const state = button.querySelector(".source-option-state");
  if (state) {
    state.hidden = !loading && !selected;
    state.textContent = loading ? "Connecting…" : "Selected";
  }
}

export function createSourceOptionButton({
  option,
  selectedSourceHash,
  sourceHash,
  loadingSourceHash = "",
}) {
  const button = document.createElement("button");
  button.className = "source-option";
  button.type = "button";
  button.dataset.sourceHash = sourceHash;
  button.setAttribute("aria-label", `Play from ${getSourceDisplayName(option)}`);

  const textWrap = document.createElement("span");
  textWrap.className = "source-option-text";
  const nameLine = document.createElement("span");
  nameLine.className = "source-option-name";
  nameLine.textContent = getSourceDisplayName(option);
  textWrap.appendChild(nameLine);

  const hint = getSourceMenuHint(option);
  if (hint) {
    const line = document.createElement("span");
    line.className = "source-option-hint";
    line.id = `source-hint-${sourceHash}`;
    line.textContent = hint;
    button.setAttribute("aria-describedby", line.id);
    textWrap.appendChild(line);
  }
  const state = document.createElement("span");
  state.className = "source-option-state";
  textWrap.appendChild(state);

  const status = document.createElement("span");
  status.className = "source-option-status";
  status.setAttribute("aria-hidden", "true");
  status.innerHTML = `<svg class="source-option-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4 10-10" /></svg>`;
  const spinner = document.createElement("span");
  spinner.className = "source-option-spinner";
  status.appendChild(spinner);

  button.append(status, textWrap);
  syncSourceOptionState(button, {
    selected: sourceHash === selectedSourceHash,
    loading: Boolean(loadingSourceHash) && sourceHash === loadingSourceHash,
  });

  const downloadButton = document.createElement("button");
  downloadButton.className = "source-option-download";
  downloadButton.type = "button";
  downloadButton.dataset.sourceHash = sourceHash;
  const downloadLabel = `Download ${getSourceDisplayName(option)}`;
  downloadButton.dataset.downloadLabel = downloadLabel;
  downloadButton.setAttribute("aria-label", downloadLabel);
  downloadButton.title = "Download MP4";
  const downloadIcon = document.createElement("span");
  downloadIcon.className = "source-option-download-icon";
  downloadIcon.setAttribute("aria-hidden", "true");
  downloadIcon.innerHTML = SOURCE_OPTION_DOWNLOAD_ICON_SVG;
  const downloadSpinner = document.createElement("span");
  downloadSpinner.className = "source-option-spinner";
  downloadSpinner.setAttribute("aria-hidden", "true");
  const downloadText = document.createElement("span");
  downloadText.className = "source-option-download-label";
  downloadText.textContent = "Download";
  downloadButton.append(downloadIcon, downloadSpinner, downloadText);

  const row = document.createElement("div");
  row.className = "source-option-row";
  row.setAttribute("role", "listitem");
  row.append(button, downloadButton);
  return row;
}

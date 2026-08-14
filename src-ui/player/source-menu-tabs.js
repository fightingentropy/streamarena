import {
  getSourceDisplayHint,
  getSourceDisplayMeta,
  getSourceDisplayName,
  isSourceOptionEmbed,
  normalizeSourceHash,
} from "./sources.js";

export const SOURCE_MENU_HLS_TAB = "hls";
export const SOURCE_MENU_TORRENTS_TAB = "torrents";

export function shouldIgnoreRememberedTorrentSource(
  shouldResumePlayback = false,
  torrentProviderEnabled = false,
) {
  return !shouldResumePlayback || !torrentProviderEnabled;
}

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
      : fallbackTab;
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
    button.dataset.count = String(view.counts[tab] || 0);
  });
}

const SOURCE_OPTION_DOWNLOAD_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 3v12"></path>
  <path d="M7 11l5 5 5-5"></path>
  <path d="M5 21h14"></path>
</svg>`;

export function createSourceOptionButton({
  iconSvg,
  option,
  selectedSourceHash,
  sourceHash,
  loadingSourceHash = "",
  downloadingSourceHash = "",
}) {
  const button = document.createElement("button");
  button.className = "audio-option source-option";
  button.type = "button";
  button.setAttribute("role", "option");
  button.dataset.sourceHash = sourceHash;
  const isLoading =
    Boolean(loadingSourceHash) && sourceHash === loadingSourceHash;
  button.classList.toggle("is-loading", isLoading);
  button.setAttribute(
    "aria-selected",
    !isLoading && sourceHash === selectedSourceHash ? "true" : "false",
  );
  button.setAttribute("aria-busy", isLoading ? "true" : "false");

  const iconBadge = document.createElement("span");
  iconBadge.className = "source-option-icon";
  iconBadge.setAttribute("aria-hidden", "true");
  iconBadge.innerHTML = iconSvg;

  const textWrap = document.createElement("span");
  textWrap.className = "source-option-text";
  const nameLine = document.createElement("span");
  nameLine.className = "source-option-name";
  nameLine.textContent = getSourceDisplayName(option);
  textWrap.appendChild(nameLine);

  [
    ["source-option-hint", getSourceDisplayHint(option)],
    ["source-option-meta", getSourceDisplayMeta(option)],
  ].forEach(([className, text]) => {
    if (!text) return;
    const line = document.createElement("span");
    line.className = className;
    line.textContent = text;
    textWrap.appendChild(line);
  });

  const status = document.createElement("span");
  status.className = "source-option-status";
  status.setAttribute("aria-hidden", "true");
  const spinner = document.createElement("span");
  spinner.className = "source-option-spinner";
  status.appendChild(spinner);

  button.append(iconBadge, textWrap, status);

  const downloadButton = document.createElement("button");
  downloadButton.className = "source-option-download";
  downloadButton.type = "button";
  downloadButton.dataset.sourceHash = sourceHash;
  const downloadLabel = `Download ${getSourceDisplayName(option)}`;
  downloadButton.dataset.downloadLabel = downloadLabel;
  const isDownloading =
    Boolean(downloadingSourceHash) && sourceHash === downloadingSourceHash;
  downloadButton.classList.toggle("is-loading", isDownloading);
  downloadButton.disabled = Boolean(downloadingSourceHash);
  downloadButton.setAttribute("aria-busy", isDownloading ? "true" : "false");
  downloadButton.setAttribute(
    "aria-label",
    isDownloading ? "Preparing download" : downloadLabel,
  );
  downloadButton.title = isDownloading ? "Preparing download" : "Download";
  const downloadIcon = document.createElement("span");
  downloadIcon.className = "source-option-download-icon";
  downloadIcon.setAttribute("aria-hidden", "true");
  downloadIcon.innerHTML = SOURCE_OPTION_DOWNLOAD_ICON_SVG;
  const downloadSpinner = document.createElement("span");
  downloadSpinner.className = "source-option-spinner";
  downloadSpinner.setAttribute("aria-hidden", "true");
  downloadButton.append(downloadIcon, downloadSpinner);

  const row = document.createElement("div");
  row.className = "source-option-row";
  row.append(button, downloadButton);
  return row;
}

const DEFAULT_HLS_QUALITY_PREFERENCE_STORAGE_KEY = "netflix-hls-quality-pref";

export function normalizeHlsQualityPreference(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized || normalized === "auto") {
    return "auto";
  }
  const match = normalized.match(/^(\d{3,4})p?$/);
  if (!match) {
    return "auto";
  }
  const height = Number(match[1]);
  return Number.isFinite(height) && height > 0 ? `${Math.floor(height)}p` : "auto";
}

function readStoredHlsQualityPreference(storageKey) {
  try {
    return normalizeHlsQualityPreference(localStorage.getItem(storageKey));
  } catch {
    return "auto";
  }
}

function formatHlsQualityLabel(level) {
  const height = Number(level?.height || 0);
  if (Number.isFinite(height) && height > 0) {
    return `${Math.floor(height)}p`;
  }
  const name = String(level?.name || "").trim();
  if (name) {
    return name;
  }
  const width = Number(level?.width || 0);
  if (Number.isFinite(width) && width > 0) {
    return `${Math.floor(width)}w`;
  }
  return `Level ${Number(level?.index || 0) + 1}`;
}

function formatHlsQualityMeta(level) {
  const bitrate = Number(level?.bitrate || 0);
  if (!Number.isFinite(bitrate) || bitrate <= 0) {
    return "";
  }
  if (bitrate >= 1_000_000) {
    return `${(bitrate / 1_000_000).toFixed(bitrate >= 10_000_000 ? 0 : 1)} Mbps`;
  }
  return `${Math.round(bitrate / 1000)} Kbps`;
}

function getHlsQualityPreferenceForLevel(level) {
  const height = Number(level?.height || 0);
  if (Number.isFinite(height) && height > 0) {
    return `${Math.floor(height)}p`;
  }
  return "auto";
}

function appendHlsQualityOptionContent(documentRef, button, primary, secondary = "") {
  const name = documentRef.createElement("span");
  name.className = "hls-quality-option-name";
  name.textContent = primary;
  button.appendChild(name);

  if (secondary) {
    const meta = documentRef.createElement("span");
    meta.className = "hls-quality-option-meta";
    meta.textContent = secondary;
    button.appendChild(meta);
  }
}

export function createHlsQualityControls({
  storageKey = DEFAULT_HLS_QUALITY_PREFERENCE_STORAGE_KEY,
  getElements = () => ({}),
  isLiveIframePlaybackActive = () => false,
  closePopover = () => {},
  setQualityLevel = () => false,
} = {}) {
  let qualityPreference = readStoredHlsQualityPreference(storageKey);
  let qualityLevels = [];
  let selectedQualityLevel = -1;
  let activeQualityLevel = -1;

  function persistPreference(value) {
    const normalized = normalizeHlsQualityPreference(value);
    qualityPreference = normalized;
    try {
      localStorage.setItem(storageKey, normalized);
    } catch {
      // Ignore storage access issues.
    }
  }

  function getPreferenceHeight(value = qualityPreference) {
    const match = normalizeHlsQualityPreference(value).match(/^(\d{3,4})p$/);
    if (!match) {
      return 0;
    }
    const height = Number(match[1]);
    return Number.isFinite(height) && height > 0 ? Math.floor(height) : 0;
  }

  function getSortedLevels(levels = qualityLevels) {
    return [...levels].sort((left, right) => {
      const leftHeight = Number(left?.height || 0);
      const rightHeight = Number(right?.height || 0);
      if (leftHeight !== rightHeight) {
        return rightHeight - leftHeight;
      }
      const leftBitrate = Number(left?.bitrate || 0);
      const rightBitrate = Number(right?.bitrate || 0);
      if (leftBitrate !== rightBitrate) {
        return rightBitrate - leftBitrate;
      }
      return Number(left?.index || 0) - Number(right?.index || 0);
    });
  }

  function pickPreferredQualityLevel(levels = []) {
    const targetHeight = getPreferenceHeight();
    if (!targetHeight || !Array.isArray(levels) || !levels.length) {
      return -1;
    }
    const matches = levels
      .filter((level) => Number(level?.height || 0) === targetHeight)
      .sort((left, right) => Number(right?.bitrate || 0) - Number(left?.bitrate || 0));
    return Number(matches[0]?.index ?? -1);
  }

  function getLevelByIndex(levelIndex) {
    const normalized = Number(levelIndex);
    if (!Number.isFinite(normalized) || normalized < 0) {
      return null;
    }
    return (
      qualityLevels.find((level) => Number(level?.index) === Math.floor(normalized)) ||
      null
    );
  }

  function getCurrentLabel() {
    const selectedLevel = getLevelByIndex(selectedQualityLevel);
    if (selectedLevel) {
      return formatHlsQualityLabel(selectedLevel);
    }
    const activeLevel = getLevelByIndex(activeQualityLevel);
    return activeLevel ? `Auto (${formatHlsQualityLabel(activeLevel)})` : "Auto";
  }

  function shouldShowControl() {
    return Boolean(qualityLevels.length > 1 && !isLiveIframePlaybackActive());
  }

  function syncControls() {
    const {
      control,
      toggle,
      menu,
      optionsContainer,
    } = getElements();
    const shouldShow = shouldShowControl();
    if (control) {
      control.hidden = !shouldShow;
      if (!shouldShow) {
        closePopover(false, { force: true });
      }
    }

    const accessibleLabel = `Quality (${getCurrentLabel()})`;
    toggle?.setAttribute("aria-label", accessibleLabel);
    toggle?.setAttribute("title", accessibleLabel);
    menu?.setAttribute("aria-label", accessibleLabel);

    if (optionsContainer) {
      Array.from(optionsContainer.querySelectorAll(".hls-quality-option")).forEach(
        (option) => {
          const rawLevel = option.dataset.levelIndex || "auto";
          const isAuto = rawLevel === "auto";
          const isSelected = isAuto
            ? selectedQualityLevel < 0
            : Number(rawLevel) === selectedQualityLevel;
          option.setAttribute("aria-selected", isSelected ? "true" : "false");
        },
      );
    }
  }

  function renderOptions() {
    const { optionsContainer } = getElements();
    if (!(optionsContainer instanceof HTMLElement)) {
      return;
    }

    const documentRef = optionsContainer.ownerDocument || document;
    optionsContainer.innerHTML = "";
    const activeLevel = getLevelByIndex(activeQualityLevel);
    const autoButton = documentRef.createElement("button");
    autoButton.className = "audio-option hls-quality-option";
    autoButton.type = "button";
    autoButton.setAttribute("role", "option");
    autoButton.dataset.levelIndex = "auto";
    appendHlsQualityOptionContent(
      documentRef,
      autoButton,
      "Auto",
      activeLevel ? `Currently ${formatHlsQualityLabel(activeLevel)}` : "Adaptive",
    );
    optionsContainer.appendChild(autoButton);

    getSortedLevels().forEach((level) => {
      const button = documentRef.createElement("button");
      button.className = "audio-option hls-quality-option";
      button.type = "button";
      button.setAttribute("role", "option");
      button.dataset.levelIndex = String(level.index);
      button.dataset.qualityPreference = getHlsQualityPreferenceForLevel(level);
      appendHlsQualityOptionContent(
        documentRef,
        button,
        formatHlsQualityLabel(level),
        formatHlsQualityMeta(level),
      );
      optionsContainer.appendChild(button);
    });

    syncControls();
  }

  function handleLevelsChanged({
    levels = [],
    selectedLevel = -1,
    activeLevel = -1,
  } = {}) {
    qualityLevels = Array.isArray(levels) ? levels : [];
    selectedQualityLevel = Number.isFinite(Number(selectedLevel))
      ? Math.floor(Number(selectedLevel))
      : -1;
    activeQualityLevel = Number.isFinite(Number(activeLevel))
      ? Math.floor(Number(activeLevel))
      : -1;
    renderOptions();
    syncControls();
  }

  function selectLevel(levelIndex) {
    const normalizedLevelIndex =
      levelIndex === "auto" ? -1 : Number(levelIndex);
    const nextLevel =
      Number.isFinite(normalizedLevelIndex) && normalizedLevelIndex >= 0
        ? Math.floor(normalizedLevelIndex)
        : -1;
    const level = getLevelByIndex(nextLevel);
    persistPreference(level ? getHlsQualityPreferenceForLevel(level) : "auto");
    if (setQualityLevel(nextLevel)) {
      selectedQualityLevel = nextLevel;
    }
    renderOptions();
    syncControls();
  }

  return {
    handleLevelsChanged,
    pickPreferredQualityLevel,
    renderOptions,
    selectLevel,
    shouldShowControl,
    syncControls,
  };
}

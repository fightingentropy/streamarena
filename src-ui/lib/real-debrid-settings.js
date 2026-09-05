function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

export function normalizeRealDebridSettings(payload = {}) {
  const configured = Boolean(payload?.configured);
  const hasExplicitEnabled = hasOwn(payload, "enabled") ||
    hasOwn(payload, "realDebridEnabled");
  const explicitEnabled = hasOwn(payload, "enabled")
    ? payload.enabled
    : payload.realDebridEnabled;
  const enabled = configured && (
    hasExplicitEnabled ? Boolean(explicitEnabled) : true
  );

  return {
    configured,
    enabled,
    active: configured && enabled,
    maskedApiKey: String(payload?.maskedApiKey || ""),
    localTorrentEnabled: Boolean(payload?.localTorrentEnabled),
  };
}

export function buildRealDebridSettingsUpdate({
  apiKey = "",
  apiKeyDirty = false,
  enabled = false,
  enabledDirty = false,
  localTorrentEnabled = false,
  localTorrentDirty = false,
} = {}) {
  const body = {};
  const normalizedApiKey = String(apiKey || "").trim();
  if (apiKeyDirty && normalizedApiKey) {
    body.apiKey = normalizedApiKey;
  }
  if (enabledDirty || apiKeyDirty) {
    body.realDebridEnabled = Boolean(enabled);
  }
  if (localTorrentDirty) {
    body.localTorrentEnabled = Boolean(localTorrentEnabled);
  }
  return body;
}

export function pickTorrentResolverProvider({
  currentProvider = "fastest",
  isEmbed = false,
  realDebridActive = false,
  localTorrentEnabled = false,
} = {}) {
  if (isEmbed) {
    return String(currentProvider || "fastest");
  }
  if (realDebridActive && localTorrentEnabled) {
    // The backend's fastest policy tries Real-Debrid first for the required
    // hash, then falls back to the local engine if RD is unavailable/uncached.
    return "fastest";
  }
  if (realDebridActive) {
    return "real-debrid";
  }
  if (localTorrentEnabled) {
    return "local-torrent";
  }
  return String(currentProvider || "fastest");
}

export function resolveTorrentRequestProvider({
  currentProvider = "fastest",
  skipExternalEmbed = false,
  realDebridActive = false,
  localTorrentEnabled = false,
} = {}) {
  const provider = String(currentProvider || "fastest");
  if (
    provider === "fastest" &&
    skipExternalEmbed &&
    localTorrentEnabled &&
    !realDebridActive
  ) {
    return "local-torrent";
  }
  return provider;
}

export function shouldFallbackAutomaticTorrentResolveToExternal({
  skipExternalEmbed = false,
  resolverProvider = "fastest",
  sourceHash = "",
} = {}) {
  return Boolean(
    skipExternalEmbed &&
      String(resolverProvider || "fastest").trim().toLowerCase() === "fastest" &&
      !String(sourceHash || "").trim()
  );
}

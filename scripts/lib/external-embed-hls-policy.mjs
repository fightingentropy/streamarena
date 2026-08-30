export const EMBED_SUPPORT_RESOURCE_TYPES = new Set([
  "document",
  "script",
  "xhr",
  "fetch",
  "stylesheet",
  "websocket",
]);

export function isEmbedSupportResourceType(resourceType) {
  return EMBED_SUPPORT_RESOURCE_TYPES.has(resourceType);
}

export function isPublicHlsHostname(value) {
  const host = String(value || "")
    .trim()
    .replace(/\.$/, "")
    .toLowerCase();
  if (
    !host ||
    host.includes(":") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    isIpv4Hostname(host)
  ) {
    return false;
  }
  return (
    host.includes(".") &&
    !host.startsWith(".") &&
    !host.endsWith(".") &&
    !host.includes("..") &&
    /^[a-z0-9.-]+$/.test(host)
  );
}

function isIpv4Hostname(host) {
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  );
}

export function isStreamPlaylistUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      isPublicHlsHostname(url.hostname) &&
      url.pathname.toLowerCase().endsWith(".m3u8")
    );
  } catch {
    return false;
  }
}

export function isKnownEmbedProviderHost(host) {
  const normalized = String(host || "").toLowerCase();
  return (
    normalized === "videasy.net" ||
    normalized.endsWith(".videasy.net") ||
    normalized === "videasy.to" ||
    normalized.endsWith(".videasy.to") ||
    normalized === "vidlink.pro" ||
    normalized.endsWith(".vidlink.pro") ||
    normalized === "speedracelight.com" ||
    normalized.endsWith(".speedracelight.com") ||
    normalized === "storm.vodvidl.site" ||
    normalized === "easy.speedsterwave.app" ||
    normalized === "easy.nightspeedster.app" ||
    normalized === "hello.mousedoor.com" ||
    normalized === "yoru.midwesteagle.com" ||
    normalized === "typhoontigertribe.net"
  );
}

export function shouldAbortEmbedRequest(requestUrl, resourceType) {
  return (
    resourceType === "image" ||
    resourceType === "font" ||
    (resourceType === "media" && !isStreamPlaylistUrl(requestUrl))
  );
}

export function shouldAllowEmbedRequest(requestUrl, resourceType) {
  if (isStreamPlaylistUrl(requestUrl)) {
    return true;
  }
  if (shouldAbortEmbedRequest(requestUrl, resourceType)) {
    return false;
  }
  if (!isEmbedSupportResourceType(resourceType)) {
    return false;
  }
  if (requestUrl.startsWith("blob:")) {
    return true;
  }
  try {
    const url = new URL(requestUrl);
    if (url.protocol !== "https:" && url.protocol !== "wss:") {
      return false;
    }
    const host = url.hostname.toLowerCase();
    return isKnownEmbedProviderHost(host) || isPublicHlsHostname(host);
  } catch {
    return false;
  }
}

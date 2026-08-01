import { isPublicHlsProxyHostname } from "./authorization.js";

const ORIGIN_DIRECT_SOFT_DEADLINE_MS = 2_500;
const ORIGIN_DIRECT_COOLDOWN_MS = 30_000;
let directOriginTrippedUntil = 0;

export function normalizeOriginBase(raw, { allowHttp = false } = {}) {
  let url;
  try {
    url = new URL(String(raw || "").trim());
  } catch {
    return "";
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) return "";
  if (url.username || url.password || url.search || url.hash) return "";
  if (url.pathname !== "/") return "";
  if (!isPublicHlsProxyHostname(url.hostname)) return "";
  return url.origin;
}

function originSubrequest(base, path, search, requestHeaders, cacheTtl, signal) {
  const originUrl = `${base}${path}${search}`;
  const headers = { Accept: "*/*", "X-Live-Worker-Origin-Fetch": "1" };
  const range = requestHeaders.get("Range");
  if (range) headers.Range = range;
  const init = {
    method: "GET",
    headers,
    redirect: "manual",
    cf: { cacheTtl, cacheEverything: true, cacheKey: originUrl },
  };
  if (signal) init.signal = signal;
  return fetch(originUrl, init);
}

export function fetchFromOrigin(env, path, search, requestHeaders, cacheTtl) {
  const direct = normalizeOriginBase(env.ORIGIN_DIRECT_BASE, { allowHttp: true });
  const edge = normalizeOriginBase(env.ORIGIN_BASE);
  const primary = direct || edge;
  if (!primary) return null;
  if (!direct || !edge || direct === edge) {
    return originSubrequest(primary, path, search, requestHeaders, cacheTtl);
  }
  if (Date.now() < directOriginTrippedUntil) {
    return originSubrequest(edge, path, search, requestHeaders, cacheTtl);
  }

  return (async () => {
    const controller = new AbortController();
    let deadlineTimer;
    const softDeadline = new Promise((resolve) => {
      deadlineTimer = setTimeout(() => resolve("slow"), ORIGIN_DIRECT_SOFT_DEADLINE_MS);
    });
    const directAttempt = originSubrequest(
      direct,
      path,
      search,
      requestHeaders,
      cacheTtl,
      controller.signal,
    )
      .then((response) => ({ response }))
      .catch((error) => ({ error }));
    const settled = await Promise.race([directAttempt, softDeadline]);
    clearTimeout(deadlineTimer);
    if (settled !== "slow") {
      if (settled.response && settled.response.status < 500) {
        directOriginTrippedUntil = 0;
        return settled.response;
      }
      directOriginTrippedUntil = Date.now() + ORIGIN_DIRECT_COOLDOWN_MS;
      return originSubrequest(edge, path, search, requestHeaders, cacheTtl);
    }
    directOriginTrippedUntil = Date.now() + ORIGIN_DIRECT_COOLDOWN_MS;
    controller.abort();
    return originSubrequest(edge, path, search, requestHeaders, cacheTtl);
  })();
}

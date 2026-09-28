// Fetch exceptions may contain signed URLs or provider credentials. Emit only
// fixed classifications; never serialize error.message, stack, headers or URL.
export function fetchFailureReason(error) {
  const message = String(error?.message || "");
  if (/cacheKey|cache key.*enterprise/i.test(message)) return "cache_configuration";
  if (/illegal invocation/i.test(message)) return "invalid_invocation";
  if (/unsafe redirect target/i.test(message)) return "unsafe_redirect";
  if (/redirect limit/i.test(message)) return "redirect_limit";
  if (/redirect missing location/i.test(message)) return "redirect_location";
  if (/response body exceeded|safety limits/i.test(message)) return "body_limit";
  if (/tls|ssl|certificate/i.test(message)) return "tls";
  if (/dns|resolve host|name resolution/i.test(message)) return "dns";
  if (error?.name === "AbortError" || /timeout|timed out/i.test(message)) return "timeout";
  return "fetch_failed";
}

export function logProxyFailure(stage, { target, error, status, startedAt } = {}) {
  console.warn(JSON.stringify({
    event: "live_hls_proxy_failure",
    stage,
    ...(target ? { upstreamHost: target.hostname } : {}),
    reason: Number.isInteger(status) ? "http_error" : fetchFailureReason(error),
    ...(Number.isInteger(status) ? { status } : {}),
    ...(Number.isFinite(startedAt) ? { elapsedMs: Math.max(0, Date.now() - startedAt) } : {}),
  }));
}

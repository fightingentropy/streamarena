export function normalizeResumeStartSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 1 ? Math.floor(seconds) : 0;
}

export function withRemuxResumeStart(source, startSeconds, baseUrl) {
  const safeStart = normalizeResumeStartSeconds(startSeconds);
  if (!safeStart) {
    return source;
  }

  try {
    const url = new URL(source, baseUrl);
    if (url.pathname !== "/api/remux") {
      return source;
    }
    url.searchParams.set("start", String(safeStart));
    return `${url.pathname}?${url.searchParams.toString()}`;
  } catch {
    return source;
  }
}

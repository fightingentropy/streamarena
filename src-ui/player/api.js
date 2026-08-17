export async function requestJson(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const externalSignal = options?.signal || null;
  let externalAborted = Boolean(externalSignal?.aborted);
  let timedOut = false;
  const handleExternalAbort = () => {
    externalAborted = true;
    controller.abort();
  };
  if (externalAborted) {
    controller.abort();
  } else if (externalSignal?.addEventListener) {
    externalSignal.addEventListener("abort", handleExternalAbort, { once: true });
  }
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("Request timed out."));
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      fetch(url, {
        ...options,
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);

    if (response.status === 204) {
      return null;
    }

    const rawText = await response.text();
    let payload = null;

    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = {
          message: buildHttpErrorMessage(response, rawText) || rawText,
        };
      }
    }

    if (!response.ok) {
      const message =
        payload?.error ||
        payload?.message ||
        buildHttpErrorMessage(response, rawText) ||
        `Request failed (${response.status})`;
      const error = new Error(message);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      throw error;
    }

    return payload;
  } catch (error) {
    if (externalAborted || externalSignal?.aborted) {
      const abortError = new Error("Request cancelled.");
      abortError.name = "AbortError";
      throw abortError;
    }
    if (
      timedOut ||
      error.name === "AbortError" ||
      error.message === "Request timed out."
    ) {
      throw new Error("Request timed out.");
    }
    throw error;
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
    externalSignal?.removeEventListener?.("abort", handleExternalAbort);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

export function normalizeRequestTimeoutMs(value) {
  const timeoutMs = Number(value);
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : undefined;
}

function buildHttpErrorMessage(response, rawText = "") {
  const status = Number(response?.status || 0);
  const statusText = String(response?.statusText || "").trim();
  const statusLabel = status
    ? `Request failed (${status}${statusText ? ` ${statusText}` : ""}).`
    : "Request failed.";
  const contentType = String(response?.headers?.get?.("content-type") || "")
    .trim()
    .toLowerCase();
  const text = String(rawText || "");
  const looksLikeHtml =
    contentType.includes("text/html") ||
    /^\s*<!doctype\b/i.test(text) ||
    /<html[\s>]/i.test(text);

  if (!looksLikeHtml) {
    return "";
  }

  const normalized = text.toLowerCase();
  if (normalized.includes("cloudflare") && normalized.includes("bad gateway")) {
    return status
      ? `Cloudflare returned ${status}${statusText ? ` ${statusText}` : " Bad Gateway"}.`
      : "Cloudflare returned a bad gateway response.";
  }
  return statusLabel;
}

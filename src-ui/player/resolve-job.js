import { requestJson, sleep } from "./api.js";

export const RESOLVE_JOB_LONG_POLL_MS = 25_000;
export const RESOLVE_JOB_FALLBACK_POLL_MS = 2_000;
const RESOLVE_JOB_REQUEST_GRACE_MS = 5_000;
const RESOLVE_JOB_CANCEL_TIMEOUT_MS = 3_000;

function createResolveAbortError() {
  const error = new Error("Resolve request cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfResolveAborted(signal) {
  if (signal?.aborted) {
    throw createResolveAbortError();
  }
}

function isLongPollTransportError(error) {
  const status = Number(error?.status || 0);
  if (status >= 500 && status <= 599) {
    return true;
  }
  const message = String(error?.message || "").trim().toLowerCase();
  return (
    message.includes("request timed out") ||
    message.includes("failed to fetch") ||
    message.includes("network error") ||
    message.includes("networkerror") ||
    message.includes("load failed")
  );
}

export function isTransientResolveError(error) {
  const status = Number(error?.status || 0);
  if (status === 502 || status === 503 || status === 504) {
    return true;
  }
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("bad gateway") ||
    message.includes("request timed out") ||
    message.includes("real-debrid request timed out") ||
    message.includes("torrentio request failed") ||
    message.includes("selected external hls source is unavailable") ||
    message.includes("external hls sources are unavailable") ||
    message.includes("failed to fetch")
  );
}

function resolveTerminalJobState(status) {
  const state = String(status?.status || "").trim().toLowerCase();
  if (state === "done" && status?.result != null) {
    return { done: true, result: status.result };
  }
  if (state === "error") {
    throw new Error(
      String(status?.error || status?.message || "Unable to resolve this stream."),
    );
  }
  if (state === "cancelled") {
    throw createResolveAbortError();
  }
  return { done: false, result: null };
}

/** Best-effort cancellation. Older servers return 405 and are harmless. */
export async function cancelResolveJob({
  jobId,
  requestJsonFn = requestJson,
} = {}) {
  const normalizedJobId = String(jobId || "").trim();
  if (!normalizedJobId) {
    return false;
  }
  try {
    await requestJsonFn(
      `/api/resolve/job/${encodeURIComponent(normalizedJobId)}`,
      { method: "DELETE", credentials: "same-origin" },
      RESOLVE_JOB_CANCEL_TIMEOUT_MS,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Serialize async resolves around cancellation: C does not enter the backend
 * until the best-effort cancellation request for superseded B has returned.
 */
export function createResolveJobRequestCoordinator({
  cancelResolveJobFn = cancelResolveJob,
} = {}) {
  let activeRequest = null;
  let transition = Promise.resolve();
  let transitionGeneration = 0;

  function enqueueTransition(work) {
    const run = transition.then(work, work);
    transition = run.catch(() => {});
    return run;
  }

  async function cancelCurrentRequest() {
    const request = activeRequest;
    if (!request) {
      return false;
    }
    activeRequest = null;
    request.controller.abort();
    if (!request.jobId && request.registrationPromise) {
      try {
        await request.registrationPromise;
      } catch {
        // If job creation itself failed, there is no known backend work to stop.
      }
    }
    if (request.jobId) {
      await cancelResolveJobFn({ jobId: request.jobId });
    }
    return true;
  }

  function cancelActive() {
    const generation = ++transitionGeneration;
    return enqueueTransition(async () => {
      if (generation !== transitionGeneration) {
        return false;
      }
      return cancelCurrentRequest();
    });
  }

  function begin() {
    const generation = ++transitionGeneration;
    return enqueueTransition(async () => {
      if (generation !== transitionGeneration) {
        throw createResolveAbortError();
      }
      await cancelCurrentRequest();
      if (generation !== transitionGeneration) {
        throw createResolveAbortError();
      }
      const request = {
        controller: new AbortController(),
        jobId: "",
        registrationPromise: null,
      };
      activeRequest = request;
      return {
        signal: request.controller.signal,
        trackStart(startPromise) {
          request.registrationPromise = Promise.resolve(startPromise).then(
            (payload) => {
              request.jobId = String(payload?.jobId || "").trim();
              return payload;
            },
            (error) => {
              throw error;
            },
          );
          return request.registrationPromise;
        },
        setJobId(jobId) {
          request.jobId = String(jobId || "").trim();
        },
        finish() {
          if (activeRequest === request) {
            activeRequest = null;
          }
        },
        isCurrent() {
          return activeRequest === request;
        },
      };
    });
  }

  return { begin, cancelActive };
}

/** Own resolve retry policy and async-job transport outside the player page. */
export function createResolveRequester({
  coordinator,
  requestJsonFn = requestJson,
  waitForResolveJobFn = waitForResolveJob,
  sleepFn = sleep,
  getResolverProvider = () => "",
  registrationTimeoutMs = 5_000,
} = {}) {
  if (!coordinator) {
    throw new Error("Resolve requester requires a job coordinator.");
  }

  let activeInvocation = null;
  let disposed = false;
  let invocationGeneration = 0;

  function invalidateActiveInvocation() {
    const invocation = activeInvocation;
    if (!invocation) {
      return false;
    }
    activeInvocation = null;
    invocation.controller.abort();
    return true;
  }

  async function sleepForRetry(delayMs, signal) {
    throwIfResolveAborted(signal);
    if (!signal?.addEventListener) {
      await sleepFn(delayMs);
      return;
    }
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(createResolveAbortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(sleepFn(delayMs)).then(
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  async function requestAsync(url, timeoutMs, invocationSignal) {
    throwIfResolveAborted(invocationSignal);
    const coordinatedRequest = await coordinator.begin();
    const asyncUrl = String(url || "").includes("?")
      ? `${url}&async=1`
      : `${url}?async=1`;
    try {
      throwIfResolveAborted(invocationSignal);
      // Finish the tiny registration request even after supersession so its
      // backend id can be cancelled before the next resolve is admitted.
      const started = await coordinatedRequest.trackStart(
        requestJsonFn(asyncUrl, {}, registrationTimeoutMs),
      );
      throwIfResolveAborted(invocationSignal);
      if (started?.playableUrl || (started?.sourceHash && !started?.jobId)) {
        return started;
      }
      const jobId = String(started?.jobId || "").trim();
      if (!jobId) {
        throw new Error("Unable to start async resolve.");
      }
      coordinatedRequest.setJobId(jobId);
      return await waitForResolveJobFn({
        jobId,
        timeoutMs,
        signal: coordinatedRequest.signal,
        // The coordinator waits for DELETE before admitting the next resolve.
        cancelOnAbort: false,
      });
    } finally {
      coordinatedRequest.finish();
    }
  }

  async function requestResolveJson(url, timeoutMs) {
    if (disposed) {
      throw createResolveAbortError();
    }
    const generation = ++invocationGeneration;
    const hadActiveInvocation = invalidateActiveInvocation();
    if (hadActiveInvocation) {
      await coordinator.cancelActive();
    }
    if (disposed || generation !== invocationGeneration) {
      throw createResolveAbortError();
    }
    const invocation = { controller: new AbortController() };
    activeInvocation = invocation;
    const { signal } = invocation.controller;
    const provider = String(getResolverProvider() || "").trim();
    const retryDelays = provider === "real-debrid" ? [900, 1800] : [];
    // Only an explicit timeout opts into a server-side async job. Background
    // page-load resolves must stay short so they cannot starve manual sources.
    const hasExplicitTimeout =
      Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0;
    const effectiveTimeoutMs = hasExplicitTimeout
      ? Math.floor(Number(timeoutMs))
      : provider === "real-debrid"
        ? 95_000
        : provider === "local-torrent"
          ? 190_000
          : 50_000;
    const useAsyncResolve = hasExplicitTimeout && effectiveTimeoutMs > 90_000;
    let lastError = null;

    try {
      for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
        throwIfResolveAborted(signal);
        try {
          return useAsyncResolve
            ? await requestAsync(url, effectiveTimeoutMs, signal)
            : await requestJsonFn(url, { signal }, effectiveTimeoutMs);
        } catch (error) {
          if (signal.aborted) {
            throw createResolveAbortError();
          }
          lastError = error;
          if (attempt >= retryDelays.length || !isTransientResolveError(error)) {
            throw error;
          }
          await sleepForRetry(retryDelays[attempt], signal);
        }
      }
      throw lastError || new Error("Unable to resolve this stream.");
    } finally {
      if (activeInvocation === invocation) {
        activeInvocation = null;
      }
    }
  }

  requestResolveJson.cancelActive = async () => {
    invocationGeneration += 1;
    invalidateActiveInvocation();
    return coordinator.cancelActive();
  };
  requestResolveJson.dispose = async () => {
    disposed = true;
    invocationGeneration += 1;
    invalidateActiveInvocation();
    return coordinator.cancelActive();
  };
  return requestResolveJson;
}

async function sleepUntilPoll({ sleepFn, delayMs, signal }) {
  throwIfResolveAborted(signal);
  if (!signal?.addEventListener) {
    await sleepFn(delayMs);
    return;
  }
  await new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(createResolveAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(sleepFn(delayMs)).then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Wait for a server-side resolve without adding a fixed polling delay.
 *
 * The server holds each request for at most 25 seconds and returns immediately
 * when the job changes. Quick pending responses identify an older server that
 * ignores `waitMs`; transient proxy failures fall back to the legacy polling
 * path while continuing to follow the same job.
 */
export async function waitForResolveJob({
  jobId,
  timeoutMs,
  requestJsonFn = requestJson,
  sleepFn = sleep,
  nowFn = () => Date.now(),
  longPollMs = RESOLVE_JOB_LONG_POLL_MS,
  fallbackPollMs = RESOLVE_JOB_FALLBACK_POLL_MS,
  signal = null,
  cancelOnAbort = true,
  cancelResolveJobFn = ({ jobId: cancelJobId }) =>
    cancelResolveJob({ jobId: cancelJobId, requestJsonFn }),
} = {}) {
  const normalizedJobId = String(jobId || "").trim();
  if (!normalizedJobId) {
    throw new Error("Unable to start async resolve.");
  }

  const normalizedTimeoutMs = Math.max(1, Math.floor(Number(timeoutMs) || 1));
  const normalizedLongPollMs = Math.max(1, Math.floor(Number(longPollMs) || 1));
  const normalizedFallbackPollMs = Math.max(
    1,
    Math.floor(Number(fallbackPollMs) || 1),
  );
  const deadline = nowFn() + normalizedTimeoutMs;
  const statusUrl = `/api/resolve/job/${encodeURIComponent(normalizedJobId)}`;
  const requestOptions = {
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  };
  let useLongPoll = true;

  const cancelForAbort = async () => {
    if (cancelOnAbort) {
      await cancelResolveJobFn({ jobId: normalizedJobId });
    }
    throw createResolveAbortError();
  };

  while (nowFn() < deadline) {
    if (signal?.aborted) {
      return cancelForAbort();
    }
    const remainingMs = Math.max(1, deadline - nowFn());
    let status;

    if (useLongPoll) {
      const waitMs = Math.min(normalizedLongPollMs, remainingMs);
      const startedAtMs = nowFn();
      try {
        status = await requestJsonFn(
          `${statusUrl}?waitMs=${waitMs}`,
          requestOptions,
          Math.max(1, Math.min(remainingMs, waitMs + RESOLVE_JOB_REQUEST_GRACE_MS)),
        );
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") {
          return cancelForAbort();
        }
        if (!isLongPollTransportError(error)) {
          throw error;
        }
        useLongPoll = false;
        continue;
      }

      const terminal = resolveTerminalJobState(status);
      if (terminal.done) {
        return terminal.result;
      }

      // Old servers return `pending` immediately because they ignore waitMs.
      // Detect that behavior so the compatibility path does not busy-loop.
      const elapsedMs = Math.max(0, nowFn() - startedAtMs);
      if (waitMs >= 1_000 && elapsedMs < Math.min(500, waitMs / 4)) {
        useLongPoll = false;
      }
      continue;
    }

    try {
      await sleepUntilPoll({
        sleepFn,
        delayMs: Math.min(normalizedFallbackPollMs, remainingMs),
        signal,
      });
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") {
        return cancelForAbort();
      }
      throw error;
    }
    if (nowFn() >= deadline) {
      break;
    }
    try {
      status = await requestJsonFn(
        statusUrl,
        requestOptions,
        Math.max(1, Math.min(20_000, deadline - nowFn())),
      );
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") {
        return cancelForAbort();
      }
      if (!isLongPollTransportError(error)) {
        throw error;
      }
      continue;
    }
    const terminal = resolveTerminalJobState(status);
    if (terminal.done) {
      return terminal.result;
    }
  }

  await cancelResolveJobFn({ jobId: normalizedJobId });
  throw new Error("Resolving stream timed out.");
}

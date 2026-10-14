import { CinejoyResolver } from "./resolve-cinejoy-hls.mjs";

// Private JSON-lines protocol on inherited pipes only. No socket, file registry,
// session data or signed URLs in logs. Rust assigns one request per worker.
export async function serveCinejoyWorker({ input = process.stdin, output = process.stdout,
  resolver = new CinejoyResolver(), idleMs = 900000, maxRequests = 100,
  maxLifetimeMs = 3600000, exit = code => process.exit(code) } = {}) {
  let pending = "", busy = false, stopping = false, requests = 0, idleTimer, jobTimer;
  const startedAt = Date.now();
  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    clearTimeout(idleTimer); clearTimeout(jobTimer);
    // EOF must cancel an active browser operation immediately, not wait for
    // a serial read loop to finish it. A parent hard kill is the final backstop.
    const hardExit = setTimeout(() => exit(code), 1500);
    hardExit.unref?.();
    await resolver.close().catch(() => {});
    clearTimeout(hardExit);
    exit(code);
  };
  const idle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => void shutdown(), idleMs); };
  const reply = payload => new Promise((resolve, reject) => {
    output.write(`${JSON.stringify(payload)}\n`, error => error ? reject(error) : resolve());
  });
  const request = async line => {
    if (busy || stopping) return shutdown(2);
    let value;
    try { value = JSON.parse(line); } catch { return shutdown(2); }
    const { id, watchUrl, server, timeoutMs } = value || {};
    if (!Number.isSafeInteger(id) || id < 1 || typeof watchUrl !== "string" ||
        typeof server !== "string" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
      return shutdown(2);
    }
    busy = true; clearTimeout(idleTimer);
    // Includes context creation, navigation, parsing, and cleanup. Rust imposes
    // the same overall deadline including waiting for worker capacity.
    jobTimer = setTimeout(() => void shutdown(1), timeoutMs + 250);
    try {
      const result = await resolver.resolve(watchUrl, server, timeoutMs);
      if (!stopping) await reply({ id, ok: true, result,
        retire: requests + 1 >= maxRequests || Date.now() - startedAt >= maxLifetimeMs });
    } catch {
      if (!stopping) await reply({ id, ok: false }).catch(() => {});
      return shutdown();
    } finally { busy = false; clearTimeout(jobTimer); }
    requests++;
    if (requests >= maxRequests || Date.now() - startedAt >= maxLifetimeMs) return shutdown();
    if (!stopping) idle();
  };
  input.setEncoding("utf8");
  input.on("data", chunk => {
    if (stopping) return;
    pending += chunk;
    if (pending.length > 4096) { void shutdown(2); return; }
    let index;
    while ((index = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, index); pending = pending.slice(index + 1);
      void request(line).catch(() => shutdown(1));
    }
  });
  input.on("end", () => void shutdown());
  input.on("error", () => void shutdown(1));
  output.on("error", () => void shutdown(1));
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  idle();
}

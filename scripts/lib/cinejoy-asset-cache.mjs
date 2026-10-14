// Only explicitly public, immutable, fingerprinted CineJoy build assets are
// reusable across isolated requests. Never cache the page, API, WASM handshake,
// cookies, media, or any signed URL. Bounds apply to bytes as well as entries.
export class CinejoyAssetCache {
  constructor({ maxBytes = 8 * 1024 * 1024, maxEntries = 192, ttlMs = 900000, now = Date.now } = {}) {
    this.entries = new Map(); this.bytes = 0;
    this.maxBytes = maxBytes; this.maxEntries = maxEntries; this.ttlMs = ttlMs; this.now = now;
  }
  accepts(url, method = "GET") {
    try {
      const u = new URL(url);
      return method === "GET" && u.origin === "https://cinejoy.pk" && !u.username && !u.password &&
        !u.search && !u.hash && /^\/_app\/immutable\/(?:chunks|entry|nodes|assets)\/(?:[^/]+\.)?[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(u.pathname);
    } catch { return false; }
  }
  get(url) {
    const item = this.entries.get(url);
    if (!item) return null;
    this.entries.delete(url); this.bytes -= item.body.length;
    if (item.expiresAt <= this.now()) return null;
    this.entries.set(url, item); this.bytes += item.body.length;
    return item;
  }
  put(url, headers, body) {
    if (!this.accepts(url) || !Buffer.isBuffer(body) || body.length > 512 * 1024 || body.length > this.maxBytes) return false;
    const control = String(headers["cache-control"] || "");
    if (!/(?:^|,)\s*public\s*(?:,|$)/i.test(control) || !/(?:^|,)\s*immutable\s*(?:,|$)/i.test(control) ||
        /(?:private|no-store|no-cache)/i.test(control) || /(?:cookie|authorization|\*)/i.test(headers.vary || "")) return false;
    const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(control);
    const freshnessMs = maxAge ? (Number(maxAge[1]) - Number(headers.age || 0)) * 1000 : 0;
    if (!Number.isFinite(freshnessMs) || freshnessMs <= 0) return false;
    const type = String(headers["content-type"] || "");
    if (!/^(?:application|text)\/(?:javascript|css)(?:;|$)/i.test(type)) return false;
    const old = this.entries.get(url);
    if (old) { this.entries.delete(url); this.bytes -= old.body.length; }
    while (this.entries.size && (this.entries.size >= this.maxEntries || this.bytes + body.length > this.maxBytes)) {
      const key = this.entries.keys().next().value;
      this.bytes -= this.entries.get(key).body.length; this.entries.delete(key);
    }
    // No provider cookies, authentication, compression or connection headers
    // are replayed into another browser context.
    const safeHeaders = { "content-type": type, "cache-control": control };
    if (headers["access-control-allow-origin"] === "*") safeHeaders["access-control-allow-origin"] = "*";
    this.entries.set(url, { body, headers: safeHeaders,
      expiresAt: this.now() + Math.min(this.ttlMs, freshnessMs) });
    this.bytes += body.length;
    return true;
  }
}

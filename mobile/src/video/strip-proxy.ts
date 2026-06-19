// On-device HLS strip proxy — the native equivalent of the web's hls.js loader.
//
// External-embed CDNs (LordFlix, VidEasy, …) disguise each MPEG-TS fragment as a PNG:
// a real PNG header is prepended to the .ts payload, served as `image/png`. The web
// strips this client-side in hls.js (`src-ui/player/hls-controller.js`) and fetches
// every segment straight from the CDN over the viewer's *residential* connection —
// which is why the browser plays them. The native backend transcode instead pulls those
// segments from the server's datacenter IP, which some CDNs anti-bot-block (Cloudflare
// 1010) → segments 502 → playback freezes.
//
// This proxy reproduces the web exactly, on the device:
//   • A tiny localhost HTTP server (react-native-tcp-socket) the player talks to.
//   • `/m` fetches an HLS playlist and rewrites every variant/segment URL to point back
//     at this proxy, so the player never talks to the CDN directly.
//   • `/s` fetches a segment *from the device* (residential IP + the browser UA the CDN
//     gates on), strips the PNG prefix, and hands back clean MPEG-TS.
//
// The player here is libVLC (MobileVLCKit, via VlcVideo.tsx), NOT AVPlayer: AVPlayer parses
// the proxied playlist but computes dur=0 and never fetches a segment, whereas libVLC's
// software demuxer plays it. (react-native-video/AVPlayer also exposes no JS segment-loader
// hook, so the strip has to happen here regardless.) The CDN fetches run on the device's own
// network — exactly the residential egress the backend can't offer.

import TcpSocket from "react-native-tcp-socket";
import { Buffer } from "buffer";
import { API_ORIGIN } from "@/lib/config";

// The CDNs gate on a real browser UA (a non-browser UA → 403). Matches the backend's
// `LIVE_HLS_BROWSER_USER_AGENT` (src/live.rs) so the device looks identical to the relay.
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// First port to try; bumped on EADDRINUSE (e.g. a leaked server after a Metro reload).
const BASE_PORT = 8771;
const PORT_TRIES = 6;

type TcpServer = InstanceType<typeof TcpSocket.Server>;
type TcpSock = InstanceType<typeof TcpSocket.Socket>;

let server: TcpServer | null = null;
let serverPort: number | null = null;
let starting: Promise<number> | null = null;

// Segment id table: the wrapped CDN URLs run ~480 chars once re-encoded, so the playlist
// references each segment by a short integer id and the /s handler resolves it back to the
// real CDN URL + referer here — keeping the proxied playlist/segment URIs short and clean.
const segTable = new Map<number, { url: string; ref: string }>();
const segIndex = new Map<string, number>();
let segSeq = 0;
function segId(url: string, ref: string): number {
  const key = `${ref}\n${url}`;
  let id = segIndex.get(key);
  if (id === undefined) {
    id = segSeq++;
    segIndex.set(key, id);
    segTable.set(id, { url, ref });
  }
  return id;
}

// Tiny LRU of recently-stripped segments keyed by segment id. A range probe followed by a
// full GET — or a short backward seek — reuses the clean bytes instead of re-fetching from
// the rate-limited, anti-bot-gated CDN (redundant fetches also raise the block risk). Kept
// tight: TS segments are multi-MB and the device is memory-constrained.
const SEG_CACHE_MAX = 3;
const segCache = new Map<number, Uint8Array>();
function segCacheGet(id: number): Uint8Array | undefined {
  const v = segCache.get(id);
  if (v !== undefined) {
    segCache.delete(id); // refresh recency (most-recent stays at the end)
    segCache.set(id, v);
  }
  return v;
}
function segCachePut(id: number, bytes: Uint8Array): void {
  segCache.delete(id);
  segCache.set(id, bytes);
  while (segCache.size > SEG_CACHE_MAX) {
    const oldest = segCache.keys().next().value;
    if (oldest === undefined) break;
    segCache.delete(oldest);
  }
}

// Drop all per-session segment state. Called when a new master is built (a new title starts)
// so the id table can't grow unbounded across a long session, and a new title's ids can't
// collide with the previous title's cached bytes.
function resetSegState(): void {
  segTable.clear();
  segIndex.clear();
  segCache.clear();
  segSeq = 0;
}

/** The running proxy port, or null if it hasn't started yet (callers fall back). */
export function getStripProxyPort(): number | null {
  return serverPort;
}

/** Start the loopback proxy once; subsequent calls return the same port. */
export function ensureStripProxy(): Promise<number> {
  if (serverPort) return Promise.resolve(serverPort);
  if (!starting) {
    starting = listenWithRetry(BASE_PORT, PORT_TRIES)
      .then((port) => {
        serverPort = port;
        return port;
      })
      .finally(() => {
        starting = null;
      });
  }
  return starting;
}

/** Build the master URL handed to the player: it hits the proxy, never the CDN. */
export function stripProxyMasterUrl(port: number, masterAbsUrl: string, referer?: string): string {
  // A new playback session starts here (decideSource calls this once before VLC issues any
  // /m or /s request), so it's the safe point to drop the previous title's segment state.
  resetSegState();
  return proxyUrl(port, "m", masterAbsUrl, referer || "");
}

/** Tear down the loopback server + segment state (dev: Metro reload; frees sockets/port). */
export function stopStripProxy(): void {
  try {
    server?.close();
  } catch {}
  server = null;
  serverPort = null;
  starting = null;
  resetSegState();
}

function listenWithRetry(port: number, triesLeft: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = TcpSocket.createServer((socket) => handleConnection(socket));
    srv.on("error", (err: Error & { code?: string }) => {
      try {
        srv.close();
      } catch {}
      if (err?.code === "EADDRINUSE" && triesLeft > 1) {
        listenWithRetry(port + 1, triesLeft - 1).then(resolve, reject);
      } else {
        reject(err);
      }
    });
    srv.listen({ port, host: "127.0.0.1", reuseAddress: true }, () => {
      server = srv;
      resolve(port);
    });
  });
}

// The player (libVLC) keeps the connection alive and pipelines the master, media playlist
// and every segment over it, so the server must handle many GETs per socket. Accumulate
// bytes, and for each complete header block parse the request line + Range and serve,
// leaving the socket open for the next request. An idle timeout reaps abandoned sockets.
function handleConnection(socket: TcpSock): void {
  let buf = "";
  let busy = false;
  try {
    socket.setTimeout(30000);
  } catch {}
  const pump = async (): Promise<void> => {
    if (busy) return;
    const end = buf.indexOf("\r\n\r\n");
    if (end === -1) return; // headers still arriving
    busy = true;
    const lines = buf.slice(0, end).split("\r\n");
    buf = buf.slice(end + 4); // keep any pipelined bytes for the next request
    const requestLine = lines[0] || "";
    const path = requestLine.split(" ")[1] || "/";
    const range = headerValue(lines, "range");
    try {
      await serve(socket, path, range);
    } finally {
      busy = false;
      if (buf.indexOf("\r\n\r\n") !== -1) void pump();
    }
  };
  socket.on("data", (data: Buffer | string) => {
    buf += typeof data === "string" ? data : Buffer.from(data).toString("latin1");
    void pump();
  });
  socket.on("error", () => {
    try {
      socket.destroy();
    } catch {}
  });
  socket.on("timeout", () => {
    try {
      socket.destroy();
    } catch {}
  });
}

async function serve(socket: TcpSock, path: string, range: string | null): Promise<void> {
  let url: URL;
  try {
    url = new URL("http://127.0.0.1" + path);
  } catch {
    return sendText(socket, 400, "bad path");
  }
  let target = url.searchParams.get("u");
  let referer = url.searchParams.get("ref") || "";
  // Playlists (?mid=) and segments (?id=) are addressed by a short id resolved back to the
  // real CDN URL + referer via segTable; long opaque "u=" URLs are still accepted directly.
  const idStr = url.searchParams.get("id") ?? url.searchParams.get("mid");
  if (idStr !== null) {
    const entry = segTable.get(parseInt(idStr, 10));
    if (entry) {
      target = entry.url;
      referer = entry.ref;
    }
  }
  if (!target) return sendText(socket, 400, "missing u");

  try {
    if (url.pathname === "/m") {
      const { text, baseUrl } = await resolveToMediaPlaylist(target, referer);
      const playlist = rewritePlaylist(text, baseUrl, referer, serverPort as number);
      send(socket, 200, "OK", "application/vnd.apple.mpegurl", Buffer.from(playlist, "utf8"));
    } else if (url.pathname === "/s") {
      // Reuse a cached strip when the player range-probes then full-GETs the same segment
      // (or seeks back into it), so the CDN is hit once per segment, not per request.
      const cacheId = idStr !== null ? parseInt(idStr, 10) : NaN;
      let clean = Number.isNaN(cacheId) ? undefined : segCacheGet(cacheId);
      if (clean === undefined) {
        clean = stripPngPrefix(await fetchBytes(target, referer));
        if (!Number.isNaN(cacheId)) segCachePut(cacheId, clean);
      }
      sendBytes(socket, "video/mp2t", clean, range);
    } else {
      sendText(socket, 404, "not found");
    }
  } catch (err) {
    sendText(socket, 502, String(err instanceof Error ? err.message : err));
  }
}

// --- upstream fetches (device network = residential IP) -------------------------------

function isApiHost(u: string): boolean {
  try {
    return new URL(u).host === new URL(API_ORIGIN).host;
  } catch {
    return false;
  }
}

// Backend URLs (the master at /api/live/hls.m3u8) authenticate via the shared cookie jar
// and need no UA override. CDN URLs need the browser UA (+ the source's Referer, if any).
function upstreamHeaders(u: string, referer: string): Record<string, string> {
  if (isApiHost(u)) return {};
  const headers: Record<string, string> = { "User-Agent": CHROME_UA, Accept: "*/*" };
  if (referer) headers.Referer = referer;
  return headers;
}

// Send the session cookie to the backend (the master lives behind auth); never leak it
// cross-origin to a CDN.
function fetchInit(u: string, referer: string): RequestInit {
  return {
    headers: upstreamHeaders(u, referer),
    credentials: isApiHost(u) ? "include" : "omit",
  };
}

// These embed CDNs are flaky and anti-bot (Cloudflare 1010, transient 502/520, dead hangs).
// A fetch with no timeout that the CDN accepts but never answers would hang the await in
// serve() forever and, because requests are serialized per socket, block every later
// pipelined request behind it. So bound every upstream fetch and retry transient failures
// like a real browser/hls.js would. Playlists get a tighter budget than segments.
const PLAYLIST_TIMEOUT_MS = 6000;
const SEGMENT_TIMEOUT_MS = 10000;
const FETCH_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 1010]);

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(u: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(u, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Fetch with a per-attempt timeout and bounded retries on transient network/HTTP failures.
async function fetchUpstream(u: string, referer: string, timeoutMs: number, what: string): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetchWithTimeout(u, fetchInit(u, referer), timeoutMs);
      if (res.ok) return res;
      lastErr = new Error(`${what} ${res.status}`);
      if (!RETRYABLE_STATUS.has(res.status)) throw lastErr;
    } catch (e) {
      lastErr = e; // network error or abort (timeout) — retryable
    }
    if (attempt < FETCH_ATTEMPTS - 1) await delay(150 * (attempt + 1));
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${what} failed`);
}

async function fetchText(u: string, referer: string): Promise<string> {
  const res = await fetchUpstream(u, referer, PLAYLIST_TIMEOUT_MS, "playlist");
  return res.text();
}

async function fetchBytes(u: string, referer: string): Promise<Uint8Array> {
  const res = await fetchUpstream(u, referer, SEGMENT_TIMEOUT_MS, "segment");
  return new Uint8Array(await res.arrayBuffer());
}

// --- playlist rewriting ---------------------------------------------------------------

function proxyUrl(port: number, kind: "m" | "s", abs: string, referer: string): string {
  // Both kinds use a short id — long wrapped URLs (and their encoded query delimiters) are
  // fragile in some players' asset/segment URI handling, so keep the proxied URIs short.
  return `http://127.0.0.1:${port}/${kind}?${kind === "s" ? "id" : "mid"}=${segId(abs, referer)}`;
}

function absolutize(u: string, base: string): string {
  try {
    return new URL(u, base).toString();
  } catch {
    return u;
  }
}

// Route each URI back through the proxy. Variant playlists (after #EXT-X-STREAM-INF, or
// #EXT-X-MEDIA URIs, or anything ending .m3u8) → `/m`; everything else (segments, init
// maps, keys) → `/s`. Context (the preceding tag) decides, because embed variant URLs are
// opaque (`…/tcloud?u=<base64>`) and carry no .m3u8 extension.
function rewritePlaylist(text: string, baseUrl: string, referer: string, port: number): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let nextIsPlaylist = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      out.push(line);
      continue;
    }
    if (trimmed.startsWith("#")) {
      if (trimmed.startsWith("#EXT-X-STREAM-INF")) nextIsPlaylist = true;
      if (trimmed.includes('URI="')) {
        const toPlaylist = trimmed.startsWith("#EXT-X-MEDIA");
        out.push(
          line.replace(/URI="([^"]+)"/, (_m, uri: string) => {
            const abs = absolutize(uri, baseUrl);
            return `URI="${proxyUrl(port, toPlaylist ? "m" : "s", abs, referer)}"`;
          }),
        );
      } else {
        out.push(line);
      }
      continue;
    }
    const abs = absolutize(trimmed, baseUrl);
    const kind = nextIsPlaylist || /\.m3u8(\?|#|$)/i.test(abs) ? "m" : "s";
    out.push(proxyUrl(port, kind, abs, referer));
    nextIsPlaylist = false;
  }
  return out.join("\n");
}

// Resolve a playlist URL down to a *media* playlist, following master→variant inside the
// proxy. Some players mishandle a variant URL that points back to the same loopback `/m`
// path (they fetch the master, then never request the variant), so `/m` hands back a media
// playlist directly. Picks the highest-bandwidth variant (these embeds offer 2-3).
async function resolveToMediaPlaylist(startUrl: string, referer: string): Promise<{ text: string; baseUrl: string }> {
  let url = startUrl;
  for (let hop = 0; hop < 4; hop++) {
    const text = await fetchText(url, referer);
    if (!text.includes("#EXT-X-STREAM-INF")) return { text, baseUrl: url };
    const next = pickBestVariant(text, url);
    if (!next || next === url) return { text, baseUrl: url };
    url = next;
  }
  return { text: await fetchText(url, referer), baseUrl: url };
}

function pickBestVariant(masterText: string, baseUrl: string): string | null {
  const lines = masterText.split(/\r?\n/);
  let best: { bw: number; url: string } | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    const bw = Number(/BANDWIDTH=(\d+)/.exec(lines[i])?.[1] ?? 0);
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t === "" || t.startsWith("#")) continue;
      if (!best || bw > best.bw) best = { bw, url: absolutize(t, baseUrl) };
      break;
    }
  }
  return best?.url ?? null;
}

// --- PNG-stego strip (port of png_prefixed_ts_strip_offset / hls-controller.js) --------

// PNG magic (89 50 4E 47) → scan for the first MPEG-TS sync byte (0x47) with 188-byte
// periodicity and return the payload from there. Clean segments fail the 4-byte check and
// pass through untouched, so this is safe to call on every fragment.
function stripPngPrefix(bytes: Uint8Array): Uint8Array {
  if (
    bytes.length < 8 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    return bytes;
  }
  const limit = Math.min(bytes.length - 376, 65536);
  for (let i = 1; i < limit; i++) {
    if (bytes[i] === 0x47 && bytes[i + 188] === 0x47 && bytes[i + 376] === 0x47) {
      return bytes.subarray(i);
    }
  }
  return bytes;
}

// --- HTTP response helpers ------------------------------------------------------------

function headerValue(lines: string[], name: string): string | null {
  const lower = name.toLowerCase();
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(":");
    if (idx > 0 && lines[i].slice(0, idx).trim().toLowerCase() === lower) {
      return lines[i].slice(idx + 1).trim();
    }
  }
  return null;
}

function send(
  socket: TcpSock,
  status: number,
  statusText: string,
  contentType: string,
  body: Uint8Array,
  extra: string[] = [],
): void {
  const header =
    [
      `HTTP/1.1 ${status} ${statusText}`,
      `Content-Type: ${contentType}`,
      `Content-Length: ${body.length}`,
      "Connection: keep-alive",
      ...extra,
      "",
      "",
    ].join("\r\n");
  // Write header then body as two writes (the socket is serialized behind `busy`, so order
  // holds), keeping the socket open for the next pipelined request. Two writes avoid the
  // extra Buffer.concat copy of a multi-MB segment; a playlist body is already a Buffer and
  // is forwarded without a re-copy.
  try {
    socket.write(Buffer.from(header, "latin1"));
    if (body.length > 0) socket.write(Buffer.isBuffer(body) ? body : Buffer.from(body));
  } catch {
    try {
      socket.destroy();
    } catch {}
  }
}

// .ts segments: honor a Range request (players sometimes probe/range) by slicing the
// already-in-memory stripped buffer; otherwise return the whole clean segment.
function sendBytes(socket: TcpSock, contentType: string, bytes: Uint8Array, range: string | null): void {
  // Operate on the stripped buffer directly; a Range slice is a view (no copy) and send()
  // does the single unavoidable copy when handing it to the native socket.
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? Math.min(parseInt(m[2], 10), bytes.length - 1) : bytes.length - 1;
      if (start <= end) {
        send(socket, 206, "Partial Content", contentType, bytes.subarray(start, end + 1), [
          `Content-Range: bytes ${start}-${end}/${bytes.length}`,
          "Accept-Ranges: bytes",
        ]);
        return;
      }
    }
  }
  send(socket, 200, "OK", contentType, bytes, ["Accept-Ranges: bytes"]);
}

function sendText(socket: TcpSock, status: number, message: string): void {
  send(socket, status, status === 200 ? "OK" : "Error", "text/plain; charset=utf-8", Buffer.from(message, "utf8"));
}

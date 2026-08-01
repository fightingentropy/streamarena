import {
  SIGNATURE_CLOCK_SKEW_SECONDS,
  SIGNATURE_CONTEXT_V1,
  SIGNATURE_CONTEXT_V2,
  SIGNATURE_MAX_TTL_SECONDS,
} from "./constants.js";
import { deny } from "./http.js";

const encoder = new TextEncoder();

function base64UrlDecodeToBytes(value) {
  let normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4 !== 0) normalized += "=";
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export async function verifySignature(
  secret,
  input,
  referer,
  expires,
  signature,
  context = SIGNATURE_CONTEXT_V2,
) {
  let provided;
  try {
    provided = base64UrlDecodeToBytes(signature);
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = concatBytes([
    encoder.encode(context),
    new Uint8Array([0]),
    encoder.encode(input),
    new Uint8Array([0]),
    encoder.encode(referer),
    ...(expires === null
      ? []
      : [new Uint8Array([0]), encoder.encode(String(expires))]),
  ]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  if (provided.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= provided[index] ^ expected[index];
  }
  return difference === 0;
}

export function parseSignatureExpiry(value, nowSeconds) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const expires = Number(value);
  if (!Number.isSafeInteger(expires)) return null;
  const earliest = nowSeconds - SIGNATURE_CLOCK_SKEW_SECONDS;
  const latest = nowSeconds + SIGNATURE_MAX_TTL_SECONDS + SIGNATURE_CLOCK_SKEW_SECONDS;
  return expires >= earliest && expires <= latest ? expires : null;
}

export function legacySignatureIsTemporarilyAllowed(value, nowSeconds) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return false;
  const deadline = Number(value);
  if (!Number.isSafeInteger(deadline)) return false;
  return (
    deadline >= nowSeconds - SIGNATURE_CLOCK_SKEW_SECONDS &&
    deadline <= nowSeconds + SIGNATURE_MAX_TTL_SECONDS + SIGNATURE_CLOCK_SKEW_SECONDS
  );
}

// Cloudflare Workers do not expose a portable DNS-resolution API. HTTPS plus
// this lexical host policy and the backend-minted HMAC form the egress trust
// boundary: IP literals, localhost/internal suffixes and malformed names fail.
export function isPublicHlsProxyHostname(host) {
  const value = host.trim().replace(/\.+$/, "").toLowerCase();
  if (
    value.length === 0 ||
    value.includes(":") ||
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value.endsWith(".local") ||
    value.endsWith(".internal") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(value)
  ) {
    return false;
  }
  return (
    value.includes(".") &&
    !value.startsWith(".") &&
    !value.endsWith(".") &&
    !value.includes("..") &&
    /^[a-z0-9.-]+$/.test(value)
  );
}

export async function authorizeSignedRequest(
  url,
  env,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const input = url.searchParams.get("input");
  const referer = url.searchParams.get("referer") || "";
  if (!input || url.searchParams.get("externalEmbed") !== "1") {
    return deny(400, "bad request");
  }
  const secret = env.LIVE_HLS_PROXY_SECRET;
  if (!secret) return deny(503, "not configured");

  const expiryValue = url.searchParams.get("expires");
  let expiresAt = null;
  if (expiryValue === null) {
    const legacySignature = url.searchParams.get("sig");
    if (
      !legacySignature ||
      !legacySignatureIsTemporarilyAllowed(
        env.LIVE_HLS_LEGACY_SIGNATURE_ACCEPT_UNTIL,
        nowSeconds,
      )
    ) {
      return deny(400, "missing expiry");
    }
    if (
      !(await verifySignature(
        secret,
        input,
        referer,
        null,
        legacySignature,
        SIGNATURE_CONTEXT_V1,
      ))
    ) {
      return deny(403, "bad signature");
    }
  } else {
    expiresAt = parseSignatureExpiry(expiryValue, nowSeconds);
    if (expiresAt === null) return deny(403, "bad expiry");
    const signature = url.searchParams.get("sigV2") || url.searchParams.get("sig");
    if (!signature) return deny(400, "bad request");
    if (!(await verifySignature(secret, input, referer, expiresAt, signature))) {
      return deny(403, "bad signature");
    }
  }

  let target;
  try {
    target = new URL(input);
  } catch {
    return deny(400, "bad input url");
  }
  if (target.protocol !== "https:") return deny(400, "bad scheme");
  if (!isPublicHlsProxyHostname(target.hostname)) return deny(403, "host not allowed");
  if (
    target.hostname.toLowerCase() === url.hostname.toLowerCase() &&
    target.pathname.startsWith("/api/live/")
  ) {
    return deny(403, "recursive target rejected");
  }
  return { target, referer, expiresAt };
}

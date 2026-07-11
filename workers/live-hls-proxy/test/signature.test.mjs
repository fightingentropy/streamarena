import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  SIGNATURE_CLOCK_SKEW_SECONDS,
  SIGNATURE_MAX_TTL_SECONDS,
  SIGNATURE_TTL_SECONDS,
  authorizeSignedRequest,
  verifySignature,
} from "../src/index.js";

const V1_CONTEXT = "streamarena-live-hls-v1";
const V2_CONTEXT = "streamarena-live-hls-v2";
const SECRET = "test-live-hls-proxy-secret-with-enough-length";
const INPUT = "https://cdn.example.com/live/index.m3u8";
const REFERER = "https://example.test/";
const NOW = 1_800_000_000;

function sign(context, input, referer, expires = null, secret = SECRET) {
  const fields = [context, input, referer];
  if (expires !== null) fields.push(String(expires));
  return createHmac("sha256", secret).update(fields.join("\0")).digest("base64url");
}

function signedUrl(expires, { transition = false } = {}) {
  const url = new URL("https://live.example.workers.dev/api/live/hls.m3u8");
  url.searchParams.set("input", INPUT);
  url.searchParams.set("referer", REFERER);
  url.searchParams.set("externalEmbed", "1");
  url.searchParams.set("expires", String(expires));
  if (transition) {
    url.searchParams.set("sig", sign(V1_CONTEXT, INPUT, REFERER));
    url.searchParams.set("sigV2", sign(V2_CONTEXT, INPUT, REFERER, expires));
  } else {
    url.searchParams.set("sig", sign(V2_CONTEXT, INPUT, REFERER, expires));
  }
  return url;
}

async function deniedStatus(url, env = { LIVE_HLS_PROXY_SECRET: SECRET }) {
  const result = await authorizeSignedRequest(url, env, NOW);
  assert.ok(result instanceof Response, "request should be denied");
  return result.status;
}

test("Rust and Worker share the expiry-bound HMAC vector and limits", async () => {
  assert.equal(SIGNATURE_TTL_SECONDS, 14_400);
  assert.equal(SIGNATURE_MAX_TTL_SECONDS, 21_600);
  assert.equal(SIGNATURE_CLOCK_SKEW_SECONDS, 60);

  const expected = "LPJB2XyjYuHFCTN9f3BWwtYqNevQnmbZAyisfSCEMg4";
  assert.equal(
    sign(
      V2_CONTEXT,
      "https://www.bloomberg.com/parity-probe.ts",
      "https://example.test/",
      1_800_000_000,
      "paritytest12345",
    ),
    expected,
  );
  assert.equal(
    await verifySignature(
      "paritytest12345",
      "https://www.bloomberg.com/parity-probe.ts",
      "https://example.test/",
      1_800_000_000,
      expected,
    ),
    true,
  );
  assert.equal(
    await verifySignature(
      "paritytest12345",
      "https://www.bloomberg.com/parity-probe.ts",
      "https://example.test/",
      1_800_000_001,
      expected,
    ),
    false,
  );
});

test("expiry validation rejects missing, expired, far-future, and tampered values", async () => {
  const validExpiry = NOW + SIGNATURE_TTL_SECONDS;
  const valid = await authorizeSignedRequest(
    signedUrl(validExpiry),
    { LIVE_HLS_PROXY_SECRET: SECRET },
    NOW,
  );
  assert.ok(!(valid instanceof Response));
  assert.equal(valid.expiresAt, validExpiry);
  assert.equal(valid.target.toString(), INPUT);

  const missing = signedUrl(validExpiry);
  missing.searchParams.delete("expires");
  assert.equal(await deniedStatus(missing), 400);

  const expired = signedUrl(NOW - SIGNATURE_CLOCK_SKEW_SECONDS - 1);
  assert.equal(await deniedStatus(expired), 403);

  const skewBoundary = signedUrl(NOW - SIGNATURE_CLOCK_SKEW_SECONDS);
  const skewed = await authorizeSignedRequest(
    skewBoundary,
    { LIVE_HLS_PROXY_SECRET: SECRET },
    NOW,
  );
  assert.ok(!(skewed instanceof Response));

  const farFuture = signedUrl(
    NOW + SIGNATURE_MAX_TTL_SECONDS + SIGNATURE_CLOCK_SKEW_SECONDS + 1,
  );
  assert.equal(await deniedStatus(farFuture), 403);

  const tampered = signedUrl(validExpiry);
  tampered.searchParams.set("expires", String(validExpiry - 1));
  assert.equal(await deniedStatus(tampered), 403);

  const nonCanonical = signedUrl(validExpiry);
  nonCanonical.searchParams.set("expires", `0${validExpiry}`);
  assert.equal(await deniedStatus(nonCanonical), 403);
});

test("legacy v1 compatibility is explicit, short, and cannot downgrade v2 after deadline", async () => {
  const validExpiry = NOW + SIGNATURE_TTL_SECONDS;
  const transition = signedUrl(validExpiry, { transition: true });
  const current = await authorizeSignedRequest(
    transition,
    {
      LIVE_HLS_PROXY_SECRET: SECRET,
      LIVE_HLS_LEGACY_SIGNATURE_ACCEPT_UNTIL: String(NOW + 300),
    },
    NOW,
  );
  assert.ok(!(current instanceof Response));
  assert.equal(current.expiresAt, validExpiry);

  transition.searchParams.delete("expires");
  transition.searchParams.delete("sigV2");
  const legacy = await authorizeSignedRequest(
    transition,
    {
      LIVE_HLS_PROXY_SECRET: SECRET,
      LIVE_HLS_LEGACY_SIGNATURE_ACCEPT_UNTIL: String(NOW + 300),
    },
    NOW,
  );
  assert.ok(!(legacy instanceof Response));
  assert.equal(legacy.expiresAt, null);

  assert.equal(await deniedStatus(transition), 400);
  assert.equal(
    await deniedStatus(transition, {
      LIVE_HLS_PROXY_SECRET: SECRET,
      LIVE_HLS_LEGACY_SIGNATURE_ACCEPT_UNTIL: String(
        NOW + SIGNATURE_MAX_TTL_SECONDS + SIGNATURE_CLOCK_SKEW_SECONDS + 1,
      ),
    }),
    400,
  );
  assert.equal(
    await deniedStatus(transition, {
      LIVE_HLS_PROXY_SECRET: SECRET,
      LIVE_HLS_LEGACY_SIGNATURE_ACCEPT_UNTIL: String(
        NOW - SIGNATURE_CLOCK_SKEW_SECONDS - 1,
      ),
    }),
    400,
  );
});

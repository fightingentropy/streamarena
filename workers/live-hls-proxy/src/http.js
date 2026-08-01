export class BodyLimitError extends Error {
  constructor(limit) {
    super(`response body exceeded ${limit} bytes`);
    this.name = "BodyLimitError";
    this.limit = limit;
  }
}

export function deny(status, message) {
  return new Response(message, {
    status,
    headers: { "cache-control": "no-store", "content-type": "text/plain" },
  });
}

export function upstreamCacheStatus(upstream) {
  return upstream.headers.get("cf-cache-status") || "none";
}

export async function readBoundedBytes(response, limit) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new BodyLimitError(limit);
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel("body limit exceeded");
        throw new BodyLimitError(limit);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedText(response, limit) {
  return new TextDecoder().decode(await readBoundedBytes(response, limit));
}

# Live HLS delivery cache

Use `https://live.streamarena.xyz` as `LIVE_HLS_RESOURCE_WORKER_BASE` on the
backend. The custom domain runs the same Worker as the `workers.dev` fallback,
but cache behavior must be verified on the actual playback hostname. A
`workers.dev` response marked `DYNAMIC` does not establish that the custom
domain also bypasses the cache.

The Worker authorizes each request before fetching a media resource. Its
`fetch` cache retains the complete upstream URL, including signed provider
tokens, referrer and expiry. No custom Cache API, unsigned shared identity or
Enterprise cache-key override is needed. The normal streaming body path is
unchanged; cache policy does not buffer media.

`X-Upstream-Cache: HIT` shows that the upstream subrequest used an edge cache.
Compare it with `MISS` on repeated requests for the **same complete signed
resource URL**, verifying response bytes as well as timing. Browser-cache
hits alone do not demonstrate that the Mini was bypassed.

Probe an existing signed segment with fresh network GETs (the input file stays
private; output contains timings, cache classifications and byte hashes):

```sh
python3 scripts/check-hls-delivery-cache.py --url-file /private/segment-url.txt \
  --origin https://live.streamarena.xyz
```

For a JSON probe file, add `--json-path segments.0.url`. Repeat `--origin` with
an explicitly chosen alternate endpoint to compare the same path and signature.
A cache HIT is a warm-delivery result, not a cold-start or playback benchmark.
Verify advancing 1080p video, decoded audio and seeking separately.

The Mini loads this setting from `/Users/hermes/.config/streamarena/env` at
startup. Preserve that file's permissions and keep a backup before changing
only `LIVE_HLS_RESOURCE_WORKER_BASE`. Apply it with a backend-only restart:

```sh
MINI_HOST=m4mini-ts MINI_INGRESS_MODE=tunnel scripts/install-mini-server.sh
```

Existing player sessions may retain their previous signed URLs. Verify a new
resolve uses the custom domain. Keep `workers.dev` available for rollback if
custom-domain routing fails; do not weaken Cloudflare protections to force a HIT.

Browser freshness is capped by both the signed grant/provider deadline and
remaining upstream freshness. `Age` and `Date` reduce that remaining lifetime;
relaying a HIT must not restart its original `max-age`. A longer `s-maxage`
never expands a shorter browser `max-age`. Private, no-store, no-cache, partial
and failed responses remain uncached by the outgoing policy.

Run the focused checks with:

```sh
node --test workers/live-hls-proxy/test/*.test.mjs
```

Cloudflare references:

- [How the cache works](https://developers.cloudflare.com/workers/reference/how-the-cache-works/)
- [Cache-Control directives](https://developers.cloudflare.com/cache/concepts/cache-control/)

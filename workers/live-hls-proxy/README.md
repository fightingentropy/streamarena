# Live HLS proxy

## Tooling and deployment

Use Node 22.18 or newer. The Worker pins `cf` 1.0.0-beta.10 and Wrangler 4.145.0
in its own npm lockfile; Bun continues to manage the main app. From the repo root:

```sh
npm ci --prefix workers/live-hls-proxy
bun run worker:dev       # local Worker on port 8790
bun run worker:build
bun run check:worker     # signature/cache tests and deployment dry run
bun run worker:deploy
```

The npm scripts run `cf` with Node. `cloudflare.config.ts` owns the Worker name,
Erlin account, routes, compatibility date, observability and bindings.
`wrangler.config.ts` configures the bundler. Keep `wrangler.jsonc` for remaining
Wrangler commands such as live tails; it is not the deployment configuration.
`bun run check` includes the Worker tests and dry run; the dry run needs no login.

For deployment, verify `cf auth whoami` selects the Erlin account. `cf` and
Wrangler have separate logins. Existing remote secrets `LIVE_HLS_PROXY_SECRET`
and `ORIGIN_DIRECT_BASE` are declared by name and reused without copying their
values. Keep `LIVE_HLS_LEGACY_SIGNATURE_ACCEPT_UNTIL` absent in normal operation.
For local development, put test values in this directory's ignored `.dev.vars`;
missing local secrets do not read or change the remote values.

Use `cf` for remote resource operations, checking its selected account because
resource commands do not inherit the project's `accountId`. Discover the exact
operation with `cf cli search`, then inspect its help and schema. For example,
`cf workers secrets list --worker streamarena-live-hls-proxy` verifies secret
names without retrieving their values. Do not put secret values in source or
shell arguments.

The deployed entrypoint exports only its request handler. Tests import internal
helpers directly; exporting their numeric constants from the entrypoint makes
the Workers runtime reject startup.

See the [Cloudflare CLI project guide](https://developers.cloudflare.com/cf/projects/)
and [Wrangler coexistence guide](https://developers.cloudflare.com/cf/wrangler/).

## Delivery cache

Use `https://live.streamarena.xyz` as `LIVE_HLS_RESOURCE_WORKER_BASE` on the
backend. The custom domain runs the same Worker as the `workers.dev` fallback,
but cache behavior must be verified on the actual playback hostname. A
`workers.dev` response marked `DYNAMIC` does not establish that the custom
domain also bypasses the cache.

The Worker authorizes each request before fetching a media resource. Its
`fetch` cache retains the complete origin-relay URL, including signed provider
tokens, referrer and expiry. Direct CDN fetches retain the complete provider
URL and still require Worker authorization first. No custom Cache API,
unsigned shared identity or Enterprise cache-key override is needed. The normal streaming body path is
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

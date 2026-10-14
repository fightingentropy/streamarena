# CineJoy resolver reuse — Oracle verification, 14 October 2026

## Change and scope

The backend now reuses at most two private Node/Chromium workers for CineJoy
resolution. Each job receives a new isolated browser context and a pinned server;
cookies, storage and session state are never shared. A bounded in-memory cache
reuses only explicitly public, immutable, fingerprinted CineJoy JS/CSS assets.
It excludes pages, API responses, WASM negotiation, signed URLs and video data.
The normal Rust manifest and quality validation still follows every fresh resolve.

The pool admits two active and at most two waiting requests. Workers retire after
15 minutes idle, 100 requests or one hour; each asset cache is capped at 8 MiB and
192 entries with a maximum 15-minute freshness, respecting upstream age/max-age.
The benchmark populated 93 assets totaling 2,361,119 bytes per worker. Workers
use inherited private pipes, not HTTP/listening sockets. Existing proxy settings
are preserved. `CINEJOY_WARM_RESOLVER=0` restores the one-shot process path.

No production configuration/service changes were made during these tests.
New helpers ran from an isolated temporary directory as the existing
`streamarena` service user with its installed Playwright runtime. The production
egress proxy settings were verified empty; the benchmark used that same egress.

## Timings

Measured on Oracle (`oracle-free-01`, ARM64, 2 OCPU / 12 GB). The old route spawned
the actual production `resolve-external-embed-hls.mjs` CLI for each request; the new
route used the private persistent JSON-lines worker protocol. CineJoy Nebula was
pinned throughout. Pairs alternated order to reduce systematic ordering bias.
Values are milliseconds from starting a resolver call to receiving its result;
the old route includes process exit because Rust's `command.output()` waits for it.

- Inception, movie/27205: cold CLI **4,086 ms**; warm worker **2,884 ms**.
- Oppenheimer, movie/872585: cold CLI **4,073 ms**; warm worker **2,680 ms**.
- Interstellar, movie/157336: cold CLI **4,311 ms**; warm worker **2,733 ms**.
- Game of Thrones S1 E2, tv/1399/1/2: cold CLI **5,296 ms**; warm worker **2,930 ms**.

Median: **4,198.5 ms → 2,808.5 ms**, a **1,390 ms / 33.1%** reduction in this small
sample. The initial cold-worker warmup was **4,128 ms**, so a first request after
startup/retirement still pays the original cold cost. This is provider-discovery
time, not full player startup, decoded-frame latency or seek speed.

All nine returned playlists (eight measured plus warmup) were independently
fetched from Oracle: HTTP 200, valid `#EXTM3U`, and advertised 1080p / 720p variants.
No watch history, provider health or production resolver-cache records were
written by the helper tests. No signed URLs or credentials are saved in this report.

A preliminary browser-only comparison, which did not include per-request Node
process/module startup, found a smaller median **3,206 → 2,735 ms** improvement
(14.7%, three paired movies). The CLI/protocol comparison above matches the actual
production process boundary and is the relevant result.

## Lifecycle and focused checks

Actual Oracle Chromium descendants were inventoried before closing the worker's
stdin, then checked after worker exit:

- Idle after successful resolve: 8 descendants → **0 live**, worker exited 0;
  **206 ms** including a 150 ms observation delay.
- Cancellation during browser launch: 3 descendants → **0 live**, no reply;
  **182 ms** including observation delay.
- Cancellation after page startup: 6 descendants → **0 live**, no reply;
  **327 ms** including observation delay.

Focused coverage includes context isolation, crash recovery, source pinning,
context-creation deadline, immutable-cache hygiene/expiry/byte bounds, capped
protocol framing, reply correlation, worker retirement, idle exit, concurrent
request rejection, Rust capacity/queue bounds and cancellation cleanup.
`node --test scripts/cinejoy-test.mjs scripts/check-resolver-runtime-test.mjs`
passed 19 tests; `cargo test cinejoy_worker` passed 3 tests. Clippy with
`--all-targets -- -D warnings` passed before the final retention-constant change;
the release gate must run on the final committed content.

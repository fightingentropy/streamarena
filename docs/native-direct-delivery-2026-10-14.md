# Native direct delivery and warm resolver release

Application release: `f9b5384fb17767d20636bef1acdc701cf2b2dd76`.
Native release: version **1.0.1**, build **14**.

## Delivered behavior

Older native builds ignored the additive `directMediaUrls` response field and
continued to use Worker-first delivery. Build 14 tries the signed public Oracle
route first, retaining Worker and app transport fallbacks. Private sessions keep
their authenticated route. Public media requests do not carry account cookies.
The existing VLC engine and device relay remain in use for compatible VOD sources.

Recovery now preserves distinct relay URLs, pending seek position and pause state,
rejects stale player callbacks, bounds response-body waits and detects silent
startup failures. Seeking while paused keeps Play and skip controls available,
even when VLC emits buffering until playback resumes.

The backend also reuses bounded, isolated CineJoy resolver workers. See the
[four-title benchmark](cinejoy-resolver-benchmark-2026-10-14.md): warm discovery
median **4.20 → 2.81 seconds**, about **33% faster**. First-cold discovery remains
about four seconds; this is not a measured 33% improvement in whole-app startup.

## Verification layers

- Full web/backend `bun run check` passed: 540 Rust tests passed, 2 ignored,
  Worker tests, audits, frontend build, benchmark contracts, operations tests
  and browser smoke tests. Final Rust formatting/Clippy also passed.
- Mobile TypeScript, Expo lint and all **82 tests** passed, including routing,
  recovery races and rendered paused-control regressions. Independent review
  found no unresolved blocker.
- The actual production TypeScript relay fetched the same **5,312,128-byte**
  public sample-media segment through direct, Worker and app routes, all HTTP
  200. Direct/Worker omitted credentials; the app route retained its API policy.
  This check was repeated after Oracle activation.
- In the iOS simulator, a public HLS sample decoded and advanced through the
  direct candidate, with the direct host deliberately unavailable, and with both
  direct and Worker hosts deliberately unavailable. The final paused-seek check
  moved 0:33 → 0:43, retained Play, and advanced past 1:04 after resuming.
  Test account APIs were served only by a local fixture; no real watch progress
  was written. The simulator was restored to a production-configured Release
  build afterward.
- The signed final Release build passed strict code-signature validation and
  was installed and launched on the paired iPhone. Device inventory confirmed
  version 1.0.1/build 14. Physical screen playback, battery use and a controlled
  before/after iPhone startup benchmark were not measured.

## Production verification

Oracle activated the exact application release above. A pre-activation backup
was saved at `/var/backups/streamarena/deploy-20261014T171254202390Z`; the previous
application release `997d7175cd7c2b60ef98c2576b9b23358da0dce6` remains available.
Only StreamArena restarted. Caddy, its Cloudflare tunnel, Jackett, WARP and SSH
kept their existing process IDs. A stale systemd reload flag was cleared after
confirming that the installed unit exactly matched the committed template;
this did not restart any service.

Two explicit CineJoy Nebula resolves for Interstellar used the admin benchmark
header, suppressing provider-health writes and bypassing resolved-stream cache
reuse. They returned HTTP 200 in **4,554 ms cold** and **2,864 ms warm**, with the
same backend-owned worker PID, confirming actual production reuse. Ordinary
regenerable metadata cache and in-memory metrics may still update.

The published browser player then decoded **1920×1080** CineJoy video through
`media.streamarena.xyz`, advancing to 637 frames at 26.40 seconds. A forward seek
to 600 seconds recovered: 1,506 decoded frames, time 628.22, ready state 4,
playing and no longer seeking. Disposable page storage and write guards blocked
watch-progress changes; the temporary page was closed after verification.

Public checks: app liveness and media health returned 200, unsigned media 401,
and account APIs on the media host 404. The Worker remains a transport fallback.
No DNS, Cloudflare Worker, Caddy routing or Mini process changes were required.

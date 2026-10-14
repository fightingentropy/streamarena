# Oracle deployment

StreamArena runs as a dedicated `streamarena` system user under systemd. The
Cloudflare edge terminates public HTTPS; a dedicated Oracle Tunnel forwards to Caddy
on loopback port 5180, then reaches the backend on `127.0.0.1:5173`. Neither
listener is publicly exposed. Keep the current Cloudflare Worker provider routing: some upstreams
require the origin relay and reject requests directly from Workers.

## Deployed state, 13 October 2026

The main domain, www alias, and existing Worker-origin hostname point to the
dedicated `streamarena-oracle` tunnel. The app, relay, user databases, Jackett,
and sports WARP proxy run on Oracle. Music and the other Mini services retain
their original routes. The Mini StreamArena app, watchdog and temporary cutover
forwarder are disabled, preventing two hosts from independently changing user data.

Public ingress is currently Cloudflare Tunnel. A DNS-only direct HTTPS media
route remains an optional follow-up: Oracle console sign-in is complete, and
the narrow OCI ingress changes are awaiting approval. Guest ingress remains SSH-only.
Do not describe the current media delivery as bypassing Cloudflare.

The deployed application release is `ef11d59dbf7ad75a7641ec48ed2bfbfac74e8a17`.
Its 60 Rust source/manifest files were hash-matched before installing the
Linux ARM64 build; its frontend is the pristine production build, without
staging benchmark injections. This migration changes hosting and operations,
not the web/mobile application code or its public URL.

All 12 accounts and 9 existing sessions were copied with SQLite verification,
along with progress, lists, preferences and assets. Only title track preferences
were retained from the resolver cache; host-bound playback URLs and provider
health were regenerated. Frozen migration snapshots remain on the Mini and
in the private migration backup. Daily Oracle backups retain 14 days.

Verified through HTTPS: existing login, 3832×1600 movie playback, movie provider
switch to CineJoy, native 1080p Sky Sports, and 3840×2160 TV playback. A fresh
40-minute seek took 457 ms with the Mini backend and forwarder both stopped.
These are observed samples, not a guaranteed latency for every provider.

## Layout

- `/opt/streamarena/releases/<git-sha>`: root-owned binary, `bin/lib` resolver
  helpers, frontend `dist`, and `.release-commit`. Never edit a published release.
- `/opt/streamarena/current`: atomically replaced symlink to one release.
- `/opt/streamarena/runtime`: root-owned, pinned Playwright and libsodium
  packages shared between releases.
- `/etc/streamarena/env`: private production environment, owned by root, mode
  `600`. systemd reads it before changing to the service user.
- `/var/lib/streamarena/cache`: both SQLite databases and runtime caches.
- `/var/lib/streamarena/assets`: existing library metadata, artwork and uploaded
  videos. The **entire assets directory** is shared: library updates use atomic
  rename, so making only `library.json` a symlink is insufficient.
- `/var/lib/streamarena/.cache/ms-playwright`: Chromium installed for the service user.
- `/var/backups/streamarena`: private database snapshots and previous-release
  pointers. Back these up outside the VM too.
- `~/.local/share/streamarena-build`: unprivileged SSH user's source/build
  workspace and Cargo target cache; it is never served by the app.

The release's `cache` and `assets` symlinks reference the persistent directories.
Deploying app code never replaces user data or copies development databases.

## Initial host preparation

Install stable Rust for the SSH user, Node 22.18 or later at
`/usr/local/bin/node`, and the Linux packages needed by Cargo/FFmpeg/Chromium.
Oracle A1 needs ARM64 binaries. Do not reuse a macOS release executable.

Create the account and directories, if absent:

```sh
sudo useradd --system --user-group --home-dir /var/lib/streamarena --shell /usr/sbin/nologin streamarena
sudo install -d -m 755 /opt/streamarena/releases /opt/streamarena/runtime
sudo install -d -m 750 /etc/streamarena
sudo install -d -o streamarena -g streamarena -m 700 /var/lib/streamarena
sudo install -d -o streamarena -g streamarena -m 700 /var/lib/streamarena/cache /var/lib/streamarena/assets
sudo install -d -o streamarena -g streamarena -m 700 /var/lib/streamarena/.cache/ms-playwright
sudo install -d -m 700 /var/backups/streamarena
sudo npm install --prefix /opt/streamarena/runtime --save-exact playwright@1.60.0 libsodium-wrappers@0.8.4
sudo /usr/local/bin/node /opt/streamarena/runtime/node_modules/playwright/cli.js install-deps chromium
sudo -u streamarena env HOME=/var/lib/streamarena PLAYWRIGHT_BROWSERS_PATH=/var/lib/streamarena/.cache/ms-playwright /usr/local/bin/node /opt/streamarena/runtime/node_modules/playwright/cli.js install chromium
```

Provision `/etc/streamarena/env` privately; never paste its contents into logs or
commit it. The existing environment uses simple `KEY=value` entries; normalize
them for systemd's EnvironmentFile format without shell expansion. Preserve
auth, signing and Worker secrets. Set `HOST=127.0.0.1`, `PORT=5173` and the same
public `APP_ORIGIN`. Rewrite absolute macOS helper paths to the appropriate
`/opt/streamarena/current/bin/*.mjs` files. Runtime defaults use `bin/` when no
override is set. Remove stale macOS PATH/HOME/Node/browser directory overrides.
Keep resolver dependencies at `/opt/streamarena/runtime` and browser cache
at `/var/lib/streamarena/.cache/ms-playwright`, matching the unit.

Do not copy a `SPORTS_HTTP_PROXY=http://127.0.0.1:40000` entry unless that proxy
actually exists on Oracle. Test the sports resolvers there and explicitly
provision their required proxy before cutover. Apply the same check to every
loopback or private-network service URL. IP-bound playback URLs must be resolved
again from Oracle; copying their cached values does not make them portable.

Install `deploy/linux/streamarena.service` as
`/etc/systemd/system/streamarena.service`, then run `sudo systemctl daemon-reload`.
Do not enable or start it until the environment, data and release are ready.
The unit preserves browser compatibility by not restricting namespaces/syscalls;
it restricts writes to service data and private temporary storage instead.

## Data migration and cutover

1. Inventory the Mini's current app environment, launchd service, Caddy/tunnel
   routes, Worker origin and all persistent files. Record exact DNS records and
   keep unrelated apps/services intact.
2. Copy existing `assets/`, dereferencing local video symlinks where their targets
   must move. Check available disk before copying media. Preserve local library
   metadata and artwork. File counts and checksums should match the source.
3. Use `scripts/snapshot-streamarena.py snapshot --source <mini-app-root>
   --output <new-private-directory> --expect-release <sha>` to copy the complete
   durable user database and **only `title_track_preferences`** from the resolver
   database. The helper includes committed WAL data, checks integrity, counts
   rows and records checksums. Verify with its `verify --snapshot <directory>`
   command. Resolved URLs, playback sessions, legacy user tables and provider
   health are intentionally not migrated: URLs can be IP-bound and provider
   performance must be learned from Oracle. This migration snapshot is distinct
   from the full backups used for same-host recovery. Never copy just the live
   main database while omitting its WAL.
4. Test Oracle with a separate working copy of data and a staging endpoint. Do
   not let staging and production update the same logical user state. Test the
   systemd service identity and sandbox, not only a shell under the SSH account.
5. Just before the final copy, quiesce writes on the Mini: stop only its
   StreamArena backend and prevent it from restarting. Take the final SQLite
   backups with `--quiesced` and synchronize the final mutable assets. This mode
   refuses nonempty WAL/journal files and verifies database files remain unchanged;
   it avoids creating source sidecars when reading checkpointed databases. Install them with owner
   `streamarena:streamarena`, directory mode `700`, file mode `600`; remove stale
   destination WAL/SHM files only while its backend is stopped and after backup.
6. Stage and activate the verified release, configure Caddy, then switch the
   public app and Worker-origin routes. During DNS propagation the old Mini
   frontend should proxy to Oracle, or remain in explicit maintenance mode; it
   must not become a second independent writer. Keep existing browser auth and
   signed resource requests valid where possible by preserving their keys.
7. Verify through public HTTPS: existing authenticated session, static assets,
   account preferences/progress, API health, movie and TV playback with advancing
   decoded frames, high-resolution rendition, seeking, source switching and live
   sports. Confirm the Worker is using Oracle rather than reaching the Mini.
   Repeat after a systemd restart, then enable the service for boot.
8. Keep the Mini's last release and frozen data as rollback material. Archive the
   migration manifest, original routes, checksums and snapshots privately. Do not
   leave staging benchmark HTML, credentials, processes or ports in production.

## Direct media HTTPS configuration

`deploy/linux/media.Caddyfile` is a separate media-only virtual host for
`media.streamarena.xyz`. Installing it does not replace the existing loopback
tunnel site. Add `auto_https disable_redirects` to Caddy's existing global block
and import the file after that block. The host binds IPv4 only and obtains and
renews its certificate using [Caddy's TLS-ALPN-01 ACME support](https://caddyserver.com/docs/caddyfile/directives/tls#issuers).
It deliberately disables the HTTP challenge: no listener or ingress rule on
port 80 is needed. TCP 443 is required; UDP 443 enables HTTP/3. DNS must be an
unproxied A record pointing at the VM, with no AAAA record until IPv6 is configured.

The vhost exposes only `/api/live/hls.m3u8`, `/api/live/hls-resource`, and a local
`/healthz` response. The backend still validates every media URL's expiring HMAC.
Cookie and Authorization headers are removed before proxying, and client-IP
headers are replaced with the actual peer address. Other API and application
paths return 404. Keep account/session-bound streams on the main app hostname.

Browser CORS is limited to `https://streamarena.xyz` and
`https://www.streamarena.xyz`, with GET/OPTIONS, Range requests, and exposed
range/length response headers. Native players may make signed requests without
an Origin header; arbitrary browser origins and `Origin: null` are rejected.
No credentialed CORS is enabled. Keep the existing Worker as a transport fallback.
Verify decoded browser playback, seeking, provider switching and private-stream
routing before treating the direct route as ready.

This rollout opts the **web player** into direct delivery. The backend exposes
the new candidates in an additive `directMediaUrls` array, which the web player
prepends to its delivery queue. Existing `playableUrl`, `fallbackUrls` and live
transport fields keep their Worker-first ordering for installed native apps.
Native routing therefore stays unchanged, and this web rollout needs no native
rebuild. The endpoint's acceptance of no-Origin requests does not itself opt
native playback into the direct route.

Before installation, save the live Caddy and firewall configuration, validate the
combined file with `caddy validate`, and confirm the approved OCI ingress rules.
Insert the narrow guest TCP/UDP 443 accept rules before its terminal INPUT reject
and save them with `netfilter-persistent`, preserving SSH and InstanceServices.
Reload Caddy only after the exact candidate passes validation. `/healthz` proves
the Caddy endpoint only; authenticated app health and decoded playback are separate
checks. Only after public TLS and live media delivery are verified, set
`LIVE_HLS_DIRECT_BASE=https://media.streamarena.xyz` and restart the app to publish
the web player's direct candidates. Retain
the existing `LIVE_HLS_RESOURCE_WORKER_BASE` value so the Worker remains a
transport fallback. To roll back, remove or empty `LIVE_HLS_DIRECT_BASE` and
restart the app; do not point the direct-base setting at the Worker. This restores
the previous delivery path without changing the main domain or its tunnel.

## Subsequent releases

From a clean, committed checkout:

```sh
./scripts/deploy-oracle.sh
./scripts/deploy-oracle.sh --activate --skip-check
```

The first command validates the app, rebuilds frontend and Linux backend, and
stages the release without changing traffic. The second reuses Cargo's incremental
release cache, keeps an existing release immutable, requires the durable database
to exist, stops app writes, backs up both databases and library metadata, switches
the symlink and starts systemd. A failure before activation restarts the prior
service if it was running and its release is still selected. Once activation
changes the symlink, the script never automatically switches back or downgrades
the database. It verifies the running process's executable and working directory
against the selected release, as well as loopback liveness. Use `--skip-check` only when that exact
commit already passed the quality gate. No DNS or firewall changes are made.

Loopback liveness is a deployment check, not proof of public HTTPS, authentication
or video playback. Keep those verification layers distinct in the release log.

The build user needs passwordless sudo for the explicit deployment operations.
Source is built without sudo; only artifact installation and service operations
are privileged. Releases and credentials remain unwritable by the app user.
A host-wide file lock serializes deployments so a concurrent build cannot replace
the shared Cargo artifact between compilation and installation.

## Daily backups

Install the two Python helpers and backup units, then enable the timer:

```sh
sudo install -d -m 755 /usr/local/libexec/streamarena
sudo install -m 644 scripts/backup-streamarena.py scripts/snapshot-streamarena.py /usr/local/libexec/streamarena/
sudo install -m 644 deploy/linux/streamarena-backup.service deploy/linux/streamarena-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now streamarena-backup.timer
sudo systemctl start streamarena-backup.service
sudo systemctl status streamarena-backup.service --no-pager
sudo systemctl list-timers streamarena-backup.timer
```

At 04:15 UTC daily, plus up to ten minutes of jitter, the root service backs up
both complete SQLite databases using the online backup API, verifies integrity,
and archives library metadata/artwork. It includes committed WAL pages. Each
database is transactionally consistent; the live daily job does **not** claim an
atomic snapshot across databases and assets. Deployment backups stop writes first
and use `--quiesced`, which rejects pending WAL/journal data and detects source
changes without creating root-owned database sidecars.
An incomplete backup is removed and never published as a completed backup.

The timer is intended to back up the running backend. When it is stopped,
online mode can fail if SQLite needs missing WAL sidecars on the read-only
source filesystem. Confirm the backend and any other writers are stopped,
then take an explicit offline backup:

```sh
sudo python3 /usr/local/libexec/streamarena/backup-streamarena.py --source /opt/streamarena/current --output-root /var/backups/streamarena --name-prefix deploy --quiesced
```

If this refuses pending WAL/journal data, preserve those files; do not delete
them or force immutable reads. There is no automatic immutable fallback.

Directories are root-owned mode `700`; databases, archives and manifests are
mode `600`. Completed `daily-*` backups older than fourteen days are pruned only
after a new backup succeeds. Deployment snapshots and unrelated directories are
never pruned by this timer. The archive excludes `assets/videos/` and generated
caches; back up local video files separately if they are not reproducible.
These local backups do not protect against loss of the VM: keep an encrypted
off-host copy. Retention here makes no claim to provide that off-host copy.

## Rollback

For an app-only failure with a database schema compatible with the earlier
release, stop the service, atomically point `/opt/streamarena/current` to the
recorded previous release, then start and verify it. The deploy script intentionally
does not automatically downgrade a running binary after a failed health check:
database migrations might not be reversible.

For a host rollback, first stop Oracle writes and take fresh SQLite backups plus
an assets delta. Move that latest durable state back to the Mini before restoring
its routes. Restoring the frozen pre-cutover database would lose users' new
progress and changes. Use pre-deployment snapshots only when deliberately
recovering data corruption or an incompatible schema, with the data-loss window
understood. Never start both hosts as independent writers.

Useful inspection commands:

```sh
sudo systemctl status streamarena.service --no-pager
sudo journalctl -u streamarena.service -n 100 --no-pager
readlink /opt/streamarena/current
cat /opt/streamarena/current/.release-commit
curl --fail http://127.0.0.1:5173/api/health/live
```

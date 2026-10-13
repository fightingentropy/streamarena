#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
ORACLE_HOST="${ORACLE_HOST:-oracle}"
ACTIVATE=0
CHECK=1

usage() {
  cat <<'USAGE'
Usage: scripts/deploy-oracle.sh [--activate] [--skip-check]

Stage the clean, committed HEAD on Oracle. Build the frontend locally and Rust
on the Linux host; never reuse a Mac binary or an unverified staging build.
The default only stages a release. --activate switches the current symlink,
restarts the installed systemd service and checks loopback liveness.

Prerequisites and first migration: docs/oracle-deployment.md.
ORACLE_HOST selects an existing SSH alias (default: oracle). Passwordless sudo,
Rust, Node, ffmpeg and the documented service/data layout must exist there.

--skip-check skips the local full quality gate when that exact commit has
already passed it. It still rebuilds both frontend and Linux backend.
Activation does not automatically downgrade after failure: database migrations
may be forward-only. Previous releases and a SQLite backup are retained.
This script never edits DNS, private environment values, or migrated assets.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --activate) ACTIVATE=1; shift ;;
    --skip-check) CHECK=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$ORACLE_HOST" =~ ^[[:alnum:]_][[:alnum:]_.@-]*$ ]] || {
  echo "ORACLE_HOST must be a plain SSH alias or user@host." >&2; exit 2;
}
assert_clean() {
  [[ -z "$(git status --porcelain --untracked-files=normal)" ]] || {
    echo "Commit or move local changes before deploying an exact release." >&2; exit 1;
  }
}
assert_clean
SHA="$(git rev-parse HEAD)"
DEPLOY_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
SSH=(ssh -o BatchMode=yes "$ORACLE_HOST")

if [[ "$CHECK" -eq 1 ]]; then
  bun run check
else
  bun run build
fi
assert_clean
[[ "$(git rev-parse HEAD)" == "$SHA" ]] || {
  echo "HEAD changed during validation; retry deployment." >&2; exit 1;
}
[[ -f dist/index.html && -f dist/player.html ]] || {
  echo "Frontend build is incomplete." >&2; exit 1;
}

# Only a unique, unprivileged build directory receives the transferred files.
# Durable files are never rsynced from the development checkout.
"${SSH[@]}" "bash -s -- '$SHA' '$DEPLOY_ID'" <<'REMOTE'
set -euo pipefail
sha="$1"
deploy_id="$2"
command -v node >/dev/null
command -v ffmpeg >/dev/null
command -v ffprobe >/dev/null
"$HOME/.cargo/bin/cargo" --version
sudo -n test -f /etc/streamarena/env
sudo -n test -f /var/lib/streamarena/assets/library.json
sudo -n test -d /var/lib/streamarena/cache
sudo -n test -f /opt/streamarena/runtime/node_modules/playwright/package.json
sudo -n -u streamarena test -r /var/lib/streamarena/assets/library.json
build_dir="$HOME/.local/share/streamarena-build/$sha-$deploy_id"
mkdir -p "$build_dir/dist"
REMOTE

REMOTE_BUILD=".local/share/streamarena-build/$SHA-$DEPLOY_ID"
git archive --format=tar "$SHA" | "${SSH[@]}" "tar -xf - -C '$REMOTE_BUILD'"
tar -czf - -C dist . | "${SSH[@]}" "tar -xzf - -C '$REMOTE_BUILD/dist'"

"${SSH[@]}" "bash -s -- '$SHA' '$DEPLOY_ID' '$ACTIVATE'" <<'REMOTE'
set -euo pipefail
umask 077
sha="$1"
deploy_id="$2"
activate="$3"
build_dir="$HOME/.local/share/streamarena-build/$sha-$deploy_id"
release="/opt/streamarena/releases/$sha"
stage="/opt/streamarena/releases/.$sha-$deploy_id"
export PATH="$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin"
export CARGO_TARGET_DIR="$HOME/.local/share/streamarena-build/target"
# Serialize the shared build output and the release switch across SSH callers.
# Keep one persistent inode; replacing the lock file would break mutual exclusion.
sudo -n touch /opt/streamarena/.deploy.lock
sudo -n chmod 644 /opt/streamarena/.deploy.lock
exec 9</opt/streamarena/.deploy.lock
flock -n 9 || { echo "Another Oracle deployment is running." >&2; exit 1; }
cd "$build_dir"
cargo build --release --locked -j 2

if ! sudo -n test -d "$release"; then
  sudo -n install -d -m 755 "$stage/bin/lib"
  sudo -n cp -R dist "$stage/dist"
  sudo -n install -m 755 "$CARGO_TARGET_DIR/release/streamarena-backend" "$stage/bin/"
  for name in resolve-external-embed-hls resolve-streamed-hls resolve-matchstream-hls \
    resolve-ntvs-hls resolve-cdnlivetv-hls fetch-browser-live-hls resolve-embed-min \
    serve-browser-hls-session check-resolver-runtime; do
    sudo -n install -m 644 "scripts/$name.mjs" "$stage/bin/"
  done
  sudo -n install -m 644 scripts/backup-streamarena.py scripts/snapshot-streamarena.py "$stage/bin/"
  sudo -n cp -R scripts/lib/. "$stage/bin/lib/"
  printf '%s\n' "$sha" | sudo -n tee "$stage/.release-commit" >/dev/null
  sudo -n ln -s /var/lib/streamarena/cache "$stage/cache"
  sudo -n ln -s /var/lib/streamarena/assets "$stage/assets"
  sudo -n chown -R root:root "$stage"
  sudo -n find "$stage" -type d -exec chmod 755 {} +
  sudo -n find "$stage" -type f ! -name streamarena-backend -exec chmod 644 {} +
  sudo -n -u streamarena env HOME=/var/lib/streamarena \
    PLAYWRIGHT_BROWSERS_PATH=/var/lib/streamarena/.cache/ms-playwright \
    STREAMARENA_NODE_DEPS_DIR=/opt/streamarena/runtime \
    /usr/local/bin/node "$stage/bin/check-resolver-runtime.mjs" "$stage/bin"
  sudo -n mv "$stage" "$release"
else
  [[ "$(sudo -n cat "$release/.release-commit")" == "$sha" ]]
  echo "Retaining existing immutable release $release"
fi

echo "Staged $release"
if [[ "$activate" != 1 ]]; then
  echo "Current service and traffic are unchanged. Rerun with --activate when ready."
  exit 0
fi

# A missing users database must never silently turn a deployment into a fresh
# installation. Stop writes before the backup, so it captures the final state
# before a new binary can migrate either database or mutate the local library.
sudo -n test -s /var/lib/streamarena/cache/users.sqlite
sudo -n test -s /var/lib/streamarena/cache/resolver-cache.sqlite
previous="$(readlink /opt/streamarena/current 2>/dev/null || true)"
previous_running=0
if sudo -n systemctl is-active --quiet streamarena.service; then
  previous_running=1
fi
activated=0
recover_before_activation() {
  local status=$?
  trap - EXIT
  # Never move the symlink backwards. Only restart a previously running service
  # while its original release is still selected and no activation occurred.
  if [[ "$status" -ne 0 && "$activated" -eq 0 && "$previous_running" -eq 1 \
    && "$(readlink /opt/streamarena/current 2>/dev/null || true)" == "$previous" ]]; then
    echo "Deployment failed before activation; restarting the unchanged prior release." >&2
    if ! sudo -n systemctl start streamarena.service; then
      echo "Recovery start failed; inspect streamarena.service immediately." >&2
    fi
  fi
  exit "$status"
}
trap recover_before_activation EXIT
sudo -n systemctl stop streamarena.service
sudo -n install -d -m 700 /var/backups/streamarena
backup_source=/opt/streamarena/current
if ! sudo -n test -f "$backup_source/.release-commit"; then
  backup_source="$release"
fi
if ! sudo -n /usr/bin/python3 "$release/bin/backup-streamarena.py" \
  --source "$backup_source" --output-root /var/backups/streamarena \
  --name-prefix deploy --retention-days 14 --quiesced; then
  echo "Backup failed; old release remains selected." >&2
  exit 1
fi

printf '%s\n' "$previous" | sudo -n tee "/var/backups/streamarena/$deploy_id-previous-release" >/dev/null
sudo -n ln -s "$release" "/opt/streamarena/.current-$deploy_id"
sudo -n mv -Tf "/opt/streamarena/.current-$deploy_id" /opt/streamarena/current
activated=1
sudo -n systemctl restart streamarena.service
for attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:5173/api/health/live >/dev/null; then
    sudo -n systemctl is-active --quiet streamarena.service
    pid="$(sudo -n systemctl show streamarena.service --property=MainPID --value)"
    [[ "$pid" =~ ^[1-9][0-9]*$ ]]
    if [[ "$(sudo -n readlink "/proc/$pid/exe")" != "$release/bin/streamarena-backend" \
      || "$(sudo -n readlink "/proc/$pid/cwd")" != "$release" ]]; then
      echo "Service executable or working directory does not match the selected release." >&2
      exit 1
    fi
    echo "Active release: $sha; loopback liveness passed."
    echo "Still verify public HTTPS, authentication, decoded playback and seeking."
    exit 0
  fi
  sleep 1
done
echo "Liveness failed. New release retained for diagnosis; no automatic DB downgrade." >&2
echo "Inspect: sudo journalctl -u streamarena.service -n 100 --no-pager" >&2
exit 1
REMOTE

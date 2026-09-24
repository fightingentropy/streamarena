#!/usr/bin/env bash
set -euo pipefail
umask 077

MINI_HOST="${MINI_HOST:-hermes@m4mini.local}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_codex_m4mini}"
REMOTE_APP="${REMOTE_APP:-/Users/hermes/Developer/streamarena}"
INCLUDE_RUNTIME=1

usage() {
  cat <<'USAGE'
Usage: scripts/backup-mini.sh [--config-only] <backup-root>

Creates a timestamped Mac mini server backup. Use an external drive or another
large volume for full backups because assets and caches can be large.

Backed up by default:
  - /Users/hermes/Developer/streamarena/{assets,bin,cache,dist}
  - /Users/hermes/.config/streamarena/env
  - /Users/hermes/.config/caddy config
  - /Users/hermes/.local/bin/streamarena-run-backend
  - /Library/Application Support/StreamArena/{maintenance.py,settings.json}
  - Active StreamArena cloudflared config and its referenced tunnel credential
  - System LaunchDaemon plists for the app/Caddy/maintenance jobs

Options:
  --config-only   Back up secrets, Caddy config, scripts, and plists only.
  -h, --help      Show this help.
USAGE
}

backup_root=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config-only)
      INCLUDE_RUNTIME=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -n "$backup_root" ]]; then
        echo "Unexpected argument: $1" >&2
        usage >&2
        exit 2
      fi
      backup_root="$1"
      shift
      ;;
  esac
done

if [[ -z "$backup_root" ]]; then
  usage >&2
  exit 2
fi

mkdir -p "$backup_root"
backup_root="$(cd "$backup_root" && pwd)"
stamp="$(date +%Y%m%d-%H%M%S)"
snapshot="$backup_root/$stamp"
mkdir -p "$snapshot"

SSH_BASE=(ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10)
RSYNC_SSH="ssh -i $SSH_KEY -o BatchMode=yes -o ConnectTimeout=10"

rsync_remote() {
  local src="$1"
  local dest="$2"
  shift 2
  mkdir -p "$(dirname "$dest")"
  rsync -a "$@" -e "$RSYNC_SSH" "$MINI_HOST:$src" "$dest"
}

rsync_remote_dir() {
  local src="$1"
  local dest="$2"
  shift 2
  local link_dest=""
  if [[ $# -gt 0 ]]; then
    link_dest="$1"
    shift
  fi
  mkdir -p "$dest"
  if [[ -n "$link_dest" && -d "$link_dest" ]]; then
    rsync -a --delete --link-dest="$link_dest" "$@" -e "$RSYNC_SSH" "$MINI_HOST:$src/" "$dest/"
  else
    rsync -a --delete "$@" -e "$RSYNC_SSH" "$MINI_HOST:$src/" "$dest/"
  fi
}

remote_db_snapshot=""
remote_caddy_snapshot=""
remote_tunnel_snapshot=""
cleanup_remote_snapshots() {
  if [[ "$remote_db_snapshot" == /tmp/streamarena-db-backup.* ]]; then
    "${SSH_BASE[@]}" "$MINI_HOST" "rm -rf -- '$remote_db_snapshot'" >/dev/null 2>&1 || true
  fi
  if [[ "$remote_caddy_snapshot" == /tmp/streamarena-caddy-backup.* ]]; then
    "${SSH_BASE[@]}" "$MINI_HOST" "rm -rf -- '$remote_caddy_snapshot'" >/dev/null 2>&1 || true
  fi
  if [[ "$remote_tunnel_snapshot" == /tmp/streamarena-tunnel-backup.* ]]; then
    "${SSH_BASE[@]}" "$MINI_HOST" "rm -rf -- '$remote_tunnel_snapshot'" >/dev/null 2>&1 || true
  fi
}
trap cleanup_remote_snapshots EXIT

previous=""
if [[ -L "$backup_root/latest" ]]; then
  previous="$(readlink "$backup_root/latest")"
  [[ "$previous" = /* ]] || previous="$backup_root/$previous"
fi

if [[ "$INCLUDE_RUNTIME" -eq 1 ]]; then
  # Copy immutable SQLite snapshots instead of racing the live database and WAL
  # files. `.backup` is transactionally consistent while the service remains up.
  remote_db_snapshot="$("${SSH_BASE[@]}" "$MINI_HOST" "REMOTE_APP='$REMOTE_APP' bash -s" <<'REMOTE'
set -euo pipefail
umask 077
snapshot_dir="$(mktemp -d /tmp/streamarena-db-backup.XXXXXX)"
trap 'rm -rf "$snapshot_dir"' ERR
for name in users resolver-cache; do
  source_db="$REMOTE_APP/cache/$name.sqlite"
  snapshot_db="$snapshot_dir/$name.sqlite"
  [[ -f "$source_db" ]] || { echo "Missing database: $source_db" >&2; exit 1; }
  sqlite3 "$source_db" ".backup '$snapshot_db'"
  # `query_only` prevents accidental mutation while avoiding a macOS sqlite3
  # `-readonly` open race observed immediately after `.backup` creates a 0600
  # WAL-mode snapshot.
  [[ "$(sqlite3 "$snapshot_db" 'PRAGMA query_only=ON; PRAGMA quick_check;')" == "ok" ]] || {
    echo "SQLite quick_check failed for $name.sqlite" >&2
    exit 1
  }
  chmod 600 "$snapshot_db"
done
trap - ERR
printf '%s\n' "$snapshot_dir"
REMOTE
)"
  rsync_remote_dir "$REMOTE_APP/assets" "$snapshot/runtime/assets" "${previous:+$previous/runtime/assets}"
  rsync_remote_dir "$REMOTE_APP/bin" "$snapshot/runtime/bin" "${previous:+$previous/runtime/bin}"
  rsync_remote_dir "$REMOTE_APP/cache" "$snapshot/runtime/cache" "${previous:+$previous/runtime/cache}" \
    --exclude='users.sqlite*' --exclude='resolver-cache.sqlite*'
  rsync_remote "$remote_db_snapshot/users.sqlite" "$snapshot/runtime/cache/users.sqlite"
  rsync_remote "$remote_db_snapshot/resolver-cache.sqlite" "$snapshot/runtime/cache/resolver-cache.sqlite"
  cleanup_remote_snapshots
  remote_db_snapshot=""
  rsync_remote_dir "$REMOTE_APP/dist" "$snapshot/runtime/dist" "${previous:+$previous/runtime/dist}"
fi

mkdir -p "$snapshot/config" "$snapshot/caddy" "$snapshot/local-bin" "$snapshot/plists" "$snapshot/maintenance"
rsync_remote "/Users/hermes/.config/streamarena/env" "$snapshot/config/env"
# Caddy's production config is intentionally root-owned and 0600. Stage a
# short-lived, hermes-readable copy on the mini so rsync can back it up without
# weakening the live file's permissions or requiring a privileged rsync daemon.
remote_caddy_snapshot="$("${SSH_BASE[@]}" "$MINI_HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
umask 077
snapshot_dir="$(mktemp -d /tmp/streamarena-caddy-backup.XXXXXX)"
trap 'rm -rf "$snapshot_dir"' ERR
sudo -n cp -R "$HOME/.config/caddy/." "$snapshot_dir/"
sudo -n chown -R "$(id -u):$(id -g)" "$snapshot_dir"
find "$snapshot_dir" -type d -exec chmod 700 {} +
find "$snapshot_dir" -type f -exec chmod 600 {} +
trap - ERR
printf '%s\n' "$snapshot_dir"
REMOTE
)"
rsync_remote_dir "$remote_caddy_snapshot" "$snapshot/caddy"
cleanup_remote_snapshots
remote_caddy_snapshot=""
rsync_remote "/Users/hermes/.local/bin/streamarena-run-backend" "$snapshot/local-bin/streamarena-run-backend"
# Stream only the installed root-owned helper/config, not maintenance logs,
# archives, locks, or prior installer snapshots. Quoting also supports the space
# in Application Support with the older rsync shipped by macOS.
"${SSH_BASE[@]}" "$MINI_HOST" \
  "sudo -n /usr/bin/tar -C '/Library/Application Support/StreamArena' -cf - maintenance.py settings.json" | \
  tar -xf - -C "$snapshot/maintenance"
rsync_remote "/Library/LaunchDaemons/com.fightingentropy.streamarena-app.plist" "$snapshot/plists/com.fightingentropy.streamarena-app.plist"
rsync_remote "/Library/LaunchDaemons/com.fightingentropy.streamarena-caddy.plist" "$snapshot/plists/com.fightingentropy.streamarena-caddy.plist"
rsync_remote "/Library/LaunchDaemons/com.fightingentropy.streamarena-log-rotation.plist" "$snapshot/plists/com.fightingentropy.streamarena-log-rotation.plist"
rsync_remote "/Library/LaunchDaemons/com.fightingentropy.streamarena-disk-monitor.plist" "$snapshot/plists/com.fightingentropy.streamarena-disk-monitor.plist"
rsync_remote "/Library/LaunchDaemons/com.fightingentropy.streamarena-watchdog.plist" "$snapshot/plists/com.fightingentropy.streamarena-watchdog.plist"

# Derive the active config from this one service, then include only the credential
# it references. Never copy the shared cloudflared directory or certificate.
remote_tunnel_snapshot="$("${SSH_BASE[@]}" "$MINI_HOST" 'sudo -n /usr/bin/python3 -' <<'REMOTE'
import json
import os
from pathlib import Path
import plistlib
import pwd
import re
import shlex
import shutil
import tempfile
import uuid

os.umask(0o077)
label = "com.cloudflare.cloudflared.streamarena"
plist = Path("/Library/LaunchDaemons") / (label + ".plist")
job = plistlib.loads(plist.read_bytes())
assert job["Label"] == label, "Unexpected tunnel service"
args = job["ProgramArguments"]
assert args.count("--config") == 1, "Expected one explicit tunnel config"
config = Path(args[args.index("--config") + 1])
assert config.is_absolute() and config.is_file() and not config.is_symlink(), "Invalid tunnel config path"
original = config.read_text()

def scalar(key):
    matches = re.findall(r"(?m)^" + re.escape(key) + r":\s*([^\n]+)$", original)
    assert len(matches) == 1, "Expected one explicit " + key
    values = shlex.split(matches[0], comments=True)
    assert len(values) == 1, "Expected simple scalar for " + key
    return values[0]

tunnel_id = str(uuid.UUID(scalar("tunnel")))
credential = Path(scalar("credentials-file"))
assert credential.is_absolute() and credential.is_file() and not credential.is_symlink(), "Invalid tunnel credential path"
assert credential.parent.resolve() == config.parent.resolve(), "Tunnel credential must be beside its config"
assert credential.name == tunnel_id + ".json", "Unexpected tunnel credential filename"
try:
    data = json.loads(credential.read_text())
    assert str(uuid.UUID(data["TunnelID"])) == tunnel_id
    assert data["AccountTag"] and data["TunnelSecret"]
except (ValueError, KeyError, TypeError, AssertionError):
    raise RuntimeError("Tunnel credential does not match active config") from None

directory = Path(tempfile.mkdtemp(prefix="streamarena-tunnel-backup.", dir="/tmp"))
try:
    owner = pwd.getpwnam("hermes")
    paths = {"config.yml": config, credential.name: credential, plist.name: plist}
    for name, source in paths.items():
        shutil.copyfile(source, directory / name)
    (directory / "source-paths.json").write_text(json.dumps({name: str(path) for name, path in paths.items()}, indent=2))
    for path in directory.iterdir():
        path.chmod(0o600)
        os.chown(path, owner.pw_uid, owner.pw_gid)
    directory.chmod(0o700)
    os.chown(directory, owner.pw_uid, owner.pw_gid)
except Exception:
    shutil.rmtree(directory)
    raise
print(directory)
REMOTE
)"
rsync_remote_dir "$remote_tunnel_snapshot" "$snapshot/tunnel"
cleanup_remote_snapshots
remote_tunnel_snapshot=""

# Archive tools preserve source modes; configuration copies should remain private
# even when the production helper/plist is intentionally world-readable.
find "$snapshot/config" "$snapshot/caddy" "$snapshot/local-bin" "$snapshot/plists" "$snapshot/maintenance" "$snapshot/tunnel" \
  -type d -exec chmod 700 {} +
find "$snapshot/config" "$snapshot/caddy" "$snapshot/local-bin" "$snapshot/plists" "$snapshot/maintenance" "$snapshot/tunnel" \
  -type f -exec chmod 600 {} +

"${SSH_BASE[@]}" "$MINI_HOST" "REMOTE_APP='$REMOTE_APP' bash -s" > "$snapshot/manifest.txt" <<'REMOTE'
set -euo pipefail
printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'host=%s\n' "$(hostname)"
printf 'runtime_path=%s\n' "$REMOTE_APP"
printf 'caddy='
/usr/local/bin/caddy version | awk '{print $1}'
printf 'runtime_tree='
find "$REMOTE_APP" -maxdepth 1 -mindepth 1 -exec basename {} \; | sort | paste -sd, -
printf '\nasset_files='
find "$REMOTE_APP/assets" -type f | wc -l | tr -d ' '
printf '\nasset_symlinks='
find "$REMOTE_APP/assets" -type l | wc -l | tr -d ' '
printf '\ndisk='
df -h "$REMOTE_APP" | awk 'NR == 2 {print $4 " free, " $5 " used"}'
REMOTE

ln -sfn "$stamp" "$backup_root/latest"
if [[ "$INCLUDE_RUNTIME" -eq 1 ]]; then
  printf 'users_db_quick_check=ok\nresolver_cache_quick_check=ok\n' >> "$snapshot/manifest.txt"
fi
printf 'backup=%s\n' "$snapshot"
printf 'latest=%s\n' "$backup_root/latest"

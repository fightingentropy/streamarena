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
large volume for full backups because assets are about 153G.

Backed up by default:
  - /Users/hermes/Developer/streamarena/{assets,bin,cache,dist}
  - /Users/hermes/.config/streamarena/env
  - /Users/hermes/.config/caddy config
  - /Users/hermes/.local/bin server helper scripts
  - LaunchDaemon and LaunchAgent plists for the app/Caddy/maintenance jobs

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

SSH_BASE=(ssh -i "$SSH_KEY" -o BatchMode=yes)
RSYNC_SSH="ssh -i $SSH_KEY -o BatchMode=yes"

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
cleanup_remote_db_snapshot() {
  if [[ "$remote_db_snapshot" == /tmp/streamarena-db-backup.* ]]; then
    "${SSH_BASE[@]}" "$MINI_HOST" "rm -rf -- '$remote_db_snapshot'" >/dev/null 2>&1 || true
  fi
}
trap cleanup_remote_db_snapshot EXIT

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
  cleanup_remote_db_snapshot
  remote_db_snapshot=""
  rsync_remote_dir "$REMOTE_APP/dist" "$snapshot/runtime/dist" "${previous:+$previous/runtime/dist}"
fi

mkdir -p "$snapshot/config" "$snapshot/caddy" "$snapshot/local-bin" "$snapshot/plists"
rsync_remote "/Users/hermes/.config/streamarena/env" "$snapshot/config/env"
rsync -a --exclude='*.log' --exclude='*.err.log' -e "$RSYNC_SSH" "$MINI_HOST:/Users/hermes/.config/caddy/" "$snapshot/caddy/"
rsync_remote "/Users/hermes/.local/bin/streamarena-run-backend" "$snapshot/local-bin/streamarena-run-backend"
rsync_remote "/Users/hermes/.local/bin/streamarena-rotate-logs" "$snapshot/local-bin/streamarena-rotate-logs"
rsync_remote "/Users/hermes/.local/bin/streamarena-disk-monitor" "$snapshot/local-bin/streamarena-disk-monitor"
rsync_remote "/Users/hermes/.local/bin/streamarena-watchdog" "$snapshot/local-bin/streamarena-watchdog"
rsync_remote "/Library/LaunchDaemons/com.fightingentropy.streamarena-app.plist" "$snapshot/plists/com.fightingentropy.streamarena-app.plist"
rsync_remote "/Library/LaunchDaemons/com.fightingentropy.streamarena-caddy.plist" "$snapshot/plists/com.fightingentropy.streamarena-caddy.plist"
rsync_remote "/Users/hermes/Library/LaunchAgents/com.fightingentropy.streamarena-log-rotation.plist" "$snapshot/plists/com.fightingentropy.streamarena-log-rotation.plist"
rsync_remote "/Users/hermes/Library/LaunchAgents/com.fightingentropy.streamarena-disk-monitor.plist" "$snapshot/plists/com.fightingentropy.streamarena-disk-monitor.plist"
rsync_remote "/Users/hermes/Library/LaunchAgents/com.fightingentropy.streamarena-watchdog.plist" "$snapshot/plists/com.fightingentropy.streamarena-watchdog.plist"

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

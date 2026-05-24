#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MINI_HOST="${MINI_HOST:-hermes@m4mini.local}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_codex_m4mini}"
REMOTE_APP="${REMOTE_APP:-/Users/hermes/Developer/netflix}"

SKIP_BUILD=0
RESTART=1
VIDEOS=()

usage() {
  cat <<'USAGE'
Usage: scripts/deploy-mini.sh [options]

Builds on the MacBook, deploys runtime artifacts to the Mac mini, restarts the
backend through launchd, then runs scripts/check-mini.sh.

Options:
  --skip-build         Reuse existing dist/ and target/release binary.
  --no-restart         Sync files but do not restart the backend.
  --video <path>       Also copy one symlinked/local video target as a real file
                       to the Mac mini assets/videos directory. May be repeated.
  -h, --help           Show this help.

Environment:
  MINI_HOST            Default: hermes@m4mini.local
  SSH_KEY              Default: ~/.ssh/id_ed25519_codex_m4mini
  REMOTE_APP           Default: /Users/hermes/Developer/netflix
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --no-restart)
      RESTART=0
      shift
      ;;
    --video)
      [[ $# -ge 2 ]] || { echo "--video requires a path" >&2; exit 2; }
      VIDEOS+=("$2")
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

SSH_BASE=(ssh -i "$SSH_KEY" -o BatchMode=yes)
RSYNC_SSH="ssh -i $SSH_KEY -o BatchMode=yes"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  bun run build
  cargo build --release
fi

[[ -d dist ]] || { echo "Missing dist/. Run without --skip-build first." >&2; exit 1; }
[[ -x target/release/netflix-rust-backend ]] || { echo "Missing target/release/netflix-rust-backend. Run without --skip-build first." >&2; exit 1; }

"${SSH_BASE[@]}" "$MINI_HOST" "mkdir -p '$REMOTE_APP/dist' '$REMOTE_APP/bin' '$REMOTE_APP/assets/images' '$REMOTE_APP/assets/icons' '$REMOTE_APP/assets/videos'"

rsync -a --delete -e "$RSYNC_SSH" dist/ "$MINI_HOST:$REMOTE_APP/dist/"

rsync -a -e "$RSYNC_SSH" target/release/netflix-rust-backend "$MINI_HOST:$REMOTE_APP/bin/netflix-rust-backend.new"
"${SSH_BASE[@]}" "$MINI_HOST" "chmod 755 '$REMOTE_APP/bin/netflix-rust-backend.new' && mv '$REMOTE_APP/bin/netflix-rust-backend.new' '$REMOTE_APP/bin/netflix-rust-backend'"

rsync -a -e "$RSYNC_SSH" assets/library.json "$MINI_HOST:$REMOTE_APP/assets/library.json"
rsync -a --delete -e "$RSYNC_SSH" assets/images/ "$MINI_HOST:$REMOTE_APP/assets/images/"
rsync -a --delete -e "$RSYNC_SSH" assets/icons/ "$MINI_HOST:$REMOTE_APP/assets/icons/"

if [[ "${#VIDEOS[@]}" -gt 0 ]]; then
  for video in "${VIDEOS[@]}"; do
    if [[ "$video" != assets/videos/* ]]; then
      echo "Refusing video outside assets/videos: $video" >&2
      exit 1
    fi
    if [[ ! -e "$video" ]]; then
      echo "Video path does not resolve: $video" >&2
      exit 1
    fi
    name="$(basename "$video")"
    rsync -aL --partial -e "$RSYNC_SSH" "$video" "$MINI_HOST:$REMOTE_APP/assets/videos/$name"
  done
fi

if [[ "$RESTART" -eq 1 ]]; then
  "${SSH_BASE[@]}" "$MINI_HOST" "pkill -TERM -f '$REMOTE_APP/bin/netflix-rust-backend' || true"
  sleep 4
fi

"$ROOT_DIR/scripts/install-mini-agents.sh"
"$ROOT_DIR/scripts/check-mini.sh"

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MINI_HOST="${MINI_HOST:-hermes@m4mini.local}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_codex_m4mini}"
REMOTE_APP="${REMOTE_APP:-/Users/hermes/Developer/netflix}"
PLAYWRIGHT_VERSION="${PLAYWRIGHT_VERSION:-^1.54.2}"
LIBSODIUM_WRAPPERS_VERSION="${LIBSODIUM_WRAPPERS_VERSION:-^0.8.4}"

SKIP_BUILD=0
SKIP_CHECK=0
ALLOW_STALE=0
RESTART=1
VIDEOS=()

usage() {
  cat <<'USAGE'
Usage: scripts/deploy-mini.sh [options]

Builds on the MacBook, deploys runtime artifacts to the Mac mini, restarts the
backend through launchd, then runs scripts/check-mini.sh.

By default this runs `bun run check` (lint + build + arch + Rust tests +
frontend tests) before shipping, so broken code can't be deployed. With
--skip-build it also refuses to deploy a release binary that is older than the
Rust sources, which is what caused past "stale binary" deploys.

Options:
  --skip-build         Reuse existing dist/ and target/release binary. Refuses
                       to proceed if the binary is older than src/ or the Cargo
                       manifests (override with --allow-stale).
  --skip-check         Skip the pre-deploy `bun run check` gate (faster, unsafe).
  --allow-stale        With --skip-build, deploy even if the binary looks stale.
  --no-restart         Sync files but do not restart the backend.
  --video <path>       Also copy one symlinked/local video target as a real file
                       to the Mac mini assets/videos directory. May be repeated.
  -h, --help           Show this help.

Environment:
  MINI_HOST            Default: hermes@m4mini.local
  SSH_KEY              Default: ~/.ssh/id_ed25519_codex_m4mini
  REMOTE_APP           Default: /Users/hermes/Developer/netflix
  PLAYWRIGHT_VERSION   Default: ^1.54.2
  LIBSODIUM_WRAPPERS_VERSION
                       Default: ^0.8.4
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --skip-check)
      SKIP_CHECK=1
      shift
      ;;
    --allow-stale)
      ALLOW_STALE=1
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

BACKEND_BIN="target/release/netflix-rust-backend"

# Fail if any path in $@ is newer than the reference artifact. Uses `find
# -newer ... -print -quit`, which behaves identically on BSD/macOS and GNU find
# (no `stat` format differences), and stops at the first offending file.
assert_artifact_fresh() {
  local label="$1" artifact="$2"
  shift 2
  [[ -e "$artifact" ]] || return 0 # existence is checked separately below
  local newer
  newer="$(find "$@" -newer "$artifact" -print -quit 2>/dev/null || true)"
  if [[ -n "$newer" ]]; then
    echo "Refusing --skip-build: $label is older than the source tree." >&2
    echo "  changed since last build: $newer" >&2
    echo "  rebuild without --skip-build, or pass --allow-stale to override." >&2
    exit 1
  fi
}

# Pre-deploy validation gate: lint, build, architecture check, and the Rust +
# frontend test suites. Skipping this is what let broken code reach the mini.
if [[ "$SKIP_CHECK" -eq 0 ]]; then
  bun run check
fi

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  export CARGO_TARGET_DIR="$ROOT_DIR/target"
  # `bun run check` already produced dist/ via `vite build`; only rebuild the
  # frontend here when the check gate was skipped. The release binary is always
  # built (check runs the debug `cargo test`, not a release build).
  if [[ "$SKIP_CHECK" -ne 0 ]]; then
    bun run build
  fi
  cargo build --release
elif [[ "$ALLOW_STALE" -eq 0 ]]; then
  # Reusing a prebuilt binary: make sure it isn't older than the Rust sources,
  # so `--skip-build` can never silently ship a stale binary.
  assert_artifact_fresh "release binary ($BACKEND_BIN)" "$BACKEND_BIN" \
    src Cargo.toml Cargo.lock
fi

[[ -d dist ]] || { echo "Missing dist/. Run without --skip-build first." >&2; exit 1; }
[[ -x "$BACKEND_BIN" ]] || { echo "Missing $BACKEND_BIN. Run without --skip-build first." >&2; exit 1; }

"${SSH_BASE[@]}" "$MINI_HOST" "mkdir -p '$REMOTE_APP/dist' '$REMOTE_APP/bin' '$REMOTE_APP/assets/images' '$REMOTE_APP/assets/icons' '$REMOTE_APP/assets/videos'"

rsync -a --delete -e "$RSYNC_SSH" dist/ "$MINI_HOST:$REMOTE_APP/dist/"

rsync -a -e "$RSYNC_SSH" target/release/netflix-rust-backend "$MINI_HOST:$REMOTE_APP/bin/netflix-rust-backend.new"
"${SSH_BASE[@]}" "$MINI_HOST" "chmod 755 '$REMOTE_APP/bin/netflix-rust-backend.new' && mv '$REMOTE_APP/bin/netflix-rust-backend.new' '$REMOTE_APP/bin/netflix-rust-backend'"
rsync -a -e "$RSYNC_SSH" scripts/resolve-external-embed-hls.mjs "$MINI_HOST:$REMOTE_APP/bin/resolve-external-embed-hls.mjs"
rsync -a -e "$RSYNC_SSH" scripts/resolve-streamed-hls.mjs "$MINI_HOST:$REMOTE_APP/bin/resolve-streamed-hls.mjs"
rsync -a -e "$RSYNC_SSH" scripts/resolve-matchstream-hls.mjs "$MINI_HOST:$REMOTE_APP/bin/resolve-matchstream-hls.mjs"
rsync -a -e "$RSYNC_SSH" scripts/resolve-ntvs-hls.mjs "$MINI_HOST:$REMOTE_APP/bin/resolve-ntvs-hls.mjs"
rsync -a -e "$RSYNC_SSH" scripts/fetch-browser-live-hls.mjs "$MINI_HOST:$REMOTE_APP/bin/fetch-browser-live-hls.mjs"
rsync -a -e "$RSYNC_SSH" scripts/resolve-embed-min.mjs "$MINI_HOST:$REMOTE_APP/bin/resolve-embed-min.mjs"
"${SSH_BASE[@]}" "$MINI_HOST" "chmod 755 '$REMOTE_APP/bin/resolve-external-embed-hls.mjs' '$REMOTE_APP/bin/resolve-streamed-hls.mjs' '$REMOTE_APP/bin/resolve-matchstream-hls.mjs' '$REMOTE_APP/bin/resolve-ntvs-hls.mjs' '$REMOTE_APP/bin/fetch-browser-live-hls.mjs' '$REMOTE_APP/bin/resolve-embed-min.mjs'"

rsync -a -e "$RSYNC_SSH" assets/library.json "$MINI_HOST:$REMOTE_APP/assets/library.json"
rsync -a --delete -e "$RSYNC_SSH" assets/images/ "$MINI_HOST:$REMOTE_APP/assets/images/"
rsync -a --delete -e "$RSYNC_SSH" assets/icons/ "$MINI_HOST:$REMOTE_APP/assets/icons/"

"${SSH_BASE[@]}" "$MINI_HOST" "PLAYWRIGHT_VERSION='$PLAYWRIGHT_VERSION' LIBSODIUM_WRAPPERS_VERSION='$LIBSODIUM_WRAPPERS_VERSION' bash -s" <<'REMOTE'
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
deps_dir="${NETFLIX_NODE_DEPS_DIR:-$HOME/.local/share/netflix-node}"
node_bin="${NODE_BIN:-$(command -v node || true)}"
bun_bin="${BUN_BIN:-$(command -v bun || true)}"
if [[ -z "$node_bin" || -z "$bun_bin" ]]; then
  echo "Missing node or bun on remote host; cannot install resolver deps." >&2
  exit 1
fi

mkdir -p "$deps_dir"
if [[ ! -f "$deps_dir/package.json" ]]; then
  cat > "$deps_dir/package.json" <<'JSON'
{
  "private": true,
  "type": "module"
}
JSON
fi

if ! NETFLIX_NODE_DEPS_DIR="$deps_dir" "$node_bin" -e 'require.resolve("playwright", { paths: [process.env.NETFLIX_NODE_DEPS_DIR] })' >/dev/null 2>&1; then
  (cd "$deps_dir" && "$bun_bin" add --dev "playwright@$PLAYWRIGHT_VERSION")
fi

if ! NETFLIX_NODE_DEPS_DIR="$deps_dir" "$node_bin" -e 'require.resolve("libsodium-wrappers", { paths: [process.env.NETFLIX_NODE_DEPS_DIR] })' >/dev/null 2>&1; then
  (cd "$deps_dir" && "$bun_bin" add "libsodium-wrappers@$LIBSODIUM_WRAPPERS_VERSION")
fi

if ! NETFLIX_NODE_DEPS_DIR="$deps_dir" "$node_bin" >/dev/null 2>&1 <<'NODE'
const fs = require("fs");
const playwrightPath = require.resolve("playwright", {
  paths: [process.env.NETFLIX_NODE_DEPS_DIR],
});
const { chromium } = require(playwrightPath);
process.exit(fs.existsSync(chromium.executablePath()) ? 0 : 1);
NODE
then
  (cd "$deps_dir" && "$deps_dir/node_modules/.bin/playwright" install chromium)
fi
REMOTE

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

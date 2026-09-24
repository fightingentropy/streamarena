#!/usr/bin/env bash
set -euo pipefail

MINI_HOST="${MINI_HOST:-hermes@m4mini.local}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_codex_m4mini}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Source/settings travel as Python literals on stdin, never as shell code.
# Only StreamArena's three maintenance timers are reloaded by this installer.
python3 - "$script_dir/mini-maintenance.py" <<'PY' | \
  ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$MINI_HOST" \
    'sudo -n /usr/bin/python3 - --install'
import os
import pathlib
import sys

settings = {
    "app": os.environ.get("REMOTE_APP", "/Users/hermes/Developer/streamarena"),
    "disk_max_percent": int(os.environ.get("DISK_MAX_PERCENT", "90")),
    "disk_min_free_gb": int(os.environ.get("DISK_MIN_FREE_GB", "50")),
    "url": os.environ.get("WATCHDOG_URL", "http://127.0.0.1:5173/api/health/live"),
    "interval": int(os.environ.get("WATCHDOG_INTERVAL_SECONDS", "60")),
    "threshold": int(os.environ.get("WATCHDOG_FAILURE_THRESHOLD", "3")),
    "timeout": int(os.environ.get("WATCHDOG_TIMEOUT_SECONDS", "10")),
}
source = pathlib.Path(sys.argv[1]).read_text()
print("INSTALL_SETTINGS = " + repr(settings))
print("INSTALL_SOURCE = " + repr(source))
print("exec(compile(INSTALL_SOURCE, 'mini-maintenance.py', 'exec'))")
PY

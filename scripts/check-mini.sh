#!/usr/bin/env bash
set -euo pipefail

MINI_HOST="${MINI_HOST:-hermes@m4mini.local}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_codex_m4mini}"
REMOTE_APP="${REMOTE_APP:-/Users/hermes/Developer/netflix}"
PUBLIC_URL="${PUBLIC_URL:-https://fightingentropy.org}"
MIN_CLOUDFLARED_VERSION="${MIN_CLOUDFLARED_VERSION:-2026.5.0}"
MAX_DISK_PERCENT="${MAX_DISK_PERCENT:-90}"
MIN_FREE_GB="${MIN_FREE_GB:-50}"

SSH_OPTS=(
  -i "$SSH_KEY"
  -o BatchMode=yes
  -o ConnectTimeout=10
)

fail=0

pass() {
  printf 'ok  %s\n' "$1"
}

warn() {
  printf 'warn %s\n' "$1"
}

bad() {
  printf 'bad %s\n' "$1" >&2
  fail=1
}

remote_output="$(ssh "${SSH_OPTS[@]}" "$MINI_HOST" \
  "REMOTE_APP='$REMOTE_APP' MIN_CLOUDFLARED_VERSION='$MIN_CLOUDFLARED_VERSION' MAX_DISK_PERCENT='$MAX_DISK_PERCENT' MIN_FREE_GB='$MIN_FREE_GB' bash -s" <<'REMOTE'
set -euo pipefail

app="$REMOTE_APP"
cloudflared="$HOME/.local/bin/cloudflared"
expected_tree="assets,bin,cache,dist"

runtime_tree=$(find "$app" -maxdepth 1 -mindepth 1 -exec basename {} \; | sort | paste -sd, -)
app_http=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:5173 || true)
library_http=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:5173/assets/library.json || true)
listener=$(lsof -nP -iTCP:5173 -sTCP:LISTEN 2>/dev/null | awk 'NR == 2 {print $9}')
app_pid=$(pgrep -f "$app/bin/netflix-rust-backend" | head -1 || true)
tunnel_pid=$(pgrep -f "cloudflared tunnel run netflix" | head -1 || true)
cloudflared_version=$("$cloudflared" --version | awk '{print $3}')
tunnel_connectors=$("$cloudflared" tunnel info netflix 2>/dev/null | awk '/darwin_arm64/ {count++} END {print count + 0}')
asset_files=$(find "$app/assets" -type f | wc -l | tr -d ' ')
video_files=$(find "$app/assets/videos" -type f | wc -l | tr -d ' ')
asset_symlinks=$(find "$app/assets" -type l | wc -l | tr -d ' ')
env_mode=$(stat -f '%Lp' "$HOME/.config/netflix/env" 2>/dev/null || echo missing)
env_in_app=$(test -e "$app/.env" && echo yes || echo no)
log_agent=$(test -f "$HOME/Library/LaunchAgents/com.fightingentropy.netflix-log-rotation.plist" && echo yes || echo no)
disk_agent=$(test -f "$HOME/Library/LaunchAgents/com.fightingentropy.netflix-disk-monitor.plist" && echo yes || echo no)
cron_leftover=$(crontab -l 2>/dev/null | grep -c 'netflix-rotate-logs' || true)

df_line=$(df -Pk "$app" | awk 'NR == 2 {print $4 " " $5}')
available_kb=${df_line%% *}
capacity=${df_line##* }
capacity=${capacity%%%}
available_gb=$((available_kb / 1024 / 1024))

printf 'runtime_tree=%s\n' "$runtime_tree"
printf 'expected_tree=%s\n' "$expected_tree"
printf 'app_http=%s\n' "$app_http"
printf 'library_http=%s\n' "$library_http"
printf 'listener=%s\n' "$listener"
printf 'app_pid=%s\n' "${app_pid:-missing}"
printf 'tunnel_pid=%s\n' "${tunnel_pid:-missing}"
printf 'cloudflared_version=%s\n' "$cloudflared_version"
printf 'min_cloudflared_version=%s\n' "$MIN_CLOUDFLARED_VERSION"
printf 'tunnel_connectors=%s\n' "$tunnel_connectors"
printf 'asset_files=%s\n' "$asset_files"
printf 'video_files=%s\n' "$video_files"
printf 'asset_symlinks=%s\n' "$asset_symlinks"
printf 'env_mode=%s\n' "$env_mode"
printf 'env_in_app=%s\n' "$env_in_app"
printf 'log_agent=%s\n' "$log_agent"
printf 'disk_agent=%s\n' "$disk_agent"
printf 'cron_leftover=%s\n' "$cron_leftover"
printf 'disk_capacity_percent=%s\n' "$capacity"
printf 'disk_available_gb=%s\n' "$available_gb"
printf 'max_disk_percent=%s\n' "$MAX_DISK_PERCENT"
printf 'min_free_gb=%s\n' "$MIN_FREE_GB"
REMOTE
)"

printf '%s\n' "$remote_output"

value_for() {
  printf '%s\n' "$remote_output" | awk -F= -v key="$1" '$1 == key {print substr($0, length(key) + 2); exit}'
}

runtime_tree=$(value_for runtime_tree)
expected_tree=$(value_for expected_tree)
app_http=$(value_for app_http)
library_http=$(value_for library_http)
listener=$(value_for listener)
app_pid=$(value_for app_pid)
tunnel_pid=$(value_for tunnel_pid)
cloudflared_version=$(value_for cloudflared_version)
tunnel_connectors=$(value_for tunnel_connectors)
asset_symlinks=$(value_for asset_symlinks)
env_mode=$(value_for env_mode)
env_in_app=$(value_for env_in_app)
log_agent=$(value_for log_agent)
disk_agent=$(value_for disk_agent)
cron_leftover=$(value_for cron_leftover)
disk_capacity_percent=$(value_for disk_capacity_percent)
disk_available_gb=$(value_for disk_available_gb)

[[ "$runtime_tree" == "$expected_tree" ]] && pass "runtime tree is $runtime_tree" || bad "runtime tree is $runtime_tree, expected $expected_tree"
[[ "$app_http" == "200" ]] && pass "mini app returns HTTP 200" || bad "mini app returned HTTP $app_http"
[[ "$library_http" == "200" ]] && pass "library endpoint returns HTTP 200" || bad "library endpoint returned HTTP $library_http"
[[ "$listener" == "127.0.0.1:5173" ]] && pass "listener is localhost only" || bad "listener is '$listener'"
[[ "$app_pid" != "missing" ]] && pass "backend process is running ($app_pid)" || bad "backend process missing"
[[ "$tunnel_pid" != "missing" ]] && pass "cloudflared process is running ($tunnel_pid)" || bad "cloudflared process missing"
[[ "$cloudflared_version" == "$MIN_CLOUDFLARED_VERSION" ]] && pass "cloudflared is $cloudflared_version" || bad "cloudflared is $cloudflared_version, expected $MIN_CLOUDFLARED_VERSION"
[[ "$tunnel_connectors" -ge 1 ]] && pass "tunnel has active connector(s)" || bad "tunnel has no active connectors"
[[ "$asset_symlinks" == "0" ]] && pass "mini assets have no symlinks" || bad "mini assets have $asset_symlinks symlink(s)"
[[ "$env_mode" == "600" ]] && pass "server env permissions are 600" || bad "server env permissions are $env_mode"
[[ "$env_in_app" == "no" ]] && pass "server env is outside deploy tree" || bad "server .env still exists in deploy tree"
[[ "$log_agent" == "yes" ]] && pass "log rotation LaunchAgent exists" || bad "log rotation LaunchAgent missing"
[[ "$disk_agent" == "yes" ]] && pass "disk monitor LaunchAgent exists" || bad "disk monitor LaunchAgent missing"
[[ "$cron_leftover" == "0" ]] && pass "old cron log rotation removed" || bad "old cron log rotation still present"

if [[ "$disk_capacity_percent" -ge "$MAX_DISK_PERCENT" ]]; then
  bad "disk usage is ${disk_capacity_percent}% (limit ${MAX_DISK_PERCENT}%)"
else
  pass "disk usage is ${disk_capacity_percent}%"
fi

if [[ "$disk_available_gb" -lt "$MIN_FREE_GB" ]]; then
  bad "disk free space is ${disk_available_gb}GB (minimum ${MIN_FREE_GB}GB)"
else
  pass "disk free space is ${disk_available_gb}GB"
fi

public_status="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "$PUBLIC_URL" || true)"
[[ "$public_status" == "302" ]] && pass "$PUBLIC_URL returns Cloudflare Access 302" || bad "$PUBLIC_URL returned HTTP $public_status"

exit "$fail"

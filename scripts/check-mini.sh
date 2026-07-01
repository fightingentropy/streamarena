#!/usr/bin/env bash
set -euo pipefail

MINI_HOST="${MINI_HOST:-hermes@m4mini.local}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_codex_m4mini}"
REMOTE_APP="${REMOTE_APP:-/Users/hermes/Developer/streamarena}"
PUBLIC_URL="${PUBLIC_URL:-https://streamarena.xyz}"
PUBLIC_HOST="${PUBLIC_HOST:-streamarena.xyz}"
MAX_DISK_PERCENT="${MAX_DISK_PERCENT:-90}"
MIN_FREE_GB="${MIN_FREE_GB:-50}"
PROTECTED_ENDPOINT_STATUS="${PROTECTED_ENDPOINT_STATUS:-401}"
SPORTS_PROXY_EXPECTED="${SPORTS_PROXY_EXPECTED:-http://127.0.0.1:40000}"

SSH_OPTS=(
  -i "$SSH_KEY"
  -o BatchMode=yes
  -o ConnectTimeout=10
)

fail=0

pass() {
  printf 'ok  %s\n' "$1"
}

bad() {
  printf 'bad %s\n' "$1" >&2
  fail=1
}

remote_output="$(ssh "${SSH_OPTS[@]}" "$MINI_HOST" \
  "REMOTE_APP='$REMOTE_APP' PUBLIC_HOST='$PUBLIC_HOST' MAX_DISK_PERCENT='$MAX_DISK_PERCENT' MIN_FREE_GB='$MIN_FREE_GB' SPORTS_PROXY_EXPECTED='$SPORTS_PROXY_EXPECTED' bash -s" <<'REMOTE'
set -euo pipefail

app="$REMOTE_APP"
expected_tree="assets,bin,cache,dist"
caddy_bin="/usr/local/bin/caddy"
tunnel_plist="/Library/LaunchDaemons/com.cloudflare.cloudflared.streamarena.plist"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
node_deps_dir="${STREAMARENA_NODE_DEPS_DIR:-$HOME/.local/share/streamarena-node}"

# A 600-permissioned .env in the app dir is a supported config source (the
# backend loads it via dotenvy); exclude it from the structure check and verify
# its permissions separately below.
runtime_tree=$(find "$app" -maxdepth 1 -mindepth 1 -exec basename {} \; 2>/dev/null | grep -vxF .env | sort | paste -sd, - || true)
app_http=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:5173/api/health/live || true)
library_http=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:5173/api/library || true)
# Direct-origin Caddy probes were retired: the origin is locked to Cloudflare
# IPs, so a loopback request to Caddy is aborted (always 000). The reverse proxy
# is verified end-to-end through the public hostname instead (see PUBLIC_URL
# checks at the bottom of this script).
listener=$(lsof -nP -iTCP:5173 -sTCP:LISTEN 2>/dev/null | awk 'NR == 2 {print $9}' || true)
caddy_80=$(sudo lsof -nP -iTCP:80 -sTCP:LISTEN 2>/dev/null | awk 'NR == 2 {print $9}' || true)
caddy_443=$(sudo lsof -nP -iTCP:443 -sTCP:LISTEN 2>/dev/null | awk 'NR == 2 {print $9}' || true)
app_pid=$(pgrep -f "$app/bin/streamarena-backend" | head -1 || true)
caddy_pid=$(pgrep -x caddy | head -1 || true)
tunnel_pid=$(pgrep -f "cloudflared tunnel run streamarena" | head -1 || true)
tunnel_daemon=$(test -e "$tunnel_plist" && echo yes || echo no)
caddy_version=$("$caddy_bin" version 2>/dev/null | awk '{print $1}' || true)
asset_files=$(find "$app/assets" -type f 2>/dev/null | wc -l | tr -d ' ' || true)
video_files=$(find "$app/assets/videos" -type f 2>/dev/null | wc -l | tr -d ' ' || true)
asset_symlinks=$(find "$app/assets" -type l 2>/dev/null | wc -l | tr -d ' ' || true)
env_mode=$(stat -f '%Lp' "$HOME/.config/streamarena/env" 2>/dev/null || echo missing)
env_in_app=$(test -e "$app/.env" && echo yes || echo no)
app_env_mode=$(stat -f '%Lp' "$app/.env" 2>/dev/null || echo none)
sports_http_proxy=$(
  awk -F= '/^SPORTS_HTTP_PROXY=/ {print substr($0, length($1) + 2); exit}' "$HOME/.config/streamarena/env" 2>/dev/null || true
)
sports_proxy_matches_expected=$([[ "$sports_http_proxy" == "$SPORTS_PROXY_EXPECTED" ]] && echo yes || echo no)
app_daemon=$(test -f "/Library/LaunchDaemons/com.fightingentropy.streamarena-app.plist" && echo yes || echo no)
caddy_daemon=$(test -f "/Library/LaunchDaemons/com.fightingentropy.streamarena-caddy.plist" && echo yes || echo no)
app_launch_state=$(launchctl print "system/com.fightingentropy.streamarena-app" 2>/dev/null | awk -F= '/state =/ {gsub(/[ ";]/, "", $2); print $2; exit}' || true)
caddy_launch_state=$(launchctl print "system/com.fightingentropy.streamarena-caddy" 2>/dev/null | awk -F= '/state =/ {gsub(/[ ";]/, "", $2); print $2; exit}' || true)
app_runs=$(launchctl print "system/com.fightingentropy.streamarena-app" 2>/dev/null | awk -F= '/runs =/ {gsub(/[ ";]/, "", $2); print $2; exit}' || true)
caddy_runs=$(launchctl print "system/com.fightingentropy.streamarena-caddy" 2>/dev/null | awk -F= '/runs =/ {gsub(/[ ";]/, "", $2); print $2; exit}' || true)
log_agent=$(test -f "$HOME/Library/LaunchAgents/com.fightingentropy.streamarena-log-rotation.plist" && echo yes || echo no)
disk_agent=$(test -f "$HOME/Library/LaunchAgents/com.fightingentropy.streamarena-disk-monitor.plist" && echo yes || echo no)
watchdog_agent=$(test -f "$HOME/Library/LaunchAgents/com.fightingentropy.streamarena-watchdog.plist" && echo yes || echo no)
watchdog_helper=$(test -x "$HOME/.local/bin/streamarena-watchdog" && echo yes || echo no)
watchdog_log=$(test -f "$HOME/.local/state/streamarena/watchdog.log" && echo yes || echo no)
watchdog_launch_state=$(launchctl print "gui/$(id -u)/com.fightingentropy.streamarena-watchdog" 2>/dev/null | awk -F= '/state =/ {gsub(/[ ";]/, "", $2); print $2; exit}' || true)
cron_leftover=$(crontab -l 2>/dev/null | grep -c 'streamarena-rotate-logs' || true)

df_line=$(df -Pk "$app" | awk 'NR == 2 {print $4 " " $5}')
available_kb=${df_line%% *}
capacity=${df_line##* }
capacity=${capacity%%%}
available_gb=$((available_kb / 1024 / 1024))
public_ip=$(curl -fsS --max-time 5 https://api.ipify.org || true)
hls_resolver=$(test -f "$app/bin/resolve-external-embed-hls.mjs" && echo yes || echo no)
streamed_hls_resolver=$(test -f "$app/bin/resolve-streamed-hls.mjs" && echo yes || echo no)
matchstream_hls_resolver=$(test -f "$app/bin/resolve-matchstream-hls.mjs" && echo yes || echo no)
ntvs_hls_resolver=$(test -f "$app/bin/resolve-ntvs-hls.mjs" && echo yes || echo no)
cdnlivetv_hls_resolver=$(test -f "$app/bin/resolve-cdnlivetv-hls.mjs" && echo yes || echo no)
node_bin=$(command -v node || true)
bun_bin=$(command -v bun || true)
playwright_module=$(
  STREAMARENA_NODE_DEPS_DIR="$node_deps_dir" node -e 'require.resolve("playwright", { paths: [process.env.STREAMARENA_NODE_DEPS_DIR] }); process.stdout.write("yes")' 2>/dev/null || echo no
)
libsodium_module=$(
  STREAMARENA_NODE_DEPS_DIR="$node_deps_dir" node -e 'require.resolve("libsodium-wrappers", { paths: [process.env.STREAMARENA_NODE_DEPS_DIR] }); process.stdout.write("yes")' 2>/dev/null || echo no
)
playwright_chromium=$(
  STREAMARENA_NODE_DEPS_DIR="$node_deps_dir" node <<'NODE' 2>/dev/null || echo no
const fs = require("fs");
const playwrightPath = require.resolve("playwright", {
  paths: [process.env.STREAMARENA_NODE_DEPS_DIR],
});
const { chromium } = require(playwrightPath);
process.stdout.write(fs.existsSync(chromium.executablePath()) ? "yes" : "no");
NODE
)
warp_cli=$(command -v warp-cli || true)
warp_status=$(
  if [[ -n "$warp_cli" ]]; then
    "$warp_cli" --accept-tos status 2>/dev/null | awk -F: '/Status update:/ {gsub(/^[[:space:]]+/, "", $2); print $2; exit}'
  fi
)
warp_mode=$(
  if [[ -n "$warp_cli" ]]; then
    "$warp_cli" --accept-tos settings list 2>/dev/null | awk -F: '/Mode:/ {gsub(/^[[:space:]]+/, "", $2); print $2; exit}'
  fi
)
streamed_proxy_http=$(
  if [[ -n "$sports_http_proxy" ]]; then
    curl -sS --proxy "$sports_http_proxy" -o /dev/null -w "%{http_code}" --max-time 12 https://streamed.pk/api/matches/football 2>/dev/null || true
  fi
)
ntvs_proxy_http=$(
  if [[ -n "$sports_http_proxy" ]]; then
    curl -sS --proxy "$sports_http_proxy" -o /dev/null -w "%{http_code}" --max-time 12 'https://ntvs.cx/api/search?q=football&server=kobra' 2>/dev/null || true
  fi
)

printf 'runtime_tree=%s\n' "$runtime_tree"
printf 'expected_tree=%s\n' "$expected_tree"
printf 'app_http=%s\n' "$app_http"
printf 'library_http=%s\n' "$library_http"
printf 'listener=%s\n' "$listener"
printf 'caddy_80=%s\n' "${caddy_80:-missing}"
printf 'caddy_443=%s\n' "${caddy_443:-missing}"
printf 'app_pid=%s\n' "${app_pid:-missing}"
printf 'caddy_pid=%s\n' "${caddy_pid:-missing}"
printf 'tunnel_pid=%s\n' "${tunnel_pid:-missing}"
printf 'tunnel_daemon=%s\n' "$tunnel_daemon"
printf 'caddy_version=%s\n' "${caddy_version:-missing}"
printf 'asset_files=%s\n' "$asset_files"
printf 'video_files=%s\n' "$video_files"
printf 'asset_symlinks=%s\n' "$asset_symlinks"
printf 'env_mode=%s\n' "$env_mode"
printf 'env_in_app=%s\n' "$env_in_app"
printf 'app_env_mode=%s\n' "$app_env_mode"
printf 'sports_proxy_matches_expected=%s\n' "$sports_proxy_matches_expected"
printf 'app_daemon=%s\n' "$app_daemon"
printf 'caddy_daemon=%s\n' "$caddy_daemon"
printf 'app_launch_state=%s\n' "${app_launch_state:-missing}"
printf 'caddy_launch_state=%s\n' "${caddy_launch_state:-missing}"
printf 'app_runs=%s\n' "${app_runs:-missing}"
printf 'caddy_runs=%s\n' "${caddy_runs:-missing}"
printf 'log_agent=%s\n' "$log_agent"
printf 'disk_agent=%s\n' "$disk_agent"
printf 'watchdog_agent=%s\n' "$watchdog_agent"
printf 'watchdog_helper=%s\n' "$watchdog_helper"
printf 'watchdog_log=%s\n' "$watchdog_log"
printf 'watchdog_launch_state=%s\n' "${watchdog_launch_state:-missing}"
printf 'cron_leftover=%s\n' "$cron_leftover"
printf 'disk_capacity_percent=%s\n' "$capacity"
printf 'disk_available_gb=%s\n' "$available_gb"
printf 'max_disk_percent=%s\n' "$MAX_DISK_PERCENT"
printf 'min_free_gb=%s\n' "$MIN_FREE_GB"
printf 'public_ip=%s\n' "${public_ip:-missing}"
printf 'hls_resolver=%s\n' "$hls_resolver"
printf 'streamed_hls_resolver=%s\n' "$streamed_hls_resolver"
printf 'matchstream_hls_resolver=%s\n' "$matchstream_hls_resolver"
printf 'ntvs_hls_resolver=%s\n' "$ntvs_hls_resolver"
printf 'cdnlivetv_hls_resolver=%s\n' "$cdnlivetv_hls_resolver"
printf 'node_bin=%s\n' "${node_bin:-missing}"
printf 'bun_bin=%s\n' "${bun_bin:-missing}"
printf 'playwright_module=%s\n' "$playwright_module"
printf 'libsodium_module=%s\n' "$libsodium_module"
printf 'playwright_chromium=%s\n' "$playwright_chromium"
printf 'warp_cli=%s\n' "${warp_cli:-missing}"
printf 'warp_status=%s\n' "${warp_status:-missing}"
printf 'warp_mode=%s\n' "${warp_mode:-missing}"
printf 'streamed_proxy_http=%s\n' "${streamed_proxy_http:-missing}"
printf 'ntvs_proxy_http=%s\n' "${ntvs_proxy_http:-missing}"
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
caddy_80=$(value_for caddy_80)
caddy_443=$(value_for caddy_443)
app_pid=$(value_for app_pid)
caddy_pid=$(value_for caddy_pid)
tunnel_pid=$(value_for tunnel_pid)
tunnel_daemon=$(value_for tunnel_daemon)
caddy_version=$(value_for caddy_version)
asset_symlinks=$(value_for asset_symlinks)
env_mode=$(value_for env_mode)
env_in_app=$(value_for env_in_app)
app_env_mode=$(value_for app_env_mode)
sports_proxy_matches_expected=$(value_for sports_proxy_matches_expected)
app_daemon=$(value_for app_daemon)
caddy_daemon=$(value_for caddy_daemon)
app_launch_state=$(value_for app_launch_state)
caddy_launch_state=$(value_for caddy_launch_state)
app_runs=$(value_for app_runs)
caddy_runs=$(value_for caddy_runs)
log_agent=$(value_for log_agent)
disk_agent=$(value_for disk_agent)
watchdog_agent=$(value_for watchdog_agent)
watchdog_helper=$(value_for watchdog_helper)
watchdog_log=$(value_for watchdog_log)
watchdog_launch_state=$(value_for watchdog_launch_state)
cron_leftover=$(value_for cron_leftover)
disk_capacity_percent=$(value_for disk_capacity_percent)
disk_available_gb=$(value_for disk_available_gb)
public_ip=$(value_for public_ip)
hls_resolver=$(value_for hls_resolver)
streamed_hls_resolver=$(value_for streamed_hls_resolver)
matchstream_hls_resolver=$(value_for matchstream_hls_resolver)
ntvs_hls_resolver=$(value_for ntvs_hls_resolver)
cdnlivetv_hls_resolver=$(value_for cdnlivetv_hls_resolver)
node_bin=$(value_for node_bin)
bun_bin=$(value_for bun_bin)
playwright_module=$(value_for playwright_module)
libsodium_module=$(value_for libsodium_module)
playwright_chromium=$(value_for playwright_chromium)
warp_cli=$(value_for warp_cli)
warp_status=$(value_for warp_status)
warp_mode=$(value_for warp_mode)
streamed_proxy_http=$(value_for streamed_proxy_http)
ntvs_proxy_http=$(value_for ntvs_proxy_http)

[[ "$runtime_tree" == "$expected_tree" ]] && pass "runtime tree is $runtime_tree" || bad "runtime tree is $runtime_tree, expected $expected_tree"
[[ "$app_http" == "200" ]] && pass "mini live health returns HTTP 200" || bad "mini live health returned HTTP $app_http"
[[ "$library_http" == "$PROTECTED_ENDPOINT_STATUS" ]] && pass "API library endpoint returns HTTP $PROTECTED_ENDPOINT_STATUS" || bad "API library endpoint returned HTTP $library_http"
# Caddy reverse-proxy correctness is checked via the public hostname (through
# Cloudflare) in the PUBLIC_URL section below; the origin can't be probed
# directly now that it only accepts Cloudflare IPs.
[[ "$listener" == "127.0.0.1:5173" ]] && pass "backend listener is localhost only" || bad "backend listener is '$listener'"
[[ "$caddy_80" == *":80" ]] && pass "Caddy listens on port 80" || bad "Caddy port 80 listener is '$caddy_80'"
[[ "$caddy_443" == *":443" ]] && pass "Caddy listens on port 443" || bad "Caddy port 443 listener is '$caddy_443'"
[[ "$app_pid" != "missing" ]] && pass "backend process is running ($app_pid)" || bad "backend process missing"
[[ "$caddy_pid" != "missing" ]] && pass "Caddy process is running ($caddy_pid)" || bad "Caddy process missing"
[[ "$caddy_version" != "missing" ]] && pass "Caddy is installed ($caddy_version)" || bad "Caddy is missing"
[[ "$asset_symlinks" == "0" ]] && pass "mini assets have no symlinks" || bad "mini assets have $asset_symlinks symlink(s)"
[[ "$hls_resolver" == "yes" ]] && pass "external HLS resolver script is deployed" || bad "external HLS resolver script is missing"
[[ "$streamed_hls_resolver" == "yes" ]] && pass "Streamed sports HLS resolver script is deployed" || bad "Streamed sports HLS resolver script is missing"
[[ "$matchstream_hls_resolver" == "yes" ]] && pass "MatchStream sports HLS resolver script is deployed" || bad "MatchStream sports HLS resolver script is missing"
[[ "$ntvs_hls_resolver" == "yes" ]] && pass "NTVS sports HLS resolver script is deployed" || bad "NTVS sports HLS resolver script is missing"
[[ "$cdnlivetv_hls_resolver" == "yes" ]] && pass "cdnlivetv sports HLS resolver script is deployed" || bad "cdnlivetv sports HLS resolver script is missing"
[[ "$node_bin" != "missing" ]] && pass "Node is available for resolver helpers ($node_bin)" || bad "Node is missing for resolver helpers"
[[ "$bun_bin" != "missing" ]] && pass "Bun is available for resolver dependency installs ($bun_bin)" || bad "Bun is missing for resolver dependency installs"
[[ "$playwright_module" == "yes" ]] && pass "Playwright module is installed for resolver helpers" || bad "Playwright module is missing for resolver helpers"
[[ "$libsodium_module" == "yes" ]] && pass "libsodium-wrappers module is installed for native VidLink resolver" || bad "libsodium-wrappers module is missing for native VidLink resolver"
[[ "$playwright_chromium" == "yes" ]] && pass "Playwright Chromium is installed for resolver helpers" || bad "Playwright Chromium is missing for resolver helpers"
[[ "$env_mode" == "600" ]] && pass "server env permissions are 600" || bad "server env permissions are $env_mode"
if [[ "$env_in_app" == "no" ]]; then
  pass "deploy tree has no .env (secrets stay in the canonical env file)"
elif [[ "$app_env_mode" == "600" ]]; then
  pass "deploy-tree .env is present and 600-secured"
else
  bad "deploy-tree .env permissions are $app_env_mode (expected 600)"
fi
[[ "$sports_proxy_matches_expected" == "yes" ]] && pass "SPORTS_HTTP_PROXY points at WARP local proxy" || bad "SPORTS_HTTP_PROXY does not match expected WARP local proxy"
[[ "$warp_cli" != "missing" ]] && pass "WARP CLI is installed ($warp_cli)" || bad "WARP CLI is missing"
[[ "$warp_status" == "Connected" ]] && pass "WARP is connected" || bad "WARP status is $warp_status"
[[ "$warp_mode" == "WarpProxy on port 40000" ]] && pass "WARP is in local proxy mode on port 40000" || bad "WARP mode is $warp_mode"
[[ "$streamed_proxy_http" == "200" ]] && pass "Streamed schedule is reachable through WARP proxy" || bad "Streamed schedule through WARP proxy returned HTTP $streamed_proxy_http"
[[ "$ntvs_proxy_http" == "200" ]] && pass "NTVS football search is reachable through WARP proxy" || bad "NTVS football search through WARP proxy returned HTTP $ntvs_proxy_http"
[[ "$app_daemon" == "yes" ]] && pass "backend LaunchDaemon exists" || bad "backend LaunchDaemon missing"
[[ "$caddy_daemon" == "yes" ]] && pass "Caddy LaunchDaemon exists" || bad "Caddy LaunchDaemon missing"
[[ "$app_launch_state" == "running" ]] && pass "backend launchd state is running (runs=$app_runs)" || bad "backend launchd state is $app_launch_state"
[[ "$caddy_launch_state" == "running" ]] && pass "Caddy launchd state is running (runs=$caddy_runs)" || bad "Caddy launchd state is $caddy_launch_state"
[[ "$log_agent" == "yes" ]] && pass "log rotation LaunchAgent exists" || bad "log rotation LaunchAgent missing"
[[ "$disk_agent" == "yes" ]] && pass "disk monitor LaunchAgent exists" || bad "disk monitor LaunchAgent missing"
[[ "$watchdog_agent" == "yes" ]] && pass "watchdog LaunchAgent exists" || bad "watchdog LaunchAgent missing"
[[ "$watchdog_helper" == "yes" ]] && pass "watchdog helper is executable" || bad "watchdog helper missing or not executable"
[[ "$watchdog_log" == "yes" ]] && pass "watchdog log exists" || bad "watchdog log missing"
[[ "$watchdog_launch_state" != "missing" ]] && pass "watchdog launchd state is $watchdog_launch_state" || bad "watchdog LaunchAgent is not loaded"
[[ "$cron_leftover" == "0" ]] && pass "old cron log rotation removed" || bad "old cron log rotation still present"

[[ "$tunnel_pid" == "missing" ]] && pass "cloudflared tunnel process is removed" || bad "cloudflared tunnel process is still running ($tunnel_pid)"
[[ "$tunnel_daemon" == "no" ]] && pass "cloudflared LaunchDaemon is removed" || bad "cloudflared LaunchDaemon still exists"

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

[[ "$public_ip" != "missing" && -n "$public_ip" ]] && pass "mini public IP is $public_ip" || bad "mini public IP could not be resolved"

# The app is private: an anonymous request for the homepage must redirect to the
# sign-in page rather than render anything, and that sign-in page must load.
public_status="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "$PUBLIC_URL" || true)"
[[ "$public_status" == "302" ]] && pass "$PUBLIC_URL gates anonymous visitors (HTTP 302 to login)" || bad "$PUBLIC_URL returned HTTP $public_status (expected 302 redirect to login)"

public_login_status="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "$PUBLIC_URL/login.html" || true)"
[[ "$public_login_status" == "200" ]] && pass "$PUBLIC_URL/login.html is reachable (HTTP 200)" || bad "$PUBLIC_URL/login.html returned HTTP $public_login_status"

public_auth_status="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "$PUBLIC_URL/api/auth/me" || true)"
[[ "$public_auth_status" == "401" ]] && pass "$PUBLIC_URL keeps app login active" || bad "$PUBLIC_URL app auth returned HTTP $public_auth_status"

# Reverse-proxy check (replaces the retired direct-origin Caddy probes): a
# protected route must reach the backend through Cloudflare -> Caddy and come
# back with the auth-required status, proving the full edge path is intact.
public_proxy_status="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "$PUBLIC_URL/api/library" || true)"
[[ "$public_proxy_status" == "$PROTECTED_ENDPOINT_STATUS" ]] && pass "Caddy reverse-proxies protected routes via $PUBLIC_HOST (HTTP $PROTECTED_ENDPOINT_STATUS)" || bad "$PUBLIC_URL/api/library returned HTTP $public_proxy_status"

exit "$fail"

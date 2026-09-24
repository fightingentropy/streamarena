#!/usr/bin/env bash
set -euo pipefail

MINI_HOST="${MINI_HOST:-hermes@m4mini.local}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_codex_m4mini}"
REMOTE_APP="${REMOTE_APP:-/Users/hermes/Developer/streamarena}"
PUBLIC_URL="${PUBLIC_URL:-https://streamarena.xyz}"
PUBLIC_URL="${PUBLIC_URL%/}"
PUBLIC_HOST="${PUBLIC_HOST:-streamarena.xyz}"
PUBLIC_ALIAS_HOST="${PUBLIC_ALIAS_HOST:-www.$PUBLIC_HOST}"
MAX_DISK_PERCENT="${MAX_DISK_PERCENT:-90}"
MIN_FREE_GB="${MIN_FREE_GB:-50}"
PROTECTED_ENDPOINT_STATUS="${PROTECTED_ENDPOINT_STATUS:-401}"
SPORTS_PROXY_EXPECTED="${SPORTS_PROXY_EXPECTED:-http://127.0.0.1:40000}"
EXPECTED_OPEN_SIGNUP="${EXPECTED_OPEN_SIGNUP:-0}"
# Tunnel ingress is the deployed topology. Direct 80/443 ingress is opt-in.
MINI_INGRESS_MODE="${MINI_INGRESS_MODE:-tunnel}"
STREAMARENA_CADDY_PORT="${STREAMARENA_CADDY_PORT:-5180}"
TORZNAB_CHECK_QUERY="${TORZNAB_CHECK_QUERY:-}"
case "$MINI_INGRESS_MODE" in tunnel|direct) ;; *) echo "Invalid MINI_INGRESS_MODE" >&2; exit 2 ;; esac
[[ "$STREAMARENA_CADDY_PORT" =~ ^[0-9]+$ && "$STREAMARENA_CADDY_PORT" -ge 1 && "$STREAMARENA_CADDY_PORT" -le 65535 ]] \
  || { echo "Invalid STREAMARENA_CADDY_PORT" >&2; exit 2; }
# Quote values for the remote shell without interpolating user input as code.
shell_quote() { printf '%q' "$1"; }

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

remote_output_file="$(mktemp)"
trap 'rm -f "$remote_output_file"' EXIT
ssh "${SSH_OPTS[@]}" "$MINI_HOST" \
  "REMOTE_APP=$(shell_quote "$REMOTE_APP") PUBLIC_HOST=$(shell_quote "$PUBLIC_HOST") PUBLIC_ALIAS_HOST=$(shell_quote "$PUBLIC_ALIAS_HOST") MAX_DISK_PERCENT=$(shell_quote "$MAX_DISK_PERCENT") MIN_FREE_GB=$(shell_quote "$MIN_FREE_GB") SPORTS_PROXY_EXPECTED=$(shell_quote "$SPORTS_PROXY_EXPECTED") MINI_INGRESS_MODE=$(shell_quote "$MINI_INGRESS_MODE") STREAMARENA_CADDY_PORT=$(shell_quote "$STREAMARENA_CADDY_PORT") TORZNAB_CHECK_QUERY=$(shell_quote "$TORZNAB_CHECK_QUERY") bash -s" \
  >"$remote_output_file" <<'REMOTE'
set -euo pipefail

app="$REMOTE_APP"
expected_tree="assets,bin,cache,dist"
caddy_bin="/usr/local/bin/caddy"
tunnel_plist="/Library/LaunchDaemons/com.cloudflare.cloudflared.streamarena.plist"
legacy_caddy_plist="/Library/LaunchDaemons/xyz.streamarena.caddy.plist"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
node_deps_dir="${STREAMARENA_NODE_DEPS_DIR:-$HOME/.local/share/streamarena-node}"

# A 600-permissioned .env in the app dir is a supported config source (the
# backend loads it via dotenvy); exclude it from the structure check and verify
# its permissions separately below.
runtime_tree=$(find "$app" -maxdepth 1 -mindepth 1 -exec basename {} \; 2>/dev/null \
  | grep -Ev '^(\.env|\.release-commit|\.deploy-(staging|rollback|failed))$' \
  | sort | paste -sd, - || true)
release_marker=absent
if [[ -e "$app/.release-commit" || -L "$app/.release-commit" ]]; then
  release_marker=invalid
  if [[ -f "$app/.release-commit" && ! -L "$app/.release-commit" ]] \
    && [[ "$(cat "$app/.release-commit")" =~ ^[0-9a-f]{40}$ ]]; then
    release_marker=valid
  fi
fi
app_http=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:5173/api/health/live || true)
library_http=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:5173/api/library || true)
# The reverse proxy is verified end-to-end through the public hostname below;
# the backend's loopback health check separately isolates app health from edge
# and DNS failures.
listener=$(lsof -nP -iTCP:5173 -sTCP:LISTEN 2>/dev/null | awk 'NR == 2 {print $9}' || true)
# Read the running job, not an inactive Caddyfile or a coincidental process.
launch_value() {
  launchctl print "$1" 2>/dev/null | awk -F= -v key="$2" '
    {name=$1; gsub(/^[ \t]+|[ \t]+$/, "", name)}
    name == key {value=$2; gsub(/^[ \t]+|[ \t;]+$/, "", value); print value; exit}' || true
}
process_argument() {
  ps -p "$1" -o command= 2>/dev/null | python3 -c '
import shlex, sys
try:
    args = shlex.split(sys.stdin.read())
    if sys.argv[1] == "program":
        print(args[0])
        raise SystemExit(0)
    config = next((arg.split("=", 1)[1] for arg in args if arg.startswith("--config=")), "")
    if "--config" in args:
        config = args[args.index("--config") + 1]
    print(config)
except (ValueError, IndexError):
    pass
' "$2" || true
}
app_pid=$(launch_value system/com.fightingentropy.streamarena-app pid)
caddy_pid=$(launch_value system/com.fightingentropy.streamarena-caddy pid)
tunnel_pid=$(launch_value system/com.cloudflare.cloudflared.streamarena pid)
tunnel_launch_state=$(launch_value system/com.cloudflare.cloudflared.streamarena state)
tunnel_daemon=$(test -e "$tunnel_plist" && echo yes || echo no)
caddy_version=$("$caddy_bin" version 2>/dev/null | awk '{print $1}' || true)
caddy_config=$(process_argument "${caddy_pid:-0}" config)
caddy_config_valid=no
if [[ -n "$caddy_config" ]] && sudo -n "$caddy_bin" validate --config "$caddy_config" --adapter caddyfile >/dev/null 2>&1; then
  caddy_config_valid=yes
fi
caddy_listener() {
  sudo -n lsof -nP -a -p "${caddy_pid:-0}" -iTCP:"$1" -sTCP:LISTEN -Fn 2>/dev/null \
    | sed -n 's/^n//p' | sort -u | paste -sd, - || true
}
caddy_80=$(caddy_listener 80)
caddy_443=$(caddy_listener 443)
caddy_loopback=$(caddy_listener "$STREAMARENA_CADDY_PORT")
caddy_client_ip_guard=no
caddy_https_redirect=no
caddy_direct_origin=no
if [[ "$MINI_INGRESS_MODE" == "direct" ]]; then
  if sudo -n grep -q 'trusted_proxies static' "$caddy_config" 2>/dev/null \
    && sudo -n grep -qi 'header_up cf-connecting-ip' "$caddy_config" 2>/dev/null \
    && sudo -n grep -qi 'client_ip_headers CF-Connecting-IP' "$caddy_config" 2>/dev/null \
    && sudo -n grep -q 'remote_ip private_ranges' "$caddy_config" 2>/dev/null; then
    caddy_client_ip_guard=yes
  fi
  if sudo -n grep -Eq 'redir[[:space:]]+https://[^[:space:]]+\{uri\}[[:space:]]+permanent' "$caddy_config" 2>/dev/null; then
    caddy_https_redirect=yes
  fi
  if sudo -n grep -Fq '# BEGIN STREAMARENA DIRECT WORKER ORIGIN' "$caddy_config" 2>/dev/null \
    && sudo -n grep -Fq '# END STREAMARENA DIRECT WORKER ORIGIN' "$caddy_config" 2>/dev/null; then
    caddy_direct_origin=yes
  fi
fi
tunnel_config=$(process_argument "${tunnel_pid:-0}" config)
cloudflared_bin=$(process_argument "${tunnel_pid:-0}" program)
# cloudflared uses this standard path when no explicit --config is supplied.
tunnel_config="${tunnel_config:-$HOME/.cloudflared/config.yml}"
tunnel_ingress_valid=no
tunnel_primary_service=missing
tunnel_alias_service=missing
if [[ "$MINI_INGRESS_MODE" == "tunnel" ]]; then
  if [[ -x "$cloudflared_bin" ]] && "$cloudflared_bin" tunnel --config "$tunnel_config" ingress validate >/dev/null 2>&1; then
    tunnel_ingress_valid=yes
  fi
  tunnel_service() {
    "$cloudflared_bin" tunnel --config "$tunnel_config" ingress rule "https://$1/login.html" 2>/dev/null \
      | awk '/^[[:space:]]*service:/ {sub(/^[[:space:]]*service:[[:space:]]*/, ""); gsub(/["\047]/, ""); print; exit}' || true
  }
  tunnel_primary_service=$(tunnel_service "$PUBLIC_HOST")
  tunnel_alias_service=$(tunnel_service "$PUBLIC_ALIAS_HOST")
fi
local_proxy_http=skipped
local_http_redirect=skipped
local_alias_redirect=skipped
if [[ "$MINI_INGRESS_MODE" == "tunnel" ]]; then
  local_origin="http://127.0.0.1:$STREAMARENA_CADDY_PORT"
  local_proxy_http=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
    -H "Host: $PUBLIC_HOST" -H 'X-Forwarded-Proto: https' "$local_origin/api/library" || true)
  local_http_redirect=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 5 \
    -H "Host: $PUBLIC_HOST" -H 'X-Forwarded-Proto: http' "$local_origin/login.html?mini_check=1" || true)
  local_alias_redirect=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 5 \
    -H "Host: $PUBLIC_ALIAS_HOST" -H 'X-Forwarded-Proto: https' "$local_origin/login.html?mini_check=1" || true)
fi
asset_files=$(find "$app/assets" -type f 2>/dev/null | wc -l | tr -d ' ' || true)
video_files=$(find "$app/assets/videos" -type f 2>/dev/null | wc -l | tr -d ' ' || true)
asset_symlinks=$(find "$app/assets" -type l 2>/dev/null | wc -l | tr -d ' ' || true)
env_mode=$(stat -f '%Lp' "$HOME/.config/streamarena/env" 2>/dev/null || echo missing)
env_in_app=$(test -e "$app/.env" && echo yes || echo no)
app_env_mode=$(stat -f '%Lp' "$app/.env" 2>/dev/null || echo none)
cache_mode=$(stat -f '%Lp' "$app/cache" 2>/dev/null || echo missing)
users_db_mode=$(stat -f '%Lp' "$app/cache/users.sqlite" 2>/dev/null || echo missing)
users_db_quick_check=$(sqlite3 -readonly "$app/cache/users.sqlite" 'PRAGMA quick_check;' 2>/dev/null || echo failed)
# Match the runner's literal env reader: strip matching outer quotes and CRLF,
# retain embedded equals/dollar signs, and let the last assignment win. Never
# source operator configuration as shell code.
env_value() {
  local key="$1" file="$2" line name value result=""
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" == *=* && "$line" != \#* ]] || continue
    name="${line%%=*}"
    [[ "$name" == "$key" ]] || continue
    value="${line#*=}"
    if [[ ${#value} -ge 2 && ( "$value" == \"*\" || "$value" == \'*\' ) ]]; then
      value="${value:1:${#value}-2}"
    fi
    result="$value"
  done < "$file"
  printf '%s' "$result"
}
canonical_open_signup=$(env_value OPEN_SIGNUP "$HOME/.config/streamarena/env")
app_open_signup=$(env_value OPEN_SIGNUP "$app/.env")
effective_open_signup="${canonical_open_signup:-${app_open_signup:-unset}}"
rd_token_encryption_configured=no
rd_token_keyring=$(env_value REAL_DEBRID_TOKEN_ENCRYPTION_KEYS "$HOME/.config/streamarena/env")
if printf '%s\n' "$rd_token_keyring" \
  | grep -Eq '^[A-Za-z0-9._-]{1,48}:[A-Za-z0-9_-]{43}(,[A-Za-z0-9._-]{1,48}:[A-Za-z0-9_-]{43})*$'; then
  rd_token_encryption_configured=yes
fi
unset rd_token_keyring
live_hls_proxy_secret=$(
  env_value LIVE_HLS_PROXY_SECRET "$HOME/.config/streamarena/env"
)
live_hls_proxy_secret="${live_hls_proxy_secret#"${live_hls_proxy_secret%%[![:space:]]*}"}"
live_hls_proxy_secret="${live_hls_proxy_secret%"${live_hls_proxy_secret##*[![:space:]]}"}"
live_hls_proxy_secret_configured=no
if [[ ${#live_hls_proxy_secret} -ge 32 ]]; then
  live_hls_proxy_secret_configured=yes
fi
unset live_hls_proxy_secret
sports_http_proxy=$(
  env_value SPORTS_HTTP_PROXY "$HOME/.config/streamarena/env"
)
sports_proxy_matches_expected=$([[ "$sports_http_proxy" == "$SPORTS_PROXY_EXPECTED" ]] && echo yes || echo no)
torznab_url=$(env_value TORZNAB_API_URL "$HOME/.config/streamarena/env")
torznab_key=$(env_value TORZNAB_API_KEY "$HOME/.config/streamarena/env")
torznab_configured=$([[ -n "$torznab_url" && -n "$torznab_key" ]] && echo yes || echo no)
torznab_local_jackett=no
case "$torznab_url" in http://127.0.0.1:9117/*|http://localhost:9117/*) torznab_local_jackett=yes ;; esac
jackett_listener=$(lsof -nP -iTCP:9117 -sTCP:LISTEN -Fn 2>/dev/null | sed -n 's/^n//p' | sort -u | paste -sd, - || true)
jackett_launch_state=$(launch_value system/com.fightingentropy.jackett state)
jackett_indexers_mode=$(stat -f '%Lp' "$HOME/Library/Application Support/Jackett/Indexers" 2>/dev/null || echo missing)
jackett_credentials_private=yes
if find "$HOME/Library/Application Support/Jackett/Indexers" -name '*.json' ! -perm 600 -print -quit 2>/dev/null | grep -q .; then
  jackett_credentials_private=no
fi
# Capabilities test API/auth health without a fixed title or upstream catalog hit.
# Set TORZNAB_CHECK_QUERY for an additional real search. Empty RSS is valid;
# Torznab <error> responses and malformed XML always fail.
torznab_caps_http=skipped
torznab_caps_valid=no
torznab_search_http=skipped
torznab_search_valid=skipped
torznab_search_items=0
torznab_request_base() {
  # Match build_torznab_request_url: replace an embedded apikey rather than
  # sending duplicate values (Jackett rejects even two identical keys).
  python3 -c '
import sys
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
try:
    url = urlsplit(sys.stdin.read().strip())
    query = [(key, value) for key, value in parse_qsl(url.query, keep_blank_values=True) if key.lower() != "apikey"]
    print(urlunsplit(url._replace(query=urlencode(query))))
except ValueError:
    print("")
'
}
torznab_xml() {
  python3 - "$1" "$2" <<'XML'
import sys
import xml.etree.ElementTree as ET
try:
    root = ET.parse(sys.argv[1]).getroot()
    tag = lambda el: el.tag.rsplit("}", 1)[-1]
    if any(tag(el) == "error" for el in root.iter()):
        raise ValueError("Torznab API error")
    if sys.argv[2] == "caps":
        valid = tag(root) == "caps" and any(tag(el) == "searching" for el in root)
        print("yes" if valid else "no")
    else:
        valid = tag(root) == "rss" and any(tag(el) == "channel" for el in root)
        print(sum(tag(el) == "item" for el in root.iter()) if valid else "invalid")
except (ET.ParseError, OSError, ValueError):
    print("no" if sys.argv[2] == "caps" else "invalid")
XML
}
if [[ "$torznab_configured" == "yes" ]]; then
  torznab_probe=$(mktemp)
  torznab_base=$(printf '%s' "$torznab_url" | torznab_request_base)
  torznab_caps_http=$(curl -sS -G -o "$torznab_probe" -w '%{http_code}' --max-time 15 "$torznab_base" \
    --data-urlencode "apikey=$torznab_key" --data-urlencode 't=caps' 2>/dev/null || true)
  torznab_caps_valid=$(torznab_xml "$torznab_probe" caps)
  if [[ -n "$TORZNAB_CHECK_QUERY" ]]; then
    torznab_search_http=$(curl -sS -G -o "$torznab_probe" -w '%{http_code}' --max-time 45 "$torznab_base" \
      --data-urlencode "apikey=$torznab_key" --data-urlencode 't=search' \
      --data-urlencode "q=$TORZNAB_CHECK_QUERY" --data-urlencode 'limit=20' 2>/dev/null || true)
    torznab_search_items=$(torznab_xml "$torznab_probe" search)
    torznab_search_valid=$([[ "$torznab_search_items" =~ ^[0-9]+$ ]] && echo yes || echo no)
  fi
  rm -f "$torznab_probe"
fi
unset torznab_key
app_daemon=$(test -f "/Library/LaunchDaemons/com.fightingentropy.streamarena-app.plist" && echo yes || echo no)
caddy_daemon=$(test -f "/Library/LaunchDaemons/com.fightingentropy.streamarena-caddy.plist" && echo yes || echo no)
legacy_caddy_daemon=$(test -e "$legacy_caddy_plist" && echo yes || echo no)
legacy_caddy_loaded=$(launchctl print "system/xyz.streamarena.caddy" >/dev/null 2>&1 && echo yes || echo no)
app_launch_state=$(launchctl print "system/com.fightingentropy.streamarena-app" 2>/dev/null | awk -F= '/state =/ {gsub(/[ ";]/, "", $2); print $2; exit}' || true)
caddy_launch_state=$(launchctl print "system/com.fightingentropy.streamarena-caddy" 2>/dev/null | awk -F= '/state =/ {gsub(/[ ";]/, "", $2); print $2; exit}' || true)
app_runs=$(launchctl print "system/com.fightingentropy.streamarena-app" 2>/dev/null | awk -F= '/runs =/ {gsub(/[ ";]/, "", $2); print $2; exit}' || true)
caddy_runs=$(launchctl print "system/com.fightingentropy.streamarena-caddy" 2>/dev/null | awk -F= '/runs =/ {gsub(/[ ";]/, "", $2); print $2; exit}' || true)
maintenance_helper="/Library/Application Support/StreamArena/maintenance.py"
maintenance_helper_private=no
if [[ "$(sudo -n stat -f '%u:%Lp' "$maintenance_helper" 2>/dev/null || true)" == "0:644" \
   && "$(sudo -n stat -f '%u:%Lp' "$(dirname "$maintenance_helper")" 2>/dev/null || true)" == "0:755" \
   && ! -L "$maintenance_helper" ]]; then
  maintenance_helper_private=yes
fi
maintenance_job() {
  local mode="$1" label="com.fightingentropy.streamarena-$2" info state last_exit disabled arguments
  info=$(launchctl print "system/$label" 2>/dev/null || true)
  [[ -n "$info" ]] || { echo missing; return; }
  disabled=$(launchctl print-disabled system 2>/dev/null | grep -E "\"$label\"[[:space:]]*=>[[:space:]]*(true|disabled)([[:space:]]|$)" || true)
  [[ -z "$disabled" ]] || { echo disabled; return; }
  arguments=$(printf '%s\n' "$info" | awk '
    /^[[:space:]]*arguments = \{/ {inside=1; next}
    inside && /^[[:space:]]*}/ {exit}
    inside {gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print}')
  if [[ "$arguments" != $'/usr/bin/python3\n'"$maintenance_helper"$'\n'"$mode" ]]; then
    echo wrong-helper; return
  fi
  state=$(launch_value "system/$label" state)
  last_exit=$(launch_value "system/$label" 'last exit code')
  if [[ "$state" == "running" || ( "$state" == "not running" && ( -z "$last_exit" || "$last_exit" == "0" ) ) ]]; then
    echo healthy
  else
    echo "failed:$state:exit=$last_exit"
  fi
}
log_maintenance=$(maintenance_job rotate log-rotation)
disk_maintenance=$(maintenance_job disk disk-monitor)
watchdog_maintenance=$(maintenance_job watchdog watchdog)
maintenance_gui_duplicates=no
for label in log-rotation disk-monitor watchdog; do
  if launchctl print "gui/$(id -u)/com.fightingentropy.streamarena-$label" >/dev/null 2>&1; then
    maintenance_gui_duplicates=yes
  fi
done
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
browser_hls_session_relay=$(test -f "$app/bin/serve-browser-hls-session.mjs" && echo yes || echo no)
cdnlivetv_hls_resolver=$(test -f "$app/bin/resolve-cdnlivetv-hls.mjs" && echo yes || echo no)
resolver_runtime_helper=$(test -f "$app/bin/lib/load-playwright.mjs" && echo yes || echo no)
node_bin=$(command -v node || true)
bun_bin=$(command -v bun || true)
resolver_runtime_smoke=no
if [[ -n "$node_bin" && -f "$app/bin/check-resolver-runtime.mjs" ]]; then
  if STREAMARENA_NODE_DEPS_DIR="$node_deps_dir" \
    "$node_bin" "$app/bin/check-resolver-runtime.mjs" "$app/bin" >/dev/null 2>&1; then
    resolver_runtime_smoke=yes
  fi
fi
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
espn_probe=$(mktemp)
espn_http=$(curl -sS --max-time 12 -o "$espn_probe" -w '%{http_code}' \
  'https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard?limit=500' 2>/dev/null || true)
espn_football_event_count=$(jq -er 'if (.events | type) == "array" then (.events | length) else error("missing events") end' "$espn_probe" 2>/dev/null || echo invalid)
rm -f "$espn_probe"

printf 'release_marker=%s\n' "${release_marker:-missing}"
printf 'caddy_config=%s\n' "${caddy_config:-missing}"
printf 'caddy_config_valid=%s\n' "${caddy_config_valid:-missing}"
printf 'caddy_loopback=%s\n' "${caddy_loopback:-missing}"
printf 'tunnel_launch_state=%s\n' "${tunnel_launch_state:-missing}"
printf 'tunnel_ingress_valid=%s\n' "${tunnel_ingress_valid:-missing}"
printf 'tunnel_primary_service=%s\n' "${tunnel_primary_service:-missing}"
printf 'tunnel_alias_service=%s\n' "${tunnel_alias_service:-missing}"
printf 'local_proxy_http=%s\n' "${local_proxy_http:-missing}"
printf 'local_http_redirect=%s\n' "${local_http_redirect:-missing}"
printf 'local_alias_redirect=%s\n' "${local_alias_redirect:-missing}"
printf 'torznab_local_jackett=%s\n' "${torznab_local_jackett:-missing}"
printf 'jackett_credentials_private=%s\n' "${jackett_credentials_private:-missing}"
printf 'torznab_caps_http=%s\n' "${torznab_caps_http:-missing}"
printf 'torznab_caps_valid=%s\n' "${torznab_caps_valid:-missing}"
printf 'torznab_search_valid=%s\n' "${torznab_search_valid:-missing}"
printf 'espn_http=%s\n' "${espn_http:-missing}"
printf 'maintenance_helper_private=%s\n' "${maintenance_helper_private:-missing}"
printf 'log_maintenance=%s\n' "${log_maintenance:-missing}"
printf 'disk_maintenance=%s\n' "${disk_maintenance:-missing}"
printf 'watchdog_maintenance=%s\n' "${watchdog_maintenance:-missing}"
printf 'maintenance_gui_duplicates=%s\n' "${maintenance_gui_duplicates:-missing}"
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
printf 'caddy_client_ip_guard=%s\n' "$caddy_client_ip_guard"
printf 'caddy_https_redirect=%s\n' "$caddy_https_redirect"
printf 'caddy_direct_origin=%s\n' "$caddy_direct_origin"
printf 'asset_files=%s\n' "$asset_files"
printf 'video_files=%s\n' "$video_files"
printf 'asset_symlinks=%s\n' "$asset_symlinks"
printf 'env_mode=%s\n' "$env_mode"
printf 'env_in_app=%s\n' "$env_in_app"
printf 'app_env_mode=%s\n' "$app_env_mode"
printf 'cache_mode=%s\n' "$cache_mode"
printf 'users_db_mode=%s\n' "$users_db_mode"
printf 'users_db_quick_check=%s\n' "$users_db_quick_check"
printf 'effective_open_signup=%s\n' "$effective_open_signup"
printf 'rd_token_encryption_configured=%s\n' "$rd_token_encryption_configured"
printf 'live_hls_proxy_secret_configured=%s\n' "$live_hls_proxy_secret_configured"
printf 'sports_proxy_matches_expected=%s\n' "$sports_proxy_matches_expected"
printf 'torznab_configured=%s\n' "$torznab_configured"
printf 'jackett_listener=%s\n' "${jackett_listener:-missing}"
printf 'jackett_launch_state=%s\n' "${jackett_launch_state:-missing}"
printf 'jackett_indexers_mode=%s\n' "$jackett_indexers_mode"
printf 'torznab_search_http=%s\n' "$torznab_search_http"
printf 'torznab_search_items=%s\n' "$torznab_search_items"
printf 'espn_football_event_count=%s\n' "$espn_football_event_count"
printf 'app_daemon=%s\n' "$app_daemon"
printf 'caddy_daemon=%s\n' "$caddy_daemon"
printf 'legacy_caddy_daemon=%s\n' "$legacy_caddy_daemon"
printf 'legacy_caddy_loaded=%s\n' "$legacy_caddy_loaded"
printf 'app_launch_state=%s\n' "${app_launch_state:-missing}"
printf 'caddy_launch_state=%s\n' "${caddy_launch_state:-missing}"
printf 'app_runs=%s\n' "${app_runs:-missing}"
printf 'caddy_runs=%s\n' "${caddy_runs:-missing}"
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
printf 'browser_hls_session_relay=%s\n' "$browser_hls_session_relay"
printf 'cdnlivetv_hls_resolver=%s\n' "$cdnlivetv_hls_resolver"
printf 'resolver_runtime_helper=%s\n' "$resolver_runtime_helper"
printf 'resolver_runtime_smoke=%s\n' "$resolver_runtime_smoke"
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
remote_output="$(cat "$remote_output_file")"
rm -f "$remote_output_file"
trap - EXIT

printf '%s\n' "$remote_output"

value_for() {
  printf '%s\n' "$remote_output" | awk -F= -v key="$1" '$1 == key {print substr($0, length(key) + 2); exit}'
}

release_marker=$(value_for release_marker)
caddy_config=$(value_for caddy_config)
caddy_config_valid=$(value_for caddy_config_valid)
caddy_loopback=$(value_for caddy_loopback)
tunnel_launch_state=$(value_for tunnel_launch_state)
tunnel_ingress_valid=$(value_for tunnel_ingress_valid)
tunnel_primary_service=$(value_for tunnel_primary_service)
tunnel_alias_service=$(value_for tunnel_alias_service)
local_proxy_http=$(value_for local_proxy_http)
local_http_redirect=$(value_for local_http_redirect)
local_alias_redirect=$(value_for local_alias_redirect)
torznab_local_jackett=$(value_for torznab_local_jackett)
jackett_credentials_private=$(value_for jackett_credentials_private)
torznab_caps_http=$(value_for torznab_caps_http)
torznab_caps_valid=$(value_for torznab_caps_valid)
torznab_search_valid=$(value_for torznab_search_valid)
espn_http=$(value_for espn_http)
maintenance_helper_private=$(value_for maintenance_helper_private)
log_maintenance=$(value_for log_maintenance)
disk_maintenance=$(value_for disk_maintenance)
watchdog_maintenance=$(value_for watchdog_maintenance)
maintenance_gui_duplicates=$(value_for maintenance_gui_duplicates)
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
caddy_client_ip_guard=$(value_for caddy_client_ip_guard)
caddy_https_redirect=$(value_for caddy_https_redirect)
caddy_direct_origin=$(value_for caddy_direct_origin)
asset_symlinks=$(value_for asset_symlinks)
env_mode=$(value_for env_mode)
env_in_app=$(value_for env_in_app)
app_env_mode=$(value_for app_env_mode)
cache_mode=$(value_for cache_mode)
users_db_mode=$(value_for users_db_mode)
users_db_quick_check=$(value_for users_db_quick_check)
effective_open_signup=$(value_for effective_open_signup)
rd_token_encryption_configured=$(value_for rd_token_encryption_configured)
live_hls_proxy_secret_configured=$(value_for live_hls_proxy_secret_configured)
sports_proxy_matches_expected=$(value_for sports_proxy_matches_expected)
torznab_configured=$(value_for torznab_configured)
jackett_listener=$(value_for jackett_listener)
jackett_launch_state=$(value_for jackett_launch_state)
jackett_indexers_mode=$(value_for jackett_indexers_mode)
torznab_search_http=$(value_for torznab_search_http)
torznab_search_items=$(value_for torznab_search_items)
espn_football_event_count=$(value_for espn_football_event_count)
app_daemon=$(value_for app_daemon)
caddy_daemon=$(value_for caddy_daemon)
legacy_caddy_daemon=$(value_for legacy_caddy_daemon)
legacy_caddy_loaded=$(value_for legacy_caddy_loaded)
app_launch_state=$(value_for app_launch_state)
caddy_launch_state=$(value_for caddy_launch_state)
app_runs=$(value_for app_runs)
caddy_runs=$(value_for caddy_runs)
cron_leftover=$(value_for cron_leftover)
disk_capacity_percent=$(value_for disk_capacity_percent)
disk_available_gb=$(value_for disk_available_gb)
public_ip=$(value_for public_ip)
hls_resolver=$(value_for hls_resolver)
streamed_hls_resolver=$(value_for streamed_hls_resolver)
matchstream_hls_resolver=$(value_for matchstream_hls_resolver)
ntvs_hls_resolver=$(value_for ntvs_hls_resolver)
browser_hls_session_relay=$(value_for browser_hls_session_relay)
cdnlivetv_hls_resolver=$(value_for cdnlivetv_hls_resolver)
resolver_runtime_helper=$(value_for resolver_runtime_helper)
resolver_runtime_smoke=$(value_for resolver_runtime_smoke)
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
# Cloudflare) in the PUBLIC_URL section below.
[[ "$listener" == "127.0.0.1:5173" ]] && pass "backend listener is localhost only" || bad "backend listener is '$listener'"
[[ "$release_marker" == "valid" || "$release_marker" == "absent" ]] && pass "release metadata is $release_marker" || bad "release metadata is malformed or not a regular file"
[[ "$app_pid" != "missing" ]] && pass "backend launchd process is running ($app_pid)" || bad "backend process missing"
[[ "$caddy_pid" != "missing" ]] && pass "Caddy launchd process is running ($caddy_pid)" || bad "Caddy process missing"
[[ "$caddy_version" != "missing" ]] && pass "Caddy is installed ($caddy_version)" || bad "Caddy is missing"
[[ "$caddy_config_valid" == "yes" ]] && pass "running Caddy configuration validates ($caddy_config)" || bad "running Caddy configuration is missing or invalid"
if [[ "$MINI_INGRESS_MODE" == "tunnel" ]]; then
  [[ "$caddy_loopback" == "127.0.0.1:$STREAMARENA_CADDY_PORT" ]] && pass "Caddy StreamArena listener is loopback only" || bad "Caddy StreamArena listener is '$caddy_loopback'"
  [[ "$tunnel_daemon" == "yes" && "$tunnel_launch_state" == "running" && "$tunnel_pid" != "missing" ]] && pass "Cloudflare Tunnel daemon is running ($tunnel_pid)" || bad "Cloudflare Tunnel daemon is missing or not running"
  [[ "$tunnel_ingress_valid" == "yes" ]] && pass "active Cloudflare Tunnel ingress validates" || bad "active Cloudflare Tunnel ingress is invalid"
  expected_tunnel_service="http://127.0.0.1:$STREAMARENA_CADDY_PORT"
  [[ "$tunnel_primary_service" == "$expected_tunnel_service" ]] && pass "primary Tunnel route reaches StreamArena Caddy" || bad "primary Tunnel route is '$tunnel_primary_service'"
  [[ "$tunnel_alias_service" == "$expected_tunnel_service" ]] && pass "alias Tunnel route reaches StreamArena Caddy" || bad "alias Tunnel route is '$tunnel_alias_service'"
  [[ "$local_proxy_http" == "$PROTECTED_ENDPOINT_STATUS" ]] && pass "local Caddy forwards HTTPS protected requests" || bad "local Caddy proxy returned HTTP $local_proxy_http"
  for kind in http alias; do
    if [[ "$kind" == "http" ]]; then result="$local_http_redirect"; else result="$local_alias_redirect"; fi
    status="${result%% *}"; target="${result#* }"
    [[ ( "$status" == "301" || "$status" == "308" ) && "$target" == "$PUBLIC_URL/login.html?mini_check=1" ]] \
      && pass "local Caddy $kind redirect preserves the canonical path and query" \
      || bad "local Caddy $kind redirect returned '$result'"
  done
else
  [[ "$caddy_80" == *":80" ]] && pass "Caddy owns port 80" || bad "Caddy port 80 listener is '$caddy_80'"
  [[ "$caddy_443" == *":443" ]] && pass "Caddy owns port 443" || bad "Caddy port 443 listener is '$caddy_443'"
  [[ "$caddy_client_ip_guard" == "yes" ]] && pass "Caddy sanitizes client IP headers using Cloudflare's trusted ranges" || bad "Caddy client IP trust guard is missing"
  [[ "$caddy_https_redirect" == "yes" ]] && pass "Caddy redirects public HTTP requests to HTTPS" || bad "Caddy HTTPS redirect is missing"
  [[ "$caddy_direct_origin" == "yes" ]] && pass "Caddy retains the Cloudflare-only direct Worker origin" || bad "Caddy direct Worker origin is missing"
fi
[[ "$asset_symlinks" == "0" ]] && pass "mini assets have no symlinks" || bad "mini assets have $asset_symlinks symlink(s)"
[[ "$hls_resolver" == "yes" ]] && pass "external HLS resolver script is deployed" || bad "external HLS resolver script is missing"
[[ "$streamed_hls_resolver" == "yes" ]] && pass "Streamed sports HLS resolver script is deployed" || bad "Streamed sports HLS resolver script is missing"
[[ "$matchstream_hls_resolver" == "yes" ]] && pass "MatchStream sports HLS resolver script is deployed" || bad "MatchStream sports HLS resolver script is missing"
[[ "$ntvs_hls_resolver" == "yes" ]] && pass "NTVS sports HLS resolver script is deployed" || bad "NTVS sports HLS resolver script is missing"
[[ "$browser_hls_session_relay" == "yes" ]] && pass "browser HLS session relay script is deployed" || bad "browser HLS session relay script is missing"
[[ "$cdnlivetv_hls_resolver" == "yes" ]] && pass "cdnlivetv sports HLS resolver script is deployed" || bad "cdnlivetv sports HLS resolver script is missing"
[[ "$resolver_runtime_helper" == "yes" ]] && pass "shared Playwright resolver loader is deployed" || bad "shared Playwright resolver loader is missing"
[[ "$resolver_runtime_smoke" == "yes" ]] && pass "resolver runtime import graph loads from the deployed bundle" || bad "resolver runtime import graph is broken"
[[ "$node_bin" != "missing" ]] && pass "Node is available for resolver helpers ($node_bin)" || bad "Node is missing for resolver helpers"
[[ "$bun_bin" != "missing" ]] && pass "Bun is available for resolver dependency installs ($bun_bin)" || bad "Bun is missing for resolver dependency installs"
[[ "$playwright_module" == "yes" ]] && pass "Playwright module is installed for resolver helpers" || bad "Playwright module is missing for resolver helpers"
[[ "$libsodium_module" == "yes" ]] && pass "libsodium-wrappers module is installed for native VidLink resolver" || bad "libsodium-wrappers module is missing for native VidLink resolver"
[[ "$playwright_chromium" == "yes" ]] && pass "Playwright Chromium is installed for resolver helpers" || bad "Playwright Chromium is missing for resolver helpers"
[[ "$env_mode" == "600" ]] && pass "server env permissions are 600" || bad "server env permissions are $env_mode"
[[ "$cache_mode" == "700" ]] && pass "runtime cache permissions are 700" || bad "runtime cache permissions are $cache_mode"
[[ "$users_db_mode" == "600" ]] && pass "users database permissions are 600" || bad "users database permissions are $users_db_mode"
[[ "$users_db_quick_check" == "ok" ]] && pass "users database quick_check is ok" || bad "users database quick_check is $users_db_quick_check"
[[ "$effective_open_signup" == "$EXPECTED_OPEN_SIGNUP" ]] \
  && pass "OPEN_SIGNUP is $effective_open_signup" \
  || bad "OPEN_SIGNUP is $effective_open_signup (expected $EXPECTED_OPEN_SIGNUP)"
[[ "$rd_token_encryption_configured" == "yes" ]] && pass "Real-Debrid token encryption key ring is configured" || bad "REAL_DEBRID_TOKEN_ENCRYPTION_KEYS is missing or malformed"
[[ "$live_hls_proxy_secret_configured" == "yes" ]] && pass "LIVE_HLS_PROXY_SECRET is pinned (32+ characters)" || bad "LIVE_HLS_PROXY_SECRET is missing or shorter than 32 characters"
if [[ "$env_in_app" == "no" ]]; then
  pass "deploy tree has no .env (secrets stay in the canonical env file)"
elif [[ "$app_env_mode" == "600" ]]; then
  pass "deploy-tree .env is present and 600-secured"
else
  bad "deploy-tree .env permissions are $app_env_mode (expected 600)"
fi
[[ "$sports_proxy_matches_expected" == "yes" ]] && pass "SPORTS_HTTP_PROXY points at WARP local proxy" || bad "SPORTS_HTTP_PROXY does not match expected WARP local proxy"
if [[ "$torznab_configured" == "yes" ]]; then
  if [[ "$torznab_local_jackett" == "yes" ]]; then
    [[ "$jackett_listener" == "127.0.0.1:9117" ]] && pass "Jackett listens on localhost only" || bad "Jackett listener is '$jackett_listener'"
    [[ "$jackett_launch_state" == "running" ]] && pass "Jackett system launchd state is running" || bad "Jackett system launchd state is $jackett_launch_state"
    [[ "$jackett_indexers_mode" == "700" && "$jackett_credentials_private" == "yes" ]] && pass "Jackett indexer credentials are private" || bad "Jackett indexer credential permissions are unsafe"
  fi
  [[ "$torznab_caps_http" == "200" && "$torznab_caps_valid" == "yes" ]] && pass "Torznab authenticated capabilities are valid" || bad "Torznab capabilities failed (HTTP $torznab_caps_http, valid=$torznab_caps_valid)"
  if [[ -n "$TORZNAB_CHECK_QUERY" ]]; then
    [[ "$torznab_search_http" == "200" && "$torznab_search_valid" == "yes" ]] && pass "Torznab search returned valid RSS ($torznab_search_items items)" || bad "Torznab search failed (HTTP $torznab_search_http, valid=$torznab_search_valid)"
  fi
fi
[[ "$warp_cli" != "missing" ]] && pass "WARP CLI is installed ($warp_cli)" || bad "WARP CLI is missing"
[[ "$warp_status" == "Connected" ]] && pass "WARP is connected" || bad "WARP status is $warp_status"
[[ "$warp_mode" == "WarpProxy on port 40000" ]] && pass "WARP is in local proxy mode on port 40000" || bad "WARP mode is $warp_mode"
[[ "$streamed_proxy_http" == "200" ]] && pass "Streamed schedule is reachable through WARP proxy" || bad "Streamed schedule through WARP proxy returned HTTP $streamed_proxy_http"
[[ "$ntvs_proxy_http" == "200" ]] && pass "NTVS football search is reachable through WARP proxy" || bad "NTVS football search through WARP proxy returned HTTP $ntvs_proxy_http"
[[ "$espn_http" == "200" && "$espn_football_event_count" =~ ^[0-9]+$ ]] && pass "ESPN football schedule is valid ($espn_football_event_count events)" || bad "ESPN football schedule is malformed or unreachable (HTTP $espn_http)"
[[ "$app_daemon" == "yes" ]] && pass "backend LaunchDaemon exists" || bad "backend LaunchDaemon missing"
[[ "$caddy_daemon" == "yes" ]] && pass "Caddy LaunchDaemon exists" || bad "Caddy LaunchDaemon missing"
[[ "$legacy_caddy_daemon" == "no" ]] && pass "legacy Caddy LaunchDaemon file is removed" || bad "legacy Caddy LaunchDaemon file still exists"
[[ "$legacy_caddy_loaded" == "no" ]] && pass "legacy Caddy launchd service is unloaded" || bad "legacy Caddy launchd service is still loaded"
[[ "$app_launch_state" == "running" ]] && pass "backend launchd state is running (runs=$app_runs)" || bad "backend launchd state is $app_launch_state"
[[ "$caddy_launch_state" == "running" ]] && pass "Caddy launchd state is running (runs=$caddy_runs)" || bad "Caddy launchd state is $caddy_launch_state"
[[ "$maintenance_helper_private" == "yes" ]] && pass "maintenance helper is root-owned and not writable by other users" || bad "maintenance helper has unsafe permissions or is missing"
for task in log disk watchdog; do
  case "$task" in log) state="$log_maintenance" ;; disk) state="$disk_maintenance" ;; watchdog) state="$watchdog_maintenance" ;; esac
  [[ "$state" == "healthy" ]] && pass "$task maintenance system timer is healthy" || bad "$task maintenance system timer is $state"
done
[[ "$maintenance_gui_duplicates" == "no" ]] && pass "maintenance jobs have no duplicate GUI agents" || bad "duplicate maintenance GUI jobs are loaded"
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

[[ "$public_ip" != "missing" && -n "$public_ip" ]] && pass "mini public IP is $public_ip" || bad "mini public IP could not be resolved"

# The app is private: an anonymous request for the homepage must redirect to the
# sign-in page rather than render anything, and that sign-in page must load.
public_status="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "$PUBLIC_URL" || true)"
[[ "$public_status" == "302" ]] && pass "$PUBLIC_URL gates anonymous visitors (HTTP 302 to login)" || bad "$PUBLIC_URL returned HTTP $public_status (expected 302 redirect to login)"

public_edge_server="$(
  { curl -sSI --max-time 10 "$PUBLIC_URL" 2>/dev/null || true; } \
    | awk -F: 'tolower($1) == "server" {gsub(/^[[:space:]]+|[[:space:]\r]+$/, "", $2); print tolower($2); exit}'
)"
[[ "$public_edge_server" == "cloudflare" ]] && pass "$PUBLIC_HOST is Cloudflare-proxied" || bad "$PUBLIC_HOST edge server is '$public_edge_server' (expected cloudflare)"

public_login_status="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "$PUBLIC_URL/login.html" || true)"
[[ "$public_login_status" == "200" ]] && pass "$PUBLIC_URL/login.html is reachable (HTTP 200)" || bad "$PUBLIC_URL/login.html returned HTTP $public_login_status"

public_http_result="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 "http://$PUBLIC_HOST/login.html" || true)"
public_http_status="${public_http_result%% *}"
public_http_target="${public_http_result#* }"
if [[ ("$public_http_status" == "301" || "$public_http_status" == "308") && "$public_http_target" == "$PUBLIC_URL/login.html" ]]; then
  pass "public HTTP login redirects permanently to canonical HTTPS"
else
  bad "public HTTP login returned '$public_http_result' (expected permanent redirect to $PUBLIC_URL/login.html)"
fi

public_alias_result="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 "https://$PUBLIC_ALIAS_HOST/login.html" || true)"
public_alias_status="${public_alias_result%% *}"
public_alias_target="${public_alias_result#* }"
if [[ ("$public_alias_status" == "301" || "$public_alias_status" == "308") && "$public_alias_target" == "$PUBLIC_URL/login.html" ]]; then
  pass "alternate hostname redirects permanently to canonical HTTPS"
else
  bad "alternate hostname returned '$public_alias_result' (expected permanent redirect to $PUBLIC_URL/login.html)"
fi

public_robots_header="$({ curl -sSI --max-time 10 "$PUBLIC_URL/login.html" 2>/dev/null || true; } \
  | awk -F: 'tolower($1) == "x-robots-tag" {sub(/^[[:space:]]+/, "", $2); sub(/[[:space:]\r]+$/, "", $2); print tolower($2); exit}')"
[[ "$public_robots_header" == "noindex, nofollow, noarchive, nosnippet" ]] \
  && pass "public responses carry a site-wide X-Robots-Tag" \
  || bad "public X-Robots-Tag is '$public_robots_header'"

robots_body="$(curl -fsS --max-time 10 "$PUBLIC_URL/robots.txt" 2>/dev/null || true)"
if printf '%s\n' "$robots_body" | grep -Eqi '^User-agent:[[:space:]]*\*$' \
  && printf '%s\n' "$robots_body" | grep -Eqi '^Disallow:[[:space:]]*/$'; then
  pass "robots.txt disallows all crawling"
else
  bad "robots.txt does not disallow all crawling"
fi

auth_config_file="$(mktemp)"
auth_config_status="$(curl -sS -o "$auth_config_file" -w '%{http_code}' --max-time 10 "$PUBLIC_URL/api/auth/config" || true)"
auth_config_open="$(jq -r 'if .signup.open == false then "false" elif .signup.open == true then "true" else "missing" end' "$auth_config_file" 2>/dev/null || echo invalid)"
rm -f "$auth_config_file"
expected_signup_json=false
[[ "$EXPECTED_OPEN_SIGNUP" == "1" ]] && expected_signup_json=true
if [[ "$auth_config_status" == "200" && "$auth_config_open" == "$expected_signup_json" ]]; then
  pass "public auth config confirms signup.open=$expected_signup_json"
else
  bad "public auth config returned HTTP $auth_config_status with signup.open=$auth_config_open"
fi

for protected_path in /api/config /api/health /api/home/bootstrap /assets/images/thumbnail.jpg; do
  protected_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$PUBLIC_URL$protected_path" || true)"
  [[ "$protected_status" == "$PROTECTED_ENDPOINT_STATUS" ]] \
    && pass "$protected_path requires authentication" \
    || bad "$protected_path returned HTTP $protected_status (expected $PROTECTED_ENDPOINT_STATUS)"
done

public_auth_status="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "$PUBLIC_URL/api/auth/me" || true)"
[[ "$public_auth_status" == "401" ]] && pass "$PUBLIC_URL keeps app login active" || bad "$PUBLIC_URL app auth returned HTTP $public_auth_status"

# Reverse-proxy check (replaces the retired direct-origin Caddy probes): a
# protected route must reach the backend through the configured ingress and come
# back with the auth-required status, proving the full edge path is intact.
public_proxy_status="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "$PUBLIC_URL/api/library" || true)"
[[ "$public_proxy_status" == "$PROTECTED_ENDPOINT_STATUS" ]] && pass "Caddy reverse-proxies protected routes via $PUBLIC_HOST (HTTP $PROTECTED_ENDPOINT_STATUS)" || bad "$PUBLIC_URL/api/library returned HTTP $public_proxy_status"

exit "$fail"

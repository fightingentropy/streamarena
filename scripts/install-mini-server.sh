#!/usr/bin/env bash
set -euo pipefail

MINI_HOST="${MINI_HOST:-hermes@m4mini.local}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_codex_m4mini}"
REMOTE_APP="${REMOTE_APP:-/Users/hermes/Developer/netflix}"
CADDY_VERSION="${CADDY_VERSION:-2.11.3}"
PUBLIC_HOSTS="${PUBLIC_HOSTS:-streamarena.xyz,www.streamarena.xyz}"
TLS_MODE="${TLS_MODE:-auto}"

usage() {
  cat <<'USAGE'
Usage: scripts/install-mini-server.sh [options]

Installs/updates the Mac mini production server stack:
  - /usr/local/bin/caddy
  - /Users/hermes/.local/bin/netflix-run-backend
  - /Library/LaunchDaemons/com.fightingentropy.netflix-app.plist
  - /Library/LaunchDaemons/com.fightingentropy.netflix-caddy.plist

Options:
  --tls-mode <mode>            auto or internal. Default: auto.
  -h, --help                   Show this help.

Environment:
  MINI_HOST                    Default: hermes@m4mini.local
  SSH_KEY                      Default: ~/.ssh/id_ed25519_codex_m4mini
  REMOTE_APP                   Default: /Users/hermes/Developer/netflix
  CADDY_VERSION                Default: 2.11.3
  PUBLIC_HOSTS                 Default: streamarena.xyz,www.streamarena.xyz
  TLS_MODE                     Default: auto
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tls-mode)
      [[ $# -ge 2 ]] || { echo "--tls-mode requires a value" >&2; exit 2; }
      TLS_MODE="$2"
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

ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$MINI_HOST" \
  "REMOTE_APP='$REMOTE_APP' CADDY_VERSION='$CADDY_VERSION' PUBLIC_HOSTS='$PUBLIC_HOSTS' TLS_MODE='$TLS_MODE' bash -s" <<'REMOTE'
set -euo pipefail

state_dir="$HOME/.local/state/netflix"
bin_dir="$HOME/.local/bin"
caddy_config_dir="$HOME/.config/caddy"
caddy_data_dir="/var/db/netflix-caddy"
caddy_log_dir="$state_dir"
app_plist="/Library/LaunchDaemons/com.fightingentropy.netflix-app.plist"
caddy_plist="/Library/LaunchDaemons/com.fightingentropy.netflix-caddy.plist"
sysctl_plist="/Library/LaunchDaemons/com.fightingentropy.netflix-sysctl.plist"
caddy_bin="/usr/local/bin/caddy"

mkdir -p "$state_dir" "$bin_dir" "$caddy_config_dir"
chmod 700 "$state_dir" "$bin_dir" "$caddy_config_dir"

if [[ ! -x "$REMOTE_APP/bin/netflix-rust-backend" ]]; then
  echo "Missing backend binary: $REMOTE_APP/bin/netflix-rust-backend" >&2
  exit 1
fi

installed_version=""
if [[ -x "$caddy_bin" ]]; then
  installed_version="$("$caddy_bin" version 2>/dev/null | awk '{print $1}' | sed 's/^v//')"
fi

if [[ "$installed_version" != "$CADDY_VERSION" ]]; then
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT
  archive="$tmp_dir/caddy.tar.gz"
  url="https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_mac_arm64.tar.gz"
  curl -fsSL "$url" -o "$archive"
  tar -xzf "$archive" -C "$tmp_dir" caddy
  chmod 755 "$tmp_dir/caddy"
  sudo install -m 755 "$tmp_dir/caddy" "$caddy_bin"
fi

case "$TLS_MODE" in
  auto|internal) ;;
  *)
    echo "TLS_MODE must be auto or internal" >&2
    exit 2
    ;;
esac

cat > "$bin_dir/netflix-run-backend" <<'SCRIPT'
#!/bin/bash
set -uo pipefail

export PATH="/Users/hermes/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NETFLIX_ENV_FILE="${NETFLIX_ENV_FILE:-/Users/hermes/.config/netflix/env}"
export RUST_BACKTRACE="${RUST_BACKTRACE:-1}"
cd /Users/hermes/Developer/netflix

if [[ -f "$NETFLIX_ENV_FILE" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "${line//[[:space:]]/}" || "$line" == \#* || "$line" != *=* ]] && continue

    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue

    if [[ "$value" == \"*\" && "$value" == *\" && ${#value} -ge 2 ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' && ${#value} -ge 2 ]]; then
      value="${value:1:${#value}-2}"
    fi

    export "$key=$value"
  done < "$NETFLIX_ENV_FILE"
fi

printf '%s backend starting binary=/Users/hermes/Developer/netflix/bin/netflix-rust-backend\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
/Users/hermes/Developer/netflix/bin/netflix-rust-backend
status=$?
printf '%s backend exited status=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$status" >&2
exit "$status"
SCRIPT
chmod 700 "$bin_dir/netflix-run-backend"
bash -n "$bin_dir/netflix-run-backend"

host_blocks=""
IFS=',' read -r -a hosts <<< "$PUBLIC_HOSTS"
for host in "${hosts[@]}"; do
  host="${host//[[:space:]]/}"
  [[ -n "$host" ]] || continue
  if [[ -z "$host_blocks" ]]; then
    host_blocks="$host"
  else
    host_blocks="$host_blocks, $host"
  fi
done
if [[ -z "$host_blocks" ]]; then
  echo "PUBLIC_HOSTS resolved to an empty host list" >&2
  exit 1
fi

tls_line=""
if [[ "$TLS_MODE" == "internal" ]]; then
  tls_line="  tls internal"
fi

tmp_caddy_config="$(mktemp)"
cat > "$tmp_caddy_config" <<CADDY
{
  admin off
  auto_https disable_redirects
}

(netflix_proxy) {
  encode zstd gzip
  reverse_proxy 127.0.0.1:5173 {
    lb_try_duration 30s
    lb_try_interval 250ms
  }
  log {
    output file $caddy_log_dir/caddy-access.log {
      roll_size 10MiB
      roll_keep 10
      roll_keep_for 168h
    }
  }
}

http:// {
  import netflix_proxy
}

$host_blocks {
$tls_line
  import netflix_proxy
}
CADDY
"$caddy_bin" fmt --overwrite "$tmp_caddy_config"
sudo install -m 600 "$tmp_caddy_config" "$caddy_config_dir/Caddyfile"
rm -f "$tmp_caddy_config"
sudo "$caddy_bin" validate --config "$caddy_config_dir/Caddyfile" --adapter caddyfile

sudo mkdir -p "$caddy_data_dir/config" "$caddy_log_dir"
sudo chmod 755 "$caddy_data_dir" "$caddy_data_dir/config"

tmp_app_plist="$(mktemp)"
cat > "$tmp_app_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.fightingentropy.netflix-app</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/hermes/.local/bin/netflix-run-backend</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/hermes/Developer/netflix</string>
  <key>UserName</key>
  <string>hermes</string>
  <key>GroupName</key>
  <string>staff</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/Users/hermes/.local/state/netflix/backend.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/hermes/.local/state/netflix/backend.err.log</string>
</dict>
</plist>
PLIST

tmp_caddy_plist="$(mktemp)"
cat > "$tmp_caddy_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.fightingentropy.netflix-caddy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/caddy</string>
    <string>run</string>
    <string>--config</string>
    <string>/Users/hermes/.config/caddy/Caddyfile</string>
    <string>--adapter</string>
    <string>caddyfile</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>/var/db/netflix-caddy</string>
    <key>XDG_CONFIG_HOME</key>
    <string>/var/db/netflix-caddy/config</string>
    <key>XDG_DATA_HOME</key>
    <string>/var/db/netflix-caddy</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/Users/hermes/.local/state/netflix/caddy.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/hermes/.local/state/netflix/caddy.err.log</string>
</dict>
</plist>
PLIST

# Boot-time kernel tuning: the default accept-queue cap (kern.ipc.somaxconn=128)
# clamps the backend's requested listen backlog, dropping connection bursts under
# load. A one-shot RunAtLoad daemon raises it so the setting survives reboots.
tmp_sysctl_plist="$(mktemp)"
cat > "$tmp_sysctl_plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.fightingentropy.netflix-sysctl</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/sbin/sysctl</string>
    <string>-w</string>
    <string>kern.ipc.somaxconn=1024</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
PLIST

sudo install -m 644 "$tmp_app_plist" "$app_plist"
sudo install -m 644 "$tmp_caddy_plist" "$caddy_plist"
sudo install -m 644 "$tmp_sysctl_plist" "$sysctl_plist"
rm -f "$tmp_app_plist" "$tmp_caddy_plist" "$tmp_sysctl_plist"

sudo launchctl bootout system "$app_plist" 2>/dev/null || true
sudo launchctl bootout system "$caddy_plist" 2>/dev/null || true
sudo launchctl bootout system "$sysctl_plist" 2>/dev/null || true
sudo launchctl bootstrap system "$app_plist"
sudo launchctl bootstrap system "$caddy_plist"
sudo launchctl bootstrap system "$sysctl_plist"
sudo launchctl enable system/com.fightingentropy.netflix-app 2>/dev/null || true
sudo launchctl enable system/com.fightingentropy.netflix-caddy 2>/dev/null || true
sudo launchctl enable system/com.fightingentropy.netflix-sysctl 2>/dev/null || true
sudo launchctl kickstart -k system/com.fightingentropy.netflix-app
sudo launchctl kickstart -k system/com.fightingentropy.netflix-caddy
sudo launchctl kickstart system/com.fightingentropy.netflix-sysctl

sleep 2
backend_http=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:5173/api/library || true)
caddy_http=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1/api/library || true)
caddy_https=$(curl -k -sS -o /dev/null -w "%{http_code}" --resolve "${hosts[0]}:443:127.0.0.1" --max-time 5 "https://${hosts[0]}/api/library" || true)

printf 'backend_http=%s\n' "$backend_http"
printf 'caddy_http=%s\n' "$caddy_http"
printf 'caddy_https=%s\n' "$caddy_https"
printf 'caddy_version='
"$caddy_bin" version | awk '{print $1}'
launchctl print system/com.fightingentropy.netflix-app 2>/dev/null | awk '/state =|pid =|runs =|last exit code =|path =/ {print}'
launchctl print system/com.fightingentropy.netflix-caddy 2>/dev/null | awk '/state =|pid =|runs =|last exit code =|path =/ {print}'

case "$backend_http" in 200|401) ;; *) exit 1 ;; esac
case "$caddy_http" in 200|401) ;; *) exit 1 ;; esac
case "$caddy_https" in 200|401) ;; *) exit 1 ;; esac
REMOTE

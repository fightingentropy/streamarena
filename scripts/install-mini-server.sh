#!/usr/bin/env bash
set -euo pipefail
umask 077

MINI_HOST="${MINI_HOST:-hermes@m4mini.local}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_codex_m4mini}"
REMOTE_APP="${REMOTE_APP:-/Users/hermes/Developer/streamarena}"
CADDY_VERSION="${CADDY_VERSION:-2.11.3}"
PUBLIC_HOSTS="${PUBLIC_HOSTS:-streamarena.xyz,www.streamarena.xyz}"
TLS_MODE="${TLS_MODE:-auto}"

usage() {
  cat <<'USAGE'
Usage: scripts/install-mini-server.sh [options]

Installs/updates the Mac mini production server stack:
  - /usr/local/bin/caddy
  - /Users/hermes/.local/bin/streamarena-run-backend
  - /Library/LaunchDaemons/com.fightingentropy.streamarena-app.plist
  - /Library/LaunchDaemons/com.fightingentropy.streamarena-caddy.plist

Options:
  --tls-mode <mode>            auto or internal. Default: auto.
  -h, --help                   Show this help.

Environment:
  MINI_HOST                    Default: hermes@m4mini.local
  SSH_KEY                      Default: ~/.ssh/id_ed25519_codex_m4mini
  REMOTE_APP                   Default: /Users/hermes/Developer/streamarena
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

state_dir="$HOME/.local/state/streamarena"
bin_dir="$HOME/.local/bin"
caddy_config_dir="$HOME/.config/caddy"
caddy_data_dir="/var/db/streamarena-caddy"
caddy_log_dir="$state_dir"
app_plist="/Library/LaunchDaemons/com.fightingentropy.streamarena-app.plist"
caddy_plist="/Library/LaunchDaemons/com.fightingentropy.streamarena-caddy.plist"
legacy_caddy_label="xyz.streamarena.caddy"
legacy_caddy_plist="/Library/LaunchDaemons/${legacy_caddy_label}.plist"
sysctl_plist="/Library/LaunchDaemons/com.fightingentropy.streamarena-sysctl.plist"
caddy_bin="/usr/local/bin/caddy"

mkdir -p "$state_dir" "$bin_dir" "$caddy_config_dir"
chmod 700 "$state_dir" "$bin_dir" "$caddy_config_dir"
mkdir -p "$REMOTE_APP/cache"
chmod 700 "$REMOTE_APP/cache"
find "$REMOTE_APP/cache" -maxdepth 1 -type f -name 'users.sqlite*' -exec chmod 600 {} +

if [[ ! -x "$REMOTE_APP/bin/streamarena-backend" ]]; then
  echo "Missing backend binary: $REMOTE_APP/bin/streamarena-backend" >&2
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

cat > "$bin_dir/streamarena-run-backend" <<'SCRIPT'
#!/bin/bash
set -uo pipefail
umask 077

export PATH="/Users/hermes/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export STREAMARENA_ENV_FILE="${STREAMARENA_ENV_FILE:-/Users/hermes/.config/streamarena/env}"
export RUST_BACKTRACE="${RUST_BACKTRACE:-1}"
cd /Users/hermes/Developer/streamarena
mkdir -p cache
chmod 700 cache
find cache -maxdepth 1 -type f -name 'users.sqlite*' -exec chmod 600 {} +

if [[ -f "$STREAMARENA_ENV_FILE" ]]; then
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
  done < "$STREAMARENA_ENV_FILE"
fi

printf '%s backend starting binary=/Users/hermes/Developer/streamarena/bin/streamarena-backend\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
/Users/hermes/Developer/streamarena/bin/streamarena-backend
status=$?
printf '%s backend exited status=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$status" >&2
exit "$status"
SCRIPT
chmod 700 "$bin_dir/streamarena-run-backend"
bash -n "$bin_dir/streamarena-run-backend"

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

# Resolve Cloudflare's authoritative edge ranges at install time. Caddy only
# trusts client-IP headers from those peers and rewrites CF-Connecting-IP for
# every upstream request, so a direct-to-origin caller cannot spoof a fresh
# rate-limit identity.
cloudflare_ranges="$(
  {
    curl -fsSL https://www.cloudflare.com/ips-v4
    printf '\n'
    curl -fsSL https://www.cloudflare.com/ips-v6
  } | awk '
    NF {
      if ($0 !~ /^[0-9A-Fa-f:.]+\/[0-9]+$/) exit 1
      printf "%s ", $0
      count += 1
    }
    END { if (count < 10) exit 1 }
  '
)"

tls_line=""
if [[ "$TLS_MODE" == "internal" ]]; then
  tls_line="  tls internal"
fi

tmp_caddy_config="$(mktemp)"
cat > "$tmp_caddy_config" <<CADDY
{
  admin off
  auto_https disable_redirects
  servers {
    trusted_proxies static $cloudflare_ranges
    trusted_proxies_strict
    client_ip_headers CF-Connecting-IP X-Forwarded-For
  }
}

(streamarena_proxy) {
  @untrusted_origin not remote_ip private_ranges $cloudflare_ranges
  respond @untrusted_origin 403
  encode zstd gzip
  reverse_proxy 127.0.0.1:5173 {
    lb_try_duration 30s
    lb_try_interval 250ms
    header_up CF-Connecting-IP {client_ip}
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
  import streamarena_proxy
}

$host_blocks {
$tls_line
  import streamarena_proxy
}
CADDY
"$caddy_bin" fmt --overwrite "$tmp_caddy_config"
caddy_config_changed=1
if [[ -f "$caddy_config_dir/Caddyfile" ]] && cmp -s "$tmp_caddy_config" "$caddy_config_dir/Caddyfile"; then
  caddy_config_changed=0
fi
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
  <string>com.fightingentropy.streamarena-app</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/hermes/.local/bin/streamarena-run-backend</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/hermes/Developer/streamarena</string>
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
  <string>/Users/hermes/.local/state/streamarena/backend.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/hermes/.local/state/streamarena/backend.err.log</string>
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
  <string>com.fightingentropy.streamarena-caddy</string>
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
    <string>/var/db/streamarena-caddy</string>
    <key>XDG_CONFIG_HOME</key>
    <string>/var/db/streamarena-caddy/config</string>
    <key>XDG_DATA_HOME</key>
    <string>/var/db/streamarena-caddy</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/Users/hermes/.local/state/streamarena/caddy.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/hermes/.local/state/streamarena/caddy.err.log</string>
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
  <string>com.fightingentropy.streamarena-sysctl</string>
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

app_plist_changed=1
caddy_plist_changed=1
sysctl_plist_changed=1
[[ -f "$app_plist" ]] && cmp -s "$tmp_app_plist" "$app_plist" && app_plist_changed=0
[[ -f "$caddy_plist" ]] && cmp -s "$tmp_caddy_plist" "$caddy_plist" && caddy_plist_changed=0
[[ -f "$sysctl_plist" ]] && cmp -s "$tmp_sysctl_plist" "$sysctl_plist" && sysctl_plist_changed=0
sudo install -m 644 "$tmp_app_plist" "$app_plist"
sudo install -m 644 "$tmp_caddy_plist" "$caddy_plist"
sudo install -m 644 "$tmp_sysctl_plist" "$sysctl_plist"
rm -f "$tmp_app_plist" "$tmp_caddy_plist" "$tmp_sysctl_plist"

old_app_pids="$(pgrep -f "$REMOTE_APP/bin/streamarena-backend" 2>/dev/null || true)"
if launchctl print system/com.fightingentropy.streamarena-app >/dev/null 2>&1; then
  if [[ "$app_plist_changed" -eq 1 ]]; then
    sudo launchctl bootout system "$app_plist" 2>/dev/null || true
    sudo launchctl bootstrap system "$app_plist"
  else
    # SIGTERM lets the backend drain active responses before launchd's KeepAlive
    # starts the newly deployed binary.
    pkill -TERM -f "$REMOTE_APP/bin/streamarena-backend" 2>/dev/null || true
  fi
else
  if [[ -n "$old_app_pids" ]]; then
    pkill -TERM -f "$REMOTE_APP/bin/streamarena-backend" 2>/dev/null || true
  fi
  sudo launchctl bootstrap system "$app_plist"
fi

# Do not report a successful deploy while the old in-memory binary is still
# draining. The backend allows at most 30 seconds before closing long-lived
# responses, then launchd's KeepAlive starts the replacement.
if [[ -n "$old_app_pids" ]]; then
  replacement_ready=0
  for _ in {1..40}; do
    old_still_running=0
    while IFS= read -r pid; do
      [[ -n "$pid" ]] || continue
      if kill -0 "$pid" 2>/dev/null; then
        old_still_running=1
        break
      fi
    done <<< "$old_app_pids"
    current_app_pids="$(pgrep -f "$REMOTE_APP/bin/streamarena-backend" 2>/dev/null || true)"
    if [[ "$old_still_running" -eq 0 && -n "$current_app_pids" ]]; then
      replacement_ready=1
      break
    fi
    sleep 1
  done
  if [[ "$replacement_ready" -ne 1 ]]; then
    echo "Backend replacement did not start within 40 seconds" >&2
    exit 1
  fi
fi

# Older installs used a KeepAlive service with a different label. Stop and
# remove it before adopting the canonical daemon; killing only its process lets
# launchd immediately respawn it and leaves the new Caddy unable to bind ports.
if launchctl print "system/$legacy_caddy_label" >/dev/null 2>&1; then
  echo "Retiring legacy Caddy LaunchDaemon: $legacy_caddy_label"
  sudo launchctl bootout "system/$legacy_caddy_label" 2>/dev/null \
    || sudo launchctl bootout system "$legacy_caddy_plist" 2>/dev/null \
    || true
  for _ in {1..15}; do
    launchctl print "system/$legacy_caddy_label" >/dev/null 2>&1 || break
    sleep 1
  done
  if launchctl print "system/$legacy_caddy_label" >/dev/null 2>&1; then
    echo "Legacy Caddy LaunchDaemon did not stop within 15 seconds" >&2
    exit 1
  fi
fi
sudo rm -f "$legacy_caddy_plist"

if launchctl print system/com.fightingentropy.streamarena-caddy >/dev/null 2>&1; then
  if [[ "$caddy_plist_changed" -eq 1 || "$caddy_config_changed" -eq 1 ]]; then
    sudo launchctl bootout system "$caddy_plist" 2>/dev/null || true
    sudo launchctl bootstrap system "$caddy_plist"
  fi
else
  # Adopt an older manually-started Caddy without racing it for :80/:443.
  if pgrep -x caddy >/dev/null 2>&1; then
    sudo pkill -TERM -x caddy 2>/dev/null || true
    for _ in {1..15}; do
      pgrep -x caddy >/dev/null 2>&1 || break
      sleep 1
    done
    if pgrep -x caddy >/dev/null 2>&1; then
      echo "Unmanaged Caddy did not stop within 15 seconds" >&2
      exit 1
    fi
  fi
  sudo launchctl bootstrap system "$caddy_plist"
fi

if launchctl print system/com.fightingentropy.streamarena-sysctl >/dev/null 2>&1; then
  if [[ "$sysctl_plist_changed" -eq 1 ]]; then
    sudo launchctl bootout system "$sysctl_plist" 2>/dev/null || true
    sudo launchctl bootstrap system "$sysctl_plist"
  fi
else
  sudo launchctl bootstrap system "$sysctl_plist"
fi
sudo launchctl enable system/com.fightingentropy.streamarena-app 2>/dev/null || true
sudo launchctl enable system/com.fightingentropy.streamarena-caddy 2>/dev/null || true
sudo launchctl enable system/com.fightingentropy.streamarena-sysctl 2>/dev/null || true
sudo launchctl kickstart system/com.fightingentropy.streamarena-app 2>/dev/null || true
sudo launchctl kickstart system/com.fightingentropy.streamarena-caddy 2>/dev/null || true
sudo launchctl kickstart system/com.fightingentropy.streamarena-sysctl 2>/dev/null || true

sleep 2
backend_http=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:5173/api/library || true)
caddy_http=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1/api/library || true)
caddy_https=$(curl -k -sS -o /dev/null -w "%{http_code}" --resolve "${hosts[0]}:443:127.0.0.1" --max-time 5 "https://${hosts[0]}/api/library" || true)

printf 'backend_http=%s\n' "$backend_http"
printf 'caddy_http=%s\n' "$caddy_http"
printf 'caddy_https=%s\n' "$caddy_https"
printf 'caddy_version='
"$caddy_bin" version | awk '{print $1}'
launchctl print system/com.fightingentropy.streamarena-app 2>/dev/null | awk '/state =|pid =|runs =|last exit code =|path =/ {print}'
launchctl print system/com.fightingentropy.streamarena-caddy 2>/dev/null | awk '/state =|pid =|runs =|last exit code =|path =/ {print}'

case "$backend_http" in 200|401) ;; *) exit 1 ;; esac
case "$caddy_http" in 200|401) ;; *) exit 1 ;; esac
case "$caddy_https" in 200|401) ;; *) exit 1 ;; esac
REMOTE

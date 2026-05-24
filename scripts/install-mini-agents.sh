#!/usr/bin/env bash
set -euo pipefail

MINI_HOST="${MINI_HOST:-hermes@m4mini.local}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_codex_m4mini}"
REMOTE_APP="${REMOTE_APP:-/Users/hermes/Developer/netflix}"
DISK_MAX_PERCENT="${DISK_MAX_PERCENT:-90}"
DISK_MIN_FREE_GB="${DISK_MIN_FREE_GB:-50}"
WATCHDOG_URL="${WATCHDOG_URL:-http://127.0.0.1:5173/}"
WATCHDOG_INTERVAL_SECONDS="${WATCHDOG_INTERVAL_SECONDS:-60}"
WATCHDOG_FAILURE_THRESHOLD="${WATCHDOG_FAILURE_THRESHOLD:-1}"
WATCHDOG_TIMEOUT_SECONDS="${WATCHDOG_TIMEOUT_SECONDS:-5}"

ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$MINI_HOST" \
  "REMOTE_APP='$REMOTE_APP' DISK_MAX_PERCENT='$DISK_MAX_PERCENT' DISK_MIN_FREE_GB='$DISK_MIN_FREE_GB' WATCHDOG_URL='$WATCHDOG_URL' WATCHDOG_INTERVAL_SECONDS='$WATCHDOG_INTERVAL_SECONDS' WATCHDOG_FAILURE_THRESHOLD='$WATCHDOG_FAILURE_THRESHOLD' WATCHDOG_TIMEOUT_SECONDS='$WATCHDOG_TIMEOUT_SECONDS' bash -s" <<'REMOTE'
set -euo pipefail

uid="$(id -u)"
state_dir="$HOME/.local/state/netflix"
bin_dir="$HOME/.local/bin"
agents_dir="$HOME/Library/LaunchAgents"
mkdir -p "$state_dir" "$bin_dir" "$agents_dir"
chmod 700 "$state_dir" "$bin_dir" "$agents_dir"
launchctl bootout "gui/$uid" "$agents_dir/com.fightingentropy.netflix-hero-previews.plist" 2>/dev/null || true
rm -f \
  "$agents_dir/com.fightingentropy.netflix-hero-previews.plist" \
  "$bin_dir/netflix-refresh-hero-previews" \
  "$REMOTE_APP/bin/netflix-refresh-hero-previews.py" \
  "$REMOTE_APP/assets/hero-previews.json"
rm -rf "$REMOTE_APP/assets/videos/hero-previews"

cat > "$bin_dir/netflix-rotate-logs" <<'SCRIPT'
#!/bin/bash
set -euo pipefail

log_dir="/Users/hermes/.local/state/netflix"
keep=7
max_bytes=$((5 * 1024 * 1024))
force="${1:-}"

for name in backend.log backend.err.log caddy.log caddy.err.log caddy-access.log disk-monitor.log watchdog.log; do
  file="$log_dir/$name"
  [[ -f "$file" ]] || continue
  size=$(stat -f %z "$file" 2>/dev/null || echo 0)
  [[ "$size" -gt 0 ]] || continue
  if [[ "$force" != "--force" && "$size" -lt "$max_bytes" ]]; then
    continue
  fi
  stamp=$(date +%Y%m%d-%H%M%S)
  archive="$log_dir/$name.$stamp"
  cp "$file" "$archive"
  : > "$file"
  gzip -f "$archive"
  ls -1t "$log_dir/$name".*.gz 2>/dev/null | sed -n "$((keep + 1)),\$p" | while IFS= read -r old; do
    rm -f "$old"
  done
done
SCRIPT

cat > "$bin_dir/netflix-disk-monitor" <<'SCRIPT'
#!/bin/bash
set -euo pipefail

app="__REMOTE_APP__"
state_dir="/Users/hermes/.local/state/netflix"
log_file="$state_dir/disk-monitor.log"
max_percent="__DISK_MAX_PERCENT__"
min_free_gb="__DISK_MIN_FREE_GB__"
mkdir -p "$state_dir"
chmod 700 "$state_dir"

df_line=$(df -Pk "$app" | awk 'NR == 2 {print $4 " " $5}')
available_kb=${df_line%% *}
capacity=${df_line##* }
capacity=${capacity%%%}
available_gb=$((available_kb / 1024 / 1024))
timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if [[ "$capacity" -ge "$max_percent" || "$available_gb" -lt "$min_free_gb" ]]; then
  printf '%s WARN disk usage=%s%% free=%sGB max=%s%% min_free=%sGB\n' "$timestamp" "$capacity" "$available_gb" "$max_percent" "$min_free_gb" >> "$log_file"
  chmod 600 "$log_file"
  exit 2
fi

printf '%s OK disk usage=%s%% free=%sGB max=%s%% min_free=%sGB\n' "$timestamp" "$capacity" "$available_gb" "$max_percent" "$min_free_gb" >> "$log_file"
chmod 600 "$log_file"
SCRIPT
sed -i '' \
  -e "s|__REMOTE_APP__|$REMOTE_APP|g" \
  -e "s|__DISK_MAX_PERCENT__|$DISK_MAX_PERCENT|g" \
  -e "s|__DISK_MIN_FREE_GB__|$DISK_MIN_FREE_GB|g" \
  "$bin_dir/netflix-disk-monitor"

cat > "$bin_dir/netflix-watchdog" <<'SCRIPT'
#!/bin/bash
set -euo pipefail

url="__WATCHDOG_URL__"
timeout_seconds="__WATCHDOG_TIMEOUT_SECONDS__"
failure_threshold="__WATCHDOG_FAILURE_THRESHOLD__"
app="__REMOTE_APP__"
launcher="/Users/hermes/.local/bin/netflix-run-backend"
state_dir="/Users/hermes/.local/state/netflix"
log_file="$state_dir/watchdog.log"
fail_file="$state_dir/watchdog.failures"
lock_dir="$state_dir/watchdog.lock"
backend_pattern="$app/bin/netflix-rust-backend"
launchd_label="com.fightingentropy.netflix-app"

mkdir -p "$state_dir"
chmod 700 "$state_dir"

timestamp() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

log() {
  printf '%s %s\n' "$(timestamp)" "$*" >> "$log_file"
  chmod 600 "$log_file"
}

failures() {
  if [[ -f "$fail_file" ]]; then
    tr -cd '0-9' < "$fail_file"
  else
    printf '0'
  fi
}

record_failures() {
  printf '%s\n' "$1" > "$fail_file"
  chmod 600 "$fail_file"
}

clear_failures() {
  rm -f "$fail_file"
}

kill_stale_ffmpeg() {
  local pids
  pids="$(pgrep -x ffmpeg 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    log "restart ffmpeg=none"
    return 0
  fi

  log "restart ffmpeg_term_pids=$(printf '%s' "$pids" | paste -sd, -)"
  pkill -TERM -x ffmpeg 2>/dev/null || true
  sleep 2
  pids="$(pgrep -x ffmpeg 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    log "restart ffmpeg_kill_pids=$(printf '%s' "$pids" | paste -sd, -)"
    pkill -KILL -x ffmpeg 2>/dev/null || true
  fi
}

restart_backend() {
  local reason="$1"
  local old_pids
  local current_pids

  if ! mkdir "$lock_dir" 2>/dev/null; then
    log "restart skipped reason=$reason lock=held"
    return 0
  fi
  trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT

  log "restart begin reason=$reason"
  kill_stale_ffmpeg

  old_pids="$(pgrep -f "$backend_pattern" 2>/dev/null || true)"
  if pgrep -f "$backend_pattern" >/dev/null 2>&1; then
    pkill -TERM -f "$backend_pattern" 2>/dev/null || true
    sleep 5
  fi

  current_pids="$(pgrep -f "$backend_pattern" 2>/dev/null || true)"
  if [[ -n "$current_pids" && "$current_pids" != "$old_pids" ]]; then
    log "restart launched=launchd_auto pids=$(printf '%s' "$current_pids" | paste -sd, -)"
    clear_failures
    log "restart end reason=$reason"
    return 0
  fi

  if pgrep -f "$backend_pattern" >/dev/null 2>&1; then
    pkill -KILL -f "$backend_pattern" 2>/dev/null || true
    sleep 2
  fi

  current_pids="$(pgrep -f "$backend_pattern" 2>/dev/null || true)"
  if [[ -n "$current_pids" ]]; then
    log "restart launched=launchd_after_kill pids=$(printf '%s' "$current_pids" | paste -sd, -)"
    clear_failures
    log "restart end reason=$reason"
    return 0
  fi

  if launchctl kickstart -k "system/$launchd_label" >/dev/null 2>&1; then
    log "restart launched=launchctl label=$launchd_label"
  else
    if [[ ! -x "$launcher" ]]; then
      log "restart failed launcher_missing=$launcher"
      return 1
    fi
    nohup "$launcher" >> "$state_dir/backend.log" 2>> "$state_dir/backend.err.log" &
    log "restart launched=script path=$launcher pid=$!"
  fi

  clear_failures
  log "restart end reason=$reason"
}

http_code="$(curl -sS -o /dev/null -w "%{http_code}" --max-time "$timeout_seconds" "$url" 2>/dev/null || true)"
http_code="${http_code:-000}"

if [[ "$http_code" == "200" ]]; then
  previous="$(failures)"
  clear_failures
  log "OK url=$url http=$http_code previous_failures=$previous"
  exit 0
fi

count="$(failures)"
count=$((count + 1))
record_failures "$count"
log "FAIL url=$url http=$http_code failures=$count threshold=$failure_threshold"

if [[ "$count" -ge "$failure_threshold" ]]; then
  restart_backend "probe_http_$http_code failures=$count threshold=$failure_threshold"
fi
SCRIPT
sed -i '' \
  -e "s|__REMOTE_APP__|$REMOTE_APP|g" \
  -e "s|__WATCHDOG_URL__|$WATCHDOG_URL|g" \
  -e "s|__WATCHDOG_TIMEOUT_SECONDS__|$WATCHDOG_TIMEOUT_SECONDS|g" \
  -e "s|__WATCHDOG_FAILURE_THRESHOLD__|$WATCHDOG_FAILURE_THRESHOLD|g" \
  "$bin_dir/netflix-watchdog"

chmod 700 "$bin_dir/netflix-rotate-logs" "$bin_dir/netflix-disk-monitor" "$bin_dir/netflix-watchdog"
bash -n "$bin_dir/netflix-rotate-logs"
bash -n "$bin_dir/netflix-disk-monitor"
bash -n "$bin_dir/netflix-watchdog"

cat > "$agents_dir/com.fightingentropy.netflix-log-rotation.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.fightingentropy.netflix-log-rotation</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/hermes/.local/bin/netflix-rotate-logs</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>17</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/hermes/.local/state/netflix/log-rotation.launchd.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/hermes/.local/state/netflix/log-rotation.launchd.err.log</string>
</dict>
</plist>
PLIST

cat > "$agents_dir/com.fightingentropy.netflix-disk-monitor.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.fightingentropy.netflix-disk-monitor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/hermes/.local/bin/netflix-disk-monitor</string>
  </array>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/hermes/.local/state/netflix/disk-monitor.launchd.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/hermes/.local/state/netflix/disk-monitor.launchd.err.log</string>
</dict>
</plist>
PLIST

chmod 600 "$agents_dir/com.fightingentropy.netflix-log-rotation.plist" "$agents_dir/com.fightingentropy.netflix-disk-monitor.plist"

cat > "$agents_dir/com.fightingentropy.netflix-watchdog.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.fightingentropy.netflix-watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/hermes/.local/bin/netflix-watchdog</string>
  </array>
  <key>StartInterval</key>
  <integer>$WATCHDOG_INTERVAL_SECONDS</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/hermes/.local/state/netflix/watchdog.launchd.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/hermes/.local/state/netflix/watchdog.launchd.err.log</string>
</dict>
</plist>
PLIST

chmod 600 "$agents_dir/com.fightingentropy.netflix-watchdog.plist"

# Remove the old cron-based rotation now that launchd owns it.
tmp_cron="$(mktemp)"
crontab -l 2>/dev/null | grep -v 'netflix-rotate-logs' > "$tmp_cron" || true
if [[ -s "$tmp_cron" ]]; then
  crontab "$tmp_cron"
else
  crontab -r 2>/dev/null || true
fi
rm -f "$tmp_cron"

load_agent() {
  local label="$1"
  local plist="$2"
  launchctl bootout "gui/$uid" "$plist" 2>/dev/null || true
  launchctl bootstrap "gui/$uid" "$plist"
  launchctl enable "gui/$uid/$label" 2>/dev/null || true
}

load_agent "com.fightingentropy.netflix-log-rotation" "$agents_dir/com.fightingentropy.netflix-log-rotation.plist"
load_agent "com.fightingentropy.netflix-disk-monitor" "$agents_dir/com.fightingentropy.netflix-disk-monitor.plist"
load_agent "com.fightingentropy.netflix-watchdog" "$agents_dir/com.fightingentropy.netflix-watchdog.plist"
launchctl kickstart -k "gui/$uid/com.fightingentropy.netflix-disk-monitor" 2>/dev/null || true
launchctl kickstart -k "gui/$uid/com.fightingentropy.netflix-watchdog" 2>/dev/null || true

"$bin_dir/netflix-disk-monitor"
"$bin_dir/netflix-watchdog"

printf 'installed_agents=ok\n'
launchctl print "gui/$uid/com.fightingentropy.netflix-log-rotation" 2>/dev/null | awk '/state =|path =|program =/ {print}'
launchctl print "gui/$uid/com.fightingentropy.netflix-disk-monitor" 2>/dev/null | awk '/state =|path =|program =|last exit code =/ {print}'
launchctl print "gui/$uid/com.fightingentropy.netflix-watchdog" 2>/dev/null | awk '/state =|path =|program =|last exit code =/ {print}'
printf 'crontab_leftover='
crontab -l 2>/dev/null | grep -c 'netflix-rotate-logs' || true
printf 'disk_log_tail=\n'
tail -5 "$state_dir/disk-monitor.log"
printf 'watchdog_log_tail=\n'
tail -5 "$state_dir/watchdog.log"
REMOTE

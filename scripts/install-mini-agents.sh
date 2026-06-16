#!/usr/bin/env bash
set -euo pipefail

MINI_HOST="${MINI_HOST:-hermes@m4mini.local}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_codex_m4mini}"
REMOTE_APP="${REMOTE_APP:-/Users/hermes/Developer/streamarena}"
DISK_MAX_PERCENT="${DISK_MAX_PERCENT:-90}"
DISK_MIN_FREE_GB="${DISK_MIN_FREE_GB:-50}"
WATCHDOG_URL="${WATCHDOG_URL:-http://127.0.0.1:5173/api/health/live}"
WATCHDOG_INTERVAL_SECONDS="${WATCHDOG_INTERVAL_SECONDS:-60}"
WATCHDOG_FAILURE_THRESHOLD="${WATCHDOG_FAILURE_THRESHOLD:-3}"
WATCHDOG_TIMEOUT_SECONDS="${WATCHDOG_TIMEOUT_SECONDS:-10}"

ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$MINI_HOST" \
  "REMOTE_APP='$REMOTE_APP' DISK_MAX_PERCENT='$DISK_MAX_PERCENT' DISK_MIN_FREE_GB='$DISK_MIN_FREE_GB' WATCHDOG_URL='$WATCHDOG_URL' WATCHDOG_INTERVAL_SECONDS='$WATCHDOG_INTERVAL_SECONDS' WATCHDOG_FAILURE_THRESHOLD='$WATCHDOG_FAILURE_THRESHOLD' WATCHDOG_TIMEOUT_SECONDS='$WATCHDOG_TIMEOUT_SECONDS' bash -s" <<'REMOTE'
set -euo pipefail

uid="$(id -u)"
state_dir="$HOME/.local/state/streamarena"
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

cat > "$bin_dir/streamarena-rotate-logs" <<'SCRIPT'
#!/bin/bash
set -euo pipefail

log_dir="/Users/hermes/.local/state/streamarena"
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

cat > "$bin_dir/streamarena-disk-monitor" <<'SCRIPT'
#!/bin/bash
set -euo pipefail

app="__REMOTE_APP__"
state_dir="/Users/hermes/.local/state/streamarena"
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
  "$bin_dir/streamarena-disk-monitor"

cat > "$bin_dir/streamarena-watchdog" <<'SCRIPT'
#!/bin/bash
set -euo pipefail

url="__WATCHDOG_URL__"
timeout_seconds="__WATCHDOG_TIMEOUT_SECONDS__"
failure_threshold="__WATCHDOG_FAILURE_THRESHOLD__"
# A genuine outage of `failure_threshold` strikes at the ~60s probe interval spans at
# least ~(threshold-1)*60s of wall-clock. Require the failing streak to cover most of
# that before restarting, so a burst of bunched/overlapping probes can't trip a restart
# on a momentary blip. Assumes the 60s StartInterval in the watchdog plist below.
min_streak_seconds=$(( (failure_threshold - 1) * 45 ))
app="__REMOTE_APP__"
launcher="/Users/hermes/.local/bin/streamarena-run-backend"
state_dir="/Users/hermes/.local/state/streamarena"
log_file="$state_dir/watchdog.log"
fail_file="$state_dir/watchdog.failures"
run_lock="$state_dir/watchdog.run.lock"
backend_pattern="$app/bin/streamarena-backend"
launchd_label="com.fightingentropy.streamarena-app"

mkdir -p "$state_dir"
chmod 700 "$state_dir"

timestamp() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

log() {
  printf '%s %s\n' "$(timestamp)" "$*" >> "$log_file"
  chmod 600 "$log_file"
}

# On a sustained hang (process up but not answering /api/health/live) capture a
# fully symbolicated thread-stack sample of the backend BEFORE the watchdog kills
# it, so a freeze leaves a real trace instead of just "http=000". The 2026-06-13
# idle freeze (whole tokio runtime wedged ~222s at 0.1 load/core) was undiagnosable
# precisely because nothing dumped the stacks. Fires once per streak (penultimate
# strike) and is bounded so a wedged profiler can never delay or abort the restart.
capture_hang_stack() {
  local pid hang_dir stamp out ctx spid kpid
  pid="$(pgrep -f "$backend_pattern" 2>/dev/null | head -1 || true)"
  if [[ -z "$pid" ]]; then
    log "hang-capture skipped reason=no_backend_pid"
    return 0
  fi
  hang_dir="$state_dir/hangdumps"
  mkdir -p "$hang_dir"
  chmod 700 "$hang_dir"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  out="$hang_dir/hang-$stamp-pid$pid.sample.txt"
  ctx="$hang_dir/hang-$stamp-pid$pid.context.txt"
  # Cheap, always-works context first: per-thread states, open-fd count, VM pressure.
  {
    printf '# hang capture %s pid=%s streak=%ss\n' "$(timestamp)" "$pid" "${streak_seconds:-0}"
    printf '## ps -M (per-thread):\n'
    ps -M "$pid" 2>/dev/null || true
    printf '## open fds: '
    lsof -p "$pid" 2>/dev/null | wc -l | tr -d ' '
    printf '\n## vm_stat:\n'
    vm_stat 2>/dev/null | head -10 || true
  } > "$ctx" 2>/dev/null || true
  chmod 600 "$ctx" 2>/dev/null || true
  # The prize: a 3s thread-stack sample of the hung process. Backgrounded with a
  # 30s hard kill so a stuck profiler cannot hold the watchdog run-lock.
  sample "$pid" 3 -fullPaths -file "$out" >/dev/null 2>&1 &
  spid=$!
  ( sleep 30; kill -TERM "$spid" 2>/dev/null || true ) >/dev/null 2>&1 &
  kpid=$!
  wait "$spid" 2>/dev/null || true
  kill -TERM "$kpid" 2>/dev/null || true
  wait "$kpid" 2>/dev/null || true
  chmod 600 "$out" 2>/dev/null || true
  log "hang-capture wrote pid=$pid sample=$out"
  # Keep only the most recent ~20 incidents (2 files each) so dumps can't fill disk.
  ( ls -1t "$hang_dir"/hang-*.txt 2>/dev/null || true ) | sed -n '41,$p' | while IFS= read -r old; do
    rm -f "$old"
  done
}

# Failure state is "<count> <first_failure_epoch>" so a streak can be measured in real
# wall-clock time, not just a raw count that overlapping probes could inflate.
read_failures() {
  local raw count first
  raw="$(cat "$fail_file" 2>/dev/null || true)"
  if [[ "$raw" == *" "* ]]; then
    count="${raw%% *}"
    first="${raw#* }"
  else
    count="$raw"
    first=0
  fi
  count="${count//[^0-9]/}"
  first="${first//[^0-9]/}"
  printf '%s %s\n' "${count:-0}" "${first:-0}"
}

record_failures() {
  printf '%s %s\n' "$1" "$2" > "$fail_file"
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

# Single-instance guard: never let two overlapping watchdog runs race the failure
# counter. A slow run (curl timeout, restart sleeps) can let the 60s StartInterval
# bunch up; concurrent runs previously racked up `failure_threshold` strikes in
# seconds, turning a momentary blip into a needless restart. One run at a time.
if [[ -d "$run_lock" ]]; then
  lock_age=$(( $(date +%s) - $(stat -f %m "$run_lock" 2>/dev/null || echo 0) ))
  if [[ "$lock_age" -ge 300 ]]; then
    rmdir "$run_lock" 2>/dev/null || true
  fi
fi
if ! mkdir "$run_lock" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$run_lock" 2>/dev/null || true' EXIT

now_epoch="$(date +%s)"

# Capture curl's real exit code (7=refused/down, 28=timed out/hung) as extra signal;
# both surface as HTTP 000. `set +e` so the failing probe itself doesn't abort us.
set +e
http_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$timeout_seconds" "$url" 2>/dev/null)"
curl_status=$?
set -e
http_code="${http_code:-000}"
case "$curl_status" in
  0) probe="http=$http_code" ;;
  7) probe="http=000 reason=refused" ;;
  28) probe="http=000 reason=timeout" ;;
  *) probe="http=000 reason=curl_exit_$curl_status" ;;
esac

if [[ "$http_code" == "200" ]]; then
  read -r prev_count _prev_first < <(read_failures)
  clear_failures
  log "OK url=$url $probe previous_failures=$prev_count"
  exit 0
fi

read -r prev_count prev_first < <(read_failures)
if [[ "$prev_count" -eq 0 || "$prev_first" -eq 0 ]]; then
  count=1
  first_epoch="$now_epoch"
else
  count=$((prev_count + 1))
  first_epoch="$prev_first"
fi
record_failures "$count" "$first_epoch"
streak_seconds=$((now_epoch - first_epoch))
log "FAIL url=$url $probe failures=$count threshold=$failure_threshold streak=${streak_seconds}s min_streak=${min_streak_seconds}s"

# Penultimate strike: the backend is hung but not yet restarted — grab a stack
# trace now (once per streak) so the next freeze is diagnosable from a real dump
# rather than reconstructed from gaps. Guarded to threshold>=3 so a misconfigured
# low threshold can't spam captures on a momentary blip.
if [[ "$failure_threshold" -ge 3 && "$count" -eq $((failure_threshold - 1)) ]]; then
  capture_hang_stack
fi

# Restart only on a sustained outage: enough strikes AND spanning real wall-clock,
# so a brief/transient HTTP 000 blip can no longer force a restart.
if [[ "$count" -ge "$failure_threshold" && "$streak_seconds" -ge "$min_streak_seconds" ]]; then
  restart_backend "probe_${probe// /_} failures=$count threshold=$failure_threshold streak=${streak_seconds}s"
fi
SCRIPT
sed -i '' \
  -e "s|__REMOTE_APP__|$REMOTE_APP|g" \
  -e "s|__WATCHDOG_URL__|$WATCHDOG_URL|g" \
  -e "s|__WATCHDOG_TIMEOUT_SECONDS__|$WATCHDOG_TIMEOUT_SECONDS|g" \
  -e "s|__WATCHDOG_FAILURE_THRESHOLD__|$WATCHDOG_FAILURE_THRESHOLD|g" \
  "$bin_dir/streamarena-watchdog"

chmod 700 "$bin_dir/streamarena-rotate-logs" "$bin_dir/streamarena-disk-monitor" "$bin_dir/streamarena-watchdog"
bash -n "$bin_dir/streamarena-rotate-logs"
bash -n "$bin_dir/streamarena-disk-monitor"
bash -n "$bin_dir/streamarena-watchdog"

cat > "$agents_dir/com.fightingentropy.streamarena-log-rotation.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.fightingentropy.streamarena-log-rotation</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/hermes/.local/bin/streamarena-rotate-logs</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>17</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/hermes/.local/state/streamarena/log-rotation.launchd.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/hermes/.local/state/streamarena/log-rotation.launchd.err.log</string>
</dict>
</plist>
PLIST

cat > "$agents_dir/com.fightingentropy.streamarena-disk-monitor.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.fightingentropy.streamarena-disk-monitor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/hermes/.local/bin/streamarena-disk-monitor</string>
  </array>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/hermes/.local/state/streamarena/disk-monitor.launchd.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/hermes/.local/state/streamarena/disk-monitor.launchd.err.log</string>
</dict>
</plist>
PLIST

chmod 600 "$agents_dir/com.fightingentropy.streamarena-log-rotation.plist" "$agents_dir/com.fightingentropy.streamarena-disk-monitor.plist"

cat > "$agents_dir/com.fightingentropy.streamarena-watchdog.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.fightingentropy.streamarena-watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/hermes/.local/bin/streamarena-watchdog</string>
  </array>
  <key>StartInterval</key>
  <integer>$WATCHDOG_INTERVAL_SECONDS</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/hermes/.local/state/streamarena/watchdog.launchd.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/hermes/.local/state/streamarena/watchdog.launchd.err.log</string>
</dict>
</plist>
PLIST

chmod 600 "$agents_dir/com.fightingentropy.streamarena-watchdog.plist"

# Remove the old cron-based rotation now that launchd owns it.
tmp_cron="$(mktemp)"
crontab -l 2>/dev/null | grep -v 'streamarena-rotate-logs' > "$tmp_cron" || true
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

load_agent "com.fightingentropy.streamarena-log-rotation" "$agents_dir/com.fightingentropy.streamarena-log-rotation.plist"
load_agent "com.fightingentropy.streamarena-disk-monitor" "$agents_dir/com.fightingentropy.streamarena-disk-monitor.plist"
load_agent "com.fightingentropy.streamarena-watchdog" "$agents_dir/com.fightingentropy.streamarena-watchdog.plist"
launchctl kickstart -k "gui/$uid/com.fightingentropy.streamarena-disk-monitor" 2>/dev/null || true
launchctl kickstart -k "gui/$uid/com.fightingentropy.streamarena-watchdog" 2>/dev/null || true

"$bin_dir/streamarena-disk-monitor"
"$bin_dir/streamarena-watchdog"

printf 'installed_agents=ok\n'
launchctl print "gui/$uid/com.fightingentropy.streamarena-log-rotation" 2>/dev/null | awk '/state =|path =|program =/ {print}'
launchctl print "gui/$uid/com.fightingentropy.streamarena-disk-monitor" 2>/dev/null | awk '/state =|path =|program =|last exit code =/ {print}'
launchctl print "gui/$uid/com.fightingentropy.streamarena-watchdog" 2>/dev/null | awk '/state =|path =|program =|last exit code =/ {print}'
printf 'crontab_leftover='
crontab -l 2>/dev/null | grep -c 'streamarena-rotate-logs' || true
printf 'disk_log_tail=\n'
tail -5 "$state_dir/disk-monitor.log"
printf 'watchdog_log_tail=\n'
tail -5 "$state_dir/watchdog.log"
REMOTE

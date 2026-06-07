#!/usr/bin/env bash
set -euo pipefail

APP="${REMOTE_APP:-/Users/hermes/Developer/netflix}"
DB="$APP/cache/resolver-cache.sqlite"
BASE="http://127.0.0.1:5173"
NTVS_URL="https://ntvs.cx/channel-hesgoales/NOVASPORTS-1"

echo "== Nova Sports 1 Mac mini test =="

TOKEN="$(sqlite3 "$DB" "SELECT token FROM auth_sessions WHERE expires_at > (strftime('%s','now') * 1000) ORDER BY created_at DESC LIMIT 1;" 2>/dev/null || true)"
if [[ -z "${TOKEN:-}" ]]; then
  echo "FAIL: no active auth session"
  exit 1
fi
echo "ok  active session found"

printf '%s' "$TOKEN" > /tmp/nova-session-token.txt

ENCODED_URL="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$NTVS_URL")"
curl -sS --max-time 90 -H "Cookie: session=$TOKEN" \
  "$BASE/api/sports/stream?url=$ENCODED_URL&_ts=$(date +%s)" \
  -o /tmp/nova-sports-resolve.json

python3 <<'PY'
import json
import sys
import urllib.parse
import urllib.request

with open("/tmp/nova-sports-resolve.json", encoding="utf-8") as handle:
    payload = json.load(handle)

if payload.get("error"):
    print(f"FAIL: resolver error: {payload['error']}")
    sys.exit(1)

playback_type = payload.get("playbackType")
playback_url = str(payload.get("playbackUrl") or "").strip()
player_page = str(payload.get("playerPage") or "").strip()
provider = payload.get("provider")

print(f"ok  resolver provider={provider} playbackType={playback_type}")
print(f"resolver_playback_prefix={playback_url[:120]}")

if playback_type != "hls" or not playback_url:
    print("FAIL: resolver did not return HLS playbackUrl")
    sys.exit(1)

token = open("/tmp/nova-session-token.txt", encoding="utf-8").read().strip()

if playback_url.startswith("/api/live/hls.m3u8?"):
    proxy_url = playback_url
    print("ok  resolver returned signed live HLS proxy URL")
else:
    if not playback_url.startswith("https://"):
        print(f"FAIL: unexpected playbackUrl: {playback_url}")
        sys.exit(1)
    print("ok  resolver returned upstream HLS URL (frontend will proxy)")
    query = {"input": playback_url}
    if player_page.startswith("https://"):
        query["referer"] = player_page
    proxy_url = "/api/live/hls.m3u8?" + urllib.parse.urlencode(query)

print(f"proxy_prefix={proxy_url[:120]}")

req = urllib.request.Request(
    f"http://127.0.0.1:5173{proxy_url}",
    headers={"Cookie": f"session={token}"},
)
try:
    with urllib.request.urlopen(req, timeout=45) as response:
        body = response.read().decode("utf-8", errors="replace")
        status = response.status
except urllib.error.HTTPError as error:
    print(f"FAIL: HLS proxy returned HTTP {error.code}")
    print(error.read().decode("utf-8", errors="replace")[:300])
    sys.exit(1)

print(f"hls_proxy_status={status}")
if status != 200:
    print("FAIL: HLS proxy did not return 200")
    print(body[:300])
    sys.exit(1)

print("ok  HLS proxy returned HTTP 200")
lines = [line.strip() for line in body.splitlines() if line.strip()]
print("playlist_head:")
for line in lines[:5]:
    print(line)

if not body.startswith("#EXTM3U"):
    print("FAIL: playlist missing #EXTM3U")
    sys.exit(1)

if "ch=NOVASPORTS1" in body and "input=" not in body:
    print("FAIL: playlist contains unproxied hesgoaler URL")
    sys.exit(1)

print("PASS Nova Sports 1 pipeline works on Mac mini")
PY

#!/usr/bin/env bash
set -euo pipefail
umask 077

BASE="${BASE_URL:-http://127.0.0.1:5173}"
NTVS_URL="https://hesgoal.team/ntvtvplayer.html?id=NOVASPORTS1"

echo "== Nova Sports 1 Mac mini test =="

TOKEN="${STREAMARENA_SESSION_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then
  echo "FAIL: set STREAMARENA_SESSION_TOKEN to an active raw session cookie." >&2
  echo "      users.sqlite intentionally stores only token hashes, so a raw token cannot be recovered from the database." >&2
  exit 1
fi
echo "ok  explicit session token provided"

response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT
export STREAMARENA_SESSION_TOKEN="$TOKEN"
export NOVA_RESPONSE_FILE="$response_file"
export NOVA_BASE_URL="$BASE"

ENCODED_URL="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$NTVS_URL")"
curl -sS --max-time 90 -H "Cookie: session=$TOKEN" \
  "$BASE/api/sports/stream?url=$ENCODED_URL&_ts=$(date +%s)" \
  -o "$response_file"

python3 <<'PY'
import json
import os
import sys
import urllib.parse
import urllib.request

with open(os.environ["NOVA_RESPONSE_FILE"], encoding="utf-8") as handle:
    payload = json.load(handle)

if payload.get("error"):
    print(f"FAIL: resolver error: {payload['error']}")
    sys.exit(1)

playback_type = payload.get("playbackType")
playback_url = str(payload.get("playbackUrl") or "").strip()
player_page = str(payload.get("playerPage") or "").strip()
provider = payload.get("provider")

print(f"ok  resolver provider={provider} playbackType={playback_type}")

if playback_type != "hls" or not playback_url:
    print("FAIL: resolver did not return HLS playbackUrl")
    sys.exit(1)

token = os.environ["STREAMARENA_SESSION_TOKEN"]
base_url = os.environ["NOVA_BASE_URL"].rstrip("/")

if playback_url.startswith("/api/live/hls.m3u8?"):
    fetch_url = f"{base_url}{playback_url}"
    print("ok  resolver returned signed live HLS proxy URL")
else:
    if not playback_url.startswith("https://"):
        print("FAIL: resolver returned an unexpected playback URL shape")
        sys.exit(1)
    parsed_playback = urllib.parse.urlparse(playback_url)
    playback_query = urllib.parse.parse_qs(parsed_playback.query)
    if (
        parsed_playback.path == "/api/live/hls.m3u8"
        and playback_query.get("externalEmbed") == ["1"]
        and (playback_query.get("sig") or playback_query.get("sigV2"))
    ):
        fetch_url = playback_url
        print("ok  resolver returned an absolute signed live HLS proxy URL")
    else:
        print("ok  resolver returned upstream HLS URL (frontend will proxy)")
        query = {"input": playback_url}
        if player_page.startswith("https://"):
            query["referer"] = player_page
        fetch_url = f"{base_url}/api/live/hls.m3u8?{urllib.parse.urlencode(query)}"

req = urllib.request.Request(fetch_url, headers={"Cookie": f"session={token}"})
try:
    with urllib.request.urlopen(req, timeout=45) as response:
        body = response.read().decode("utf-8", errors="replace")
        status = response.status
except urllib.error.HTTPError as error:
    print(f"FAIL: HLS proxy returned HTTP {error.code}")
    sys.exit(1)

print(f"hls_proxy_status={status}")
if status != 200:
    print("FAIL: HLS proxy did not return 200")
    sys.exit(1)

print("ok  HLS proxy returned HTTP 200")
lines = [line.strip() for line in body.splitlines() if line.strip()]
tag_count = sum(1 for line in lines if line.startswith("#"))
uri_count = sum(1 for line in lines if not line.startswith("#"))
print(f"playlist_lines={len(lines)} tags={tag_count} uris={uri_count}")

if not body.startswith("#EXTM3U"):
    print("FAIL: playlist missing #EXTM3U")
    sys.exit(1)

if "ch=NOVASPORTS1" in body and "input=" not in body:
    print("FAIL: playlist contains unproxied hesgoaler URL")
    sys.exit(1)

print("PASS Nova Sports 1 pipeline works on Mac mini")
PY

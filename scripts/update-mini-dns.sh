#!/usr/bin/env bash
set -euo pipefail

MINI_HOST="${MINI_HOST:-hermes@m4mini.local}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_codex_m4mini}"
ZONE_NAME="${ZONE_NAME:-streamarena.xyz}"
PUBLIC_HOSTS="${PUBLIC_HOSTS:-streamarena.xyz,www.streamarena.xyz}"
PROXIED="${PROXIED:-false}"
TTL="${TTL:-60}"
PUBLIC_IP="${PUBLIC_IP:-}"

usage() {
  cat <<'USAGE'
Usage: CF_API_TOKEN=... scripts/update-mini-dns.sh

Sets Cloudflare DNS-only A records for the Mac mini's current home public IP.
The token must have Zone.DNS edit access for the zone.

Environment:
  CF_API_TOKEN  Required Cloudflare API token with Zone.DNS edit permission.
  CF_ZONE_ID    Optional. If omitted, the script resolves it from ZONE_NAME.
  ZONE_NAME     Default: streamarena.xyz
  PUBLIC_HOSTS  Default: streamarena.xyz,www.streamarena.xyz
  PUBLIC_IP     Optional. If omitted, read from the Mac mini.
  PROXIED       Default: false
  TTL           Default: 60
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ -z "${CF_API_TOKEN:-}" ]]; then
  echo "CF_API_TOKEN is required" >&2
  exit 2
fi

if [[ -z "$PUBLIC_IP" ]]; then
  PUBLIC_IP="$(ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$MINI_HOST" \
    'curl -fsS --max-time 5 https://api.ipify.org')"
fi

CF_API_TOKEN="$CF_API_TOKEN" \
CF_ZONE_ID="${CF_ZONE_ID:-}" \
ZONE_NAME="$ZONE_NAME" \
PUBLIC_HOSTS="$PUBLIC_HOSTS" \
PUBLIC_IP="$PUBLIC_IP" \
PROXIED="$PROXIED" \
TTL="$TTL" \
/usr/bin/python3 - <<'PY'
import json
import os
import sys
import urllib.parse
import urllib.request

token = os.environ["CF_API_TOKEN"]
zone_id = os.environ.get("CF_ZONE_ID", "")
zone_name = os.environ["ZONE_NAME"]
hosts = [part.strip() for part in os.environ["PUBLIC_HOSTS"].split(",") if part.strip()]
public_ip = os.environ["PUBLIC_IP"].strip()
proxied = os.environ["PROXIED"].strip().lower() in {"1", "true", "yes", "on"}
ttl = int(os.environ["TTL"])

if not hosts:
    raise SystemExit("PUBLIC_HOSTS resolved to an empty list")
if not public_ip:
    raise SystemExit("PUBLIC_IP is empty")

def request(method, path, query=None, body=None):
    url = "https://api.cloudflare.com/client/v4" + path
    if query:
        url += "?" + urllib.parse.urlencode(query)
    data = None
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, method=method, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        payload = json.loads(error.read().decode("utf-8"))
        raise RuntimeError(f"{method} {path} failed: {payload}") from error
    if not payload.get("success"):
        raise RuntimeError(f"{method} {path} failed: {payload}")
    return payload

if not zone_id:
    zones = request("GET", "/zones", {"name": zone_name, "per_page": 1})["result"]
    if not zones:
        raise SystemExit(f"Zone not found: {zone_name}")
    zone_id = zones[0]["id"]

for host in hosts:
    records = request("GET", f"/zones/{zone_id}/dns_records", {"name": host, "per_page": 100})["result"]
    editable = [record for record in records if record["type"] in {"A", "AAAA", "CNAME"}]
    if not editable:
        created = request("POST", f"/zones/{zone_id}/dns_records", body={
            "type": "A",
            "name": host,
            "content": public_ip,
            "ttl": ttl,
            "proxied": proxied,
            "comment": "Direct Mac mini Caddy origin",
        })["result"]
        print(f"{host}: created {created['type']} {created['content']} proxied={created.get('proxied')}")
        continue

    primary, *stale = editable
    updated = request("PUT", f"/zones/{zone_id}/dns_records/{primary['id']}", body={
        "type": "A",
        "name": host,
        "content": public_ip,
        "ttl": ttl,
        "proxied": proxied,
        "comment": "Direct Mac mini Caddy origin",
    })["result"]
    print(f"{host}: updated {primary['type']}->{updated['type']} {updated['content']} proxied={updated.get('proxied')}")

    for record in stale:
        request("DELETE", f"/zones/{zone_id}/dns_records/{record['id']}")
        print(f"{host}: deleted stale {record['type']} {record['content']}")

print(f"zone_id={zone_id}")
print(f"public_ip={public_ip}")
PY

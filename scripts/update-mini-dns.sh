#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
Usage: scripts/update-mini-dns.sh [--dry-run]
Set proxied A records for the Mac mini using the pinned Node-based cf CLI.
Authenticate with cf auth login. CF_API_TOKEN is an optional legacy alias for
CLOUDFLARE_API_TOKEN. CF_ACCOUNT_ID selects the expected account.
ZONE_NAME defaults to streamarena.xyz; PUBLIC_HOSTS defaults to
streamarena.xyz,www.streamarena.xyz. PUBLIC_IP skips the Mini IP lookup.
CF_ZONE_ID, MINI_HOST, SSH_KEY, PROXIED and TTL remain optional overrides.
USAGE
  exit 0
fi

if [[ $# -gt 1 || ( $# -eq 1 && "$1" != "--dry-run" ) ]]; then
  echo "Usage: scripts/update-mini-dns.sh [--dry-run]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export CF_CLI="$SCRIPT_DIR/../workers/live-hls-proxy/node_modules/cf/bin/cf"
export CLOUDFLARE_ACCOUNT_ID="${CF_ACCOUNT_ID:-9349e7e9527ec0aad29368255a686ec4}"
if [[ -n "${CF_API_TOKEN:-}" ]]; then export CLOUDFLARE_API_TOKEN="$CF_API_TOKEN"; fi
export ZONE_NAME="${ZONE_NAME:-streamarena.xyz}"
export PUBLIC_HOSTS="${PUBLIC_HOSTS:-streamarena.xyz,www.streamarena.xyz}"
export PROXIED="${PROXIED:-true}"
export TTL="${TTL:-1}"
export CF_ZONE_ID="${CF_ZONE_ID:-}"
export DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then export DRY_RUN=true; fi
if [[ -z "${PUBLIC_IP:-}" ]]; then
  PUBLIC_IP="$(ssh -i "${SSH_KEY:-$HOME/.ssh/id_ed25519_codex_m4mini}" -o BatchMode=yes -o ConnectTimeout=10 "${MINI_HOST:-hermes@m4mini.local}" 'curl -fsS --max-time 5 https://api.ipify.org')"
fi
export PUBLIC_IP

/usr/bin/python3 - <<'PY'
import ipaddress
import json
import os
import subprocess

zone_name = os.environ["ZONE_NAME"]
hosts = [h.strip() for h in os.environ["PUBLIC_HOSTS"].split(",") if h.strip()]
public_ip = str(ipaddress.IPv4Address(os.environ["PUBLIC_IP"].strip()))
proxied = os.environ["PROXIED"].lower() in {"1", "true", "yes", "on"}
ttl = int(os.environ["TTL"])
dry_run = os.environ["DRY_RUN"] == "true"
if not hosts or any(h != zone_name and not h.endswith("." + zone_name) for h in hosts):
    raise SystemExit("PUBLIC_HOSTS must contain hosts within ZONE_NAME")
if proxied and ttl != 1:
    raise SystemExit("Proxied records require TTL=1")

def cf(*args):
    result = subprocess.run(["node", os.environ["CF_CLI"], *args], check=True, capture_output=True, text=True)
    return json.loads(result.stdout) if result.stdout.strip() else None

def pages(*args):
    result, page = [], 1
    while True:
        batch = cf(*args, "--page", str(page), "--per-page", "50")
        if not isinstance(batch, list):
            raise RuntimeError("Unexpected cf list response")
        result.extend(batch)
        if len(batch) < 50:
            return result
        page += 1

zones = pages("zones", "list", "--name", zone_name, "--account-id", os.environ["CLOUDFLARE_ACCOUNT_ID"])
if len(zones) != 1:
    raise SystemExit("Expected exactly one matching zone in the selected account")
zone_id = zones[0]["id"]
if os.environ["CF_ZONE_ID"] and os.environ["CF_ZONE_ID"] != zone_id:
    raise SystemExit("CF_ZONE_ID does not match the selected zone and account")

for host in hosts:
    records = pages("dns", "records", "list", "--zone", zone_id, "--name", host)
    editable = [r for r in records if r["type"] in {"A", "AAAA", "CNAME"}]
    body = json.dumps({"type": "A", "name": host, "content": public_ip, "ttl": ttl, "proxied": proxied, "comment": "Cloudflare-proxied Mac mini Caddy origin"})
    action = ["dns", "records", "update", editable[0]["id"]] if editable else ["dns", "records", "create"]
    preview = ["--dry-run"] if dry_run else []
    cf(*action, "--zone", zone_id, "--body", body, *preview)
    for stale in editable[1:]:
        cf("dns", "records", "delete", stale["id"], "--zone", zone_id, *preview, *([] if dry_run else ["--force"]))
    if dry_run:
        print(f"{host}: preview A {public_ip}, {len(editable[1:])} stale record(s)")
        continue
    verified = pages("dns", "records", "list", "--zone", zone_id, "--name", host)
    addresses = [r for r in verified if r["type"] in {"A", "AAAA", "CNAME"}]
    if len(addresses) != 1 or addresses[0]["type"] != "A" or addresses[0]["content"] != public_ip or addresses[0]["proxied"] != proxied:
        raise RuntimeError(f"DNS read-back did not match the requested record for {host}")
    print(f"{host}: verified A {public_ip} proxied={proxied}")
PY

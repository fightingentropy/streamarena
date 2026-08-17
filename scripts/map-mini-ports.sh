#!/usr/bin/env bash
set -euo pipefail

MINI_HOST="${MINI_HOST:-hermes@m4mini.local}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_codex_m4mini}"
REMOTE_ENV_FILE="${REMOTE_ENV_FILE:-/Users/hermes/.config/streamarena/env}"
PORTS="${PORTS:-}"
TORRENT_PORTS="${TORRENT_PORTS:-}"
STALE_TORRENT_PORTS="${STALE_TORRENT_PORTS:-42501}"

normalize_port_csv() {
  local label="$1"
  local raw="$2"
  local allow_empty="$3"
  local normalized=""
  local part port
  local parts=()

  if [[ -z "${raw//[[:space:]]/}" ]]; then
    if [[ "$allow_empty" == "1" ]]; then
      NORMALIZED_PORT_CSV=""
      return
    fi
    echo "$label must contain at least one TCP port." >&2
    exit 2
  fi

  IFS=',' read -r -a parts <<<"$raw"
  for part in "${parts[@]}"; do
    part="${part#"${part%%[![:space:]]*}"}"
    part="${part%"${part##*[![:space:]]}"}"
    if [[ -z "$part" || ! "$part" =~ ^[0-9]+$ ]]; then
      echo "$label must be a comma-separated list of TCP ports." >&2
      exit 2
    fi
    while [[ ${#part} -gt 1 && "${part:0:1}" == "0" ]]; do
      part="${part:1}"
    done
    if [[ ${#part} -gt 5 ]]; then
      echo "$label contains an invalid TCP port: $part" >&2
      exit 2
    fi
    port=$((10#$part))
    if ((port < 1 || port > 65535)); then
      echo "$label contains an invalid TCP port: $part" >&2
      exit 2
    fi
    case ",$normalized," in
      *",$port,"*) ;;
      *) normalized+="${normalized:+,}$port" ;;
    esac
  done

  if [[ -z "$normalized" && "$allow_empty" != "1" ]]; then
    echo "$label must contain at least one TCP port." >&2
    exit 2
  fi
  NORMALIZED_PORT_CSV="$normalized"
}

assert_port_subset() {
  local subset_label="$1"
  local subset="$2"
  local superset="$3"
  local part
  local parts=()

  [[ -z "$subset" ]] && return
  IFS=',' read -r -a parts <<<"$subset"
  for part in "${parts[@]}"; do
    [[ -z "$part" ]] && continue
    case ",$superset," in
      *",$part,"*) ;;
      *)
        echo "$subset_label contains port $part, which is not present in PORTS." >&2
        exit 2
        ;;
    esac
  done
}

usage() {
  cat <<'USAGE'
Usage: scripts/map-mini-ports.sh

Creates idempotent router port forwards for the Mac mini through UPnP:
  - external TCP 80  -> mini TCP 80
  - external TCP 443 -> mini TCP 443
  - the configured LOCAL_TORRENT_LISTEN_PORT_START..END range (BitTorrent peers)

Environment:
  MINI_HOST   Default: hermes@m4mini.local
  SSH_KEY     Default: ~/.ssh/id_ed25519_codex_m4mini
  REMOTE_ENV_FILE
              Default: /Users/hermes/.config/streamarena/env
  PORTS       Optional explicit comma-separated override. By default the
              script maps 80,443 plus the canonical remote torrent range;
              LOCAL_TORRENT_LISTEN_PORT_START=0 maps web ports only. Automatic
              range derivation is capped at 16 torrent ports.
  TORRENT_PORTS
              Torrent subset when PORTS is explicitly overridden (used only
              for mapping descriptions).
  STALE_TORRENT_PORTS
              Previously managed torrent ports to remove when no longer in
              the configured range. Default: 42501.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ -z "$PORTS" ]]; then
  [[ "$REMOTE_ENV_FILE" != *"'"* ]] || {
    echo "REMOTE_ENV_FILE cannot contain a single quote." >&2
    exit 2
  }
  REMOTE_PORT_RANGE="$(ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$MINI_HOST" \
    "/usr/bin/python3 - '$REMOTE_ENV_FILE'" <<'PY'
import pathlib
import re
import sys

values = {}
path = pathlib.Path(sys.argv[1])
if path.exists():
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key in {"LOCAL_TORRENT_LISTEN_PORT_START", "LOCAL_TORRENT_LISTEN_PORT_END"}:
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]
            values[key] = value

def parse_u64(name, fallback, minimum, maximum):
    raw = values.get(name, "")
    parsed = int(raw) if re.fullmatch(r"[0-9]+", raw) else fallback
    return max(minimum, min(parsed, maximum))

start = parse_u64("LOCAL_TORRENT_LISTEN_PORT_START", 42501, 0, 65534)
end = parse_u64("LOCAL_TORRENT_LISTEN_PORT_END", 42502, 1, 65535)
if start > 0:
    end = max(end, start + 1)
    if end - start > 16:
        raise SystemExit("Refusing to map more than 16 BitTorrent ports")
print(f"{start},{end}")
PY
)"
  IFS=, read -r TORRENT_PORT_START TORRENT_PORT_END <<<"$REMOTE_PORT_RANGE"
  PORTS="80,443"
  TORRENT_PORTS=""
  if [[ "$TORRENT_PORT_START" -gt 0 ]]; then
    for ((port = TORRENT_PORT_START; port < TORRENT_PORT_END; port++)); do
      PORTS+=",$port"
      TORRENT_PORTS+="${TORRENT_PORTS:+,}$port"
    done
  fi
fi

normalize_port_csv "PORTS" "$PORTS" 0
PORTS="$NORMALIZED_PORT_CSV"
normalize_port_csv "TORRENT_PORTS" "$TORRENT_PORTS" 1
TORRENT_PORTS="$NORMALIZED_PORT_CSV"
assert_port_subset "TORRENT_PORTS" "$TORRENT_PORTS" "$PORTS"
normalize_port_csv "STALE_TORRENT_PORTS" "$STALE_TORRENT_PORTS" 1
STALE_TORRENT_PORTS="$NORMALIZED_PORT_CSV"

ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$MINI_HOST" \
  "PORTS='$PORTS' TORRENT_PORTS='$TORRENT_PORTS' STALE_TORRENT_PORTS='$STALE_TORRENT_PORTS' /usr/bin/python3 -" <<'PY'
import os
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

def parse_ports(name, allow_empty=False):
    parsed = []
    for part in os.environ.get(name, "").split(","):
        part = part.strip()
        if not part:
            continue
        if not part.isascii() or not part.isdigit():
            raise SystemExit(f"{name} contains a non-numeric port")
        port = int(part)
        if port < 1 or port > 65535:
            raise SystemExit(f"{name} contains an invalid TCP port: {port}")
        if port not in parsed:
            parsed.append(port)
    if not parsed and not allow_empty:
        raise SystemExit(f"{name} must contain at least one TCP port")
    return parsed

ports = parse_ports("PORTS")
torrent_ports = set(parse_ports("TORRENT_PORTS", allow_empty=True))
stale_torrent_ports = set(parse_ports("STALE_TORRENT_PORTS", allow_empty=True)) - torrent_ports
if not torrent_ports.issubset(ports):
    raise SystemExit("TORRENT_PORTS must be a subset of PORTS")

def discover():
    search_targets = [
        "urn:schemas-upnp-org:device:InternetGatewayDevice:2",
        "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
        "urn:schemas-upnp-org:service:WANIPConnection:2",
        "urn:schemas-upnp-org:service:WANIPConnection:1",
        "urn:schemas-upnp-org:service:WANPPPConnection:1",
    ]
    locations = []
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.settimeout(2)
    for target in search_targets:
        payload = "\r\n".join([
            "M-SEARCH * HTTP/1.1",
            "HOST: 239.255.255.250:1900",
            'MAN: "ssdp:discover"',
            "MX: 2",
            f"ST: {target}",
            "",
            "",
        ]).encode("ascii")
        sock.sendto(payload, ("239.255.255.250", 1900))
    deadline = time.time() + 3
    while time.time() < deadline:
        try:
            data, _addr = sock.recvfrom(65535)
        except socket.timeout:
            break
        headers = data.decode("latin1", "replace").splitlines()
        for header in headers:
            if header.lower().startswith("location:"):
                location = header.split(":", 1)[1].strip()
                if location not in locations:
                    locations.append(location)
    return locations

def local_ip_for(url):
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname
    if not host:
        raise RuntimeError(f"Cannot determine gateway host from {url}")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect((host, parsed.port or 80))
        return sock.getsockname()[0]
    finally:
        sock.close()

def service_from_description(location):
    with urllib.request.urlopen(location, timeout=5) as response:
        root = ET.fromstring(response.read())
    ns = {"d": root.tag.split("}")[0].strip("{")} if root.tag.startswith("{") else {}
    services = root.findall(".//d:service", ns) if ns else root.findall(".//service")
    for service in services:
        get = lambda name: service.findtext(f"d:{name}", namespaces=ns) if ns else service.findtext(name)
        service_type = get("serviceType") or ""
        if "WANIPConnection" in service_type or "WANPPPConnection" in service_type:
            control = get("controlURL")
            if not control:
                continue
            return service_type, urllib.parse.urljoin(location, control)
    return None, None

def soap(control_url, service_type, action, body):
    envelope = f"""<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:{action} xmlns:u="{service_type}">
{body}
    </u:{action}>
  </s:Body>
</s:Envelope>""".encode("utf-8")
    request = urllib.request.Request(
        control_url,
        data=envelope,
        headers={
            "Content-Type": 'text/xml; charset="utf-8"',
            "SOAPAction": f'"{service_type}#{action}"',
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=8) as response:
        return response.read().decode("utf-8", "replace")

def get_mapping(control_url, service_type, port):
    body = f"""
      <NewRemoteHost></NewRemoteHost>
      <NewExternalPort>{port}</NewExternalPort>
      <NewProtocol>TCP</NewProtocol>"""
    try:
        text = soap(control_url, service_type, "GetSpecificPortMappingEntry", body)
    except urllib.error.HTTPError:
        return None
    fields = {}
    for key in ["NewInternalClient", "NewInternalPort", "NewEnabled", "NewPortMappingDescription"]:
        start = text.find(f"<{key}>")
        end = text.find(f"</{key}>")
        if start != -1 and end != -1:
            fields[key] = text[start + len(key) + 2:end]
    return fields

def delete_mapping(control_url, service_type, port):
    body = f"""
      <NewRemoteHost></NewRemoteHost>
      <NewExternalPort>{port}</NewExternalPort>
      <NewProtocol>TCP</NewProtocol>"""
    try:
        soap(control_url, service_type, "DeletePortMapping", body)
    except urllib.error.HTTPError:
        return False
    return True

def mapping_enabled(existing):
    return existing.get("NewEnabled", "").strip().lower() in {"1", "true", "yes"}

def add_mapping(control_url, service_type, local_ip, port):
    existing = get_mapping(control_url, service_type, port)
    if existing:
        if (
            existing.get("NewInternalClient") == local_ip
            and existing.get("NewInternalPort") == str(port)
            and mapping_enabled(existing)
        ):
            print(f"port={port} status=exists internal={local_ip}:{port}")
            return
        print(f"port={port} status=replacing old={existing.get('NewInternalClient')}:{existing.get('NewInternalPort')}")
        if not delete_mapping(control_url, service_type, port):
            raise RuntimeError(f"Could not remove existing TCP mapping for port {port}")
    description = "StreamArena BitTorrent" if port in torrent_ports else f"StreamArena Caddy {port}"
    body = f"""
      <NewRemoteHost></NewRemoteHost>
      <NewExternalPort>{port}</NewExternalPort>
      <NewProtocol>TCP</NewProtocol>
      <NewInternalPort>{port}</NewInternalPort>
      <NewInternalClient>{local_ip}</NewInternalClient>
      <NewEnabled>1</NewEnabled>
      <NewPortMappingDescription>{description}</NewPortMappingDescription>
      <NewLeaseDuration>0</NewLeaseDuration>"""
    soap(control_url, service_type, "AddPortMapping", body)
    print(f"port={port} status=added internal={local_ip}:{port}")

def remove_stale_mappings(control_url, service_type, local_ip):
    for port in sorted(stale_torrent_ports):
        existing = get_mapping(control_url, service_type, port)
        if existing and existing.get("NewPortMappingDescription") == "StreamArena BitTorrent":
            if not delete_mapping(control_url, service_type, port):
                raise RuntimeError(f"Could not remove stale TCP mapping for port {port}")
            print(f"port={port} status=removed-stale internal={local_ip}:{port}")

locations = discover()
if not locations:
    raise SystemExit("No UPnP Internet Gateway Device found")

last_error = None
for location in locations:
    try:
        service_type, control_url = service_from_description(location)
        if not control_url:
            continue
        local_ip = local_ip_for(location)
        print(f"gateway={location}")
        print(f"control_url={control_url}")
        print(f"internal_ip={local_ip}")
        remove_stale_mappings(control_url, service_type, local_ip)
        for port in ports:
            add_mapping(control_url, service_type, local_ip, port)
        raise SystemExit(0)
    except Exception as error:
        last_error = error

raise SystemExit(f"Could not configure UPnP port mappings: {last_error}")
PY

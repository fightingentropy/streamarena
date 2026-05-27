#!/usr/bin/env bash
set -euo pipefail

MINI_HOST="${MINI_HOST:-hermes@m4mini.local}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_codex_m4mini}"
PORTS="${PORTS:-80,443}"

usage() {
  cat <<'USAGE'
Usage: scripts/map-mini-ports.sh

Creates idempotent router port forwards for the Mac mini through UPnP:
  - external TCP 80  -> mini TCP 80
  - external TCP 443 -> mini TCP 443

Environment:
  MINI_HOST   Default: hermes@m4mini.local
  SSH_KEY     Default: ~/.ssh/id_ed25519_codex_m4mini
  PORTS       Default: 80,443
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$MINI_HOST" \
  "PORTS='$PORTS' /usr/bin/python3 -" <<'PY'
import os
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

ports = [int(part.strip()) for part in os.environ["PORTS"].split(",") if part.strip()]
if not ports:
    raise SystemExit("No ports configured")

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

def add_mapping(control_url, service_type, local_ip, port):
    existing = get_mapping(control_url, service_type, port)
    if existing:
        if existing.get("NewInternalClient") == local_ip and existing.get("NewInternalPort") == str(port):
            print(f"port={port} status=exists internal={local_ip}:{port}")
            return
        print(f"port={port} status=replacing old={existing.get('NewInternalClient')}:{existing.get('NewInternalPort')}")
        delete_mapping(control_url, service_type, port)
    body = f"""
      <NewRemoteHost></NewRemoteHost>
      <NewExternalPort>{port}</NewExternalPort>
      <NewProtocol>TCP</NewProtocol>
      <NewInternalPort>{port}</NewInternalPort>
      <NewInternalClient>{local_ip}</NewInternalClient>
      <NewEnabled>1</NewEnabled>
      <NewPortMappingDescription>Netflix Caddy {port}</NewPortMappingDescription>
      <NewLeaseDuration>0</NewLeaseDuration>"""
    soap(control_url, service_type, "AddPortMapping", body)
    print(f"port={port} status=added internal={local_ip}:{port}")

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
        for port in ports:
            add_mapping(control_url, service_type, local_ip, port)
        raise SystemExit(0)
    except Exception as error:
        last_error = error

raise SystemExit(f"Could not configure UPnP port mappings: {last_error}")
PY

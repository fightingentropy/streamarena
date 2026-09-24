#!/usr/bin/env python3
"""Repair the existing Mini tunnel ingress without replacing shared routes.

Run over SSH with `python3 - --apply < scripts/configure-mini-tunnel.py`.
Without --apply, only stage and validate. No credentials are printed.
"""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

BEGIN = "# BEGIN STREAMARENA TUNNEL PROXY"
END = "# END STREAMARENA TUNNEL PROXY"
CANONICAL = "streamarena.xyz"
ALIAS = "www.streamarena.xyz"
PORT = 5180
CADDY_LABEL = "com.fightingentropy.streamarena-caddy"
TUNNEL_LABEL = "com.cloudflare.cloudflared.streamarena"


def caddy_configuration(original):
    if original.count(BEGIN) != original.count(END) or original.count(BEGIN) > 1:
        raise ValueError("Incomplete or duplicated StreamArena managed block")
    if BEGIN in original:
        original, count = re.subn(
            rf"(?ms)^{re.escape(BEGIN)}\n.*?^{re.escape(END)}\n?", "", original
        )
        if count != 1:
            raise ValueError("Malformed StreamArena managed block")
    block = f"""{BEGIN}
# Cloudflare terminates TLS. Only cloudflared on this host reaches this listener.
:{PORT} {{
    bind 127.0.0.1
    route {{
        @unknown_host not host {CANONICAL} {ALIAS}
        respond @unknown_host 421
        @alias host {ALIAS}
        redir @alias https://{CANONICAL}{{uri}} 308
        @http header X-Forwarded-Proto http
        redir @http https://{CANONICAL}{{uri}} 308
        @invalid_scheme not header X-Forwarded-Proto https
        respond @invalid_scheme 400
        reverse_proxy 127.0.0.1:5173 {{
            header_up X-Forwarded-Proto {{http.request.header.X-Forwarded-Proto}}
            header_up X-Forwarded-For {{http.request.header.CF-Connecting-IP}}
            header_up CF-Connecting-IP {{http.request.header.CF-Connecting-IP}}
            lb_try_duration 5s
            lb_try_interval 250ms
        }}
    }}
}}
{END}
"""
    return original.rstrip() + "\n\n" + block


def tunnel_configuration(original):
    """Edit two explicit existing hostname rules, preserving all other bytes."""
    result = original
    for host in (CANONICAL, ALIAS):
        pattern = re.compile(
            rf"(?m)^(  - hostname: {re.escape(host)}\s*\n"
            rf"    service: )([^\n]+)$"
        )
        matches = list(pattern.finditer(result))
        if len(matches) != 1:
            raise ValueError(f"Expected one explicit existing ingress rule for {host}")
        if matches[0].group(2).strip() not in (
            "http://127.0.0.1:5173", f"http://127.0.0.1:{PORT}"
        ):
            raise ValueError(f"Unexpected existing service for {host}")
        result = pattern.sub(rf"\g<1>http://127.0.0.1:{PORT}", result)
    return result


def command(args):
    result = subprocess.run(args, text=True, capture_output=True, timeout=45)
    if result.returncode:
        # Config parsers may quote credential-bearing source lines on errors.
        raise RuntimeError(f"Command failed ({result.returncode}): {args[0]} {args[1]}")
    return result.stdout


def daemon(label):
    path = Path("/Library/LaunchDaemons") / f"{label}.plist"
    data = plistlib.loads(path.read_bytes())
    state = command(["/bin/launchctl", "print", f"system/{label}"])
    match = re.search(r"^\s*pid = (\d+)$", state, re.M)
    if not match or not re.search(r"^\s*state = running$", state, re.M):
        raise RuntimeError(f"Expected running system/{label}")
    args = data["ProgramArguments"]
    config = Path(args[args.index("--config") + 1])
    return data, config, int(match.group(1))


def temporary_config(path, content):
    fd, name = tempfile.mkstemp(prefix=".streamarena-stage-", dir=path.parent)
    with os.fdopen(fd, "w") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    return Path(name)


def atomic_write(path, content):
    temporary = temporary_config(path, content)
    os.replace(temporary, path)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


def response(url, headers=None):
    request = urllib.request.Request(url, headers=headers or {})
    opener = urllib.request.build_opener(NoRedirect)
    try:
        result = opener.open(request, timeout=8)
    except urllib.error.HTTPError as error:
        result = error
    with result:
        return result.status, result.headers.get("Location", "")


def local_probes():
    for host, scheme, path, status, target in (
        (CANONICAL, "https", "/api/library", 401, ""),
        (CANONICAL, "https", "/login.html", 200, ""),
        (CANONICAL, "http", "/login.html?probe=1", 308, f"https://{CANONICAL}/login.html?probe=1"),
        (ALIAS, "https", "/login.html?probe=1", 308, f"https://{CANONICAL}/login.html?probe=1"),
        ("unexpected.invalid", "https", "/login.html", 421, ""),
        (CANONICAL, "", "/api/library", 400, ""),
    ):
        actual = response(f"http://127.0.0.1:{PORT}{path}", {"Host": host, "X-Forwarded-Proto": scheme})
        if actual != (status, target):
            raise RuntimeError(f"Loopback ingress check failed for {host}, scheme={scheme}: {actual}")


def public_probes():
    for url, status, target in (
        (f"http://{CANONICAL}/login.html", 308, f"https://{CANONICAL}/login.html"),
        (f"https://{ALIAS}/login.html", 308, f"https://{CANONICAL}/login.html"),
        (f"https://{CANONICAL}/login.html", 200, ""),
        (f"https://{CANONICAL}/api/library", 401, ""),
        ("https://music.streamarena.xyz/signin", 200, ""),
    ):
        # Match mini:check's HTTP client. The edge's Browser Integrity Check
        # rejects Python urllib's default user agent (1010), even before repair.
        output = command(["/usr/bin/curl", "-sS", "-o", "/dev/null", "--max-time", "8",
                          "-w", "%{http_code}\t%{redirect_url}", url])
        status_text, redirect = output.split("\t", 1)
        actual = (int(status_text), redirect)
        if actual != (status, target):
            raise RuntimeError(f"Public ingress check failed for {url}: {actual}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    caddy, caddy_path, caddy_pid = daemon(CADDY_LABEL)
    tunnel, tunnel_path, tunnel_pid = daemon(TUNNEL_LABEL)
    if caddy_path.name != "Caddyfile-tunnel" or "run" not in caddy["ProgramArguments"]:
        raise RuntimeError("This repair requires the existing shared tunnel Caddy service")
    originals = {caddy_path: caddy_path.read_text(), tunnel_path: tunnel_path.read_text()}
    desired = {caddy_path: caddy_configuration(originals[caddy_path]),
               tunnel_path: tunnel_configuration(originals[tunnel_path])}
    staged = {path: temporary_config(path, text) for path, text in desired.items()}
    try:
        command([caddy["ProgramArguments"][0], "validate", "--config", str(staged[caddy_path]), "--adapter", "caddyfile"])
        command([tunnel["ProgramArguments"][0], "tunnel", "--config", str(staged[tunnel_path]), "ingress", "validate"])
        changed = [path for path in originals if originals[path] != desired[path]]
        print(json.dumps({"validated": True, "apply": args.apply,
                          "changed": [str(path) for path in changed], "listener": f"127.0.0.1:{PORT}"}), flush=True)
        if not args.apply:
            return
        backup = Path.home() / ".local/state/streamarena/config-backups" / datetime.datetime.now(datetime.timezone.utc).strftime("tunnel-%Y%m%dT%H%M%S%fZ")
        backup.mkdir(parents=True, mode=0o700)
        for path, text in originals.items():
            (backup / path.name).write_text(text)
            if path.read_text() != text:
                raise RuntimeError("Configuration changed during validation; refusing to overwrite")
        metadata = {"caddy_pid": caddy_pid, "tunnel_pid": tunnel_pid,
                    "sha256": {str(path): hashlib.sha256(text.encode()).hexdigest() for path, text in originals.items()}}
        (backup / "metadata.json").write_text(json.dumps(metadata, indent=2))
        print(f"rollback_backup={backup}", flush=True)
        activated = []
        try:
            if caddy_path in changed:
                os.replace(staged[caddy_path], caddy_path)
                activated.append(caddy_path)
                os.kill(caddy_pid, signal.SIGUSR1)
            deadline = time.monotonic() + 15
            while True:
                try:
                    local_probes()
                    break
                except (OSError, RuntimeError):
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.25)
            if daemon(CADDY_LABEL)[2] != caddy_pid:
                raise RuntimeError("Caddy process changed during reload")
            print("local_ingress_checks=passed; shared_caddy_pid=unchanged", flush=True)
            if tunnel_path in changed:
                os.replace(staged[tunnel_path], tunnel_path)
                activated.append(tunnel_path)
                command(["sudo", "-n", "/bin/launchctl", "kickstart", "-k", f"system/{TUNNEL_LABEL}"])
            deadline = time.monotonic() + 45
            while True:
                try:
                    if response("http://127.0.0.1:20241/ready")[0] == 200:
                        public_probes()
                        break
                except (OSError, RuntimeError):
                    if time.monotonic() >= deadline:
                        raise
                if time.monotonic() >= deadline:
                    raise RuntimeError("Tunnel did not become ready")
                time.sleep(0.5)
            print("public_redirects_auth_and_music=passed", flush=True)
        except Exception:
            for path in reversed(activated):
                atomic_write(path, originals[path])
                if path == tunnel_path:
                    command(["sudo", "-n", "/bin/launchctl", "kickstart", "-k", f"system/{TUNNEL_LABEL}"])
                else:
                    os.kill(caddy_pid, signal.SIGUSR1)
            print("Configuration restored from rollback backup", flush=True)
            raise
    finally:
        for path in staged.values():
            path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()

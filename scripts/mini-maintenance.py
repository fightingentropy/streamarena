#!/usr/bin/env python3
"""Scoped, reboot-safe StreamArena maintenance. No third-party dependencies."""
from __future__ import annotations

import contextlib
import datetime
import fcntl
import gzip
import http.client
import json
import os
from pathlib import Path
import plistlib
import shutil
import stat
import subprocess
import sys
import time
from urllib.parse import urlsplit


INSTALL_DIR = Path("/Library/Application Support/StreamArena")
STATE_DIR = Path("/private/var/db/streamarena-maintenance")
LOG_DIR = Path("/Users/hermes/.local/state/streamarena")
SERVICE = "system/com.fightingentropy.streamarena-app"
LAUNCHCTL = "/bin/launchctl"
LABELS = {
    "rotate": "com.fightingentropy.streamarena-log-rotation",
    "disk": "com.fightingentropy.streamarena-disk-monitor",
    "watchdog": "com.fightingentropy.streamarena-watchdog",
}
LOG_NAMES = (
    "backend.log", "backend.err.log", "caddy.log", "caddy.err.log",
    "caddy-access.log", "tunnel.log", "tunnel.err.log", "disk-monitor.log",
    "watchdog.log", "log-rotation.launchd.log", "log-rotation.launchd.err.log",
    "disk-monitor.launchd.log", "disk-monitor.launchd.err.log",
    "watchdog.launchd.log", "watchdog.launchd.err.log",
)


def command(args, **kwargs):
    return subprocess.run(args, capture_output=True, text=True, timeout=30, **kwargs)


def validate(settings):
    settings = dict(settings)
    url = urlsplit(settings["url"])
    if (url.scheme != "http" or url.hostname not in ("127.0.0.1", "localhost", "::1")
            or url.username or url.password or url.fragment):
        raise ValueError("Watchdog URL must be an HTTP loopback URL without credentials")
    if not Path(settings["app"]).is_absolute():
        raise ValueError("REMOTE_APP must be an absolute path")
    for key, minimum, maximum in (
        ("disk_max_percent", 1, 100), ("disk_min_free_gb", 1, 100000),
        ("interval", 10, 3600), ("threshold", 2, 100), ("timeout", 1, 60),
    ):
        if not minimum <= settings[key] <= maximum:
            raise ValueError("Invalid maintenance setting: " + key)
    return settings


def log(state, name, message):
    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    with (state / name).open("a") as output:
        output.write(f"{stamp} {message}\n")


@contextlib.contextmanager
def directory_fd(path):
    """Walk every component without following links, including user-owned parents."""
    path = Path(path)
    if not path.is_absolute():
        raise ValueError("Expected absolute log directory")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        yield fd
    finally:
        os.close(fd)


def rotate_file(directory, name, archives, *, max_bytes=5 * 1024 * 1024, keep=7, prefix=""):
    """Copy/truncate the open inode so live writers need no restart or reopen."""
    with directory_fd(directory) as dir_fd:
        try:
            fd = os.open(name, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
        except FileNotFoundError:
            return False
        try:
            metadata = os.fstat(fd)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
                raise ValueError("Refusing non-regular or hard-linked log: " + name)
            if metadata.st_size < max_bytes:
                return False
            archive = archives / f"{prefix}{name}.{time.time_ns()}.gz"
            try:
                with archive.open("xb") as output, gzip.GzipFile(fileobj=output, mode="wb") as zipped:
                    remaining = metadata.st_size
                    while remaining:
                        chunk = os.read(fd, min(remaining, 1024 * 1024))
                        if not chunk:
                            break
                        zipped.write(chunk)
                        remaining -= len(chunk)
                # Close gzip and its file before touching the original.
                os.ftruncate(fd, 0)
            except Exception:
                archive.unlink(missing_ok=True)
                raise
            for old in sorted(archives.glob(f"{prefix}{name}.*.gz"), reverse=True)[keep:]:
                old.unlink()
            return True
        finally:
            os.close(fd)


def rotate_logs(state, log_dir=LOG_DIR):
    archives = state / "rotated-logs"
    archives.mkdir(mode=0o700, exist_ok=True)
    failures = []
    for directory, names, prefix in (
        (log_dir, LOG_NAMES, "legacy-"),
        (state, ("watchdog.log", "disk-monitor.log", "maintenance.out.log", "maintenance.err.log"), ""),
    ):
        for name in names:
            try:
                rotate_file(directory, name, archives, prefix=prefix)
            except (OSError, ValueError) as error:
                failures.append(name)
                print(f"Log rotation failed for {name}: {error}", file=sys.stderr)
    return 1 if failures else 0


def check_disk(settings, state):
    usage = shutil.disk_usage(settings["app"])
    free_gb = usage.free // (1024 ** 3)
    percent = (usage.used * 100 + usage.used + usage.free - 1) // (usage.used + usage.free)
    warning = percent >= settings["disk_max_percent"] or free_gb < settings["disk_min_free_gb"]
    log(state, "disk-monitor.log", f"{'WARN' if warning else 'OK'} usage={percent}% free={free_gb}GiB")
    return 2 if warning else 0


def probe(settings):
    url = urlsplit(settings["url"])
    connection = http.client.HTTPConnection(url.hostname, url.port or 80, timeout=settings["timeout"])
    try:
        connection.request("GET", (url.path or "/") + ("?" + url.query if url.query else ""))
        return connection.getresponse().status == 200
    except (OSError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def watchdog(settings, state, *, now=None, healthy=None, run=command):
    now = time.time() if now is None else now
    fail_path = state / "watchdog-failures.json"
    is_healthy = probe(settings) if healthy is None else healthy
    if is_healthy:
        fail_path.unlink(missing_ok=True)
        log(state, "watchdog.log", "OK health=200")
        return 0
    try:
        failures = json.loads(fail_path.read_text())
        count, first = int(failures["count"]), float(failures["first"])
        if first > now:
            count, first = 0, now
    except (OSError, ValueError, KeyError, TypeError):
        count, first = 0, now
    count += 1
    fail_path.write_text(json.dumps({"count": count, "first": first}))
    streak = now - first
    minimum = (settings["threshold"] - 1) * settings["interval"] * 0.75
    log(state, "watchdog.log", f"FAIL count={count} streak={streak:.0f}s minimum={minimum:.0f}s")
    if count < settings["threshold"] or streak < minimum:
        return 0
    # Respect an operator who unloads/disables the backend. Never create an
    # unmanaged replacement, kill by process name, or touch another service.
    disabled = run([LAUNCHCTL, "print-disabled", "system"])
    label = SERVICE.split("/", 1)[1]
    if disabled.returncode != 0 or f'"{label}" => disabled' in disabled.stdout:
        log(state, "watchdog.log", "restart skipped: backend disabled or status unavailable")
        return 1
    loaded = run([LAUNCHCTL, "print", SERVICE])
    if loaded.returncode != 0:
        log(state, "watchdog.log", "restart skipped: backend service not loaded")
        return 1
    result = run([LAUNCHCTL, "kickstart", "-k", SERVICE])
    if result.returncode:
        log(state, "watchdog.log", f"restart failed: launchctl exit={result.returncode}")
        return 1
    fail_path.unlink(missing_ok=True)
    log(state, "watchdog.log", "restart requested: " + SERVICE)
    return 0


def job_plist(mode, settings):
    job = {
        "Label": LABELS[mode],
        "ProgramArguments": ["/usr/bin/python3", str(INSTALL_DIR / "maintenance.py"), mode],
        "UserName": "root", "GroupName": "wheel", "Umask": 0o077,
        "StandardOutPath": str(STATE_DIR / "maintenance.out.log"),
        "StandardErrorPath": str(STATE_DIR / "maintenance.err.log"),
        "RunAtLoad": True,
    }
    if mode == "rotate":
        job["StartCalendarInterval"] = {"Hour": 3, "Minute": 17}
    else:
        job["StartInterval"] = 3600 if mode == "disk" else settings["interval"]
    return job


def install(settings, source):
    if os.geteuid() != 0:
        raise RuntimeError("Installing system maintenance requires root")
    settings = validate(settings)
    with directory_fd(Path(settings["app"])):
        pass
    for path in (INSTALL_DIR, STATE_DIR):
        path.mkdir(parents=True, exist_ok=True)
        with directory_fd(path):
            pass
        os.chown(path, 0, 0)
        path.chmod(0o755 if path == INSTALL_DIR else 0o700)
    backup = STATE_DIR / "install-backups" / datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup.mkdir(parents=True, mode=0o700)
    helper = INSTALL_DIR / "maintenance.py"
    config = INSTALL_DIR / "settings.json"
    manifest = {}
    paths = [helper, config] + [Path("/Library/LaunchDaemons") / (label + ".plist") for label in LABELS.values()]
    for path in paths:
        if path.is_symlink():
            raise RuntimeError("Refusing symlink destination: " + str(path))
        manifest[str(path)] = path.exists()
        if path.exists():
            shutil.copy2(path, backup / path.name)
    for domain in ("system", "gui/501"):
        status = command([LAUNCHCTL, "print-disabled", domain])
        (backup / (domain.replace("/", "-") + "-disabled.txt")).write_text("\n".join(
            line for line in status.stdout.splitlines() if any(label in line for label in LABELS.values())))
    (backup / "manifest.json").write_text(json.dumps(manifest, indent=2))
    for label in LABELS.values():
        command([LAUNCHCTL, "disable", "gui/501/" + label])
        command([LAUNCHCTL, "bootout", "gui/501/" + label])
        command([LAUNCHCTL, "bootout", "system/" + label])
    helper.write_text(source)
    config.write_text(json.dumps(settings, indent=2) + "\n")
    for path in (helper, config):
        os.chown(path, 0, 0)
        path.chmod(0o644)
    for mode, label in LABELS.items():
        path = Path("/Library/LaunchDaemons") / (label + ".plist")
        path.write_bytes(plistlib.dumps(job_plist(mode, settings)))
        os.chown(path, 0, 0)
        path.chmod(0o644)
        command([LAUNCHCTL, "enable", "system/" + label], check=True)
        command([LAUNCHCTL, "bootstrap", "system", str(path)], check=True)
    print("Installed StreamArena system maintenance; rollback files: " + str(backup))
    print("RunAtLoad schedules initial checks; inspect each system job's last exit code.")


def main(mode):
    settings = validate(json.loads((INSTALL_DIR / "settings.json").read_text()))
    with (STATE_DIR / (mode + ".lock")).open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        if mode == "watchdog":
            return watchdog(settings, STATE_DIR)
        if mode == "disk":
            return check_disk(settings, STATE_DIR)
        return rotate_logs(STATE_DIR)


if __name__ == "__main__":
    os.umask(0o077)
    if len(sys.argv) != 2 or sys.argv[1] not in (*LABELS, "--install"):
        raise SystemExit("Usage: mini-maintenance.py rotate|disk|watchdog|--install")
    if sys.argv[1] == "--install":
        install(INSTALL_SETTINGS, INSTALL_SOURCE)
    else:
        raise SystemExit(main(sys.argv[1]))

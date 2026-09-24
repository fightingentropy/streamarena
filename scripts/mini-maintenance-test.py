#!/usr/bin/env python3
"""Offline regression tests; never run launchctl or touch production paths."""
from __future__ import annotations

import contextlib
import fcntl
import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location("maintenance", Path(__file__).with_name("mini-maintenance.py"))
maintenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maintenance)


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.state = self.root / "state"
        self.logs = self.root / "logs"
        self.archives = self.root / "archives"
        for path in (self.state, self.logs, self.archives):
            path.mkdir()
        self.settings = dict(app=str(self.root), disk_max_percent=90, disk_min_free_gb=50,
                             url="http://127.0.0.1:5173/api/health/live", interval=60,
                             threshold=3, timeout=10)
        self.calls = []

    def tearDown(self):
        self.temp.cleanup()

    def run_command(self, argv):
        self.calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

    def fail(self, now, run=None):
        return maintenance.watchdog(self.settings, self.state, now=now, healthy=False,
                                    run=run or self.run_command)

    def test_sustained_failure_restarts_only_the_loaded_backend_service(self):
        for now in (1000, 1060, 1120):
            self.assertEqual(self.fail(now), 0)
        self.assertEqual(self.calls, [
            ["/bin/launchctl", "print-disabled", "system"],
            ["/bin/launchctl", "print", "system/com.fightingentropy.streamarena-app"],
            ["/bin/launchctl", "kickstart", "-k", "system/com.fightingentropy.streamarena-app"],
        ])
        self.assertFalse((self.state / "watchdog-failures.json").exists())

    def test_bunched_failures_do_not_restart_a_transient_outage(self):
        for now in range(1000, 1010):
            self.fail(now)
        self.assertEqual(self.calls, [])

    def test_recovery_clears_streak_before_later_failure(self):
        self.fail(1000)
        self.fail(1060)
        maintenance.watchdog(self.settings, self.state, now=1120, healthy=True, run=self.run_command)
        self.fail(1180)
        self.assertEqual(self.calls, [])
        self.assertEqual(json.loads((self.state / "watchdog-failures.json").read_text())["count"], 1)

    def test_clock_moving_backwards_starts_new_streak(self):
        self.fail(1000)
        self.fail(1060)
        self.fail(900)
        self.assertEqual(self.calls, [])
        self.assertEqual(json.loads((self.state / "watchdog-failures.json").read_text())["first"], 900)

    def test_operator_disabled_backend_is_not_restarted(self):
        def disabled(argv):
            self.calls.append(argv)
            return subprocess.CompletedProcess(argv, 0, stdout='"com.fightingentropy.streamarena-app" => disabled')
        self.fail(1000)
        self.fail(1060)
        self.assertEqual(self.fail(1120, disabled), 1)
        self.assertFalse(any("kickstart" in call for call in self.calls))

    def test_missing_service_does_not_start_an_unmanaged_backend(self):
        def missing(argv):
            result = self.run_command(argv)
            result.returncode = 1 if argv[1] == "print" else 0
            return result
        self.fail(1000)
        self.fail(1060)
        self.assertEqual(self.fail(1120, missing), 1)
        self.assertEqual(len(self.calls), 2)
        self.assertTrue((self.state / "watchdog-failures.json").exists())

    def test_failed_restart_preserves_failure_evidence(self):
        def denied(argv):
            result = self.run_command(argv)
            result.returncode = 1 if argv[1] == "kickstart" else 0
            return result
        self.fail(1000)
        self.fail(1060)
        self.assertEqual(self.fail(1120, denied), 1)
        self.assertTrue((self.state / "watchdog-failures.json").exists())

    def test_rotation_preserves_open_writer_inode_and_archive_contents(self):
        path = self.logs / "backend.log"
        path.write_bytes(b"before rotation\n")
        inode = path.stat().st_ino
        with path.open("ab", buffering=0) as writer:
            self.assertTrue(maintenance.rotate_file(self.logs, path.name, self.archives, max_bytes=1))
            writer.write(b"after rotation\n")
        self.assertEqual(path.stat().st_ino, inode)
        self.assertEqual(path.read_bytes(), b"after rotation\n")
        self.assertEqual(gzip.decompress(next(self.archives.iterdir()).read_bytes()), b"before rotation\n")

    def test_rotation_does_not_truncate_if_archive_cannot_be_created(self):
        path = self.logs / "backend.log"
        path.write_bytes(b"preserve me")
        with self.assertRaises(OSError):
            maintenance.rotate_file(self.logs, path.name, self.archives / "missing", max_bytes=1)
        self.assertEqual(path.read_bytes(), b"preserve me")

    def test_rotation_retains_only_configured_archive_count(self):
        path = self.logs / "backend.log"
        for index in range(10):
            path.write_text(str(index))
            maintenance.rotate_file(self.logs, path.name, self.archives, max_bytes=1, keep=3)
        self.assertEqual(len(list(self.archives.iterdir())), 3)
        self.assertEqual(sorted(gzip.decompress(p.read_bytes()) for p in self.archives.iterdir()), [b"7", b"8", b"9"])

    def test_symlink_log_cannot_truncate_another_file(self):
        target = self.root / "private"
        target.write_bytes(b"private content")
        (self.logs / "backend.log").symlink_to(target)
        with self.assertRaises(OSError):
            maintenance.rotate_file(self.logs, "backend.log", self.archives, max_bytes=1)
        self.assertEqual(target.read_bytes(), b"private content")

    def test_symlink_directory_cannot_redirect_privileged_rotation(self):
        (self.logs / "backend.log").write_bytes(b"private content")
        link = self.root / "linked-logs"
        link.symlink_to(self.logs, target_is_directory=True)
        with self.assertRaises(OSError):
            maintenance.rotate_file(link, "backend.log", self.archives, max_bytes=1)
        self.assertEqual((self.logs / "backend.log").read_bytes(), b"private content")

    def test_hard_link_cannot_truncate_another_file(self):
        target = self.root / "private"
        target.write_bytes(b"private content")
        os.link(target, self.logs / "backend.log")
        with self.assertRaises(ValueError):
            maintenance.rotate_file(self.logs, "backend.log", self.archives, max_bytes=1)
        self.assertEqual(target.read_bytes(), b"private content")

    def test_bad_log_does_not_prevent_later_tunnel_rotation(self):
        (self.logs / "backend.log").symlink_to(self.root / "absent")
        (self.logs / "tunnel.err.log").write_bytes(b"t" * (5 * 1024 * 1024))
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(maintenance.rotate_logs(self.state, self.logs), 1)
        self.assertEqual((self.logs / "tunnel.err.log").stat().st_size, 0)

    def test_disk_thresholds_warn_without_deleting_data(self):
        usage = type("Usage", (), {"used": 950 * 1024 ** 3, "free": 50 * 1024 ** 3})()
        with mock.patch.object(maintenance.shutil, "disk_usage", return_value=usage):
            self.assertEqual(maintenance.check_disk(self.settings, self.state), 2)
        self.assertIn("WARN usage=95%", (self.state / "disk-monitor.log").read_text())

    def test_helper_lock_skips_overlapping_watchdog(self):
        (self.root / "settings.json").write_text(json.dumps(self.settings))
        with (self.state / "watchdog.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with mock.patch.object(maintenance, "STATE_DIR", self.state), \
                    mock.patch.object(maintenance, "INSTALL_DIR", self.root), \
                    mock.patch.object(maintenance, "probe") as probe:
                self.assertEqual(maintenance.main("watchdog"), 0)
                probe.assert_not_called()

    def test_plists_use_protected_helper_and_system_schedules(self):
        for mode in maintenance.LABELS:
            job = plistlib.loads(plistlib.dumps(maintenance.job_plist(mode, self.settings)))
            self.assertEqual(job["UserName"], "root")
            self.assertEqual(job["ProgramArguments"], ["/usr/bin/python3", "/Library/Application Support/StreamArena/maintenance.py", mode])
            self.assertTrue(job["RunAtLoad"])
            self.assertNotIn("KeepAlive", job)
        self.assertEqual(maintenance.job_plist("watchdog", self.settings)["StartInterval"], 60)
        self.assertEqual(maintenance.job_plist("disk", self.settings)["StartInterval"], 3600)

    def test_configuration_rejects_remote_health_url(self):
        self.settings["url"] = "http://example.com/api/health/live"
        with self.assertRaises(ValueError):
            maintenance.validate(self.settings)


if __name__ == "__main__":
    unittest.main()

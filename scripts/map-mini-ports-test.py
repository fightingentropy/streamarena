#!/usr/bin/env python3
"""Offline regression tests for the Mini UPnP mapping script."""

from __future__ import annotations

import contextlib
import io
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "map-mini-ports.sh"


class MapperShellTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp.name)
        self.bin_dir = self.temp_path / "bin"
        self.bin_dir.mkdir()
        self.remote_env = self.temp_path / "remote.env"
        self.capture = self.temp_path / "remote-command.txt"
        ssh = self.bin_dir / "ssh"
        ssh.write_text(
            """#!/bin/bash
set -euo pipefail
last_arg=""
for arg in "$@"; do
  last_arg="$arg"
done
case "$last_arg" in
  "/usr/bin/python3 - "*)
    exec /usr/bin/python3 - "$MOCK_REMOTE_ENV_FILE"
    ;;
esac
printf '%s\n' "$last_arg" > "$MOCK_CAPTURE"
while IFS= read -r _line; do :; done
""",
            encoding="utf-8",
        )
        ssh.chmod(0o755)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def run_mapper(self, env_text: str = "", **overrides: str) -> subprocess.CompletedProcess[str]:
        self.remote_env.write_text(env_text, encoding="utf-8")
        self.capture.unlink(missing_ok=True)
        env = os.environ.copy()
        for name in (
            "PORTS",
            "TORRENT_PORTS",
            "STALE_TORRENT_PORTS",
            "REMOTE_ENV_FILE",
        ):
            env.pop(name, None)
        env.update(
            {
                "PATH": f"{self.bin_dir}:{env['PATH']}",
                "REMOTE_ENV_FILE": str(self.remote_env),
                "MOCK_REMOTE_ENV_FILE": str(self.remote_env),
                "MOCK_CAPTURE": str(self.capture),
            }
        )
        env.update(overrides)
        return subprocess.run(
            [str(SCRIPT)],
            cwd=ROOT,
            env=env,
            check=False,
            capture_output=True,
            text=True,
        )

    def captured_command(self) -> str:
        return self.capture.read_text(encoding="utf-8").strip()

    def test_derives_quoted_custom_range(self) -> None:
        result = self.run_mapper(
            "LOCAL_TORRENT_LISTEN_PORT_START='43000'\n"
            'LOCAL_TORRENT_LISTEN_PORT_END="43003"\n'
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        command = self.captured_command()
        self.assertIn("PORTS='80,443,43000,43001,43002'", command)
        self.assertIn("TORRENT_PORTS='43000,43001,43002'", command)

    def test_start_zero_ignores_invalid_end_and_maps_web_only(self) -> None:
        result = self.run_mapper(
            "LOCAL_TORRENT_LISTEN_PORT_START=0\n"
            "LOCAL_TORRENT_LISTEN_PORT_END=not-a-number\n"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        command = self.captured_command()
        self.assertIn("PORTS='80,443'", command)
        self.assertIn("TORRENT_PORTS=''", command)
        self.assertIn("STALE_TORRENT_PORTS='42501'", command)

    def test_invalid_start_matches_backend_fallback(self) -> None:
        result = self.run_mapper("LOCAL_TORRENT_LISTEN_PORT_START=-1\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        command = self.captured_command()
        self.assertIn("PORTS='80,443,42501'", command)
        self.assertIn("TORRENT_PORTS='42501'", command)

    def test_explicit_overrides_are_normalized(self) -> None:
        result = self.run_mapper(
            PORTS="080, 443,45000,45000",
            TORRENT_PORTS="045000",
            STALE_TORRENT_PORTS="42501, 043000",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        command = self.captured_command()
        self.assertIn("PORTS='80,443,45000'", command)
        self.assertIn("TORRENT_PORTS='45000'", command)
        self.assertIn("STALE_TORRENT_PORTS='42501,43000'", command)

    def test_rejects_remote_shell_injection_and_non_subset(self) -> None:
        injected = self.run_mapper(PORTS="80,443,'; touch nope")
        self.assertEqual(injected.returncode, 2)
        self.assertIn("comma-separated list", injected.stderr)
        self.assertFalse(self.capture.exists())

        non_subset = self.run_mapper(PORTS="80,443", TORRENT_PORTS="42501")
        self.assertEqual(non_subset.returncode, 2)
        self.assertIn("not present in PORTS", non_subset.stderr)
        self.assertFalse(self.capture.exists())


class MapperPythonTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        source = SCRIPT.read_text(encoding="utf-8")
        python_blocks = re.findall(r"<<'PY'\n(.*?)\nPY", source, flags=re.DOTALL)
        if len(python_blocks) != 2:
            raise AssertionError("Expected exactly two embedded Python programs")
        definitions, marker, _main = python_blocks[1].partition("\nlocations = discover()")
        if not marker:
            raise AssertionError("Could not isolate embedded mapper definitions")
        namespace: dict[str, object] = {"__name__": "map_mini_ports_test"}
        with mock.patch.dict(
            os.environ,
            {
                "PORTS": "80,443,42501",
                "TORRENT_PORTS": "42501",
                "STALE_TORRENT_PORTS": "42501",
            },
        ):
            exec(compile(definitions, str(SCRIPT), "exec"), namespace)
        cls.mapper = namespace

    def setUp(self) -> None:
        self.mapper["torrent_ports"] = {42501}
        self.mapper["stale_torrent_ports"] = {42501}

    def test_enabled_mapping_is_idempotent_for_boolean_true(self) -> None:
        calls: list[object] = []
        self.mapper["get_mapping"] = lambda *_args: {
            "NewInternalClient": "192.0.2.10",
            "NewInternalPort": "42501",
            "NewEnabled": "true",
        }
        self.mapper["delete_mapping"] = lambda *_args: calls.append("delete") or True
        self.mapper["soap"] = lambda *_args: calls.append("add")
        with contextlib.redirect_stdout(io.StringIO()):
            self.mapper["add_mapping"]("control", "service", "192.0.2.10", 42501)
        self.assertEqual(calls, [])

    def test_disabled_mapping_is_replaced_and_labelled(self) -> None:
        calls: list[object] = []
        self.mapper["get_mapping"] = lambda *_args: {
            "NewInternalClient": "192.0.2.10",
            "NewInternalPort": "42501",
            "NewEnabled": "0",
        }
        self.mapper["delete_mapping"] = lambda *_args: calls.append("delete") or True

        def record_soap(_control, _service, action, body):
            calls.append((action, body))

        self.mapper["soap"] = record_soap
        with contextlib.redirect_stdout(io.StringIO()):
            self.mapper["add_mapping"]("control", "service", "192.0.2.10", 42501)
        self.assertEqual(calls[0], "delete")
        self.assertEqual(calls[1][0], "AddPortMapping")
        self.assertIn("StreamArena BitTorrent", calls[1][1])

    def test_stale_owned_mapping_is_removed_after_ip_change(self) -> None:
        calls: list[int] = []
        self.mapper["get_mapping"] = lambda *_args: {
            "NewInternalClient": "192.0.2.9",
            "NewInternalPort": "42501",
            "NewEnabled": "1",
            "NewPortMappingDescription": "StreamArena BitTorrent",
        }
        self.mapper["delete_mapping"] = lambda _control, _service, port: calls.append(port) or True
        with contextlib.redirect_stdout(io.StringIO()):
            self.mapper["remove_stale_mappings"](
                "control", "service", "192.0.2.10"
            )
        self.assertEqual(calls, [42501])

    def test_failed_delete_is_not_reported_as_success(self) -> None:
        self.mapper["get_mapping"] = lambda *_args: {
            "NewPortMappingDescription": "StreamArena BitTorrent",
        }
        self.mapper["delete_mapping"] = lambda *_args: False
        with self.assertRaisesRegex(RuntimeError, "Could not remove stale"):
            self.mapper["remove_stale_mappings"](
                "control", "service", "192.0.2.10"
            )


if __name__ == "__main__":
    unittest.main()

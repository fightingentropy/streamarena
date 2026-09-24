import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("configure_mini_tunnel", Path(__file__).with_name("configure-mini-tunnel.py"))
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


class TunnelConfigurationTests(unittest.TestCase):
    def test_only_public_app_routes_change(self):
        original = """tunnel: existing-id
credentials-file: /private/existing.json
ingress:
  - hostname: music.streamarena.xyz
    service: http://127.0.0.1:5175
  - hostname: streamarena.xyz
    service: http://127.0.0.1:5173
  - hostname: www.streamarena.xyz
    service: http://127.0.0.1:5173
  - hostname: private-origin.streamarena.xyz
    service: http://127.0.0.1:5173
  - service: http_status:404
"""
        changed = repair.tunnel_configuration(original)
        self.assertEqual(changed.count("http://127.0.0.1:5180"), 2)
        self.assertIn("private-origin.streamarena.xyz\n    service: http://127.0.0.1:5173", changed)
        self.assertIn("music.streamarena.xyz\n    service: http://127.0.0.1:5175", changed)
        self.assertEqual(repair.tunnel_configuration(changed), changed)
        self.assertEqual(changed.replace("http://127.0.0.1:5180", "http://127.0.0.1:5173"), original)

    def test_unexpected_or_duplicate_routes_fail_closed(self):
        for text in (
            "ingress:\n  - service: http_status:404\n",
            "  - hostname: streamarena.xyz\n    service: http://other:1234\n",
            "  - hostname: streamarena.xyz\n    service: http://127.0.0.1:5173\n" * 2,
        ):
            with self.assertRaises(ValueError):
                repair.tunnel_configuration(text)

    def test_shared_caddy_routes_are_preserved_and_repair_is_idempotent(self):
        original = "{\n admin off\n auto_https off\n}\n:5175 {\n bind 127.0.0.1\n reverse_proxy 127.0.0.1:5174\n}\n"
        changed = repair.caddy_configuration(original)
        self.assertTrue(changed.startswith(original))
        self.assertEqual(repair.caddy_configuration(changed), changed)
        self.assertEqual(changed.count(repair.BEGIN), 1)

    def test_malformed_managed_block_is_rejected(self):
        for text in (repair.BEGIN, repair.END, repair.BEGIN + "\n" + repair.BEGIN):
            with self.assertRaises(ValueError):
                repair.caddy_configuration(text)


if __name__ == "__main__":
    unittest.main()

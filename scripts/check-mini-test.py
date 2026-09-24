#!/usr/bin/env python3
"""Offline regressions for Mini health decisions; no SSH or provider traffic."""
from pathlib import Path
import os
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/check-mini.sh'
SOURCE = SCRIPT.read_text()


class CheckerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)
        self.bin = self.path / 'bin'
        self.bin.mkdir()
        self.fixture = self.path / 'remote.txt'
        self.values = dict(line.split('=', 1) for line in '''runtime_tree=assets,bin,cache,dist
expected_tree=assets,bin,cache,dist
release_marker=valid
app_http=200
library_http=401
listener=127.0.0.1:5173
caddy_80=missing
caddy_443=missing
app_pid=50421
caddy_pid=94753
tunnel_pid=758
tunnel_daemon=yes
tunnel_launch_state=running
tunnel_ingress_valid=yes
tunnel_primary_service=http://127.0.0.1:5180
tunnel_alias_service=http://127.0.0.1:5180
caddy_config=/Users/hermes/.config/caddy/Caddyfile-tunnel
caddy_config_valid=yes
caddy_loopback=127.0.0.1:5180
caddy_version=v2.11.3
caddy_client_ip_guard=no
caddy_https_redirect=no
caddy_direct_origin=no
local_proxy_http=401
local_http_redirect=308 https://streamarena.xyz/login.html?mini_check=1
local_alias_redirect=308 https://streamarena.xyz/login.html?mini_check=1
asset_symlinks=0
env_mode=600
env_in_app=no
app_env_mode=none
cache_mode=700
users_db_mode=600
users_db_quick_check=ok
effective_open_signup=0
rd_token_encryption_configured=yes
live_hls_proxy_secret_configured=yes
sports_proxy_matches_expected=yes
torznab_configured=yes
torznab_local_jackett=yes
jackett_listener=127.0.0.1:9117
jackett_launch_state=running
jackett_indexers_mode=700
jackett_credentials_private=yes
torznab_caps_http=200
torznab_caps_valid=yes
torznab_search_http=200
torznab_search_valid=yes
torznab_search_items=0
espn_http=200
espn_football_event_count=0
app_daemon=yes
caddy_daemon=yes
legacy_caddy_daemon=no
legacy_caddy_loaded=no
app_launch_state=running
caddy_launch_state=running
app_runs=1
caddy_runs=1
maintenance_helper_private=yes
log_maintenance=healthy
disk_maintenance=healthy
watchdog_maintenance=healthy
maintenance_gui_duplicates=no
cron_leftover=0
disk_capacity_percent=50
disk_available_gb=100
public_ip=192.0.2.2
hls_resolver=yes
streamed_hls_resolver=yes
matchstream_hls_resolver=yes
ntvs_hls_resolver=yes
browser_hls_session_relay=yes
cdnlivetv_hls_resolver=yes
resolver_runtime_helper=yes
resolver_runtime_smoke=yes
node_bin=/usr/local/bin/node
bun_bin=/usr/local/bin/bun
playwright_module=yes
libsodium_module=yes
playwright_chromium=yes
warp_cli=/usr/local/bin/warp-cli
warp_status=Connected
warp_mode=WarpProxy on port 40000
streamed_proxy_http=200
ntvs_proxy_http=200'''.splitlines())
        self.tool('ssh', '''#!/bin/bash
cat >/dev/null
printf '%s' "${@: -1}" > "$MOCK_REMOTE_COMMAND"
cat "$MOCK_REMOTE_OUTPUT"
''')
        self.tool('curl', '''#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
url = next(arg for arg in reversed(args) if arg.startswith(('http:', 'https:')))
if '-o' in args and args[args.index('-o') + 1] != '/dev/null':
    open(args[args.index('-o') + 1], 'w').write('{"signup":{"open":false}}')
if '-sSI' in args:
    print('server: cloudflare\\r\\nx-robots-tag: noindex, nofollow, noarchive, nosnippet\\r')
elif url.startswith('http:') or 'www.streamarena' in url:
    print('308 https://streamarena.xyz/login.html', end='')
elif url.endswith('/robots.txt'):
    print('User-agent: *\\nDisallow: /')
elif url.endswith('/api/auth/config') or url.endswith('/login.html'):
    print('200', end='')
elif url == 'https://streamarena.xyz':
    print('302', end='')
else:
    print('401', end='')
''')

    def tearDown(self):
        self.temp.cleanup()

    def tool(self, name, content):
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o755)

    def run_check(self, overrides=None, **env_overrides):
        values = self.values | (overrides or {})
        self.fixture.write_text(''.join(f'{key}={value}\n' for key, value in values.items()))
        env = os.environ | {
            'PATH': f'{self.bin}:{os.environ["PATH"]}',
            'MOCK_REMOTE_OUTPUT': str(self.fixture),
            'MOCK_REMOTE_COMMAND': str(self.path / 'remote-command'),
            'MINI_INGRESS_MODE': 'tunnel',
            'STREAMARENA_CADDY_PORT': '5180',
            'TORZNAB_CHECK_QUERY': '',
        } | env_overrides
        return subprocess.run(['bash', str(SCRIPT)], env=env, capture_output=True, text=True)

    def test_tunnel_without_public_listeners_and_empty_schedule_passes(self):
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Cloudflare Tunnel daemon is running', result.stdout)
        self.assertIn('ESPN football schedule is valid (0 events)', result.stdout)

    def test_route_bypass_and_dead_tunnel_fail(self):
        for changes, error in [
            ({'tunnel_primary_service': 'http://127.0.0.1:5173'}, 'primary Tunnel route'),
            ({'tunnel_launch_state': 'not running'}, 'Tunnel daemon'),
            ({'caddy_loopback': '*:5180'}, 'listener'),
            ({'caddy_config_valid': 'no'}, 'configuration'),
            ({'local_proxy_http': '200'}, 'protected requests'),
            ({'local_alias_redirect': '308 https://streamarena.xyz/login.html'}, 'preserves'),
        ]:
            with self.subTest(changes=changes):
                result = self.run_check(changes)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn('bad ', result.stderr)

    def test_direct_mode_checks_owned_listeners_without_removing_shared_tunnel(self):
        values = {'caddy_80': '*:80', 'caddy_443': '*:443', 'caddy_client_ip_guard': 'yes',
                  'caddy_https_redirect': 'yes', 'caddy_direct_origin': 'yes'}
        result = self.run_check(values, MINI_INGRESS_MODE='direct')
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.run_check(values | {'caddy_443': 'missing'}, MINI_INGRESS_MODE='direct')
        self.assertEqual(result.returncode, 1)

    def test_real_health_failures_are_not_masked(self):
        for field, value in [('release_marker', 'invalid'), ('runtime_tree', 'assets,bin,cache,dist,src'),
                             ('watchdog_maintenance', 'disabled'), ('log_maintenance', 'failed:not running:exit=1'),
                             ('maintenance_gui_duplicates', 'yes'), ('maintenance_helper_private', 'no'),
                             ('torznab_caps_valid', 'no'), ('espn_football_event_count', 'invalid'),
                             ('users_db_quick_check', 'corrupt'), ('jackett_launch_state', 'missing')]:
            with self.subTest(field=field):
                result = self.run_check({field: value})
                self.assertEqual(result.returncode, 1, result.stdout)

    def test_opt_in_search_accepts_empty_rss_but_rejects_provider_error(self):
        result = self.run_check(TORZNAB_CHECK_QUERY='Interstellar')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('valid RSS (0 items)', result.stdout)
        result = self.run_check({'torznab_search_valid': 'no'}, TORZNAB_CHECK_QUERY='Interstellar')
        self.assertEqual(result.returncode, 1)

    def test_remote_provider_does_not_require_local_jackett(self):
        result = self.run_check({'torznab_local_jackett': 'no', 'jackett_launch_state': 'missing'})
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_remote_values_are_shell_quoted(self):
        payload = "it's literal `touch /tmp/not-run-check-mini` $(exit 7)"
        result = self.run_check(REMOTE_APP=payload)
        self.assertEqual(result.returncode, 0, result.stderr)
        remote = (self.path / 'remote-command').read_text()
        # The command only sets env and runs bash; replace bash to inspect that
        # the receiving shell sees exactly the supplied value without evaluation.
        inspected = subprocess.run(['bash', '-c', remote.removesuffix('bash -s') + "python3 -c 'import os; print(os.environ[\"REMOTE_APP\"])'"],
                                   capture_output=True, text=True)
        self.assertEqual(inspected.returncode, 0, inspected.stderr)
        self.assertEqual(inspected.stdout.strip(), payload)
        self.assertFalse(Path('/tmp/not-run-check-mini').exists())


class RemoteProbeTests(unittest.TestCase):
    def test_maintenance_timer_state_and_exact_program(self):
        launch = SOURCE[SOURCE.index('launch_value() {'):SOURCE.index('process_argument() {')]
        probe = SOURCE[SOURCE.index('maintenance_job() {'):SOURCE.index('log_maintenance=$(maintenance_job')]
        helper = '/Library/Application Support/StreamArena/maintenance.py'
        cases = [('not running', '0', '', helper, 'rotate', 'healthy'),
                 ('not running', '', '', helper, 'rotate', 'healthy'),
                 ('running', '0', '', helper, 'rotate', 'healthy'),
                 ('not running', '1', '', helper, 'rotate', 'failed:not running:exit=1'),
                 ('not running', '0', '"com.fightingentropy.streamarena-log-rotation" => true', helper, 'rotate', 'disabled'),
                 ('not running', '0', '"com.fightingentropy.streamarena-log-rotation" => disabled', helper, 'rotate', 'disabled'),
                 ('not running', '0', '', '/Users/hermes/.local/bin/old-helper', 'rotate', 'wrong-helper'),
                 ('not running', '0', '', helper, 'watchdog', 'wrong-helper')]
        for state, last_exit, disabled, program, mode, expected in cases:
            with self.subTest(state=state, last_exit=last_exit, mode=mode, disabled=disabled):
                info = f"state = {state}\narguments = {{\n /usr/bin/python3\n {program}\n {mode}\n}}\n"
                if last_exit:
                    info += f'last exit code = {last_exit}\n'
                mock = "launchctl() { if [[ \"$1\" == print-disabled ]]; then printf '%s\\n' \"$DISABLED\"; else printf '%s\\n' \"$INFO\"; fi; }\n"
                result = subprocess.run(['bash', '-c', mock + launch + probe + 'maintenance_job rotate log-rotation'],
                    env=os.environ | {'INFO': info, 'DISABLED': disabled, 'maintenance_helper': helper}, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), expected)

    def test_env_values_match_backend_literal_quote_and_last_assignment_rules(self):
        code = SOURCE[SOURCE.index('env_value() {'):SOURCE.index('canonical_open_signup=')]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'env'
            path.write_bytes(b"""# comment\nKEY=old\nKEY="literal$()=key"\r\nSINGLE='single=quoted'\nRAW=literal$variable\n""")
            for key, expected in [('KEY', 'literal$()=key'), ('SINGLE', 'single=quoted'),
                                  ('RAW', 'literal$variable'), ('MISSING', '')]:
                with self.subTest(key=key):
                    result = subprocess.run(['bash', '-c', code + 'env_value "$KEY" "$ENV_FILE"'],
                        env=os.environ | {'KEY': key, 'ENV_FILE': str(path)}, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stdout, expected)

    def test_torznab_url_replaces_embedded_key_and_preserves_other_parameters(self):
        code = SOURCE[SOURCE.index('torznab_request_base() {'):SOURCE.index('torznab_xml() {')]
        url = 'http://127.0.0.1:9117/api?apikey=old&filter=movies&APIKEY=duplicate&empty='
        result = subprocess.run(['bash', '-c', code + 'torznab_request_base'], input=url, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'http://127.0.0.1:9117/api?filter=movies&empty=')

    def test_xml_contract(self):
        code = re.search(r"<<'XML'\n(.*?)\nXML", SOURCE, re.S).group(1)
        cases = [('caps', '<caps><searching/></caps>', 'yes'),
                 ('caps', '<error code="100" description="Bad API key"/>', 'no'),
                 ('caps', '<html/>', 'no'),
                 ('search', '<rss><channel/></rss>', '0'),
                 ('search', '<rss><channel><item id="1"/></channel></rss>', '1'),
                 ('search', '<rss xmlns="test"><channel><item/></channel></rss>', '1'),
                 ('search', '<rss><channel><error code="900"/></channel></rss>', 'invalid'),
                 ('search', '<html>down', 'invalid')]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'body.xml'
            for kind, xml, expected in cases:
                with self.subTest(xml=xml):
                    path.write_text(xml)
                    result = subprocess.run(['python3', '-', str(path), kind], input=code, capture_output=True, text=True)
                    self.assertEqual(result.stdout.strip(), expected)

    def test_runtime_metadata_is_checked_without_allowing_extra_tree_entries(self):
        code = SOURCE[SOURCE.index('runtime_tree=$(find'):SOURCE.index('app_http=$(curl')]
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            for name in ['assets', 'bin', 'cache', 'dist', '.deploy-rollback']:
                (app / name).mkdir()
            def inspect():
                result = subprocess.run(['bash', '-c', code + '\nprintf "%s\\n%s" "$runtime_tree" "$release_marker"'],
                                        env=os.environ | {'app': directory}, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                return result.stdout.splitlines()
            self.assertEqual(inspect(), ['assets,bin,cache,dist', 'absent'])
            (app / '.release-commit').write_text('80568e2b4e75e923c699d8f8f85ff0e1277cd2a5\n')
            self.assertEqual(inspect(), ['assets,bin,cache,dist', 'valid'])
            (app / '.release-commit').write_text('not a commit')
            self.assertEqual(inspect()[1], 'invalid')
            (app / '.release-commit').unlink()
            (app / '.release-commit').symlink_to(app / 'assets')
            self.assertEqual(inspect()[1], 'invalid')
            (app / 'src').mkdir()
            self.assertIn('src', inspect()[0])


if __name__ == '__main__':
    unittest.main()

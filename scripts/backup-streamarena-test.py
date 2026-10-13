#!/usr/bin/env python3
"""Exercise recovery from uncheckpointed WAL and safe backup retention."""
import contextlib
import datetime
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


backup = load('backup_streamarena', 'backup-streamarena.py')
snapshot = load('snapshot_streamarena', 'snapshot-streamarena.py')


class BackupTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / 'app'
        (self.source / 'cache').mkdir(parents=True)
        (self.source / 'assets/images').mkdir(parents=True)
        (self.source / 'assets/videos').mkdir()
        (self.source / 'assets/library.json').write_text('{"movies": [{"id": "local-1"}]}')
        (self.source / 'assets/images/poster.jpg').write_bytes(b'poster-artwork')
        (self.source / 'assets/videos/movie.mp4').write_bytes(b'large-video-excluded')
        (self.source / '.release-commit').write_text('a' * 40 + '\n')
        self.users = self.database('users.sqlite')
        self.users.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
        self.users.commit()
        self.users.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        self.users.execute('INSERT INTO users VALUES (1, "kept-in-WAL")')
        self.users.commit()
        self.cache = self.database('resolver-cache.sqlite')
        self.cache.execute('CREATE TABLE title_track_preferences (user_id INTEGER, language TEXT)')
        self.cache.execute('CREATE TABLE resolver_cache (url TEXT)')
        self.cache.execute('CREATE TABLE source_health (source TEXT, failures INTEGER)')
        self.cache.execute('CREATE TABLE legacy_users (name TEXT)')
        self.cache.execute('INSERT INTO title_track_preferences VALUES (1, "en")')
        self.cache.execute('INSERT INTO resolver_cache VALUES ("host-bound-url")')
        self.cache.execute('INSERT INTO source_health VALUES ("provider", 4)')
        self.cache.execute('INSERT INTO legacy_users VALUES ("must-not-migrate")')
        self.cache.commit()
        self.output = self.root / 'backups'

    def database(self, filename):
        connection = sqlite3.connect(self.source / 'cache' / filename)
        self.addCleanup(connection.close)
        connection.execute('PRAGMA journal_mode=WAL')
        connection.execute('PRAGMA wal_autocheckpoint=0')
        return connection

    def test_online_full_backup_preserves_wal_and_excludes_video_files(self):
        # Ignoring WAL demonstrates that a naive main-file copy loses this row.
        main_only = sqlite3.connect(
            (self.source / 'cache/users.sqlite').as_uri() + '?immutable=1', uri=True)
        self.addCleanup(main_only.close)
        self.assertEqual(main_only.execute('SELECT count(*) FROM users').fetchone()[0], 0)
        result = backup.backup(self.source, self.output)
        saved = Path(result['backup'])
        with sqlite3.connect(saved / 'users.sqlite') as connection:
            self.assertEqual(connection.execute('SELECT name FROM users').fetchone()[0], 'kept-in-WAL')
        with sqlite3.connect(saved / 'resolver-cache.sqlite') as connection:
            self.assertEqual(connection.execute('SELECT url FROM resolver_cache').fetchone()[0], 'host-bound-url')
            self.assertEqual(connection.execute('SELECT failures FROM source_health').fetchone()[0], 4)
        with tarfile.open(saved / 'assets-metadata.tar.gz') as archive:
            self.assertIn('assets/library.json', archive.getnames())
            self.assertIn('assets/images/poster.jpg', archive.getnames())
            self.assertFalse(any(name.startswith('assets/videos') for name in archive.getnames()))
            self.assertEqual(archive.extractfile('assets/images/poster.jpg').read(), b'poster-artwork')
        self.assertEqual(saved.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o700)
        for file in saved.iterdir():
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)

    def test_migration_copies_title_preferences_but_retrains_host_health(self):
        saved = self.root / 'migration'
        with contextlib.redirect_stdout(io.StringIO()):
            snapshot.snapshot(self.source, saved, 'a' * 40)
            snapshot.verify(saved)
        with sqlite3.connect(saved / 'resolver-cache.sqlite') as connection:
            names = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertEqual(names, {'title_track_preferences'})
            self.assertEqual(connection.execute('SELECT * FROM title_track_preferences').fetchall(), [(1, 'en')])
        with sqlite3.connect(saved / 'users.sqlite') as connection:
            self.assertEqual(connection.execute('SELECT name FROM users').fetchone()[0], 'kept-in-WAL')

    def test_quiesced_migration_refuses_uncheckpointed_wal(self):
        saved = self.root / 'migration-offline'
        with self.assertRaisesRegex(RuntimeError, 'empty or absent -wal'):
            snapshot.snapshot(self.source, saved, 'a' * 40, quiesced=True)
        self.assertFalse(saved.exists())

    def test_quiesced_full_backup_refuses_uncheckpointed_wal(self):
        with self.assertRaisesRegex(RuntimeError, 'empty or absent -wal'):
            backup.backup(self.source, self.output, quiesced=True)
        self.assertFalse(self.output.exists())

    def test_quiesced_migration_preserves_checkpointed_data_without_sidecars(self):
        self.users.close()
        self.cache.close()
        for filename in ('users.sqlite', 'resolver-cache.sqlite'):
            self.assertFalse(Path(str(self.source / 'cache' / filename) + '-wal').exists())
        saved = self.root / 'migration-offline'
        with contextlib.redirect_stdout(io.StringIO()):
            snapshot.snapshot(self.source, saved, 'a' * 40, quiesced=True)
            snapshot.verify(saved)
        with sqlite3.connect(saved / 'users.sqlite') as connection:
            self.assertEqual(connection.execute('SELECT name FROM users').fetchone()[0], 'kept-in-WAL')
        self.assertTrue(json.loads((saved / 'manifest.json').read_text())['quiesced'])
        for filename in ('users.sqlite', 'resolver-cache.sqlite'):
            self.assertFalse(Path(str(self.source / 'cache' / filename) + '-wal').exists())
            self.assertFalse(Path(str(self.source / 'cache' / filename) + '-shm').exists())

    def test_quiesced_migration_refuses_nonempty_journal(self):
        self.users.close()
        self.cache.close()
        (self.source / 'cache/users.sqlite-journal').write_bytes(b'pending-writes')
        saved = self.root / 'migration-offline'
        with self.assertRaisesRegex(RuntimeError, 'empty or absent -journal'):
            snapshot.snapshot(self.source, saved, 'a' * 40, quiesced=True)
        self.assertFalse(saved.exists())

    def test_quiesced_full_backup_creates_no_source_sidecars(self):
        self.users.close()
        self.cache.close()
        result = backup.backup(self.source, self.output, quiesced=True)
        saved = Path(result['backup'])
        with sqlite3.connect(saved / 'users.sqlite') as connection:
            self.assertEqual(connection.execute('SELECT name FROM users').fetchone()[0], 'kept-in-WAL')
        with sqlite3.connect(saved / 'resolver-cache.sqlite') as connection:
            self.assertEqual(connection.execute('SELECT url FROM resolver_cache').fetchone()[0], 'host-bound-url')
        for filename in ('users.sqlite', 'resolver-cache.sqlite'):
            self.assertFalse(Path(str(self.source / 'cache' / filename) + '-wal').exists())
            self.assertFalse(Path(str(self.source / 'cache' / filename) + '-shm').exists())

    def test_retention_removes_only_completed_old_daily_snapshots(self):
        self.output.mkdir()
        now = datetime.datetime.now(datetime.timezone.utc)
        old = now - datetime.timedelta(days=15)
        stamp = old.strftime('%Y%m%dT%H%M%S%fZ')
        for prefix in ('daily-', 'deploy-', '.daily-'):
            target = self.output / (prefix + stamp)
            target.mkdir()
            (target / 'manifest.json').write_text(json.dumps({
                'kind': 'streamarena-full-backup-v1', 'created_at': old.isoformat()}))
        incomplete = self.output / ('daily-' + (old - datetime.timedelta(seconds=1)).strftime('%Y%m%dT%H%M%S%fZ'))
        incomplete.mkdir()
        result = backup.backup(self.source, self.output)
        self.assertEqual(result['pruned'], ['daily-' + stamp])
        self.assertTrue((self.output / ('deploy-' + stamp)).exists())
        self.assertTrue((self.output / ('.daily-' + stamp)).exists())
        self.assertTrue(incomplete.exists())

    def test_missing_users_never_creates_an_empty_account_database(self):
        self.users.close()
        (self.source / 'cache/users.sqlite').unlink()
        with self.assertRaisesRegex(RuntimeError, 'Durable users database is missing'):
            backup.backup(self.source, self.output)
        self.assertFalse((self.source / 'cache/users.sqlite').exists())
        self.assertFalse(self.output.exists())

    def test_corruption_does_not_publish_a_partial_backup_or_prune(self):
        self.cache.close()
        (self.source / 'cache/resolver-cache.sqlite').write_bytes(b'not-a-database')
        with self.assertRaises(sqlite3.DatabaseError):
            backup.backup(self.source, self.output)
        self.assertEqual({path.name for path in self.output.iterdir()}, {'.backup.lock'})


if __name__ == '__main__':
    unittest.main()

#!/usr/bin/env python3
"""Consistent, private StreamArena account snapshot plus title preferences.

Run while production is live for preparation. For the final cutover, stop app
writes first: the two source databases are individually consistent, not an
atomic cross-database snapshot. Never copy live SQLite files without backup.
After stopping the app, --quiesced permits immutable reads of checkpointed
databases on systems where SQLite cannot reopen a WAL-mode database read-only.
It refuses any nonempty WAL/journal and checks the files stayed unchanged.
No resolver/playback URL cache or legacy account tables are transferred from
resolver-cache.sqlite. The backend recreates those cache tables on startup.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import sqlite3


def identifier(value):
    return '"' + value.replace('"', '""') + '"'


def offline_state(path):
    """Fail closed if an immutable read could omit pending committed writes."""
    for suffix in ('-wal', '-journal'):
        sidecar = Path(str(path) + suffix)
        if sidecar.exists() and sidecar.stat().st_size:
            raise RuntimeError('Quiesced snapshot requires an empty or absent ' +
                               suffix + ' file: ' + path.name)
    stat = path.stat()
    return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns,
            stat.st_ctime_ns)


def readonly(path, quiesced=False):
    if quiesced:
        offline_state(path)
    options = '?mode=ro&immutable=1' if quiesced else '?mode=ro'
    return sqlite3.connect(path.resolve().as_uri() + options, uri=True,
                           timeout=30)


def tables(connection):
    return [r[0] for r in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]


def counts(connection):
    return {name: connection.execute(
        'SELECT count(*) FROM ' + identifier(name)).fetchone()[0]
        for name in tables(connection)}


def checked_db(path):
    with readonly(path) as connection:
        integrity = [r[0] for r in connection.execute('PRAGMA integrity_check')]
        if integrity != ['ok']:
            raise RuntimeError('SQLite integrity check failed: ' + path.name)
        if list(connection.execute('PRAGMA foreign_key_check')):
            raise RuntimeError('SQLite foreign key check failed: ' + path.name)
        result = counts(connection)
    return {'tables': result, 'bytes': path.stat().st_size,
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def new_private_db(path):
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    return sqlite3.connect(path)


def snapshot(root, output, expected_release, quiesced=False):
    root = root.resolve()
    release_path = root / '.release-commit'
    release = release_path.read_text().strip() if release_path.exists() else None
    if expected_release and release != expected_release:
        raise RuntimeError('Source release does not match expected release')
    source_users = root / 'cache/users.sqlite'
    source_cache = root / 'cache/resolver-cache.sqlite'
    if not source_users.is_file():
        raise RuntimeError('Durable users database is missing; refusing snapshot')
    offline_sources = ({path: offline_state(path)
                        for path in (source_users, source_cache) if path.exists()}
                       if quiesced else {})
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.chmod(output, 0o700)
    target_users = output / 'users.sqlite'
    target_cache = output / 'resolver-cache.sqlite'
    source = readonly(source_users, quiesced=quiesced)
    destination = new_private_db(target_users)
    try:
        # Establish a read snapshot before counts, then use that same source
        # transaction for online backup, including all committed WAL contents.
        source.execute('BEGIN')
        source_counts = counts(source)
        source.backup(destination)
        source.rollback()
        destination.execute('PRAGMA journal_mode=DELETE')
    finally:
        destination.close()
        source.close()
    user_result = checked_db(target_users)
    if user_result['tables'] != source_counts:
        raise RuntimeError('Durable snapshot row counts differ from source snapshot')

    # Title audio/subtitle preferences currently live in the otherwise
    # regenerable database. Copy their current schema and rows only.
    preference_count = 0
    destination = new_private_db(target_cache)
    try:
        if source_cache.exists():
            source = readonly(source_cache, quiesced=quiesced)
            try:
                source.execute('BEGIN')
                schema = source.execute(
                    "SELECT sql FROM sqlite_master WHERE type='table' "
                    "AND name='title_track_preferences'").fetchone()
                if schema:
                    destination.execute(schema[0])
                    cursor = source.execute('SELECT * FROM title_track_preferences')
                    column_count = len(cursor.description)
                    rows = cursor.fetchall()
                    preference_count = len(rows)
                    destination.executemany(
                        'INSERT INTO title_track_preferences VALUES (' +
                        ','.join('?' for _ in range(column_count)) + ')', rows)
                    for row in source.execute(
                        "SELECT sql FROM sqlite_master WHERE type='index' "
                        "AND tbl_name='title_track_preferences' AND sql IS NOT NULL"):
                        destination.execute(row[0])
                source.rollback()
            finally:
                source.close()
        destination.commit()
    finally:
        destination.close()
    cache_result = checked_db(target_cache)
    if set(cache_result['tables']) - {'title_track_preferences'}:
        raise RuntimeError('Unexpected table in sanitized resolver cache')
    if cache_result['tables'].get('title_track_preferences', 0) != preference_count:
        raise RuntimeError('Title preference count differs from source snapshot')
    for path, initial in offline_sources.items():
        if offline_state(path) != initial:
            raise RuntimeError('Source changed during quiesced snapshot: ' + path.name)
    manifest = {
        'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'release_commit': release,
        'source': str(root),
        'quiesced': quiesced,
        'scope': 'Durable users plus title preferences; resolver URLs excluded',
        'databases': {'users.sqlite': user_result,
                      'resolver-cache.sqlite': cache_result},
    }
    manifest_path = output / 'manifest.json'
    fd = os.open(manifest_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(manifest, handle, indent=2)
        handle.write('\n')
    print(json.dumps({'snapshot': str(output), **manifest}, indent=2))


def verify(directory):
    manifest = json.loads((directory / 'manifest.json').read_text())
    if set(manifest['databases']) != {'users.sqlite', 'resolver-cache.sqlite'}:
        raise RuntimeError('Unexpected database set in snapshot manifest')
    for filename, expected in manifest['databases'].items():
        actual = checked_db(directory / filename)
        if actual != expected:
            raise RuntimeError('Snapshot verification failed: ' + filename)
    print(json.dumps({'verified': True, 'snapshot': str(directory),
                      'release_commit': manifest['release_commit'],
                      'databases': manifest['databases']}, indent=2))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    create = commands.add_parser('snapshot')
    create.add_argument('--source', type=Path, required=True)
    create.add_argument('--output', type=Path, required=True)
    create.add_argument('--expect-release')
    create.add_argument('--quiesced', action='store_true',
                        help='App must be stopped; only checkpointed databases '
                             'without nonempty WAL/journal files may be read immutably')
    check = commands.add_parser('verify')
    check.add_argument('--snapshot', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'snapshot':
        snapshot(args.source, args.output, args.expect_release, args.quiesced)
    else:
        verify(args.snapshot)


if __name__ == '__main__':
    main()

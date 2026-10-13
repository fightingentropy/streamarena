#!/usr/bin/env python3
"""Online SQLite backups and library metadata/artwork, with private retention.

Each database includes committed WAL pages and is transactionally consistent.
An online backup is not an atomic snapshot across the two databases and assets;
stop application writes first when that stronger guarantee is required.
Local video files and generated caches are excluded. Back them up separately.
"""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tarfile


spec = importlib.util.spec_from_file_location(
    'streamarena_snapshot', Path(__file__).with_name('snapshot-streamarena.py'))
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)
DAILY_NAME = re.compile(r'^daily-\d{8}T\d{12}Z$')


def archive_assets(source, destination):
    """Preserve metadata/artwork, without traversing links or archiving videos."""
    assets = (source / 'assets').resolve()
    if not (assets / 'library.json').is_file():
        raise RuntimeError('Library metadata is missing; refusing backup')
    entries = 0
    with tarfile.open(destination, 'w:gz', dereference=False) as archive:
        for current, directories, filenames in os.walk(assets, followlinks=False):
            current = Path(current)
            if current == assets:
                directories[:] = [name for name in directories if name != 'videos']
            for name in sorted(directories + filenames):
                path = current / name
                relative = path.relative_to(assets)
                if path.is_symlink():
                    raise RuntimeError('Metadata contains a symlink: ' + str(relative))
                if not path.is_file() and not path.is_dir():
                    raise RuntimeError('Unsupported metadata entry: ' + str(relative))
                before = path.stat()
                archive.add(path, arcname='assets/' + str(relative), recursive=False)
                after = path.stat()
                if (before.st_ino, before.st_size, before.st_mtime_ns) != (
                        after.st_ino, after.st_size, after.st_mtime_ns):
                    raise RuntimeError('Metadata changed during backup; retry')
                entries += 1
    destination.chmod(0o600)
    # Read the whole gzip stream so a truncated archive cannot be published.
    with tarfile.open(destination, 'r:gz') as archive:
        for member in archive:
            if member.isfile():
                with archive.extractfile(member) as handle:
                    while handle.read(1024 * 1024):
                        pass
    return {'entries': entries, 'bytes': destination.stat().st_size,
            'sha256': hashlib.sha256(destination.read_bytes()).hexdigest(),
            'excludes': ['assets/videos/']}


def prune(root, cutoff):
    removed = []
    for path in root.iterdir():
        if not DAILY_NAME.fullmatch(path.name) or path.is_symlink() or not path.is_dir():
            continue
        manifest_path = path / 'manifest.json'
        if not manifest_path.is_file() or manifest_path.is_symlink():
            continue
        try:
            manifest = json.loads(manifest_path.read_text())
            created = datetime.datetime.fromisoformat(manifest['created_at'])
            if manifest.get('kind') != 'streamarena-full-backup-v1' or created >= cutoff:
                continue
        except (KeyError, TypeError, ValueError):
            continue
        shutil.rmtree(path)
        removed.append(path.name)
    return removed


def backup(source, output_root, retention_days=14, prefix='daily', quiesced=False):
    if retention_days < 1:
        raise ValueError('Retention must be at least one day')
    if prefix not in ('daily', 'deploy'):
        raise ValueError('Backup prefix must be daily or deploy')
    source = source.resolve()
    if not (source / 'cache/users.sqlite').is_file():
        raise RuntimeError('Durable users database is missing; refusing backup')
    if not (source / 'cache/resolver-cache.sqlite').is_file():
        raise RuntimeError('Resolver database is missing; refusing full backup')
    offline_sources = ({path: snapshot.offline_state(path) for path in (
        source / 'cache/users.sqlite', source / 'cache/resolver-cache.sqlite')}
        if quiesced else {})
    if output_root.is_symlink():
        raise RuntimeError('Backup root must not be a symlink')
    output_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    output_root.chmod(0o700)
    with open(output_root / '.backup.lock', 'a') as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        now = datetime.datetime.now(datetime.timezone.utc)
        name = prefix + '-' + now.strftime('%Y%m%dT%H%M%S%fZ')
        temporary = output_root / ('.' + name + '.partial')
        completed = output_root / name
        temporary.mkdir(mode=0o700)
        try:
            databases = {}
            for filename in ('users.sqlite', 'resolver-cache.sqlite'):
                target = temporary / filename
                with contextlib.closing(snapshot.readonly(source / 'cache' / filename,
                                                          quiesced=quiesced)) as src:
                    with contextlib.closing(snapshot.new_private_db(target)) as dst:
                        src.backup(dst)
                        dst.execute('PRAGMA journal_mode=DELETE')
                databases[filename] = snapshot.checked_db(target)
            assets = archive_assets(source, temporary / 'assets-metadata.tar.gz')
            for path, initial in offline_sources.items():
                if snapshot.offline_state(path) != initial:
                    raise RuntimeError('Source changed during quiesced backup: ' + path.name)
            release_file = source / '.release-commit'
            manifest = {
                'kind': 'streamarena-full-backup-v1',
                'created_at': now.isoformat(),
                'release_commit': release_file.read_text().strip() if release_file.exists() else None,
                'quiesced': quiesced,
                'consistency': 'Per-database online snapshots; stop writes for cross-file consistency',
                'databases': databases, 'assets-metadata.tar.gz': assets,
            }
            manifest_path = temporary / 'manifest.json'
            manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
            manifest_path.chmod(0o600)
            temporary.rename(completed)
        except BaseException:
            shutil.rmtree(temporary, ignore_errors=True)
            raise
        removed = prune(output_root, now - datetime.timedelta(days=retention_days))
    return {'backup': str(completed), 'release_commit': manifest['release_commit'],
            'pruned': removed, 'databases': databases}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path('/opt/streamarena/current'))
    parser.add_argument('--output-root', type=Path, default=Path('/var/backups/streamarena'))
    parser.add_argument('--retention-days', type=int, default=14)
    parser.add_argument('--name-prefix', choices=('daily', 'deploy'), default='daily')
    parser.add_argument('--quiesced', action='store_true',
                        help='Require stopped writers and checkpointed databases; '
                             'read immutably without creating source WAL/SHM files')
    args = parser.parse_args()
    print(json.dumps(backup(args.source, args.output_root, args.retention_days,
                            args.name_prefix, args.quiesced), indent=2))


if __name__ == '__main__':
    main()

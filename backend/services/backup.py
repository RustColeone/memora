import hashlib
import json
import os
import sqlite3
import tempfile
import zipfile
from contextlib import ExitStack, closing
from datetime import datetime, timezone


class BackupService:
    def handle_portable_backup(self, db, upload_folder, lock=None):
        from services.db_converter import export_to_zip
        archive = tempfile.TemporaryFile()
        try:
            with ExitStack() as locks:
                if lock is not None:
                    locks.enter_context(lock)
                locks.enter_context(db._lock)
                if db.fetchone('PRAGMA quick_check')[0] != 'ok':
                    raise RuntimeError('Backup database verification failed')
                export_to_zip(db, upload_folder, output=archive)
            return archive
        except Exception:
            archive.close()
            raise

    def handle_download_backup(self, base_dir, data_dir, upload_folder, db=None, lock=None):
        """Return a disk-backed archive; response owns and closes the file.

        Lock order matches writers: context then database. SQLite backup includes
        committed WAL content. Paths stay portable for external data directories.
        """
        archive = tempfile.TemporaryFile()
        try:
            with tempfile.TemporaryDirectory() as staging, ExitStack() as locks:
                if lock is not None:
                    locks.enter_context(lock)
                if db is not None:
                    locks.enter_context(db._lock)
                snapshot = os.path.join(staging, 'memosystem.db')
                with closing(sqlite3.connect(os.path.join(data_dir, 'memosystem.db'))) as source, closing(sqlite3.connect(snapshot)) as destination:
                    source.backup(destination)
                    if destination.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                        raise RuntimeError('Backup database verification failed')
                manifest = {'version': 1, 'createdAt': datetime.now(timezone.utc).isoformat(), 'files': []}
                with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
                    def add(source_file, name):
                        digest = hashlib.sha256()
                        size = 0
                        with open(source_file, 'rb') as reader, zf.open(name, 'w', force_zip64=True) as writer:
                            for chunk in iter(lambda: reader.read(1024 * 1024), b''):
                                writer.write(chunk)
                                digest.update(chunk)
                                size += len(chunk)
                        manifest['files'].append({'path': name, 'size': size, 'sha256': digest.hexdigest()})
                    add(snapshot, 'data/memosystem.db')
                    for folder, prefix in [(data_dir, 'data'), (upload_folder, 'uploads')]:
                        for root, dirs, files in os.walk(folder):
                            dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(root, d))]
                            for name in sorted(files):
                                if prefix == 'data' and name in ('memosystem.db', 'memosystem.db-wal', 'memosystem.db-shm'):
                                    continue
                                path = os.path.join(root, name)
                                if not os.path.islink(path):
                                    add(path, prefix + '/' + os.path.relpath(path, folder).replace(os.sep, '/'))
                    zf.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
            archive.seek(0)
            return archive, f"memo_backup_{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}.zip"
        except Exception:
            archive.close()
            raise

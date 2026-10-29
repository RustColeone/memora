"""Isolated backup, compaction and acknowledgement fault checks."""
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import threading
import unittest
import zipfile
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from services.db import Database
from services.operations_store import OperationsStore
from services.operations import OperationsService
from services.backup import BackupService


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'data').mkdir()
        (self.root / 'uploads').mkdir()
        self.db = Database(str(self.root / 'data/memosystem.db'))
        self.store = OperationsStore(self.db)
        self.service = OperationsService(self.store)

    def tearDown(self):
        # Windows SQLite connections are thread-local and own open file handles.
        self.db._get_connection().close()
        self.temp.cleanup()

    def push(self, client_id, title):
        return self.service.handle_push_operations({'operations': [{
            'clientOpId': client_id, 'entryId': 'entry', 'type': 'create',
            'timestamp': 1, 'data': {'description': title},
        }]}, 'default')

    def test_retry_after_compaction_does_not_reapply_old_create(self):
        first, _ = self.push('old-create', 'original')
        self.push('new-create', 'newer')
        self.service.handle_compact_operations({'keepDays': 0}, 'default')
        again, status = self.push('old-create', 'original')
        self.assertEqual(status, 200)
        self.assertTrue(again['operations'][0]['duplicate'])
        self.assertEqual(first['operations'][0]['serverOpId'], again['operations'][0]['serverOpId'])
        self.assertEqual(self.service.rebuild_state_from_operations('default')[0]['description'], 'newer')

    def test_compaction_failure_rolls_back_snapshot_and_log(self):
        self.push('one', 'original')
        original = self.db.execute
        def fail_delete(sql, params=None):
            if sql.startswith('DELETE FROM operations'):
                raise RuntimeError('injected interruption')
            return original(sql, params)
        with patch.object(self.db, 'execute', side_effect=fail_delete):
            with self.assertRaises(RuntimeError):
                self.service.handle_compact_operations({'keepDays': 0}, 'default')
        self.assertEqual(self.store.get_snapshot('default')['snapshotId'], 0)
        self.assertEqual(len(self.store.get_operations('default')), 1)

    def test_concurrent_push_waits_for_compaction_then_remains_pullable(self):
        self.push('one', 'original')
        entered, finished = threading.Event(), threading.Event()
        original = self.service.save_snapshot_for_variant
        worker_errors = []
        def push_new():
            entered.set()
            try:
                self.assertEqual(self.push('two', 'newer')[1], 200)
            except Exception as exc:
                worker_errors.append(exc)
            finally:
                self.db._get_connection().close()
                finished.set()
        threads = []
        def save(snapshot, variant):
            thread = threading.Thread(target=push_new)
            threads.append(thread)
            thread.start()
            self.assertTrue(entered.wait(2))
            self.assertFalse(finished.wait(.05))
            original(snapshot, variant)
        with patch.object(self.service, 'save_snapshot_for_variant', side_effect=save):
            compact, _ = self.service.handle_compact_operations({'keepDays': 0}, 'default')
        for thread in threads:
            thread.join(5)
        self.assertTrue(finished.is_set())
        self.assertFalse(worker_errors)
        pulled, _ = self.service.handle_pull_operations(compact['snapshotId'], 'default')
        self.assertEqual(pulled['operations'][0]['clientOpId'], 'two')

    def test_backup_restores_committed_wal_and_checksums_with_portable_paths(self):
        self.push('one', 'backed up')
        (self.root / 'uploads/photo.jpg').write_bytes(b'original bytes')
        (self.root / 'data/memosystem.db.bak_old').write_bytes(b'older recovery copy')
        archive, _ = BackupService().handle_download_backup(
            '/unrelated/app', str(self.root / 'data'), str(self.root / 'uploads'), self.db, threading.RLock())
        try:
            with zipfile.ZipFile(archive) as zf:
                manifest = json.loads(zf.read('manifest.json'))
                for item in manifest['files']:
                    content = zf.read(item['path'])
                    self.assertEqual(len(content), item['size'])
                    self.assertEqual(hashlib.sha256(content).hexdigest(), item['sha256'])
                self.assertEqual(zf.read('data/memosystem.db.bak_old'), b'older recovery copy')
                self.assertFalse(any('..' in name or name.endswith(('-wal', '-shm')) for name in zf.namelist()))
                restored = self.root / 'restored.db'
                restored.write_bytes(zf.read('data/memosystem.db'))
            with closing(sqlite3.connect(restored)) as con:
                self.assertEqual(con.execute('PRAGMA quick_check').fetchone()[0], 'ok')
                self.assertEqual(con.execute('SELECT COUNT(*) FROM operations').fetchone()[0], 1)
        finally:
            archive.close()


if __name__ == '__main__':
    unittest.main()

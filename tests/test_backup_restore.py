"""Restore failures must leave synthetic records and files intact."""
import hashlib
import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))
from flask import Flask
from api.export_routes import create_export_blueprint
from services.db import Database
from services.db_converter import export_to_bundle, export_to_zip, import_from_bundle, import_from_zips
from services.operations import OperationsService
from services.operations_store import OperationsStore


def bundle(prefix):
    return {'version': 1,
            'memos': [{'id': prefix+'-memo', 'description': prefix, 'ts': 1000, 'images': ['/uploads/photo.bin']}],
            'finance': [{'id': prefix+'-finance', 'description': prefix, 'price': 12.5, 'ts': 1000}],
            'planner': [{'id': prefix+'-planner', 'kind': 'todo', 'title': prefix, 'ts': 1000}]}


def archive(data, files=None):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as z:
        z.writestr('memosystem.json', json.dumps(data))
        for name, content in (files or {}).items():
            z.writestr(name, content)
    return stream.getvalue()


class BackupRestoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='memora_restore_')
        self.addCleanup(self.temp.cleanup)
        self.db = Database(os.path.join(self.temp.name, 'live.db'))
        self.addCleanup(self.db.close)
        self.uploads = os.path.join(self.temp.name, 'uploads')
        os.makedirs(self.uploads)
        with open(os.path.join(self.uploads, 'photo.bin'), 'wb') as writer:
            writer.write(b'original-photo')
        import_from_bundle(self.db, bundle('original'), 'replace')
        self.original = export_to_bundle(self.db)
        app = Flask(__name__)
        app.register_blueprint(create_export_blueprint(SimpleNamespace(db=self.db, upload_folder=self.uploads, lock=threading.RLock())))
        self.client = app.test_client()

    def post(self, content, fmt='json', mode='replace'):
        return self.client.post('/api/db/import', data={'file': (io.BytesIO(content), 'backup.'+fmt), 'format': fmt, 'mode': mode})

    def assert_original(self):
        current = export_to_bundle(self.db)
        self.assertEqual({k: v for k, v in current.items() if k != 'exported_at'},
                         {k: v for k, v in self.original.items() if k != 'exported_at'})
        with open(os.path.join(self.uploads, 'photo.bin'), 'rb') as reader:
            self.assertEqual(reader.read(), b'original-photo')

    def test_portable_backup_covers_three_sections_and_verified_files(self):
        response = self.client.get('/api/db/export?format=zip')
        self.assertEqual(response.status_code, 200)
        with zipfile.ZipFile(io.BytesIO(response.data)) as z:
            self.assertIsNone(z.testzip())
            exported = json.loads(z.read('memosystem.json'))
            for key in ('memos', 'finance', 'planner'):
                self.assertEqual(len(exported[key]), 1)
            for item in json.loads(z.read('manifest.json'))['files']:
                data = z.read(item['path'])
                self.assertEqual(len(data), item['size'])
                self.assertEqual(hashlib.sha256(data).hexdigest(), item['sha256'])
        response.close()

    def test_invalid_late_section_does_not_commit_earlier_section(self):
        incoming = bundle('incoming')
        with patch('services.db_converter._import_planner', side_effect=ValueError('late section failure')):
            response = self.post(json.dumps(incoming).encode())
        self.assertEqual(response.status_code, 400)
        self.assert_original()

    def test_traversal_in_later_archive_changes_nothing(self):
        first = archive(bundle('incoming'), {'uploads/photo.bin': b'new-photo'})
        second = archive(bundle('second'), {'uploads/../escape.bin': b'bad'})
        with self.assertRaisesRegex(ValueError, 'Unsafe archive path'):
            import_from_zips(self.db, [first, second], self.uploads, 'replace')
        self.assert_original()
        self.assertFalse(os.path.exists(os.path.join(self.temp.name, 'escape.bin')))

    def test_late_database_failure_rolls_back_promoted_files(self):
        incoming = archive(bundle('incoming'), {'uploads/photo.bin': b'new-photo', 'uploads/new.bin': b'new'})
        def fail():
            raise RuntimeError('snapshot cannot be saved')
        with self.assertRaisesRegex(RuntimeError, 'snapshot'):
            import_from_zips(self.db, [incoming], self.uploads, 'replace', after_import=fail)
        self.assert_original()
        self.assertFalse(os.path.exists(os.path.join(self.uploads, 'new.bin')))

    def test_file_promotion_failure_rolls_back_records_and_previous_file(self):
        incoming = archive(bundle('incoming'), {'uploads/photo.bin': b'new-photo', 'uploads/new.bin': b'new'})
        replace = os.replace
        def fail_second(source, destination):
            if destination.endswith('new.bin'):
                raise OSError('disk is full')
            return replace(source, destination)
        with patch('services.db_converter.os.replace', side_effect=fail_second):
            with self.assertRaisesRegex(OSError, 'disk is full'):
                import_from_zips(self.db, [incoming], self.uploads, 'replace')
        self.assert_original()

    def test_checksum_mismatch_never_promotes_records_or_files(self):
        source = export_to_zip(self.db, self.uploads)
        target = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(source)) as original, zipfile.ZipFile(target, 'w') as corrupt:
            for name in original.namelist():
                corrupt.writestr(name, b'changed-photo' if name == 'uploads/photo.bin' else original.read(name))
        response = self.post(target.getvalue(), 'zip')
        self.assertEqual(response.status_code, 400)
        self.assert_original()

    def test_restored_sections_reach_existing_sync_clients_and_keep_receipts(self):
        store = OperationsStore(self.db)
        service = OperationsService(store)
        for variant in ('default', 'finance', 'planner'):
            service.reseat_snapshot_from_entries([], variant, 50)
            store.append_operation({'type': 'create', 'entryId': 'old', 'data': {'id': 'old'}, 'clientOpId': variant+'-receipt'}, variant)
        floors = {v: store.max_op_id(v) for v in ('default', 'finance', 'planner')}
        response = self.post(json.dumps(bundle('restored')).encode())
        self.assertEqual(response.status_code, 200, response.data)
        for variant in floors:
            result, status = service.handle_pull_operations(floors[variant], variant)
            self.assertEqual(status, 200)
            self.assertTrue(result['needsFullSync'])
            self.assertEqual(len(result['snapshot']['entries']), 1)
            self.assertGreater(result['snapshot']['snapshotId'], floors[variant])
            self.assertIsNotNone(self.db.fetchone('SELECT * FROM operation_receipts WHERE variant=? AND client_op_id=?', [variant, variant+'-receipt']))
            self.assertLess(abs(result['serverTime'] - time.time()*1000), 2000)

    def test_raw_restore_keeps_live_wal_and_other_thread_connections_coherent(self):
        source_path = os.path.join(self.temp.name, 'source.db')
        source = Database(source_path)
        import_from_bundle(source, bundle('raw-restored'), 'replace')
        source.close()
        with open(source_path, 'rb') as reader:
            raw = reader.read()
        self.assertEqual(self.post(raw, 'db', 'merge').status_code, 400)
        self.assert_original()
        ready, resumed = threading.Event(), threading.Event()
        observations = []
        def reader_thread():
            try:
                observations.append(self.db.fetchone('SELECT id FROM memos')[0])
                ready.set()
                resumed.wait(10)
                observations.append(self.db.fetchone('SELECT id FROM memos')[0])
            finally:
                self.db.close()
        worker = threading.Thread(target=reader_thread)
        worker.start()
        self.assertTrue(ready.wait(10))
        try:
            response = self.post(raw, 'db')
            self.assertEqual(response.status_code, 200, response.data)
            self.assertEqual(self.db.fetchone('SELECT id FROM memos')[0], 'raw-restored-memo')
        finally:
            resumed.set()
            worker.join(10)
        self.assertEqual(observations, ['original-memo', 'raw-restored-memo'])
        self.assertEqual(self.db.fetchone('PRAGMA quick_check')[0], 'ok')
        reopened = Database(os.path.join(self.temp.name, 'live.db'))
        try:
            self.assertEqual(reopened.fetchone('SELECT id FROM memos')[0], 'raw-restored-memo')
        finally:
            reopened.close()

    def test_unrelated_and_corrupt_raw_files_do_not_replace_live_database(self):
        for raw in (b'not sqlite', b'SQLite format 3\x00'+b'\x00'*4096):
            self.assertEqual(self.post(raw, 'db').status_code, 400)
            self.assert_original()


if __name__ == '__main__':
    unittest.main(verbosity=2)

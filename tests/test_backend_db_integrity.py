"""Backend SQLite startup integrity checks.

These checks use isolated temporary databases.  In particular, the corrupt
fixture must never be replaced with a newly initialized empty database.

Run:  python tests/test_backend_db_integrity.py
"""

import os
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch


sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

from backend_context import BackendContext
from services.db import Database, DatabaseIntegrityError


class BackendDatabaseIntegrityTests(unittest.TestCase):
    def test_corrupt_existing_database_fails_closed_and_is_preserved(self):
        with tempfile.TemporaryDirectory(prefix="memo_db_integrity_") as base:
            db_path = os.path.join(base, "memosystem.db")
            corrupt_bytes = (b"not-a-sqlite-database\x00MemoSystem\xff" * 64)
            with open(db_path, "wb") as handle:
                handle.write(corrupt_bytes)

            with self.assertRaises(DatabaseIntegrityError) as raised:
                Database(db_path)

            error = raised.exception
            self.assertIn("integrity check failed", str(error).lower())
            self.assertIn(os.path.abspath(db_path), str(error))
            self.assertIn("not replaced", str(error).lower())
            self.assertIn("-wal", str(error).lower())
            self.assertIn("backup", str(error).lower())
            with open(db_path, "rb") as handle:
                self.assertEqual(handle.read(), corrupt_bytes)
            self.assertFalse(os.path.exists(db_path + "-wal"))

    def test_backend_context_propagates_integrity_failure_without_json_fallback(self):
        with tempfile.TemporaryDirectory(prefix="memo_context_integrity_") as base:
            data_dir = os.path.join(base, "data")
            upload_dir = os.path.join(base, "uploads")
            os.makedirs(data_dir)
            db_path = os.path.join(data_dir, "memosystem.db")
            corrupt_bytes = b"corrupt-existing-primary" * 128
            with open(db_path, "wb") as handle:
                handle.write(corrupt_bytes)
            # A legacy JSON file must not make startup replace the bad primary
            # with an apparently healthy, newly imported database.
            with open(os.path.join(data_dir, "memos.json"), "w", encoding="utf-8") as handle:
                handle.write('[{"id":"legacy","description":"keep me"}]')

            with patch.dict(
                os.environ,
                {"MEMO_DATA_DIR": data_dir, "MEMO_UPLOAD_DIR": upload_dir},
            ):
                with self.assertRaises(DatabaseIntegrityError) as raised:
                    BackendContext(base_dir=base, use_server_backend=True)

            self.assertEqual(raised.exception.db_path, os.path.abspath(db_path))
            with open(db_path, "rb") as handle:
                self.assertEqual(handle.read(), corrupt_bytes)

    def test_valid_wal_database_opens_and_keeps_committed_rows(self):
        with tempfile.TemporaryDirectory(prefix="memo_db_wal_") as base:
            db_path = os.path.join(base, "memosystem.db")
            initial = Database(db_path)
            initial.close()

            writer = sqlite3.connect(db_path, isolation_level=None)
            reopened = None
            try:
                writer.execute("PRAGMA journal_mode=WAL")
                writer.execute("PRAGMA wal_autocheckpoint=0")
                writer.execute("BEGIN IMMEDIATE")
                writer.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                    ("wal-sentinel", "committed-in-wal"),
                )
                writer.execute("COMMIT")
                self.assertTrue(os.path.exists(db_path + "-wal"))
                self.assertGreater(os.path.getsize(db_path + "-wal"), 0)

                reopened = Database(db_path)
                row = reopened.fetchone(
                    "SELECT value FROM settings WHERE key = ?", ["wal-sentinel"]
                )
                self.assertIsNotNone(row)
                self.assertEqual(row[0], "committed-in-wal")
            finally:
                if reopened is not None:
                    reopened.close()
                writer.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)

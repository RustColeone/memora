"""
services/hashbook_store.py — SQLite-backed file deduplication store.

Drop-in replacement for UploadHashbookStore.  Exposes the same public
interface expected by UploadService and OcrDraftService:

  compute_filestorage_sha256(file_storage)
  compute_file_sha256_from_path(path)
  get_duplicate_record(file_storage) -> (is_dup, hash, rec_or_None)
  save_new_record(file_hash, stored_path)
  increment_count(file_hash, rec)
  decrement_or_remove_by_hash(file_hash, full_path) -> bool|None
  remove_records_by_path(image_url)
  get_hashbook() -> dict          # for export / compat shims
  save_hashbook(book)             # for import / compat shims
  _read_hashbook()                # compat shim for OcrDraftService
  _write_hashbook(book)           # compat shim for OcrDraftService
"""

import hashlib
import os
import time
from typing import Any, Dict, Optional, Tuple

from services.db import Database


class HashbookStore:
    def __init__(self, db: Database, base_dir: str):
        self._db = db
        self.base_dir = base_dir

    def _now_ms(self) -> int:
        return int(time.time() * 1000)

    # ------------------------------------------------------------------
    # Hash computation helpers (identical to UploadHashbookStore)
    # ------------------------------------------------------------------

    @staticmethod
    def compute_filestorage_sha256(file_storage, chunk_size: int = 1024 * 1024) -> str:
        h = hashlib.sha256()
        stream = file_storage.stream
        try:
            pos = stream.tell()
        except Exception:
            pos = None
        try:
            stream.seek(0)
        except Exception:
            pass
        while True:
            chunk = stream.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
        try:
            stream.seek(0 if pos is None else pos)
        except Exception:
            pass
        return h.hexdigest()

    @staticmethod
    def compute_file_sha256_from_path(path: str, chunk_size: int = 1024 * 1024) -> str:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            while True:
                chunk = f.read(chunk_size)
                if not chunk:
                    break
                h.update(chunk)
        return h.hexdigest()

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    def get_record(self, sha256: str) -> Optional[Dict]:
        row = self._db.fetchone("SELECT * FROM hashbook WHERE sha256=?", [sha256])
        if not row:
            return None
        return {"storedPath": row["stored_path"], "count": row["ref_count"]}

    def save_new_record(self, file_hash: str, stored_path: str):
        self._db.execute(
            "INSERT OR REPLACE INTO hashbook (sha256,stored_path,ref_count,created_at) VALUES (?,?,1,?)",
            [file_hash, stored_path, self._now_ms()],
        )

    def increment_count(self, file_hash: str, rec: Dict):
        self._db.execute(
            "UPDATE hashbook SET ref_count = ref_count + 1 WHERE sha256=?",
            [file_hash],
        )

    def decrement_or_remove_by_hash(self, file_hash: str, full_path: str) -> Optional[bool]:
        row = self._db.fetchone("SELECT ref_count FROM hashbook WHERE sha256=?", [file_hash])
        if not row:
            return None
        new_count = max(0, row["ref_count"] - 1)
        if new_count == 0:
            try:
                os.remove(full_path)
            except OSError:
                pass
            self._db.execute("DELETE FROM hashbook WHERE sha256=?", [file_hash])
            return True
        self._db.execute(
            "UPDATE hashbook SET ref_count=? WHERE sha256=?",
            [new_count, file_hash],
        )
        return False

    def remove_records_by_path(self, image_url: str):
        self._db.execute("DELETE FROM hashbook WHERE stored_path=?", [image_url])

    def get_duplicate_record(self, file_storage) -> Tuple[bool, str, Optional[Dict]]:
        file_hash = self.compute_filestorage_sha256(file_storage)
        row = self._db.fetchone("SELECT * FROM hashbook WHERE sha256=?", [file_hash])
        if row:
            existing_url = row["stored_path"]
            if existing_url:
                rel = os.path.normpath(existing_url.lstrip("/"))
                full_path = os.path.join(self.base_dir, rel)
                if os.path.isfile(full_path):
                    return True, file_hash, {"storedPath": existing_url, "count": row["ref_count"]}
            # stale record — clean up
            self._db.execute("DELETE FROM hashbook WHERE sha256=?", [file_hash])
        return False, file_hash, None

    # ------------------------------------------------------------------
    # Bulk helpers (used for migration / export)
    # ------------------------------------------------------------------

    def get_hashbook(self) -> Dict:
        rows = self._db.fetchall("SELECT * FROM hashbook")
        return {r["sha256"]: {"storedPath": r["stored_path"], "count": r["ref_count"]} for r in rows}

    def save_hashbook(self, book: Dict):
        """Replace entire hashbook. For import/migration use only."""
        self._db.execute("DELETE FROM hashbook")
        now = self._now_ms()
        rows = [
            (sha, info.get("storedPath", ""), int(info.get("count", 1)), now)
            for sha, info in book.items()
        ]
        if rows:
            self._db.executemany(
                "INSERT INTO hashbook (sha256,stored_path,ref_count,created_at) VALUES (?,?,?,?)",
                rows,
            )

    # ------------------------------------------------------------------
    # Compat shims for OcrDraftService
    # ------------------------------------------------------------------

    def _read_hashbook(self) -> Dict:
        return self.get_hashbook()

    def _write_hashbook(self, book: Dict):
        self.save_hashbook(book)

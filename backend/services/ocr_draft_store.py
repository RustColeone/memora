"""
services/ocr_draft_store.py — SQLite-backed OCR draft store.

Drop-in replacement for OcrDraftService.  Same public API:

  create_draft(memo_id, variant, temp_bin)              -> dict
  get_draft(draft_id)                                   -> Optional[dict]
  get_draft_for_memo(memo_id, variant)                  -> Optional[dict]
  update_draft_status(draft_id, status, proposed, error)-> Optional[dict]
  add_to_temp_bin(draft_id, file_url)                   -> Optional[dict]
  clear_draft(draft_id)                                 -> bool
  clear_drafts_for_memo(memo_id, variant)               -> int
  purge_old_drafts(max_age_hours)                       -> None
"""

import json
import time
import uuid
from typing import Any, Dict, List, Optional

from services.db import Database


def _j(obj) -> Optional[str]:
    if obj is None:
        return None
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _p(text) -> Any:
    if text is None:
        return None
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None


class OcrDraftStore:
    """Stores OCR analysis drafts in the `ocr_drafts` SQLite table."""

    def __init__(self, db: Database):
        self._db = db

    def _now_ms(self) -> int:
        return int(time.time() * 1000)

    def _row_to_dict(self, r) -> Dict[str, Any]:
        return {
            "draftId": r["draft_id"],
            "memoId": r["memo_id"],
            "variant": r["variant"],
            "status": r["status"],
            "createdAt": r["created_at"],
            "updatedAt": r["updated_at"],
            "tempBin": _p(r["temp_bin"]) or [],
            "proposed": _p(r["proposed"]),
            "error": r["error"],
        }

    def create_draft(self, memo_id: Optional[str], variant: str, temp_bin: List[str]) -> Dict[str, Any]:
        draft_id = str(uuid.uuid4())
        now = self._now_ms()
        self._db.execute(
            """
            INSERT INTO ocr_drafts
                (draft_id,memo_id,variant,status,temp_bin,proposed,error,created_at,updated_at)
            VALUES (?,?,?,'pending',?,NULL,NULL,?,?)
            """,
            [draft_id, memo_id, variant, _j(temp_bin or []), now, now],
        )
        return self.get_draft(draft_id)

    def get_draft(self, draft_id: str) -> Optional[Dict[str, Any]]:
        row = self._db.fetchone("SELECT * FROM ocr_drafts WHERE draft_id=?", [draft_id])
        return self._row_to_dict(row) if row else None

    def get_draft_for_memo(self, memo_id: Optional[str], variant: str) -> Optional[Dict[str, Any]]:
        rows = self._db.fetchall(
            "SELECT * FROM ocr_drafts WHERE variant=? AND memo_id IS ? ORDER BY updated_at DESC",
            [variant, memo_id],
        )
        return self._row_to_dict(rows[0]) if rows else None

    def update_draft_status(
        self,
        draft_id: str,
        status: str,
        proposed: Optional[Dict] = None,
        error: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        row = self._db.fetchone("SELECT * FROM ocr_drafts WHERE draft_id=?", [draft_id])
        if not row:
            return None
        now = self._now_ms()
        new_proposed = _j(proposed) if proposed is not None else row["proposed"]
        new_error = error if error is not None else row["error"]
        self._db.execute(
            "UPDATE ocr_drafts SET status=?, proposed=?, error=?, updated_at=? WHERE draft_id=?",
            [status, new_proposed, new_error, now, draft_id],
        )
        return self.get_draft(draft_id)

    def add_to_temp_bin(self, draft_id: str, file_url: str) -> Optional[Dict[str, Any]]:
        row = self._db.fetchone("SELECT * FROM ocr_drafts WHERE draft_id=?", [draft_id])
        if not row:
            return None
        temp_bin = _p(row["temp_bin"]) or []
        if file_url not in temp_bin:
            temp_bin.append(file_url)
        self._db.execute(
            "UPDATE ocr_drafts SET temp_bin=?, updated_at=? WHERE draft_id=?",
            [_j(temp_bin), self._now_ms(), draft_id],
        )
        return self.get_draft(draft_id)

    def clear_draft(self, draft_id: str) -> bool:
        row = self._db.fetchone("SELECT draft_id FROM ocr_drafts WHERE draft_id=?", [draft_id])
        if not row:
            return False
        self._db.execute("DELETE FROM ocr_drafts WHERE draft_id=?", [draft_id])
        return True

    def clear_drafts_for_memo(self, memo_id: Optional[str], variant: str) -> int:
        rows = self._db.fetchall(
            "SELECT draft_id FROM ocr_drafts WHERE variant=? AND memo_id IS ?",
            [variant, memo_id],
        )
        count = len(rows)
        if count:
            self._db.execute(
                "DELETE FROM ocr_drafts WHERE variant=? AND memo_id IS ?",
                [variant, memo_id],
            )
        return count

    def purge_old_drafts(self, max_age_hours: int = 48):
        cutoff = self._now_ms() - max_age_hours * 3600 * 1000
        self._db.execute("DELETE FROM ocr_drafts WHERE updated_at < ?", [cutoff])

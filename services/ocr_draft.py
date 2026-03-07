"""
OCR Draft Service
Manages temporary OCR processing bins and drafts in hashbook.json under a dedicated 'ocr_drafts' key.
"""

import uuid
import time
from datetime import datetime
from typing import Dict, Any, Optional, List


class OcrDraftService:
    """
    Stores OCR analysis drafts in the hashbook JSON file under the 'ocr_drafts' key.
    
    Draft structure:
    {
      "ocr_drafts": {
        "<draft_id>": {
          "draftId": "...",
          "memoId": "..." | null,          # null = new entry draft
          "variant": "default" | "finance",
          "status": "pending" | "processing" | "done" | "error",
          "createdAt": <epoch_ms>,
          "updatedAt": <epoch_ms>,
          "tempBin": ["/uploads/..."],      # uploaded file URLs being processed
          "proposed": { ... },              # LLM-proposed fields
          "error": "..." | null
        }
      }
    }
    """

    DRAFTS_KEY = 'ocr_drafts'

    def __init__(self, lock, read_hashbook, write_hashbook):
        self._lock = lock
        self._read_hashbook = read_hashbook
        self._write_hashbook = write_hashbook

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _load_drafts(self) -> Dict[str, Any]:
        """Read drafts dict from hashbook. Must be called while holding self._lock."""
        book = self._read_hashbook()
        return book.get(self.DRAFTS_KEY) or {}

    def _save_drafts(self, drafts: Dict[str, Any]):
        """Persist drafts dict to hashbook. Must be called while holding self._lock."""
        book = self._read_hashbook()
        book[self.DRAFTS_KEY] = drafts
        self._write_hashbook(book)

    def _now_ms(self) -> int:
        return int(time.time() * 1000)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def create_draft(self, memo_id: Optional[str], variant: str, temp_bin: List[str]) -> Dict[str, Any]:
        """Create a new OCR draft record."""
        draft_id = str(uuid.uuid4())
        now = self._now_ms()
        draft = {
            'draftId': draft_id,
            'memoId': memo_id,
            'variant': variant,
            'status': 'pending',
            'createdAt': now,
            'updatedAt': now,
            'tempBin': temp_bin or [],
            'proposed': None,
            'error': None,
        }
        with self._lock:
            drafts = self._load_drafts()
            drafts[draft_id] = draft
            self._save_drafts(drafts)
        return draft

    def get_draft(self, draft_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            drafts = self._load_drafts()
        return drafts.get(draft_id)

    def get_draft_for_memo(self, memo_id: Optional[str], variant: str) -> Optional[Dict[str, Any]]:
        """
        Return the most recent non-cleared draft for a given memoId + variant.
        For new entries memoId should be None / the string 'null'.
        """
        with self._lock:
            drafts = self._load_drafts()
        candidates = [
            d for d in drafts.values()
            if d.get('variant') == variant and str(d.get('memoId') or '') == str(memo_id or '')
        ]
        if not candidates:
            return None
        # Most recently updated
        return max(candidates, key=lambda d: d.get('updatedAt', 0))

    def update_draft_status(self, draft_id: str, status: str,
                             proposed: Optional[Dict] = None,
                             error: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Update status (and optionally proposed data) of an existing draft."""
        with self._lock:
            drafts = self._load_drafts()
            draft = drafts.get(draft_id)
            if not draft:
                return None
            draft['status'] = status
            draft['updatedAt'] = self._now_ms()
            if proposed is not None:
                draft['proposed'] = proposed
            if error is not None:
                draft['error'] = error
            drafts[draft_id] = draft
            self._save_drafts(drafts)
            return draft

    def add_to_temp_bin(self, draft_id: str, file_url: str) -> Optional[Dict[str, Any]]:
        """Add a file URL to the draft's tempBin."""
        with self._lock:
            drafts = self._load_drafts()
            draft = drafts.get(draft_id)
            if not draft:
                return None
            if file_url not in draft['tempBin']:
                draft['tempBin'].append(file_url)
            draft['updatedAt'] = self._now_ms()
            drafts[draft_id] = draft
            self._save_drafts(drafts)
            return draft

    def clear_draft(self, draft_id: str) -> bool:
        """Remove a draft by ID."""
        with self._lock:
            drafts = self._load_drafts()
            if draft_id not in drafts:
                return False
            del drafts[draft_id]
            self._save_drafts(drafts)
            return True

    def clear_drafts_for_memo(self, memo_id: Optional[str], variant: str) -> int:
        """Remove all drafts for a given memo + variant. Returns count removed."""
        with self._lock:
            drafts = self._load_drafts()
            to_remove = [
                k for k, d in drafts.items()
                if d.get('variant') == variant and str(d.get('memoId') or '') == str(memo_id or '')
            ]
            for k in to_remove:
                del drafts[k]
            self._save_drafts(drafts)
            return len(to_remove)

    def purge_old_drafts(self, max_age_hours: int = 48):
        """Remove drafts older than max_age_hours (housekeeping)."""
        cutoff = self._now_ms() - max_age_hours * 3600 * 1000
        with self._lock:
            drafts = self._load_drafts()
            to_remove = [k for k, d in drafts.items() if d.get('updatedAt', 0) < cutoff]
            for k in to_remove:
                del drafts[k]
            if to_remove:
                self._save_drafts(drafts)
            return len(to_remove)

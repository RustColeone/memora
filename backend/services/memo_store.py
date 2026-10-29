"""
services/memo_store.py — SQLite CRUD for memos and finance_entries tables.

Provides a variant-agnostic interface matching backend_context.py conventions:
  store.get_all(variant)           → List[dict]
  store.save_all(entries, variant) → None (replace-all; preserves row order)
  store.upsert(entry, variant)     → dict
  store.get_one(entry_id, variant) → Optional[dict]
  store.update_fields(entry_id, fields, variant) → Optional[dict]
  store.soft_delete(entry_id, variant) → Optional[dict]
  store.hard_delete(entry_id, variant) → None
  store.restore(entry_id, variant) → Optional[dict]
"""

import json
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from services.db import Database


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _iso_to_ms(iso: Optional[str]) -> Optional[int]:
    if not iso:
        return None
    try:
        return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)
    except (ValueError, AttributeError):
        return None


def _ms_to_iso(ms: Optional[int]) -> Optional[str]:
    if ms is None:
        return None
    try:
        return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"
    except (OSError, OverflowError, ValueError):
        return None


def _now_ms() -> int:
    return int(time.time() * 1000)


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


def _j(obj) -> Optional[str]:
    if obj is None:
        return None
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _p(text: Optional[str]) -> Any:
    if text is None:
        return None
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None


def _real(v) -> float:
    if v is None:
        return 0.0
    try:
        return float(v)
    except (ValueError, TypeError):
        return 0.0


# A purchase's optional details (store, how it was paid, notes) share one
# JSON column, so a later field needs no new column.
FINANCE_DETAIL_KEYS = ("store", "paidWith", "notes")


def _details_json(entry: Dict) -> Optional[str]:
    out = {k: str(entry.get(k)).strip() for k in FINANCE_DETAIL_KEYS if entry.get(k) not in (None, "")}
    out = {k: v for k, v in out.items() if v}
    return json.dumps(out, ensure_ascii=False) if out else None


def _finance_details(r) -> Dict:
    raw = r["details"] if "details" in r.keys() else None
    try:
        data = json.loads(raw) if raw else {}
    except (ValueError, TypeError):
        data = {}
    return {k: str(data[k]) for k in FINANCE_DETAIL_KEYS if isinstance(data, dict) and data.get(k)}


def _tax(v):
    """Tax is a rate ("8.25%") or an amount; keep a rate as typed."""
    if isinstance(v, str) and v.strip().endswith("%"):
        return v.strip()
    return _real(v)


def _generate_id() -> str:
    return str(uuid.uuid4())


# ---------------------------------------------------------------------------
# MemoStore
# ---------------------------------------------------------------------------

class MemoStore:
    """SQLite-backed store for memos (default) and finance_entries (finance)."""

    def __init__(self, db: Database):
        self._db = db

    # ------------------------------------------------------------------
    # Row serialisation
    # ------------------------------------------------------------------

    def _row_to_memo(self, r) -> Dict:
        deleted_at_ms = r["deleted_at"] if r["deleted"] else None
        perm_delete_ms = (r["deleted_at"] + 30 * 24 * 3600 * 1000) if r["deleted"] and r["deleted_at"] else None
        memo = {
            "id": r["id"],
            "description": r["description"] or "",
            "category": r["category"] or "",
            "tags": _p(r["tags"]) or [],
            "images": _p(r["images"]) or [],
            "attachments": _p(r["attachments"]) or [],
            "imageMeta": (_p(r["image_meta"]) if "image_meta" in r.keys() else None) or {},
            "ts": r["created_at"],
            "createdAt": _ms_to_iso(r["created_at"]),
            "updatedAt": _ms_to_iso(r["updated_at"]),
            "deletedAt": _ms_to_iso(deleted_at_ms),
            "deletedBy": "server" if r["deleted"] else None,
            "permanentDeleteAt": _ms_to_iso(perm_delete_ms),
        }
        if "safe" in r.keys() and r["safe"]:
            memo["safe"] = True
        return memo

    def _row_to_finance(self, r) -> Dict:
        deleted_at_ms = r["deleted_at"] if r["deleted"] else None
        return {
            "id": r["id"],
            "description": r["description"] or "",
            "category": r["category"] or "",
            "tags": _p(r["tags"]) or [],
            "images": _p(r["images"]) or [],
            "attachments": _p(r["attachments"]) or [],
            "imageMeta": (_p(r["image_meta"]) if "image_meta" in r.keys() else None) or {},
            "purchaseDate": r["purchase_date"] or "",
            "sheet": (r["sheet"] if "sheet" in r.keys() else None) or "General",
            "price": r["price"],
            "tax": r["tax"],
            "adjustment": r["adjustment"],
            "total": r["total"],
            "items": _p(r["items"]),
            **_finance_details(r),
            "ts": r["created_at"],
            "createdAt": _ms_to_iso(r["created_at"]),
            "updatedAt": _ms_to_iso(r["updated_at"]),
            "deletedAt": _ms_to_iso(deleted_at_ms),
            "deletedBy": "server" if r["deleted"] else None,
        }

    # ------------------------------------------------------------------
    # Default variant (memos)
    # ------------------------------------------------------------------

    def get_memos(self) -> List[Dict]:
        rows = self._db.fetchall("SELECT * FROM memos ORDER BY created_at")
        return [self._row_to_memo(r) for r in rows]

    def get_memo(self, memo_id: str) -> Optional[Dict]:
        r = self._db.fetchone("SELECT * FROM memos WHERE id=?", [memo_id])
        return self._row_to_memo(r) if r else None

    def upsert_memo(self, entry: Dict) -> Dict:
        now = _now_ms()
        memo_id = entry.get("id") or _generate_id()
        created_at = _iso_to_ms(entry.get("createdAt")) or now
        updated_at = _iso_to_ms(entry.get("updatedAt")) or now
        deleted_at = _iso_to_ms(entry.get("deletedAt"))
        deleted = 1 if deleted_at else 0
        self._db.execute(
            """
            INSERT INTO memos (id,description,category,tags,images,attachments,image_meta,
                created_at,updated_at,deleted,deleted_at,safe)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
                safe=excluded.safe,
                description=excluded.description,
                category=excluded.category,
                tags=excluded.tags,
                images=excluded.images,
                attachments=excluded.attachments,
                image_meta=excluded.image_meta,
                updated_at=excluded.updated_at,
                deleted=excluded.deleted,
                deleted_at=excluded.deleted_at
            """,
            [
                memo_id,
                entry.get("description", ""),
                entry.get("category", ""),
                _j(entry.get("tags", [])),
                _j(entry.get("images", [])),
                _j(entry.get("attachments", [])),
                _j(entry.get("imageMeta", {})),
                created_at,
                updated_at,
                deleted,
                deleted_at,
                1 if entry.get("safe") else 0,
            ],
        )
        return self.get_memo(memo_id)

    def update_memo_fields(self, memo_id: str, fields: Dict) -> Optional[Dict]:
        existing = self.get_memo(memo_id)
        if not existing:
            return None
        merged = {**existing, **fields, "id": memo_id, "updatedAt": _now_iso()}
        return self.upsert_memo(merged)

    def soft_delete_memo(self, memo_id: str) -> Optional[Dict]:
        now = _now_ms()
        self._db.execute(
            "UPDATE memos SET deleted=1, deleted_at=?, updated_at=? WHERE id=?",
            [now, now, memo_id],
        )
        return self.get_memo(memo_id)

    def hard_delete_memo(self, memo_id: str):
        self._db.execute("DELETE FROM memos WHERE id=?", [memo_id])

    def restore_memo(self, memo_id: str) -> Optional[Dict]:
        now = _now_ms()
        self._db.execute(
            "UPDATE memos SET deleted=0, deleted_at=NULL, updated_at=? WHERE id=?",
            [now, memo_id],
        )
        return self.get_memo(memo_id)

    # ------------------------------------------------------------------
    # Finance variant (finance_entries)
    # ------------------------------------------------------------------

    def get_finance_entries(self) -> List[Dict]:
        rows = self._db.fetchall("SELECT * FROM finance_entries ORDER BY created_at")
        return [self._row_to_finance(r) for r in rows]

    def get_finance_entry(self, entry_id: str) -> Optional[Dict]:
        r = self._db.fetchone("SELECT * FROM finance_entries WHERE id=?", [entry_id])
        return self._row_to_finance(r) if r else None

    def upsert_finance_entry(self, entry: Dict) -> Dict:
        now = _now_ms()
        entry_id = entry.get("id") or _generate_id()
        created_at = _iso_to_ms(entry.get("createdAt")) or now
        updated_at = _iso_to_ms(entry.get("updatedAt")) or now
        deleted_at = _iso_to_ms(entry.get("deletedAt"))
        deleted = 1 if deleted_at else 0
        self._db.execute(
            """
            INSERT INTO finance_entries (id,description,category,tags,images,attachments,image_meta,
                purchase_date,sheet,price,tax,adjustment,total,items,
                created_at,updated_at,deleted,deleted_at,details)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
                description=excluded.description,
                category=excluded.category,
                tags=excluded.tags,
                images=excluded.images,
                attachments=excluded.attachments,
                image_meta=excluded.image_meta,
                purchase_date=excluded.purchase_date,
                sheet=excluded.sheet,
                price=excluded.price,
                tax=excluded.tax,
                adjustment=excluded.adjustment,
                total=excluded.total,
                items=excluded.items,
                details=excluded.details,
                updated_at=excluded.updated_at,
                deleted=excluded.deleted,
                deleted_at=excluded.deleted_at
            """,
            [
                entry_id,
                entry.get("description", ""),
                entry.get("category", ""),
                _j(entry.get("tags", [])),
                _j(entry.get("images", [])),
                _j(entry.get("attachments", [])),
                _j(entry.get("imageMeta", {})),
                entry.get("purchaseDate", ""),
                entry.get("sheet") or "General",
                _real(entry.get("price")),
                _tax(entry.get("tax")),
                _real(entry.get("adjustment")),
                _real(entry.get("total")),
                _j(entry.get("items")),
                created_at,
                updated_at,
                deleted,
                deleted_at,
                _details_json(entry),
            ],
        )
        return self.get_finance_entry(entry_id)

    def update_finance_fields(self, entry_id: str, fields: Dict) -> Optional[Dict]:
        existing = self.get_finance_entry(entry_id)
        if not existing:
            return None
        merged = {**existing, **fields, "id": entry_id, "updatedAt": _now_iso()}
        return self.upsert_finance_entry(merged)

    def soft_delete_finance(self, entry_id: str) -> Optional[Dict]:
        now = _now_ms()
        self._db.execute(
            "UPDATE finance_entries SET deleted=1, deleted_at=?, updated_at=? WHERE id=?",
            [now, now, entry_id],
        )
        return self.get_finance_entry(entry_id)

    def hard_delete_finance(self, entry_id: str):
        self._db.execute("DELETE FROM finance_entries WHERE id=?", [entry_id])

    def restore_finance(self, entry_id: str) -> Optional[Dict]:
        now = _now_ms()
        self._db.execute(
            "UPDATE finance_entries SET deleted=0, deleted_at=NULL, updated_at=? WHERE id=?",
            [now, entry_id],
        )
        return self.get_finance_entry(entry_id)

    # ------------------------------------------------------------------
    # Variant-agnostic interface
    # ------------------------------------------------------------------

    def get_all(self, variant: str) -> List[Dict]:
        if variant == "finance":
            return self.get_finance_entries()
        return self.get_memos()

    def get_one(self, entry_id: str, variant: str) -> Optional[Dict]:
        if variant == "finance":
            return self.get_finance_entry(entry_id)
        return self.get_memo(entry_id)

    def upsert(self, entry: Dict, variant: str) -> Dict:
        if variant == "finance":
            return self.upsert_finance_entry(entry)
        return self.upsert_memo(entry)

    def update_fields(self, entry_id: str, fields: Dict, variant: str) -> Optional[Dict]:
        if variant == "finance":
            return self.update_finance_fields(entry_id, fields)
        return self.update_memo_fields(entry_id, fields)

    def soft_delete(self, entry_id: str, variant: str) -> Optional[Dict]:
        if variant == "finance":
            return self.soft_delete_finance(entry_id)
        return self.soft_delete_memo(entry_id)

    def hard_delete(self, entry_id: str, variant: str):
        if variant == "finance":
            self.hard_delete_finance(entry_id)
        else:
            self.hard_delete_memo(entry_id)

    def restore(self, entry_id: str, variant: str) -> Optional[Dict]:
        if variant == "finance":
            return self.restore_finance(entry_id)
        return self.restore_memo(entry_id)

    def save_all(self, entries: List[Dict], variant: str):
        """Replace-all upsert: adds/updates entries in the list, hard-deletes
        rows that no longer appear (used by MemosService which mutates + saves
        the entire list).
        """
        incoming_ids = {e["id"] for e in entries if e.get("id")}
        if variant == "finance":
            existing_ids = {r["id"] for r in self._db.fetchall("SELECT id FROM finance_entries")}
            for removed_id in existing_ids - incoming_ids:
                self.hard_delete_finance(removed_id)
            for entry in entries:
                self.upsert_finance_entry(entry)
        else:
            existing_ids = {r["id"] for r in self._db.fetchall("SELECT id FROM memos")}
            for removed_id in existing_ids - incoming_ids:
                self.hard_delete_memo(removed_id)
            for entry in entries:
                self.upsert_memo(entry)

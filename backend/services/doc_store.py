"""
services/doc_store.py — generic JSON-document SQLite store.

Unlike MemoStore (fixed memo/finance columns), this stores an entry of *any*
shape: the whole object lives in a JSON `data` column, with a `kind`
discriminator pulled out for querying. It is used for the Planner variant,
whose entries (events / todos / projects / habits) don't fit the memo schema.

It exposes the same variant-agnostic interface MemoStore does
(get_all / get_one / upsert / update_fields / soft_delete / hard_delete /
restore / save_all), so backend_context can dispatch to either store by
variant without special-casing call sites. The `variant` argument is accepted
for interface parity but ignored — the table itself is the partition.
"""

import json
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from services.db import Database

# Keys that map to dedicated columns / are reconstructed on read — everything
# else in an entry is preserved inside the JSON `data` blob.
_RESERVED = ("id", "kind", "createdAt", "updatedAt", "deletedAt", "deletedBy", "permanentDeleteAt", "ts")


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


class DocStore:
    """SQLite-backed generic document store for one table (one variant)."""

    def __init__(self, db: Database, table: str):
        self._db = db
        # table is an internal constant (not user input) — safe to interpolate.
        self._table = table

    # ------------------------------------------------------------------
    # Row <-> entry mapping
    # ------------------------------------------------------------------

    def _row_to_entry(self, r) -> Dict:
        data = _p(r["data"]) or {}
        deleted_at_ms = r["deleted_at"] if r["deleted"] else None
        perm_delete_ms = (r["deleted_at"] + 30 * 24 * 3600 * 1000) if r["deleted"] and r["deleted_at"] else None
        entry = dict(data)
        entry.update({
            "id": r["id"],
            "kind": r["kind"],
            "ts": r["created_at"],
            "createdAt": _ms_to_iso(r["created_at"]),
            "updatedAt": _ms_to_iso(r["updated_at"]),
            "deletedAt": _ms_to_iso(deleted_at_ms),
            "deletedBy": "server" if r["deleted"] else None,
            "permanentDeleteAt": _ms_to_iso(perm_delete_ms),
        })
        return entry

    # ------------------------------------------------------------------
    # Variant-agnostic interface (variant arg ignored — table is the partition)
    # ------------------------------------------------------------------

    def get_all(self, variant: str = None) -> List[Dict]:
        rows = self._db.fetchall(f"SELECT * FROM {self._table} ORDER BY created_at")
        return [self._row_to_entry(r) for r in rows]

    def get_one(self, entry_id: str, variant: str = None) -> Optional[Dict]:
        r = self._db.fetchone(f"SELECT * FROM {self._table} WHERE id=?", [entry_id])
        return self._row_to_entry(r) if r else None

    def upsert(self, entry: Dict, variant: str = None) -> Dict:
        now = _now_ms()
        entry_id = entry.get("id") or str(uuid.uuid4())
        created_at = _iso_to_ms(entry.get("createdAt")) or now
        updated_at = _iso_to_ms(entry.get("updatedAt")) or now
        deleted_at = _iso_to_ms(entry.get("deletedAt"))
        deleted = 1 if deleted_at else 0
        data = {k: v for k, v in entry.items() if k not in _RESERVED}
        self._db.execute(
            f"""
            INSERT INTO {self._table} (id,kind,data,created_at,updated_at,deleted,deleted_at)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
                kind=excluded.kind,
                data=excluded.data,
                updated_at=excluded.updated_at,
                deleted=excluded.deleted,
                deleted_at=excluded.deleted_at
            """,
            [entry_id, entry.get("kind"), _j(data), created_at, updated_at, deleted, deleted_at],
        )
        return self.get_one(entry_id)

    def update_fields(self, entry_id: str, fields: Dict, variant: str = None) -> Optional[Dict]:
        existing = self.get_one(entry_id)
        if not existing:
            return None
        merged = {**existing, **fields, "id": entry_id, "updatedAt": _now_iso()}
        return self.upsert(merged)

    def soft_delete(self, entry_id: str, variant: str = None) -> Optional[Dict]:
        now = _now_ms()
        self._db.execute(
            f"UPDATE {self._table} SET deleted=1, deleted_at=?, updated_at=? WHERE id=?",
            [now, now, entry_id],
        )
        return self.get_one(entry_id)

    def hard_delete(self, entry_id: str, variant: str = None):
        self._db.execute(f"DELETE FROM {self._table} WHERE id=?", [entry_id])

    def restore(self, entry_id: str, variant: str = None) -> Optional[Dict]:
        now = _now_ms()
        self._db.execute(
            f"UPDATE {self._table} SET deleted=0, deleted_at=NULL, updated_at=? WHERE id=?",
            [now, entry_id],
        )
        return self.get_one(entry_id)

    def save_all(self, entries: List[Dict], variant: str = None):
        """Replace-all upsert: upsert everything in *entries*, hard-delete rows
        that no longer appear."""
        incoming_ids = {e["id"] for e in entries if e.get("id")}
        existing_ids = {r["id"] for r in self._db.fetchall(f"SELECT id FROM {self._table}")}
        for removed_id in existing_ids - incoming_ids:
            self.hard_delete(removed_id)
        for entry in entries:
            self.upsert(entry)

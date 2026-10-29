"""
services/operations_store.py — SQLite-backed operations & snapshot store.

Operations live one-row-per-op in the `operations` table with a per-variant
monotonic `op_id`.  Snapshots (the periodically-compacted materialised state)
live one-row-per-variant in the `snapshots` table.

This is the single source of truth for the sync log — there is no JSON-blob
representation anywhere.  `OperationsService` depends on this store directly.

Wire format: an "operation" is the dict the sync API exchanges with clients:
    {
        "opId":       int,          # assigned by the server, monotonic per variant
        "type":       str,          # create | update | delete | addImage | addAttachment
        "entryId":    str,
        "timestamp":  int,          # epoch ms
        "deviceId":   str | None,
        "clientOpId": str | None,
        "data":       Any | None,
        "field":      str | None,
        "value":      Any | None,
        "url":        str | None,
        "attachment": Any | None,
    }

The indexed fields (op_id/type/entry_id/timestamp/device_id/client_op_id) are
stored as columns; the remaining variable fields (data/field/value/url/
attachment) are stored together as a compact JSON `payload`.
"""

import json
import time
from typing import Any, Dict, List, Optional

from services.db import Database


# Fields kept inside the JSON payload column (everything that isn't indexed).
_PAYLOAD_FIELDS = ("data", "field", "value", "url", "attachment")


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


class OperationsStore:
    def __init__(self, db: Database):
        self._db = db

    # ------------------------------------------------------------------
    # Row <-> operation-dict mapping
    # ------------------------------------------------------------------

    def _row_to_op(self, r) -> Dict[str, Any]:
        payload = _p(r["payload"]) or {}
        op = {
            "opId": r["op_id"],
            "type": r["type"],
            "entryId": r["entry_id"],
            "timestamp": r["timestamp"],
            "deviceId": r["device_id"],
            "clientOpId": r["client_op_id"],
        }
        for field in _PAYLOAD_FIELDS:
            op[field] = payload.get(field)
        return op

    def _op_to_columns(self, op: Dict[str, Any], variant: str, op_id: int) -> List[Any]:
        payload = {f: op[f] for f in _PAYLOAD_FIELDS if op.get(f) is not None}
        return [
            variant,
            op_id,
            op.get("type"),
            op.get("entryId"),
            int(op.get("timestamp") or 0),
            op.get("deviceId"),
            op.get("clientOpId"),
            _j(payload) if payload else None,
        ]

    # ------------------------------------------------------------------
    # Operations
    # ------------------------------------------------------------------

    def get_operations(self, variant: str) -> List[Dict[str, Any]]:
        rows = self._db.fetchall(
            "SELECT * FROM operations WHERE variant=? ORDER BY op_id",
            [variant],
        )
        return [self._row_to_op(r) for r in rows]

    def get_operations_since(self, since_op_id: int, variant: str, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        sql = "SELECT * FROM operations WHERE variant=? AND op_id > ? ORDER BY op_id"
        params: List[Any] = [variant, since_op_id]
        if limit:
            sql += " LIMIT ?"
            params.append(int(limit))
        rows = self._db.fetchall(sql, params)
        return [self._row_to_op(r) for r in rows]

    def max_op_id(self, variant: str) -> int:
        row = self._db.fetchone(
            "SELECT MAX(op_id) AS m FROM operations WHERE variant=?", [variant]
        )
        return row["m"] if row and row["m"] is not None else 0

    def find_by_client_op_id(self, client_op_id: str, variant: str) -> Optional[Dict[str, Any]]:
        if not client_op_id:
            return None
        receipt = self._db.fetchone(
            "SELECT op_id FROM operation_receipts WHERE variant=? AND client_op_id=?",
            [variant, client_op_id],
        )
        if receipt:
            return {'opId': receipt['op_id'], 'clientOpId': client_op_id}
        row = self._db.fetchone(
            "SELECT * FROM operations WHERE variant=? AND client_op_id=? LIMIT 1",
            [variant, client_op_id],
        )
        return self._row_to_op(row) if row else None

    def append_operation(self, op: Dict[str, Any], variant: str) -> int:
        """Assign the next op_id for *variant*, insert the op, return the op_id.

        Defaults a missing timestamp to now (epoch ms).  Assignment + insert
        happen under the database lock so concurrent appends can't collide on
        the same op_id.

        The next id advances past BOTH the highest existing op and the current
        snapshotId. Without the snapshot floor, a fully-compacted log (0 rows
        left) would restart at op_id 1 — below snapshotId — so pull's
        `op_id > snapshotId` filter would never surface the new op and clients
        would silently miss every post-snapshot change.
        """
        op.setdefault("timestamp", int(time.time() * 1000))
        with self._db.conn() as con:
            row = con.execute(
                "SELECT MAX(op_id) FROM operations WHERE variant=?", [variant]
            ).fetchone()
            srow = con.execute(
                "SELECT snapshot_id FROM snapshots WHERE variant=?", [variant]
            ).fetchone()
            max_op = row[0] or 0
            snap_id = (srow[0] if srow and srow[0] is not None else 0)
            next_id = max(max_op, snap_id) + 1
            con.execute(
                "INSERT INTO operations "
                "(variant, op_id, type, entry_id, timestamp, device_id, client_op_id, payload) "
                "VALUES (?,?,?,?,?,?,?,?)",
                self._op_to_columns(op, variant, next_id),
            )
            if op.get('clientOpId'):
                con.execute(
                    "INSERT OR IGNORE INTO operation_receipts VALUES (?,?,?)",
                    [variant, op['clientOpId'], next_id],
                )
        op["opId"] = next_id
        return next_id

    def replace_operations(self, operations: List[Dict[str, Any]], variant: str):
        """Replace the entire operations log for *variant* (used by compaction).

        Preserves each op's existing opId so op ids remain stable for clients.
        """
        with self._db.conn() as con:
            con.execute("DELETE FROM operations WHERE variant=?", [variant])
            for op in operations:
                op_id = op.get("opId")
                if op_id is None:
                    continue
                con.execute(
                    "INSERT INTO operations "
                    "(variant, op_id, type, entry_id, timestamp, device_id, client_op_id, payload) "
                    "VALUES (?,?,?,?,?,?,?,?)",
                    self._op_to_columns(op, variant, int(op_id)),
                )
                if op.get('clientOpId'):
                    con.execute("INSERT OR IGNORE INTO operation_receipts VALUES (?,?,?)",
                                [variant, op['clientOpId'], int(op_id)])

    # ------------------------------------------------------------------
    # Snapshots
    # ------------------------------------------------------------------

    def get_snapshot(self, variant: str) -> Dict[str, Any]:
        row = self._db.fetchone(
            "SELECT * FROM snapshots WHERE variant=?", [variant]
        )
        if not row:
            return {"snapshotId": 0, "timestamp": 0, "entries": []}
        return {
            "snapshotId": row["snapshot_id"],
            "timestamp": row["timestamp"],
            "entries": _p(row["entries"]) or [],
        }

    def get_snapshot_id(self, variant: str) -> int:
        row = self._db.fetchone("SELECT snapshot_id FROM snapshots WHERE variant=?", [variant])
        return (row["snapshot_id"] if row and row["snapshot_id"] is not None else 0)

    # A device pages through the snapshot with many requests in a row. The
    # entries are split into JSON strings once per snapshot (one json_each
    # pass in SQLite) and kept briefly, so each page is a cheap slice instead
    # of re-reading the whole snapshot.
    _PAGE_CACHE_SECONDS = 120

    def get_snapshot_page(self, variant: str, offset: int, limit: int) -> Dict[str, Any]:
        meta = self._db.fetchone(
            "SELECT snapshot_id, timestamp FROM snapshots WHERE variant=?", [variant])
        if not meta:
            return {"snapshotId": 0, "timestamp": 0, "total": 0, "entries": []}
        key = (variant, meta["snapshot_id"], meta["timestamp"])
        cache = getattr(self, "_page_cache", None)
        now = time.monotonic()
        if not cache or cache[0] != key or now - cache[2] > self._PAGE_CACHE_SECONDS:
            rows = self._db.fetchall(
                "SELECT j.value AS v FROM snapshots s, json_each(s.entries) j "
                "WHERE s.variant=? ORDER BY j.key", [variant])
            cache = (key, [r["v"] for r in rows], now)
        values = cache[1]
        self._page_cache = (key, values, now)
        return {
            "snapshotId": meta["snapshot_id"],
            "timestamp": meta["timestamp"],
            "total": len(values),
            "entries": [_p(v) for v in values[int(offset):int(offset) + int(limit)]],
        }

    def save_snapshot(self, snapshot: Dict[str, Any], variant: str):
        self._db.execute(
            "INSERT INTO snapshots (variant, snapshot_id, timestamp, entries) "
            "VALUES (?,?,?,?) "
            "ON CONFLICT(variant) DO UPDATE SET "
            "snapshot_id=excluded.snapshot_id, "
            "timestamp=excluded.timestamp, "
            "entries=excluded.entries",
            [
                variant,
                int(snapshot.get("snapshotId", 0)),
                int(snapshot.get("timestamp", 0)),
                _j(snapshot.get("entries", [])),
            ],
        )

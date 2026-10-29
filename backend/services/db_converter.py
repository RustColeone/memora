"""
services/db_converter.py — JSON ↔ SQLite round-trip converter for MemoSystem.

Standalone CLI (no Flask dependency):

  # Import individual data/ files into a fresh SQLite DB
  python -m services.db_converter import --data-dir data/ --db data/memosystem.db

  # Import from a single JSON bundle (replace mode)
  python -m services.db_converter import --json backup.json --db data/memosystem.db

  # Import with merge (newer updated_at wins, no data loss)
  python -m services.db_converter import --json backup.json --db data/memosystem.db --merge

  # Export DB to a JSON bundle
  python -m services.db_converter export --db data/memosystem.db --out backup.json

  # Export DB back to individual data/ files
  python -m services.db_converter export --db data/memosystem.db --out-dir data/

  # Verify round-trip: export DB to temp, diff against provided JSON/dir
  python -m services.db_converter verify --db data/memosystem.db --json backup.json
  python -m services.db_converter verify --db data/memosystem.db --data-dir data/

Importable:
  from services.db_converter import import_from_dir, import_from_bundle, export_to_bundle
"""

import argparse
import hashlib
import io
import json
import os
import sys
import tempfile
import shutil
import zipfile
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# Local import — works both as a module and as a top-level script
# ---------------------------------------------------------------------------
try:
    from services.db import Database
except ImportError:
    # Running as a script from the repo root
    _here = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, os.path.dirname(_here))
    from services.db import Database


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------

def _iso_to_ms(iso: Optional[str]) -> Optional[int]:
    """Convert an ISO-8601 timestamp string to epoch milliseconds."""
    if not iso:
        return None
    try:
        cleaned = iso.replace("Z", "+00:00")
        dt = datetime.fromisoformat(cleaned)
        return int(dt.timestamp() * 1000)
    except (ValueError, AttributeError):
        return None


def _ms_to_iso(ms: Optional[int]) -> Optional[str]:
    """Convert epoch milliseconds to an ISO-8601 UTC string."""
    if ms is None:
        return None
    try:
        dt = datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)
        return dt.strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"
    except (OSError, OverflowError, ValueError):
        return None


def _j(obj) -> Optional[str]:
    """Compact JSON serialise; returns None for None."""
    if obj is None:
        return None
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _p(text: Optional[str]) -> Any:
    """Parse JSON text; returns None on failure."""
    if text is None:
        return None
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None


def _real(v) -> float:
    """Coerce a possibly-string numeric to float."""
    if v is None:
        return 0.0
    try:
        return float(v)
    except (ValueError, TypeError):
        return 0.0


# ---------------------------------------------------------------------------
# Import helpers — JSON data → SQLite rows
# ---------------------------------------------------------------------------

def _import_memos(db: Database, entries: List[Dict], mode: str):
    """Insert memos.json entries into the memos table."""
    rows = []
    for e in entries:
        deleted_at_raw = e.get("deletedAt")
        deleted_at_ms = _iso_to_ms(deleted_at_raw)
        deleted = 1 if deleted_at_ms else 0

        # Prefer ts (epoch ms) for created_at; fall back to createdAt ISO
        ts = e.get("ts")
        created_at = int(ts) if isinstance(ts, (int, float)) else _iso_to_ms(e.get("createdAt"))
        updated_at = _iso_to_ms(e.get("updatedAt")) or created_at or 0

        rows.append((
            e["id"],
            e.get("description", ""),
            e.get("category", ""),
            _j(e.get("tags", [])),
            _j(e.get("images", [])),
            _j(e.get("attachments", [])),
            _j(e.get("imageMeta", {})),
            created_at,
            updated_at,
            deleted,
            deleted_at_ms,
        ))

    if mode == "replace":
        db.execute("DELETE FROM memos")
        db.executemany(
            "INSERT INTO memos (id,description,category,tags,images,attachments,image_meta,"
            "created_at,updated_at,deleted,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )
    else:  # merge — newer updated_at wins
        for row in rows:
            db.execute(
                """
                INSERT INTO memos (id,description,category,tags,images,attachments,image_meta,
                    created_at,updated_at,deleted,deleted_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET
                    description  = CASE WHEN excluded.updated_at >= memos.updated_at THEN excluded.description  ELSE memos.description  END,
                    category     = CASE WHEN excluded.updated_at >= memos.updated_at THEN excluded.category     ELSE memos.category     END,
                    tags         = CASE WHEN excluded.updated_at >= memos.updated_at THEN excluded.tags         ELSE memos.tags         END,
                    images       = CASE WHEN excluded.updated_at >= memos.updated_at THEN excluded.images       ELSE memos.images       END,
                    attachments  = CASE WHEN excluded.updated_at >= memos.updated_at THEN excluded.attachments  ELSE memos.attachments  END,
                    image_meta   = CASE WHEN excluded.updated_at >= memos.updated_at THEN excluded.image_meta   ELSE memos.image_meta   END,
                    updated_at   = CASE WHEN excluded.updated_at >= memos.updated_at THEN excluded.updated_at   ELSE memos.updated_at   END,
                    deleted      = CASE WHEN excluded.updated_at >= memos.updated_at THEN excluded.deleted      ELSE memos.deleted      END,
                    deleted_at   = CASE WHEN excluded.updated_at >= memos.updated_at THEN excluded.deleted_at   ELSE memos.deleted_at   END
                """,
                list(row),
            )

    return len(rows)


from services.memo_store import _details_json, _finance_details, _tax  # noqa: E402


def _import_finance(db: Database, entries: List[Dict], mode: str):
    """Insert finance.json entries into the finance_entries table."""
    rows = []
    for e in entries:
        deleted_at_raw = e.get("deletedAt")
        deleted_at_ms = _iso_to_ms(deleted_at_raw)
        deleted = 1 if deleted_at_ms else 0

        ts = e.get("ts")
        created_at = int(ts) if isinstance(ts, (int, float)) else _iso_to_ms(e.get("createdAt"))
        updated_at = _iso_to_ms(e.get("updatedAt")) or created_at or 0

        rows.append((
            e["id"],
            e.get("description", ""),
            e.get("category", ""),
            _j(e.get("tags", [])),
            _j(e.get("images", [])),
            _j(e.get("attachments", [])),
            _j(e.get("imageMeta", {})),
            e.get("purchaseDate", ""),
            _real(e.get("price")),
            _tax(e.get("tax")),
            _real(e.get("adjustment")),
            _real(e.get("total")),
            _j(e.get("items")),
            created_at,
            updated_at,
            deleted,
            deleted_at_ms,
            _details_json(e),
        ))

    if mode == "replace":
        db.execute("DELETE FROM finance_entries")
        db.executemany(
            "INSERT INTO finance_entries (id,description,category,tags,images,attachments,image_meta,"
            "purchase_date,price,tax,adjustment,total,items,"
            "created_at,updated_at,deleted,deleted_at,details) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )
    else:
        for row in rows:
            db.execute(
                """
                INSERT INTO finance_entries (id,description,category,tags,images,attachments,image_meta,
                    purchase_date,price,tax,adjustment,total,items,
                    created_at,updated_at,deleted,deleted_at,details)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET
                    description   = CASE WHEN excluded.updated_at >= finance_entries.updated_at THEN excluded.description   ELSE finance_entries.description   END,
                    category      = CASE WHEN excluded.updated_at >= finance_entries.updated_at THEN excluded.category      ELSE finance_entries.category      END,
                    tags          = CASE WHEN excluded.updated_at >= finance_entries.updated_at THEN excluded.tags          ELSE finance_entries.tags          END,
                    images        = CASE WHEN excluded.updated_at >= finance_entries.updated_at THEN excluded.images        ELSE finance_entries.images        END,
                    attachments   = CASE WHEN excluded.updated_at >= finance_entries.updated_at THEN excluded.attachments   ELSE finance_entries.attachments   END,
                    image_meta    = CASE WHEN excluded.updated_at >= finance_entries.updated_at THEN excluded.image_meta    ELSE finance_entries.image_meta    END,
                    purchase_date = CASE WHEN excluded.updated_at >= finance_entries.updated_at THEN excluded.purchase_date ELSE finance_entries.purchase_date END,
                    price         = CASE WHEN excluded.updated_at >= finance_entries.updated_at THEN excluded.price         ELSE finance_entries.price         END,
                    tax           = CASE WHEN excluded.updated_at >= finance_entries.updated_at THEN excluded.tax           ELSE finance_entries.tax           END,
                    adjustment    = CASE WHEN excluded.updated_at >= finance_entries.updated_at THEN excluded.adjustment    ELSE finance_entries.adjustment    END,
                    total         = CASE WHEN excluded.updated_at >= finance_entries.updated_at THEN excluded.total         ELSE finance_entries.total         END,
                    items         = CASE WHEN excluded.updated_at >= finance_entries.updated_at THEN excluded.items         ELSE finance_entries.items         END,
                    details       = CASE WHEN excluded.updated_at >= finance_entries.updated_at THEN excluded.details       ELSE finance_entries.details       END,
                    updated_at    = CASE WHEN excluded.updated_at >= finance_entries.updated_at THEN excluded.updated_at    ELSE finance_entries.updated_at    END,
                    deleted       = CASE WHEN excluded.updated_at >= finance_entries.updated_at THEN excluded.deleted       ELSE finance_entries.deleted       END,
                    deleted_at    = CASE WHEN excluded.updated_at >= finance_entries.updated_at THEN excluded.deleted_at    ELSE finance_entries.deleted_at    END
                """,
                list(row),
            )

    return len(rows)


_OP_PAYLOAD_FIELDS = ("data", "field", "value", "url", "attachment")

_OP_INSERT_COLUMNS = (
    "INSERT {conflict} INTO operations "
    "(variant,op_id,type,entry_id,timestamp,device_id,client_op_id,payload) "
    "VALUES (?,?,?,?,?,?,?,?)"
)


def _import_operations(db: Database, entries: List[Dict], variant: str, mode: str):
    """Insert operations.json entries into the operations table (lossless)."""
    rows = []
    for e in entries:
        op_id = e.get("opId")
        if op_id is None:
            continue
        payload = {f: e.get(f) for f in _OP_PAYLOAD_FIELDS if e.get(f) is not None}
        rows.append((
            variant,
            int(op_id),
            e.get("type"),
            e.get("entryId"),
            int(e.get("timestamp") or 0),
            e.get("deviceId"),
            e.get("clientOpId"),
            _j(payload) if payload else None,
        ))

    if mode == "replace":
        db.execute("DELETE FROM operations WHERE variant=?", [variant])
        db.executemany(_OP_INSERT_COLUMNS.format(conflict="OR REPLACE"), rows)
    else:
        db.executemany(_OP_INSERT_COLUMNS.format(conflict="OR IGNORE"), rows)

    db.executemany('INSERT OR IGNORE INTO operation_receipts VALUES (?,?,?)',
        [(row[0], row[6], row[1]) for row in rows if row[6]])

    return len(rows)


def _import_snapshot(db: Database, snapshot: Dict, variant: str):
    """Insert a snapshot.json document into the snapshots table."""
    if not isinstance(snapshot, dict):
        return 0
    db.execute(
        "INSERT INTO snapshots (variant,snapshot_id,timestamp,entries) VALUES (?,?,?,?) "
        "ON CONFLICT(variant) DO UPDATE SET "
        "snapshot_id=excluded.snapshot_id, timestamp=excluded.timestamp, entries=excluded.entries",
        [
            variant,
            int(snapshot.get("snapshotId", 0)),
            int(snapshot.get("timestamp", 0)),
            _j(snapshot.get("entries", [])),
        ],
    )
    return 1


def _import_hashbook(db: Database, hb: Dict, mode: str):
    """Insert hashbook.json entries into the hashbook table."""
    import time
    rows = []
    for sha256, info in hb.items():
        rows.append((
            sha256,
            info.get("storedPath", ""),
            int(info.get("count", 1)),
            int(time.time() * 1000),
        ))

    if mode == "replace":
        db.execute("DELETE FROM hashbook")
        db.executemany(
            "INSERT INTO hashbook (sha256,stored_path,ref_count,created_at) VALUES (?,?,?,?)",
            rows,
        )
    else:
        db.executemany(
            "INSERT OR IGNORE INTO hashbook (sha256,stored_path,ref_count,created_at) VALUES (?,?,?,?)",
            rows,
        )

    return len(rows)


def _import_chat_messages(db: Database, messages: List[Dict], variant: str, mode: str):
    """Insert chat message records into chat_messages table."""
    rows = []
    for m in messages:
        created_at = _iso_to_ms(m.get("created_at")) or m.get("ts") or 0
        rows.append((
            m["id"],
            variant,
            m.get("role", ""),
            m.get("content", ""),
            int(created_at),
        ))

    if mode == "replace":
        db.execute("DELETE FROM chat_messages WHERE variant=?", [variant])
        db.executemany(
            "INSERT OR REPLACE INTO chat_messages (id,variant,role,content,created_at)"
            " VALUES (?,?,?,?,?)",
            rows,
        )
    else:
        db.executemany(
            "INSERT OR IGNORE INTO chat_messages (id,variant,role,content,created_at)"
            " VALUES (?,?,?,?,?)",
            rows,
        )

    return len(rows)


def _upsert_setting(db: Database, key: str, value: Any):
    db.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [key, _j(value)],
    )


# ---------------------------------------------------------------------------
# Export helpers — SQLite rows → JSON-compatible dicts
# ---------------------------------------------------------------------------

def _export_memos(db: Database) -> List[Dict]:
    rows = db.fetchall("SELECT * FROM memos ORDER BY created_at")
    out = []
    for r in rows:
        out.append({
            "id": r["id"],
            "description": r["description"] or "",
            "category": r["category"] or "",
            "tags": _p(r["tags"]) or [],
            "images": _p(r["images"]) or [],
            "attachments": _p(r["attachments"]) or [],
            "imageMeta": _p(r["image_meta"]) or {},
            "ts": r["created_at"],
            "createdAt": _ms_to_iso(r["created_at"]),
            "updatedAt": _ms_to_iso(r["updated_at"]),
            "deletedAt": _ms_to_iso(r["deleted_at"]),
        })
    return out


def _export_finance(db: Database) -> List[Dict]:
    rows = db.fetchall("SELECT * FROM finance_entries ORDER BY created_at")
    out = []
    for r in rows:
        out.append({
            "id": r["id"],
            "description": r["description"] or "",
            "category": r["category"] or "",
            "tags": _p(r["tags"]) or [],
            "images": _p(r["images"]) or [],
            "attachments": _p(r["attachments"]) or [],
            "imageMeta": _p(r["image_meta"]) or {},
            "purchaseDate": r["purchase_date"] or "",
            "price": r["price"],
            "tax": r["tax"],
            "adjustment": r["adjustment"],
            "total": r["total"],
            "items": _p(r["items"]),
            **_finance_details(r),
            "ts": r["created_at"],
            "createdAt": _ms_to_iso(r["created_at"]),
            "updatedAt": _ms_to_iso(r["updated_at"]),
            "deletedAt": _ms_to_iso(r["deleted_at"]),
        })
    return out


def _export_operations(db: Database, variant: str) -> List[Dict]:
    rows = db.fetchall(
        "SELECT * FROM operations WHERE variant=? ORDER BY op_id",
        [variant],
    )
    out = []
    for r in rows:
        payload = _p(r["payload"]) or {}
        op = {
            "opId": r["op_id"],
            "type": r["type"],
            "entryId": r["entry_id"],
            "timestamp": r["timestamp"],
            "deviceId": r["device_id"],
            "clientOpId": r["client_op_id"],
        }
        for f in _OP_PAYLOAD_FIELDS:
            if f in payload:
                op[f] = payload[f]
        out.append(op)
    return out


def _export_snapshot(db: Database, variant: str) -> Dict:
    r = db.fetchone("SELECT * FROM snapshots WHERE variant=?", [variant])
    if not r:
        return {"snapshotId": 0, "timestamp": 0, "entries": []}
    return {
        "snapshotId": r["snapshot_id"],
        "timestamp": r["timestamp"],
        "entries": _p(r["entries"]) or [],
    }


def _export_hashbook(db: Database) -> Dict:
    rows = db.fetchall("SELECT * FROM hashbook")
    out = {}
    for r in rows:
        out[r["sha256"]] = {
            "storedPath": r["stored_path"],
            "count": r["ref_count"],
        }
    return out


def _export_chat(db: Database, variant: str) -> Dict:
    messages = db.fetchall(
        "SELECT * FROM chat_messages WHERE variant=? ORDER BY created_at",
        [variant],
    )
    msgs = []
    for m in messages:
        msgs.append({
            "id": m["id"],
            "role": m["role"],
            "content": m["content"],
            "created_at": _ms_to_iso(m["created_at"]),
        })

    # Chat metadata (prompt, meta, summaries) stored in settings
    meta_row = db.fetchone("SELECT value FROM settings WHERE key=?", [f"chat_meta_{variant}"])
    meta = _p(meta_row["value"]) if meta_row else {}

    return {
        "prompt": meta.get("prompt", ""),
        "meta": meta.get("meta", {"finalized_days": [], "last_rollover_check_date": ""}),
        "summaries": meta.get("summaries", {"day": [], "week": [], "month": [], "quarter": [], "year": []}),
        "messages": msgs,
    }


# ---------------------------------------------------------------------------
# Bundle format
# ---------------------------------------------------------------------------

BUNDLE_VERSION = 1


def _build_bundle(db: Database) -> Dict:
    _llm_row = db.fetchone("SELECT value FROM settings WHERE key='llm_config'")
    return {
        "version": BUNDLE_VERSION,
        "exported_at": datetime.now(tz=timezone.utc).isoformat(),
        "memos": _export_memos(db),
        "finance": _export_finance(db),
        "planner": _export_planner(db),
        "operations": _export_operations(db, "default"),
        "operations_finance": _export_operations(db, "finance"),
        "operations_planner": _export_operations(db, "planner"),
        "snapshot": _export_snapshot(db, "default"),
        "snapshot_finance": _export_snapshot(db, "finance"),
        "snapshot_planner": _export_snapshot(db, "planner"),
        "hashbook": _export_hashbook(db),
        "chat": _export_chat(db, "default"),
        "chat_finance": _export_chat(db, "finance"),
        "llm_config": _p(_llm_row["value"] if _llm_row else None),
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def _load_json_file(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def import_from_dir(db: Database, data_dir: str, mode: str = "merge") -> Dict[str, int]:
    """
    Import all known JSON files from *data_dir* into *db*.
    Returns a dict of { table_name: rows_imported }.
    """
    results: Dict[str, int] = {}

    def _load(name):
        p = os.path.join(data_dir, name)
        if os.path.exists(p):
            return _load_json_file(p)
        return None

    memos_data = _load("memos.json")
    if memos_data is not None:
        results["memos"] = _import_memos(db, memos_data, mode)

    finance_data = _load("finance.json")
    if finance_data is not None:
        results["finance_entries"] = _import_finance(db, finance_data, mode)

    ops_data = _load("operations.json")
    if ops_data is not None:
        results["operations.default"] = _import_operations(db, ops_data, "default", mode)

    ops_fin_data = _load("operations_finance.json")
    if ops_fin_data is not None:
        results["operations.finance"] = _import_operations(db, ops_fin_data, "finance", mode)

    snap_data = _load("snapshot.json")
    if snap_data is not None:
        results["snapshot.default"] = _import_snapshot(db, snap_data, "default")

    snap_fin_data = _load("snapshot_finance.json")
    if snap_fin_data is not None:
        results["snapshot.finance"] = _import_snapshot(db, snap_fin_data, "finance")

    hb_data = _load("hashbook.json")
    if hb_data is not None:
        results["hashbook"] = _import_hashbook(db, hb_data, mode)

    chat_data = _load("chat.json")
    if chat_data is not None:
        results["chat_messages.default"] = _import_chat_messages(
            db, chat_data.get("messages", []), "default", mode
        )
        _upsert_setting(db, "chat_meta_default", {
            "prompt": chat_data.get("prompt", ""),
            "meta": chat_data.get("meta", {}),
            "summaries": chat_data.get("summaries", {}),
        })

    chat_fin_data = _load("chat_finance.json")
    if chat_fin_data is not None:
        results["chat_messages.finance"] = _import_chat_messages(
            db, chat_fin_data.get("messages", []), "finance", mode
        )
        _upsert_setting(db, "chat_meta_finance", {
            "prompt": chat_fin_data.get("prompt", ""),
            "meta": chat_fin_data.get("meta", {}),
            "summaries": chat_fin_data.get("summaries", {}),
        })

    llm_data = _load("llm_config.json")
    if llm_data is not None:
        _upsert_setting(db, "llm_config", llm_data)
        results["settings.llm_config"] = 1

    return results


def validate_bundle(bundle):
    if not isinstance(bundle, dict) or bundle.get('version', 1) != 1:
        raise ValueError('Unsupported backup format')
    for key in ('memos', 'finance', 'planner'):
        entries = bundle.get(key)
        if entries is None:
            continue
        if not isinstance(entries, list) or any(not isinstance(e, dict) or not isinstance(e.get('id'), str) or not e['id'] for e in entries):
            raise ValueError('Invalid ' + key + ' records in backup')


def _export_planner(db):
    from services.doc_store import DocStore
    return DocStore(db, 'planner_entries').get_all('planner')


def _import_planner(db, entries, mode):
    from services.doc_store import DocStore
    store = DocStore(db, 'planner_entries')
    if mode == 'replace':
        db.execute('DELETE FROM planner_entries')
    count = 0
    for entry in entries:
        incoming = dict(entry)
        incoming['createdAt'] = incoming.get('createdAt') or _ms_to_iso(incoming.get('ts'))
        incoming['updatedAt'] = incoming.get('updatedAt') or incoming['createdAt']
        existing = store.get_one(entry['id'])
        if existing and mode == 'merge' and (_iso_to_ms(incoming['updatedAt']) or 0) < (_iso_to_ms(existing.get('updatedAt')) or 0):
            continue
        store.upsert(incoming)
        count += 1
    return count


def import_from_bundle(db: Database, bundle: Dict, mode: str = "merge") -> Dict[str, int]:
    validate_bundle(bundle)
    if mode not in ('merge', 'replace'):
        raise ValueError('Unsupported import mode')
    with db.conn():
        return _import_bundle(db, bundle, mode)


def _import_bundle(db: Database, bundle: Dict, mode: str) -> Dict[str, int]:
    """Import a single JSON bundle (as produced by export_to_bundle) into *db*."""
    results: Dict[str, int] = {}

    if bundle.get("memos") is not None:
        results["memos"] = _import_memos(db, bundle["memos"], mode)

    if bundle.get("finance") is not None:
        results["finance_entries"] = _import_finance(db, bundle["finance"], mode)

    if bundle.get("planner") is not None:
        results['planner'] = _import_planner(db, bundle['planner'], mode)

    if bundle.get("operations") is not None:
        results["operations.default"] = _import_operations(db, bundle["operations"], "default", mode)

    if bundle.get("operations_finance") is not None:
        results["operations.finance"] = _import_operations(db, bundle["operations_finance"], "finance", mode)

    if bundle.get('operations_planner') is not None:
        results['operations.planner'] = _import_operations(db, bundle['operations_planner'], 'planner', mode)

    if bundle.get("snapshot") is not None:
        results["snapshot.default"] = _import_snapshot(db, bundle["snapshot"], "default")

    if bundle.get("snapshot_finance") is not None:
        results["snapshot.finance"] = _import_snapshot(db, bundle["snapshot_finance"], "finance")

    if bundle.get('snapshot_planner') is not None:
        results['snapshot.planner'] = _import_snapshot(db, bundle['snapshot_planner'], 'planner')

    if bundle.get("hashbook") is not None:
        results["hashbook"] = _import_hashbook(db, bundle["hashbook"], mode)

    chat = bundle.get("chat")
    if chat is not None:
        results["chat_messages.default"] = _import_chat_messages(
            db, chat.get("messages", []), "default", mode
        )
        _upsert_setting(db, "chat_meta_default", {
            "prompt": chat.get("prompt", ""),
            "meta": chat.get("meta", {}),
            "summaries": chat.get("summaries", {}),
        })

    chat_fin = bundle.get("chat_finance")
    if chat_fin is not None:
        results["chat_messages.finance"] = _import_chat_messages(
            db, chat_fin.get("messages", []), "finance", mode
        )
        _upsert_setting(db, "chat_meta_finance", {
            "prompt": chat_fin.get("prompt", ""),
            "meta": chat_fin.get("meta", {}),
            "summaries": chat_fin.get("summaries", {}),
        })

    if bundle.get("llm_config") is not None:
        _upsert_setting(db, "llm_config", bundle["llm_config"])
        results["settings.llm_config"] = 1

    return results


def export_to_bundle(db: Database) -> Dict:
    """Export entire DB to a JSON-serialisable bundle dict."""
    with db.conn():
        return _build_bundle(db)


def export_to_dir(db: Database, out_dir: str):
    """Export DB tables to individual JSON files in *out_dir* (same names as originals)."""
    os.makedirs(out_dir, exist_ok=True)

    def _write(name, obj):
        path = os.path.join(out_dir, name)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
        print(f"  wrote {path} ({len(obj) if isinstance(obj, list) else len(obj)} items)")

    _write("memos.json", _export_memos(db))
    _write("finance.json", _export_finance(db))
    _write("operations.json", _export_operations(db, "default"))
    _write("operations_finance.json", _export_operations(db, "finance"))
    _write("snapshot.json", _export_snapshot(db, "default"))
    _write("snapshot_finance.json", _export_snapshot(db, "finance"))
    _write("hashbook.json", _export_hashbook(db))
    _write("chat.json", _export_chat(db, "default"))
    _write("chat_finance.json", _export_chat(db, "finance"))

    llm_row = db.fetchone("SELECT value FROM settings WHERE key='llm_config'")
    if llm_row:
        _write("llm_config.json", _p(llm_row["value"]) or {})


# ---------------------------------------------------------------------------
# ZIP interchange — readable JSON envelope + upload blobs in one archive
# ---------------------------------------------------------------------------
#
# This is the canonical portable format, shared byte-for-byte with the
# Capacitor / browser frontend.  A ZIP exported here imports into the offline
# app and vice-versa.
#
# Layout:
#   memosystem.json          ← the JSON bundle from export_to_bundle (human-readable)
#   uploads/<date>/<file>    ← every upload blob, preserving its relative path
#
ENVELOPE_NAME = "memosystem.json"


def export_to_zip(db: Database, uploads_dir: Optional[str] = None, output=None) -> bytes:
    """Pack the DB (as a JSON envelope) plus all upload blobs into a ZIP."""
    bundle = export_to_bundle(db)
    buf = output if output is not None else io.BytesIO()
    manifest = {'version': 1, 'files': []}
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        metadata = json.dumps(bundle, ensure_ascii=False, indent=2).encode('utf-8')
        zf.writestr(ENVELOPE_NAME, metadata)
        manifest['files'].append({'path': ENVELOPE_NAME, 'size': len(metadata), 'sha256': hashlib.sha256(metadata).hexdigest()})
        if uploads_dir and os.path.isdir(uploads_dir):
            for root, _, files in os.walk(uploads_dir):
                for fn in files:
                    abs_path = os.path.join(root, fn)
                    if os.path.islink(abs_path) or os.path.commonpath([os.path.realpath(abs_path), os.path.realpath(uploads_dir)]) != os.path.realpath(uploads_dir):
                        continue
                    rel = os.path.relpath(abs_path, uploads_dir).replace(os.sep, "/")
                    name = f'uploads/{rel}'
                    digest = hashlib.sha256()
                    size = 0
                    with open(abs_path, 'rb') as reader, zf.open(name, 'w', force_zip64=True) as writer:
                        for chunk in iter(lambda: reader.read(1024 * 1024), b''):
                            writer.write(chunk)
                            digest.update(chunk)
                            size += len(chunk)
                    manifest['files'].append({'path': name, 'size': size, 'sha256': digest.hexdigest()})
        zf.writestr('manifest.json', json.dumps(manifest))
    if output is not None:
        output.seek(0)
        return output
    return buf.getvalue()


def import_from_zip(
    db: Database,
    zip_bytes: bytes,
    uploads_dir: Optional[str] = None,
    mode: str = "merge",
) -> Dict[str, int]:
    """Import a ZIP produced by export_to_zip (or the frontend).

    Restores the JSON envelope into the DB and writes upload blobs back to
    *uploads_dir*.  In merge mode, existing blob files are left untouched
    (idempotent re-import); in replace mode they are overwritten.
    """
    return import_from_zips(db, [zip_bytes], uploads_dir, mode)


def import_from_zips(db, archives, uploads_dir=None, mode='merge', after_import=None):
    """Preflight/stage the complete selection and roll files back with metadata."""
    combined = {'version': 1}
    promoted = []
    with tempfile.TemporaryDirectory() as staging:
        staged_files = {}
        total_expanded = 0
        for archive in archives:
            if len(archive) > 128 * 1024 * 1024:
                raise ValueError('Backup archive is too large')
            with zipfile.ZipFile(io.BytesIO(archive)) as zf:
                members = zf.infolist()
                if len(members) > 20000 or len(set(zf.namelist())) != len(members):
                    raise ValueError('Invalid or duplicate archive members')
                for member in members:
                    parts = member.filename.rstrip('/').split('/')
                    if not parts or any(p in ('', '.', '..') or '\\' in p or ':' in p for p in parts):
                        raise ValueError('Unsafe archive path')
                    total_expanded += member.file_size
                    if member.file_size > 128 * 1024 * 1024 or total_expanded > 512 * 1024 * 1024:
                        raise ValueError('Backup expands beyond the supported size')
                    if member.file_size > 1024 * 1024 and member.file_size > max(1, member.compress_size) * 200:
                        raise ValueError('Unsafe archive compression ratio')
                if ENVELOPE_NAME not in zf.namelist() or zf.getinfo(ENVELOPE_NAME).file_size > 16 * 1024 * 1024:
                    raise ValueError('Missing or oversized backup metadata')
                bundle = json.loads(zf.read(ENVELOPE_NAME).decode('utf-8'))
                validate_bundle(bundle)
                for key, value in bundle.items():
                    if key in ('memos', 'finance', 'planner', 'operations', 'operations_finance', 'operations_planner'):
                        if value is not None:
                            combined.setdefault(key, []).extend(value)
                    else:
                        combined[key] = value
                manifest = None
                if 'manifest.json' in zf.namelist():
                    if zf.getinfo('manifest.json').file_size > 8 * 1024 * 1024:
                        raise ValueError('Oversized backup manifest')
                    manifest = json.loads(zf.read('manifest.json'))
                    records = manifest.get('files', []) if isinstance(manifest, dict) else None
                    expected = {m.filename for m in members if not m.is_dir() and m.filename != 'manifest.json'}
                    if not isinstance(records, list) or any(not isinstance(r, dict) or not {'path', 'size', 'sha256'} <= r.keys() or not isinstance(r['path'], str) for r in records):
                        raise ValueError('Invalid backup manifest')
                    if len(records) != len(expected) or {r['path'] for r in records} != expected:
                        raise ValueError('Incomplete backup manifest')
                    for record in records:
                        content = zf.read(record['path'])
                        if len(content) != record['size'] or hashlib.sha256(content).hexdigest() != record['sha256']:
                            raise ValueError('Backup checksum mismatch')
                for member in members:
                    name = member.filename
                    if member.is_dir() or not name.startswith('uploads/'):
                        continue
                    content = zf.read(name)  # Checks CRC before touching existing data.
                    fd, temporary = tempfile.mkstemp(dir=staging)
                    with os.fdopen(fd, 'wb') as writer:
                        writer.write(content)
                    staged_files[name[len('uploads/'):]] = temporary
        try:
            with db.conn():
                results = import_from_bundle(db, combined, mode)
                if uploads_dir:
                    root = os.path.realpath(uploads_dir)
                    for relative, temporary in staged_files.items():
                        destination = os.path.join(root, *relative.split('/'))
                        if os.path.commonpath([root, os.path.realpath(destination)]) != root:
                            raise ValueError('Upload path escapes its destination')
                        if mode == 'merge' and os.path.exists(destination):
                            continue
                        previous = None
                        if os.path.exists(destination):
                            previous = os.path.join(staging, 'previous-' + str(len(promoted)))
                            shutil.copy2(destination, previous)
                        os.makedirs(os.path.dirname(destination), exist_ok=True)
                        # Cross-volume safe: copy alongside destination, then rename.
                        fd, staged_target = tempfile.mkstemp(prefix='.restore-', dir=os.path.dirname(destination))
                        os.close(fd)
                        try:
                            shutil.copyfile(temporary, staged_target)
                            os.replace(staged_target, destination)
                        finally:
                            if os.path.exists(staged_target):
                                os.remove(staged_target)
                        promoted.append((destination, previous))
                results['uploads'] = len(promoted)
                if after_import is not None:
                    after_import()
            return results
        except Exception:
            for destination, previous in reversed(promoted):
                if previous:
                    shutil.copyfile(previous, destination)
                elif os.path.exists(destination):
                    os.remove(destination)
            raise


def verify(db: Database, reference_bundle: Dict) -> Dict:
    """
    Compare *db* content against *reference_bundle*.
    Returns { "ok": bool, "details": [...] }
    """
    db_bundle = export_to_bundle(db)
    details = []
    ok = True

    def _check(key, id_field="id"):
        nonlocal ok
        ref_items = reference_bundle.get(key, [])
        db_items = db_bundle.get(key, [])
        if len(ref_items) != len(db_items):
            ok = False
            details.append(f"{key}: count mismatch — ref={len(ref_items)}, db={len(db_items)}")
        else:
            details.append(f"{key}: {len(db_items)} rows OK")

    if isinstance(reference_bundle.get("memos"), list):
        _check("memos")
    if isinstance(reference_bundle.get("finance"), list):
        _check("finance")
    if isinstance(reference_bundle.get("operations"), list):
        _check("operations")
    if isinstance(reference_bundle.get("operations_finance"), list):
        _check("operations_finance")
    if isinstance(reference_bundle.get("hashbook"), dict):
        ref_hb = reference_bundle.get("hashbook", {})
        db_hb = db_bundle.get("hashbook", {})
        if len(ref_hb) != len(db_hb):
            ok = False
            details.append(f"hashbook: count mismatch — ref={len(ref_hb)}, db={len(db_hb)}")
        else:
            details.append(f"hashbook: {len(db_hb)} rows OK")

    return {"ok": ok, "details": details}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _cmd_import(args):
    db = Database(args.db)
    mode = "merge" if args.merge else "replace"

    if args.json:
        print(f"Importing bundle from {args.json} (mode={mode})...")
        bundle = _load_json_file(args.json)
        results = import_from_bundle(db, bundle, mode)
    elif args.data_dir:
        print(f"Importing data/ files from {args.data_dir} (mode={mode})...")
        results = import_from_dir(db, args.data_dir, mode)
    else:
        print("ERROR: provide --json or --data-dir", file=sys.stderr)
        sys.exit(1)

    print("Import complete:")
    for table, count in sorted(results.items()):
        print(f"  {table}: {count} rows")


def _cmd_export(args):
    db = Database(args.db)

    if args.out:
        print(f"Exporting to bundle {args.out}...")
        bundle = export_to_bundle(db)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(bundle, f, ensure_ascii=False, indent=2)
        print(f"Bundle written: {args.out}")
    elif args.out_dir:
        print(f"Exporting individual files to {args.out_dir}...")
        export_to_dir(db, args.out_dir)
    else:
        print("ERROR: provide --out or --out-dir", file=sys.stderr)
        sys.exit(1)


def _cmd_verify(args):
    db = Database(args.db)

    if args.json:
        ref_bundle = _load_json_file(args.json)
    elif args.data_dir:
        # Build a reference bundle by importing into a temp in-memory DB first
        print("Building reference bundle from data dir (in-memory)...")
        tmp_db = Database(":memory:")
        import_from_dir(tmp_db, args.data_dir, mode="replace")
        ref_bundle = export_to_bundle(tmp_db)
    else:
        print("ERROR: provide --json or --data-dir", file=sys.stderr)
        sys.exit(1)

    result = verify(db, ref_bundle)
    for line in result["details"]:
        status = "OK " if "OK" in line else "ERR"
        print(f"  [{status}] {line}")

    if result["ok"]:
        print("\nVerification PASSED — all row counts match.")
    else:
        print("\nVerification FAILED — see above.", file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        description="MemoSystem JSON ↔ SQLite converter",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # import
    p_import = sub.add_parser("import", help="Import JSON data into SQLite")
    p_import.add_argument("--db", required=True, help="Path to .db file")
    p_import.add_argument("--json", help="Path to a single JSON bundle file")
    p_import.add_argument("--data-dir", metavar="DIR", help="Directory containing individual JSON files")
    p_import.add_argument("--merge", action="store_true", default=True,
                          help="Merge (newer updated_at wins) — DEFAULT")
    p_import.add_argument("--replace", dest="merge", action="store_false",
                          help="Replace (clear tables, then insert)")

    # export
    p_export = sub.add_parser("export", help="Export SQLite data to JSON")
    p_export.add_argument("--db", required=True, help="Path to .db file")
    p_export.add_argument("--out", help="Output path for a single JSON bundle")
    p_export.add_argument("--out-dir", metavar="DIR", help="Directory to write individual JSON files")

    # verify
    p_verify = sub.add_parser("verify", help="Verify DB matches a JSON reference")
    p_verify.add_argument("--db", required=True, help="Path to .db file")
    p_verify.add_argument("--json", help="Path to a JSON bundle to compare against")
    p_verify.add_argument("--data-dir", metavar="DIR", help="Directory with original JSON files")

    args = parser.parse_args()

    if args.command == "import":
        _cmd_import(args)
    elif args.command == "export":
        _cmd_export(args)
    elif args.command == "verify":
        _cmd_verify(args)


if __name__ == "__main__":
    main()

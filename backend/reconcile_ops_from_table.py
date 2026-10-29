#!/usr/bin/env python3
"""
One-off reconciliation: make the entry table the single source of truth and
rebuild the operation log / snapshot from it.

Why: historically the entry table (served by GET /api/memos and the Settings
"Connect to server" full-load) and the operation log (served by
/api/operations/pull) could drift apart — the JSON→SQLite migration copied
already-inconsistent legacy files, so the same variant rebuilt to a different
set depending on which path a client used. This script eliminates that split
by writing a fresh snapshot that holds exactly the current table entries and
clearing the superseded ops. After it runs, every client converges on the
table state on its next pull (full-sync replace), and the two stores can no
longer disagree.

Covers every synced variant (default memo, finance, planner) — the drift is
not memo-specific.

IMPORTANT: stop the server before running (SQLite is single-writer).

Usage:
    python backend/reconcile_ops_from_table.py --dry-run   # preview only
    python backend/reconcile_ops_from_table.py             # apply
    python backend/reconcile_ops_from_table.py --db /path/to/memosystem.db
"""

import argparse
import os
import sys

# The backend package lives alongside this script.
_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _BACKEND_DIR)

from services.db import init_db
from services.memo_store import MemoStore
from services.doc_store import DocStore
from services.operations_store import OperationsStore
from services.operations import OperationsService

_DEFAULT_DB = os.path.join(_BACKEND_DIR, "..", "data", "memosystem.db")


def _entries_for_variant(variant, memo_store, planner_store):
    if variant == "planner":
        return planner_store.get_all("planner")
    # default + finance both live in the memos/finance_entries tables via MemoStore.
    return memo_store.get_all(variant)


def reconcile(db_path=_DEFAULT_DB, variants=("default", "finance", "planner"), dry_run=False):
    db_path = os.path.abspath(db_path)
    if not os.path.exists(db_path):
        print(f"❌ Database not found: {db_path}")
        return 1

    db = init_db(db_path)
    memo_store = MemoStore(db)
    planner_store = DocStore(db, "planner_entries")
    ops_store = OperationsStore(db)
    ops_service = OperationsService(ops_store)

    print("=" * 64)
    print("Reconcile op-log ← entry table (table becomes canonical)")
    print("=" * 64)
    print(f"DB: {db_path}")
    print(f"Mode: {'DRY RUN (no writes)' if dry_run else 'APPLY'}")
    print("-" * 64)

    for variant in variants:
        entries = _entries_for_variant(variant, memo_store, planner_store)
        snapshot = ops_service.get_snapshot_for_variant(variant)
        old_snapshot_id = snapshot.get("snapshotId", 0)
        max_op = ops_store.max_op_id(variant)

        # Skip variants that have never been used (nothing to reconcile).
        if not entries and max_op == 0 and old_snapshot_id == 0:
            print(f"[{variant}] no entries / no ops / no snapshot — skipped")
            continue

        live = sum(1 for e in entries if not e.get("deletedAt"))
        deleted = len(entries) - live
        print(
            f"[{variant}] table entries={len(entries)} (live={live}, deleted={deleted}) "
            f"oldSnapshotId={old_snapshot_id} maxOpId={max_op}"
        )

        if dry_run:
            print(f"          would set snapshotId -> {max(max_op, old_snapshot_id) + 1} and clear {max_op and 'the'} op log")
            continue

        result = ops_service.reseat_snapshot_from_entries(entries, variant)
        print(
            f"          ✅ snapshotId {old_snapshot_id} -> {result['newSnapshotId']}, "
            f"snapshot entries={result['entries']}, op log cleared"
        )

    print("-" * 64)
    print("Done." + ("" if dry_run else " Restart the server; clients converge on next pull."))
    return 0


def main():
    parser = argparse.ArgumentParser(description="Reconcile the operation log from the entry table.")
    parser.add_argument("--db", default=_DEFAULT_DB, help="Path to memosystem.db")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing")
    parser.add_argument(
        "--variants",
        default="default,finance,planner",
        help="Comma-separated variants to reconcile (default: default,finance,planner)",
    )
    args = parser.parse_args()
    variants = tuple(v.strip() for v in args.variants.split(",") if v.strip())
    return reconcile(db_path=args.db, variants=variants, dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())

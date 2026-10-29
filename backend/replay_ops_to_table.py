#!/usr/bin/env python3
"""
Repair: replay the operation log INTO the entry table.

The inverse of reconcile_ops_from_table.py. Use this when the op log is the
healthy side and the materialised entry table is the one that lost data.

Why this exists: a push appends the operation to the log FIRST and then applies
it to the entry table. If that apply raised (e.g. the table was missing a column
because a schema_version from another branch made the numbered migrations
no-op), the server still answered 200 — so the client marked the op synced while
the authoritative table silently never got the row. Everything derived from that
table (GET /api/memos, snapshot compaction, server-side OCR/chat/PDF) was then
missing the entry, and a compaction would have made the loss permanent.

Replaying is safe: each op is applied through the same idempotent upsert the
push path uses, so re-running changes nothing that is already correct.

IMPORTANT: stop the server before running (SQLite is single-writer).

Usage:
    python backend/replay_ops_to_table.py --dry-run        # preview only
    python backend/replay_ops_to_table.py                  # apply
    python backend/replay_ops_to_table.py --variant finance
    python backend/replay_ops_to_table.py --missing-only   # only unmaterialised entries
"""

import argparse
import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _BACKEND_DIR)

from backend_context import BackendContext  # noqa: E402

_DEFAULT_DB = os.path.join(_BACKEND_DIR, "..", "data", "memosystem.db")


def _table_ids(ctx, variant):
    store = ctx._store_for_variant(variant)
    return {e.get("id") for e in store.get_all(variant) if e.get("id")}


def replay(db_path, variants, dry_run=False, missing_only=False):
    db_path = os.path.abspath(db_path)
    if not os.path.exists(db_path):
        print(f"❌ Database not found: {db_path}")
        return 1

    # BackendContext derives data_dir from base_dir unless MEMO_DATA_DIR is set;
    # point it at the requested database's directory.
    os.environ['MEMO_DATA_DIR'] = os.path.dirname(db_path)
    base_dir = os.path.abspath(os.path.join(_BACKEND_DIR, '..'))
    ctx = BackendContext(base_dir=base_dir, use_server_backend=True)

    total_applied = 0
    total_failed = 0
    for variant in variants:
        ops = ctx.operations_service.get_operations_since(0, variant)
        if not ops:
            print(f"[{variant}] no operations — skipped")
            continue

        before = _table_ids(ctx, variant)
        targets = None
        if missing_only:
            op_entry_ids = {o.get("entryId") for o in ops if o.get("entryId")}
            targets = op_entry_ids - before
            if not targets:
                print(f"[{variant}] {len(ops)} ops, nothing missing from the table — skipped")
                continue
            print(f"[{variant}] {len(ops)} ops; {len(targets)} entry(ies) missing from the table")
        else:
            print(f"[{variant}] replaying {len(ops)} ops over {len(before)} table rows")

        applied = failed = 0
        for op in ops:
            entry_id = op.get("entryId")
            if targets is not None and entry_id not in targets:
                continue
            if dry_run:
                applied += 1
                continue
            try:
                ctx.apply_operation_to_memos(op, variant)
                applied += 1
            except Exception as exc:  # keep going: one bad op shouldn't stop repair
                failed += 1
                print(f"    ⚠️ op {op.get('opId')} {op.get('type')} on {entry_id}: {exc}")

        after = _table_ids(ctx, variant)
        recovered = sorted(after - before)
        verb = "would apply" if dry_run else "applied"
        print(f"    {verb} {applied} op(s); failed {failed}; "
              f"table rows {len(before)} -> {len(after)}")
        for rid in recovered:
            entry = ctx._store_for_variant(variant).get_one(rid, variant)
            desc = (entry or {}).get("description", "")
            print(f"    ✅ recovered {rid}  {str(desc)[:60]!r}")

        total_applied += applied
        total_failed += failed

    print(f"\n{'DRY RUN — nothing written. ' if dry_run else ''}"
          f"total ops {'to apply' if dry_run else 'applied'}: {total_applied}, failed: {total_failed}")
    return 1 if total_failed else 0


def main():
    parser = argparse.ArgumentParser(description="Replay the operation log into the entry table.")
    parser.add_argument("--db", default=_DEFAULT_DB, help="path to memosystem.db")
    parser.add_argument("--dry-run", action="store_true", help="preview without writing")
    parser.add_argument("--missing-only", action="store_true",
                        help="only replay ops for entries absent from the table")
    parser.add_argument("--variant", action="append", dest="variants",
                        help="limit to a variant (repeatable); default: default+finance+planner")
    args = parser.parse_args()
    variants = tuple(args.variants) if args.variants else ("default", "finance", "planner")
    return replay(args.db, variants, dry_run=args.dry_run, missing_only=args.missing_only)


if __name__ == "__main__":
    raise SystemExit(main())

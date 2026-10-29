#!/usr/bin/env python3
"""
Integrity scan: find entries whose images/attachments point at a `blob:` URL.

A blob: URL is a handle into ONE browser session's memory. It can never resolve
on another device, or in the same app after a reload, and the bytes behind it
were never uploaded — so a synced entry holding one has effectively lost that
file while still appearing to have it.

They are no longer produced (persistLocalEntry now fails instead of falling back
to blob: URLs, and the push path refuses to send them), so this is for auditing
data written before that fix, or after any future import.

Scans the materialised entry tables, the planner doc store, and the operation
log — the log matters because a replay or a fresh device's full sync would
re-introduce a reference that was only cleaned from the tables.

IMPORTANT: stop the server before running with --fix (SQLite is single-writer).

Usage:
    python backend/scan_blob_refs.py                 # report only
    python backend/scan_blob_refs.py --fix           # drop the dead references
    python backend/scan_blob_refs.py --db /path/to/memosystem.db
"""

import argparse
import json
import os
import sqlite3
import sys

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_DB = os.path.join(_BACKEND_DIR, "..", "data", "memosystem.db")


def _is_blob(value):
    return isinstance(value, str) and value.startswith("blob:")


def _blob_refs(value):
    """Every blob: URL inside an images / attachments value."""
    found = []
    if not isinstance(value, list):
        return found
    for item in value:
        if _is_blob(item):
            found.append(item)
        elif isinstance(item, dict):
            for key in ("url", "storedPath"):
                if _is_blob(item.get(key)):
                    found.append(item[key])
    return found


def _strip(value):
    """Drop blob-only entries; keep anything with a usable reference."""
    if not isinstance(value, list):
        return value, 0
    kept, removed = [], 0
    for item in value:
        if _is_blob(item):
            removed += 1
            continue
        if isinstance(item, dict):
            url, stored = item.get("url"), item.get("storedPath")
            # A durable storedPath makes the entry recoverable even if `url` is a
            # stale blob:, so only drop when there is nothing usable left.
            if _is_blob(url) and not (stored and not _is_blob(stored)):
                removed += 1
                continue
        kept.append(item)
    return kept, removed


def scan(db_path=_DEFAULT_DB, fix=False):
    db_path = os.path.abspath(db_path)
    if not os.path.exists(db_path):
        print(f"❌ Database not found: {db_path}")
        return 1
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row

    affected = 0
    fixed = 0

    for table, label in (("memos", "memo"), ("finance_entries", "finance")):
        try:
            rows = list(con.execute(f"SELECT id, description, images, attachments FROM {table}"))
        except sqlite3.Error as exc:
            print(f"[{label}] skipped: {exc}")
            continue
        hits = 0
        for row in rows:
            try:
                images = json.loads(row["images"] or "[]")
                attachments = json.loads(row["attachments"] or "[]")
            except ValueError:
                continue
            refs = _blob_refs(images) + _blob_refs(attachments)
            if not refs:
                continue
            hits += 1
            affected += 1
            print(f"  [{label}] {row['id']}  {str(row['description'])[:50]!r}")
            for ref in refs:
                print(f"        {ref[:78]}")
            if fix:
                new_images, n1 = _strip(images)
                new_attachments, n2 = _strip(attachments)
                con.execute(
                    f"UPDATE {table} SET images=?, attachments=? WHERE id=?",
                    (json.dumps(new_images), json.dumps(new_attachments), row["id"]),
                )
                fixed += n1 + n2
                print(f"        -> removed {n1 + n2} dead reference(s)")
        print(f"[{label}] {hits} affected row(s) of {len(rows)}")

    try:
        planner = [r for r in con.execute("SELECT id, data FROM planner_entries")
                   if r["data"] and "blob:" in r["data"]]
        for row in planner:
            affected += 1
            print(f"  [planner] {row['id']} carries a blob: reference")
        print(f"[planner] {len(planner)} affected doc(s)")
    except sqlite3.Error as exc:
        print(f"[planner] skipped: {exc}")

    # Report-only: rewriting history would change op payloads other devices have
    # already applied. A newer op (e.g. re-attaching the file) supersedes these.
    ops = [r for r in con.execute("SELECT variant, op_id, entry_id, payload FROM operations")
           if r["payload"] and "blob:" in r["payload"]]
    for row in ops:
        print(f"  [op log] {row['variant']} op {row['op_id']} entry {row['entry_id']}")
    print(f"[op log] {len(ops)} operation(s) carry blob: refs "
          f"(not rewritten — a newer op for the same entry supersedes them)")

    if fix and fixed:
        con.commit()
        print(f"\n✅ Removed {fixed} dead reference(s). Re-attach the affected files.")
    elif fix:
        print("\nNothing to fix.")
    elif affected:
        print(f"\n⚠️  {affected} affected record(s). Re-run with --fix to drop the dead "
              f"references (the files themselves were never uploaded and cannot be recovered).")
    else:
        print("\n✅ No blob: references found.")
    return 0


def main():
    parser = argparse.ArgumentParser(description="Find entries holding unresolvable blob: URLs.")
    parser.add_argument("--db", default=_DEFAULT_DB, help="path to memosystem.db")
    parser.add_argument("--fix", action="store_true", help="drop the dead references")
    args = parser.parse_args()
    return scan(args.db, fix=args.fix)


if __name__ == "__main__":
    raise SystemExit(main())

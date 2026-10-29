"""
Planner-variant backend tests — fully isolated on a temp DB.

The `planner` sync variant stores entries as generic JSON documents
(planner_entries via DocStore) and rides the same event-sourced op log as
memo/finance. These tests assert variant resolution, store routing, CRUD via the
op-push path, pull-rebuild, nested-document fidelity, and isolation from memos.

Run:  python tests/test_planner.py
Exits non-zero on the first failure.
"""

import os
import shutil
import sys
import tempfile

# The backend package lives in backend/ (put it on the path to import api/services).
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

from backend_context import BackendContext
from services.doc_store import DocStore
from services.memo_store import MemoStore

_checks = 0


def check(cond, label):
    global _checks
    _checks += 1
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}")
        raise SystemExit(1)


class _Req:
    """Minimal stand-in for a Flask request for resolve_variant()."""
    def __init__(self, args=None, headers=None):
        self.args = args or {}
        self.headers = headers or {}


def make_context():
    base = tempfile.mkdtemp(prefix="planner_test_")
    os.makedirs(os.path.join(base, "data"), exist_ok=True)
    return BackendContext(base_dir=base, use_server_backend=True), base


def push(ctx, ops, variant="planner"):
    return ctx.operations_service.handle_push_operations(
        {"operations": ops}, variant, ctx.apply_operation_to_memos
    )


def test_resolve_variant():
    print("test_resolve_variant")
    check(BackendContext.resolve_variant(_Req(args={"variant": "planner"})) == "planner", "?variant=planner")
    check(BackendContext.resolve_variant(_Req(headers={"X-Memo-Variant": "planner"})) == "planner", "X-Memo-Variant header")
    check(BackendContext.resolve_variant(_Req(headers={"Referer": "http://x/planner/"})) == "planner", "/planner/ referer")
    check(BackendContext.resolve_variant(_Req()) == "default", "default fallback unchanged")
    check(BackendContext.resolve_variant(_Req(args={"variant": "finance"})) == "finance", "finance still resolves")


def test_store_routing():
    print("test_store_routing")
    ctx, base = make_context()
    try:
        check(isinstance(ctx._store_for_variant("planner"), DocStore), "planner -> DocStore")
        check(isinstance(ctx._store_for_variant("default"), MemoStore), "default -> MemoStore")
        check(isinstance(ctx._store_for_variant("finance"), MemoStore), "finance -> MemoStore")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_planner_crud_via_ops():
    print("test_planner_crud_via_ops")
    ctx, base = make_context()
    try:
        res, st = push(ctx, [{"clientOpId": "c1", "type": "create", "entryId": "t1", "timestamp": 1,
                              "deviceId": "devA", "data": {"kind": "todo", "title": "Buy milk",
                              "done": False, "due": "2026-06-20"}}])
        check(st == 200 and res["operations"][0]["serverOpId"] == 1, "create push -> 200, opId 1")
        got = ctx.get_memos_for_variant("planner")
        check(len(got) == 1 and got[0]["kind"] == "todo" and got[0]["title"] == "Buy milk",
              "entry materialised with kind + fields")

        push(ctx, [{"clientOpId": "c2", "type": "update", "entryId": "t1", "timestamp": 2,
                    "deviceId": "devA", "data": {"done": True}}])
        check(ctx.planner_store.get_one("t1", "planner")["done"] is True, "update applied to doc store")

        push(ctx, [{"clientOpId": "c3", "type": "delete", "entryId": "t1", "timestamp": 3, "deviceId": "devA"}])
        check(bool(ctx.planner_store.get_one("t1", "planner")["deletedAt"]), "delete soft-deletes")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_planner_pull_rebuilds_from_log():
    print("test_planner_pull_rebuilds_from_log")
    ctx, base = make_context()
    try:
        push(ctx, [{"clientOpId": "c1", "type": "create", "entryId": "e1", "timestamp": 1,
                    "deviceId": "devA", "data": {"kind": "event", "title": "Standup", "date": "2026-06-20"}}])
        pull, st = ctx.operations_service.handle_pull_operations(0, "planner")
        check(st == 200 and pull["needsFullSync"] is False, "pull -> 200, no full sync")
        check(len(pull["operations"]) == 1 and pull["operations"][0]["type"] == "create", "pull surfaces the create op")
        check(pull["operations"][0]["entryId"] == "e1", "second device (sinceOpId=0) can replay it")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_nested_document_roundtrip():
    print("test_nested_document_roundtrip")
    ctx, base = make_context()
    try:
        push(ctx, [{"clientOpId": "c1", "type": "create", "entryId": "p1", "timestamp": 1, "deviceId": "devA",
                    "data": {"kind": "project", "name": "Launch",
                             "milestones": [{"id": "m1", "title": "Wireframes", "done": True},
                                            {"id": "m2", "title": "Ship", "done": False}]}}])
        proj = ctx.planner_store.get_one("p1", "planner")
        check(len(proj["milestones"]) == 2 and proj["milestones"][0]["done"] is True, "nested project milestones preserved")

        push(ctx, [{"clientOpId": "c2", "type": "create", "entryId": "h1", "timestamp": 2, "deviceId": "devA",
                    "data": {"kind": "habit", "name": "Gym", "type": "timer", "targetDays": [0, 2, 4],
                             "logs": [{"date": "2026-06-18", "count": 1, "durationMin": 32}]}}])
        hab = ctx.planner_store.get_one("h1", "planner")
        check(hab["targetDays"] == [0, 2, 4] and hab["logs"][0]["durationMin"] == 32, "habit arrays preserved")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_isolation_from_memos():
    print("test_isolation_from_memos")
    ctx, base = make_context()
    try:
        push(ctx, [{"clientOpId": "p", "type": "create", "entryId": "pt1", "timestamp": 1, "deviceId": "d",
                    "data": {"kind": "todo", "title": "planner todo"}}], variant="planner")
        push(ctx, [{"clientOpId": "m", "type": "create", "entryId": "mm1", "timestamp": 1, "deviceId": "d",
                    "data": {"description": "memo entry", "category": "X"}}], variant="default")
        check(ctx.memo_store.get_one("pt1", "default") is None, "planner entry NOT written to memos table")
        check(ctx.planner_store.get_one("mm1", "planner") is None, "memo entry NOT written to planner_entries")
        check(ctx.memo_store.get_one("mm1", "default")["description"] == "memo entry", "memo entry lands in memos table")
        check(len(ctx.operations_service.get_operations_for_variant("planner")) == 1, "1 planner op in its log")
        check(len(ctx.operations_service.get_operations_for_variant("default")) == 1, "1 default op in its log")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_dedup_by_client_op_id():
    print("test_dedup_by_client_op_id")
    ctx, base = make_context()
    try:
        p = [{"clientOpId": "dup", "type": "create", "entryId": "x", "timestamp": 1, "deviceId": "d",
              "data": {"kind": "todo", "title": "once"}}]
        r1, _ = push(ctx, p)
        r2, _ = push(ctx, p)
        check(r1["operations"][0]["duplicate"] is False, "first push is new")
        check(r2["operations"][0]["duplicate"] is True, "second push deduped by clientOpId")
        check(r1["operations"][0]["serverOpId"] == r2["operations"][0]["serverOpId"], "same serverOpId returned")
    finally:
        shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    test_resolve_variant()
    test_store_routing()
    test_planner_crud_via_ops()
    test_planner_pull_rebuilds_from_log()
    test_nested_document_roundtrip()
    test_isolation_from_memos()
    test_dedup_by_client_op_id()
    print(f"\nAll planner-variant backend checks passed ({_checks} assertions).")

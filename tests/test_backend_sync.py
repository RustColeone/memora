"""
Backend sync + interchange tests — fully isolated on a temp DB (the live
data/memosystem.db is never touched).

Run:  python tests/test_backend_sync.py
Exits non-zero on the first failure.
"""

import json
import os
import shutil
import sys
import tempfile

# The backend package lives in backend/ (put it on the path to import api/services).
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

from flask import Flask

from api import create_memo_blueprint, create_operations_blueprint
from backend_context import BackendContext

# No startup chat summarizer in tests: it would call a real provider once the
# day rolls over, and its thread races tests that drive the push path directly.
BackendContext._start_background_summarization = lambda self: None
from services.agent import MemoAgentTools, run_agent, AGENT_SYSTEM_PROMPT
from services.db_converter import export_to_bundle, export_to_zip, import_from_zip
from services.db import Database


# --- a fake OpenAI-compatible client that replays a scripted tool-calling run ---
class _FakeFn:
    def __init__(self, name, arguments):
        self.name = name
        self.arguments = arguments


class _FakeToolCall:
    def __init__(self, id, name, arguments):
        self.id = id
        self.function = _FakeFn(name, arguments)


class _FakeMessage:
    def __init__(self, content=None, tool_calls=None):
        self.content = content
        self.tool_calls = tool_calls


class _FakeResp:
    def __init__(self, message):
        self.choices = [type("C", (), {"message": message})]


class _FakeClient:
    """chat.completions.create() returns scripted messages in order."""
    def __init__(self, script):
        self._script = script
        self._i = 0
        self.chat = type("Chat", (), {"completions": self})()

    def create(self, **kwargs):
        msg = self._script[self._i]
        self._i += 1
        return _FakeResp(msg)

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
_checks = 0


def check(cond, label):
    global _checks
    _checks += 1
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}")
        raise SystemExit(1)


def _seed_entries():
    """A small notebook in the legacy JSON layout, so the tests never need anyone's real data/."""
    memos = [{"id": f"seed-memo-{i}", "description": f"Seed note {i}", "category": "General", "tags": ["seed"],
              "images": [], "attachments": [], "ts": 1767225600000 + i * 60000,
              "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"} for i in range(5)]
    finance = [{"id": f"seed-buy-{i}", "description": f"Seed purchase {i}", "category": "Food", "tags": [],
                "images": [], "price": 2.5 * (i + 1), "tax": 0, "adjustment": 0, "total": 2.5 * (i + 1),
                "purchaseDate": f"2026-01-0{i + 1}", "ts": 1767225600000 + i * 86400000,
                "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"} for i in range(4)]
    return {"memos.json": memos, "finance.json": finance}


def make_context():
    """Fresh BackendContext on a temp base dir seeded with a small sample notebook."""
    base = tempfile.mkdtemp(prefix="memo_test_")
    data_dir = os.path.join(base, "data")
    os.makedirs(data_dir, exist_ok=True)
    for name, entries in _seed_entries().items():
        with open(os.path.join(data_dir, name), "w", encoding="utf-8") as f:
            json.dump(entries, f)
    # uploads with one fake blob so ZIP blob round-trip is exercised
    up = os.path.join(base, "uploads", "2099-01-01")
    os.makedirs(up, exist_ok=True)
    with open(os.path.join(up, "fake.txt"), "wb") as f:
        f.write(b"hello-blob")
    return BackendContext(base_dir=base, use_server_backend=True), base


def test_incremental_apply_no_clobber():
    print("test_incremental_apply_no_clobber")
    ctx, base = make_context()
    try:
        before = {m["id"] for m in ctx.get_memos_for_variant("default")}
        target = next(iter(before))
        payload = {"operations": [
            {"type": "update", "entryId": target, "clientOpId": "c1", "data": {"description": "EDITED"}},
            {"type": "create", "entryId": "new-1", "clientOpId": "c2",
             "data": {"description": "new", "category": "x", "tags": [], "images": [], "attachments": []}},
        ]}
        res, status = ctx.operations_service.handle_push_operations(payload, "default", ctx.apply_operation_to_memos)
        after = {m["id"] for m in ctx.get_memos_for_variant("default")}
        check(status == 200, "push returns 200")
        check(before - after == set(), "no unrelated memos dropped")
        check("new-1" in after, "created memo present")
        edited = ctx.memo_store.get_one(target, "default")
        check(edited["description"] == "EDITED", "update applied to target")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_dedup_by_client_op_id():
    print("test_dedup_by_client_op_id")
    ctx, base = make_context()
    try:
        p = {"operations": [{"type": "create", "entryId": "dedup-x", "clientOpId": "dup", "data": {"description": "a"}}]}
        r1, _ = ctx.operations_service.handle_push_operations(p, "default", ctx.apply_operation_to_memos)
        r2, _ = ctx.operations_service.handle_push_operations(p, "default", ctx.apply_operation_to_memos)
        check(r1["operations"][0]["duplicate"] is False, "first push is new")
        check(r2["operations"][0]["duplicate"] is True, "second push deduped")
        check(r1["operations"][0]["serverOpId"] == r2["operations"][0]["serverOpId"], "same serverOpId")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_crud_emits_operation():
    print("test_crud_emits_operation")
    ctx, base = make_context()
    try:
        app = Flask(__name__)
        app.register_blueprint(create_memo_blueprint(ctx))
        app.register_blueprint(create_operations_blueprint(ctx))
        client = app.test_client()

        before = len(ctx.operations_service.get_operations_for_variant("default"))
        resp = client.post("/api/memos", json={"description": "via crud", "category": "c", "tags": []})
        check(resp.status_code == 201, "POST /api/memos -> 201")
        new_id = resp.get_json()["id"]

        ops = ctx.operations_service.get_operations_for_variant("default")
        check(len(ops) == before + 1, "exactly one op journaled")
        last = ops[-1]
        check(last["type"] == "create" and last["entryId"] == new_id, "journaled op matches the created memo")

        # a sync client pulling from 0 sees the new create op
        pull, _ = ctx.operations_service.handle_pull_operations(0, "default")
        check(any(o["entryId"] == new_id for o in pull["operations"]), "pull surfaces the CRUD-created entry")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_zip_roundtrip():
    print("test_zip_roundtrip")
    ctx, base = make_context()
    try:
        zbytes = export_to_zip(ctx.db, os.path.join(base, "uploads"))
        src = export_to_bundle(ctx.db)

        dst_db = os.path.join(tempfile.mkdtemp(prefix="memo_zip_"), "x.db")
        dst_up = tempfile.mkdtemp(prefix="memo_up_")
        dst = Database(dst_db)
        import_from_zip(dst, zbytes, dst_up, mode="replace")
        out = export_to_bundle(dst)

        check(len(out["memos"]) == len(src["memos"]), "memos count preserved")
        check(len(out["finance"]) == len(src["finance"]), "finance count preserved")
        check(len(out["operations"]) == len(src["operations"]), "operations preserved")
        check(os.path.exists(os.path.join(dst_up, "2099-01-01", "fake.txt")), "upload blob restored")
        shutil.rmtree(os.path.dirname(dst_db), ignore_errors=True)
        shutil.rmtree(dst_up, ignore_errors=True)
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_agent_create_and_journal():
    print("test_agent_create_and_journal")
    ctx, base = make_context()
    try:
        before = len(ctx.get_memos_for_variant("default"))
        ops_before = len(ctx.operations_service.get_operations_for_variant("default"))

        # Script: model asks to create an entry, then gives a final answer.
        script = [
            _FakeMessage(tool_calls=[_FakeToolCall(
                "call_1", "create_entry",
                '{"text": "Buy milk", "source": "default", "category": "Shopping", "tags": ["errand"]}',
            )]),
            _FakeMessage(content="Done — added 'Buy milk' to Shopping."),
        ]
        tools = MemoAgentTools(ctx, default_source="default")
        out = run_agent(_FakeClient(script), "deepseek-v4-flash", AGENT_SYSTEM_PROMPT,
                        [], "remember to buy milk", tools)

        check(out["reply"].startswith("Done"), "agent returns the final assistant text")
        check(len(out["actions"]) == 1 and out["actions"][0]["type"] == "create", "one create action recorded")
        after = ctx.get_memos_for_variant("default")
        check(len(after) == before + 1, "entry actually created in the store")
        check(any((m.get("description") == "Buy milk") for m in after), "created entry has the right description")
        ops_after = ctx.operations_service.get_operations_for_variant("default")
        check(len(ops_after) == ops_before + 1, "create journaled as an operation (syncs to clients)")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_agent_search_then_update():
    print("test_agent_search_then_update")
    ctx, base = make_context()
    try:
        target = ctx.get_memos_for_variant("default")[0]["id"]
        # Script: search, then update the found entry, then answer.
        script = [
            _FakeMessage(tool_calls=[_FakeToolCall("c1", "search_entries", '{"query": ""}')]),
            _FakeMessage(tool_calls=[_FakeToolCall(
                "c2", "update_entry", '{"id": "%s", "source": "default", "category": "Reclassified"}' % target)]),
            _FakeMessage(content="Updated the category."),
        ]
        tools = MemoAgentTools(ctx, default_source="default")
        out = run_agent(_FakeClient(script), "deepseek-v4-flash", AGENT_SYSTEM_PROMPT,
                        [], "reclassify the first entry", tools)
        check(any(a["type"] == "update" for a in out["actions"]), "update action recorded")
        check(ctx.memo_store.get_one(target, "default")["category"] == "Reclassified", "update persisted to the store")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_agent_cross_db():
    print("test_agent_cross_db")
    ctx, base = make_context()
    try:
        # Create a planner todo + a finance entry from the agent (default page),
        # then a cross-source search that should see items from all three stores.
        script = [
            _FakeMessage(tool_calls=[_FakeToolCall("c1", "create_entry",
                '{"text": "Renew passport", "source": "planner", "kind": "todo", "due": "2026-07-01"}')]),
            _FakeMessage(tool_calls=[_FakeToolCall("c2", "create_entry",
                '{"text": "Coffee beans", "source": "finance"}')]),
            _FakeMessage(tool_calls=[_FakeToolCall("c3", "search_entries", '{"query": ""}')]),
            _FakeMessage(content="Added a planner todo and a finance entry."),
        ]
        captured = {}
        client = _FakeClient(script)
        tools = MemoAgentTools(ctx, default_source="default")
        out = run_agent(client, "deepseek-v4-flash", AGENT_SYSTEM_PROMPT, [], "do stuff", tools)

        # planner todo landed in the planner store + journaled under planner
        planner = ctx.get_memos_for_variant("planner")
        check(any(e.get("title") == "Renew passport" and e.get("kind") == "todo" for e in planner),
              "agent created a planner todo in the planner store")
        check(len(ctx.operations_service.get_operations_for_variant("planner")) >= 1,
              "planner create journaled under variant=planner (syncs to planner clients)")
        # finance entry landed in finance
        check(any(e.get("description") == "Coffee beans" for e in ctx.get_memos_for_variant("finance")),
              "agent created a finance entry in the finance store")
        # actions carry the source
        srcs = {a.get("source") for a in out["actions"]}
        check("planner" in srcs and "finance" in srcs, "actions record the source per item")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_agent_search_recency():
    """Search must rank most-recent-first so 'latest purchase' is correct."""
    print("test_agent_search_recency")
    ctx, base = make_context()
    try:
        # Two finance entries with controlled purchase dates (older vs newer).
        ctx.memo_store.upsert({"id": "fin_old", "description": "Old gadget",
                               "category": "X", "purchaseDate": "2025-01-05",
                               "createdAt": "2025-01-05T00:00:00Z"}, "finance")
        ctx.memo_store.upsert({"id": "fin_new", "description": "Newest gizmo",
                               "category": "X", "purchaseDate": "2026-05-30",
                               "createdAt": "2026-05-30T00:00:00Z"}, "finance")
        tools = MemoAgentTools(ctx, default_source="default")
        res = tools._tool_search_entries(source="finance", limit=10)
        ents = res["entries"]
        check(all("date" in e for e in ents), "every result carries a 'date' for recency reasoning")
        dates = [e["date"] for e in ents]
        check(dates == sorted(dates, reverse=True), "finance results are most-recent-first")
        check(ents[0]["id"] == "fin_new", "the latest purchase is ranked first (not store order)")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_agent_model_resolution():
    print("test_agent_model_resolution")
    import services.agent as agent

    class _Models:
        def __init__(self, ids): self._ids = ids
        def list(self):
            return type("L", (), {"data": [type("M", (), {"id": i}) for i in self._ids]})

    class _Client:
        def __init__(self, ids, host):
            self.models = _Models(ids)
            self.base_url = type("U", (), {"host": host})()

    agent._model_cache.clear()
    c1 = _Client(["deepseek-chat", "deepseek-v4-flash", "deepseek-reasoner"], "h1")
    check(agent.resolve_agent_model(c1, "DeepSeek-V4-Flash") == "deepseek-v4-flash",
          "case/punctuation-insensitive match to the real model id")

    agent._model_cache.clear()
    c2 = _Client(["deepseek-chat", "deepseek-reasoner"], "h2")
    check(agent.resolve_agent_model(c2, "deepseek-v4-flash") == "deepseek-chat",
          "unknown model falls back to an available one (not a crash)")

    agent._model_cache.clear()
    c3 = _Client(["deepseek-v4-flash"], "h3")
    check(agent.resolve_agent_model(c3, "deepseek-v4-flash") == "deepseek-v4-flash",
          "exact id passes through")


def test_atomic_push_and_duplicate_after_edit():
    ctx, base = make_context()
    try:
        service = ctx.operations_service
        create = {"operations": [{"type": "create", "entryId": "atomic-test", "clientOpId": "atomic-create",
                                  "data": {"description": "initial", "images": [], "attachments": []}}]}
        def fail_after_materialization(op, variant):
            ctx.apply_operation_to_memos(op, variant)
            raise RuntimeError("injected failure after entry write")
        result, status = service.handle_push_operations(create, "default", fail_after_materialization)
        check(status == 500 and not result['operations'], "failed materialization has no acknowledgement")
        check(ctx.memo_store.get_one('atomic-test', 'default') is None, "failed push rolls back entry")
        check(ctx.ops_store.find_by_client_op_id('atomic-create', 'default') is None, "failed push rolls back log")
        _, status = service.handle_push_operations(create, 'default', ctx.apply_operation_to_memos)
        check(status == 200, "retry commits after rollback")
        service.handle_push_operations({"operations": [{"type": "update", "entryId": "atomic-test",
            "clientOpId": "atomic-edit", "data": {"description": "newer edit"}}]}, 'default', ctx.apply_operation_to_memos)
        service.handle_push_operations(create, 'default', ctx.apply_operation_to_memos)
        check(ctx.memo_store.get_one('atomic-test', 'default')['description'] == 'newer edit', "duplicate create cannot overwrite later edit")
        attachment = {"operations": [{"type": "addAttachment", "entryId": "atomic-test", "clientOpId": "atomic-file",
            "attachment": {"url": "/uploads/test/file.txt", "name": "file.txt"}}]}
        service.handle_push_operations(attachment, 'default', ctx.apply_operation_to_memos)
        service.handle_push_operations(attachment, 'default', ctx.apply_operation_to_memos)
        check(len(ctx.memo_store.get_one('atomic-test', 'default')['attachments']) == 1, "duplicate attachment applies once")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def _push(ctx, *ops):
    return ctx.operations_service.handle_push_operations({"operations": list(ops)}, "default", ctx.apply_operation_to_memos)


def _op(kind, entry_id, client_id, ts, **extra):
    return dict({"type": kind, "entryId": entry_id, "clientOpId": client_id, "timestamp": ts, "deviceId": "dev"}, **extra)


def test_edit_time_last_write_wins():
    print("test_edit_time_last_write_wins")
    ctx, base = make_context()
    try:
        T = 1_800_000_000_000
        _push(ctx, _op("create", "lww", "c0", T, data={"description": "first"}))
        _push(ctx, _op("update", "lww", "b-new", T + 2000, data={"description": "newer edit from B"}))
        logged_before = len(ctx.operations_service.get_operations_for_variant("default"))
        res, status = _push(ctx, _op("update", "lww", "a-old", T + 1000, data={"description": "older offline edit from A"}))
        ack = res["operations"][0]
        check(status == 200 and ack.get("stale") is True, "an older edit arriving later is acknowledged as stale")
        check(ack["entry"]["description"] == "newer edit from B", "the stale ack carries the server's current entry")
        check(ctx.memo_store.get_one("lww", "default")["description"] == "newer edit from B", "the newer edit is kept")
        check(len(ctx.operations_service.get_operations_for_variant("default")) == logged_before, "a stale edit is not logged")
        res, _ = _push(ctx, _op("update", "lww", "a-new", T + 3000, data={"description": "newest"}))
        check(not res["operations"][0].get("stale"), "a newer edit still applies")
        check(ctx.memo_store.get_one("lww", "default")["description"] == "newest", "newest edit wins")
        stored = ctx.memo_store.get_one("lww", "default")["updatedAt"]
        check(stored.startswith("2027-01-15T08:00:03"), "updatedAt records when the edit was made, not when it arrived")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_edits_and_deletes_by_edit_time():
    print("test_edits_and_deletes_by_edit_time")
    ctx, base = make_context()
    try:
        T = 1_800_000_000_000
        _push(ctx, _op("create", "del-1", "c1", T, data={"description": "note"}))
        _push(ctx, _op("delete", "del-1", "d1", T + 1000))
        check(ctx.memo_store.get_one("del-1", "default")["deletedAt"], "delete applies")
        res, _ = _push(ctx, _op("update", "del-1", "e-old", T + 500, data={"description": "edited before the delete"}))
        check(res["operations"][0].get("stale") is True, "an edit older than the delete is stale")
        check(ctx.memo_store.get_one("del-1", "default")["deletedAt"], "the note stays deleted")
        res, _ = _push(ctx, _op("update", "del-1", "e-new", T + 2000, data={"description": "edited after the delete"}))
        entry = ctx.memo_store.get_one("del-1", "default")
        check(not res["operations"][0].get("stale") and entry["deletedAt"] is None, "an edit newer than the delete restores the note")
        check(entry["description"] == "edited after the delete", "the restoring edit is applied")
        logged = ctx.operations_service.get_operations_for_variant("default")[-1]
        check(logged["data"].get("deletedAt", "missing") is None, "the logged edit carries the restore to other devices")
        _push(ctx, _op("create", "del-2", "c2", T, data={"description": "kept"}))
        _push(ctx, _op("update", "del-2", "e2", T + 3000, data={"description": "edited"}))
        res, _ = _push(ctx, _op("delete", "del-2", "d2", T + 1000))
        check(res["operations"][0].get("stale") is True and not ctx.memo_store.get_one("del-2", "default")["deletedAt"],
              "a delete older than a later edit does not remove the edited note")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_change_to_unknown_entry_is_rejected():
    print("test_change_to_unknown_entry_is_rejected")
    ctx, base = make_context()
    try:
        before = len(ctx.operations_service.get_operations_for_variant("default"))
        res, status = _push(ctx, _op("update", "never-existed", "u1", 1_800_000_000_000, data={"description": "x"}))
        check(status == 200 and res["operations"] == [], "nothing is acknowledged as saved")
        check(res["rejected"] == [{"clientOpId": "u1", "entryId": "never-existed", "reason": "not_found"}], "the change is reported as rejected")
        check(len(ctx.operations_service.get_operations_for_variant("default")) == before, "a rejected change is not logged")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_crud_writes_one_entry():
    print("test_crud_writes_one_entry")
    ctx, base = make_context()
    try:
        app = Flask(__name__)
        app.register_blueprint(create_memo_blueprint(ctx))
        client = app.test_client()
        def no_full_rewrite(*_a, **_k):
            raise AssertionError("save_all must not run for a single-entry change")
        ctx.memo_store.save_all = no_full_rewrite
        resp = client.post("/api/memos", json={"description": "one row", "category": "c", "tags": []})
        check(resp.status_code == 201, "create writes one row")
        new_id = resp.get_json()["id"]
        check(client.put(f"/api/memos/{new_id}", json={"description": "edited"}).status_code == 200, "edit writes one row")
        check(ctx.memo_store.get_one(new_id, "default")["description"] == "edited", "edit is stored")
        check(client.delete(f"/api/memos/{new_id}").status_code == 200, "delete writes one row")
        check(ctx.memo_store.get_one(new_id, "default")["deletedAt"], "soft delete is stored")
        check(client.post(f"/api/memos/{new_id}/restore").status_code == 200, "restore writes one row")
        check(ctx.memo_store.get_one(new_id, "default")["deletedAt"] is None, "restore is stored")
        check(client.delete(f"/api/memos/{new_id}?permanent=true").status_code == 200, "permanent delete")
        check(ctx.memo_store.get_one(new_id, "default") is None, "row removed")
        check(client.put("/api/memos/nope", json={}).status_code == 404, "unknown entry is 404")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_paged_full_sync():
    print("test_paged_full_sync")
    ctx, base = make_context()
    try:
        service = ctx.operations_service
        entries = [{"id": f"p{i:03d}", "description": f"entry {i}"} for i in range(25)]
        service.reseat_snapshot_from_entries(entries, "default")
        for i in range(3):
            _push(ctx, _op("create", f"after{i}", f"pa{i}", 1_800_000_000_000 + i, data={"description": "later"}))
        legacy, _ = service.handle_pull_operations(-1, "default")
        check(len(legacy["snapshot"]["entries"]) == 25 and len(legacy["operations"]) == 3, "unpaged pull is unchanged for older app versions")
        got, offset, snap_id, pages = [], 0, None, 0
        while True:
            page, _ = service.handle_pull_operations(-1, "default", limit=10, snapshot_offset=offset, snapshot_id=snap_id)
            pages += 1
            snap_id = page["snapshot"]["snapshotId"]
            got += page["snapshot"]["entries"]
            if page["snapshotNextOffset"] is None:
                break
            offset = page["snapshotNextOffset"]
        check(pages == 3 and [e["id"] for e in got] == [e["id"] for e in entries], "the snapshot arrives in pages, in order")
        check([o["entryId"] for o in page["operations"]] == ["after0", "after1", "after2"] and page["hasMore"] is False,
              "the last snapshot page carries the following operations")
        ops_page, _ = service.handle_pull_operations(snap_id, "default", limit=2)
        check(len(ops_page["operations"]) == 2 and ops_page["hasMore"] is True, "operations are paged too")
        rest, _ = service.handle_pull_operations(ops_page["latestOpId"], "default", limit=2)
        check(len(rest["operations"]) == 1 and rest["hasMore"] is False, "the last operations page ends the pull")
        stale, _ = service.handle_pull_operations(-1, "default", limit=10, snapshot_offset=10, snapshot_id=snap_id - 1)
        check(stale.get("snapshotChanged") is True, "a snapshot replaced mid-paging tells the device to start over")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_compaction_reclaims_disk_space():
    print("test_compaction_reclaims_disk_space")
    ctx, base = make_context()
    try:
        filler = "x" * 4000
        for i in range(400):
            _push(ctx, _op("create", f"big{i}", f"big{i}", 1_000_000_000_000 + i, data={"description": filler}))
        res, status = ctx.operations_service.handle_compact_operations({"keepDays": 0}, "default")
        free = ctx.db.fetchone("PRAGMA freelist_count")[0]
        check(status == 200 and res.get("spaceReclaimed") is True, "compaction reclaims space")
        check(free == 0, "no free pages are left behind")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_safe_flag_survives_the_server():
    print("test_safe_flag_survives_the_server")
    ctx, base = make_context()
    try:
        _, status = ctx.operations_service.handle_push_operations({"operations": [
            {"type": "create", "entryId": "safe-1", "clientOpId": "s1", "timestamp": 1760000000000,
             "data": {"description": "secret", "category": "x", "tags": [], "images": [], "attachments": [], "safe": True}},
            {"type": "create", "entryId": "plain-1", "clientOpId": "s2", "timestamp": 1760000000000,
             "data": {"description": "plain", "category": "x", "tags": [], "images": [], "attachments": []}},
        ]}, "default", ctx.apply_operation_to_memos)
        check(status == 200, "push with a Safe note accepted")
        check(ctx.memo_store.get_one("safe-1", "default").get("safe") is True, "server keeps the Safe flag")
        check("safe" not in ctx.memo_store.get_one("plain-1", "default"), "ordinary notes carry no flag")
        ctx.operations_service.handle_push_operations({"operations": [
            {"type": "update", "entryId": "safe-1", "clientOpId": "s3", "timestamp": 1760000001000, "data": {"safe": False}}]},
            "default", ctx.apply_operation_to_memos)
        check("safe" not in ctx.memo_store.get_one("safe-1", "default"), "moving out of Safe clears it")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_claude_on_the_server():
    print("test_claude_on_the_server")
    import types
    from services import claude_llm, chat_reply
    calls = []

    def reply(text, stop="end_turn"):
        return types.SimpleNamespace(stop_reason=stop, content=[types.SimpleNamespace(type="thinking", thinking=""),
                                                                types.SimpleNamespace(type="text", text=text)])

    class OldSdkClient:  # an SDK without the fallbacks parameter
        def __init__(self, api_key=None):
            self.messages = types.SimpleNamespace(create=lambda **kw: (calls.append(("plain", kw)), reply("hi"))[1])
            self.beta = types.SimpleNamespace(messages=types.SimpleNamespace(create=lambda **kw: (calls.append(("beta", kw)), reply("hi"))[1]))

    class NewSdkClient(OldSdkClient):
        def __init__(self, api_key=None):
            super().__init__(api_key)
            def beta_create(*, betas=None, fallbacks=None, **kw):
                calls.append(("beta", dict(kw, betas=betas, fallbacks=fallbacks)))
                return reply("hi")
            self.beta = types.SimpleNamespace(messages=types.SimpleNamespace(create=beta_create))

    real = claude_llm.anthropic.Anthropic
    try:
        claude_llm.anthropic.Anthropic = OldSdkClient
        out = claude_llm.complete("sk-ant", None, "Be brief.", [
            {"role": "assistant", "content": "dropped: Claude starts with the user"},
            {"role": "user", "content": "one"}, {"role": "user", "content": "two"}])
        kind, kw = calls[-1]
        check(out == "hi" and kind == "plain", "older SDK: plain create, text blocks only")
        check(kw["model"] == "claude-sonnet-5-5" and kw["max_tokens"] == 16000 and "temperature" not in kw, "default model, room for thinking, no sampling params")
        check(kw["messages"] == [{"role": "user", "content": "one\n\ntwo"}] and kw["system"] == "Be brief.", "turns start with the user and alternate")
        claude_llm.anthropic.Anthropic = NewSdkClient
        claude_llm.complete("sk-ant", "claude-opus-5-5", "", [{"role": "user", "content": "hi"}])
        kind, kw = calls[-1]
        check(kind == "beta" and kw["fallbacks"] == "default" and kw["betas"] == ["server-side-fallback-2026-07-01"], "SDK with fallbacks: default refusal fallback on")
        claude_llm.complete("sk-ant", "claude-haiku-5-5", "", [{"role": "user", "content": "hi"}])
        check(calls[-1][0] == "plain", "models without the fallback stay plain")
        img = os.path.join(tempfile.mkdtemp(), "x.png")
        open(img, "wb").write(b"\x89PNG fake")
        claude_llm.complete("sk-ant", None, "", [{"role": "user", "content": "what is this"}], images=[img])
        content = calls[-1][1]["messages"][-1]["content"]
        check(content[0]["type"] == "image" and content[0]["source"]["media_type"] == "image/png" and content[-1] == {"type": "text", "text": "what is this"}, "images go first in the last user turn")
        class Refuses(OldSdkClient):
            def __init__(self, api_key=None):
                super().__init__(api_key)
                self.messages = types.SimpleNamespace(create=lambda **kw: reply("", stop="refusal"))
        claude_llm.anthropic.Anthropic = Refuses
        try:
            claude_llm.complete("sk-ant", "claude-haiku-5-5", "", [{"role": "user", "content": "x"}])
            check(False, "a refusal raises")
        except ValueError as e:
            check("declined" in str(e), "a refusal raises")
        claude_llm.anthropic.Anthropic = OldSdkClient
        text = chat_reply.generate_llm_reply([{"role": "system", "content": "ctx lines"}], "hello", provider="anthropic", model=None,
                                             system_prompt="You are kind.", openai_api_key=None, gemini_api_key=None, anthropic_api_key="sk-ant")
        kw = calls[-1][1]
        check(text == "hi" and kw["system"] == "You are kind.\n\nctx lines" and kw["messages"][-1]["content"] == "hello", "chat replies route to Claude with context in the system prompt")
        no_key = chat_reply.generate_llm_reply([], "x", provider="anthropic", model=None, system_prompt="", openai_api_key=None, gemini_api_key=None)
        check("Claude API key not configured" in no_key, "no key reports clearly")
    finally:
        claude_llm.anthropic.Anthropic = real


def test_vault_collection_is_opaque_and_separate():
    print("test_vault_collection_is_opaque_and_separate")
    ctx, base = make_context()
    try:
        from api import create_config_blueprint
        app = Flask(__name__)
        app.register_blueprint(create_config_blueprint(ctx))
        app.register_blueprint(create_operations_blueprint(ctx))
        client = app.test_client()
        config = client.get("/api/config").get_json()
        check("vault" in config.get("collections", []), "config lists the vault collection")
        memos_before = {m["id"] for m in ctx.get_memos_for_variant("default")}
        doc = {"kind": "item", "v": 1, "cipher": "TUVNT1JBAQAC-not-readable"}
        r = client.post("/api/operations/push?variant=vault", json={"operations": [
            {"type": "create", "entryId": "v_1", "clientOpId": "vc1", "timestamp": 1760000000000, "data": doc}]})
        check(r.status_code == 200 and r.get_json()["operations"][0]["serverOpId"], "vault push accepted")
        stored = ctx.vault_store.get_one("v_1", "vault")
        check(stored is not None and stored.get("cipher") == doc["cipher"], "server stores the ciphertext as-is")
        check({m["id"] for m in ctx.get_memos_for_variant("default")} == memos_before, "notes untouched by a vault push")
        check(ctx.planner_store.get_one("v_1", "planner") is None, "planner untouched by a vault push")
        pulled = client.get("/api/operations/pull?variant=vault&sinceOpId=0").get_json()
        check(any(op.get("entryId") == "v_1" for op in pulled.get("operations", [])), "vault pull returns the vault op")
        default_pull = client.get("/api/operations/pull?variant=default&sinceOpId=0").get_json()
        check(not any(op.get("entryId") == "v_1" for op in default_pull.get("operations", [])), "notes pull never sees vault ops")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_server_ai_step():
    """'Your server's AI': one tool step with the server's key; the app runs the tools."""
    print("test_server_ai_step")
    import types
    from services import ai_step, claude_llm
    from api import create_config_blueprint
    from api.chat_routes import create_chat_blueprint
    ctx, base = make_context()
    real_sdk = claude_llm.anthropic.Anthropic
    try:
        app = Flask(__name__)
        app.register_blueprint(create_config_blueprint(ctx))
        app.register_blueprint(create_chat_blueprint(ctx))
        client = app.test_client()
        ctx.get_llm_config = lambda: {"provider": "anthropic", "anthropic_api_key": ""}
        ctx.anthropic_api_key = None
        check(client.get("/api/config").get_json()["ai"] == {"available": False}, "config: no server AI without a key")
        r = client.post("/api/ai/step", json={"messages": [{"role": "user", "content": "hi"}]})
        check(r.status_code == 400 and "no AI" in r.get_json()["message"], "step without a server AI explains")
        ctx.get_llm_config = lambda: {"provider": "anthropic", "anthropic_api_key": "sk-ant-server"}
        check(client.get("/api/config").get_json()["ai"] == {"available": True, "vision": True}, "config: server AI on, never the key")

        calls = []

        class Block(types.SimpleNamespace):
            def model_dump(self, exclude_none=False):
                return {k: v for k, v in vars(self).items() if not (exclude_none and v is None)}

        class Fake:
            def __init__(self, api_key=None):
                def create(**kw):
                    if "tools" not in kw:  # the background chat summarizer, not this test
                        return types.SimpleNamespace(stop_reason="end_turn", content=[Block(type="text", text="summary")])
                    calls.append(kw)
                    if len(calls) == 1:
                        return types.SimpleNamespace(stop_reason="tool_use", content=[
                            Block(type="thinking", thinking="", signature="sig"), Block(type="text", text="Looking."),
                            Block(type="tool_use", id="tu_1", name="search", input={"query": "ramen"})])
                    return types.SimpleNamespace(stop_reason="end_turn", content=[Block(type="text", text="Found it.")])
                self.messages = types.SimpleNamespace(create=create)
                self.beta = types.SimpleNamespace(messages=types.SimpleNamespace(create=create))
        claude_llm.anthropic.Anthropic = Fake
        tools = [{"name": "search", "description": "Search.", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}}}]
        first = client.post("/api/ai/step", json={"system": "Be brief.", "tools": tools,
                                                  "messages": [{"role": "user", "content": "ramen?", "images": ["data:image/jpeg;base64,AAAA"]}]}).get_json()
        check(first["calls"] == [{"id": "tu_1", "name": "search", "args": {"query": "ramen"}}], "step returns the tool calls")
        check(calls[0]["tools"][0]["input_schema"]["properties"]["query"] and calls[0]["system"] == "Be brief.", "tools go to Claude with their schema")
        check(calls[0]["messages"][0]["content"][0]["type"] == "image", "the photo reaches a vision model")
        msgs = [{"role": "user", "content": "ramen?"},
                {"role": "assistant", "content": first["text"], "calls": first["calls"], "raw": first["raw"]},
                {"role": "tool", "id": "tu_1", "name": "search", "result": {"count": 1}}]
        second = client.post("/api/ai/step", json={"tools": tools, "messages": msgs, "final": True}).get_json()
        sent = calls[1]["messages"]
        check(sent[1]["content"][0] == {"type": "thinking", "thinking": "", "signature": "sig"}, "the assistant turn goes back exactly, thinking included")
        check(sent[2]["content"][0]["type"] == "tool_result" and sent[2]["content"][0]["tool_use_id"] == "tu_1", "tool results follow as tool_result blocks")
        check(calls[1]["tool_choice"] == {"type": "none"} and second["text"] == "Found it." and second["calls"] == [], "the final step answers without tools")

        # OpenAI-compatible (e.g. a self-hosted Ollama through Custom).
        ctx.get_llm_config = lambda: {"provider": "custom", "custom_api_key": "k", "custom_base_url": "http://127.0.0.1:9/v1", "model": "qwen3"}
        check(client.get("/api/config").get_json()["ai"] == {"available": True, "vision": False}, "a custom server AI is chat-only for photos")
        from services.llm import vision_capable
        check(vision_capable("deepseek", None) and vision_capable("deepseek", "deepseek-flash") and not vision_capable("deepseek", "deepseek-v4-pro"),
              "DeepSeek Flash reads photos, Pro does not")
        from services.llm import openai_sampling
        check(openai_sampling("gpt-6-luna", 0.7, 100) == {"max_completion_tokens": 100} and openai_sampling("gpt-4o", 0.7, None) == {"temperature": 0.7},
              "OpenAI reasoning models get no temperature and max_completion_tokens")
        seen = []

        class FakeOpenAi:
            def __init__(self):
                fn = types.SimpleNamespace(name="search", arguments='{"query": "tofu"}')
                msg = types.SimpleNamespace(content="", tool_calls=[types.SimpleNamespace(id="call_1", function=fn)])
                self.chat = types.SimpleNamespace(completions=types.SimpleNamespace(
                    create=lambda **kw: (seen.append(kw), types.SimpleNamespace(choices=[types.SimpleNamespace(message=msg)]))[1]))
        import services.agent as agent
        real_make, real_resolve = agent.make_agent_client, agent.resolve_agent_model
        agent.make_agent_client = lambda *a, **k: FakeOpenAi()
        agent.resolve_agent_model = lambda c, m: m
        try:
            out = client.post("/api/ai/step", json={"tools": tools, "messages": [{"role": "user", "content": "tofu", "images": ["data:image/png;base64,AA"]}]}).get_json()
        finally:
            agent.make_agent_client, agent.resolve_agent_model = real_make, real_resolve
        check(out["calls"][0]["args"] == {"query": "tofu"} and out["raw"]["tool_calls"][0]["id"] == "call_1", "OpenAI-compatible calls come back with the raw turn")
        check(seen[0]["tools"][0]["function"]["name"] == "search" and seen[0]["messages"][0]["content"] == "tofu", "no photo sent to a chat-only model")
        ctx.get_llm_config = lambda: {"provider": "openai", "openai_api_key": "sk-o"}
        seen.clear()
        agent.make_agent_client = lambda *a, **k: FakeOpenAi()
        agent.resolve_agent_model = lambda c, m: m
        try:
            client.post("/api/ai/step", json={"tools": tools, "messages": [{"role": "user", "content": "x"}]})
        finally:
            agent.make_agent_client, agent.resolve_agent_model = real_make, real_resolve
        check(seen[0]["model"] == "gpt-6-luna" and seen[0]["reasoning_effort"] == "none", "server OpenAI default is gpt-6-luna; tools go with reasoning_effort none")
    finally:
        ctx.get_llm_config = lambda: {}
        claude_llm.anthropic.Anthropic = real_sdk
        shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    test_server_ai_step()
    test_atomic_push_and_duplicate_after_edit()
    test_incremental_apply_no_clobber()
    test_dedup_by_client_op_id()
    test_crud_emits_operation()
    test_edit_time_last_write_wins()
    test_edits_and_deletes_by_edit_time()
    test_change_to_unknown_entry_is_rejected()
    test_crud_writes_one_entry()
    test_paged_full_sync()
    test_compaction_reclaims_disk_space()
    test_vault_collection_is_opaque_and_separate()
    test_safe_flag_survives_the_server()
    test_claude_on_the_server()
    test_zip_roundtrip()
    test_agent_create_and_journal()
    test_agent_search_then_update()
    test_agent_cross_db()
    test_agent_search_recency()
    test_agent_model_resolution()
    print(f"\nAll backend sync/interchange/agent checks passed ({_checks} assertions).")

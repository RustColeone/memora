"""
Backend HTTP API smoke tests — drives the real Flask blueprints against an
isolated temp DB (the live data/memosystem.db is never touched).

Run:  python tests/test_backend_api.py
Exits non-zero on the first failure.
"""

import io
import os
import sys
import zipfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

import json

from flask import Flask, jsonify, request

from api import (
    create_chat_blueprint,
    create_config_blueprint,
    create_export_blueprint,
    create_memo_blueprint,
    create_operations_blueprint,
    create_upload_blueprint,
)
from api.upload_routes import UPLOAD_COOKIE
from services.sync_auth import SyncAuth
# Reuse the isolated-context fixture from the sync suite.
from test_backend_sync import make_context

_checks = 0


def check(cond, label):
    global _checks
    _checks += 1
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}")
        raise SystemExit(1)


def make_client(ctx):
    app = Flask(__name__)
    app.config["UPLOAD_FOLDER"] = ctx.upload_folder
    app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024
    app.register_blueprint(create_config_blueprint(ctx))
    app.register_blueprint(create_memo_blueprint(ctx))
    app.register_blueprint(create_operations_blueprint(ctx))
    app.register_blueprint(create_export_blueprint(ctx))
    app.register_blueprint(create_chat_blueprint(ctx))
    return app.test_client()


def test_config_and_memo_crud():
    print("test_config_and_memo_crud")
    ctx, base = make_context()
    try:
        c = make_client(ctx)

        r = c.get("/api/config")
        check(r.status_code == 200, "GET /api/config -> 200")
        check("server" in (r.get_json() or {}), "config exposes a 'server' flag")

        r = c.get("/api/memos")
        check(r.status_code == 200 and isinstance(r.get_json(), list), "GET /api/memos -> list")
        n0 = len(r.get_json())

        image_meta = {"uploads/2026-08/photo.jpg": {"embeddedBackup": "ZXhpZg=="}}
        r = c.post("/api/memos", json={"description": "api test", "category": "T", "tags": ["x"], "imageMeta": image_meta})
        check(r.status_code == 201, "POST /api/memos -> 201")
        new_id = r.get_json()["id"]
        check(r.get_json().get("imageMeta") == image_meta, "per-image metadata persisted on create")
        check(len(c.get("/api/memos").get_json()) == n0 + 1, "memo count increased by 1")

        r = c.put(f"/api/memos/{new_id}", json={"description": "api edited"})
        check(r.status_code == 200, "PUT /api/memos/<id> -> 200")
        edited = ctx.memo_store.get_one(new_id, "default")
        check(edited["description"] == "api edited", "edit persisted")

        r = c.delete(f"/api/memos/{new_id}")
        check(r.status_code == 200, "DELETE /api/memos/<id> -> 200")
        check(ctx.memo_store.get_one(new_id, "default")["deletedAt"] is not None, "soft-deleted")
    finally:
        import shutil
        shutil.rmtree(base, ignore_errors=True)


def test_operations_push_pull():
    print("test_operations_push_pull")
    ctx, base = make_context()
    try:
        c = make_client(ctx)
        payload = {"operations": [
            {"type": "create", "entryId": "api-op-1", "clientOpId": "api-1",
             "data": {"description": "via op", "category": "c", "tags": []}},
        ]}
        r = c.post("/api/operations/push", json=payload)
        check(r.status_code == 200, "POST /api/operations/push -> 200")
        check(r.get_json()["operations"][0]["duplicate"] is False, "op accepted")

        r = c.get("/api/operations/pull?sinceOpId=0")
        check(r.status_code == 200, "GET /api/operations/pull -> 200")
        ops = r.get_json()["operations"]
        check(any(o["entryId"] == "api-op-1" for o in ops), "pushed op is pulled back")
    finally:
        import shutil
        shutil.rmtree(base, ignore_errors=True)


def test_db_export_import():
    print("test_db_export_import")
    ctx, base = make_context()
    try:
        c = make_client(ctx)

        r = c.get("/api/db/export?format=zip")
        check(r.status_code == 200 and r.mimetype == "application/zip", "export?format=zip -> zip")
        with zipfile.ZipFile(io.BytesIO(r.data)) as zf:
            check("memosystem.json" in zf.namelist(), "zip contains the JSON envelope")
        zip_bytes = r.data

        r = c.get("/api/db/export?format=json")
        check(r.status_code == 200 and r.mimetype == "application/json", "export?format=json -> json")

        # Re-import the ZIP (merge) — idempotent, must not error.
        r = c.post(
            "/api/db/import",
            data={"file": (io.BytesIO(zip_bytes), "memosystem_backup.zip"), "mode": "merge"},
            content_type="multipart/form-data",
        )
        check(r.status_code == 200 and r.get_json().get("success"), "POST /api/db/import (zip) -> success")
    finally:
        import shutil
        shutil.rmtree(base, ignore_errors=True)


def test_agent_endpoint_graceful():
    print("test_agent_endpoint_graceful")
    ctx, base = make_context()
    try:
        # The old direct-write agent moved to the Agent API (tests/test_agent_api.py);
        # its route stays only to point callers there.
        ctx.openai_api_key = ctx.deepseek_api_key = ctx.gemini_api_key = None
        ctx.save_llm_config({"provider": "gemini"})
        c = make_client(ctx)

        r = c.post("/api/chat/agent", json={"message": "hello"})
        check(r.status_code == 410 and "/api/agent/v1/chat" in r.get_json()["message"], "POST /api/chat/agent -> 410, moved to the Agent API")
    finally:
        import shutil
        shutil.rmtree(base, ignore_errors=True)


def _make_gated_client(ctx):
    """A Flask app wired with the same sync-auth before_request as server.py."""
    app = Flask(__name__)
    app.config["UPLOAD_FOLDER"] = ctx.upload_folder
    app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024

    @app.before_request
    def _gate():
        if not ctx.sync_auth.required:
            return None
        path = request.path or ""
        if not path.startswith("/api/") or path == "/api/config":
            return None
        if not ctx.sync_auth.check(request.headers.get("X-Sync-Password", "")):
            return jsonify({"error": "auth_required"}), 401
        return None

    app.register_blueprint(create_config_blueprint(ctx))
    app.register_blueprint(create_memo_blueprint(ctx))
    app.register_blueprint(create_upload_blueprint(ctx, app))
    return app.test_client()


def test_sync_auth_gate():
    print("test_sync_auth_gate")
    ctx, base = make_context()
    try:
        # Configure a password the way the docs describe: data/sync_auth.json.
        with open(os.path.join(ctx.data_dir, "sync_auth.json"), "w", encoding="utf-8") as f:
            json.dump({"password": "s3cret"}, f)
        ctx.sync_auth = SyncAuth(ctx.data_dir)
        c = _make_gated_client(ctx)

        r = c.get("/api/config")
        check(r.status_code == 200, "GET /api/config open even when gated")
        check(r.get_json().get("authRequired") is True, "config advertises authRequired=true")

        check(c.get("/api/memos").status_code == 401, "GET /api/memos -> 401 without password")
        check(c.get("/api/memos", headers={"X-Sync-Password": "wrong"}).status_code == 401,
              "wrong password -> 401")
        r = c.get("/api/memos", headers={"X-Sync-Password": "s3cret"})
        check(r.status_code == 200 and isinstance(r.get_json(), list),
              "correct password -> 200 + list")

        # uploads: blocked without credentials, allowed via header / cookie / token
        up = "/uploads/2099-01-01/fake.txt"
        check(c.get(up).status_code == 401, "GET /uploads -> 401 without credentials")
        check(c.get(up, headers={"X-Sync-Password": "s3cret"}).status_code == 200,
              "GET /uploads -> 200 with header")
        token = ctx.sync_auth.make_upload_token()
        check(c.get(up + "?t=" + token).status_code == 200, "GET /uploads -> 200 with ?t= token")
        check(c.get(up + "?t=999.deadbeef").status_code == 401, "GET /uploads -> 401 with bad token")

        # session endpoint mints the image cookie (only reachable when authed)
        r = c.post("/api/uploads/session", headers={"X-Sync-Password": "s3cret"})
        check(r.status_code == 200, "POST /api/uploads/session -> 200")
        check(UPLOAD_COOKIE in r.headers.get("Set-Cookie", ""), "session sets the upload cookie")
    finally:
        import shutil
        shutil.rmtree(base, ignore_errors=True)


def test_sync_auth_open_when_unset():
    print("test_sync_auth_open_when_unset")
    ctx, base = make_context()
    try:
        ctx.sync_auth = SyncAuth(ctx.data_dir)  # no file, no env -> open
        check(ctx.sync_auth.required is False, "no password configured -> not required")
        c = _make_gated_client(ctx)
        check(c.get("/api/memos").status_code == 200, "GET /api/memos -> 200 (open, no gate)")
        check(c.get("/api/config").get_json().get("authRequired") is False,
              "config advertises authRequired=false")
    finally:
        import shutil
        shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    test_config_and_memo_crud()
    test_operations_push_pull()
    test_db_export_import()
    test_agent_endpoint_graceful()
    test_sync_auth_gate()
    test_sync_auth_open_when_unset()
    print(f"\nAll backend API smoke checks passed ({_checks} assertions).")

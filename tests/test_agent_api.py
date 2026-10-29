"""
The Agent API (backend/api/agent_routes.py) through the real server app:
per-agent tokens instead of the sync password, per-page read/propose/write,
proposals that arrive in the app as cards (through the sync log), Safe notes
never shown, revocation, and the plain-language chat whose changes become
cards. Runs on a temporary data folder.
"""
import json
import os
import shutil
import sys
import tempfile

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BASE = tempfile.mkdtemp(prefix="memo_agent_api_")
os.makedirs(os.path.join(BASE, "data"), exist_ok=True)
os.makedirs(os.path.join(BASE, "uploads"), exist_ok=True)
with open(os.path.join(BASE, "data", "sync_auth.json"), "w", encoding="utf-8") as f:
    json.dump({"password": "owner-pw"}, f)
os.environ["MEMO_BASE_DIR"] = BASE
os.environ["MEMO_APP_DIR"] = REPO
os.environ["MEMO_DATA_DIR"] = os.path.join(BASE, "data")
os.environ["MEMO_UPLOAD_DIR"] = os.path.join(BASE, "uploads")
os.environ.pop("MEMO_SYNC_PASSWORD", None)
sys.path.insert(0, os.path.join(REPO, "backend"))

from backend_context import BackendContext  # noqa: E402
BackendContext._start_background_summarization = lambda self: None   # no real AI calls in tests
import server  # noqa: E402
from services import ai_step  # noqa: E402

_checks = 0


def check(cond, label):
    global _checks
    _checks += 1
    print(("  ok   " if cond else "  FAIL ") + label)
    if not cond:
        raise SystemExit(1)


def main():
    print("test_agent_api")
    app = server.app
    ctx = app.memora_context
    c = app.test_client()
    owner = {"X-Sync-Password": "owner-pw"}
    try:
        # Seed through the sync log: notes (one Safe), a purchase, a to-do.
        ops = [
            {"type": "create", "entryId": "n1", "clientOpId": "s1", "timestamp": 1760000000000, "data": {"description": "Mailbox rules note", "category": "Work", "tags": ["mail"], "images": [], "attachments": []}},
            {"type": "create", "entryId": "n2", "clientOpId": "s2", "timestamp": 1760000000000, "data": {"description": "Secret mail password", "category": "Private", "tags": [], "images": [], "attachments": [], "safe": True}},
        ]
        check(c.post("/api/operations/push?variant=default", json={"operations": ops}, headers=owner).status_code == 200, "seed notes")
        c.post("/api/operations/push?variant=finance", json={"operations": [{"type": "create", "entryId": "f1", "clientOpId": "s3", "timestamp": 1760000000000,
            "data": {"description": "Old receipt", "category": "Food", "tags": [], "images": [], "attachments": [], "total": 12.5, "purchaseDate": "2026-10-01"}}]}, headers=owner)

        # A purchase's store, payment and notes, and a tax rate, survive the server.
        c.post("/api/operations/push?variant=finance", json={"operations": [{"type": "create", "entryId": "f2", "clientOpId": "s4", "timestamp": 1760000000000,
            "data": {"description": "Ralphs", "category": "Groceries", "tags": [], "images": [], "attachments": [], "total": 14.25, "tax": "8.25%", "purchaseDate": "2026-10-14",
                     "store": "Ralphs", "paidWith": "card", "notes": "weekly shop",
                     "items": [{"name": "Milk", "amount": 2, "unitPrice": 4.29, "totalPrice": 8.58}, {"name": "Savings", "amount": 1, "unitPrice": -2, "totalPrice": -2, "kind": "discount"}]}}]}, headers=owner)
        f2 = ctx.memo_store.get_one("f2", "finance")
        check(f2 and f2.get("store") == "Ralphs" and f2.get("paidWith") == "card" and f2.get("notes") == "weekly shop", "store, payment and notes are kept")
        check(f2.get("tax") == "8.25%" and f2["items"][1].get("kind") == "discount", "a tax rate and a discount line are kept as sent")
        listed_fin = c.get("/api/memos?variant=finance", headers=owner).get_json()
        rows = listed_fin if isinstance(listed_fin, list) else (listed_fin.get("memos") or listed_fin.get("entries") or [])
        check(any(r.get("id") == "f2" and r.get("store") == "Ralphs" for r in rows), "devices read the details back")

        # Owner endpoints need the sync password; the Agent API needs a token instead.
        check(c.get("/api/agent-tokens").status_code == 401, "token list needs the sync password")
        r = c.post("/api/agent-tokens", headers=owner, json={"name": "Mailbox receipts", "scopes": {"spending": "propose", "notes": "read", "bogus": "write"}})
        check(r.status_code == 200 and r.get_json()["token"].startswith("mk_"), "owner creates a token (shown once)")
        token, rec = r.get_json()["token"], r.get_json()["record"]
        check(rec["scopes"] == {"spending": "propose", "notes": "read"}, "unknown pages are dropped")
        listed = c.get("/api/agent-tokens", headers=owner).get_json()["tokens"]
        check(len(listed) == 1 and "hash" not in listed[0] and token not in json.dumps(listed), "the list never shows the token or its hash")
        auth = {"Authorization": "Bearer " + token}
        check(c.get("/api/agent/v1/me").status_code == 401, "no token -> 401")
        check(c.get("/api/agent/v1/me", headers={"Authorization": "Bearer mk_wrong"}).status_code == 401, "wrong token -> 401")
        check(c.get("/api/agent/v1/me", headers=owner).status_code == 401, "the sync password is not an agent token")
        me = c.get("/api/agent/v1/me", headers=auth)
        check(me.status_code == 200 and me.get_json()["name"] == "Mailbox receipts", "a token works without the sync password")

        # Reading: only allowed pages; Safe notes never.
        found = c.get("/api/agent/v1/search?q=mail&page=notes", headers=auth).get_json()
        ids = [i["id"] for i in found["items"]]
        check("n1" in ids and "n2" not in ids, "search finds notes but never Safe ones")
        check(c.get("/api/agent/v1/items/notes/n2", headers=auth).status_code == 404, "a Safe note cannot be opened")
        check(c.get("/api/agent/v1/search?page=plans", headers=auth).status_code == 403, "a page left out cannot be read")

        # Proposals: cards in the agent's thread, through the sync log.
        prop = {"message": "Found a receipt in your mailbox.", "actions": [
            {"type": "create", "page": "spending", "items": [{"description": "Menya Kouji", "total": "31.85", "category": "Food", "date": "2026-10-17", "deletedAt": "evil", "id": "x"}]},
            {"type": "update", "page": "spending", "ids": ["f1"], "change": {"addTags": ["receipt"], "evil": 1}}]}
        r = c.post("/api/agent/v1/proposals", headers=auth, json=prop)
        check(r.status_code == 200 and r.get_json()["cards"] == 2, "a proposal with two cards is accepted")
        mid = r.get_json()["messageId"]
        msg = ctx.messages_store.get_one(mid, "messages")
        check(msg and msg["chatId"] == "agent_" + rec["id"] and [a["status"] for a in msg["actions"]] == ["pending", "pending"], "the message holds pending cards")
        item = msg["actions"][0]["items"][0]
        check(item == {"description": "Menya Kouji", "total": 31.85, "tax": 0.0, "category": "Food", "purchaseDate": "2026-10-17", "tags": [], "items": []}, "only known fields reach a card")
        check(msg["actions"][1]["change"] == {"addTags": ["receipt"]}, "unknown change fields are dropped")
        contact = ctx.contacts_store.get_one("agent_" + rec["id"], "contacts")
        check(contact and contact["kind"] == "agent" and contact["name"] == "Mailbox receipts", "the agent appears as a contact")
        pulled = c.get("/api/operations/pull?variant=messages&sinceOpId=0", headers=owner).get_json()
        check(any(op.get("entryId") == mid for op in pulled.get("operations", [])), "devices pull the proposal like any synced change")
        check(ctx.memo_store.get_one("f1", "finance").get("tags") == [], "nothing changed before a tap")
        r = c.post("/api/agent/v1/proposals", headers=auth, json={"actions": [{"type": "create", "page": "notes", "items": [{"text": "x"}]}]})
        check(r.status_code == 400 and "may not propose" in r.get_json()["message"], "read-only pages refuse proposals")
        check(c.post("/api/agent/v1/proposals", headers=auth, json={"actions": [{"type": "drop-table", "page": "spending"}]}).status_code == 400, "unknown action types are refused")

        # Direct writes only with write.
        check(c.post("/api/agent/v1/entries", headers=auth, json={"page": "spending", "item": {"description": "x", "total": 1}}).status_code == 403, "propose is not write")
        w = c.post("/api/agent-tokens", headers=owner, json={"name": "Todo bot", "scopes": {"plans": "write"}}).get_json()
        r = c.post("/api/agent/v1/entries", headers={"Authorization": "Bearer " + w["token"]}, json={"page": "plans", "item": {"title": "Call the bank", "due": "2026-10-22"}})
        check(r.status_code == 200, "write scope adds an item directly")
        todo = ctx.planner_store.get_one(r.get_json()["id"], "planner")
        check(todo["title"] == "Call the bank" and todo["kind"] == "todo" and todo["done"] is False and todo["source"] == "agent:Todo bot", "the item is marked with its agent")

        # Plain language through the server's AI: changes become cards, never writes.
        real_ready, real_step = ai_step.ready, ai_step.step
        seen = []
        def fake_step(_ctx, payload):
            seen.append(payload)
            if len(seen) == 1:
                return {"text": "", "calls": [{"id": "c1", "name": "create_entry", "args": {"text": "Taxi to airport", "source": "finance"}},
                                                {"id": "c2", "name": "delete_entry", "args": {"id": "f1", "source": "finance"}}], "raw": None}
            return {"text": "Proposed a purchase and a removal.", "calls": [], "raw": None}
        ai_step.ready, ai_step.step = (lambda _ctx: True), fake_step
        try:
            before = len(ctx.get_memos_for_variant("finance"))
            r = c.post("/api/agent/v1/chat", headers=auth, json={"message": "log the taxi and drop the old receipt"})
        finally:
            ai_step.ready, ai_step.step = real_ready, real_step
        check(r.status_code == 200 and r.get_json()["cards"] == 2, "chat turns the AI's changes into two cards")
        check(len(ctx.get_memos_for_variant("finance")) == before and not ctx.memo_store.get_one("f1", "finance").get("deletedAt"), "the chat itself changed nothing")
        tool_names = [t["name"] for t in seen[0]["tools"]]
        check("create_entry" in tool_names and seen[0]["tools"][0]["parameters"]["properties"]["source"]["enum"] == ["default", "finance"], "the AI only sees the pages this token may use")

        # Revoked tokens stop at once.
        check(c.delete("/api/agent-tokens/" + rec["id"], headers=owner).status_code == 200, "owner revokes the token")
        check(c.get("/api/agent/v1/me", headers=auth).status_code == 401, "a revoked token -> 401")
        # A permanent server id, and a proof that needs the password (finding a moved server).
        import hashlib, hmac
        cfg = c.get("/api/config").get_json()
        check(len(cfg["serverId"]) == 32 and "proof" not in cfg, "config has a permanent server id, no proof without a challenge")
        check(open(os.path.join(BASE, "data", "server_id"), encoding="utf-8").read().strip() == cfg["serverId"], "the id is kept in the data folder")
        challenge = "0123456789abcdef0123456789abcdef"
        proved = c.get("/api/config?challenge=" + challenge).get_json()
        expected = hmac.new(b"owner-pw", (challenge + ":" + cfg["serverId"]).encode(), hashlib.sha256).hexdigest()
        check(proved["proof"] == expected and proved["serverId"] == cfg["serverId"], "the proof is HMAC(password, challenge:id)")
        check("proof" not in c.get("/api/config?challenge=not-hex!").get_json(), "a malformed challenge gets no proof")

        # Guessing is slowed down per address; others are not affected.
        guesser = {"REMOTE_ADDR": "10.9.9.9"}
        for _ in range(10):
            c.get("/api/memos", headers={"X-Sync-Password": "guess"}, environ_base=guesser)
        r = c.get("/api/memos", headers={"X-Sync-Password": "owner-pw"}, environ_base=guesser)
        check(r.status_code == 429 and int(r.headers.get("Retry-After", "0")) > 0, "10 wrong passwords: that address waits (429 + Retry-After)")
        check(c.get("/uploads/x.txt", headers={"X-Sync-Password": "owner-pw"}, environ_base=guesser).status_code == 401, "the wait covers /uploads too")
        check(c.get("/api/memos", headers=owner, environ_base={"REMOTE_ADDR": "10.9.9.10"}).status_code == 200, "another address is not affected")
        lazy = {"REMOTE_ADDR": "10.9.9.11"}
        for _ in range(15):
            c.get("/api/memos", environ_base=lazy)
        check(c.get("/api/memos", headers=owner, environ_base=lazy).status_code == 200, "a client with no password set is not counted as guessing")
        for _ in range(10):
            c.get("/api/agent/v1/me", headers={"Authorization": "Bearer mk_guess"}, environ_base={"REMOTE_ADDR": "10.9.9.12"})
        check(c.get("/api/agent/v1/me", headers={"Authorization": "Bearer " + w["token"]}, environ_base={"REMOTE_ADDR": "10.9.9.12"}).status_code == 429, "wrong agent tokens hit the same limit")
        print(f"\nAll Agent API checks passed ({_checks} assertions).")
    finally:
        shutil.rmtree(BASE, ignore_errors=True)


if __name__ == "__main__":
    main()

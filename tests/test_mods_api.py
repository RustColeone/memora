"""
Mods on the server (backend/api/mods_routes.py) through the real server app:
GET /api/mods lists <base-dir>/mods behind the sync password, /mods/<folder>/<file>
serves files with the /uploads check (header, cookie or token), and nothing
outside a mod's folder is reachable. Runs on a temporary data folder.
"""
import json
import os
import shutil
import sys
import tempfile

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BASE = tempfile.mkdtemp(prefix="memo_mods_api_")
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
BackendContext._start_background_summarization = lambda self: None
import server  # noqa: E402

_checks = 0


def check(cond, label):
    global _checks
    _checks += 1
    print(("  ok   " if cond else "  FAIL ") + label)
    if not cond:
        raise SystemExit(1)


def main():
    print("test_mods_api")
    mods = os.path.join(BASE, "mods")
    shutil.copytree(os.path.join(REPO, "mods-examples", "notebook-stats"), os.path.join(mods, "notebook-stats"))
    os.makedirs(os.path.join(mods, "broken"))
    with open(os.path.join(mods, "broken", "mod.json"), "w", encoding="utf-8") as f:
        f.write("{ not json")
    os.makedirs(os.path.join(mods, "empty"))
    with open(os.path.join(BASE, "secret.txt"), "w", encoding="utf-8") as f:
        f.write("outside")
    c = server.app.test_client()
    owner = {"X-Sync-Password": "owner-pw"}
    try:
        check(c.get("/api/mods").status_code == 401, "the list needs the sync password")
        r = c.get("/api/mods", headers=owner).get_json()
        check(r["dir"] == mods, "the list names the mods folder")
        by = {m["folder"]: m for m in r["mods"]}
        check(sorted(by) == ["broken", "empty", "notebook-stats"], "every folder is listed")
        check(by["notebook-stats"]["manifest"]["id"] == "notebook-stats" and not by["notebook-stats"]["error"], "a good mod.json is read")
        check(by["broken"]["error"].startswith("mod.json:") and by["empty"]["error"] == "no mod.json in this folder", "bad folders say why")
        check(c.get("/mods/notebook-stats/main.js").status_code == 401, "files need the password too")
        got = c.get("/mods/notebook-stats/main.js", headers=owner)
        check(got.status_code == 200 and b"Memora.mod('notebook-stats'" in got.data, "a mod's file is served with the password")
        c.get("/api/uploads/session", headers=owner)   # the cookie a page's <script> tags send
        check(c.get("/mods/notebook-stats/style.css").status_code == 200, "and with the image cookie")
        for bad in ["/mods/notebook-stats/../../secret.txt", "/mods/notebook-stats/%2e%2e/%2e%2e/secret.txt", "/mods/../secret.txt", "/mods/.hidden/x"]:
            check(c.get(bad, headers=owner).status_code in (400, 404), "nothing outside a mod's folder: " + bad)
    finally:
        shutil.rmtree(BASE, ignore_errors=True)
    print("\nAll mods API checks passed (%d assertions)." % _checks)


if __name__ == "__main__":
    main()

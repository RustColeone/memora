"""
Run the whole MemoSystem test suite — backend (Python) + frontend (Playwright/Edge).

    python tests/run_all.py            # everything
    python tests/run_all.py --backend  # backend Python suites only (fast, no browser)
    python tests/run_all.py --browser  # Playwright/Edge suite only

Exit code is non-zero if any suite fails, so it's CI/pre-commit friendly.
Run this after every major change.
"""

import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

BACKEND_SUITES = [
    "test_backup_restore.py",
    "test_sync_maintenance.py",
    "test_backend_db_integrity.py",  # fail-closed startup, corrupt-primary preservation, WAL reads
    "test_backend_sync.py",   # schema/migration, stores, sync log, converter, agent loop
    "test_backend_api.py",    # HTTP endpoints (memo CRUD, operations, db export/import, agent)
    "test_planner.py",        # planner sync variant: doc store, routing, ops round-trip, isolation
    "test_agent_api.py",      # Agent API: per-agent tokens, scopes, proposals as cards, revocation
    "test_mods_api.py",       # mods: the list behind the password, files served safely
]


def _run(label, cmd, cwd):
    print("\n" + "=" * 70)
    print(f"▶ {label}")
    print("=" * 70)
    t0 = time.time()
    rc = subprocess.call(cmd, cwd=cwd, shell=isinstance(cmd, str))
    dt = time.time() - t0
    print(f"  → {'PASS' if rc == 0 else 'FAIL'} ({dt:.1f}s)")
    return rc == 0


def run_backend():
    results = []
    for suite in BACKEND_SUITES:
        ok = _run(f"backend: {suite}", [sys.executable, os.path.join(HERE, suite)], cwd=REPO)
        results.append((f"backend/{suite}", ok))
    return results


def run_browser():
    # Run the fast storage fault checks before the browser suite, then build www/
    # and run Playwright against installed Edge.
    npm = "npm.cmd" if os.name == "nt" else "npm"
    results = [("frontend/state-db-recovery",
                _run("frontend: SQLite recovery/fault checks (npm run test:state)",
                     f"{npm} run test:state", cwd=REPO)),
               ("frontend/playwright",
               _run("frontend: Playwright/Edge (npm test)", f"{npm} test", cwd=REPO))]
    # End-to-end sync test: spins up an isolated backend + static host and drives
    # two real browser clients (backend-hosted + frontend-only) through a sync.
    results.append(("sync/e2e",
                    _run("sync: two-client end-to-end (node tests/sync-e2e.js)",
                         ["node", os.path.join(HERE, "sync-e2e.js")], cwd=REPO)))
    return results


def main():
    args = set(sys.argv[1:])
    do_backend = "--browser" not in args
    do_browser = "--backend" not in args

    results = []
    if do_backend:
        results += run_backend()
    if do_browser:
        results += run_browser()

    print("\n" + "=" * 70)
    print("SUMMARY")
    print("=" * 70)
    for name, ok in results:
        print(f"  {'✅ PASS' if ok else '❌ FAIL'}  {name}")
    failed = [n for n, ok in results if not ok]
    if failed:
        print(f"\n{len(failed)} suite(s) FAILED.")
        sys.exit(1)
    print(f"\nAll {len(results)} suite(s) passed. ✅")


if __name__ == "__main__":
    main()

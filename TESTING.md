# Testing

Run the whole suite after every major change:

```bash
python tests/run_all.py        # backend (Python) + frontend (Playwright/Edge)
```

Subsets:

```bash
python tests/run_all.py --backend   # Python suites only (fast, no browser)
python tests/run_all.py --browser   # Playwright/Edge only
```

Or via npm:

```bash
npm run test:all        # everything
npm run test:backend    # Python only
npm test                # Playwright only (also builds www/ first)
```

The runner exits non-zero if any suite fails (CI / pre-commit friendly).

## Prerequisites

- **Python** deps: `pip install -r requirements.txt` (Flask). Tests use only the
  standard library + Flask; no LLM key is needed (LLM calls are stubbed/disabled).
- **Node** deps: `npm install` (installs Playwright + sql.js).
- **Browser**: the Playwright suite runs against **installed Microsoft Edge**
  (`channel: 'msedge'`) — no Chromium download. Edge must be installed.

Tests never touch the live `data/memosystem.db`: backend suites build an isolated
temp DB seeded from `data/*.json`; the browser suite serves a fresh `www/` build
and uses the browser's own OPFS storage.

## What's covered

### Backend — Python (`tests/test_backend_sync.py`, `tests/test_backend_api.py`)
- **Sync log**: incremental op apply (no clobber), client-op dedup, `pull` after
  `push`, CRUD mutations journaling operations.
- **Interchange**: JSON bundle + ZIP export/import round-trip (rows + upload blobs).
- **Agent**: tool-calling loop (search/create/update/delete) with a fake LLM
  client, action recording, op journaling, and `models.list()` model resolution.
- **HTTP endpoints**: `GET/POST/PUT/DELETE /api/memos`, `/api/operations/push|pull`,
  `/api/db/export?format=zip|json`, `/api/db/import`, `/api/config`,
  `/api/chat/agent` (graceful with no LLM key — never 500s).

### Frontend — Playwright/Edge (`tests/*.spec.js`)
- **offline.spec.js** — offline mode runs on sql.js/OPFS and persists across reload.
- **offline-blobs.spec.js** — image bytes persist app-private and rehydrate to
  object URLs after reload.
- **zip-roundtrip.spec.js** — export ZIP → wipe → import ZIP through the real
  Settings UI restores entries.
- **interchange.spec.js** — a backend-produced JSON bundle imports into the
  in-browser store and round-trips (cross-compatibility).

## Adding tests

- **Backend**: add a `tests/test_*.py` (self-contained, exits non-zero on failure)
  and list it in `BACKEND_SUITES` in `tests/run_all.py`. Reuse `make_context()`
  from `test_backend_sync.py` for an isolated, seeded temp DB.
- **Frontend**: add a `tests/*.spec.js`; Playwright auto-discovers it.

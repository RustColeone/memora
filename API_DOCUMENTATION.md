# Memo System API Documentation

## Overview
This project exposes:
- HTTP API endpoints via Flask blueprints under `api/`
- Internal service-layer APIs in the `services/` package

The backend is variant-aware (`default` and `finance`). Variant can be selected by:
1. Query param: `?variant=finance|default`
2. Header: `X-Memo-Variant: finance|default`
3. Referer heuristic containing `/finance/`

## HTTP API

### Config
- `GET /api/config`
  - Response: `{ "server": boolean, "authRequired": boolean, "collections": [...], "ai": { "available": boolean, "vision"?: boolean } }`
  - `ai` says whether AI contacts can use this server's own AI (`POST /api/ai/step`); it never includes a key.

### Agent API (outside agents)
For programs that act for you — say, one that reads receipts from your mailbox. Each agent gets its own token
instead of the sync password, with a level per page (`notes`, `spending`, `plans`):

| level | may |
|---|---|
| `read` | search and open items (Safe notes are never shown) |
| `propose` | read, and send changes as **cards** that wait for a tap in the app |
| `write` | read, propose, and add items directly |

Make tokens on the server (the token is shown once; only its hash is stored):

```sh
memora-server token create "Mailbox receipts" --spending propose --notes read
memora-server token list
memora-server token revoke <id>
```

or with the sync password: `GET /api/agent-tokens`, `POST /api/agent-tokens {name, scopes: {page: level}}`,
`DELETE /api/agent-tokens/<id>`.

Every Agent API call sends `Authorization: Bearer mk_…`:

- `GET /api/agent/v1/me` → `{ name, scopes }`
- `GET /api/agent/v1/search?q=&page=&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=25` → `{ count, total, items: [{ page, id, … }] }`
- `GET /api/agent/v1/items/<page>/<id>` → the item
- `POST /api/agent/v1/proposals` (propose) → `{ messageId, cards }`

  ```json
  { "message": "Found 2 receipts in your mailbox.",
    "actions": [
      { "type": "create", "page": "spending", "items": [{ "description": "Menya Kouji", "total": 31.85, "category": "Food", "date": "2026-10-17" }] },
      { "type": "update", "page": "spending", "ids": ["f1"], "change": { "addTags": ["receipt"] } },
      { "type": "delete", "page": "notes", "ids": ["n9"], "reason": "duplicate" },
      { "type": "reminder", "page": "plans", "items": [{ "kind": "event", "title": "Pay the bill", "date": "2026-10-30", "start": "09:00" }] } ] }
  ```
  The app shows a thread from the agent with one card per action; nothing changes until someone taps it, and
  deletes only go to the Bin. `create` items: notes `{description, category, tags}`, spending
  `{description, total, tax, category, date, tags, items:[{name, amount, unitPrice, totalPrice}]}`, plans
  `{kind: "todo", title, due}` or `{kind: "event", title, date, start, end, description}`. `update` changes:
  `addTags, removeTags, category, done, text, total, date`. Unknown fields are dropped.
- `POST /api/agent/v1/entries {page, item}` (write) → `{ id }`; the item is marked `source: "agent:<name>"`.
- `POST /api/agent/v1/chat {message}` (propose) → `{ reply, cards }`: plain language through this server's AI, which
  can only look at the token's pages and whose changes arrive as cards.

`POST /api/chat/agent`, which changed entries directly behind only the sync password, now answers `410` and points here.

### Chat
- `GET /api/chat`
  - Returns chat history array for current variant.
- `POST /api/chat`
  - Request body:
    - `message` (string, required)
    - `visibleIds` (array of memo ids, optional)
  - Response: `{ "messages": [userMessage, assistantMessage] }`
- `DELETE /api/chat`
  - Clears chat history for current variant.
- `POST /api/chat/create-entry`
  - Multipart form-data:
    - `files` (1..n files, required)
    - `message` (string, optional)
  - Creates memo/finance entry from uploaded files + AI analysis.

### Memos
- `GET /api/memos`
  - Returns all memos for current variant.
- `POST /api/memos`
  - Creates a memo; server injects missing `id`, `createdAt`, `updatedAt`.
- `PUT /api/memos/<memo_id>`
  - Updates memo by id.
- `DELETE /api/memos/<memo_id>?permanent=true|false`
  - Soft delete by default; permanent delete when `permanent=true`.
- `POST /api/memos/<memo_id>/restore`
  - Restores soft-deleted memo.

### Operations (Event Sourcing)
- `POST /api/operations/push`
  - Pushes client operations and returns server-assigned op ids.
- `GET /api/operations/pull?sinceOpId=<int>`
  - Pulls operations after op id, or snapshot+ops when client is behind snapshot.
- `POST /api/operations/compact`
  - Request body: `{ "keepDays": number }` (optional, default 30)
  - Compacts old operations into snapshot.

### Uploads
- `POST /api/upload`
  - Supports:
    - `multipart/form-data` with `file`
    - JSON body with base64 payload (`file`, `filename`, optional `type`)
  - Response includes:
    - `url`, `duplicate`, `hash`, and on new upload `size`
- `GET /uploads/<path:filename>`
  - Serves uploaded files.

### Export / Backup
- `POST /api/export/detailed-pdf`
  - Request body:
    - `entryIds` (array, optional; empty means all active entries)
    - `pageSize` (`A4|LETTER|LEGAL`, optional)
  - Returns downloadable PDF.
- `GET /api/backup`
  - Returns zip archive of data + uploads.

### Frontend routes
- `GET /`
- `GET /index.html`
- `GET /finance`
- `GET /finance.html`

---

## Service-layer API (`services/`)

## Core services

### `MemosService` (`services/memos.py`)
- `handle_get_all_memos(variant, get_memos_for_variant)`
- `handle_create_memo(payload, variant, get_memos_for_variant, save_memos_for_variant)`
- `handle_update_memo(memo_id, updated_data, variant, get_memos_for_variant, save_memos_for_variant, delete_upload_url)`
- `handle_delete_memo(memo_id, permanent, variant, get_memos_for_variant, save_memos_for_variant, delete_upload_url)`
- `handle_restore_memo(memo_id, variant, get_memos_for_variant, save_memos_for_variant)`

### `OperationsService` (`services/operations.py`)
- `append_operation(operation, variant)`
- `handle_push_operations(payload, variant, save_memos_for_variant)`
- `handle_pull_operations(since_op_id, variant)`
- `handle_compact_operations(payload, variant)`
- `rebuild_state_from_operations(variant, up_to_op_id=None)`

### `UploadService` (`services/upload.py`)
- `handle_upload_request(req, use_server_backend)`
- `delete_upload_url(image_url)`

### `ExportService` (`services/export.py`)
- `handle_detailed_pdf_export(payload, variant, base_dir, get_memos_for_variant)`

### `BackupService` (`services/backup.py`)
- `handle_download_backup(base_dir, data_dir, upload_folder)`

### `FrontendService` (`services/frontend.py`)
- `index_template()`
- `finance_template()`

### `JsonStoreService` (`services/json_store.py`)
- `ensure_file(path, default, schema_version=1)`
- `read_json(path, default)`
- `write_json(path, obj, schema_version=1)`

### `LLMService` + factory (`services/llm.py`)
- `create_llm_service(provider=None, openai_key=None, gemini_key=None, model=None)`
- `LLMService.analyze_files_for_entry(file_paths, user_message, variant='default', base_dir='.')`

## Chat orchestration services
- `services/chat.py` (facade exports)
  - `generate_llm_reply(...)`
  - `generate_entry_from_files(...)`
  - `handle_chat_send(...)`
  - `handle_chat_create_entry(...)`

## Upload helper services
- `UploadHashbookStore` (`services/upload_hashbook.py`)
  - Hash-based dedup bookkeeping and reference counting.
- `parse_upload_file_from_request` (`services/upload_request.py`)
  - Normalizes multipart and base64 JSON request formats.

---

## Package exports
`services/__init__.py` defines explicit public exports for service classes and helper APIs. Use package imports for consistency, for example:

- `from services import UploadService, MemosService`
- `from services import handle_chat_send, handle_chat_create_entry`

---

## Notes
- Server backend toggle: `USE_SERVER_BACKEND=true|false`
- Optional LLM env vars: `OPENAI_API_KEY`, `GEMINI_API_KEY`, `LLM_MODEL`, `LLM_MAX_MESSAGES`
- Upload endpoint currently accepts all file types; apply validation in `services/upload_request.py` if needed.

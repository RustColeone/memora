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
  - Response: `{ "server": boolean }`

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

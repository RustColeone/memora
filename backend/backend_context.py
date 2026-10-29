import json
import logging
import os
from threading import RLock, Thread

from services.backup import BackupService
from services.chat_store import ChatStore
from services.db import init_db
from services.db_converter import import_from_dir
from services.doc_store import DocStore
from services.export import ExportService
from services.frontend import FrontendService
from services.hashbook_store import HashbookStore
from services.json_store import JsonStoreService
from services.llm import create_llm_service
from services.memo_store import MemoStore, _iso_to_ms, _ms_to_iso, _now_ms
from services.memos import MemosService
from services.ocr_draft_store import OcrDraftStore
from services.ocr_reader import OcrReader
from services.operations import OperationsService
from services.operations_store import OperationsStore
from services.upload import UploadService


_log = logging.getLogger('chat_summarizer')


class BackendContext:
    def __init__(self, base_dir: str, use_server_backend: bool):
        self.base_dir = base_dir
        self.use_server_backend = use_server_backend

        # Data/upload locations are overridable (e.g. isolated dirs for tests or
        # pointing the DB at external storage) — default to base_dir/{data,uploads}.
        self.upload_folder = os.environ.get('MEMO_UPLOAD_DIR') or os.path.join(self.base_dir, 'uploads')
        self.data_dir = os.environ.get('MEMO_DATA_DIR') or os.path.join(self.base_dir, 'data')
        self.db_path = os.path.join(self.data_dir, 'memosystem.db')

        # Keep these paths for backward-compat (backup service, LLM config fallback)
        self.data_file = os.path.join(self.data_dir, 'memos.json')
        self.finance_data_file = os.path.join(self.data_dir, 'finance.json')
        self.chat_default_file = os.path.join(self.data_dir, 'chat.json')
        self.chat_finance_file = os.path.join(self.data_dir, 'chat_finance.json')
        self.hashbook_file = os.path.join(self.data_dir, 'hashbook.json')
        self.llm_config_file = os.path.join(self.data_dir, 'llm_config.json')
        self.operations_file = os.path.join(self.data_dir, 'operations.json')
        self.operations_finance_file = os.path.join(self.data_dir, 'operations_finance.json')
        self.snapshot_file = os.path.join(self.data_dir, 'snapshot.json')
        self.snapshot_finance_file = os.path.join(self.data_dir, 'snapshot_finance.json')
        self.json_backup_dir = os.path.join(self.data_dir, '.json_backups')

        self.llm_provider = os.environ.get('LLM_PROVIDER', 'gemini')
        self.openai_api_key = os.environ.get('OPENAI_API_KEY')
        self.gemini_api_key = os.environ.get('GEMINI_API_KEY')
        self.deepseek_api_key = os.environ.get('DEEPSEEK_API_KEY')
        self.anthropic_api_key = os.environ.get('ANTHROPIC_API_KEY')
        self.custom_api_key = os.environ.get('LLM_CUSTOM_API_KEY')
        self.custom_base_url = os.environ.get('LLM_CUSTOM_BASE_URL')
        self.llm_model = os.environ.get('LLM_MODEL')
        self.llm_system_prompt = (
            'You are an efficient assistant embedded in a personal memo system.'
            ' You will be provide with a list of their memos.'
            ' Sometimes the user may not provide the full context of their questions, make an educated guess.'
            ' Sometimes what the user ask may not match exactly what is in the memos, try to find the closest match.'
            ' Provide concise, helpful answers. If user asks to reference memos, you can reason over the conversation context only;'
            ' you cannot actually read files unless explicitly given their content.'
        )
        self.llm_max_messages = int(os.environ.get('LLM_MAX_MESSAGES', '14'))

        os.makedirs(self.data_dir, exist_ok=True)
        os.makedirs(self.upload_folder, exist_ok=True)

        # ----------------------------------------------------------------
        # SQLite — primary data store
        # ----------------------------------------------------------------
        db_is_new = not os.path.exists(self.db_path)
        self.db = init_db(self.db_path)

        if db_is_new:
            # Seed from JSON files on first run
            print('📦 New database detected — importing JSON data...')
            try:
                import_from_dir(self.db, self.data_dir, mode='replace')
                print('✅ JSON data imported into SQLite')
            except Exception as exc:
                print(f'⚠️  JSON import warning: {exc}')

        # ----------------------------------------------------------------
        # Store instances
        # ----------------------------------------------------------------
        self.memo_store = MemoStore(self.db)
        # Generic JSON-document store for the Planner variant (events/todos/
        # projects/habits). Routed to by variant in _store_for_variant().
        self.planner_store = DocStore(self.db, 'planner_entries')
        # Vault items arrive already encrypted by the device; stored as-is.
        self.vault_store = DocStore(self.db, 'vault_entries')
        self.contacts_store = DocStore(self.db, 'ai_contacts')
        self.messages_store = DocStore(self.db, 'ai_messages')
        self.hashbook_store = HashbookStore(self.db, self.base_dir)
        self.chat_store_service = ChatStore(self.db)
        self.ocr_draft_store = OcrDraftStore(self.db)
        self.ops_store = OperationsStore(self.db)

        # ----------------------------------------------------------------
        # JSON store (kept only for LLM config read/write and JSON backups)
        # ----------------------------------------------------------------
        self.json_store = JsonStoreService(backup_root=self.json_backup_dir, max_backups_per_file=10)

        self.lock = RLock()
        self._summary_inflight = set()
        self._summary_rerun = set()

        # ----------------------------------------------------------------
        # Services
        # ----------------------------------------------------------------
        self.upload_service = UploadService(
            upload_folder=self.upload_folder,
            base_dir=self.base_dir,
            hashbook=self.hashbook_store,
            lock=self.lock,
        )

        self.operations_service = OperationsService(store=self.ops_store)

        self.memos_service = MemosService()
        self.backup_service = BackupService()
        self.export_service = ExportService()
        self.frontend_service = FrontendService()

        # LLM config — read from SQLite settings, fall back to JSON file
        llm_cfg = self._read_llm_config_raw()
        self.llm_service = create_llm_service(
            provider=llm_cfg.get('provider') or self.llm_provider,
            openai_key=llm_cfg.get('openai_api_key') or self.openai_api_key,
            gemini_key=llm_cfg.get('gemini_api_key') or self.gemini_api_key,
            deepseek_key=llm_cfg.get('deepseek_api_key') or self.deepseek_api_key,
            model=llm_cfg.get('model') or self.llm_model,
            anthropic_key=llm_cfg.get('anthropic_api_key') or self.anthropic_api_key,
            custom_key=llm_cfg.get('custom_api_key') or self.custom_api_key,
            custom_base_url=llm_cfg.get('custom_base_url') or self.custom_base_url,
        )

        self.ocr_draft_service = self.ocr_draft_store  # unified API

        # Traditional OCR helper (best-effort; gracefully disabled if backends missing)
        self.ocr_reader = OcrReader(languages=['en'])

        # Kick off background summarization now that LLM is ready
        self._start_background_summarization()

        print('✅ SQLite backend ready')

    def _read_llm_config_raw(self) -> dict:
        """Read LLM config from SQLite settings, falling back to JSON file."""
        val = self.chat_store_service.get_setting('llm_config')
        if val and isinstance(val, dict):
            return val
        # Fall back to JSON file (migration path)
        try:
            raw = self.json_store.read_json(self.llm_config_file, default={})
            if raw and isinstance(raw, dict):
                # Migrate into SQLite for next run
                self.chat_store_service.save_setting('llm_config', raw)
                return raw
        except Exception:
            pass
        return {}

    def _read_json(self, path: str):
        """Legacy helper — only used for files not yet migrated (e.g. LLM config)."""
        return self.json_store.read_json(path, default={})

    def _write_json(self, path: str, obj):
        """Legacy helper."""
        self.json_store.write_json(path, obj)

    # Variants whose entries are JSON documents in planner_entries rather than
    # the fixed memos/finance_entries schemas.
    DOC_VARIANTS = ('planner', 'vault', 'contacts', 'messages')
    VARIANTS = ('finance', 'default', 'planner', 'vault', 'contacts', 'messages')

    @staticmethod
    def resolve_variant(req) -> str:
        variant = (req.args.get('variant') or '').strip().lower()
        if variant in BackendContext.VARIANTS:
            return variant

        header_variant = (req.headers.get('X-Memo-Variant') or '').strip().lower()
        if header_variant in BackendContext.VARIANTS:
            return header_variant

        referer = req.headers.get('Referer') or ''
        if '/FINANCE/' in referer or '/finance/' in referer:
            return 'finance'
        if '/PLANNER/' in referer or '/planner/' in referer:
            return 'planner'

        return 'default'

    def _store_for_variant(self, variant: str):
        """Return the authoritative entry store for a variant.

        Doc-shaped variants (planner) use the generic JSON DocStore; memo and
        finance use the fixed-schema MemoStore. Both expose the same
        variant-agnostic interface, so callers don't special-case.
        """
        extra = {'vault': self.vault_store, 'contacts': self.contacts_store, 'messages': self.messages_store}
        if variant in extra:
            return extra[variant]
        return self.planner_store if variant in self.DOC_VARIANTS else self.memo_store

    def get_llm_config(self) -> dict:
        """Return current LLM config dict (including keys for internal use)."""
        with self.lock:
            return self._read_llm_config_raw()

    def provider_keys(self, cfg: dict = None) -> dict:
        """Claude and custom-provider settings: saved config first, then env."""
        cfg = cfg if cfg is not None else self.get_llm_config()
        return {
            'anthropic_api_key': cfg.get('anthropic_api_key') or self.anthropic_api_key,
            'custom_api_key': cfg.get('custom_api_key') or self.custom_api_key,
            'custom_base_url': cfg.get('custom_base_url') or self.custom_base_url,
        }

    def save_llm_config(self, config: dict):
        """Persist LLM config and reinitialise the service."""
        with self.lock:
            self.chat_store_service.save_setting('llm_config', config)
        self.reload_llm_service(config)

    def reload_llm_service(self, config: dict = None):
        """Re-create llm_service from the given config (or re-read from file)."""
        if config is None:
            config = self.get_llm_config()
        self.llm_service = create_llm_service(
            provider=config.get('provider') or self.llm_provider,
            openai_key=config.get('openai_api_key') or self.openai_api_key,
            gemini_key=config.get('gemini_api_key') or self.gemini_api_key,
            deepseek_key=config.get('deepseek_api_key') or self.deepseek_api_key,
            model=config.get('model') or self.llm_model,
            anthropic_key=config.get('anthropic_api_key') or self.anthropic_api_key,
            custom_key=config.get('custom_api_key') or self.custom_api_key,
            custom_base_url=config.get('custom_base_url') or self.custom_base_url,
        )

    def get_llm_config_safe(self) -> dict:
        """Return LLM config with keys redacted (safe to send to frontend)."""
        cfg = self.get_llm_config()
        provider = cfg.get('provider') or self.llm_provider or 'gemini'
        is_deepseek = provider.lower() == 'deepseek'
        # ocr_enabled: always True for deepseek, else persisted value (default False)
        ocr_enabled = True if is_deepseek else bool(cfg.get('ocr_enabled', False))
        return {
            'provider': provider,
            'model': cfg.get('model') or '',
            'ocr_enabled': ocr_enabled,
            'gemini_key_set': bool(cfg.get('gemini_api_key') or self.gemini_api_key),
            'openai_key_set': bool(cfg.get('openai_api_key') or self.openai_api_key),
            'deepseek_key_set': bool(cfg.get('deepseek_api_key') or self.deepseek_api_key),
            'anthropic_key_set': bool(cfg.get('anthropic_api_key') or self.anthropic_api_key),
            'custom_key_set': bool(cfg.get('custom_api_key') or self.custom_api_key),
            'custom_base_url': cfg.get('custom_base_url') or self.custom_base_url or '',
        }

    def data_file_for_variant(self, variant: str) -> str:
        return self.finance_data_file if variant == 'finance' else self.data_file

    def chat_file_for_variant(self, variant: str) -> str:
        return self.chat_finance_file if variant == 'finance' else self.chat_default_file

    def journal_operation(self, op_type: str, entry_id: str, variant: str, data=None):
        """Append a sync operation to the log for a server-side CRUD mutation.

        The CRUD path has already written the authoritative entry store; this
        records the change in the operation log so sync clients pull it too.
        Keeps the operation log the single, complete sync journal.
        """
        if not entry_id:
            return
        op = {'type': op_type, 'entryId': entry_id, 'deviceId': 'server'}
        if data is not None:
            op['data'] = data
        try:
            self.operations_service.append_operation(op, variant)
        except Exception as exc:
            print(f"⚠️ Failed to journal {op_type} for {entry_id}: {exc}")

    def apply_operation_to_memos(self, op, variant: str):
        """Apply a single sync operation to the authoritative entry store.

        Incremental by design: each op touches only its own entry, so entries
        created through other paths (e.g. the CRUD API) are never dropped.

        Last write wins by *edit time* (the op's timestamp, set on the device
        when the edit was made), not by arrival order:
          - an op older than the entry's last change is stale and not applied;
          - an edit newer than a delete brings the entry back;
          - an edit or delete for an entry the server does not have is missing.
        Returns (verdict, entry): 'applied', 'stale' (entry = current server
        copy, so the device can adopt it) or 'missing'. A stale or missing op
        must not be logged, so every device keeps replaying the same history.
        """
        op_type = op.get('type')
        entry_id = op.get('entryId')
        if not entry_id:
            return 'missing', None
        store = self._store_for_variant(variant)
        with self.lock:
            existing = store.get_one(entry_id, variant)
            edit_ms = int(op.get('timestamp') or 0)
            if existing is not None and op_type in ('create', 'update', 'delete'):
                last_ms = max(_iso_to_ms(existing.get('updatedAt')) or 0, _iso_to_ms(existing.get('deletedAt')) or 0)
                if edit_ms and edit_ms < last_ms:
                    return 'stale', existing
            stamp = _ms_to_iso(edit_ms) if edit_ms else None
            if op_type == 'create':
                data = dict(op.get('data') or {})
                data['id'] = entry_id
                if stamp:
                    data['updatedAt'] = stamp
                store.upsert(data, variant)
                return 'applied', None
            if existing is None:
                return 'missing', None
            if op_type == 'update':
                fields = dict(op['data']) if op.get('data') is not None else (
                    {op['field']: op.get('value')} if op.get('field') is not None else {})
                if existing.get('deletedAt'):
                    # The edit is newer than the delete: it wins, so the entry is
                    # restored. Logging the restore keeps every device in step.
                    fields.update({'deletedAt': None, 'deletedBy': None, 'permanentDeleteAt': None})
                    op['data'] = dict(op.get('data') or {}, deletedAt=None, deletedBy=None)
                    if op.get('field') is not None:
                        op['data'][op['field']] = op.get('value')
                        op['field'] = op['value'] = None
                store.upsert({**existing, **fields, 'id': entry_id, 'updatedAt': stamp or _ms_to_iso(_now_ms())}, variant)
            elif op_type == 'delete':
                store.upsert({**existing, 'id': entry_id, 'deletedAt': stamp or _ms_to_iso(_now_ms()),
                              'deletedBy': op.get('deviceId') or 'unknown',
                              'updatedAt': stamp or _ms_to_iso(_now_ms())}, variant)
            elif op_type == 'addImage':
                if op.get('url'):
                    images = list(existing.get('images') or [])
                    if op['url'] not in images:
                        images.append(op['url'])
                    store.update_fields(entry_id, {'images': images}, variant)
            elif op_type == 'addAttachment':
                if op.get('attachment'):
                    attachments = list(existing.get('attachments') or [])
                    if op['attachment'] not in attachments:
                        attachments.append(op['attachment'])
                    store.update_fields(entry_id, {'attachments': attachments}, variant)
            return 'applied', None

    def store_for_variant(self, variant: str):
        """Public accessor for the entry store (callers hold self.lock)."""
        return self._store_for_variant(variant)

    def upsert_entry_for_variant(self, entry, variant: str):
        """Write one entry (no full-list rewrite)."""
        with self.lock:
            return self._store_for_variant(variant).upsert(entry, variant)

    def image_url_in_use(self, url: str, exclude_id=None) -> bool:
        """True when any memo or finance entry other than *exclude_id* still
        references *url* (one indexed-free scan in SQLite, not a Python loop
        over every entry)."""
        needle = json.dumps(url, ensure_ascii=False)
        for table in ('memos', 'finance_entries'):
            row = self.db.fetchone(
                f"SELECT 1 FROM {table} WHERE id != ? AND instr(images, ?) > 0 LIMIT 1",
                [exclude_id or '', needle])
            if row:
                return True
        return False

    def get_memos_for_variant(self, variant: str):
        with self.lock:
            return self._store_for_variant(variant).get_all(variant)

    def save_memos_for_variant(self, memos, variant: str):
        with self.lock:
            self._store_for_variant(variant).save_all(memos, variant)

    def get_chat_store_for_variant(self, variant: str) -> dict:
        """Return the full chat store (prompt + summaries + messages)."""
        with self.lock:
            return self.chat_store_service.get_store(variant)

    def save_chat_store_for_variant(self, store: dict, variant: str):
        """Persist the full chat store."""
        with self.lock:
            self.chat_store_service.save_store(store, variant)

    def get_chat_for_variant(self, variant: str):
        """Return only the messages list (backward-compatible)."""
        return self.get_chat_store_for_variant(variant)["messages"]

    def save_chat_for_variant(self, messages, variant: str):
        """Save messages while preserving existing prompt and summaries."""
        store = self.get_chat_store_for_variant(variant)
        store["messages"] = messages if isinstance(messages, list) else []
        self.save_chat_store_for_variant(store, variant)

    def _make_summarize_fn(self):
        """Return a callable(prompt: str) -> str using the configured LLM."""
        from services.chat_reply import generate_llm_reply
        cfg = self.get_llm_config()
        provider = cfg.get('provider') or self.llm_provider
        model = cfg.get('model') or self.llm_model
        openai_key = cfg.get('openai_api_key') or self.openai_api_key
        gemini_key = cfg.get('gemini_api_key') or self.gemini_api_key
        deepseek_key = cfg.get('deepseek_api_key') or self.deepseek_api_key
        extra_keys = self.provider_keys(cfg)
        base_summary_tokens = int(os.environ.get('LLM_SUMMARY_BASE_MAX_TOKENS', '384'))
        stage_multipliers = {
            'day': 1,
            'week': 4,
            'month': 8,
            'quarter': 16,
            'year': 32,
        }
        _log.debug('_make_summarize_fn: provider=%s, model=%s', provider, model or '(default)')
        system_prompt = (
            'You are a summarization assistant. '
            'Return only the summary text with no preamble or meta-commentary.'
        )

        def fn(prompt: str, stage: str = 'day') -> str:
            max_output_tokens = base_summary_tokens * stage_multipliers.get(stage, 1)
            return generate_llm_reply(
                history_messages=[],
                latest_user_text=prompt,
                provider=provider,
                model=model,
                system_prompt=system_prompt,
                openai_api_key=openai_key,
                gemini_api_key=gemini_key,
                deepseek_api_key=deepseek_key,
                max_output_tokens=max_output_tokens,
                **extra_keys,
            )
        return fn

    def run_chat_summarization(self, variant: str):
        """Run the summarization pipeline for one variant and persist if changed."""
        import time
        from services.chat_summary import run_summarization
        _log.info('run_chat_summarization: START variant=%s', variant)
        t0 = time.monotonic()
        try:
            store = self.get_chat_store_for_variant(variant)
            all_entries = self.get_memos_for_variant(variant)
            _log.debug('  loaded store: messages=%d, entries=%d',
                       len(store.get('messages', [])), len(all_entries) if isinstance(all_entries, list) else -1)
            llm_fn = self._make_summarize_fn()
            updated, changed = run_summarization(store, all_entries, variant, llm_fn)
            elapsed = time.monotonic() - t0
            if changed:
                self.save_chat_store_for_variant(updated, variant)
                _log.info('run_chat_summarization: DONE variant=%s changed=True elapsed=%.2fs', variant, elapsed)
                print(f'✅ Chat summaries updated for variant={variant}')
            else:
                _log.info('run_chat_summarization: DONE variant=%s changed=False elapsed=%.2fs', variant, elapsed)
        except Exception as exc:
            _log.exception('run_chat_summarization: FAILED variant=%s error=%s', variant, exc)
            print(f'⚠️  Chat summarization failed for variant={variant}: {exc}')

    def schedule_chat_summarization(self, variant: str):
        """Schedule one background summarization pass for a variant.

        If a run is already in flight, queue a single rerun so bursty chat activity
        still ends with a fresh summarization pass without spawning duplicate workers.
        """
        with self.lock:
            if variant in self._summary_inflight:
                self._summary_rerun.add(variant)
                _log.debug('schedule_chat_summarization: variant=%s already running; queued rerun', variant)
                return
            self._summary_inflight.add(variant)

        def _worker():
            _log.info('schedule_chat_summarization: worker started for variant=%s', variant)
            while True:
                try:
                    self.run_chat_summarization(variant)
                finally:
                    with self.lock:
                        if variant in self._summary_rerun:
                            self._summary_rerun.discard(variant)
                            _log.debug('schedule_chat_summarization: rerunning queued variant=%s', variant)
                            continue
                        self._summary_inflight.discard(variant)
                        break
            _log.info('schedule_chat_summarization: worker finished for variant=%s', variant)

        Thread(target=_worker, daemon=True, name=f'chat-summarizer-{variant}').start()

    def schedule_chat_summarization_if_due(self, variant: str, reason: str = '') -> bool:
        """Schedule summarization only when the calendar day has rolled over."""
        from services.chat_summary import should_run_rollover

        store = self.get_chat_store_for_variant(variant)
        if not should_run_rollover(store):
            _log.debug('schedule_chat_summarization_if_due: variant=%s due=False reason=%s', variant, reason or '(none)')
            return False

        _log.info('schedule_chat_summarization_if_due: variant=%s due=True reason=%s', variant, reason or '(none)')
        self.schedule_chat_summarization(variant)
        return True

    def _start_background_summarization(self):
        """Kick off summarization for both variants in a daemon thread."""
        def _run():
            _log.info('Background summarization thread started')
            for v in ('default', 'finance'):
                self.schedule_chat_summarization_if_due(v, reason='startup')
            _log.info('Background summarization thread finished')
        t = Thread(target=_run, daemon=True, name='chat-summarizer')
        _log.debug('Spawning chat-summarizer daemon thread')
        t.start()

import os
from threading import RLock

from services.backup import BackupService
from services.export import ExportService
from services.frontend import FrontendService
from services.json_store import JsonStoreService
from services.memos import MemosService
from services.operations import OperationsService
from services.upload import UploadService


class BackendContext:
    def __init__(self, base_dir: str, use_server_backend: bool):
        self.base_dir = base_dir
        self.use_server_backend = use_server_backend

        self.upload_folder = os.path.join(self.base_dir, 'uploads')
        self.data_dir = os.path.join(self.base_dir, 'data')

        self.data_file = os.path.join(self.data_dir, 'memos.json')
        self.finance_data_file = os.path.join(self.data_dir, 'finance.json')
        self.chat_default_file = os.path.join(self.data_dir, 'chat.json')
        self.chat_finance_file = os.path.join(self.data_dir, 'chat_finance.json')
        self.hashbook_file = os.path.join(self.data_dir, 'hashbook.json')

        self.operations_file = os.path.join(self.data_dir, 'operations.json')
        self.operations_finance_file = os.path.join(self.data_dir, 'operations_finance.json')
        self.snapshot_file = os.path.join(self.data_dir, 'snapshot.json')
        self.snapshot_finance_file = os.path.join(self.data_dir, 'snapshot_finance.json')
        self.json_backup_dir = os.path.join(self.data_dir, '.json_backups')

        self.json_defaults = {
            self.data_file: [],
            self.finance_data_file: [],
            self.chat_default_file: [],
            self.chat_finance_file: [],
            self.operations_file: [],
            self.operations_finance_file: [],
            self.snapshot_file: {'snapshotId': 0, 'timestamp': 0, 'entries': []},
            self.snapshot_finance_file: {'snapshotId': 0, 'timestamp': 0, 'entries': []},
            self.hashbook_file: {},
        }

        self.json_schema_versions = {
            self.data_file: 1,
            self.finance_data_file: 1,
            self.chat_default_file: 1,
            self.chat_finance_file: 1,
            self.operations_file: 1,
            self.operations_finance_file: 1,
            self.snapshot_file: 1,
            self.snapshot_finance_file: 1,
            self.hashbook_file: 1,
        }

        self.llm_provider = 'gemini'
        self.openai_api_key = os.environ.get('OPENAI_API_KEY')
        self.gemini_api_key = os.environ.get('GEMINI_API_KEY')
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

        self.json_store = JsonStoreService(backup_root=self.json_backup_dir, max_backups_per_file=10)
        self._initialize_json_files()

        self.lock = RLock()
        self.upload_service = UploadService(
            hashbook_file=self.hashbook_file,
            upload_folder=self.upload_folder,
            base_dir=self.base_dir,
            lock=self.lock,
            read_json=self.json_store.read_json,
            write_json=self.json_store.write_json,
        )

        self.operations_service = OperationsService(
            lock=self.lock,
            read_json=self._read_json,
            write_json=self._write_json,
            operations_file_for_variant=self.operations_file_for_variant,
            snapshot_file_for_variant=self.snapshot_file_for_variant,
        )

        self.memos_service = MemosService()
        self.backup_service = BackupService()
        self.export_service = ExportService()
        self.frontend_service = FrontendService()

    def _initialize_json_files(self):
        print('📨 Running JSON startup integrity checks...')
        for file_path, default_value in self.json_defaults.items():
            self.json_store.ensure_file(
                file_path,
                default=default_value,
                schema_version=self.json_schema_versions.get(file_path, 1),
            )

        ops_count = 0
        try:
            ops = self.json_store.read_json(self.operations_file, [])
            ops_count = len(ops) if isinstance(ops, list) else 0
        except Exception:
            ops_count = 0

        if ops_count > 0:
            print(f'✅ Event sourcing enabled - {ops_count} operations loaded')
        else:
            print('✅ JSON files validated and ready')

    def _read_json(self, path: str):
        default = self.json_defaults.get(path, [])
        return self.json_store.read_json(path, default=default)

    def _write_json(self, path: str, obj):
        schema_version = self.json_schema_versions.get(path, 1)
        self.json_store.write_json(path, obj, schema_version=schema_version)

    @staticmethod
    def resolve_variant(req) -> str:
        variant = (req.args.get('variant') or '').strip().lower()
        if variant in ('finance', 'default'):
            return variant

        header_variant = (req.headers.get('X-Memo-Variant') or '').strip().lower()
        if header_variant in ('finance', 'default'):
            return header_variant

        referer = req.headers.get('Referer') or ''
        if '/FINANCE/' in referer or '/finance/' in referer:
            return 'finance'

        return 'default'

    def data_file_for_variant(self, variant: str) -> str:
        return self.finance_data_file if variant == 'finance' else self.data_file

    def chat_file_for_variant(self, variant: str) -> str:
        return self.chat_finance_file if variant == 'finance' else self.chat_default_file

    def operations_file_for_variant(self, variant: str) -> str:
        return self.operations_finance_file if variant == 'finance' else self.operations_file

    def snapshot_file_for_variant(self, variant: str) -> str:
        return self.snapshot_finance_file if variant == 'finance' else self.snapshot_file

    def get_memos_for_variant(self, variant: str):
        path = self.data_file_for_variant(variant)
        with self.lock:
            return self._read_json(path)

    def save_memos_for_variant(self, memos, variant: str):
        path = self.data_file_for_variant(variant)
        with self.lock:
            self._write_json(path, memos)

    def get_chat_for_variant(self, variant: str):
        path = self.chat_file_for_variant(variant)
        with self.lock:
            return self._read_json(path)

    def save_chat_for_variant(self, messages, variant: str):
        path = self.chat_file_for_variant(variant)
        with self.lock:
            self._write_json(path, messages)

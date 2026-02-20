import json
import os
import io
from flask import Flask, request, jsonify, render_template, send_from_directory, send_file
from datetime import datetime
from threading import RLock

from service_chat import handle_chat_send, handle_chat_create_entry
from service_upload import ServiceUpload
from service_operations import ServiceOperations
from service_memos import ServiceMemos
from service_backup import ServiceBackup
from service_export import ServiceExport
from service_frontend import ServiceFrontend
from service_json_store import ServiceJsonStore

# --- Configuration ---
USE_SERVER_BACKEND = os.environ.get("USE_SERVER_BACKEND", "true").lower() == "true"
BASE_DIR = os.path.abspath(os.path.dirname(__file__))
UPLOAD_FOLDER = os.path.join(BASE_DIR, 'uploads')
DATA_DIR = os.path.join(BASE_DIR, 'data')
DATA_FILE = os.path.join(DATA_DIR, 'memos.json')
HASHBOOK_FILE = os.path.join(DATA_DIR, 'hashbook.json')
# Additional finance dataset file (separate from default memos.json)
FINANCE_DATA_FILE = os.path.join(DATA_DIR, 'finance.json')
CHAT_DEFAULT_FILE = os.path.join(DATA_DIR, 'chat.json')
CHAT_FINANCE_FILE = os.path.join(DATA_DIR, 'chat_finance.json')

# --- Event Sourcing Operation Log Files ---
OPERATIONS_FILE = os.path.join(DATA_DIR, 'operations.json')
OPERATIONS_FINANCE_FILE = os.path.join(DATA_DIR, 'operations_finance.json')
SNAPSHOT_FILE = os.path.join(DATA_DIR, 'snapshot.json')
SNAPSHOT_FINANCE_FILE = os.path.join(DATA_DIR, 'snapshot_finance.json')
JSON_BACKUP_DIR = os.path.join(DATA_DIR, '.json_backups')

JSON_DEFAULTS = {
    DATA_FILE: [],
    FINANCE_DATA_FILE: [],
    CHAT_DEFAULT_FILE: [],
    CHAT_FINANCE_FILE: [],
    OPERATIONS_FILE: [],
    OPERATIONS_FINANCE_FILE: [],
    SNAPSHOT_FILE: {'snapshotId': 0, 'timestamp': 0, 'entries': []},
    SNAPSHOT_FINANCE_FILE: {'snapshotId': 0, 'timestamp': 0, 'entries': []},
    HASHBOOK_FILE: {},
}

JSON_SCHEMA_VERSIONS = {
    DATA_FILE: 1,
    FINANCE_DATA_FILE: 1,
    CHAT_DEFAULT_FILE: 1,
    CHAT_FINANCE_FILE: 1,
    OPERATIONS_FILE: 1,
    OPERATIONS_FINANCE_FILE: 1,
    SNAPSHOT_FILE: 1,
    SNAPSHOT_FINANCE_FILE: 1,
    HASHBOOK_FILE: 1,
}

# --- LLM Configuration (optional) ---
LLM_PROVIDER = 'gemini'  # 'openai' | 'gemini'
OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY')
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY')
LLM_MODEL = os.environ.get('LLM_MODEL')  # if unset we'll choose a reasonable default per provider
LLM_SYSTEM_PROMPT = (
    "You are an efficient assistant embedded in a personal memo system."
    " You will be provide with a list of their memos."
    " Sometimes the user may not provide the full context of their questions, make an educated guess."
    " Sometimes what the user ask may not match exactly what is in the memos, try to find the closest match."
    " Provide concise, helpful answers. If user asks to reference memos, you can reason over the conversation context only;"
    " you cannot actually read files unless explicitly given their content."
)
LLM_MAX_MESSAGES = int(os.environ.get('LLM_MAX_MESSAGES', '14'))  # number of recent messages (user+assistant) to send

# Initialize Flask app
app = Flask(__name__, static_folder='static', template_folder='templates')
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB upload cap

# Add CORS headers to all responses
@app.after_request
def add_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
    # Allow ALL headers to avoid preflight issues
    response.headers['Access-Control-Allow-Headers'] = '*'
    return response

# Handle CORS preflight requests explicitly
@app.before_request
def handle_preflight():
    # Log request for debugging
    print(f"📨 {request.method} {request.path} from {request.remote_addr}")
    if request.method == "OPTIONS":
        return jsonify({'status': 'OK'})

# Ensure the data and upload folders exist
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
json_store = ServiceJsonStore(backup_root=JSON_BACKUP_DIR, max_backups_per_file=10)
print("📨 Running JSON startup integrity checks...")
for file_path, default_value in JSON_DEFAULTS.items():
    json_store.ensure_file(
        file_path,
        default=default_value,
        schema_version=JSON_SCHEMA_VERSIONS.get(file_path, 1),
    )

ops_count = 0
try:
    ops = json_store.read_json(OPERATIONS_FILE, [])
    ops_count = len(ops) if isinstance(ops, list) else 0
except Exception:
    ops_count = 0

if ops_count > 0:
    print(f"✅ Event sourcing enabled - {ops_count} operations loaded")
else:
    print("✅ JSON files validated and ready")

_lock = RLock()
upload_service = ServiceUpload(
    hashbook_file=HASHBOOK_FILE,
    upload_folder=UPLOAD_FOLDER,
    base_dir=BASE_DIR,
    lock=_lock,
    read_json=json_store.read_json,
    write_json=json_store.write_json,
)
operations_service = None
memos_service = ServiceMemos()
backup_service = ServiceBackup()
export_service = ServiceExport()
frontend_service = ServiceFrontend()

def _read_json(path):
    default = JSON_DEFAULTS.get(path, [])
    return json_store.read_json(path, default=default)

def _write_json(path, obj):
    schema_version = JSON_SCHEMA_VERSIONS.get(path, 1)
    json_store.write_json(path, obj, schema_version=schema_version)

def iso_to_timestamp(iso_string):
    """Convert ISO 8601 timestamp to milliseconds since epoch"""
    try:
        if not iso_string:
            return 0
        if isinstance(iso_string, (int, float)):
            return int(iso_string)
        if isinstance(iso_string, str) and iso_string.isdigit():
            return int(iso_string)
        # Handle both 'Z' suffix and timezone-aware strings
        dt = datetime.fromisoformat(str(iso_string).replace('Z', '+00:00'))
        return int(dt.timestamp() * 1000)
    except (ValueError, AttributeError, TypeError):
        return 0

def _get_variant():
    """
    Determine which variant the request is for.
    Priority: query param ?variant=finance|default -> header X-Memo-Variant -> Referer heuristic -> default.
    """
    v = (request.args.get('variant') or '').strip().lower()
    if v in ('finance', 'default'):
        return v
    hdr = (request.headers.get('X-Memo-Variant') or '').strip().lower()
    if hdr in ('finance', 'default'):
        return hdr
    # Heuristic: referer path contains '/FINANCE/' (case-insensitive)
    ref = (request.headers.get('Referer') or '')
    if '/FINANCE/' in ref or '/finance/' in ref:
        return 'finance'
    return 'default'

def _data_file_for_variant(variant: str) -> str:
    return FINANCE_DATA_FILE if variant == 'finance' else DATA_FILE

def _chat_file_for_variant(variant: str) -> str:
    return CHAT_FINANCE_FILE if variant == 'finance' else CHAT_DEFAULT_FILE

def _operations_file_for_variant(variant: str) -> str:
    return OPERATIONS_FINANCE_FILE if variant == 'finance' else OPERATIONS_FILE

def _snapshot_file_for_variant(variant: str) -> str:
    return SNAPSHOT_FINANCE_FILE if variant == 'finance' else SNAPSHOT_FILE

operations_service = ServiceOperations(
    lock=_lock,
    read_json=_read_json,
    write_json=_write_json,
    operations_file_for_variant=_operations_file_for_variant,
    snapshot_file_for_variant=_snapshot_file_for_variant,
)

def get_memos_for_variant(variant: str):
    path = _data_file_for_variant(variant)
    with _lock:
        return _read_json(path)

def save_memos_for_variant(memos, variant: str):
    path = _data_file_for_variant(variant)
    with _lock:
        _write_json(path, memos)

def get_chat_for_variant(variant: str):
    path = _chat_file_for_variant(variant)
    with _lock:
        return _read_json(path)

def save_chat_for_variant(messages, variant: str):
    path = _chat_file_for_variant(variant)
    with _lock:
        _write_json(path, messages)

# --- Chat API ---
@app.route('/api/chat', methods=['GET'])
def chat_list():
    if not USE_SERVER_BACKEND:
        return jsonify([])
    variant = _get_variant()
    return jsonify(get_chat_for_variant(variant))

@app.route('/api/chat', methods=['POST'])
def chat_send():
    if not USE_SERVER_BACKEND:
        return jsonify({"message": "Server backend is disabled."}), 400
    variant = _get_variant()
    payload = request.get_json(force=True, silent=True) or {}
    result, status = handle_chat_send(
        payload=payload,
        variant=variant,
        get_chat_for_variant=get_chat_for_variant,
        save_chat_for_variant=save_chat_for_variant,
        get_memos_for_variant=get_memos_for_variant,
        provider=LLM_PROVIDER,
        model=LLM_MODEL,
        system_prompt=LLM_SYSTEM_PROMPT,
        openai_key=OPENAI_API_KEY,
        gemini_key=GEMINI_API_KEY,
        max_messages=LLM_MAX_MESSAGES,
    )
    return jsonify(result), status

@app.route('/api/chat', methods=['DELETE'])
def chat_clear():
    if not USE_SERVER_BACKEND:
        return jsonify({"message": "Server backend is disabled."}), 400
    variant = _get_variant()
    save_chat_for_variant([], variant)
    return jsonify([])

@app.route('/api/chat/create-entry', methods=['POST'])
def chat_create_entry():
    """AI-powered entry creation from uploaded files"""
    if not USE_SERVER_BACKEND:
        return jsonify({"message": "Server backend is disabled."}), 400
    variant = _get_variant()
    files = request.files.getlist('files')
    user_message = request.form.get('message', '').strip()
    result, status = handle_chat_create_entry(
        files=files,
        user_message=user_message,
        variant=variant,
        upload_folder=UPLOAD_FOLDER,
        base_dir=BASE_DIR,
        llm_provider=LLM_PROVIDER,
        get_memos_for_variant=get_memos_for_variant,
        save_memos_for_variant=save_memos_for_variant,
        append_operation=operations_service.append_operation,
        get_chat_for_variant=get_chat_for_variant,
        save_chat_for_variant=save_chat_for_variant,
    )
    return jsonify(result), status

# --- Health / Config ---
@app.route('/api/config', methods=['GET'])
def api_config():
    """Tell the frontend whether server mode is on."""
    return jsonify({"server": USE_SERVER_BACKEND})

# --- Event Sourcing Operation API ---

@app.route('/api/operations/push', methods=['POST'])
def push_operations():
    """
    Accept operations from client and store them in the operation log.
    Returns the assigned server operation IDs.
    """
    if not USE_SERVER_BACKEND:
        return jsonify({"success": False, "message": "Server backend disabled"}), 400
    variant = _get_variant()
    payload = request.get_json(force=True, silent=True) or {}
    result, status = operations_service.handle_push_operations(payload, variant, save_memos_for_variant)
    return jsonify(result), status

@app.route('/api/operations/pull', methods=['GET'])
def pull_operations():
    """
    Return operations since a given operation ID.
    If client is too far behind, return snapshot + recent operations.
    """
    if not USE_SERVER_BACKEND:
        return jsonify({"needsFullSync": False, "operations": []}), 400
    variant = _get_variant()
    since_op_id = int(request.args.get('sinceOpId', 0))
    result, status = operations_service.handle_pull_operations(since_op_id, variant)
    return jsonify(result), status

@app.route('/api/operations/compact', methods=['POST'])
def compact_operations():
    """
    Create a snapshot and remove old operations.
    This should be called periodically (e.g., nightly cron job).
    """
    if not USE_SERVER_BACKEND:
        return jsonify({"success": False}), 400
    variant = _get_variant()
    payload = request.get_json(silent=True) or {}
    result, status = operations_service.handle_compact_operations(payload, variant)
    return jsonify(result), status

# --- Memo API ---
@app.route('/api/memos', methods=['GET'])
def get_all_memos():
    """Returns all memos."""
    if USE_SERVER_BACKEND:
        variant = _get_variant()
        result, status = memos_service.handle_get_all_memos(variant, get_memos_for_variant)
        return jsonify(result), status
    return jsonify([])

@app.route('/api/memos', methods=['POST'])
def create_memo():
    """Creates a new memo."""
    if not USE_SERVER_BACKEND:
        return jsonify({"message": "Server backend is disabled."}), 400
    variant = _get_variant()
    payload = request.get_json(force=True, silent=True) or {}
    result, status = memos_service.handle_create_memo(payload, variant, get_memos_for_variant, save_memos_for_variant)
    return jsonify(result), status

@app.route('/api/memos/<memo_id>', methods=['PUT'])
def update_memo(memo_id):
    """Updates an existing memo. Also deletes any locally-stored images removed from this memo."""
    if not USE_SERVER_BACKEND:
        return jsonify({"message": "Server backend is disabled."}), 400
    variant = _get_variant()
    updated_data = request.get_json(force=True, silent=True) or {}
    result, status = memos_service.handle_update_memo(
        memo_id,
        updated_data,
        variant,
        get_memos_for_variant,
        save_memos_for_variant,
        upload_service.delete_upload_url,
    )
    return jsonify(result), status

@app.route('/api/memos/<memo_id>', methods=['DELETE'])
def delete_memo(memo_id):
    """Deletes a memo. Supports soft delete (default) or permanent delete (?permanent=true)."""
    if not USE_SERVER_BACKEND:
        return jsonify({"message": "Server backend is disabled."}), 400
    permanent = request.args.get('permanent', 'false').lower() == 'true'
    variant = _get_variant()
    result, status = memos_service.handle_delete_memo(
        memo_id,
        permanent,
        variant,
        get_memos_for_variant,
        save_memos_for_variant,
        upload_service.delete_upload_url,
    )
    return jsonify(result), status

@app.route('/api/memos/<memo_id>/restore', methods=['POST'])
def restore_memo(memo_id):
    """Restores a soft-deleted memo from the recycle bin."""
    if not USE_SERVER_BACKEND:
        return jsonify({"message": "Server backend is disabled."}), 400
    variant = _get_variant()
    result, status = memos_service.handle_restore_memo(
        memo_id,
        variant,
        get_memos_for_variant,
        save_memos_for_variant,
    )
    return jsonify(result), status


# --- Uploads ---
@app.route('/api/upload', methods=['POST'])
def upload_file():
    """
       Handles file uploads; stores in uploads/YYYY-MM-DD/ and returns that URL.
       Also does de-duplication (SHA-256).
       Stores/reuses under uploads/_blobs/sha256/<hash><ext>, returns that URL.
       Supports multipart/form-data (standard) and JSON base64 (Capacitor workaround).
    """

    result, status = upload_service.handle_upload_request(request, USE_SERVER_BACKEND)
    return jsonify(result), status

@app.route('/uploads/<path:filename>')
def serve_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

# --- Frontend ---
@app.route('/')
def serve_index():
    return render_template(frontend_service.index_template())

@app.route('/index.html')
def serve_index_html():
    return render_template(frontend_service.index_template())

# Finance page route
@app.route('/finance')
def serve_finance():
    return render_template(frontend_service.finance_template())

@app.route('/finance.html')
def serve_finance_html():
    return render_template(frontend_service.finance_template())

@app.route('/api/export/detailed-pdf', methods=['POST'])
def export_detailed_pdf():
    if not USE_SERVER_BACKEND:
        return jsonify({'message': 'Server backend is disabled.'}), 400

    payload = request.get_json(force=True, silent=True) or {}
    variant = _get_variant()
    result, status = export_service.handle_detailed_pdf_export(payload, variant, BASE_DIR, get_memos_for_variant)
    if status != 200:
        return jsonify(result), status

    return send_file(
        io.BytesIO(result['pdfBytes']),
        mimetype=result['mimetype'],
        as_attachment=True,
        download_name=result['filename']
    )

@app.route('/api/backup', methods=['GET'])
def download_backup():
    if not USE_SERVER_BACKEND:
        return jsonify({"message": "Server backend disabled"}), 400
    mem_zip, filename = backup_service.handle_download_backup(BASE_DIR, DATA_DIR, UPLOAD_FOLDER)
    return send_file(mem_zip, as_attachment=True, download_name=filename)

if __name__ == '__main__':
     # Run: USE_SERVER_BACKEND=true python app.py
     app.run(host='0.0.0.0', port=5050, debug=True)

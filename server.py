import json
import os
import uuid
import zipfile
import io
import mimetypes
from urllib.parse import urlparse
from flask import Flask, request, jsonify, render_template, send_from_directory, send_file
from werkzeug.utils import secure_filename
from datetime import datetime
from threading import Lock
import hashlib
import textwrap
import importlib

# Import LLM service
from llm_service import create_llm_service

# Optional LLM provider SDKs (installed only if you want AI chat replies)
try:  # OpenAI (>=1.0 new SDK) - optional
    from openai import OpenAI  # type: ignore
    _openai_available = True
except Exception:
    OpenAI = None  # type: ignore
    _openai_available = False

try:  # Google Gemini
    import google.generativeai as genai  # type: ignore
    _gemini_available = True
except Exception:
    genai = None  # type: ignore
    _gemini_available = False

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
if not os.path.exists(DATA_FILE):
    with open(DATA_FILE, 'w', encoding='utf-8') as f:
        f.write("[]")
if not os.path.exists(HASHBOOK_FILE):
    with open(HASHBOOK_FILE, 'w', encoding='utf-8') as f:
        f.write("{}")
if not os.path.exists(FINANCE_DATA_FILE):
    with open(FINANCE_DATA_FILE, 'w', encoding='utf-8') as f:
        f.write("[]")
if not os.path.exists(CHAT_DEFAULT_FILE):
    with open(CHAT_DEFAULT_FILE, 'w', encoding='utf-8') as f:
        f.write("[]")
if not os.path.exists(CHAT_FINANCE_FILE):
    with open(CHAT_FINANCE_FILE, 'w', encoding='utf-8') as f:
        f.write("[]")

# Initialize operation log files
print("📨 Initializing event sourcing operation log files...")
operations_created = False
snapshots_created = False

if not os.path.exists(OPERATIONS_FILE):
    with open(OPERATIONS_FILE, 'w', encoding='utf-8') as f:
        f.write("[]")
    operations_created = True
if not os.path.exists(OPERATIONS_FINANCE_FILE):
    with open(OPERATIONS_FINANCE_FILE, 'w', encoding='utf-8') as f:
        f.write("[]")
    operations_created = True
if not os.path.exists(SNAPSHOT_FILE):
    with open(SNAPSHOT_FILE, 'w', encoding='utf-8') as f:
        f.write('{"snapshotId": 0, "timestamp": 0, "entries": []}')
    snapshots_created = True
if not os.path.exists(SNAPSHOT_FINANCE_FILE):
    with open(SNAPSHOT_FINANCE_FILE, 'w', encoding='utf-8') as f:
        f.write('{"snapshotId": 0, "timestamp": 0, "entries": []}')
    snapshots_created = True

if operations_created or snapshots_created:
    print("✅ Operation log files initialized")
else:
    # Check if files have data (from migration)
    ops_count = 0
    try:
        with open(OPERATIONS_FILE, 'r') as f:
            ops = json.load(f)
            ops_count = len(ops) if isinstance(ops, list) else 0
    except:
        pass
    
    if ops_count > 0:
        print(f"✅ Event sourcing enabled - {ops_count} operations loaded")
    else:
        print("✅ Event sourcing files ready (run migrate_to_event_sourcing.py if needed)")

_lock = Lock()
_operation_id_counter = 0  # Auto-incrementing operation ID

def _read_json(path):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []

def _write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)

def iso_to_timestamp(iso_string):
    """Convert ISO 8601 timestamp to milliseconds since epoch"""
    try:
        if not iso_string:
            return 0
        # Handle both 'Z' suffix and timezone-aware strings
        dt = datetime.fromisoformat(iso_string.replace('Z', '+00:00'))
        return int(dt.timestamp() * 1000)
    except (ValueError, AttributeError):
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

# --- Event Sourcing Operation Log Functions ---

def get_operations_for_variant(variant: str):
    """Get all operations for a variant"""
    path = _operations_file_for_variant(variant)
    with _lock:
        return _read_json(path)

def save_operations_for_variant(operations, variant: str):
    """Save operations for a variant"""
    path = _operations_file_for_variant(variant)
    with _lock:
        _write_json(path, operations)

def append_operation(operation, variant: str):
    """Append a single operation to the log"""
    global _operation_id_counter
    with _lock:
        operations = get_operations_for_variant(variant)
        
        # Auto-assign operation ID if not present
        if 'opId' not in operation:
            # Find max opId from existing operations
            max_id = 0
            for op in operations:
                if isinstance(op.get('opId'), int):
                    max_id = max(max_id, op['opId'])
            operation['opId'] = max_id + 1
        
        # Add timestamp if not present
        if 'timestamp' not in operation:
            operation['timestamp'] = int(datetime.utcnow().timestamp() * 1000)
        
        operations.append(operation)
        save_operations_for_variant(operations, variant)
        
        return operation['opId']

def get_operations_since(since_op_id, variant: str):
    """Get operations after a specific operation ID"""
    operations = get_operations_for_variant(variant)
    return [op for op in operations if op.get('opId', 0) > since_op_id]

def get_snapshot_for_variant(variant: str):
    """Get the latest snapshot"""
    path = _snapshot_file_for_variant(variant)
    with _lock:
        data = read_key_json(path)
        if not data or 'entries' not in data:
            return {'snapshotId': 0, 'timestamp': 0, 'entries': []}
        return data

def save_snapshot_for_variant(snapshot, variant: str):
    """Save a snapshot"""
    path = _snapshot_file_for_variant(variant)
    with _lock:
        write_key_json(path, snapshot)

def rebuild_state_from_operations(variant: str, up_to_op_id=None):
    """Rebuild current state from snapshot + operations"""
    snapshot = get_snapshot_for_variant(variant)
    operations = get_operations_for_variant(variant)
    
    # Start with snapshot entries
    entries = {e['id']: e for e in snapshot.get('entries', [])}
    
    # Apply operations after snapshot
    for op in operations:
        op_id = op.get('opId', 0)
        
        # Stop if we've reached the target operation
        if up_to_op_id and op_id > up_to_op_id:
            break
        
        # Skip operations before snapshot
        if op_id <= snapshot.get('snapshotId', 0):
            continue
        
        op_type = op.get('type')
        entry_id = op.get('entryId')
        
        if op_type == 'create':
            entries[entry_id] = op.get('data', {})
            entries[entry_id]['id'] = entry_id
        elif op_type == 'update':
            if entry_id in entries:
                # Update specific fields
                if 'data' in op:
                    entries[entry_id].update(op['data'])
                elif 'field' in op and 'value' in op:
                    entries[entry_id][op['field']] = op['value']
        elif op_type == 'delete':
            if entry_id in entries:
                entries[entry_id]['deletedAt'] = datetime.utcfromtimestamp(op['timestamp'] / 1000).isoformat() + 'Z'
                entries[entry_id]['deletedBy'] = op.get('deviceId', 'unknown')
        elif op_type == 'addImage':
            if entry_id in entries:
                if 'images' not in entries[entry_id]:
                    entries[entry_id]['images'] = []
                entries[entry_id]['images'].append(op.get('url'))
        elif op_type == 'addAttachment':
            if entry_id in entries:
                if 'attachments' not in entries[entry_id]:
                    entries[entry_id]['attachments'] = []
                entries[entry_id]['attachments'].append(op.get('attachment'))
    
    return list(entries.values())

# Helper Function to delete file
def delete_upload_url(image_url: str):
    """
    Decrement refcount in hashbook for this image; delete only when it reaches zero.
    If the image isn't in the hashbook, delete the file directly (legacy).
    Also cleans empty date folders.
    """
    if not image_url or not image_url.startswith('/uploads/'):
        return

    rel = os.path.normpath(image_url.lstrip('/'))
    full_path = os.path.join(app.root_path, rel)

    # If file doesn't exist, just clean potential stale hashbook entries
    if not os.path.exists(full_path):
        book = get_hashbook()
        dirty = False
        for h, rec in list(book.items()):
            if isinstance(rec, dict) and rec.get("url") == image_url:
                del book[h]
                dirty = True
        if dirty:
            save_hashbook(book)
        return

    # Compute hash of the on-disk file to find the right record
    try:
        file_hash = compute_file_sha256_from_path(full_path)
    except Exception as e:
        print(f"Error hashing for deletion {full_path}: {e}")
        file_hash = None

    book = get_hashbook()

    if file_hash and file_hash in book and isinstance(book[file_hash], dict):
        rec = book[file_hash]
        rec['count'] = max(0, int(rec.get('count', 0)) - 1)
        if rec['count'] == 0:
            # Safe to remove file and mapping
            try:
                os.remove(full_path)
            except OSError as e:
                print(f"Error deleting file {full_path}: {e}")
            book.pop(file_hash, None)
            save_hashbook(book)

            # Attempt to remove empty folders
            try:
                os.removedirs(os.path.dirname(full_path))
            except OSError:
                pass
        else:
            # Still in use; update count only
            book[file_hash] = rec
            save_hashbook(book)
    else:
        # Not tracked in hashbook (legacy). Delete the file.
        try:
            os.remove(full_path)
        except OSError as e:
            print(f"Error deleting file {full_path}: {e}")
        # Best-effort: clean any stale entries pointing to this URL
        dirty = False
        for h, rec in list(book.items()):
            if isinstance(rec, dict) and rec.get("url") == image_url:
                del book[h]; dirty = True
        if dirty:
            save_hashbook(book)
        try:
            os.removedirs(os.path.dirname(full_path))
        except OSError:
            pass


# Helper Address Book

def read_key_json(path):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            obj = json.load(f)
            return obj if isinstance(obj, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}

def write_key_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)

def get_hashbook():
    with _lock:
        return read_key_json(HASHBOOK_FILE)

def save_hashbook(book):
    with _lock:
        write_key_json(HASHBOOK_FILE, book)

def compute_filestorage_sha256(file_storage, chunk_size=1024*1024):
    """
    Compute sha256 of a Werkzeug FileStorage without consuming it permanently.
    Resets the stream to position 0 afterwards.
    """
    h = hashlib.sha256()
    stream = file_storage.stream
    try:
        pos = stream.tell()
    except Exception:
        pos = None

    # Ensure start
    try:
        stream.seek(0)
    except Exception:
        pass

    while True:
        chunk = stream.read(chunk_size)
        if not chunk:
            break
        h.update(chunk)

    # Reset for later save()
    try:
        stream.seek(0 if pos is None else pos)
    except Exception:
        pass

    return h.hexdigest()

def compute_file_sha256_from_path(path, chunk_size=1024*1024):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()

def is_file_in_hashbook(file_storage):
    """
    Returns (True, file_hash, record) if duplicate and file exists,
    where record = {"url": ..., "count": int}.
    Otherwise returns (False, file_hash, None) and cleans stale mappings.
    """
    file_hash = compute_filestorage_sha256(file_storage)
    book = get_hashbook()
    rec = book.get(file_hash)

    if rec and isinstance(rec, dict):
        existing_url = rec.get("storedPath")
        if existing_url:
            rel = os.path.normpath(existing_url.lstrip('/'))
            full_path = os.path.join(app.root_path, rel)
            if os.path.isfile(full_path):
                return True, file_hash, rec
        # stale: remove and fall through
        book.pop(file_hash, None)
        save_hashbook(book)

    return False, file_hash, None

# --- LLM Integration Helpers ---
def _generate_llm_reply(history_messages, latest_user_text: str) -> str:
    """Generate assistant reply using configured LLM provider.

    history_messages: list of persisted dicts with keys (role: user|assistant, content)
    latest_user_text: raw user input (already in history)

    Returns plain string reply. If provider misconfigured or errors, returns fallback notice.
    """
    provider = LLM_PROVIDER
    if not provider:
        return "(AI disabled: Set LLM_PROVIDER=openai or gemini and API key env vars to enable.)"

    try:
        if provider == 'openai':
            if not _openai_available:
                return "(OpenAI SDK unavailable on server)"
            if not OPENAI_API_KEY:
                return "(Missing OPENAI_API_KEY)"
            client = OpenAI(api_key=OPENAI_API_KEY)
            model = LLM_MODEL or 'gpt-4o-mini'
            # Convert history
            msgs = []
            if LLM_SYSTEM_PROMPT:
                msgs.append({"role": "system", "content": LLM_SYSTEM_PROMPT})
            for m in history_messages:
                r = m.get('role')
                if r in ('user','assistant', 'system'):
                    msgs.append({"role": r, "content": m.get('content','')[:4000]})
            # Call OpenAI
            resp = client.chat.completions.create(model=model, messages=msgs, temperature=0.7,)
            return (resp.choices[0].message.content or '').strip()
        elif provider == 'gemini':
            if not _gemini_available:
                return "(Gemini SDK unavailable on server)"
            if not GEMINI_API_KEY:
                return "(Missing GEMINI_API_KEY)"
            genai.configure(api_key=GEMINI_API_KEY)
            model_name = LLM_MODEL or 'gemini-2.5-flash-lite'
            # Compose a single prompt with light formatting (Gemini Python SDK chat style)
            convo_lines = []
            if LLM_SYSTEM_PROMPT:
                convo_lines.append(f"System: {LLM_SYSTEM_PROMPT}")
            for m in history_messages:
                r = m.get('role')
                if r in ('user','assistant', 'system'):
                    convo_lines.append(f"{r.capitalize()}: {m.get('content','')}")
            convo_lines.append(f"User: {latest_user_text}")
            convo_lines.append("Assistant:")
            prompt = "\n".join(convo_lines)[-12000:]  # trim safety
            model = genai.GenerativeModel(model_name)
            resp = model.generate_content(prompt)
            if hasattr(resp, 'text') and resp.text:
                return resp.text.strip()
            # Fallback: try to join candidates
            parts = []
            try:
                for cand in getattr(resp, 'candidates', []) or []:
                    for part in getattr(cand, 'content', {}).get('parts', []):
                        t = getattr(part, 'text', '') or ''
                        if t:
                            parts.append(t)
            except Exception:
                pass
            return (" ".join(parts).strip()) or "(No response from Gemini)"
        else:
            return f"(Unsupported LLM_PROVIDER '{provider}')"
    except Exception as e:
        return f"(LLM error: {e.__class__.__name__}: {e})"

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
    user_text = (payload.get('message') or '').strip()
    visible_ids = payload.get('visibleIds') or []
    if isinstance(visible_ids, list):
        visible_ids = [str(i) for i in visible_ids if isinstance(i, (str,int))]
    else:
        visible_ids = []
    if not user_text:
        return jsonify({"message": "Empty message"}), 400
    history = get_chat_for_variant(variant)
    now = datetime.utcnow().isoformat() + 'Z'
    user_msg = {"id": str(uuid.uuid4()), "role": "user", "content": user_text, "ts": now}

    # Append user first so it is part of persisted history regardless of LLM success
    history.append(user_msg)

    # Prepare the subset of history to send to LLM (exclude any future assistant message)
    ctx = history[-LLM_MAX_MESSAGES:]

    # Build filtered entries summary (server-side read for provided IDs)
    entries_summary = ''
    if visible_ids:
        try:
            all_entries = get_memos_for_variant(variant)
            subset = [e for e in all_entries if str(e.get('id')) in set(visible_ids)]
            # Limit to avoid blowing context
            subset = subset[: min(len(subset), 60)]
            lines = []
            for e in subset:
                desc = (e.get('description') or '').replace('\n',' ')[:160]
                tags = ','.join(e.get('tags') or [])
                category = e.get('category') or 'Uncategorized'
                # For finance variant include key numeric fields
                if variant == 'finance':
                    pd = e.get('purchaseDate') or ''
                    price = e.get('price')
                    tax = e.get('tax')
                    adj = e.get('adjustment')
                    total = e.get('total')
                    lines.append(f"ID={e.get('id')} | date={pd} | category={category} | price={price} tax={tax} adj={adj} total={total} | tags={tags} | desc='{desc}'")
                else:
                    ts = e.get('ts')
                    lines.append(f"ID={e.get('id')} | date = {e.get('createdAt')} | ts={ts} | category={category} | tags={tags} | desc='{desc}'")
            entries_summary = '\n'.join(lines)
        except Exception as e:
            entries_summary = f"(Could not build entries summary: {e})"

    if entries_summary:
        synthetic_context_message = {"role": "system", "content": f"Visible filtered entries (count={len(entries_summary.splitlines())}):\n" + entries_summary }
        ctx = [synthetic_context_message] + ctx

    assistant_reply = _generate_llm_reply(ctx, user_text)

    bot_msg = {"id": str(uuid.uuid4()), "role": "assistant", "content": assistant_reply, "ts": datetime.utcnow().isoformat() + 'Z'}
    history.append(bot_msg)
    save_chat_for_variant(history, variant)
    return jsonify({"messages": [user_msg, bot_msg]})

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
    
    # Get uploaded files
    files = request.files.getlist('files')
    user_message = request.form.get('message', '').strip()
    
    if not files:
        return jsonify({"error": "No files provided"}), 400
    
    # Upload files and collect URLs
    file_urls = []
    for file in files:
        if file and file.filename:
            filename = secure_filename(file.filename)
            date_folder = datetime.now().strftime('%Y-%m-%d')
            date_path = os.path.join(UPLOAD_FOLDER, date_folder)
            os.makedirs(date_path, exist_ok=True)
            
            # Add unique prefix to avoid collisions
            unique_name = f"{uuid.uuid4().hex[:8]}_{filename}"
            file_path = os.path.join(date_path, unique_name)
            file.save(file_path)
            
            file_url = f"/uploads/{date_folder}/{unique_name}"
            file_urls.append(file_url)
    
    # Call LLM to analyze files and generate entry
    entry_data = _generate_entry_from_files(file_urls, user_message, variant)
    
    # Create the entry
    entry_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat() + 'Z'
    
    new_entry = {
        'id': entry_id,
        'description': f"[AI Generated] {entry_data.get('description', 'Entry from uploaded file')}",
        'category': entry_data.get('category', 'Uncategorized'),
        'tags': entry_data.get('tags', []),
        'images': file_urls if any(f.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.webp')) for f in file_urls) else [],
        'attachments': [{'url': f, 'name': f.split('/')[-1]} for f in file_urls if not f.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.webp'))],
        'ts': int(datetime.utcnow().timestamp() * 1000),
        'createdAt': now,
        'updatedAt': now
    }
    
    # Add finance-specific fields if in finance variant
    if variant == 'finance':
        new_entry['purchaseDate'] = entry_data.get('purchaseDate', datetime.now().strftime('%Y-%m-%d'))
        new_entry['price'] = entry_data.get('price', 0)
        new_entry['tax'] = entry_data.get('tax', 0)
        new_entry['adjustment'] = entry_data.get('adjustment', 0)
        new_entry['total'] = entry_data.get('total', 0)
    
    # Save to database
    memos = get_memos_for_variant(variant)
    memos.append(new_entry)
    save_memos_for_variant(memos, variant)
    
    # Append operation to event log
    append_operation({
        'type': 'create',
        'entryId': entry_id,
        'data': new_entry
    }, variant)
    
    # Create chat messages
    history = get_chat_for_variant(variant)
    
    user_msg = {
        'id': str(uuid.uuid4()),
        'role': 'user',
        'content': user_message or 'Creating entry from files...',
        'ts': now,
        'files': file_urls
    }
    
    assistant_msg = {
        'id': str(uuid.uuid4()),
        'role': 'assistant',
        'content': f"✓ Created entry: {new_entry['description']}\n\nCategory: {new_entry['category']}\nTags: {', '.join(new_entry['tags']) if new_entry['tags'] else 'None'}",
        'ts': datetime.utcnow().isoformat() + 'Z',
        'entryId': entry_id
    }
    
    history.append(user_msg)
    history.append(assistant_msg)
    save_chat_for_variant(history, variant)
    
    return jsonify({
        'entry': new_entry,
        'messages': [user_msg, assistant_msg]
    })

def _generate_entry_from_files(file_urls, user_message, variant):
    """Use LLM to analyze files and generate entry metadata"""
    try:
        # Initialize LLM service (lazily to pick up latest env vars if any)
        llm = create_llm_service(provider=LLM_PROVIDER)
        
        # Prepare file paths (remove leading slash from URL to make them relative)
        file_paths = [url.lstrip('/') for url in file_urls]
        
        print(f"🤖 Calling LLM ({LLM_PROVIDER}) for {len(file_paths)} files...")
        
        # Execute analysis
        result = llm.analyze_files_for_entry(
            file_paths=file_paths,
            user_message=user_message,
            variant=variant,
            base_dir=BASE_DIR
        )
        
        return result
        
    except Exception as e:
        print(f"❌ LLM Integration Error: {e}")
        # Return fallback data so the flow doesn't break
        return {
            'description': 'File processing completed (AI analysis failed)',
            'category': 'Uncategorized',
            'tags': ['ai-error'],
            'price': 0,
            'total': 0
        }

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
    client_operations = payload.get('operations', [])
    
    if not client_operations:
        return jsonify({"success": True, "operations": []}), 200
    
    assigned_ops = []
    
    for client_op in client_operations:
        # Validate operation structure
        if 'type' not in client_op or 'entryId' not in client_op:
            continue
        
        # Check for duplicate operation (idempotency)
        client_op_id = client_op.get('clientOpId')
        if client_op_id:
            existing_ops = get_operations_for_variant(variant)
            if any(op.get('clientOpId') == client_op_id for op in existing_ops):
                # Already processed, return existing opId
                existing_op = next(op for op in existing_ops if op.get('clientOpId') == client_op_id)
                assigned_ops.append({
                    'clientOpId': client_op_id,
                    'serverOpId': existing_op['opId'],
                    'duplicate': True
                })
                continue
        
        # Append operation to log
        operation = {
            'type': client_op['type'],
            'entryId': client_op['entryId'],
            'timestamp': client_op.get('timestamp', int(datetime.utcnow().timestamp() * 1000)),
            'deviceId': client_op.get('deviceId', 'unknown'),
            'clientOpId': client_op_id,
            'data': client_op.get('data'),
            'field': client_op.get('field'),
            'value': client_op.get('value'),
            'url': client_op.get('url'),
            'attachment': client_op.get('attachment')
        }
        
        server_op_id = append_operation(operation, variant)
        
        assigned_ops.append({
            'clientOpId': client_op_id,
            'serverOpId': server_op_id,
            'duplicate': False
        })
    
    # Also update legacy memos.json for backward compatibility
    try:
        current_state = rebuild_state_from_operations(variant)
        save_memos_for_variant(current_state, variant)
    except Exception as e:
        print(f"⚠️ Failed to update legacy memos.json: {e}")
    
    return jsonify({
        'success': True,
        'operations': assigned_ops,
        'serverTime': int(datetime.utcnow().timestamp() * 1000)
    })

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
    
    snapshot = get_snapshot_for_variant(variant)
    snapshot_id = snapshot.get('snapshotId', 0)
    
    # If client is asking for operations before our snapshot, they need full sync
    if since_op_id < snapshot_id:
        operations = get_operations_since(snapshot_id, variant)
        return jsonify({
            'needsFullSync': True,
            'snapshot': snapshot,
            'operations': operations,
            'serverTime': int(datetime.utcnow().timestamp() * 1000)
        })
    
    # Return operations since requested ID
    operations = get_operations_since(since_op_id, variant)
    
    return jsonify({
        'needsFullSync': False,
        'operations': operations,
        'latestOpId': operations[-1]['opId'] if operations else since_op_id,
        'serverTime': int(datetime.utcnow().timestamp() * 1000)
    })

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
    
    # Configurable: keep operations from last N days (default 30)
    keep_days = payload.get('keepDays', 30)
    cutoff_timestamp = int((datetime.utcnow().timestamp() - (keep_days * 24 * 60 * 60)) * 1000)
    
    operations = get_operations_for_variant(variant)
    
    # Find the last operation before cutoff
    ops_before_cutoff = [op for op in operations if op.get('timestamp', 0) < cutoff_timestamp]
    
    if not ops_before_cutoff:
        return jsonify({
            'success': True,
            'message': 'No operations to compact',
            'compactedCount': 0
        })
    
    last_op_before_cutoff = max(ops_before_cutoff, key=lambda op: op.get('opId', 0))
    snapshot_op_id = last_op_before_cutoff['opId']
    
    # Rebuild state up to that operation
    entries = rebuild_state_from_operations(variant, up_to_op_id=snapshot_op_id)
    
    # Create snapshot
    snapshot = {
        'snapshotId': snapshot_op_id,
        'timestamp': last_op_before_cutoff['timestamp'],
        'entries': entries
    }
    save_snapshot_for_variant(snapshot, variant)
    
    # Remove old operations (keep only after snapshot)
    remaining_ops = [op for op in operations if op.get('opId', 0) > snapshot_op_id]
    save_operations_for_variant(remaining_ops, variant)
    
    compacted_count = len(operations) - len(remaining_ops)
    
    print(f"✂️ Compacted {compacted_count} operations into snapshot (opId: {snapshot_op_id})")
    
    return jsonify({
        'success': True,
        'message': f'Compacted {compacted_count} operations',
        'snapshotId': snapshot_op_id,
        'remainingOps': len(remaining_ops),
        'compactedCount': compacted_count
    })

# --- Sync API (Legacy - kept for backward compatibility) ---
@app.route('/api/sync/compare', methods=['POST'])
def sync_compare():
    """Compare client and server entries to determine what needs to be synced"""
    if not USE_SERVER_BACKEND:
        return jsonify({"needsUpload": [], "needsDownload": [], "needsDelete": []}), 400
    
    variant = _get_variant()
    payload = request.get_json(force=True, silent=True) or {}
    
    client_summary = payload.get('entries', [])  # [{id, modifiedAt, hash}, ...]
    client_deleted = payload.get('deleted', [])  # [id, ...]
    
    # Get server entries
    server_entries = get_memos_for_variant(variant)
    
    # Create lookup maps
    client_map = {e['id']: e for e in client_summary}
    server_map = {e['id']: e for e in server_entries if not e.get('deletedAt')}
    
    needs_upload = []  # Entries client should upload to server
    needs_download = []  # Entries client should download from server
    needs_delete = []  # Entries to delete from server
    
    # Check each client entry
    for client_id, client_entry in client_map.items():
        if client_id in server_map:
            server_entry = server_map[client_id]
            
            client_hash = client_entry.get('hash')
            server_hash = hash_entry_server(server_entry)
            
            # Use 'updatedAt' field as the modification time (not 'ts' which is creation time)
            server_modified = iso_to_timestamp(server_entry.get('updatedAt', server_entry.get('createdAt', '')))
            client_modified = client_entry.get('modifiedAt', 0)
            
            # Debug logging
            print(f"🔍 Comparing entry {client_id}:")
            print(f"   Client modifiedAt: {client_modified}, Server updatedAt: {server_modified}")
            print(f"   Client hash: {client_hash}, Server hash: {server_hash}")
            
            # Compare modification times
            if client_hash == server_hash:
                # Hashes match = content identical, no sync needed
                print(f"   ✅ In sync (identical content)")
            elif client_modified > server_modified:
                # Client is newer, upload to server
                print(f"   ⬆️ Client newer, needs upload")
                needs_upload.append(client_id)
            elif server_modified > client_modified:
                # Server is newer, download from server
                print(f"   ⬇️ Server newer, needs download")
                needs_download.append(client_id)
            else:
                # Equal timestamps
                print(f"   ✅ In sync")
        else:
            # Entry exists on client but not server - upload it
            print(f"📤 Entry {client_id} not on server, needs upload")
            needs_upload.append(client_id)
    
    # Check each server entry
    for server_id, server_entry in server_map.items():
        if server_id not in client_map:
            # Entry exists on server but not client - download it
            needs_download.append(server_id)
    
    # Check deletions
    for deleted_id in client_deleted:
        if deleted_id in server_map:
            # Client deleted this entry, delete from server
            needs_delete.append(deleted_id)
    
    return jsonify({
        'needsUpload': needs_upload,
        'needsDownload': needs_download,
        'needsDelete': needs_delete
    })

def hash_entry_server(entry):
    """Create a simple hash of an entry for comparison (matches frontend logic)"""
    import json
    relevant = {
        'attachments': ','.join([a.get('name', '') for a in entry.get('attachments', [])]),
        'category': entry.get('category', ''),
        'description': entry.get('description', ''),
        'images': len(entry.get('images', []))
    }
    
    # Use separators to match JavaScript JSON.stringify (no spaces)
    str_repr = json.dumps(relevant, sort_keys=True, separators=(',', ':'))
    print(f"   Server hashing: {relevant}")
    print(f"   Server stringified: {str_repr}")
    
    # Simple hash function (matches frontend)
    hash_val = 0
    for char in str_repr:
        hash_val = ((hash_val << 5) - hash_val) + ord(char)
        hash_val = hash_val & 0xFFFFFFFF  # Convert to 32bit integer
    
    # Convert to signed 32-bit
    if hash_val > 0x7FFFFFFF:
        hash_val -= 0x100000000
    
    return str(hash_val)

@app.route('/api/sync', methods=['GET'])
def sync_get():
    """Get changes since last sync time (pull phase)"""
    if not USE_SERVER_BACKEND:
        return jsonify({"entries": [], "deleted": [], "serverTime": 0}), 400
    
    variant = _get_variant()
    since = int(request.args.get('since', 0))
    
    memos = get_memos_for_variant(variant)
    
    # Filter entries modified after 'since' timestamp
    modified = []
    for m in memos:
        updated_ts = iso_to_timestamp(m.get('updatedAt', ''))
        created_ts = iso_to_timestamp(m.get('createdAt', ''))
        # Include if updated after 'since' OR created after 'since'
        if updated_ts > since or created_ts > since:
            modified.append(m)
    
    # Get IDs of entries that were deleted after 'since'
    deleted_ids = []
    for m in memos:
        if m.get('deletedAt'):
            deleted_ts = iso_to_timestamp(m['deletedAt'])
            if deleted_ts > since:
                deleted_ids.append(m['id'])
    
    # Include hashbook for image deduplication
    hashbook = get_hashbook()
    
    return jsonify({
        'entries': modified,
        'deleted': deleted_ids,
        'hashbook': hashbook,
        'serverTime': int(datetime.utcnow().timestamp() * 1000)
    })

@app.route('/api/sync', methods=['POST'])
def sync_push():
    """Receive client changes and resolve conflicts (push phase)"""
    if not USE_SERVER_BACKEND:
        return jsonify({"success": False, "message": "Server backend is disabled."}), 400
    
    variant = _get_variant()
    payload = request.get_json(force=True, silent=True) or {}
    
    client_entries = payload.get('entries', [])
    client_deleted = payload.get('deleted', [])
    
    memos = get_memos_for_variant(variant)
    conflicts = []
    
    # Process updates/creates
    for client_entry in client_entries:
        entry_id = client_entry.get('id')
        if not entry_id:
            continue
        
        # Find existing server entry
        server_entry = None
        server_idx = -1
        for idx, m in enumerate(memos):
            if m.get('id') == entry_id:
                server_entry = m
                server_idx = idx
                break
        
        if server_entry:
            # Conflict detection: compare timestamps
            client_updated = iso_to_timestamp(client_entry.get('updatedAt', ''))
            server_updated = iso_to_timestamp(server_entry.get('updatedAt', ''))
            
            # Allow 5 second tolerance for clock skew
            time_diff = abs(server_updated - client_updated)
            
            if time_diff > 5000:  # More than 5 seconds apart
                if server_updated > client_updated:
                    # Server is newer - conflict!
                    conflicts.append({
                        'id': entry_id,
                        'clientVersion': client_entry,
                        'serverVersion': server_entry,
                        'resolution': 'server_wins'
                    })
                    continue  # Skip updating this entry
            
            # Merge client changes into server entry
            for key, value in client_entry.items():
                if key != 'id':  # Never change ID
                    server_entry[key] = value
            # Preserve client's updatedAt timestamp (don't regenerate)
            if 'updatedAt' not in client_entry:
                server_entry['updatedAt'] = datetime.utcnow().isoformat() + 'Z'
            memos[server_idx] = server_entry
        else:
            # New entry from client - preserve client timestamps
            if 'createdAt' not in client_entry:
                client_entry['createdAt'] = datetime.utcnow().isoformat() + 'Z'
            if 'updatedAt' not in client_entry:
                client_entry['updatedAt'] = datetime.utcnow().isoformat() + 'Z'
            memos.append(client_entry)
    
    # Process deletions
    for del_id in client_deleted:
        for entry in memos:
            if entry.get('id') == del_id and not entry.get('deletedAt'):
                entry['deletedAt'] = datetime.utcnow().isoformat() + 'Z'
                entry['deletedBy'] = 'client'
                entry['updatedAt'] = entry['deletedAt']
                # Set permanent delete time (30 days)
                from datetime import timedelta
                entry['permanentDeleteAt'] = (
                    datetime.utcnow() + timedelta(days=30)
                ).isoformat() + 'Z'
                break
    
    save_memos_for_variant(memos, variant)
    
    return jsonify({
        'success': True,
        'conflicts': conflicts,
        'serverTime': int(datetime.utcnow().timestamp() * 1000)
    })

# --- Memo API ---
@app.route('/api/memos', methods=['GET'])
def get_all_memos():
    """Returns all memos."""
    if USE_SERVER_BACKEND:
        variant = _get_variant()
        return jsonify(get_memos_for_variant(variant))
    return jsonify([])

@app.route('/api/memos', methods=['POST'])
def create_memo():
    """Creates a new memo."""
    if not USE_SERVER_BACKEND:
        return jsonify({"message": "Server backend is disabled."}), 400

    variant = _get_variant()
    new_memo = request.get_json(force=True, silent=True) or {}
    memos = get_memos_for_variant(variant)

    new_memo['id'] = new_memo.get('id') or str(uuid.uuid4())
    new_memo['createdAt'] = new_memo.get('createdAt') or datetime.utcnow().isoformat() + 'Z'
    new_memo.setdefault('updatedAt', new_memo['createdAt'])

    memos.append(new_memo)
    save_memos_for_variant(memos, variant)
    return jsonify(new_memo), 201

@app.route('/api/memos/<memo_id>', methods=['PUT'])
def update_memo(memo_id):
    """Updates an existing memo. Also deletes any locally-stored images removed from this memo."""
    if not USE_SERVER_BACKEND:
        return jsonify({"message": "Server backend is disabled."}), 400

    variant = _get_variant()
    updated_data = request.get_json(force=True, silent=True) or {}
    memos = get_memos_for_variant(variant)

    for i, memo in enumerate(memos):
        if str(memo.get('id')) == str(memo_id):

            old_images = set(memo.get('images') or [])
            # If client sends images list, compute which ones were removed
            if 'images' in updated_data and isinstance(updated_data['images'], list):
                new_images = set(updated_data['images'])
                removed = old_images - new_images
                # Only delete uploads that no other memo still references (across both variants)
                # Check same-file first
                for url in removed:
                    still_used_elsewhere = any(
                        url in (m.get('images') or [])
                        for m in memos
                        if str(m.get('id')) != str(memo_id)
                    )
                    if not still_used_elsewhere:
                        # Check the other file too
                        other_variant = 'default' if variant == 'finance' else 'finance'
                        other_memos = get_memos_for_variant(other_variant)
                        still_used_elsewhere = any(
                            url in (m.get('images') or [])
                            for m in other_memos
                        )
                    if not still_used_elsewhere:
                        delete_upload_url(url)

            memo.update(updated_data)
            memo['id'] = memo_id  # don't let client change id
            memo['updatedAt'] = datetime.utcnow().isoformat() + 'Z'
            memos[i] = memo
            save_memos_for_variant(memos, variant)
            return jsonify(memo)

    return jsonify({"message": "Memo not found"}), 404

@app.route('/api/memos/<memo_id>', methods=['DELETE'])
def delete_memo(memo_id):
    """Deletes a memo. Supports soft delete (default) or permanent delete (?permanent=true)."""
    if not USE_SERVER_BACKEND:
        return jsonify({"message": "Server backend is disabled."}), 400

    permanent = request.args.get('permanent', 'false').lower() == 'true'
    variant = _get_variant()
    memos = get_memos_for_variant(variant)
    memo_to_delete = None

    for m in memos:
        if str(m.get('id')) == str(memo_id):
            memo_to_delete = m
            break

    if not memo_to_delete:
        return jsonify({"message": "Memo not found"}), 404

    if permanent:
        # Permanent delete: remove files and entry
        if 'images' in memo_to_delete and memo_to_delete['images']:
            for image_url in memo_to_delete['images']:
                other_variant = 'default' if variant == 'finance' else 'finance'
                other_memos = get_memos_for_variant(other_variant)
                still_used_elsewhere = any(
                    image_url in (m.get('images') or [])
                    for m in other_memos
                )
                if not still_used_elsewhere:
                    delete_upload_url(image_url)
        
        new_memos = [m for m in memos if str(m.get('id')) != str(memo_id)]
        save_memos_for_variant(new_memos, variant)
        return jsonify({"message": "Memo permanently deleted"}), 200
    else:
        # Soft delete: mark as deleted
        from datetime import timedelta
        memo_to_delete['deletedAt'] = datetime.utcnow().isoformat() + 'Z'
        memo_to_delete['deletedBy'] = 'server'
        memo_to_delete['permanentDeleteAt'] = (
            datetime.utcnow() + timedelta(days=30)
        ).isoformat() + 'Z'
        memo_to_delete['updatedAt'] = datetime.utcnow().isoformat() + 'Z'
        
        save_memos_for_variant(memos, variant)
        return jsonify(memo_to_delete), 200

@app.route('/api/memos/<memo_id>/restore', methods=['POST'])
def restore_memo(memo_id):
    """Restores a soft-deleted memo from the recycle bin."""
    if not USE_SERVER_BACKEND:
        return jsonify({"message": "Server backend is disabled."}), 400
    
    variant = _get_variant()
    memos = get_memos_for_variant(variant)
    
    memo = None
    for m in memos:
        if str(m.get('id')) == str(memo_id):
            memo = m
            break
    
    if not memo:
        return jsonify({"message": "Memo not found"}), 404
    
    # Clear deletion markers
    memo['deletedAt'] = None
    memo['deletedBy'] = None
    memo['permanentDeleteAt'] = None
    memo['updatedAt'] = datetime.utcnow().isoformat() + 'Z'
    
    save_memos_for_variant(memos, variant)
    return jsonify(memo), 200


# --- Uploads ---
@app.route('/api/upload', methods=['POST'])
def upload_file():
    """
       Handles file uploads; stores in uploads/YYYY-MM-DD/ and returns that URL.
       Also does de-duplication (SHA-256).
       Stores/reuses under uploads/_blobs/sha256/<hash><ext>, returns that URL.
       Supports multipart/form-data (standard) and JSON base64 (Capacitor workaround).
    """

    if not USE_SERVER_BACKEND:
        return jsonify({"message": "Server backend is disabled."}), 400
    
    file = None
    
    # Check for JSON base64 upload (Capacitor workaround)
    if request.is_json:
        data = request.get_json(silent=True) or {}
        if 'file' in data and 'filename' in data:
            import base64
            from io import BytesIO
            from werkzeug.datastructures import FileStorage
            
            try:
                # Handle data URI scheme if present (e.g. "data:image/png;base64,....")
                b64_str = data['file']
                if ',' in b64_str:
                    b64_str = b64_str.split(',', 1)[1]
                    
                file_data = base64.b64decode(b64_str)
                filename = data['filename']
                # Create a FileStorage object to reuse existing logic
                file = FileStorage(
                    stream=BytesIO(file_data),
                    filename=filename,
                    content_type=data.get('type', 'application/octet-stream')
                )
            except Exception as e:
                print(f"❌ Upload error (base64): {e}")
                return jsonify({"message": f"Invalid base64 data: {str(e)}"}), 400
    
    # Check for standard multipart upload
    if file is None and 'file' in request.files:
        file = request.files['file']

    if not file or file.filename == '':
        return jsonify({"message": "No file part or selected file"}), 400
    
    is_duplicate, file_hash, rec = is_file_in_hashbook(file)
    if is_duplicate:
        book = get_hashbook()
        rec['count'] = int(rec.get('count', 0)) + 1
        book[file_hash] = rec
        save_hashbook(book)
        return jsonify({"url": rec["storedPath"], "duplicate": True, "hash": file_hash}), 200

    # Create a date-based subdirectory like '2025-08-25'
    date_folder = datetime.now().strftime('%Y-%m-%d')  # or datetime.utcnow()
    day_dir = os.path.join(app.config['UPLOAD_FOLDER'], date_folder)
    os.makedirs(day_dir, exist_ok=True)

    # Check if filename already has HHMM_ prefix (from sync uploads)
    # Pattern: starts with 4 digits followed by underscore
    secured_name = secure_filename(file.filename)
    import re
    if re.match(r'^\d{4}_', secured_name):
        # Already has time prefix, don't add another
        filename = secured_name
    else:
        # Add time prefix for new uploads
        time_prefix = datetime.now().strftime('%H%M_')
        filename = time_prefix + secured_name
    
    base, ext = os.path.splitext(filename)
    if not base:
        time_prefix = datetime.now().strftime('%H%M_')
        base = f"{time_prefix}upload"

    # Avoid overwriting existing files in the same day folder
    dest = os.path.join(day_dir, filename)
    counter = 1
    while os.path.exists(dest):
        filename = f"{base}_{counter}{ext}"
        dest = os.path.join(day_dir, filename)
        counter += 1

    file.save(dest)
    url = f"/uploads/{date_folder}/{filename}"
    hashed_entry = {"storedPath": url, "count": counter}
    book = get_hashbook()
    book[file_hash] = hashed_entry
    save_hashbook(book)
    
    # Return hash for client-side verification
    return jsonify({
        "url": url, 
        "duplicate": False, 
        "hash": file_hash,
        "size": os.path.getsize(dest)
    }), 201

@app.route('/uploads/<path:filename>')
def serve_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

# --- Frontend ---
@app.route('/')
def serve_index():
    return render_template('index.html')

@app.route('/index.html')
def serve_index_html():
    return render_template('index.html')

# Finance page route
@app.route('/finance')
def serve_finance():
    return render_template('finance.html')

@app.route('/finance.html')
def serve_finance_html():
    return render_template('finance.html')

def _pdf_page_size(size_name):
    key = (size_name or 'A4').strip().upper()
    try:
        pagesizes = importlib.import_module('reportlab.lib.pagesizes')
        A4 = getattr(pagesizes, 'A4')
        LETTER = getattr(pagesizes, 'LETTER')
        LEGAL = getattr(pagesizes, 'LEGAL')
        sizes = {
            'A4': A4,
            'LETTER': LETTER,
            'LEGAL': LEGAL,
        }
        return sizes.get(key, A4), key
    except Exception:
        return (595.275590551, 841.88976378), key

def _resolve_upload_abs_path(url):
    if not url:
        return None
    if isinstance(url, dict):
        url = url.get('url') or url.get('storedPath') or ''
    if not isinstance(url, str):
        return None
    candidate = url.strip()
    if candidate.startswith('http://') or candidate.startswith('https://'):
        try:
            parsed = urlparse(candidate)
            candidate = parsed.path or ''
        except Exception:
            return None
    if not candidate.startswith('/uploads/'):
        return None
    rel = os.path.normpath(candidate.lstrip('/'))
    return os.path.join(BASE_DIR, rel)

def _append_scaled_pdf_pages(writer, pdf_path, page_size, top_title=None):
    pypdf_module = importlib.import_module('pypdf')
    PdfReader = getattr(pypdf_module, 'PdfReader')

    src_pdf = PdfReader(pdf_path)
    target_w = float(page_size[0])
    target_h = float(page_size[1])
    margin = 28.0
    title_space = 18.0 if top_title else 0.0

    for idx, src_page in enumerate(src_pdf.pages, start=1):
        src_w = float(src_page.mediabox.width)
        src_h = float(src_page.mediabox.height)
        if src_w <= 0 or src_h <= 0:
            writer.add_page(src_page)
            continue

        scale_x = (target_w - margin * 2) / src_w
        scale_y = (target_h - margin * 2 - title_space) / src_h
        scale = min(scale_x, scale_y)
        draw_w = src_w * scale
        draw_h = src_h * scale
        tx = (target_w - draw_w) / 2
        ty = (target_h - draw_h) / 2
        if top_title:
            ty = min(ty, target_h - margin - title_space - draw_h)

        blank = writer.add_blank_page(width=target_w, height=target_h)
        blank.merge_transformed_page(src_page, (scale, 0, 0, scale, tx, ty))

def _entry_assets(entry):
    assets = []

    for idx, img in enumerate(entry.get('images') or [], start=1):
        url = img.get('url') if isinstance(img, dict) else img
        if isinstance(img, dict) and not url:
            url = img.get('storedPath')
        if not url:
            continue
        assets.append({
            'label': f"Image {idx}",
            'url': url,
        })

    for idx, att in enumerate(entry.get('attachments') or [], start=1):
        if not isinstance(att, dict):
            continue
        url = att.get('url') or att.get('storedPath')
        if not url:
            continue
        assets.append({
            'label': att.get('name') or f"Attachment {idx}",
            'url': url,
        })

    return assets

def _text_pdf_bytes(lines, page_size, title=None):
    canvas_module = importlib.import_module('reportlab.pdfgen.canvas')
    canvas = getattr(canvas_module, 'Canvas')

    out = io.BytesIO()
    c = canvas(out, pagesize=page_size)
    width, height = page_size
    margin_x = 42
    margin_top = height - 50
    margin_bottom = 42

    def draw_header():
        if title:
            c.setFont('Helvetica-Bold', 12)
            c.drawString(margin_x, height - 32, title)
            c.setLineWidth(0.5)
            c.line(margin_x, height - 36, width - margin_x, height - 36)

    draw_header()
    y = margin_top - (14 if title else 0)

    for raw_line in lines:
        line = '' if raw_line is None else str(raw_line)
        wrapped = textwrap.wrap(line, width=110) or ['']
        for part in wrapped:
            if y <= margin_bottom:
                c.showPage()
                draw_header()
                y = margin_top - (14 if title else 0)
            c.setFont('Helvetica', 10)
            c.drawString(margin_x, y, part)
            y -= 14

    c.save()
    out.seek(0)
    return out.getvalue()

def _image_pdf_bytes(image_path, page_size, title):
    canvas_module = importlib.import_module('reportlab.pdfgen.canvas')
    utils_module = importlib.import_module('reportlab.lib.utils')
    canvas = getattr(canvas_module, 'Canvas')
    ImageReader = getattr(utils_module, 'ImageReader')

    out = io.BytesIO()
    c = canvas(out, pagesize=page_size)
    width, height = page_size
    margin = 36

    c.setFont('Helvetica-Bold', 11)
    c.drawString(margin, height - 26, title)

    ir = ImageReader(image_path)
    iw, ih = ir.getSize()
    max_w = width - margin * 2
    max_h = height - margin * 2 - 24
    scale = min(max_w / float(iw), max_h / float(ih)) if iw and ih else 1
    draw_w = iw * scale
    draw_h = ih * scale
    x = (width - draw_w) / 2
    y = (height - draw_h) / 2 - 10
    c.drawImage(ir, x, y, width=draw_w, height=draw_h, preserveAspectRatio=True, mask='auto')
    c.save()
    out.seek(0)
    return out.getvalue()

def _variant_label(variant):
    return 'Finance' if str(variant).lower() == 'finance' else 'Memo'

def _finance_tax_amount(subtotal, tax_value):
    if tax_value is None or tax_value == '':
        return 0.0
    s = str(tax_value).strip()
    if not s:
        return 0.0
    if s.endswith('%'):
        try:
            perc = float(s[:-1])
            return subtotal * (perc / 100.0)
        except Exception:
            return 0.0
    try:
        return float(s)
    except Exception:
        return 0.0

def _finance_summary_values(entry):
    items = entry.get('items') or []
    if items:
        subtotal = 0.0
        for item in items:
            try:
                subtotal += float(item.get('totalPrice') or 0)
            except Exception:
                pass
    else:
        try:
            subtotal = float(entry.get('price') or 0) + float(entry.get('adjustment') or 0)
        except Exception:
            subtotal = 0.0

    tax = _finance_tax_amount(subtotal, entry.get('tax'))
    try:
        total = float(entry.get('total'))
    except Exception:
        total = subtotal + tax

    return subtotal, tax, total

def _fmt_currency(value):
    try:
        return f"${float(value):,.2f}"
    except Exception:
        return "$0.00"

def _build_reportlab_modules():
    styles_module = importlib.import_module('reportlab.lib.styles')
    units_module = importlib.import_module('reportlab.lib.units')
    colors_module = importlib.import_module('reportlab.lib.colors')
    plus_module = importlib.import_module('reportlab.platypus')

    return {
        'getSampleStyleSheet': getattr(styles_module, 'getSampleStyleSheet'),
        'ParagraphStyle': getattr(styles_module, 'ParagraphStyle'),
        'SimpleDocTemplate': getattr(plus_module, 'SimpleDocTemplate'),
        'Paragraph': getattr(plus_module, 'Paragraph'),
        'Spacer': getattr(plus_module, 'Spacer'),
        'Table': getattr(plus_module, 'Table'),
        'TableStyle': getattr(plus_module, 'TableStyle'),
        'inch': getattr(units_module, 'inch'),
        'colors': colors_module,
    }

def _entry_detail_pdf_bytes(entry, idx, total, variant, page_size, normalized_size):
    mods = _build_reportlab_modules()
    getSampleStyleSheet = mods['getSampleStyleSheet']
    ParagraphStyle = mods['ParagraphStyle']
    SimpleDocTemplate = mods['SimpleDocTemplate']
    Paragraph = mods['Paragraph']
    Spacer = mods['Spacer']
    Table = mods['Table']
    TableStyle = mods['TableStyle']
    inch = mods['inch']
    colors = mods['colors']

    out = io.BytesIO()
    doc = SimpleDocTemplate(
        out,
        pagesize=page_size,
        leftMargin=0.55 * inch,
        rightMargin=0.55 * inch,
        topMargin=0.6 * inch,
        bottomMargin=0.55 * inch,
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle('DocTitle', parent=styles['Title'], fontSize=16, leading=20, spaceAfter=10)
    section_style = ParagraphStyle('Section', parent=styles['Heading3'], fontSize=11, leading=14, spaceAfter=4)
    body_style = ParagraphStyle('Body', parent=styles['BodyText'], fontSize=9.6, leading=13)
    small_style = ParagraphStyle('Small', parent=styles['BodyText'], fontSize=8.8, leading=11)

    variant_label = _variant_label(variant)
    entry_id = str(entry.get('id') or f'entry-{idx}')
    desc = entry.get('description') or '(No description)'
    date_value = entry.get('purchaseDate') if str(variant).lower() == 'finance' else datetime.fromtimestamp((entry.get('ts') or 0) / 1000).strftime('%Y-%m-%d %H:%M:%S')
    tags = entry.get('tags') or []
    assets = _entry_assets(entry)

    story = []
    story.append(Paragraph(f"Detailed Log of {variant_label} in PDF ({normalized_size})", title_style))
    story.append(Paragraph(f"Entry {idx} of {total}", small_style))
    story.append(Spacer(1, 6))

    meta_rows = [
        ['Entry ID', entry_id],
        ['Category', str(entry.get('category') or 'Uncategorized')],
        ['Date', str(date_value or '')],
        ['Attachments', str(len(assets))],
    ]
    if str(variant).lower() == 'finance':
        subtotal_value, tax_value_calc, total_value_calc = _finance_summary_values(entry)
        meta_rows.extend([
            ['Subtotal', _fmt_currency(subtotal_value)],
            ['Tax', _fmt_currency(tax_value_calc)],
            ['Total', _fmt_currency(total_value_calc)],
        ])

    meta_table = Table(meta_rows, colWidths=[1.2 * inch, None], hAlign='LEFT')
    meta_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#EEF2F7')),
        ('TEXTCOLOR', (0, 0), (-1, -1), colors.HexColor('#1F2937')),
        ('GRID', (0, 0), (-1, -1), 0.35, colors.HexColor('#CBD5E1')),
        ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
        ('FONTNAME', (1, 0), (1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 0), (-1, -1), 9),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
    ]))
    if str(variant).lower() == 'finance':
        finance_money_labels = {'Subtotal', 'Tax', 'Total'}
        for row_idx, row in enumerate(meta_rows):
            if row and str(row[0]) in finance_money_labels:
                meta_table.setStyle(TableStyle([
                    ('ALIGN', (1, row_idx), (1, row_idx), 'RIGHT'),
                ]))
    story.append(meta_table)
    story.append(Spacer(1, 8))

    story.append(Paragraph('Description', section_style))
    story.append(Paragraph(str(desc).replace('\n', '<br/>'), body_style))
    story.append(Spacer(1, 8))

    story.append(Paragraph('Tags', section_style))
    story.append(Paragraph(', '.join(tags) if tags else '(none)', body_style))
    story.append(Spacer(1, 8))

    if str(variant).lower() == 'finance':
        story.append(Paragraph('Items', section_style))
        items = entry.get('items') or []
        if items:
            item_rows = [['#', 'Name', 'Qty', 'Unit', 'Total']]
            for row_idx, item in enumerate(items, start=1):
                item_rows.append([
                    str(row_idx),
                    str(item.get('name') or ''),
                    str(item.get('amount') if item.get('amount') is not None else ''),
                    _fmt_currency(item.get('unitPrice') if item.get('unitPrice') is not None else 0),
                    _fmt_currency(item.get('totalPrice') if item.get('totalPrice') is not None else 0),
                ])
            items_table = Table(item_rows, colWidths=[0.4 * inch, 2.9 * inch, 0.7 * inch, 0.9 * inch, 0.9 * inch], repeatRows=1)
            items_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#E2E8F0')),
                ('TEXTCOLOR', (0, 0), (-1, -1), colors.HexColor('#0F172A')),
                ('GRID', (0, 0), (-1, -1), 0.35, colors.HexColor('#CBD5E1')),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
                ('FONTSIZE', (0, 0), (-1, -1), 8.6),
                ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                ('ALIGN', (2, 1), (4, -1), 'RIGHT'),
                ('ALIGN', (2, 0), (4, 0), 'CENTER'),
                ('LEFTPADDING', (0, 0), (-1, -1), 5),
                ('RIGHTPADDING', (0, 0), (-1, -1), 5),
                ('TOPPADDING', (0, 0), (-1, -1), 3),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
            ]))
            story.append(items_table)
        else:
            story.append(Paragraph('(no itemized rows)', body_style))
        story.append(Spacer(1, 8))

    story.append(Paragraph('Attached Files (bookmarked in PDF outline)', section_style))
    if assets:
        file_rows = [['No.', 'Label', 'Source URL']]
        for asset_idx, asset in enumerate(assets, start=1):
            file_rows.append([str(asset_idx), str(asset['label']), str(asset['url'])])
        file_table = Table(file_rows, colWidths=[0.4 * inch, 1.9 * inch, None], repeatRows=1)
        file_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#E2E8F0')),
            ('TEXTCOLOR', (0, 0), (-1, -1), colors.HexColor('#0F172A')),
            ('GRID', (0, 0), (-1, -1), 0.35, colors.HexColor('#CBD5E1')),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
            ('FONTSIZE', (0, 0), (-1, -1), 8.2),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('RIGHTPADDING', (0, 0), (-1, -1), 5),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]))
        story.append(file_table)
    else:
        story.append(Paragraph('(no attached files)', body_style))

    doc.build(story)
    out.seek(0)
    return out.getvalue()

def _toc_pdf_bytes(entries, entry_page_start, page_offset, variant, page_size, normalized_size):
    canvas_module = importlib.import_module('reportlab.pdfgen.canvas')
    colors_module = importlib.import_module('reportlab.lib.colors')
    canvas = getattr(canvas_module, 'Canvas')
    colors = colors_module

    out = io.BytesIO()
    c = canvas(out, pagesize=page_size)
    width, height = page_size

    margin_x = 34
    margin_top = 38
    margin_bottom = 34
    table_w = width - (margin_x * 2)
    row_h = 16
    header_h = 16
    is_finance = str(variant).lower() == 'finance'
    if is_finance:
        # Keep sum <= table width to avoid overflow in last columns.
        # Columns: #, Date, Category, Description, Files, Subtotal, Tax, Total, Page
        col_ws = [16, 42, 50, 157, 18, 74, 64, 74, 32]
        row_h = 22
    else:
        col_ws = [24, 62, 78, 236, 34, 34]
    if sum(col_ws) < table_w:
        col_ws[-1] += table_w - sum(col_ws)
    elif sum(col_ws) > table_w:
        overflow = sum(col_ws) - table_w
        # Reduce description first if needed
        reducible = max(0, col_ws[3] - 120)
        cut = min(overflow, reducible)
        col_ws[3] -= cut
        overflow -= cut
        if overflow > 0:
            col_ws[-1] = max(20, col_ws[-1] - overflow)

    variant_label = _variant_label(variant)
    link_specs = []
    toc_page = 0
    finance_amount_cols = {5, 6, 7}

    def trim_text(txt, max_len):
        value = '' if txt is None else str(txt)
        return (value[:max_len] + '...') if len(value) > max_len else value

    def clamp_desc_two_lines(txt, width_chars=36):
        raw = '' if txt is None else str(txt)
        wrapped = textwrap.wrap(raw, width=width_chars) or ['']
        truncated = len(wrapped) > 2
        lines = wrapped[:2]
        if truncated:
            line2 = lines[1].rstrip()
            if len(line2) >= 3:
                line2 = line2[:-3].rstrip()
            lines[1] = (line2 + '...') if line2 else '...'
        return lines

    def draw_header(is_cont=False):
        nonlocal y_cursor
        c.setFont('Helvetica-Bold', 15)
        c.setFillColor(colors.HexColor('#0F172A'))
        c.drawString(margin_x, height - margin_top, f"Detailed Log of {variant_label} in PDF ({normalized_size})")
        c.setFont('Helvetica', 9)
        c.setFillColor(colors.HexColor('#334155'))
        subtitle = 'Summary Table / Table of Contents'
        if is_cont:
            subtitle += ' (continued)'
        c.drawString(margin_x, height - margin_top - 14, subtitle)

        y_cursor = height - margin_top - 30

        c.setFillColor(colors.HexColor('#CBD5E1'))
        c.rect(margin_x, y_cursor - header_h, table_w, header_h, fill=1, stroke=0)
        c.setFillColor(colors.HexColor('#0F172A'))
        c.setFont('Helvetica-Bold', 8.0 if is_finance else 8.4)
        headers = ['#', 'Date', 'Category', 'Description', 'Files', 'Page']
        if is_finance:
            headers = ['#', 'Date', 'Category', 'Description', 'Files', 'Subtotal', 'Tax', 'Total', 'Page']
        x = margin_x
        for i, text in enumerate(headers):
            if is_finance and i in finance_amount_cols:
                c.drawRightString(x + col_ws[i] - 3, y_cursor - 10, text)
            else:
                c.drawString(x + 3, y_cursor - 10, text)
            x += col_ws[i]

        c.setStrokeColor(colors.HexColor('#94A3B8'))
        c.setLineWidth(0.45)
        c.rect(margin_x, y_cursor - header_h, table_w, header_h, fill=0, stroke=1)
        y_cursor -= header_h

    y_cursor = 0
    draw_header(False)

    subtotal_sum = 0.0
    tax_sum = 0.0
    total_sum = 0.0

    for idx, entry in enumerate(entries, start=1):
        entry_id = str(entry.get('id') or f'entry-{idx}')
        if y_cursor - row_h < margin_bottom:
            c.showPage()
            toc_page += 1
            draw_header(True)

        desc = trim_text(entry.get('description') or '(No description)', 90)
        if is_finance:
            date_value = entry.get('purchaseDate') or ''
        else:
            date_value = datetime.fromtimestamp((entry.get('ts') or 0) / 1000).strftime('%Y-%m-%d')

        page_no = int(entry_page_start.get(entry_id, 0)) + int(page_offset) + 1
        if is_finance:
            subtotal, tax_value, total_value = _finance_summary_values(entry)
            subtotal_sum += subtotal
            tax_sum += tax_value
            total_sum += total_value
            values = [
                str(idx),
                trim_text(date_value, 12),
                trim_text(entry.get('category') or 'Uncategorized', 10),
                desc,
                str(len(_entry_assets(entry))),
                _fmt_currency(subtotal),
                _fmt_currency(tax_value),
                _fmt_currency(total_value),
                str(page_no),
            ]
        else:
            values = [
                str(idx),
                trim_text(date_value, 12),
                trim_text(entry.get('category') or 'Uncategorized', 16),
                desc,
                str(len(_entry_assets(entry))),
                str(page_no),
            ]

        if idx % 2 == 0:
            c.setFillColor(colors.HexColor('#F8FAFC'))
            c.rect(margin_x, y_cursor - row_h, table_w, row_h, fill=1, stroke=0)

        c.setFillColor(colors.HexColor('#0F172A'))
        c.setFont('Helvetica', 7.8 if is_finance else 8.1)
        x = margin_x
        for col_idx, value in enumerate(values):
            if is_finance and col_idx == 3:
                desc_lines = clamp_desc_two_lines(value, width_chars=36)
                c.setFont('Helvetica', 7.1)
                c.drawString(x + 3, y_cursor - 9, desc_lines[0])
                if len(desc_lines) > 1:
                    c.drawString(x + 3, y_cursor - 17, desc_lines[1])
                c.setFont('Helvetica', 7.8)
            elif is_finance and col_idx in finance_amount_cols:
                c.drawRightString(x + col_ws[col_idx] - 3, y_cursor - 13, value)
            else:
                c.drawString(x + 3, y_cursor - 13, value)
            x += col_ws[col_idx]

        c.setStrokeColor(colors.HexColor('#CBD5E1'))
        c.setLineWidth(0.35)
        c.rect(margin_x, y_cursor - row_h, table_w, row_h, fill=0, stroke=1)

        link_specs.append({
            'toc_page': toc_page,
            'entry_id': entry_id,
            'rect': (margin_x, y_cursor - row_h, margin_x + table_w, y_cursor),
        })

        y_cursor -= row_h

    if is_finance:
        if y_cursor - row_h < margin_bottom:
            c.showPage()
            toc_page += 1
            draw_header(True)

        c.setFillColor(colors.HexColor('#E2E8F0'))
        c.rect(margin_x, y_cursor - row_h, table_w, row_h, fill=1, stroke=0)
        c.setFillColor(colors.HexColor('#0F172A'))
        c.setFont('Helvetica-Bold', 7.9)

        totals_values = [
            '',
            '',
            '',
            'Totals',
            '',
            _fmt_currency(subtotal_sum),
            _fmt_currency(tax_sum),
            _fmt_currency(total_sum),
            '',
        ]

        x = margin_x
        for col_idx, value in enumerate(totals_values):
            if col_idx in finance_amount_cols:
                c.drawRightString(x + col_ws[col_idx] - 3, y_cursor - 13, value)
            else:
                c.drawString(x + 3, y_cursor - 13, value)
            x += col_ws[col_idx]

        c.setStrokeColor(colors.HexColor('#94A3B8'))
        c.setLineWidth(0.45)
        c.rect(margin_x, y_cursor - row_h, table_w, row_h, fill=0, stroke=1)
        y_cursor -= row_h

    c.save()
    out.seek(0)
    return out.getvalue(), link_specs

def _build_detailed_pdf(entries, variant, page_size_name):
    pypdf_module = importlib.import_module('pypdf')
    PdfReader = getattr(pypdf_module, 'PdfReader')
    PdfWriter = getattr(pypdf_module, 'PdfWriter')

    page_size, normalized_size = _pdf_page_size(page_size_name)
    writer = PdfWriter()

    entry_page_start = {}
    asset_bookmarks = []

    for idx, entry in enumerate(entries, start=1):
        entry_id = str(entry.get('id') or f'entry-{idx}')
        assets = _entry_assets(entry)

        summary_bytes = _entry_detail_pdf_bytes(entry, idx, len(entries), variant, page_size, normalized_size)
        summary_reader = PdfReader(io.BytesIO(summary_bytes))

        summary_start = len(writer.pages)
        entry_page_start[entry_id] = summary_start
        for page in summary_reader.pages:
            writer.add_page(page)

        for asset_idx, asset in enumerate(assets, start=1):
            asset_title = f"Entry {idx} - {asset['label']}"
            asset_url = asset['url']
            asset_path = _resolve_upload_abs_path(asset_url)
            asset_start = len(writer.pages)

            appended = False
            if asset_path and os.path.exists(asset_path):
                ext = os.path.splitext(asset_path)[1].lower()
                mime, _ = mimetypes.guess_type(asset_path)

                if ext == '.pdf' or mime == 'application/pdf':
                    try:
                        before = len(writer.pages)
                        _append_scaled_pdf_pages(writer, asset_path, page_size, top_title=asset_title)
                        appended = len(writer.pages) > before
                    except Exception:
                        appended = False
                elif ext in {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff'} or (mime and mime.startswith('image/')):
                    try:
                        image_bytes = _image_pdf_bytes(asset_path, page_size, asset_title)
                        image_reader = PdfReader(io.BytesIO(image_bytes))
                        for page in image_reader.pages:
                            writer.add_page(page)
                        appended = len(image_reader.pages) > 0
                    except Exception:
                        appended = False

            if not appended:
                placeholder_lines = [
                    asset_title,
                    f"Original URL: {asset_url}",
                    "This file type cannot be directly converted in server export.",
                    "A placeholder page is inserted instead.",
                ]
                placeholder_bytes = _text_pdf_bytes(placeholder_lines, page_size, title='Attachment Placeholder')
                placeholder_reader = PdfReader(io.BytesIO(placeholder_bytes))
                for page in placeholder_reader.pages:
                    writer.add_page(page)

            asset_bookmarks.append({
                'entry_id': entry_id,
                'title': f"{asset_idx}. {asset['label']}",
                'page': asset_start,
            })

    entry_parent = {}
    for i, entry in enumerate(entries, start=1):
        entry_id = str(entry.get('id') or f'entry-{i}')
        page_index = entry_page_start.get(entry_id, 0)
        desc = (entry.get('description') or '(No description)').strip()
        if len(desc) > 60:
            desc = desc[:60] + '…'
        entry_parent[entry_id] = writer.add_outline_item(
            f"Entry {i}: {desc}",
            page_number=page_index
        )

    for b in asset_bookmarks:
        parent = entry_parent.get(b['entry_id'])
        writer.add_outline_item(
            b['title'],
            page_number=b['page'],
            parent=parent
        )

    toc_guess = 1
    toc_bytes = b''
    toc_links = []
    toc_pages_count = 0
    for _ in range(5):
        toc_bytes, toc_links = _toc_pdf_bytes(entries, entry_page_start, toc_guess, variant, page_size, normalized_size)
        toc_reader = PdfReader(io.BytesIO(toc_bytes))
        toc_pages_count = len(toc_reader.pages)
        if toc_pages_count == toc_guess:
            break
        toc_guess = toc_pages_count

    final_writer = PdfWriter()
    if toc_bytes:
        toc_reader = PdfReader(io.BytesIO(toc_bytes))
        for page in toc_reader.pages:
            final_writer.add_page(page)
    for page in writer.pages:
        final_writer.add_page(page)

    final_entry_parent = {}
    for i, entry in enumerate(entries, start=1):
        entry_id = str(entry.get('id') or f'entry-{i}')
        page_index = entry_page_start.get(entry_id, 0) + toc_pages_count
        desc = (entry.get('description') or '(No description)').strip()
        if len(desc) > 60:
            desc = desc[:60] + '…'
        final_entry_parent[entry_id] = final_writer.add_outline_item(
            f"Entry {i}: {desc}",
            page_number=page_index
        )

    for b in asset_bookmarks:
        parent = final_entry_parent.get(b['entry_id'])
        final_writer.add_outline_item(
            b['title'],
            page_number=b['page'] + toc_pages_count,
            parent=parent
        )

    try:
        annotations_module = importlib.import_module('pypdf.annotations')
        Link = getattr(annotations_module, 'Link')
        for link_spec in toc_links:
            entry_id = link_spec['entry_id']
            if entry_id not in entry_page_start:
                continue
            target_page = entry_page_start[entry_id] + toc_pages_count
            link_obj = Link(rect=link_spec['rect'], target_page_index=target_page)
            final_writer.add_annotation(link_spec['toc_page'], link_obj)
    except Exception:
        pass

    out = io.BytesIO()
    final_writer.write(out)
    out.seek(0)
    return out.getvalue()

@app.route('/api/export/detailed-pdf', methods=['POST'])
def export_detailed_pdf():
    if not USE_SERVER_BACKEND:
        return jsonify({'message': 'Server backend is disabled.'}), 400

    payload = request.get_json(force=True, silent=True) or {}
    variant = _get_variant()
    page_size = payload.get('pageSize') or 'A4'
    entry_ids = payload.get('entryIds') or []

    if not isinstance(entry_ids, list):
        return jsonify({'message': 'entryIds must be an array.'}), 400

    all_memos = get_memos_for_variant(variant)
    active_entries = [m for m in all_memos if not m.get('deletedAt')]
    by_id = {str(m.get('id')): m for m in active_entries}

    selected = []
    if entry_ids:
        for raw_id in entry_ids:
            key = str(raw_id)
            if key in by_id:
                selected.append(by_id[key])
    else:
        selected = active_entries

    if not selected:
        return jsonify({'message': 'No entries selected for export.'}), 400

    try:
        importlib.import_module('reportlab')
        importlib.import_module('pypdf')
    except Exception:
        return jsonify({
            'message': 'Detailed PDF export dependencies are missing. Install: pip install reportlab pypdf pillow'
        }), 500

    try:
        pdf_bytes = _build_detailed_pdf(selected, variant, page_size)
    except Exception as exc:
        return jsonify({'message': f'Failed to build detailed PDF: {exc}'}), 500

    filename = f"{variant}_detailed_export_{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}.pdf"
    return send_file(
        io.BytesIO(pdf_bytes),
        mimetype='application/pdf',
        as_attachment=True,
        download_name=filename
    )

@app.route('/api/backup', methods=['GET'])
def download_backup():
    if not USE_SERVER_BACKEND:
        return jsonify({"message": "Server backend disabled"}), 400

    # Create in-memory zip
    mem_zip = io.BytesIO()
    
    with zipfile.ZipFile(mem_zip, mode='w', compression=zipfile.ZIP_DEFLATED) as zf:
        # 1. Add DATA_DIR files
        for root, dirs, files in os.walk(DATA_DIR):
            for file in files:
                # Keep structure: /data/filename.json
                abs_path = os.path.join(root, file)
                rel_path = os.path.relpath(abs_path, BASE_DIR)
                zf.write(abs_path, arcname=rel_path)
        
        # 2. Add UPLOAD_FOLDER files
        for root, dirs, files in os.walk(UPLOAD_FOLDER):
            for file in files:
                # Keep structure: /uploads/date/filename
                abs_path = os.path.join(root, file)
                rel_path = os.path.relpath(abs_path, BASE_DIR)
                zf.write(abs_path, arcname=rel_path)

    mem_zip.seek(0)
    filename = f"memo_backup_{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}.zip"
    return send_file(mem_zip, as_attachment=True, download_name=filename)

if __name__ == '__main__':
     # Run: USE_SERVER_BACKEND=true python app.py
     app.run(host='0.0.0.0', port=5050, debug=True)

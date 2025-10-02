import json
import os
import uuid
from flask import Flask, request, jsonify, render_template, send_from_directory
from werkzeug.utils import secure_filename
from datetime import datetime
from threading import Lock
import hashlib
import textwrap

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

_lock = Lock()

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
# --- Health / Config ---
@app.route('/api/config', methods=['GET'])
def api_config():
    """Tell the frontend whether server mode is on."""
    return jsonify({"server": USE_SERVER_BACKEND})

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
    """Deletes a memo and its associated files, and cleans up empty directories."""
    if not USE_SERVER_BACKEND:
        return jsonify({"message": "Server backend is disabled."}), 400

    variant = _get_variant()
    memos = get_memos_for_variant(variant)
    memo_to_delete = None

    for m in memos:
        if str(m.get('id')) == str(memo_id):
            memo_to_delete = m
            break

    if not memo_to_delete:
        return jsonify({"message": "Memo not found"}), 404

    if 'images' in memo_to_delete and memo_to_delete['images']:
        for image_url in memo_to_delete['images']:
            # Best-effort: ensure not referenced by other variant before deleting
            other_variant = 'default' if variant == 'finance' else 'finance'
            other_memos = get_memos_for_variant(other_variant)
            still_used_elsewhere = any(
                image_url in (m.get('images') or [])
                for m in other_memos
            )
            if not still_used_elsewhere:
                delete_upload_url(image_url)
            """
            relative_path = image_url[1:] 
            full_path = os.path.join(app.root_path, relative_path)
            try:
                if os.path.exists(full_path):
                    os.remove(full_path)
                    # Attempt to remove the directory and its parents if they become empty
                    dir_path = os.path.dirname(full_path)
                    try:
                        os.removedirs(dir_path)
                    except OSError as e:
                        # This exception is raised if the directory is not empty
                        # or if there's another issue (e.g., permissions).
                        print(f"Directory {dir_path} is not empty or could not be removed: {e}")
            except OSError as e:
                print(f"Error deleting file {full_path}: {e}")
            """

    # Default not do anything to file stored part
    new_memos = [m for m in memos if str(m.get('id')) != str(memo_id)]
    save_memos_for_variant(new_memos, variant)
    return jsonify({"message": "Memo and associated files deleted"}), 200


# --- Uploads ---
@app.route('/api/upload', methods=['POST'])
def upload_file():
    """
       Handles file uploads; stores in uploads/YYYY-MM-DD/ and returns that URL.
       Also does de-duplication (SHA-256).
       Stores/reuses under uploads/_blobs/sha256/<hash><ext>, returns that URL.
    """

    if not USE_SERVER_BACKEND:
        return jsonify({"message": "Server backend is disabled."}), 400
    if 'file' not in request.files:
        return jsonify({"message": "No file part"}), 400
    file = request.files['file']
    if not file or file.filename == '':
        return jsonify({"message": "No selected file"}), 400
    
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

    time_prefix = datetime.now().strftime('%H%M_')

    filename = time_prefix + secure_filename(file.filename)
    base, ext = os.path.splitext(filename)
    if not base:
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
    return jsonify({"url": url, "duplicate": False, "hash": file_hash}), 201

@app.route('/uploads/<path:filename>')
def serve_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

# --- Frontend ---
@app.route('/')
def serve_index():
    return render_template('index.html')

# Finance page route
@app.route('/finance')
def serve_finance():
    return render_template('finance.html')

@app.route('/finance.html')
def serve_finance_html():
    return render_template('finance.html')

if __name__ == '__main__':
     # Run: USE_SERVER_BACKEND=true python app.py
     app.run(host='0.0.0.0', port=5050, debug=True)

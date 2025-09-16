import json
import os
import uuid
from flask import Flask, request, jsonify, render_template, send_from_directory
from werkzeug.utils import secure_filename
from datetime import datetime
from threading import Lock

# --- Configuration ---
USE_SERVER_BACKEND = os.environ.get("USE_SERVER_BACKEND", "true").lower() == "true"
BASE_DIR = os.path.abspath(os.path.dirname(__file__))
UPLOAD_FOLDER = os.path.join(BASE_DIR, 'uploads')
DATA_DIR = os.path.join(BASE_DIR, 'data')
DATA_FILE = os.path.join(DATA_DIR, 'memos.json')

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

# Helper function to read memos
def get_memos():
    with _lock:
        return _read_json(DATA_FILE)

# Helper function to write memos
def save_memos(memos):
    with _lock:
        _write_json(DATA_FILE, memos)

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
        return jsonify(get_memos())
    return jsonify([])

@app.route('/api/memos', methods=['POST'])
def create_memo():
    """Creates a new memo."""
    if not USE_SERVER_BACKEND:
        return jsonify({"message": "Server backend is disabled."}), 400

    new_memo = request.get_json(force=True, silent=True) or {}
    memos = get_memos()

    new_memo['id'] = new_memo.get('id') or str(uuid.uuid4())
    new_memo['createdAt'] = new_memo.get('createdAt') or datetime.utcnow().isoformat() + 'Z'
    new_memo.setdefault('updatedAt', new_memo['createdAt'])

    memos.append(new_memo)
    save_memos(memos)
    return jsonify(new_memo), 201

@app.route('/api/memos/<memo_id>', methods=['PUT'])
def update_memo(memo_id):
    """Updates an existing memo."""
    if not USE_SERVER_BACKEND:
        return jsonify({"message": "Server backend is disabled."}), 400

    updated_data = request.get_json(force=True, silent=True) or {}
    memos = get_memos()

    for i, memo in enumerate(memos):
        if str(memo.get('id')) == str(memo_id):
            memo.update(updated_data)
            memo['id'] = memo_id  # don't let client change id
            memo['updatedAt'] = datetime.utcnow().isoformat() + 'Z'
            memos[i] = memo
            save_memos(memos)
            return jsonify(memo)

    return jsonify({"message": "Memo not found"}), 404

@app.route('/api/memos/<memo_id>', methods=['DELETE'])
def delete_memo(memo_id):
    """Deletes a memo and its associated files, and cleans up empty directories."""
    if not USE_SERVER_BACKEND:
        return jsonify({"message": "Server backend is disabled."}), 400

    memos = get_memos()
    memo_to_delete = None

    for m in memos:
        if str(m.get('id')) == str(memo_id):
            memo_to_delete = m
            break

    if not memo_to_delete:
        return jsonify({"message": "Memo not found"}), 404

    if 'images' in memo_to_delete and memo_to_delete['images']:
        for image_url in memo_to_delete['images']:
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

    # Default not do anything to file stored part
    new_memos = [m for m in memos if str(m.get('id')) != str(memo_id)]
    save_memos(new_memos)
    return jsonify({"message": "Memo and associated files deleted"}), 200


# --- Uploads ---
@app.route('/api/upload', methods=['POST'])
def upload_file():
    """Handles file uploads; stores in uploads/YYYY-MM-DD/ and returns that URL."""
    if not USE_SERVER_BACKEND:
        return jsonify({"message": "Server backend is disabled."}), 400
    if 'file' not in request.files:
        return jsonify({"message": "No file part"}), 400
    file = request.files['file']
    if not file or file.filename == '':
        return jsonify({"message": "No selected file"}), 400

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
    return jsonify({"url": f"/uploads/{date_folder}/{filename}"}), 201

@app.route('/uploads/<path:filename>')
def serve_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

# --- Frontend ---
@app.route('/')
def serve_index():
    return render_template('index.html')

if __name__ == '__main__':
    # Run: USE_SERVER_BACKEND=true python app.py
    app.run(host='0.0.0.0', port=5050, debug=True)

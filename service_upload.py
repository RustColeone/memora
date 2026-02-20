import base64
import hashlib
import json
import os
import re
from datetime import datetime
from io import BytesIO

from werkzeug.datastructures import FileStorage
from werkzeug.utils import secure_filename


class ServiceUpload:
    def __init__(self, hashbook_file: str, upload_folder: str, base_dir: str, lock, read_json=None, write_json=None):
        self.hashbook_file = hashbook_file
        self.upload_folder = upload_folder
        self.base_dir = base_dir
        self.lock = lock
        self._read_json = read_json
        self._write_json = write_json

    def read_key_json(self, path):
        if callable(self._read_json):
            obj = self._read_json(path, {})
            return obj if isinstance(obj, dict) else {}
        try:
            with open(path, 'r', encoding='utf-8') as file_obj:
                obj = json.load(file_obj)
                return obj if isinstance(obj, dict) else {}
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def write_key_json(self, path, obj):
        if callable(self._write_json):
            self._write_json(path, obj, 1)
            return
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as file_obj:
            json.dump(obj, file_obj, ensure_ascii=False, indent=2)
        os.replace(tmp, path)

    def get_hashbook(self):
        with self.lock:
            return self.read_key_json(self.hashbook_file)

    def save_hashbook(self, book):
        with self.lock:
            self.write_key_json(self.hashbook_file, book)

    def compute_filestorage_sha256(self, file_storage, chunk_size=1024 * 1024):
        hash_value = hashlib.sha256()
        stream = file_storage.stream
        try:
            pos = stream.tell()
        except Exception:
            pos = None

        try:
            stream.seek(0)
        except Exception:
            pass

        while True:
            chunk = stream.read(chunk_size)
            if not chunk:
                break
            hash_value.update(chunk)

        try:
            stream.seek(0 if pos is None else pos)
        except Exception:
            pass

        return hash_value.hexdigest()

    def compute_file_sha256_from_path(self, path, chunk_size=1024 * 1024):
        hash_value = hashlib.sha256()
        with open(path, 'rb') as file_obj:
            while True:
                chunk = file_obj.read(chunk_size)
                if not chunk:
                    break
                hash_value.update(chunk)
        return hash_value.hexdigest()

    def is_file_in_hashbook(self, file_storage):
        file_hash = self.compute_filestorage_sha256(file_storage)
        book = self.get_hashbook()
        rec = book.get(file_hash)

        if rec and isinstance(rec, dict):
            existing_url = rec.get('storedPath')
            if existing_url:
                rel = os.path.normpath(existing_url.lstrip('/'))
                full_path = os.path.join(self.base_dir, rel)
                if os.path.isfile(full_path):
                    return True, file_hash, rec
            book.pop(file_hash, None)
            self.save_hashbook(book)

        return False, file_hash, None

    def delete_upload_url(self, image_url: str):
        if not image_url or not image_url.startswith('/uploads/'):
            return

        rel = os.path.normpath(image_url.lstrip('/'))
        full_path = os.path.join(self.base_dir, rel)

        if not os.path.exists(full_path):
            book = self.get_hashbook()
            dirty = False
            for hash_key, rec in list(book.items()):
                if isinstance(rec, dict) and rec.get('storedPath') == image_url:
                    del book[hash_key]
                    dirty = True
            if dirty:
                self.save_hashbook(book)
            return

        try:
            file_hash = self.compute_file_sha256_from_path(full_path)
        except Exception:
            file_hash = None

        book = self.get_hashbook()

        if file_hash and file_hash in book and isinstance(book[file_hash], dict):
            rec = book[file_hash]
            rec['count'] = max(0, int(rec.get('count', 0)) - 1)
            if rec['count'] == 0:
                try:
                    os.remove(full_path)
                except OSError:
                    pass
                book.pop(file_hash, None)
                self.save_hashbook(book)
                try:
                    os.removedirs(os.path.dirname(full_path))
                except OSError:
                    pass
            else:
                book[file_hash] = rec
                self.save_hashbook(book)
        else:
            try:
                os.remove(full_path)
            except OSError:
                pass
            dirty = False
            for hash_key, rec in list(book.items()):
                if isinstance(rec, dict) and rec.get('storedPath') == image_url:
                    del book[hash_key]
                    dirty = True
            if dirty:
                self.save_hashbook(book)
            try:
                os.removedirs(os.path.dirname(full_path))
            except OSError:
                pass

    def handle_upload_request(self, req, use_server_backend: bool):
        if not use_server_backend:
            return {'message': 'Server backend is disabled.'}, 400

        file_obj = None

        if req.is_json:
            data = req.get_json(silent=True) or {}
            if 'file' in data and 'filename' in data:
                try:
                    b64_str = data['file']
                    if ',' in b64_str:
                        b64_str = b64_str.split(',', 1)[1]
                    file_data = base64.b64decode(b64_str)
                    filename = data['filename']
                    file_obj = FileStorage(
                        stream=BytesIO(file_data),
                        filename=filename,
                        content_type=data.get('type', 'application/octet-stream')
                    )
                except Exception as exc:
                    return {'message': f'Invalid base64 data: {str(exc)}'}, 400

        if file_obj is None and 'file' in req.files:
            file_obj = req.files['file']

        if not file_obj or file_obj.filename == '':
            return {'message': 'No file part or selected file'}, 400

        is_duplicate, file_hash, rec = self.is_file_in_hashbook(file_obj)
        if is_duplicate:
            book = self.get_hashbook()
            rec['count'] = int(rec.get('count', 0)) + 1
            book[file_hash] = rec
            self.save_hashbook(book)
            return {'url': rec['storedPath'], 'duplicate': True, 'hash': file_hash}, 200

        date_folder = datetime.now().strftime('%Y-%m-%d')
        day_dir = os.path.join(self.upload_folder, date_folder)
        os.makedirs(day_dir, exist_ok=True)

        secured_name = secure_filename(file_obj.filename)
        if re.match(r'^\d{4}_', secured_name):
            filename = secured_name
        else:
            filename = datetime.now().strftime('%H%M_') + secured_name

        base, ext = os.path.splitext(filename)
        if not base:
            base = datetime.now().strftime('%H%M_') + 'upload'

        dest = os.path.join(day_dir, filename)
        counter = 1
        while os.path.exists(dest):
            filename = f'{base}_{counter}{ext}'
            dest = os.path.join(day_dir, filename)
            counter += 1

        file_obj.save(dest)
        url = f'/uploads/{date_folder}/{filename}'
        hashed_entry = {'storedPath': url, 'count': 1}
        book = self.get_hashbook()
        book[file_hash] = hashed_entry
        self.save_hashbook(book)

        return {
            'url': url,
            'duplicate': False,
            'hash': file_hash,
            'size': os.path.getsize(dest)
        }, 201

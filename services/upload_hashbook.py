import hashlib
import json
import os


class UploadHashbookStore:
    def __init__(self, hashbook_file: str, base_dir: str, lock, read_json=None, write_json=None):
        self.hashbook_file = hashbook_file
        self.base_dir = base_dir
        self.lock = lock
        self._read_json = read_json
        self._write_json = write_json

    def _read_hashbook(self):
        if callable(self._read_json):
            obj = self._read_json(self.hashbook_file, {})
            return obj if isinstance(obj, dict) else {}

        try:
            with open(self.hashbook_file, 'r', encoding='utf-8') as file_obj:
                obj = json.load(file_obj)
                return obj if isinstance(obj, dict) else {}
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def _write_hashbook(self, book):
        if callable(self._write_json):
            self._write_json(self.hashbook_file, book, 1)
            return

        tmp = self.hashbook_file + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as file_obj:
            json.dump(book, file_obj, ensure_ascii=False, indent=2)
        os.replace(tmp, self.hashbook_file)

    def get_hashbook(self):
        with self.lock:
            return self._read_hashbook()

    def save_hashbook(self, book):
        with self.lock:
            self._write_hashbook(book)

    @staticmethod
    def compute_filestorage_sha256(file_storage, chunk_size=1024 * 1024):
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

    @staticmethod
    def compute_file_sha256_from_path(path, chunk_size=1024 * 1024):
        hash_value = hashlib.sha256()
        with open(path, 'rb') as file_obj:
            while True:
                chunk = file_obj.read(chunk_size)
                if not chunk:
                    break
                hash_value.update(chunk)
        return hash_value.hexdigest()

    def get_duplicate_record(self, file_storage):
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

    def increment_count(self, file_hash, rec):
        book = self.get_hashbook()
        rec['count'] = int(rec.get('count', 0)) + 1
        book[file_hash] = rec
        self.save_hashbook(book)

    def save_new_record(self, file_hash, stored_path):
        book = self.get_hashbook()
        book[file_hash] = {'storedPath': stored_path, 'count': 1}
        self.save_hashbook(book)

    def remove_records_by_path(self, image_url: str):
        book = self.get_hashbook()
        dirty = False
        for hash_key, rec in list(book.items()):
            if isinstance(rec, dict) and rec.get('storedPath') == image_url:
                del book[hash_key]
                dirty = True
        if dirty:
            self.save_hashbook(book)

    def decrement_or_remove_by_hash(self, file_hash, full_path):
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
                return True

            book[file_hash] = rec
            self.save_hashbook(book)
            return False

        return None

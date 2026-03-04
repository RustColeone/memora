import os
import re
from datetime import datetime

from werkzeug.utils import secure_filename

from services.upload_hashbook import UploadHashbookStore
from services.upload_request import parse_upload_file_from_request


class UploadService:
    def __init__(self, hashbook_file: str, upload_folder: str, base_dir: str, lock, read_json=None, write_json=None):
        self.upload_folder = upload_folder
        self.base_dir = base_dir
        self.hashbook = UploadHashbookStore(
            hashbook_file=hashbook_file,
            base_dir=base_dir,
            lock=lock,
            read_json=read_json,
            write_json=write_json,
        )

    @staticmethod
    def _build_filename(raw_filename: str):
        secured_name = secure_filename(raw_filename)
        if re.match(r'^\d{4}_', secured_name):
            filename = secured_name
        else:
            filename = datetime.now().strftime('%H%M_') + secured_name

        base, ext = os.path.splitext(filename)
        if not base:
            base = datetime.now().strftime('%H%M_') + 'upload'

        return filename, base, ext

    def _allocate_destination(self, filename, base, ext):
        date_folder = datetime.now().strftime('%Y-%m-%d')
        day_dir = os.path.join(self.upload_folder, date_folder)
        os.makedirs(day_dir, exist_ok=True)

        dest = os.path.join(day_dir, filename)
        counter = 1
        while os.path.exists(dest):
            filename = f'{base}_{counter}{ext}'
            dest = os.path.join(day_dir, filename)
            counter += 1

        return date_folder, filename, dest

    def _save_new_upload(self, file_obj, file_hash):
        filename, base, ext = self._build_filename(file_obj.filename)
        date_folder, filename, dest = self._allocate_destination(filename, base, ext)

        file_obj.save(dest)
        url = f'/uploads/{date_folder}/{filename}'
        self.hashbook.save_new_record(file_hash, url)

        return {
            'url': url,
            'duplicate': False,
            'hash': file_hash,
            'size': os.path.getsize(dest),
        }, 201

    def delete_upload_url(self, image_url: str):
        if not image_url or not image_url.startswith('/uploads/'):
            return

        rel = os.path.normpath(image_url.lstrip('/'))
        full_path = os.path.join(self.base_dir, rel)

        if not os.path.exists(full_path):
            self.hashbook.remove_records_by_path(image_url)
            return

        try:
            file_hash = self.hashbook.compute_file_sha256_from_path(full_path)
        except Exception:
            file_hash = None

        deletion_result = self.hashbook.decrement_or_remove_by_hash(file_hash, full_path)
        if deletion_result is None:
            try:
                os.remove(full_path)
            except OSError:
                pass
            self.hashbook.remove_records_by_path(image_url)

        try:
            os.removedirs(os.path.dirname(full_path))
        except OSError:
            pass

    def handle_upload_request(self, req, use_server_backend: bool):
        if not use_server_backend:
            return {'message': 'Server backend is disabled.'}, 400

        file_obj, parse_error = parse_upload_file_from_request(req)
        if parse_error:
            return {'message': parse_error}, 400

        is_duplicate, file_hash, rec = self.hashbook.get_duplicate_record(file_obj)
        if is_duplicate:
            self.hashbook.increment_count(file_hash, rec)
            return {'url': rec['storedPath'], 'duplicate': True, 'hash': file_hash}, 200

        return self._save_new_upload(file_obj, file_hash)

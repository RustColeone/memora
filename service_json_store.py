import copy
import hashlib
import json
import os
import shutil
from contextlib import contextmanager
from datetime import datetime


class ServiceJsonStore:
    def __init__(self, backup_root: str, max_backups_per_file: int = 10):
        self.backup_root = backup_root
        self.max_backups_per_file = max(1, int(max_backups_per_file))
        os.makedirs(self.backup_root, exist_ok=True)

    @staticmethod
    def _checksum(content_bytes: bytes) -> str:
        return hashlib.sha256(content_bytes).hexdigest()

    @staticmethod
    def _meta_path(path: str) -> str:
        return f"{path}.meta"

    @staticmethod
    def _lock_path(path: str) -> str:
        return f"{path}.lock"

    def _backup_dir_for_file(self, path: str) -> str:
        file_name = os.path.basename(path)
        safe_name = file_name.replace(':', '_')
        return os.path.join(self.backup_root, safe_name)

    @contextmanager
    def _file_lock(self, path: str):
        lock_path = self._lock_path(path)
        os.makedirs(os.path.dirname(lock_path), exist_ok=True)
        lock_file = open(lock_path, 'a+b')
        try:
            lock_file.seek(0)
            if lock_file.read(1) == b'':
                lock_file.seek(0)
                lock_file.write(b'0')
                lock_file.flush()
                os.fsync(lock_file.fileno())
            lock_file.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            yield
        finally:
            try:
                if os.name == 'nt':
                    import msvcrt
                    lock_file.seek(0)
                    msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            finally:
                lock_file.close()

    def _write_meta(self, path: str, checksum: str, schema_version: int):
        meta = {
            'format': 'memo-json-meta-v1',
            'schemaVersion': int(schema_version),
            'checksum': checksum,
            'updatedAt': datetime.utcnow().isoformat() + 'Z',
        }
        meta_path = self._meta_path(path)
        tmp_meta = f"{meta_path}.tmp"
        with open(tmp_meta, 'w', encoding='utf-8') as file_obj:
            json.dump(meta, file_obj, ensure_ascii=False, indent=2)
            file_obj.flush()
            os.fsync(file_obj.fileno())
        os.replace(tmp_meta, meta_path)

    def _write_json_locked(self, path: str, obj, schema_version: int):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self._rotate_backup(path)

        payload = json.dumps(obj, ensure_ascii=False, indent=2).encode('utf-8')
        checksum = self._checksum(payload)

        tmp_path = f'{path}.tmp'
        with open(tmp_path, 'wb') as file_obj:
            file_obj.write(payload)
            file_obj.flush()
            os.fsync(file_obj.fileno())
        os.replace(tmp_path, path)
        self._write_meta(path, checksum=checksum, schema_version=schema_version)

    def _read_meta(self, path: str):
        try:
            with open(self._meta_path(path), 'r', encoding='utf-8') as file_obj:
                meta = json.load(file_obj)
                return meta if isinstance(meta, dict) else None
        except Exception:
            return None

    def _rotate_backup(self, path: str):
        if not os.path.exists(path):
            return

        backup_dir = self._backup_dir_for_file(path)
        os.makedirs(backup_dir, exist_ok=True)

        timestamp = datetime.utcnow().strftime('%Y%m%dT%H%M%S%f')
        backup_json = os.path.join(backup_dir, f'{timestamp}.json')
        shutil.copy2(path, backup_json)

        meta_path = self._meta_path(path)
        if os.path.exists(meta_path):
            shutil.copy2(meta_path, f'{backup_json}.meta')

        candidates = sorted(
            [
                os.path.join(backup_dir, name)
                for name in os.listdir(backup_dir)
                if name.endswith('.json')
            ],
            reverse=True,
        )
        for old_path in candidates[self.max_backups_per_file:]:
            try:
                os.remove(old_path)
            except OSError:
                pass
            old_meta = f'{old_path}.meta'
            if os.path.exists(old_meta):
                try:
                    os.remove(old_meta)
                except OSError:
                    pass

    def _validate_content(self, content_bytes: bytes, meta: dict | None) -> bool:
        if not meta:
            return True
        expected = str(meta.get('checksum') or '').strip()
        if not expected:
            return True
        return expected == self._checksum(content_bytes)

    def _restore_from_backups(self, path: str):
        backup_dir = self._backup_dir_for_file(path)
        if not os.path.isdir(backup_dir):
            return False

        candidates = sorted(
            [
                os.path.join(backup_dir, name)
                for name in os.listdir(backup_dir)
                if name.endswith('.json')
            ],
            reverse=True,
        )

        for candidate in candidates:
            try:
                with open(candidate, 'rb') as file_obj:
                    backup_bytes = file_obj.read()
                json.loads(backup_bytes.decode('utf-8'))
            except Exception:
                continue

            backup_meta = None
            backup_meta_path = f'{candidate}.meta'
            if os.path.exists(backup_meta_path):
                try:
                    with open(backup_meta_path, 'r', encoding='utf-8') as meta_file:
                        backup_meta = json.load(meta_file)
                except Exception:
                    backup_meta = None

            if not self._validate_content(backup_bytes, backup_meta):
                continue

            try:
                tmp_path = f'{path}.restore.tmp'
                with open(tmp_path, 'wb') as file_obj:
                    file_obj.write(backup_bytes)
                    file_obj.flush()
                    os.fsync(file_obj.fileno())
                os.replace(tmp_path, path)

                if backup_meta:
                    meta_path = self._meta_path(path)
                    tmp_meta = f'{meta_path}.tmp'
                    with open(tmp_meta, 'w', encoding='utf-8') as meta_file:
                        json.dump(backup_meta, meta_file, ensure_ascii=False, indent=2)
                        meta_file.flush()
                        os.fsync(meta_file.fileno())
                    os.replace(tmp_meta, meta_path)
                print(f"⚠️ Restored corrupted JSON from backup: {path}")
                return True
            except Exception:
                continue

        return False

    def read_json(self, path: str, default):
        with self._file_lock(path):
            if not os.path.exists(path):
                return copy.deepcopy(default)

            try:
                with open(path, 'rb') as file_obj:
                    content = file_obj.read()
                meta = self._read_meta(path)
                if not self._validate_content(content, meta):
                    raise ValueError('Checksum mismatch')
                loaded = json.loads(content.decode('utf-8'))
                if not meta or not str(meta.get('checksum') or '').strip():
                    self._write_meta(path, checksum=self._checksum(content), schema_version=1)
                return loaded
            except Exception as exc:
                print(f"⚠️ JSON integrity/read failure detected at {path}: {exc}")
                repaired = self._restore_from_backups(path)
                if repaired:
                    try:
                        with open(path, 'rb') as file_obj:
                            repaired_content = file_obj.read()
                        repaired_obj = json.loads(repaired_content.decode('utf-8'))
                        return repaired_obj
                    except Exception:
                        pass
                print(f"⚠️ Falling back to default JSON object for: {path}")
                return copy.deepcopy(default)

    def write_json(self, path: str, obj, schema_version: int = 1):
        with self._file_lock(path):
            self._write_json_locked(path, obj, schema_version=schema_version)

    def ensure_file(self, path: str, default, schema_version: int = 1):
        with self._file_lock(path):
            if not os.path.exists(path):
                value = copy.deepcopy(default)
                self._write_json_locked(path, value, schema_version=schema_version)
                return value

            try:
                with open(path, 'rb') as file_obj:
                    content = file_obj.read()
                meta = self._read_meta(path)
                if not self._validate_content(content, meta):
                    raise ValueError('Checksum mismatch')
                loaded = json.loads(content.decode('utf-8'))
                return loaded
            except Exception as exc:
                print(f"⚠️ Startup JSON validation failed at {path}: {exc}")
                repaired = self._restore_from_backups(path)
                if repaired:
                    try:
                        with open(path, 'rb') as file_obj:
                            repaired_content = file_obj.read()
                        return json.loads(repaired_content.decode('utf-8'))
                    except Exception:
                        pass

                value = copy.deepcopy(default)
                print(f"⚠️ Reinitializing JSON file with default content: {path}")
                self._write_json_locked(path, value, schema_version=schema_version)
                return value

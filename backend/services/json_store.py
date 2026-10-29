import copy
import json
import os
import shutil
from contextlib import contextmanager
from datetime import datetime


class JsonStoreService:
    def __init__(self, backup_root: str, max_backups_per_file: int = 10):
        self.backup_root = backup_root
        self.max_backups_per_file = max(1, int(max_backups_per_file))
        os.makedirs(self.backup_root, exist_ok=True)

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

    def _write_json_locked(self, path: str, obj, schema_version: int = 1):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self._rotate_backup(path)

        payload = json.dumps(obj, ensure_ascii=False, indent=2).encode('utf-8')

        tmp_path = f'{path}.tmp'
        with open(tmp_path, 'wb') as file_obj:
            file_obj.write(payload)
            file_obj.flush()
            os.fsync(file_obj.fileno())
        os.replace(tmp_path, path)

    def _rotate_backup(self, path: str):
        if not os.path.exists(path):
            return

        backup_dir = self._backup_dir_for_file(path)
        os.makedirs(backup_dir, exist_ok=True)

        timestamp = datetime.utcnow().strftime('%Y%m%dT%H%M%S%f')
        backup_json = os.path.join(backup_dir, f'{timestamp}.json')
        shutil.copy2(path, backup_json)

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

            try:
                tmp_path = f'{path}.restore.tmp'
                with open(tmp_path, 'wb') as file_obj:
                    file_obj.write(backup_bytes)
                    file_obj.flush()
                    os.fsync(file_obj.fileno())
                os.replace(tmp_path, path)
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
                loaded = json.loads(content.decode('utf-8'))
                return loaded
            except Exception as exc:
                print(f"⚠️ JSON read failure detected at {path}: {exc}")
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
                loaded = json.loads(content.decode('utf-8'))
                return loaded
            except Exception as exc:
                print(f"⚠️ Startup JSON read failed at {path}: {exc}")
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

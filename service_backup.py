import io
import os
import zipfile
from datetime import datetime


class ServiceBackup:
    def handle_download_backup(self, base_dir, data_dir, upload_folder):
        mem_zip = io.BytesIO()

        with zipfile.ZipFile(mem_zip, mode='w', compression=zipfile.ZIP_DEFLATED) as zf:
            for root, _, files in os.walk(data_dir):
                for file_name in files:
                    abs_path = os.path.join(root, file_name)
                    rel_path = os.path.relpath(abs_path, base_dir)
                    zf.write(abs_path, arcname=rel_path)

            for root, _, files in os.walk(upload_folder):
                for file_name in files:
                    abs_path = os.path.join(root, file_name)
                    rel_path = os.path.relpath(abs_path, base_dir)
                    zf.write(abs_path, arcname=rel_path)

        mem_zip.seek(0)
        filename = f"memo_backup_{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}.zip"
        return mem_zip, filename

import base64
from io import BytesIO

from werkzeug.datastructures import FileStorage


def parse_upload_file_from_request(req):
    file_obj = None

    if req.is_json:
        data = req.get_json(silent=True) or {}
        if 'file' in data and 'filename' in data:
            try:
                b64_str = data['file']
                if ',' in b64_str:
                    b64_str = b64_str.split(',', 1)[1]
                file_data = base64.b64decode(b64_str)
                file_obj = FileStorage(
                    stream=BytesIO(file_data),
                    filename=data['filename'],
                    content_type=data.get('type', 'application/octet-stream'),
                )
            except Exception as exc:
                return None, f'Invalid base64 data: {exc}'

    if file_obj is None and 'file' in req.files:
        file_obj = req.files['file']

    if not file_obj or file_obj.filename == '':
        return None, 'No file part or selected file'

    return file_obj, None

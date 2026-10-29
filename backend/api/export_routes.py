import io
import json
import os
import tempfile
import zipfile
from contextlib import nullcontext

from flask import Blueprint, jsonify, request, send_file

from services.db_converter import (
    export_to_bundle,
    import_from_bundle,
    import_from_zips,
)
from services.backup import BackupService
from services.restore import sync_floors, reseat_restored_records, restore_raw_database


def create_export_blueprint(ctx):
    blueprint = Blueprint('export_api', __name__)

    @blueprint.route('/api/export/detailed-pdf', methods=['POST'])
    def export_detailed_pdf():
        if not ctx.use_server_backend:
            return jsonify({'message': 'Server backend is disabled.'}), 400

        payload = request.get_json(force=True, silent=True) or {}
        variant = ctx.resolve_variant(request)
        result, status = ctx.export_service.handle_detailed_pdf_export(
            payload,
            variant,
            ctx.base_dir,
            ctx.get_memos_for_variant,
        )
        if status != 200:
            return jsonify(result), status

        return send_file(
            io.BytesIO(result['pdfBytes']),
            mimetype=result['mimetype'],
            as_attachment=True,
            download_name=result['filename'],
        )

    @blueprint.route('/api/db/export', methods=['GET'])
    def db_export():
        """Export database in a portable format.
        Query param: format=zip (recommended) | json | db
          zip  — readable JSON envelope + upload blobs (shared with the offline app)
          json — JSON bundle only (no blobs)
          db   — raw SQLite file (full hot backup)
        """
        fmt = request.args.get('format', 'zip')
        db = ctx.db

        if fmt == 'zip':
            archive = BackupService().handle_portable_backup(db, ctx.upload_folder, getattr(ctx, 'lock', None))
            return send_file(
                archive,
                mimetype='application/zip',
                as_attachment=True,
                download_name='memosystem_backup.zip',
            )

        if fmt == 'json':
            bundle = export_to_bundle(db)
            buf = io.BytesIO(
                json.dumps(bundle, ensure_ascii=False, indent=2).encode('utf-8')
            )
            return send_file(
                buf,
                mimetype='application/json',
                as_attachment=True,
                download_name='memosystem_backup.json',
            )

        # format=db — hot backup via sqlite3.backup() (WAL-safe)
        import sqlite3 as _sqlite3
        db_path = ctx.db_path
        buf = io.BytesIO()
        tmp_fd, tmp_path = tempfile.mkstemp(suffix='.db')
        try:
            os.close(tmp_fd)
            src = _sqlite3.connect(db_path)
            dst = _sqlite3.connect(tmp_path)
            src.backup(dst)
            dst.close()
            src.close()
            with open(tmp_path, 'rb') as f:
                buf.write(f.read())
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        buf.seek(0)
        return send_file(
            buf,
            mimetype='application/octet-stream',
            as_attachment=True,
            download_name='memosystem.db',
        )

    @blueprint.route('/api/db/import', methods=['POST'])
    def db_import():
        """Import from a ZIP bundle, JSON bundle, or a raw .db file.
        Multipart form fields:
          file   — the uploaded file (.zip, .json or .db)
          mode   — 'merge' (default) | 'replace'
          format — inferred from the filename, or 'zip' | 'json' | 'db'
        """
        request.max_content_length = 128 * 1024 * 1024
        if 'file' not in request.files:
            return jsonify({'error': 'No file provided'}), 400

        uploaded = request.files['file']
        mode = request.form.get('mode', 'merge')
        if mode not in ('merge', 'replace'):
            mode = 'merge'

        # Infer format from the filename when not explicitly given.
        name = (uploaded.filename or '').lower()
        fmt = request.form.get('format') or (
            'zip' if name.endswith('.zip') else 'db' if name.endswith('.db') else 'json'
        )
        db = ctx.db

        lock = getattr(ctx, 'lock', None)
        try:
            with lock if lock is not None else nullcontext():
                floors = sync_floors(db)
                if fmt == 'zip':
                    counts = import_from_zips(db, [item.read() for item in request.files.getlist('file')],
                        ctx.upload_folder, mode, after_import=lambda: reseat_restored_records(db, floors))
                    return jsonify({'success': True, 'format': fmt, 'mode': mode, 'imported': counts})
                if fmt == 'db':
                    if mode != 'replace':
                        return jsonify({'error': 'Raw database restore replaces the whole database. Choose Replace explicitly.'}), 400
                    with tempfile.TemporaryDirectory() as folder:
                        staged = os.path.join(folder, 'restore.db')
                        uploaded.save(staged)
                        restore_raw_database(db, staged)
                    return jsonify({'success': True, 'format': fmt, 'mode': mode})
                if fmt != 'json':
                    return jsonify({'error': 'Unsupported backup format'}), 400
                if len(request.files.getlist('file')) != 1:
                    return jsonify({'error': 'Select one JSON database backup'}), 400
                content = uploaded.read(16 * 1024 * 1024 + 1)
                if len(content) > 16 * 1024 * 1024:
                    raise ValueError('Backup metadata is too large')
                bundle = json.loads(content.decode('utf-8'))
                with db.conn():
                    counts = import_from_bundle(db, bundle, mode)
                    reseat_restored_records(db, floors)
                return jsonify({'success': True, 'format': fmt, 'mode': mode, 'imported': counts})
        except (ValueError, UnicodeError, zipfile.BadZipFile) as error:
            return jsonify({'error': str(error)}), 400

    return blueprint

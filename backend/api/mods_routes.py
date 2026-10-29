"""Mods for pages opened from this server: folders in <base-dir>/mods.

GET /api/mods lists them (behind the sync password, like the rest of /api);
/mods/<folder>/<file> serves their files with the same check as /uploads.
Which mods run is decided in each browser (Settings → Mods, memo-mods.js).
"""
import json
import os

from flask import Blueprint, jsonify, send_from_directory

from .upload_routes import files_authorized

MANIFEST_LIMIT = 65536


def mods_dir(ctx) -> str:
    return os.path.join(ctx.base_dir, 'mods')


def list_mods(ctx) -> list:
    root = mods_dir(ctx)
    out = []
    if not os.path.isdir(root):
        return out
    for folder in sorted(os.listdir(root)):
        path = os.path.join(root, folder)
        if folder.startswith('.') or not os.path.isdir(path):
            continue
        manifest, error = None, ''
        file = os.path.join(path, 'mod.json')
        try:
            if os.path.getsize(file) > MANIFEST_LIMIT:
                raise ValueError('mod.json is larger than 64 KB')
            with open(file, encoding='utf-8') as f:
                manifest = json.load(f)
        except FileNotFoundError:
            error = 'no mod.json in this folder'
        except (OSError, ValueError) as e:
            error = 'mod.json: %s' % e
        out.append({'folder': folder, 'manifest': manifest, 'error': error})
    return out


def create_mods_blueprint(ctx):
    blueprint = Blueprint('mods_api', __name__)

    @blueprint.route('/api/mods', methods=['GET'])
    def mods_list():
        return jsonify({'dir': mods_dir(ctx), 'mods': list_mods(ctx)})

    @blueprint.route('/mods/<folder>/<path:filename>')
    def mods_file(folder, filename):
        if not files_authorized(ctx):
            return jsonify({'error': 'auth_required'}), 401
        if folder.startswith('.') or '..' in filename.split('/'):
            return jsonify({'error': 'not_found'}), 404
        # send_from_directory refuses paths that leave the folder.
        return send_from_directory(os.path.join(mods_dir(ctx), folder), filename)

    return blueprint

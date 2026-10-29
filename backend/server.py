import json
import mimetypes
import os

from flask import Flask, jsonify, request

# .mjs must be served as JavaScript or the browser rejects the ES module (pdf.js).
# Windows' registry often maps .mjs to nothing / octet-stream, so pin it here.
mimetypes.add_type('text/javascript', '.mjs')

from api import (
    create_agent_blueprint,
    create_backup_blueprint,
    create_chat_blueprint,
    create_config_blueprint,
    create_export_blueprint,
    create_frontend_blueprint,
    create_memo_blueprint,
    create_ocr_blueprint,
    create_operations_blueprint,
    create_upload_blueprint,
)
from backend_context import BackendContext
from services.attempt_limit import AttemptLimiter
from services.sync_auth import SyncAuth


USE_SERVER_BACKEND = os.environ.get('USE_SERVER_BACKEND', 'true').lower() == 'true'
# This package lives in backend/; the repo root (one level up) is the base for
# user data (data/, uploads/), package.json, and the frontend source (src/).
# A packaged server (memora_server.py) keeps user data in MEMO_BASE_DIR and the
# pages it ships in MEMO_APP_DIR (where src/ and package.json are bundled).
APP_DIR = os.path.abspath(os.environ.get('MEMO_APP_DIR') or os.path.join(os.path.dirname(__file__), '..'))
BASE_DIR = os.path.abspath(os.environ.get('MEMO_BASE_DIR') or APP_DIR)
SRC_DIR = os.path.join(APP_DIR, 'src')


def _read_app_version():
    """App version from the single source of truth (package.json)."""
    try:
        with open(os.path.join(APP_DIR, 'package.json'), encoding='utf-8') as f:
            return json.load(f).get('version', '0.0.0')
    except Exception:
        return '0.0.0'


def create_app():
    context = BackendContext(base_dir=BASE_DIR, use_server_backend=USE_SERVER_BACKEND)
    context.src_dir = SRC_DIR
    sync_auth = SyncAuth(context.data_dir)
    context.sync_auth = sync_auth
    context.attempts = AttemptLimiter()   # wrong passwords / agent tokens, per address

    # Frontend source lives in src/ (pages at its root, assets under src/static);
    # keep the served prefix /static so URLs match the Capacitor www/ build.
    app = Flask(__name__,
                static_folder=os.path.join(SRC_DIR, 'static'),
                static_url_path='/static',
                template_folder=SRC_DIR)
    app.config['UPLOAD_FOLDER'] = context.upload_folder
    app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024

    # Fill {{ APP_VERSION }} in templates (the build stamps the same placeholder
    # into www/ for the Capacitor build).
    app_version = _read_app_version()

    @app.context_processor
    def inject_app_version():
        return {'APP_VERSION': app_version}

    @app.after_request
    def add_cors_headers(response):
        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = '*'
        return response

    @app.before_request
    def handle_preflight():
        print(f'📨 {request.method} {request.path} from {request.remote_addr}')
        if request.method == 'OPTIONS':
            return jsonify({'status': 'OK'})

    @app.before_request
    def require_sync_auth():
        # Optional shared-password gate. Only guards the API; /api/config stays
        # open so a client can discover that a password is required. OPTIONS is
        # already short-circuited above (preflight carries no auth header).
        if not sync_auth.required:
            return None
        path = request.path or ''
        # The Agent API checks its own per-agent tokens (api/agent_routes.py).
        if not path.startswith('/api/') or path == '/api/config' or path.startswith('/api/agent/v1/'):
            return None
        wait = context.attempts.retry_after(request.remote_addr)
        if wait:
            resp = jsonify({'error': 'too_many_attempts', 'message': 'Too many wrong passwords. Try again in %d seconds.' % wait})
            resp.headers['Retry-After'] = str(wait)
            return resp, 429
        provided = request.headers.get('X-Sync-Password', '')
        if not sync_auth.check(provided):
            if provided:   # a wrong password; a client with none set is not guessing
                context.attempts.fail(request.remote_addr)
            return jsonify({'error': 'auth_required',
                            'message': 'A sync password is required for this server.'}), 401
        return None

    app.register_blueprint(create_config_blueprint(context))
    app.register_blueprint(create_chat_blueprint(context))
    app.register_blueprint(create_operations_blueprint(context))
    app.register_blueprint(create_memo_blueprint(context))
    app.register_blueprint(create_upload_blueprint(context, app))
    app.register_blueprint(create_ocr_blueprint(context, app))
    app.register_blueprint(create_export_blueprint(context))
    app.register_blueprint(create_backup_blueprint(context))
    app.register_blueprint(create_agent_blueprint(context))
    app.register_blueprint(create_frontend_blueprint(context))

    app.memora_context = context   # memora_server.py's token commands use it
    return app


app = create_app()


if __name__ == '__main__':
    port = int(os.environ.get('MEMO_PORT', '5050'))
    debug = os.environ.get('MEMO_DEBUG', 'false').lower() == 'true'
    # use_reloader=False keeps a single process so callers can manage it cleanly.
    app.run(host=os.environ.get('MEMO_HOST', '0.0.0.0'), port=port, debug=debug, use_reloader=False)

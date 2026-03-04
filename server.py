import os

from flask import Flask, jsonify, request

from api import (
    create_backup_blueprint,
    create_chat_blueprint,
    create_config_blueprint,
    create_export_blueprint,
    create_frontend_blueprint,
    create_memo_blueprint,
    create_operations_blueprint,
    create_upload_blueprint,
)
from backend_context import BackendContext


USE_SERVER_BACKEND = os.environ.get('USE_SERVER_BACKEND', 'true').lower() == 'true'
BASE_DIR = os.path.abspath(os.path.dirname(__file__))


def create_app():
    context = BackendContext(base_dir=BASE_DIR, use_server_backend=USE_SERVER_BACKEND)

    app = Flask(__name__, static_folder='static', template_folder='templates')
    app.config['UPLOAD_FOLDER'] = context.upload_folder
    app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024

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

    app.register_blueprint(create_config_blueprint(context))
    app.register_blueprint(create_chat_blueprint(context))
    app.register_blueprint(create_operations_blueprint(context))
    app.register_blueprint(create_memo_blueprint(context))
    app.register_blueprint(create_upload_blueprint(context, app))
    app.register_blueprint(create_export_blueprint(context))
    app.register_blueprint(create_backup_blueprint(context))
    app.register_blueprint(create_frontend_blueprint(context))

    return app


app = create_app()


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5050, debug=True)

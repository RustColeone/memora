from flask import Blueprint, jsonify, request, send_from_directory


def create_upload_blueprint(ctx, app):
    blueprint = Blueprint('upload_api', __name__)

    @blueprint.route('/api/upload', methods=['POST'])
    def upload_file():
        result, status = ctx.upload_service.handle_upload_request(request, ctx.use_server_backend)
        return jsonify(result), status

    @blueprint.route('/uploads/<path:filename>')
    def serve_file(filename):
        return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

    return blueprint

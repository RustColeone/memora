from flask import Blueprint, jsonify


def create_config_blueprint(ctx):
    blueprint = Blueprint('config_api', __name__)

    @blueprint.route('/api/config', methods=['GET'])
    def api_config():
        return jsonify({'server': ctx.use_server_backend})

    return blueprint

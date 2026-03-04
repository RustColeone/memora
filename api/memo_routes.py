from flask import Blueprint, jsonify, request


def create_memo_blueprint(ctx):
    blueprint = Blueprint('memo_api', __name__)

    @blueprint.route('/api/memos', methods=['GET'])
    def get_all_memos():
        if not ctx.use_server_backend:
            return jsonify([])
        variant = ctx.resolve_variant(request)
        result, status = ctx.memos_service.handle_get_all_memos(variant, ctx.get_memos_for_variant)
        return jsonify(result), status

    @blueprint.route('/api/memos', methods=['POST'])
    def create_memo():
        if not ctx.use_server_backend:
            return jsonify({'message': 'Server backend is disabled.'}), 400

        variant = ctx.resolve_variant(request)
        payload = request.get_json(force=True, silent=True) or {}
        result, status = ctx.memos_service.handle_create_memo(
            payload,
            variant,
            ctx.get_memos_for_variant,
            ctx.save_memos_for_variant,
        )
        return jsonify(result), status

    @blueprint.route('/api/memos/<memo_id>', methods=['PUT'])
    def update_memo(memo_id):
        if not ctx.use_server_backend:
            return jsonify({'message': 'Server backend is disabled.'}), 400

        variant = ctx.resolve_variant(request)
        updated_data = request.get_json(force=True, silent=True) or {}
        result, status = ctx.memos_service.handle_update_memo(
            memo_id,
            updated_data,
            variant,
            ctx.get_memos_for_variant,
            ctx.save_memos_for_variant,
            ctx.upload_service.delete_upload_url,
        )
        return jsonify(result), status

    @blueprint.route('/api/memos/<memo_id>', methods=['DELETE'])
    def delete_memo(memo_id):
        if not ctx.use_server_backend:
            return jsonify({'message': 'Server backend is disabled.'}), 400

        permanent = request.args.get('permanent', 'false').lower() == 'true'
        variant = ctx.resolve_variant(request)
        result, status = ctx.memos_service.handle_delete_memo(
            memo_id,
            permanent,
            variant,
            ctx.get_memos_for_variant,
            ctx.save_memos_for_variant,
            ctx.upload_service.delete_upload_url,
        )
        return jsonify(result), status

    @blueprint.route('/api/memos/<memo_id>/restore', methods=['POST'])
    def restore_memo(memo_id):
        if not ctx.use_server_backend:
            return jsonify({'message': 'Server backend is disabled.'}), 400

        variant = ctx.resolve_variant(request)
        result, status = ctx.memos_service.handle_restore_memo(
            memo_id,
            variant,
            ctx.get_memos_for_variant,
            ctx.save_memos_for_variant,
        )
        return jsonify(result), status

    return blueprint

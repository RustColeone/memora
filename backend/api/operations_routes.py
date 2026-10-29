from flask import Blueprint, jsonify, request


def create_operations_blueprint(ctx):
    blueprint = Blueprint('operations_api', __name__)

    @blueprint.route('/api/operations/push', methods=['POST'])
    def push_operations():
        if not ctx.use_server_backend:
            return jsonify({'success': False, 'message': 'Server backend disabled'}), 400

        variant = ctx.resolve_variant(request)
        payload = request.get_json(force=True, silent=True) or {}
        result, status = ctx.operations_service.handle_push_operations(
            payload,
            variant,
            ctx.apply_operation_to_memos,
        )
        return jsonify(result), status

    @blueprint.route('/api/operations/pull', methods=['GET'])
    def pull_operations():
        if not ctx.use_server_backend:
            return jsonify({'needsFullSync': False, 'operations': []}), 400

        variant = ctx.resolve_variant(request)
        since_op_id = int(request.args.get('sinceOpId', 0))
        limit = request.args.get('limit', type=int)
        snapshot_offset = request.args.get('snapshotOffset', 0, type=int)
        snapshot_id = request.args.get('snapshotId', type=int)
        result, status = ctx.operations_service.handle_pull_operations(
            since_op_id, variant, limit=limit, snapshot_offset=snapshot_offset, snapshot_id=snapshot_id)
        return jsonify(result), status

    @blueprint.route('/api/operations/compact', methods=['POST'])
    def compact_operations():
        if not ctx.use_server_backend:
            return jsonify({'success': False}), 400

        variant = ctx.resolve_variant(request)
        payload = request.get_json(silent=True) or {}
        result, status = ctx.operations_service.handle_compact_operations(payload, variant)
        return jsonify(result), status

    return blueprint

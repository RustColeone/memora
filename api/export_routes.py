import io

from flask import Blueprint, jsonify, request, send_file


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

    return blueprint

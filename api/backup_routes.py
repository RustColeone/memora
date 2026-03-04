from flask import Blueprint, jsonify, send_file


def create_backup_blueprint(ctx):
    blueprint = Blueprint('backup_api', __name__)

    @blueprint.route('/api/backup', methods=['GET'])
    def download_backup():
        if not ctx.use_server_backend:
            return jsonify({'message': 'Server backend disabled'}), 400

        mem_zip, filename = ctx.backup_service.handle_download_backup(
            ctx.base_dir,
            ctx.data_dir,
            ctx.upload_folder,
        )
        return send_file(mem_zip, as_attachment=True, download_name=filename)

    return blueprint

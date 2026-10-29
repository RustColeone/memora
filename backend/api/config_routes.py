import os
import re
import secrets

from flask import Blueprint, jsonify, request

from services import ai_step


def server_id(ctx) -> str:
    """This server's permanent id, kept in its data folder (made once)."""
    cached = getattr(ctx, '_server_id', None)
    if cached:
        return cached
    path = os.path.join(ctx.data_dir, 'server_id')
    try:
        with open(path, encoding='utf-8') as f:
            value = f.read().strip()
    except OSError:
        value = ''
    if not re.fullmatch(r'[0-9a-f]{32}', value):
        value = secrets.token_hex(16)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(value)
    ctx._server_id = value
    return value


def create_config_blueprint(ctx):
    blueprint = Blueprint('config_api', __name__)

    @blueprint.route('/api/config', methods=['GET'])
    def api_config():
        auth_required = bool(getattr(ctx, 'sync_auth', None) and ctx.sync_auth.required)
        # collections: what the operation log accepts. Clients sync newer
        # collections (the Vault) only with a server that lists them; an older
        # server would read an unknown collection as the default notes.
        # ai: whether AI contacts can use this server's own AI (no keys sent).
        # serverId: permanent, so an app can find this server again after its
        # address changes; ?challenge=<hex> adds a proof that needs the password.
        body = {'server': ctx.use_server_backend, 'authRequired': auth_required,
                'collections': list(ctx.VARIANTS),
                'ai': ai_step.describe(ctx) if ctx.use_server_backend else {'available': False},
                'serverId': server_id(ctx)}
        challenge = request.args.get('challenge', '')
        if auth_required and re.fullmatch(r'[0-9a-f]{16,64}', challenge):
            body['proof'] = ctx.sync_auth.prove(challenge, body['serverId'])
        return jsonify(body)

    return blueprint

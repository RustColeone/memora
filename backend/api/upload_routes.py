from flask import Blueprint, jsonify, make_response, request, send_from_directory

from services.thumbnails import get_or_create_thumbnail

UPLOAD_COOKIE = 'memo_upload_token'


def files_authorized(ctx):
    # /uploads and /mods are not under /api, so the global gate doesn't cover them. <img>
    # tags can't send the auth header, so accept any of: the header (fetch /
    # Capacitor), a signed cookie, or a ?t= token (set up by the client once
    # it has the password). Open when no password is configured.
    auth = getattr(ctx, 'sync_auth', None)
    if not (auth and auth.required):
        return True
    limiter = getattr(ctx, 'attempts', None)
    if limiter and limiter.retry_after(request.remote_addr):
        return False
    provided = request.headers.get('X-Sync-Password', '')
    if auth.check(provided):
        return True
    if provided and limiter:   # a wrong password counts toward the same limit as /api
        limiter.fail(request.remote_addr)
    token = request.cookies.get(UPLOAD_COOKIE) or request.args.get('t') or ''
    return auth.verify_upload_token(token)


def create_upload_blueprint(ctx, app):
    blueprint = Blueprint('upload_api', __name__)

    def _uploads_authorized():
        return files_authorized(ctx)

    @blueprint.route('/api/uploads/session', methods=['GET', 'POST'])
    def uploads_session():
        # Reached only after the global gate validated the header (it's /api/*),
        # so the caller is authenticated — hand back a short-lived image cookie.
        auth = getattr(ctx, 'sync_auth', None)
        if not (auth and auth.required):
            return jsonify({'authRequired': False})
        resp = make_response(jsonify({'ok': True}))
        resp.set_cookie(UPLOAD_COOKIE, auth.make_upload_token(),
                        max_age=86400, samesite='Lax', secure=request.is_secure, path='/')
        return resp

    @blueprint.route('/api/upload', methods=['POST'])
    def upload_file():
        result, status = ctx.upload_service.handle_upload_request(request, ctx.use_server_backend)
        return jsonify(result), status

    @blueprint.route('/uploads/<path:filename>')
    def serve_file(filename):
        if not _uploads_authorized():
            return jsonify({'error': 'auth_required'}), 401
        # Card feeds request a downscaled thumbnail via ?w=<width>; full-res is
        # served for the lightbox/detail. Falls back to the original on miss.
        width = request.args.get('w')
        if width:
            thumb = get_or_create_thumbnail(app.config['UPLOAD_FOLDER'], filename, width)
            if thumb:
                directory, rel = thumb
                return send_from_directory(directory, rel)
        return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

    return blueprint

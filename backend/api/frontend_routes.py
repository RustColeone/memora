import json
import os

from flask import Blueprint, Response, render_template, send_from_directory


def create_frontend_blueprint(ctx):
    blueprint = Blueprint('frontend_pages', __name__)
    src_dir = getattr(ctx, 'src_dir', None) or os.path.join(ctx.base_dir, 'src')

    def _precache_list():
        # App-shell URLs the SW precaches on install: pages + every js/css/icon +
        # boot-critical sql-wasm (mirrors build_tools/build.js swPrecacheList).
        urls = ['/index.html', '/finance.html', '/planner.html', '/manifest.webmanifest']
        for sub in ('js', 'css', 'icons'):
            base = os.path.join(src_dir, 'static', sub)
            for root, _dirs, files in os.walk(base):
                for f in files:
                    rel = os.path.relpath(os.path.join(root, f), src_dir).replace(os.sep, '/')
                    urls.append('/' + rel)
        for v in ('sql-wasm.js', 'sql-wasm.wasm'):
            if os.path.exists(os.path.join(src_dir, 'static', 'vendor', v)):
                urls.append('/static/vendor/' + v)
        return urls

    def _sw_version():
        # Version the SW cache by the newest frontend-source mtime, so editing a
        # JS/CSS file invalidates the cache (fresh on reload) while an unchanged
        # tree keeps serving cache-first (fast). The static www/ build stamps its
        # own build id instead (build_tools/build.js).
        latest = 0.0
        for sub in ('static/js', 'static/css', 'static/icons'):
            for root, _dirs, files in os.walk(os.path.join(src_dir, sub)):
                for f in files:
                    try:
                        latest = max(latest, os.path.getmtime(os.path.join(root, f)))
                    except OSError:
                        pass
        try:
            latest = max(latest, os.path.getmtime(os.path.join(src_dir, 'sw.js')))
        except OSError:
            pass
        return str(int(latest))

    @blueprint.route('/sw.js')
    def service_worker():
        with open(os.path.join(src_dir, 'sw.js'), encoding='utf-8') as f:
            body = f.read()
        body = body.replace('{{BUILD_VERSION}}', _sw_version())
        body = body.replace('{{PRECACHE_LIST}}', ','.join(json.dumps(u) for u in _precache_list()))
        resp = Response(body, mimetype='text/javascript')
        resp.headers['Cache-Control'] = 'no-cache'
        resp.headers['Service-Worker-Allowed'] = '/'
        return resp

    @blueprint.route('/manifest.webmanifest')
    def web_manifest():
        return send_from_directory(src_dir, 'manifest.webmanifest', mimetype='application/manifest+json')

    @blueprint.route('/')
    def serve_index():
        return render_template(ctx.frontend_service.index_template())

    @blueprint.route('/index.html')
    def serve_index_html():
        return render_template(ctx.frontend_service.index_template())

    @blueprint.route('/finance')
    def serve_finance():
        return render_template(ctx.frontend_service.finance_template())

    @blueprint.route('/finance.html')
    def serve_finance_html():
        return render_template(ctx.frontend_service.finance_template())

    @blueprint.route('/planner')
    def serve_planner():
        return render_template(ctx.frontend_service.planner_template())

    @blueprint.route('/planner.html')
    def serve_planner_html():
        return render_template(ctx.frontend_service.planner_template())

    return blueprint

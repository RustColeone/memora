from flask import Blueprint, render_template


def create_frontend_blueprint(ctx):
    blueprint = Blueprint('frontend_pages', __name__)

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

    return blueprint

from flask import Blueprint, jsonify, request

from services.chat import handle_chat_create_entry, handle_chat_send


def create_chat_blueprint(ctx):
    blueprint = Blueprint('chat_api', __name__)

    @blueprint.route('/api/chat', methods=['GET'])
    def chat_list():
        if not ctx.use_server_backend:
            return jsonify([])
        variant = ctx.resolve_variant(request)
        return jsonify(ctx.get_chat_for_variant(variant))

    @blueprint.route('/api/chat', methods=['POST'])
    def chat_send():
        if not ctx.use_server_backend:
            return jsonify({'message': 'Server backend is disabled.'}), 400

        variant = ctx.resolve_variant(request)
        payload = request.get_json(force=True, silent=True) or {}
        result, status = handle_chat_send(
            payload=payload,
            variant=variant,
            get_chat_for_variant=ctx.get_chat_for_variant,
            save_chat_for_variant=ctx.save_chat_for_variant,
            get_memos_for_variant=ctx.get_memos_for_variant,
            provider=ctx.llm_provider,
            model=ctx.llm_model,
            system_prompt=ctx.llm_system_prompt,
            openai_key=ctx.openai_api_key,
            gemini_key=ctx.gemini_api_key,
            max_messages=ctx.llm_max_messages,
        )
        return jsonify(result), status

    @blueprint.route('/api/chat', methods=['DELETE'])
    def chat_clear():
        if not ctx.use_server_backend:
            return jsonify({'message': 'Server backend is disabled.'}), 400
        variant = ctx.resolve_variant(request)
        ctx.save_chat_for_variant([], variant)
        return jsonify([])

    @blueprint.route('/api/chat/create-entry', methods=['POST'])
    def chat_create_entry():
        if not ctx.use_server_backend:
            return jsonify({'message': 'Server backend is disabled.'}), 400

        variant = ctx.resolve_variant(request)
        files = request.files.getlist('files')
        user_message = request.form.get('message', '').strip()

        result, status = handle_chat_create_entry(
            files=files,
            user_message=user_message,
            variant=variant,
            upload_folder=ctx.upload_folder,
            base_dir=ctx.base_dir,
            llm_provider=ctx.llm_provider,
            get_memos_for_variant=ctx.get_memos_for_variant,
            save_memos_for_variant=ctx.save_memos_for_variant,
            append_operation=ctx.operations_service.append_operation,
            get_chat_for_variant=ctx.get_chat_for_variant,
            save_chat_for_variant=ctx.save_chat_for_variant,
        )
        return jsonify(result), status

    return blueprint

"""
OCR Routes
Provides endpoints for:
  POST /api/ocr/analyze       - Upload files + trigger OCR/LLM analysis, returns draft
  GET  /api/ocr/draft/<id>    - Poll draft status
  GET  /api/ocr/draft         - Get latest draft for a memo (query: memoId, variant)
  DELETE /api/ocr/draft/<id>  - Clear a specific draft
  DELETE /api/ocr/drafts      - Clear all drafts for a memo (query: memoId, variant)
"""

import os
import threading

from flask import Blueprint, jsonify, request

from services.upload_request import parse_upload_file_from_request


def create_ocr_blueprint(ctx, app):
    blueprint = Blueprint('ocr_api', __name__)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _get_ocr_draft_service():
        return ctx.ocr_draft_service

    def _get_llm_service():
        return ctx.llm_service

    def _process_draft_async(draft_id: str, variant: str):
        """Run LLM/OCR analysis in a background thread and update the draft."""
        ocr_svc = _get_ocr_draft_service()
        llm_svc = _get_llm_service()

        try:
            draft = ocr_svc.get_draft(draft_id)
            if not draft:
                return

            # Mark as processing
            ocr_svc.update_draft_status(draft_id, 'processing')

            file_paths = draft.get('tempBin') or []
            if not file_paths:
                ocr_svc.update_draft_status(draft_id, 'error', error='No files to analyse')
                return

            if not llm_svc:
                ocr_svc.update_draft_status(draft_id, 'error', error='LLM service not configured on server')
                return

            # Try best-effort traditional OCR to aid the LLM
            ocr_texts = {}
            try:
                llm_cfg = ctx.get_llm_config()
                provider = (llm_cfg.get('provider') or ctx.llm_provider or '').lower()
                is_deepseek = provider == 'deepseek'
                # ocr_enabled defaults to True for deepseek, user-settable otherwise
                ocr_enabled = True if is_deepseek else bool(llm_cfg.get('ocr_enabled', False))
                if ocr_enabled and getattr(ctx, 'ocr_reader', None):
                    abs_paths = [os.path.join(ctx.base_dir, p.lstrip('/')) for p in file_paths]
                    ocr_texts = ctx.ocr_reader.extract_texts(abs_paths)
            except Exception:
                ocr_texts = {}

            result = llm_svc.analyze_files_for_entry(
                file_paths=file_paths,
                user_message='',
                variant=variant,
                base_dir=ctx.base_dir,
                ocr_texts=ocr_texts,
            )

            ocr_svc.update_draft_status(draft_id, 'done', proposed=result)

        except Exception as exc:  # pragma: no cover
            try:
                ocr_svc.update_draft_status(draft_id, 'error', error=str(exc))
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Routes
    # ------------------------------------------------------------------

    @blueprint.route('/api/ocr/analyze', methods=['POST'])
    def ocr_analyze():
        """
        Accepts multipart/form-data with:
          files[]   - one or more files (image or pdf)
          memoId    - (optional) memo being edited; omit or 'null' for new entry
          variant   - 'default' | 'finance'
        
        Immediately returns a draft record with status='pending' or 'processing'.
        The actual LLM analysis runs in a background thread.
        """
        if not ctx.use_server_backend:
            return jsonify({'message': 'Server backend is disabled.'}), 400

        variant = ctx.resolve_variant(request)
        memo_id = request.form.get('memoId') or request.args.get('memoId') or None
        if memo_id in ('null', 'undefined', ''):
            memo_id = None

        # Upload all provided files first
        uploaded_urls = []
        files = request.files.getlist('files')

        # Collect existing URLs early so we can skip the single-file fallback
        # when only already-uploaded files are being re-analysed
        existing_urls = request.form.getlist('existingUrls') or []

        if not files and not existing_urls:
            # Single file fallback (legacy clients that send one file without a list)
            f, err = parse_upload_file_from_request(request)
            if err:
                return jsonify({'message': err}), 400
            files = [f] if f else []

        for file_obj in files:
            if not file_obj or not file_obj.filename:
                continue
            result, _status = ctx.upload_service.handle_file_object(file_obj)
            if result and result.get('url'):
                uploaded_urls.append(result['url'])

        # Also include already-uploaded file URLs sent from the frontend
        for url in existing_urls:
            if not isinstance(url, str):
                continue
            # Normalize absolute URLs like http://host/uploads/... → /uploads/...
            if url.startswith('http://') or url.startswith('https://'):
                try:
                    from urllib.parse import urlparse
                    parsed = urlparse(url)
                    url = parsed.path  # e.g. /uploads/2025-11-27/file.pdf
                except Exception:
                    pass
            if url.startswith('/uploads/') and url not in uploaded_urls:
                uploaded_urls.append(url)

        if not uploaded_urls:
            return jsonify({'message': 'No valid files were provided.'}), 400

        # Create draft
        ocr_svc = _get_ocr_draft_service()
        draft = ocr_svc.create_draft(memo_id=memo_id, variant=variant, temp_bin=uploaded_urls)

        # Kick off background analysis
        t = threading.Thread(
            target=_process_draft_async,
            args=(draft['draftId'], variant),
            daemon=True,
        )
        t.start()

        return jsonify(draft), 202

    @blueprint.route('/api/ocr/draft/<draft_id>', methods=['GET'])
    def get_draft(draft_id):
        if not ctx.use_server_backend:
            return jsonify({'message': 'Server backend is disabled.'}), 400
        ocr_svc = _get_ocr_draft_service()
        draft = ocr_svc.get_draft(draft_id)
        if not draft:
            return jsonify({'message': 'Draft not found'}), 404
        return jsonify(draft), 200

    @blueprint.route('/api/ocr/draft', methods=['GET'])
    def get_draft_for_memo():
        """Get the latest draft for a given memoId + variant."""
        if not ctx.use_server_backend:
            return jsonify({'message': 'Server backend is disabled.'}), 400
        variant = ctx.resolve_variant(request)
        memo_id = request.args.get('memoId') or None
        if memo_id in ('null', 'undefined', ''):
            memo_id = None
        ocr_svc = _get_ocr_draft_service()
        draft = ocr_svc.get_draft_for_memo(memo_id, variant)
        if not draft:
            return jsonify(None), 200
        return jsonify(draft), 200

    @blueprint.route('/api/ocr/draft/<draft_id>', methods=['DELETE'])
    def delete_draft(draft_id):
        if not ctx.use_server_backend:
            return jsonify({'message': 'Server backend is disabled.'}), 400
        ocr_svc = _get_ocr_draft_service()
        removed = ocr_svc.clear_draft(draft_id)
        if not removed:
            return jsonify({'message': 'Draft not found'}), 404
        return jsonify({'message': 'Draft cleared'}), 200

    @blueprint.route('/api/ocr/drafts', methods=['DELETE'])
    def delete_drafts_for_memo():
        """Clear all drafts for a memo (memoId + variant query params)."""
        if not ctx.use_server_backend:
            return jsonify({'message': 'Server backend is disabled.'}), 400
        variant = ctx.resolve_variant(request)
        memo_id = request.args.get('memoId') or None
        if memo_id in ('null', 'undefined', ''):
            memo_id = None
        ocr_svc = _get_ocr_draft_service()
        count = ocr_svc.clear_drafts_for_memo(memo_id, variant)
        return jsonify({'cleared': count}), 200

    # ------------------------------------------------------------------
    # LLM configuration endpoints
    # ------------------------------------------------------------------

    @blueprint.route('/api/ocr/capabilities', methods=['GET'])
    def get_ocr_capabilities():
        """Report OCR availability and current provider capabilities for UI hints."""
        provider = (ctx.get_llm_config_safe().get('provider') or ctx.llm_provider or 'gemini').lower()
        vision_capable = provider in getattr(ctx.llm_service, '_VISION_PROVIDERS', {'openai', 'gemini'})
        ocr_info = {'available': False, 'backend': None, 'languages': []}
        try:
            if getattr(ctx, 'ocr_reader', None):
                info = ctx.ocr_reader.info()
                ocr_info = {
                    'available': bool(info.get('available')),
                    'backend': info.get('backend'),
                    'languages': info.get('languages') or [],
                }
        except Exception:
            pass
        return jsonify({
            'provider': provider,
            'vision_capable': bool(vision_capable),
            'ocr': ocr_info,
        }), 200

    @blueprint.route('/api/llm/config', methods=['GET'])
    def get_llm_config():
        """Return current LLM config (API keys redacted)."""
        return jsonify(ctx.get_llm_config_safe()), 200

    @blueprint.route('/api/llm/config', methods=['POST'])
    def save_llm_config():
        """
        Update LLM config. Accepts JSON body:
          { provider, model, gemini_api_key, openai_api_key, deepseek_api_key }
        Keys are only updated when a non-empty value is supplied.
        """
        data = request.get_json(force=True) or {}
        cfg = ctx.get_llm_config()

        provider = (data.get('provider') or '').strip()
        if provider:
            cfg['provider'] = provider

        model = (data.get('model') or '').strip()
        if model:
            cfg['model'] = model

        # ocr_enabled: always True for deepseek (force), else use supplied value
        if 'ocr_enabled' in data:
            is_deepseek = (cfg.get('provider') or '').lower() == 'deepseek'
            cfg['ocr_enabled'] = True if is_deepseek else bool(data['ocr_enabled'])

        for key in ('gemini_api_key', 'openai_api_key', 'deepseek_api_key'):
            val = (data.get(key) or '').strip()
            if val:
                cfg[key] = val

        ctx.save_llm_config(cfg)
        return jsonify({'message': 'AI settings saved.', **ctx.get_llm_config_safe()}), 200

    return blueprint

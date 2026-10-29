import logging

from flask import Blueprint, jsonify, request

from services import ai_step
from services.agent import ASSISTANT_CHAT_KEY
from services.chat import handle_chat_create_entry, handle_chat_send

_log = logging.getLogger('chat_routes')


def create_chat_blueprint(ctx):
    blueprint = Blueprint('chat_api', __name__)

    @blueprint.route('/api/chat', methods=['GET'])
    def chat_list():
        if not ctx.use_server_backend:
            return jsonify([])
        # One shared assistant conversation regardless of which page asks.
        return jsonify(ctx.get_chat_for_variant(ASSISTANT_CHAT_KEY))

    @blueprint.route('/api/chat/summaries', methods=['GET'])
    def chat_summaries():
        """Return the prompt string and all summaries for the active variant."""
        if not ctx.use_server_backend:
            return jsonify({'prompt': '', 'summaries': {}})
        variant = ctx.resolve_variant(request)
        store = ctx.get_chat_store_for_variant(variant)
        return jsonify({
            'prompt': store.get('prompt', ''),
            'summaries': store.get('summaries', {}),
        })

    @blueprint.route('/api/chat/summaries/prompt', methods=['PUT'])
    def chat_update_prompt():
        """Update the custom prompt prefix stored in the chat store."""
        if not ctx.use_server_backend:
            return jsonify({'message': 'Server backend is disabled.'}), 400
        variant = ctx.resolve_variant(request)
        payload = request.get_json(force=True, silent=True) or {}
        new_prompt = (payload.get('prompt') or '').strip()
        store = ctx.get_chat_store_for_variant(variant)
        store['prompt'] = new_prompt
        ctx.save_chat_store_for_variant(store, variant)
        return jsonify({'prompt': new_prompt})

    @blueprint.route('/api/chat', methods=['POST'])
    def chat_send():
        if not ctx.use_server_backend:
            return jsonify({'message': 'Server backend is disabled.'}), 400

        variant = ctx.resolve_variant(request)
        payload = request.get_json(force=True, silent=True) or {}

        # Retrieve full store for system-prompt and summaries context
        store = ctx.get_chat_store_for_variant(variant)
        custom_prompt = store.get('prompt', '')
        summaries = store.get('summaries', {})

        # Build effective system prompt (base + custom prefix + active summaries)
        base_prompt = ctx.llm_system_prompt
        summary_context = _build_summary_context(summaries)
        effective_prompt = '\n\n'.join(
            p for p in [base_prompt, custom_prompt, summary_context] if p.strip()
        )

        result, status = handle_chat_send(
            payload=payload,
            variant=variant,
            get_chat_for_variant=ctx.get_chat_for_variant,
            save_chat_for_variant=ctx.save_chat_for_variant,
            get_memos_for_variant=ctx.get_memos_for_variant,
            provider=ctx.llm_provider,
            model=ctx.llm_model,
            system_prompt=effective_prompt,
            openai_key=ctx.openai_api_key,
            gemini_key=ctx.gemini_api_key,
            deepseek_key=ctx.deepseek_api_key,
            max_messages=ctx.llm_max_messages,
            provider_keys=ctx.provider_keys(),
        )
        if status == 200:
            ctx.schedule_chat_summarization_if_due(variant, reason='chat-send')
        return jsonify(result), status

    # /api/chat/agent (an agent that changed entries with no tap, behind only
    # the shared sync password) is now the Agent API: /api/agent/v1/*, with
    # per-agent tokens, and changes that arrive as cards (api/agent_routes.py).
    @blueprint.route('/api/chat/agent', methods=['POST'])
    def chat_agent_moved():
        return jsonify({'message': 'This endpoint moved to the Agent API: POST /api/agent/v1/chat with an agent token.'}), 410

    @blueprint.route('/api/ai/step', methods=['POST'])
    def ai_tool_step():
        """One step for an AI contact that uses the server's AI (services/ai_step.py)."""
        if not ctx.use_server_backend:
            return jsonify({'message': 'Server backend is disabled.'}), 400
        payload = request.get_json(force=True, silent=True) or {}
        try:
            return jsonify(ai_step.step(ctx, payload)), 200
        except ValueError as exc:
            return jsonify({'message': str(exc)}), 400
        except Exception as exc:  # never a bare 500 for a provider failure
            _log.warning('ai step failed: %s', exc)
            return jsonify({'message': f'The server AI failed: {type(exc).__name__}: {exc}'}), 502

    @blueprint.route('/api/chat', methods=['DELETE'])
    def chat_clear():
        if not ctx.use_server_backend:
            return jsonify({'message': 'Server backend is disabled.'}), 400
        # Clear the one shared assistant conversation.
        ctx.save_chat_for_variant([], ASSISTANT_CHAT_KEY)
        return jsonify([])

    @blueprint.route('/api/chat/close', methods=['POST'])
    def chat_close():
        if not ctx.use_server_backend:
            return jsonify({'scheduled': False, 'message': 'Server backend is disabled.'}), 400
        variant = ctx.resolve_variant(request)
        scheduled = ctx.schedule_chat_summarization_if_due(variant, reason='chat-close')
        return jsonify({'scheduled': scheduled})

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
            upsert_entry=ctx.upsert_entry_for_variant,
            append_operation=ctx.operations_service.append_operation,
            get_chat_for_variant=ctx.get_chat_for_variant,
            save_chat_for_variant=ctx.save_chat_for_variant,
        )
        if status == 200:
            ctx.schedule_chat_summarization_if_due(variant, reason='chat-create-entry')
        return jsonify(result), status

    @blueprint.route('/api/chat/debug/gen-summaries', methods=['POST'])
    def chat_debug_gen_summaries():
        """
        DEBUG ONLY – inject fake summary data so the UI can be tested without
        waiting for real calendar rollovers.  Removes any previous fake entries
        before inserting new ones (idempotent).
        """
        if not ctx.use_server_backend:
            return jsonify({'message': 'Server backend is disabled.'}), 400

        from datetime import date, timedelta
        import uuid as _uuid

        variant = ctx.resolve_variant(request)
        store = ctx.get_chat_store_for_variant(variant)
        s = store.setdefault('summaries', {})

        today = date.today()

        def _fake_day(offset, text):
            d = (today - timedelta(days=offset)).isoformat()
            return {'id': str(_uuid.uuid4()), 'date': d,
                    'summary': f'[DEBUG day -{offset}] {text}',
                    'created_at': today.isoformat() + 'T00:00:00Z'}

        def _fake_week(wk, text):
            return {'id': str(_uuid.uuid4()), 'week_key': wk,
                    'date_from': today.isoformat(), 'date_to': today.isoformat(),
                    'summary': f'[DEBUG week {wk}] {text}',
                    'created_at': today.isoformat() + 'T00:00:00Z'}

        def _fake_month(mk, text):
            return {'id': str(_uuid.uuid4()), 'month_key': mk,
                    'summary': f'[DEBUG month {mk}] {text}',
                    'created_at': today.isoformat() + 'T00:00:00Z'}

        def _fake_quarter(qk, text):
            return {'id': str(_uuid.uuid4()), 'quarter_key': qk,
                    'summary': f'[DEBUG quarter {qk}] {text}',
                    'created_at': today.isoformat() + 'T00:00:00Z'}

        def _fake_year(yk, text):
            return {'id': str(_uuid.uuid4()), 'year_key': yk,
                    'summary': f'[DEBUG year {yk}] {text}',
                    'created_at': today.isoformat() + 'T00:00:00Z'}

        label = 'finance entries' if variant == 'finance' else 'memos'

        # Replace with fresh fake data (filter out previous DEBUG entries first)
        def _strip_debug(lst):
            return [x for x in lst if not x.get('summary', '').startswith('[DEBUG')]

        before = {k: len(s.get(k, [])) for k in ('day', 'week', 'month', 'quarter', 'year')}
        _log.info('chat_debug_gen_summaries: variant=%s, counts before strip=%s', variant, before)

        s['day'] = _strip_debug(s.get('day', []))
        s['week'] = _strip_debug(s.get('week', []))
        s['month'] = _strip_debug(s.get('month', []))
        s['quarter'] = _strip_debug(s.get('quarter', []))
        s['year'] = _strip_debug(s.get('year', []))

        s['day'] += [
            _fake_day(1, f'Added 3 {label}, discussed project status.'),
            _fake_day(2, f'Logged 5 {label}, reviewed pending tasks.'),
            _fake_day(5, f'Quiet day, 1 {label} recorded.'),
            _fake_day(8, f'Active day: 7 {label}, chat about budget.'),
        ]
        s['week'] += [
            _fake_week('2026-W09', f'Regular week, 10 {label} logged.'),
            _fake_week('2026-W08', f'Productive week: reviewed Q4 results.'),
            _fake_week('2026-W06', f'Light usage, only 3 {label}.'),
        ]
        s['month'] += [
            _fake_month('2026-02', f'February: 25 {label}, focus on planning.'),
            _fake_month('2026-01', f'January: 40 {label}, started the year strong.'),
        ]
        s['quarter'] += [
            _fake_quarter('2025-Q4', f'Q4 2025: high activity, 120 {label}.'),
            _fake_quarter('2025-Q3', f'Q3 2025: steady usage, 80 {label}.'),
        ]
        s['year'] += [
            _fake_year('2025', f'2025 full year: consistent use of the system, 300+ {label}.'),
        ]

        ctx.save_chat_store_for_variant(store, variant)
        after = {k: len(v) for k, v in s.items()}
        _log.info('chat_debug_gen_summaries: done, counts after inject=%s', after)
        return jsonify({
            'ok': True,
            'counts': {k: len(v) for k, v in s.items()},
        })

    return blueprint


def _build_summary_context(summaries: dict) -> str:
    """
    Build a concise memory block from recent summaries to inject into the
    system prompt so the LLM has long-term context without inflating the
    conversation history.
    """
    parts = []

    def _latest(items, key, label):
        if not items:
            return
        latest = sorted(items, key=lambda x: x.get(key, ''))[-1]
        parts.append(f"[{label} – {latest.get(key, '')}]\n{latest.get('summary', '')}")

    _latest(summaries.get('day', []), 'date', 'Recent day')
    _latest(summaries.get('week', []), 'week_key', 'Recent week')
    _latest(summaries.get('month', []), 'month_key', 'Recent month')
    _latest(summaries.get('quarter', []), 'quarter_key', 'Recent quarter')
    _latest(summaries.get('year', []), 'year_key', 'Recent year')

    if not parts:
        _log.debug('_build_summary_context: no summaries available')
        return ''
    _log.debug('_build_summary_context: injecting %d period(s) into system prompt', len(parts))
    return (
        'Long-term memory summaries (most recent of each period):\n\n'
        + '\n\n'.join(parts)
    )

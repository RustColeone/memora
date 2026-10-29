"""
api/agent_routes.py — the Agent API: outside agents, with their own tokens.

    Authorization: Bearer mk_…        (from `memora-server token create`)

    GET  /api/agent/v1/me                       the token's name and pages
    GET  /api/agent/v1/search?q=&page=&from=&to=&limit=
    GET  /api/agent/v1/items/<page>/<id>
    POST /api/agent/v1/proposals {message, actions:[…]}   cards that wait for a tap
    POST /api/agent/v1/entries   {page, item}             add directly (write only)
    POST /api/agent/v1/chat      {message}                ask this server's AI;
                                                          its changes become cards

Pages are notes, spending and plans. A proposal shows in the app as a message
from the agent with one card per action, exactly like an AI contact's cards:
nothing changes until someone taps it. Everything an agent sends goes through
the sync log as if a device had sent it, so every device gets it.

Owner endpoints (under the sync password, like the rest of /api):
    GET    /api/agent-tokens            list (never the tokens themselves)
    POST   /api/agent-tokens {name, scopes}   → the token, shown once
    DELETE /api/agent-tokens/<id>       revoke
"""

import json
import time
import uuid
from typing import Any, Dict, List, Optional

from flask import Blueprint, g, jsonify, request

from services import ai_step
from services.agent_tokens import AgentTokens, PAGES, VARIANT

MAX_ACTIONS = 20
MAX_IDS = 50
MAX_TEXT = 8000
CHAT_STEPS = 5
_UPDATE_KEYS = ('addTags', 'removeTags', 'category', 'done', 'text', 'total', 'date')


def _now_ms() -> int:
    return int(time.time() * 1000)


def _iso(ms: int) -> str:
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(ms / 1000)) + '.%03dZ' % (ms % 1000)


def _str(v, n=400) -> str:
    return str(v if v is not None else '').strip()[:n]


def _num(v) -> float:
    try:
        return round(float(v), 2)
    except (TypeError, ValueError):
        return 0.0


def _tags(v) -> List[str]:
    items = v if isinstance(v, list) else str(v or '').split(',')
    return [str(t).strip().lstrip('#')[:40] for t in items if str(t).strip()][:20]


def _day(v) -> Optional[str]:
    s = _str(v, 10)
    return s if len(s) == 10 and s[4] == '-' and s[7] == '-' else None


def _time(v) -> Optional[str]:
    s = _str(v, 5)
    return s if len(s) == 5 and s[2] == ':' else None


def clean_item(page: str, item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The fields an agent may set on a new item, cleaned; None if unusable."""
    if not isinstance(item, dict):
        return None
    if page == 'notes':
        text = _str(item.get('description') or item.get('text'), MAX_TEXT)
        return {'description': text, 'category': _str(item.get('category'), 60) or 'Uncategorized', 'tags': _tags(item.get('tags'))} if text else None
    if page == 'spending':
        text = _str(item.get('description') or item.get('text'), 2000)
        if not text:
            return None
        lines = []
        for li in (item.get('items') or [])[:60]:
            if isinstance(li, dict) and li.get('name'):
                qty = int(_num(li.get('amount')) or 1)
                unit = _num(li.get('unitPrice'))
                line = {'name': _str(li['name'], 120), 'description': '', 'amount': qty, 'unitPrice': unit,
                        'totalPrice': _num(li['totalPrice']) if li.get('totalPrice') is not None else round(qty * unit, 2)}
                # A discount lowers the total; a fee or tip is added after tax.
                if li.get('kind') == 'discount':
                    line.update(kind='discount', amount=1, unitPrice=-abs(line['totalPrice']), totalPrice=-abs(line['totalPrice']))
                elif li.get('kind') == 'fee':
                    line['kind'] = 'fee'
                lines.append(line)
        out = {'description': text, 'total': _num(item.get('total')), 'tax': _num(item.get('tax')),
               'category': _str(item.get('category'), 60) or 'Uncategorized', 'purchaseDate': _day(item.get('purchaseDate') or item.get('date')),
               'tags': _tags(item.get('tags')), 'items': lines}
        for key, size in (('store', 60), ('paidWith', 40), ('notes', 2000)):
            value = _str(item.get(key), size)
            if value:
                out[key] = value
        return out
    if page == 'plans':
        title = _str(item.get('title') or item.get('text'), 200)
        if not title:
            return None
        if (item.get('kind') or 'todo') == 'event':
            date = _day(item.get('date'))
            if not date:
                return None
            start, end = _time(item.get('start')), _time(item.get('end'))
            out = {'kind': 'event', 'title': title, 'date': date, 'allDay': not start, 'start': start or '09:00', 'end': end or ('10:00' if not start else start),
                   'description': _str(item.get('description') or item.get('notes'), 2000), 'remindBefore': 0}
            if item.get('remindAtStart'):
                out['remindAtStart'] = True
            return out
        out = {'kind': 'todo', 'title': title}
        if _day(item.get('due')):
            out['due'] = _day(item.get('due'))
        return out
    return None


def clean_action(action: Dict[str, Any], allowed) -> Dict[str, Any]:
    """A card the app can show, from what an agent sent. Raises ValueError."""
    if not isinstance(action, dict):
        raise ValueError('Each action must be an object.')
    kind = action.get('type')
    page = action.get('page')
    if page not in PAGES:
        raise ValueError('page must be one of: ' + ', '.join(PAGES))
    if not allowed(page):
        raise ValueError(f'This token may not propose changes to {page}.')
    if kind in ('create', 'reminder'):
        items = [clean_item(page, it) for it in (action.get('items') or ([action['item']] if action.get('item') else []))[:20]]
        items = [it for it in items if it]
        if not items:
            raise ValueError('A create action needs items with their required fields.')
        if kind == 'reminder':
            if page != 'plans' or any(it.get('kind') != 'event' or it.get('allDay') for it in items):
                raise ValueError('A reminder is a plans event with a date and a start time.')
            for it in items:
                it['remindAtStart'] = True
        return {'type': kind, 'page': page, 'items': items}
    if kind in ('update', 'delete'):
        ids = [str(i)[:80] for i in (action.get('ids') or []) if i][:MAX_IDS]
        if not ids:
            raise ValueError('update and delete need ids (from search).')
        if kind == 'delete':
            return {'type': 'delete', 'page': page, 'ids': ids, 'reason': _str(action.get('reason'), 160)}
        change = {}
        raw = action.get('change') or {}
        for k in _UPDATE_KEYS:
            if k not in raw:
                continue
            if k in ('addTags', 'removeTags'):
                change[k] = _tags(raw[k])
            elif k == 'done':
                change[k] = bool(raw[k])
            elif k == 'total':
                change[k] = _num(raw[k])
            elif k == 'date':
                if _day(raw[k]):
                    change[k] = _day(raw[k])
            else:
                change[k] = _str(raw[k], MAX_TEXT if k == 'text' else 60)
        if not change:
            raise ValueError('An update needs a change: ' + ', '.join(_UPDATE_KEYS))
        return {'type': 'update', 'page': page, 'ids': ids, 'change': change, 'summary': _str(action.get('summary'), 80)}
    raise ValueError('type must be create, reminder, update or delete.')


def create_agent_blueprint(ctx):
    blueprint = Blueprint('agent_api', __name__)
    tokens = AgentTokens(ctx.chat_store_service, ctx.lock)
    ctx.agent_tokens = tokens

    # ── auth ──
    @blueprint.before_request
    def agent_auth():
        if not request.path.startswith('/api/agent/v1/') or request.method == 'OPTIONS':
            return None
        limiter = getattr(ctx, 'attempts', None)
        wait = limiter.retry_after(request.remote_addr) if limiter else 0
        if wait:
            resp = jsonify({'error': 'too_many_attempts', 'message': 'Too many wrong tokens. Try again in %d seconds.' % wait})
            resp.headers['Retry-After'] = str(wait)
            return resp, 429
        header = request.headers.get('Authorization', '')
        token = header[7:].strip() if header.lower().startswith('bearer ') else ''
        record = tokens.check(token)
        if not record:
            if token and limiter:
                limiter.fail(request.remote_addr)
            return jsonify({'error': 'agent_auth', 'message': 'A valid agent token is required (Authorization: Bearer mk_…).'}), 401
        if limiter:
            limiter.success(request.remote_addr)
        g.agent = record
        return None

    def can(level):
        return lambda page: AgentTokens.allows(g.agent, page, level)

    def push(variant: str, op_type: str, entry_id: str, data: Dict[str, Any]):
        """Through the sync log, exactly as a device would send it."""
        op = {'type': op_type, 'entryId': entry_id, 'clientOpId': 'agent-' + uuid.uuid4().hex, 'timestamp': _now_ms(),
              'deviceId': 'agent:' + g.agent['id'], 'data': data}
        result = ctx.operations_service.handle_push_operations({'operations': [op]}, variant, ctx.apply_operation_to_memos)
        body = result[0] if isinstance(result, tuple) else result
        if isinstance(body, dict) and body.get('failures'):
            raise RuntimeError('Could not save: ' + json.dumps(body['failures'])[:300])

    def contact_id():
        return 'agent_' + g.agent['id']

    def ensure_contact():
        cid = contact_id()
        existing = ctx.contacts_store.get_one(cid, 'contacts')
        if existing and not existing.get('deletedAt') and existing.get('name') == g.agent['name']:
            return cid
        push('contacts', 'create', cid, {'id': cid, 'kind': 'agent', 'name': g.agent['name'], 'avatar': {'letter': g.agent['name'][:1].upper()}})
        return cid

    def post_cards(message: str, actions: List[Dict[str, Any]]) -> Dict[str, Any]:
        cid = ensure_contact()
        now = _now_ms()
        mid = 'm_agent_' + uuid.uuid4().hex[:16]
        cards = [dict(a, id='a%d' % (i + 1), status='pending') for i, a in enumerate(actions)]
        doc = {'id': mid, 'chatId': cid, 'role': 'assistant', 'authorId': cid, 'text': _str(message, 4000), 'at': now, 'createdAt': _iso(now)}
        if cards:
            doc['actions'] = cards
        push('messages', 'create', mid, doc)
        return {'messageId': mid, 'cards': len(cards)}

    # ── reading ──
    def visible(page: str, e: Dict[str, Any]) -> bool:
        return not e.get('deletedAt') and not (page == 'notes' and e.get('safe'))

    def brief(page: str, e: Dict[str, Any]) -> Dict[str, Any]:
        out = {'page': page, 'id': e.get('id')}
        if page == 'plans':
            for k in ('kind', 'title', 'date', 'start', 'end', 'due', 'done'):
                if e.get(k) is not None:
                    out[k] = e[k]
            return out
        out['text'] = (e.get('description') or '')[:400]
        for k in ('category', 'tags', 'purchaseDate', 'total', 'createdAt'):
            if e.get(k) not in (None, '', []):
                out[k] = e[k]
        return out

    def date_of(page: str, e: Dict[str, Any]) -> str:
        if page == 'spending':
            return str(e.get('purchaseDate') or e.get('createdAt') or '')[:10]
        if page == 'plans':
            return str(e.get('date') or e.get('due') or e.get('createdAt') or '')[:10]
        return str(e.get('createdAt') or '')[:10]

    @blueprint.route('/api/agent/v1/me', methods=['GET'])
    def agent_me():
        return jsonify({'name': g.agent['name'], 'scopes': g.agent['scopes']})

    @blueprint.route('/api/agent/v1/search', methods=['GET'])
    def agent_search():
        want = request.args.get('page')
        pages = [p for p in ([want] if want else PAGES) if p in PAGES and AgentTokens.allows(g.agent, p, 'read')]
        if not pages:
            return jsonify({'message': 'This token may not read that page.'}), 403
        words = [w for w in (request.args.get('q') or '').lower().split() if w]
        start, end = _day(request.args.get('from')), _day(request.args.get('to'))
        try:
            limit = max(1, min(100, int(request.args.get('limit') or 25)))
        except ValueError:
            limit = 25
        hits = []
        for page in pages:
            for e in ctx.get_memos_for_variant(VARIANT[page]):
                if not visible(page, e):
                    continue
                d = date_of(page, e)
                if (start and d < start) or (end and d > end):
                    continue
                hay = ' '.join(str(e.get(k) or '') for k in ('description', 'title', 'category')).lower() + ' ' + ' '.join(map(str, e.get('tags') or [])).lower()
                score = sum(1 for w in words if w in hay)
                if words and not score:
                    continue
                hits.append((score, d, brief(page, e)))
        hits.sort(key=lambda h: (h[0], h[1]), reverse=True)   # best match, then newest
        return jsonify({'count': min(limit, len(hits)), 'total': len(hits), 'items': [h[2] for h in hits[:limit]]})

    @blueprint.route('/api/agent/v1/items/<page>/<item_id>', methods=['GET'])
    def agent_item(page, item_id):
        if page not in PAGES or not AgentTokens.allows(g.agent, page, 'read'):
            return jsonify({'message': 'This token may not read that page.'}), 403
        e = ctx._store_for_variant(VARIANT[page]).get_one(item_id, VARIANT[page])
        if not e or not visible(page, e):
            return jsonify({'message': 'Not found.'}), 404
        out = brief(page, e)
        if page != 'plans':
            out['text'] = (e.get('description') or '')[:MAX_TEXT]
            if page == 'spending':
                out['items'] = e.get('items') or []
                out['tax'] = e.get('tax')
        return jsonify(out)

    # ── changing ──
    @blueprint.route('/api/agent/v1/proposals', methods=['POST'])
    def agent_proposals():
        payload = request.get_json(force=True, silent=True) or {}
        raw = payload.get('actions') or []
        if not isinstance(raw, list) or not raw:
            return jsonify({'message': 'actions must be a non-empty list.'}), 400
        if len(raw) > MAX_ACTIONS:
            return jsonify({'message': f'At most {MAX_ACTIONS} actions per proposal.'}), 400
        try:
            actions = [clean_action(a, can('propose')) for a in raw]
        except ValueError as exc:
            return jsonify({'message': str(exc)}), 400
        return jsonify(post_cards(payload.get('message') or '', actions)), 200

    @blueprint.route('/api/agent/v1/entries', methods=['POST'])
    def agent_entries():
        payload = request.get_json(force=True, silent=True) or {}
        page = payload.get('page')
        if page not in PAGES or not AgentTokens.allows(g.agent, page, 'write'):
            return jsonify({'message': 'This token may not add items to that page directly. Send a proposal instead.'}), 403
        item = clean_item(page, payload.get('item') or {})
        if not item:
            return jsonify({'message': 'The item is missing its required fields.'}), 400
        now = _now_ms()
        entry_id = ('p_' if page == 'plans' else 'e_') + 'agent_' + uuid.uuid4().hex[:16]
        data = dict(item, createdAt=_iso(now), updatedAt=_iso(now), source='agent:' + g.agent['name'])
        if page != 'plans':
            data.update({'images': [], 'attachments': [], 'ts': now})
            if page == 'spending':
                data['price'] = round(data['total'] - data['tax'], 2)
                data['purchaseDate'] = data['purchaseDate'] or time.strftime('%Y-%m-%d')
        elif data['kind'] == 'todo':
            data.update({'done': False, 'priority': 'normal'})
        push(VARIANT[page], 'create', entry_id, data)
        return jsonify({'id': entry_id, 'page': page}), 200

    # ── plain language, through this server's AI ──
    @blueprint.route('/api/agent/v1/chat', methods=['POST'])
    def agent_chat():
        payload = request.get_json(force=True, silent=True) or {}
        text = _str(payload.get('message'), MAX_TEXT)
        if not text:
            return jsonify({'message': 'message is required.'}), 400
        if not ai_step.ready(ctx):
            return jsonify({'message': "This server has no AI set up. Add a provider and key in the server's Settings."}), 400
        from services.agent import MemoAgentTools
        tools = MemoAgentTools(ctx, propose=True, allowed=lambda page, level: AgentTokens.allows(g.agent, page, level))
        specs = [s['function'] for s in tools.specs()]
        messages = [{'role': 'user', 'content': text}]
        system = ('You are an assistant inside Memora, working for an outside agent named "%s". Use the tools to look things up. '
                  'Changes you make are only proposals: the person approves each one in the app. Today is %s.') % (g.agent['name'], time.strftime('%Y-%m-%d'))
        reply = ''
        try:
            for step in range(CHAT_STEPS + 1):
                out = ai_step.step(ctx, {'system': system, 'messages': messages, 'tools': specs, 'final': step == CHAT_STEPS})
                reply = out.get('text') or reply
                calls = out.get('calls') or []
                if not calls or step == CHAT_STEPS:
                    break
                messages.append({'role': 'assistant', 'content': out.get('text') or '', 'calls': calls, 'raw': out.get('raw')})
                for call in calls:
                    messages.append({'role': 'tool', 'id': call.get('id'), 'name': call.get('name'), 'result': tools.call(call.get('name'), call.get('args') or {})})
        except ValueError as exc:
            return jsonify({'message': str(exc)}), 400
        posted = post_cards(reply or ('Proposed %d change(s).' % len(tools.proposals)), tools.proposals) if (tools.proposals or reply) else {'cards': 0}
        return jsonify({'reply': reply, 'cards': posted.get('cards', 0), 'messageId': posted.get('messageId')}), 200

    # ── owner: manage tokens (sync-password protected like the rest of /api) ──
    @blueprint.route('/api/agent-tokens', methods=['GET'])
    def tokens_list():
        return jsonify({'tokens': tokens.list()})

    @blueprint.route('/api/agent-tokens', methods=['POST'])
    def tokens_create():
        payload = request.get_json(force=True, silent=True) or {}
        try:
            record, token = tokens.create(payload.get('name'), payload.get('scopes'))
        except ValueError as exc:
            return jsonify({'message': str(exc)}), 400
        return jsonify({'token': token, 'record': record, 'note': 'Shown once. Store it in the agent; Memora keeps only a hash.'}), 200

    @blueprint.route('/api/agent-tokens/<token_id>', methods=['DELETE'])
    def tokens_revoke(token_id):
        return (jsonify({'revoked': True}), 200) if tokens.revoke(token_id) else (jsonify({'message': 'No such token.'}), 404)

    return blueprint

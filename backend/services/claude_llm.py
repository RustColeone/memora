"""
Claude (Anthropic) for the self-hosted server, through the official SDK.

Kept apart from the OpenAI-compatible providers in llm.py / chat_reply.py,
which only dispatch here. The `anthropic` package is optional like the other
provider SDKs: without it, choosing Claude reports that it is not installed.

Requests follow the current API: no sampling parameters (current models
reject temperature), room in max_tokens for adaptive thinking (on by default),
and a refusal check before reading text. Where the installed SDK supports it,
the server-side refusal fallback is on for the models that accept it.
"""

import base64
import json
import inspect
import os
from typing import Dict, List, Optional

try:
    import anthropic
    _available = True
except Exception:  # pragma: no cover - depends on the server's environment
    anthropic = None
    _available = False

DEFAULT_MODEL = 'claude-sonnet-5-5'
# Models that take fallbacks="default" (routes by refusal category).
_FALLBACK_MODELS = {'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'}
_MIME = {'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif', 'webp': 'image/webp'}


def available() -> bool:
    return _available


def _create(client, params: Dict):
    create = client.beta.messages.create
    if params['model'] in _FALLBACK_MODELS and 'fallbacks' in inspect.signature(create).parameters:
        return create(betas=['server-side-fallback-2026-07-01'], fallbacks='default', **params)
    return client.messages.create(**params)


def _alternating(messages: List[Dict]) -> List[Dict]:
    """Claude wants alternating turns that start with the user."""
    turns: List[Dict] = []
    for m in messages:
        role = m.get('role')
        content = m.get('content')
        if role not in ('user', 'assistant') or content in (None, '', []):
            continue
        if not turns and role != 'user':
            continue
        if turns and turns[-1]['role'] == role and isinstance(content, str) and isinstance(turns[-1]['content'], str):
            turns[-1]['content'] += '\n\n' + content
        else:
            turns.append({'role': role, 'content': content})
    return turns or [{'role': 'user', 'content': '.'}]


def image_block(path: str) -> Dict:
    with open(path, 'rb') as f:
        data = base64.standard_b64encode(f.read()).decode('utf-8')
    ext = os.path.splitext(path)[1].lower().lstrip('.')
    return {'type': 'image', 'source': {'type': 'base64', 'media_type': _MIME.get(ext, 'image/jpeg'), 'data': data}}


def complete(api_key: Optional[str], model: Optional[str], system: Optional[str], messages: List[Dict],
             images: Optional[List[str]] = None) -> str:
    """One reply. `images` are file paths attached to the last user turn."""
    if not _available:
        raise ValueError("Claude needs the 'anthropic' Python package on the server (pip install anthropic).")
    if not api_key:
        raise ValueError('Claude API key not configured. Add it in Settings, AI Analysis, or set ANTHROPIC_API_KEY.')
    turns = _alternating(messages)
    if images:
        last = turns[-1]
        text = last['content'] if isinstance(last['content'], str) else ''
        last['content'] = [image_block(p) for p in images] + [{'type': 'text', 'text': text or '.'}]
    params = {'model': model or DEFAULT_MODEL, 'max_tokens': 16000, 'messages': turns}
    if system:
        params['system'] = system
    client = anthropic.Anthropic(api_key=api_key)
    try:
        response = _create(client, params)
    except anthropic.AuthenticationError:
        raise ValueError('Claude rejected the API key.')
    except anthropic.RateLimitError:
        raise ValueError('Claude is rate limiting this key. Try again shortly.')
    except anthropic.APIStatusError as e:
        raise ValueError(f'Claude error ({e.status_code}): {e.message}')
    except anthropic.APIConnectionError:
        raise ValueError('Could not reach Claude.')
    if response.stop_reason == 'refusal':
        raise ValueError('Claude declined to answer this one.')
    return ''.join(block.text for block in response.content if block.type == 'text')


def _errors(call):
    try:
        return call()
    except anthropic.AuthenticationError:
        raise ValueError('Claude rejected the API key.')
    except anthropic.RateLimitError:
        raise ValueError('Claude is rate limiting this key. Try again shortly.')
    except anthropic.APIStatusError as e:
        raise ValueError(f'Claude error ({e.status_code}): {e.message}')
    except anthropic.APIConnectionError:
        raise ValueError('Could not reach Claude.')


def tool_step(api_key: Optional[str], model: Optional[str], system: Optional[str], messages: List[Dict],
              tools: List[Dict], final: bool = False) -> Dict:
    """One tool-use step for services/ai_step.py (its neutral message shape).

    The assistant turn goes back exactly as Claude sent it (`raw`), and tool
    results go in the next user turn as tool_result blocks.
    """
    if not _available:
        raise ValueError("Claude needs the 'anthropic' Python package on the server (pip install anthropic).")
    if not api_key:
        raise ValueError('Claude API key not configured.')
    turns: List[Dict] = []

    def add(role, content):
        if turns and turns[-1]['role'] == role:
            prev = turns[-1]['content']
            prev = [{'type': 'text', 'text': prev}] if isinstance(prev, str) else prev
            more = [{'type': 'text', 'text': content}] if isinstance(content, str) else content
            turns[-1]['content'] = prev + more
        else:
            turns.append({'role': role, 'content': content})

    for m in messages:
        role = m.get('role')
        if role == 'user':
            images = m.get('images') or []
            text = m.get('content') or '.'
            if images:
                blocks = []
                for url in images:
                    head, _, data = url.partition(',')
                    mime = head[5:].split(';')[0] if head.startswith('data:') else 'image/jpeg'
                    blocks.append({'type': 'image', 'source': {'type': 'base64', 'media_type': mime, 'data': data}})
                add('user', blocks + [{'type': 'text', 'text': text}])
            else:
                add('user', text)
        elif role == 'assistant':
            raw = m.get('raw')
            if not turns:
                continue
            add('assistant', raw if isinstance(raw, list) and raw else (m.get('content') or '.'))
        elif role == 'tool':
            result = m.get('result')
            add('user', [{'type': 'tool_result', 'tool_use_id': m.get('id'), 'content': json.dumps(result, ensure_ascii=False, default=str),
                          'is_error': bool(isinstance(result, dict) and result.get('error'))}])
    params = {'model': model or DEFAULT_MODEL, 'max_tokens': 16000, 'messages': turns or [{'role': 'user', 'content': '.'}]}
    if system:
        params['system'] = system
    if tools:
        params['tools'] = [{'name': t['name'], 'description': t.get('description', ''),
                            'input_schema': t.get('parameters') or {'type': 'object', 'properties': {}}} for t in tools]
        if final:
            params['tool_choice'] = {'type': 'none'}
    client = anthropic.Anthropic(api_key=api_key)
    response = _errors(lambda: _create(client, params))
    if response.stop_reason == 'refusal':
        raise ValueError('Claude declined to answer this one.')
    calls = [{'id': b.id, 'name': b.name, 'args': b.input if isinstance(b.input, dict) else {}}
             for b in response.content if b.type == 'tool_use']
    text = ''.join(b.text for b in response.content if b.type == 'text')
    return {'text': text, 'calls': calls, 'raw': [b.model_dump(exclude_none=True) for b in response.content]}

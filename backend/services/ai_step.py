"""
services/ai_step.py — "Your server's AI": one tool-calling step with the
server's own provider and key, for an AI contact that picked the server.

The app runs the tools itself (search over its own copy of the data, under
its privacy rules) and turns every change into a card the person taps, so
the server never reads or writes entries here. Each call takes the
conversation so far in a neutral shape and returns what the model said and
which tools it wants:

  messages: {role: 'user', content, images?: [data URLs]}
            {role: 'assistant', content, calls: [{id, name, args}], raw?}
            {role: 'tool', id, name, result}
  tools:    [{name, description, parameters}]   (JSON schema)
  final:    true → no more tool calls, just answer
  returns   {text, calls, raw}

`raw` is the provider's own assistant turn; the app sends it back unchanged
so thinking blocks and signatures survive the round trip.
"""

import json
import uuid
from typing import Any, Dict, List, Optional

import requests

from services import claude_llm
from services.llm import openai_reasoning, vision_capable

try:
    from openai import OpenAI  # type: ignore
    _openai_available = True
except Exception:  # pragma: no cover
    OpenAI = None  # type: ignore
    _openai_available = False

_GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models/'
_DEFAULT_MODELS = {'openai': 'gpt-6-luna', 'deepseek': 'deepseek-flash', 'gemini': 'gemini-3.8-flash',
                   'anthropic': claude_llm.DEFAULT_MODEL}


def settings(ctx) -> Dict[str, Any]:
    cfg = ctx.get_llm_config()
    provider = (cfg.get('provider') or ctx.llm_provider or '').lower()
    extra = ctx.provider_keys(cfg)
    keys = {
        'openai': cfg.get('openai_api_key') or ctx.openai_api_key,
        'gemini': cfg.get('gemini_api_key') or ctx.gemini_api_key,
        'deepseek': cfg.get('deepseek_api_key') or ctx.deepseek_api_key,
        'anthropic': extra['anthropic_api_key'],
        'custom': extra['custom_api_key'],
    }
    return {'provider': provider, 'key': keys.get(provider), 'base_url': extra['custom_base_url'],
            'model': cfg.get('model') or _DEFAULT_MODELS.get(provider) or ''}


def ready(ctx) -> bool:
    s = settings(ctx)
    if s['provider'] == 'custom':
        return bool(s['key'] and s['base_url'] and s['model'])
    return bool(s['key'] and s['provider'] in _DEFAULT_MODELS)


def describe(ctx) -> Dict[str, Any]:
    """What /api/config tells the app (no keys)."""
    if not ready(ctx):
        return {'available': False}
    s = settings(ctx)
    return {'available': True, 'vision': vision_capable(s['provider'], s['model'])}


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def _data_url(url: str):
    head, _, data = (url or '').partition(',')
    mime = head[5:].split(';')[0] if head.startswith('data:') else 'image/jpeg'
    return mime or 'image/jpeg', data


# ── OpenAI-compatible (OpenAI, DeepSeek, any custom service such as Ollama) ──

def _openai_messages(system, messages):
    out = [{'role': 'system', 'content': system}] if system else []
    for m in messages:
        role = m.get('role')
        if role == 'user':
            images = m.get('images') or []
            if images:
                out.append({'role': 'user', 'content': [{'type': 'text', 'text': m.get('content') or ''}] +
                            [{'type': 'image_url', 'image_url': {'url': u}} for u in images]})
            else:
                out.append({'role': 'user', 'content': m.get('content') or ''})
        elif role == 'assistant':
            raw = m.get('raw')
            out.append(raw if isinstance(raw, dict) and raw.get('role') == 'assistant'
                       else {'role': 'assistant', 'content': m.get('content') or ''})
        elif role == 'tool':
            out.append({'role': 'tool', 'tool_call_id': m.get('id'), 'content': _json(m.get('result'))})
    return out


def _openai_step(s, system, messages, tools, final):
    if not _openai_available:
        raise ValueError("The server needs the 'openai' Python package for this provider.")
    from services.agent import make_agent_client, resolve_agent_model
    p = s['provider']
    client = make_agent_client(p, s['key'] if p == 'openai' else None, s['key'] if p == 'deepseek' else None,
                               s['key'] if p == 'custom' else None, s['base_url'])
    if client is None:
        raise ValueError('The server AI is not set up.')
    params = {'model': resolve_agent_model(client, s['model']), 'messages': _openai_messages(system, messages)}
    if tools and not final:
        params['tools'] = [{'type': 'function', 'function': t} for t in tools]
        if openai_reasoning(params['model']):
            params['reasoning_effort'] = 'none'   # Chat Completions tools need it on reasoning models
    msg = client.chat.completions.create(**params).choices[0].message
    calls, raw_calls = [], []
    for tc in (getattr(msg, 'tool_calls', None) or []):
        try:
            args = json.loads(tc.function.arguments or '{}')
        except (TypeError, ValueError):
            args = {}
        calls.append({'id': tc.id, 'name': tc.function.name, 'args': args if isinstance(args, dict) else {}})
        raw_calls.append({'id': tc.id, 'type': 'function',
                          'function': {'name': tc.function.name, 'arguments': tc.function.arguments or '{}'}})
    raw = {'role': 'assistant', 'content': msg.content or ''}
    if raw_calls:
        raw['tool_calls'] = raw_calls
    reasoning = getattr(msg, 'reasoning_content', None)
    if reasoning:
        raw['reasoning_content'] = reasoning
    return {'text': msg.content or '', 'calls': calls, 'raw': raw}


# ── Gemini (REST, like the app) ──

def _gemini_schema(schema):
    if isinstance(schema, list):
        return [_gemini_schema(s) for s in schema]
    if not isinstance(schema, dict):
        return schema
    out = {}
    for k, v in schema.items():
        if k == 'type' and isinstance(v, str):
            out[k] = v.upper()
        elif k in ('properties',):
            out[k] = {name: _gemini_schema(sub) for name, sub in v.items()}
        elif k == 'items':
            out[k] = _gemini_schema(v)
        elif k in ('description', 'enum', 'required', 'format', 'nullable'):
            out[k] = v
    return out


def _gemini_step(s, system, messages, tools, final):
    contents = []
    for m in messages:
        role = m.get('role')
        if role == 'user':
            parts = [{'text': m.get('content') or ' '}]
            for u in m.get('images') or []:
                mime, data = _data_url(u)
                parts.append({'inlineData': {'mimeType': mime, 'data': data}})
            contents.append({'role': 'user', 'parts': parts})
        elif role == 'assistant':
            raw = m.get('raw')
            contents.append(raw if isinstance(raw, dict) and raw.get('parts')
                            else {'role': 'model', 'parts': [{'text': m.get('content') or ' '}]})
        elif role == 'tool':
            result = m.get('result')
            response = {'name': m.get('name'), 'response': result if isinstance(result, dict) else {'result': result}}
            if m.get('id') and not str(m.get('id')).startswith('gem_'):
                response['id'] = m.get('id')
            part = {'functionResponse': response}
            if contents and contents[-1]['role'] == 'user' and 'functionResponse' in contents[-1]['parts'][0]:
                contents[-1]['parts'].append(part)
            else:
                contents.append({'role': 'user', 'parts': [part]})
    body: Dict[str, Any] = {'contents': contents}
    if system:
        body['systemInstruction'] = {'parts': [{'text': system}]}
    if tools:
        body['tools'] = [{'functionDeclarations': [{'name': t['name'], 'description': t.get('description', ''),
                                                    'parameters': _gemini_schema(t.get('parameters') or {})} for t in tools]}]
        if final:
            body['toolConfig'] = {'functionCallingConfig': {'mode': 'NONE'}}
    r = requests.post(_GEMINI + s['model'] + ':generateContent', params={'key': s['key']}, json=body, timeout=120)
    data = r.json() if r.content else {}
    if not r.ok:
        message = (data.get('error') or {}).get('message') if isinstance(data, dict) else None
        raise ValueError(f'Gemini error ({r.status_code}): {message or r.text[:200]}')
    content = ((data.get('candidates') or [{}])[0] or {}).get('content') or {'role': 'model', 'parts': []}
    content.setdefault('role', 'model')
    text, calls = '', []
    for part in content.get('parts') or []:
        if part.get('functionCall'):
            fc = part['functionCall']
            calls.append({'id': fc.get('id') or 'gem_' + uuid.uuid4().hex[:8], 'name': fc.get('name'), 'args': fc.get('args') or {}})
        elif part.get('text') and not part.get('thought'):
            text += part['text']
    return {'text': text, 'calls': calls, 'raw': content if content.get('parts') else None}


def step(ctx, payload: Dict[str, Any]) -> Dict[str, Any]:
    s = settings(ctx)
    if not ready(ctx):
        raise ValueError("This server has no AI set up. Add a provider and key in the server's Settings.")
    system = str(payload.get('system') or '')
    messages = [m for m in (payload.get('messages') or []) if isinstance(m, dict)]
    tools = [t for t in (payload.get('tools') or []) if isinstance(t, dict) and t.get('name')]
    final = bool(payload.get('final'))
    if not vision_capable(s['provider'], s['model']):
        for m in messages:
            m.pop('images', None)
    if s['provider'] == 'anthropic':
        return claude_llm.tool_step(s['key'], s['model'], system, messages, tools, final)
    if s['provider'] == 'gemini':
        return _gemini_step(s, system, messages, tools, final)
    return _openai_step(s, system, messages, tools, final)

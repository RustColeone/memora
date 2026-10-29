import uuid
from datetime import datetime

try:
    from openai import OpenAI  # type: ignore
    _openai_available = True
except Exception:
    OpenAI = None  # type: ignore
    _openai_available = False

try:
    import google.generativeai as genai  # type: ignore
    _gemini_available = True
except Exception:
    genai = None  # type: ignore
    _gemini_available = False


def _sanitize_visible_ids(raw_visible_ids):
    if not isinstance(raw_visible_ids, list):
        return []
    return [str(item) for item in raw_visible_ids if isinstance(item, (str, int))]


def _build_entries_summary(all_entries, visible_ids, variant):
    visible_id_set = set(visible_ids)
    subset = [entry for entry in all_entries if str(entry.get('id')) in visible_id_set]
    subset = subset[: min(len(subset), 60)]

    lines = []
    for entry in subset:
        desc = (entry.get('description') or '').replace('\n', ' ')[:160]
        tags = ','.join(entry.get('tags') or [])
        category = entry.get('category') or 'Uncategorized'

        if variant == 'finance':
            lines.append(
                f"ID={entry.get('id')} | date={entry.get('purchaseDate') or ''} | category={category} | "
                f"price={entry.get('price')} tax={entry.get('tax')} adj={entry.get('adjustment')} total={entry.get('total')} | "
                f"tags={tags} | desc='{desc}'"
            )
        else:
            lines.append(
                f"ID={entry.get('id')} | date={entry.get('createdAt')} | ts={entry.get('ts')} | "
                f"category={category} | tags={tags} | desc='{desc}'"
            )

    return '\n'.join(lines)


def generate_llm_reply(history_messages, latest_user_text: str, provider: str, model: str, system_prompt: str, openai_api_key: str, gemini_api_key: str, deepseek_api_key: str = None, max_output_tokens: int = None,
                       anthropic_api_key: str = None, custom_api_key: str = None, custom_base_url: str = None):
    if not provider:
        return '(AI disabled: Set LLM_PROVIDER=openai, gemini, or deepseek and API key env vars to enable.)'

    try:
        if provider == 'openai':
            if not _openai_available:
                return '(OpenAI SDK unavailable on server)'
            if not openai_api_key:
                return '(Missing OPENAI_API_KEY)'
            client = OpenAI(api_key=openai_api_key)
            model_name = model or 'gpt-6-luna'
            msgs = []
            if system_prompt:
                msgs.append({'role': 'system', 'content': system_prompt})
            for msg in history_messages:
                role = msg.get('role')
                if role in ('user', 'assistant', 'system'):
                    msgs.append({'role': role, 'content': msg.get('content', '')[:4000]})
            from services.llm import openai_sampling
            kwargs = dict({'model': model_name, 'messages': msgs}, **openai_sampling(model_name, 0.7, max_output_tokens))
            response = client.chat.completions.create(**kwargs)
            return (response.choices[0].message.content or '').strip()

        if provider == 'gemini':
            if not _gemini_available:
                return '(Gemini SDK unavailable on server)'
            if not gemini_api_key:
                return '(Missing GEMINI_API_KEY)'
            genai.configure(api_key=gemini_api_key)
            model_name = model or 'gemini-3.8-flash'
            convo_lines = []
            if system_prompt:
                convo_lines.append(f'System: {system_prompt}')
            for msg in history_messages:
                role = msg.get('role')
                if role in ('user', 'assistant', 'system'):
                    convo_lines.append(f"{role.capitalize()}: {msg.get('content', '')}")
            convo_lines.append(f'User: {latest_user_text}')
            convo_lines.append('Assistant:')
            prompt = '\n'.join(convo_lines)[-12000:]
            model_obj = genai.GenerativeModel(model_name)
            generation_config = {'temperature': 0.7}
            if max_output_tokens:
                generation_config['max_output_tokens'] = max_output_tokens
            response = model_obj.generate_content(prompt, generation_config=generation_config)
            if hasattr(response, 'text') and response.text:
                return response.text.strip()
            return '(No response from Gemini)'

        if provider == 'deepseek':
            if not _openai_available:
                return '(OpenAI SDK unavailable on server)'
            if not deepseek_api_key:
                return '(Missing DEEPSEEK_API_KEY)'
            client = OpenAI(api_key=deepseek_api_key, base_url='https://api.deepseek.com')
            model_name = model or 'deepseek-flash'
            msgs = []
            if system_prompt:
                msgs.append({'role': 'system', 'content': system_prompt})
            for msg in history_messages:
                role = msg.get('role')
                if role in ('user', 'assistant', 'system'):
                    msgs.append({'role': role, 'content': msg.get('content', '')[:4000]})
            if latest_user_text and (not msgs or msgs[-1].get('content') != latest_user_text or msgs[-1].get('role') != 'user'):
                msgs.append({'role': 'user', 'content': latest_user_text[:4000]})
            kwargs = {'model': model_name, 'messages': msgs, 'temperature': 0.7}
            if max_output_tokens:
                kwargs['max_tokens'] = max_output_tokens
            response = client.chat.completions.create(**kwargs)
            return (response.choices[0].message.content or '').strip()

        if provider == 'anthropic':
            # Claude has its own module (official SDK). Output caps are left to
            # it: thinking is on by default and a small cap would cut it off.
            from services import claude_llm
            turns = [{'role': m.get('role'), 'content': str(m.get('content', ''))[:4000]}
                     for m in history_messages if m.get('role') in ('user', 'assistant')]
            if latest_user_text and (not turns or turns[-1]['role'] != 'user' or turns[-1]['content'] != latest_user_text):
                turns.append({'role': 'user', 'content': latest_user_text[:4000]})
            extra = [m.get('content', '') for m in history_messages if m.get('role') == 'system']
            system = '\n\n'.join([p for p in [system_prompt] + extra if p])
            return claude_llm.complete(anthropic_api_key, model, system, turns).strip()

        if provider == 'custom':
            if not _openai_available:
                return '(OpenAI SDK unavailable on server)'
            if not custom_api_key or not custom_base_url:
                return '(Custom AI provider needs an address and an API key)'
            client = OpenAI(api_key=custom_api_key, base_url=custom_base_url)
            msgs = []
            if system_prompt:
                msgs.append({'role': 'system', 'content': system_prompt})
            for msg in history_messages:
                if msg.get('role') in ('user', 'assistant', 'system'):
                    msgs.append({'role': msg.get('role'), 'content': msg.get('content', '')[:4000]})
            if latest_user_text and (not msgs or msgs[-1].get('content') != latest_user_text or msgs[-1].get('role') != 'user'):
                msgs.append({'role': 'user', 'content': latest_user_text[:4000]})
            kwargs = {'model': model, 'messages': msgs}
            if max_output_tokens:
                kwargs['max_tokens'] = max_output_tokens
            response = client.chat.completions.create(**kwargs)
            return (response.choices[0].message.content or '').strip()

        return f"(Unsupported LLM_PROVIDER '{provider}')"
    except Exception as exc:
        return f"(LLM error: {exc.__class__.__name__}: {exc})"


def handle_chat_send(payload, variant, get_chat_for_variant, save_chat_for_variant, get_memos_for_variant, provider, model, system_prompt, openai_key, gemini_key, deepseek_key, max_messages, provider_keys=None):
    user_text = (payload.get('message') or '').strip()
    visible_ids = _sanitize_visible_ids(payload.get('visibleIds') or [])
    # contextEntries: full entry objects sent by the frontend context picker
    context_entries = payload.get('contextEntries') or []
    if not isinstance(context_entries, list):
        context_entries = []

    if not user_text:
        return {'message': 'Empty message'}, 400

    history = get_chat_for_variant(variant)
    now = datetime.utcnow().isoformat() + 'Z'
    user_msg = {'id': str(uuid.uuid4()), 'role': 'user', 'content': user_text, 'ts': now}
    history.append(user_msg)

    context_messages = history[-max_messages:]

    # Build entries context: prefer explicit contextEntries, fall back to visibleIds
    entries_summary = ''
    if context_entries:
        try:
            # context_entries are full objects sent from the frontend
            lines = []
            for entry in context_entries[:60]:
                desc = (entry.get('description') or '').replace('\n', ' ')[:160]
                tags = ','.join(entry.get('tags') or [])
                category = entry.get('category') or 'Uncategorized'
                if variant == 'finance':
                    lines.append(
                        f"ID={entry.get('id')} | date={entry.get('purchaseDate') or ''} | "
                        f"category={category} | price={entry.get('price')} "
                        f"tax={entry.get('tax')} adj={entry.get('adjustment')} "
                        f"total={entry.get('total')} | tags={tags} | desc='{desc}'"
                    )
                else:
                    lines.append(
                        f"ID={entry.get('id')} | date={entry.get('createdAt')} | "
                        f"ts={entry.get('ts')} | category={category} | "
                        f"tags={tags} | desc='{desc}'"
                    )
            entries_summary = '\n'.join(lines)
        except Exception as exc:
            entries_summary = f'(Could not build context entries summary: {exc})'
    elif visible_ids:
        try:
            all_entries = get_memos_for_variant(variant)
            entries_summary = _build_entries_summary(all_entries, visible_ids, variant)
        except Exception as exc:
            entries_summary = f'(Could not build entries summary: {exc})'

    if entries_summary:
        count = len(entries_summary.splitlines())
        synthetic_context = {
            'role': 'system',
            'content': f"User-selected context entries (count={count}):\n{entries_summary}",
        }
        context_messages = [synthetic_context] + context_messages

    assistant_reply = generate_llm_reply(
        context_messages,
        user_text,
        provider=provider,
        model=model,
        system_prompt=system_prompt,
        openai_api_key=openai_key,
        gemini_api_key=gemini_key,
        deepseek_api_key=deepseek_key,
        **(provider_keys or {}),
    )

    bot_msg = {
        'id': str(uuid.uuid4()),
        'role': 'assistant',
        'content': assistant_reply,
        'ts': datetime.utcnow().isoformat() + 'Z',
    }
    history.append(bot_msg)
    save_chat_for_variant(history, variant)
    return {'messages': [user_msg, bot_msg]}, 200

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


def generate_llm_reply(history_messages, latest_user_text: str, provider: str, model: str, system_prompt: str, openai_api_key: str, gemini_api_key: str):
    if not provider:
        return '(AI disabled: Set LLM_PROVIDER=openai or gemini and API key env vars to enable.)'

    try:
        if provider == 'openai':
            if not _openai_available:
                return '(OpenAI SDK unavailable on server)'
            if not openai_api_key:
                return '(Missing OPENAI_API_KEY)'
            client = OpenAI(api_key=openai_api_key)
            model_name = model or 'gpt-4o-mini'
            msgs = []
            if system_prompt:
                msgs.append({'role': 'system', 'content': system_prompt})
            for msg in history_messages:
                role = msg.get('role')
                if role in ('user', 'assistant', 'system'):
                    msgs.append({'role': role, 'content': msg.get('content', '')[:4000]})
            response = client.chat.completions.create(model=model_name, messages=msgs, temperature=0.7)
            return (response.choices[0].message.content or '').strip()

        if provider == 'gemini':
            if not _gemini_available:
                return '(Gemini SDK unavailable on server)'
            if not gemini_api_key:
                return '(Missing GEMINI_API_KEY)'
            genai.configure(api_key=gemini_api_key)
            model_name = model or 'gemini-2.5-flash-lite'
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
            response = model_obj.generate_content(prompt)
            if hasattr(response, 'text') and response.text:
                return response.text.strip()
            return '(No response from Gemini)'

        return f"(Unsupported LLM_PROVIDER '{provider}')"
    except Exception as exc:
        return f"(LLM error: {exc.__class__.__name__}: {exc})"


def handle_chat_send(payload, variant, get_chat_for_variant, save_chat_for_variant, get_memos_for_variant, provider, model, system_prompt, openai_key, gemini_key, max_messages):
    user_text = (payload.get('message') or '').strip()
    visible_ids = _sanitize_visible_ids(payload.get('visibleIds') or [])

    if not user_text:
        return {'message': 'Empty message'}, 400

    history = get_chat_for_variant(variant)
    now = datetime.utcnow().isoformat() + 'Z'
    user_msg = {'id': str(uuid.uuid4()), 'role': 'user', 'content': user_text, 'ts': now}
    history.append(user_msg)

    context_messages = history[-max_messages:]

    if visible_ids:
        entries_summary = ''
        try:
            all_entries = get_memos_for_variant(variant)
            entries_summary = _build_entries_summary(all_entries, visible_ids, variant)
        except Exception as exc:
            entries_summary = f'(Could not build entries summary: {exc})'

        if entries_summary:
            synthetic_context = {
                'role': 'system',
                'content': f"Visible filtered entries (count={len(entries_summary.splitlines())}):\n{entries_summary}",
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

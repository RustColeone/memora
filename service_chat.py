import os
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

from service_llm import create_llm_service


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


def generate_entry_from_files(file_urls, user_message, variant, base_dir, llm_provider):
    try:
        llm = create_llm_service(provider=llm_provider)
        file_paths = [url.lstrip('/') for url in file_urls]
        result = llm.analyze_files_for_entry(
            file_paths=file_paths,
            user_message=user_message,
            variant=variant,
            base_dir=base_dir,
        )
        return result
    except Exception:
        return {
            'description': 'File processing completed (AI analysis failed)',
            'category': 'Uncategorized',
            'tags': ['ai-error'],
            'price': 0,
            'total': 0,
        }


def handle_chat_send(payload, variant, get_chat_for_variant, save_chat_for_variant, get_memos_for_variant, provider, model, system_prompt, openai_key, gemini_key, max_messages):
    user_text = (payload.get('message') or '').strip()
    visible_ids = payload.get('visibleIds') or []
    if isinstance(visible_ids, list):
        visible_ids = [str(i) for i in visible_ids if isinstance(i, (str, int))]
    else:
        visible_ids = []

    if not user_text:
        return {'message': 'Empty message'}, 400

    history = get_chat_for_variant(variant)
    now = datetime.utcnow().isoformat() + 'Z'
    user_msg = {'id': str(uuid.uuid4()), 'role': 'user', 'content': user_text, 'ts': now}
    history.append(user_msg)

    ctx = history[-max_messages:]

    entries_summary = ''
    if visible_ids:
        try:
            all_entries = get_memos_for_variant(variant)
            subset = [entry for entry in all_entries if str(entry.get('id')) in set(visible_ids)]
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
            entries_summary = '\n'.join(lines)
        except Exception as exc:
            entries_summary = f'(Could not build entries summary: {exc})'

    if entries_summary:
        synthetic_context = {'role': 'system', 'content': f"Visible filtered entries (count={len(entries_summary.splitlines())}):\n" + entries_summary}
        ctx = [synthetic_context] + ctx

    assistant_reply = generate_llm_reply(
        ctx,
        user_text,
        provider=provider,
        model=model,
        system_prompt=system_prompt,
        openai_api_key=openai_key,
        gemini_api_key=gemini_key,
    )

    bot_msg = {'id': str(uuid.uuid4()), 'role': 'assistant', 'content': assistant_reply, 'ts': datetime.utcnow().isoformat() + 'Z'}
    history.append(bot_msg)
    save_chat_for_variant(history, variant)
    return {'messages': [user_msg, bot_msg]}, 200


def handle_chat_create_entry(files, user_message, variant, upload_folder, base_dir, llm_provider, get_memos_for_variant, save_memos_for_variant, append_operation, get_chat_for_variant, save_chat_for_variant):
    if not files:
        return {'error': 'No files provided'}, 400

    file_urls = []
    for file_obj in files:
        if file_obj and file_obj.filename:
            from werkzeug.utils import secure_filename

            filename = secure_filename(file_obj.filename)
            date_folder = datetime.now().strftime('%Y-%m-%d')
            date_path = os.path.join(upload_folder, date_folder)
            os.makedirs(date_path, exist_ok=True)

            unique_name = f"{uuid.uuid4().hex[:8]}_{filename}"
            file_path = os.path.join(date_path, unique_name)
            file_obj.save(file_path)
            file_urls.append(f'/uploads/{date_folder}/{unique_name}')

    entry_data = generate_entry_from_files(file_urls, user_message, variant, base_dir, llm_provider)
    entry_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat() + 'Z'

    new_entry = {
        'id': entry_id,
        'description': f"[AI Generated] {entry_data.get('description', 'Entry from uploaded file')}",
        'category': entry_data.get('category', 'Uncategorized'),
        'tags': entry_data.get('tags', []),
        'images': file_urls if any(url.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.webp')) for url in file_urls) else [],
        'attachments': [{'url': url, 'name': url.split('/')[-1]} for url in file_urls if not url.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.webp'))],
        'ts': int(datetime.utcnow().timestamp() * 1000),
        'createdAt': now,
        'updatedAt': now,
    }

    if variant == 'finance':
        new_entry['purchaseDate'] = entry_data.get('purchaseDate', datetime.now().strftime('%Y-%m-%d'))
        new_entry['price'] = entry_data.get('price', 0)
        new_entry['tax'] = entry_data.get('tax', 0)
        new_entry['adjustment'] = entry_data.get('adjustment', 0)
        new_entry['total'] = entry_data.get('total', 0)

    memos = get_memos_for_variant(variant)
    memos.append(new_entry)
    save_memos_for_variant(memos, variant)

    append_operation({'type': 'create', 'entryId': entry_id, 'data': new_entry}, variant)

    history = get_chat_for_variant(variant)
    user_msg = {
        'id': str(uuid.uuid4()),
        'role': 'user',
        'content': user_message or 'Creating entry from files...',
        'ts': now,
        'files': file_urls,
    }
    assistant_msg = {
        'id': str(uuid.uuid4()),
        'role': 'assistant',
        'content': f"✓ Created entry: {new_entry['description']}\n\nCategory: {new_entry['category']}\nTags: {', '.join(new_entry['tags']) if new_entry['tags'] else 'None'}",
        'ts': datetime.utcnow().isoformat() + 'Z',
        'entryId': entry_id,
    }

    history.append(user_msg)
    history.append(assistant_msg)
    save_chat_for_variant(history, variant)

    return {'entry': new_entry, 'messages': [user_msg, assistant_msg]}, 200

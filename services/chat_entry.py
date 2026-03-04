import os
import uuid
from datetime import datetime

from werkzeug.utils import secure_filename

from services.llm import create_llm_service

IMAGE_EXTENSIONS = ('.png', '.jpg', '.jpeg', '.gif', '.webp')


def _save_uploaded_files(files, upload_folder):
    file_urls = []

    for file_obj in files:
        if not file_obj or not file_obj.filename:
            continue

        filename = secure_filename(file_obj.filename)
        date_folder = datetime.now().strftime('%Y-%m-%d')
        date_path = os.path.join(upload_folder, date_folder)
        os.makedirs(date_path, exist_ok=True)

        unique_name = f'{uuid.uuid4().hex[:8]}_{filename}'
        file_path = os.path.join(date_path, unique_name)
        file_obj.save(file_path)
        file_urls.append(f'/uploads/{date_folder}/{unique_name}')

    return file_urls


def generate_entry_from_files(file_urls, user_message, variant, base_dir, llm_provider):
    try:
        llm = create_llm_service(provider=llm_provider)
        file_paths = [url.lstrip('/') for url in file_urls]
        return llm.analyze_files_for_entry(
            file_paths=file_paths,
            user_message=user_message,
            variant=variant,
            base_dir=base_dir,
        )
    except Exception:
        return {
            'description': 'File processing completed (AI analysis failed)',
            'category': 'Uncategorized',
            'tags': ['ai-error'],
            'price': 0,
            'total': 0,
        }


def _build_generated_entry(entry_data, file_urls, variant):
    entry_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat() + 'Z'

    new_entry = {
        'id': entry_id,
        'description': f"[AI Generated] {entry_data.get('description', 'Entry from uploaded file')}",
        'category': entry_data.get('category', 'Uncategorized'),
        'tags': entry_data.get('tags', []),
        'images': [url for url in file_urls if url.lower().endswith(IMAGE_EXTENSIONS)],
        'attachments': [
            {'url': url, 'name': url.split('/')[-1]}
            for url in file_urls
            if not url.lower().endswith(IMAGE_EXTENSIONS)
        ],
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

    return new_entry, entry_id, now


def _build_chat_messages(user_message, file_urls, new_entry, entry_id, now):
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
        'content': (
            f"✓ Created entry: {new_entry['description']}\n\n"
            f"Category: {new_entry['category']}\n"
            f"Tags: {', '.join(new_entry['tags']) if new_entry['tags'] else 'None'}"
        ),
        'ts': datetime.utcnow().isoformat() + 'Z',
        'entryId': entry_id,
    }
    return user_msg, assistant_msg


def handle_chat_create_entry(files, user_message, variant, upload_folder, base_dir, llm_provider, get_memos_for_variant, save_memos_for_variant, append_operation, get_chat_for_variant, save_chat_for_variant):
    if not files:
        return {'error': 'No files provided'}, 400

    file_urls = _save_uploaded_files(files, upload_folder)

    entry_data = generate_entry_from_files(file_urls, user_message, variant, base_dir, llm_provider)
    new_entry, entry_id, now = _build_generated_entry(entry_data, file_urls, variant)

    memos = get_memos_for_variant(variant)
    memos.append(new_entry)
    save_memos_for_variant(memos, variant)

    append_operation({'type': 'create', 'entryId': entry_id, 'data': new_entry}, variant)

    history = get_chat_for_variant(variant)
    user_msg, assistant_msg = _build_chat_messages(user_message, file_urls, new_entry, entry_id, now)

    history.append(user_msg)
    history.append(assistant_msg)
    save_chat_for_variant(history, variant)

    return {'entry': new_entry, 'messages': [user_msg, assistant_msg]}, 200

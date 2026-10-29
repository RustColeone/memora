import uuid
from datetime import datetime, timedelta


def _now_iso():
    return datetime.utcnow().isoformat() + 'Z'


class MemosService:
    """Server-side CRUD for single entries.

    Each call reads and writes only the entry it touches through the entry
    store (one SQLite row per entry), instead of loading and re-saving every
    entry; that full rewrite took seconds per save at tens of thousands of
    entries. `image_in_use(url, exclude_id)` answers "does any other entry
    still show this image?" in SQL.
    """

    def handle_get_all_memos(self, variant, get_memos_for_variant):
        return get_memos_for_variant(variant), 200

    def handle_create_memo(self, payload, variant, store):
        new_memo = dict(payload or {})
        new_memo['id'] = new_memo.get('id') or str(uuid.uuid4())
        new_memo['createdAt'] = new_memo.get('createdAt') or _now_iso()
        new_memo.setdefault('updatedAt', new_memo['createdAt'])
        store.upsert(new_memo, variant)
        return new_memo, 201

    def handle_update_memo(self, memo_id, updated_data, variant, store, image_in_use, delete_upload_url):
        memo = store.get_one(memo_id, variant)
        if memo is None:
            return {'message': 'Memo not found'}, 404
        if isinstance(updated_data.get('images'), list):
            removed = set(memo.get('images') or []) - set(updated_data['images'])
            for url in removed:
                if not image_in_use(url, memo_id):
                    delete_upload_url(url)
        memo.update(updated_data)
        memo['id'] = memo_id
        memo['updatedAt'] = _now_iso()
        store.upsert(memo, variant)
        return memo, 200

    def handle_delete_memo(self, memo_id, permanent, variant, store, image_in_use, delete_upload_url):
        memo = store.get_one(memo_id, variant)
        if memo is None:
            return {'message': 'Memo not found'}, 404
        if permanent:
            for image_url in memo.get('images') or []:
                if not image_in_use(image_url, memo_id):
                    delete_upload_url(image_url)
            store.hard_delete(memo_id, variant)
            return {'message': 'Memo permanently deleted'}, 200
        now = datetime.utcnow()
        memo['deletedAt'] = now.isoformat() + 'Z'
        memo['deletedBy'] = 'server'
        memo['permanentDeleteAt'] = (now + timedelta(days=30)).isoformat() + 'Z'
        memo['updatedAt'] = now.isoformat() + 'Z'
        store.upsert(memo, variant)
        return memo, 200

    def handle_restore_memo(self, memo_id, variant, store):
        memo = store.get_one(memo_id, variant)
        if memo is None:
            return {'message': 'Memo not found'}, 404
        memo['deletedAt'] = None
        memo['deletedBy'] = None
        memo['permanentDeleteAt'] = None
        memo['updatedAt'] = _now_iso()
        store.upsert(memo, variant)
        return memo, 200

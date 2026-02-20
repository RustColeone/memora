import uuid
from datetime import datetime, timedelta


class ServiceMemos:
    def handle_get_all_memos(self, variant, get_memos_for_variant):
        return get_memos_for_variant(variant), 200

    def handle_create_memo(self, payload, variant, get_memos_for_variant, save_memos_for_variant):
        new_memo = payload or {}
        memos = get_memos_for_variant(variant)

        new_memo['id'] = new_memo.get('id') or str(uuid.uuid4())
        new_memo['createdAt'] = new_memo.get('createdAt') or datetime.utcnow().isoformat() + 'Z'
        new_memo.setdefault('updatedAt', new_memo['createdAt'])

        memos.append(new_memo)
        save_memos_for_variant(memos, variant)
        return new_memo, 201

    def handle_update_memo(self, memo_id, updated_data, variant, get_memos_for_variant, save_memos_for_variant, delete_upload_url):
        memos = get_memos_for_variant(variant)

        for idx, memo in enumerate(memos):
            if str(memo.get('id')) == str(memo_id):
                old_images = set(memo.get('images') or [])
                if 'images' in updated_data and isinstance(updated_data['images'], list):
                    new_images = set(updated_data['images'])
                    removed = old_images - new_images
                    for url in removed:
                        still_used_elsewhere = any(
                            url in (m.get('images') or [])
                            for m in memos
                            if str(m.get('id')) != str(memo_id)
                        )
                        if not still_used_elsewhere:
                            other_variant = 'default' if variant == 'finance' else 'finance'
                            other_memos = get_memos_for_variant(other_variant)
                            still_used_elsewhere = any(url in (m.get('images') or []) for m in other_memos)
                        if not still_used_elsewhere:
                            delete_upload_url(url)

                memo.update(updated_data)
                memo['id'] = memo_id
                memo['updatedAt'] = datetime.utcnow().isoformat() + 'Z'
                memos[idx] = memo
                save_memos_for_variant(memos, variant)
                return memo, 200

        return {'message': 'Memo not found'}, 404

    def handle_delete_memo(self, memo_id, permanent, variant, get_memos_for_variant, save_memos_for_variant, delete_upload_url):
        memos = get_memos_for_variant(variant)
        memo_to_delete = None

        for memo in memos:
            if str(memo.get('id')) == str(memo_id):
                memo_to_delete = memo
                break

        if not memo_to_delete:
            return {'message': 'Memo not found'}, 404

        if permanent:
            if 'images' in memo_to_delete and memo_to_delete['images']:
                for image_url in memo_to_delete['images']:
                    other_variant = 'default' if variant == 'finance' else 'finance'
                    other_memos = get_memos_for_variant(other_variant)
                    still_used_elsewhere = any(
                        image_url in (m.get('images') or [])
                        for m in other_memos
                    )
                    if not still_used_elsewhere:
                        delete_upload_url(image_url)

            new_memos = [m for m in memos if str(m.get('id')) != str(memo_id)]
            save_memos_for_variant(new_memos, variant)
            return {'message': 'Memo permanently deleted'}, 200

        memo_to_delete['deletedAt'] = datetime.utcnow().isoformat() + 'Z'
        memo_to_delete['deletedBy'] = 'server'
        memo_to_delete['permanentDeleteAt'] = (datetime.utcnow() + timedelta(days=30)).isoformat() + 'Z'
        memo_to_delete['updatedAt'] = datetime.utcnow().isoformat() + 'Z'

        save_memos_for_variant(memos, variant)
        return memo_to_delete, 200

    def handle_restore_memo(self, memo_id, variant, get_memos_for_variant, save_memos_for_variant):
        memos = get_memos_for_variant(variant)
        memo = None
        for item in memos:
            if str(item.get('id')) == str(memo_id):
                memo = item
                break

        if not memo:
            return {'message': 'Memo not found'}, 404

        memo['deletedAt'] = None
        memo['deletedBy'] = None
        memo['permanentDeleteAt'] = None
        memo['updatedAt'] = datetime.utcnow().isoformat() + 'Z'

        save_memos_for_variant(memos, variant)
        return memo, 200

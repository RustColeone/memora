"""Keep restored records, snapshots and already acknowledged retries coherent."""
import sqlite3

from services.db import Database
from services.doc_store import DocStore
from services.memo_store import MemoStore
from services.operations import OperationsService
from services.operations_store import OperationsStore

VARIANTS = ('default', 'finance', 'planner', 'vault', 'contacts', 'messages')


def sync_floors(db):
    store = OperationsStore(db)
    return {variant: max(store.max_op_id(variant), store.get_snapshot(variant)['snapshotId'])
            for variant in VARIANTS}


def reseat_restored_records(db, floors):
    service = OperationsService(OperationsStore(db))
    memos = MemoStore(db)
    docs = {'planner': DocStore(db, 'planner_entries'), 'vault': DocStore(db, 'vault_entries'),
            'contacts': DocStore(db, 'ai_contacts'), 'messages': DocStore(db, 'ai_messages')}
    for variant in VARIANTS:
        entries = docs[variant].get_all(variant) if variant in docs else memos.get_all(variant)
        service.reseat_snapshot_from_entries(entries, variant, floors[variant])


def restore_raw_database(db, path):
    # Reject unrelated SQLite files before schema migration can make them look
    # like an empty Memora backup.
    source = sqlite3.connect(path)
    try:
        tables = {row[0] for row in source.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {'memos', 'finance_entries', 'schema_version'} <= tables:
            raise ValueError('This is not a Memora database backup')
        if any(row[0] != 'ok' for row in source.execute('PRAGMA quick_check')):
            raise ValueError('Backup database integrity check failed')
    except sqlite3.DatabaseError as error:
        raise ValueError('Invalid database backup') from error
    finally:
        source.close()
    staged = Database(path)
    try:
        floors = sync_floors(db)
        # A restored older log must never replay a request the live server had
        # already acknowledged. Receipts survive both restore and compaction.
        with staged.conn():
            staged.executemany('INSERT OR IGNORE INTO operation_receipts VALUES (?,?,?)',
                [list(row) for row in db.fetchall('SELECT variant,client_op_id,op_id FROM operation_receipts')])
            reseat_restored_records(staged, floors)
        db.restore_from(staged)
    finally:
        staged.close()

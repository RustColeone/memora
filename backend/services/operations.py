import time
from datetime import datetime
from contextlib import nullcontext


class OperationsService:
    """Append-only sync log + snapshot/compaction logic.

    Persistence is delegated entirely to an :class:`OperationsStore`
    (SQLite-backed); this class holds only the event-sourcing logic.
    """

    def __init__(self, store):
        self.store = store

    def get_operations_for_variant(self, variant: str):
        return self.store.get_operations(variant)

    def save_operations_for_variant(self, operations, variant: str):
        self.store.replace_operations(operations, variant)

    def append_operation(self, operation, variant: str):
        # op_id assignment + insert are atomic inside the store.
        return self.store.append_operation(operation, variant)

    def get_operations_since(self, since_op_id, variant: str, limit=None):
        return self.store.get_operations_since(since_op_id, variant, limit)

    def get_snapshot_for_variant(self, variant: str):
        return self.store.get_snapshot(variant)

    def save_snapshot_for_variant(self, snapshot, variant: str):
        self.store.save_snapshot(snapshot, variant)

    def rebuild_state_from_operations(self, variant: str, up_to_op_id=None):
        snapshot = self.get_snapshot_for_variant(variant)
        operations = self.get_operations_for_variant(variant)

        entries = {entry['id']: entry for entry in snapshot.get('entries', [])}

        for op in operations:
            op_id = op.get('opId', 0)
            if up_to_op_id and op_id > up_to_op_id:
                break
            if op_id <= snapshot.get('snapshotId', 0):
                continue

            op_type = op.get('type')
            entry_id = op.get('entryId')

            if op_type == 'create':
                entries[entry_id] = op.get('data', {})
                entries[entry_id]['id'] = entry_id
            elif op_type == 'update':
                if entry_id in entries:
                    if 'data' in op:
                        entries[entry_id].update(op['data'])
                    elif 'field' in op and 'value' in op:
                        entries[entry_id][op['field']] = op['value']
            elif op_type == 'delete':
                if entry_id in entries:
                    entries[entry_id]['deletedAt'] = datetime.utcfromtimestamp(op['timestamp'] / 1000).isoformat() + 'Z'
                    entries[entry_id]['deletedBy'] = op.get('deviceId', 'unknown')
            elif op_type == 'addImage':
                if entry_id in entries:
                    if 'images' not in entries[entry_id]:
                        entries[entry_id]['images'] = []
                    entries[entry_id]['images'].append(op.get('url'))
            elif op_type == 'addAttachment':
                if entry_id in entries:
                    if 'attachments' not in entries[entry_id]:
                        entries[entry_id]['attachments'] = []
                    entries[entry_id]['attachments'].append(op.get('attachment'))

        return list(entries.values())

    def handle_push_operations(self, payload, variant: str, apply_op=None):
        """Commit each acknowledgement, log entry and materialized row together.

        *apply_op* returns (verdict, entry). Only 'applied' ops enter the log.
        A 'stale' op (older than the entry's last change) is acknowledged with
        the server's current entry so the device can adopt it; a 'missing' op
        (for an entry the server does not have) is reported in `rejected`
        instead of being acknowledged as if it had been saved.
        """
        assigned, failures, rejected = [], [], []
        owner = getattr(apply_op, '__self__', None)
        lock = getattr(owner, 'lock', None)
        for client_op in payload.get('operations', []):
            if client_op.get('type') not in ('create', 'update', 'delete', 'addImage', 'addAttachment') or not client_op.get('entryId'):
                failures.append({'clientOpId': client_op.get('clientOpId'), 'error': 'Invalid operation'})
                continue
            try:
                # Match CRUD's lock order: context, then database. Nested stores
                # join the outer transaction via savepoints on the same connection.
                with lock if lock is not None else nullcontext():
                    with self.store._db.conn():
                        client_id = client_op.get('clientOpId')
                        existing = self.store.find_by_client_op_id(client_id, variant) if client_id else None
                        if existing:
                            # A committed duplicate must not replay an old create
                            # over a later edit or append an attachment twice.
                            assigned.append({'clientOpId': client_id, 'serverOpId': existing['opId'], 'duplicate': True})
                            continue
                        operation = {key: client_op.get(key) for key in
                                     ('type', 'entryId', 'deviceId', 'clientOpId', 'data', 'field', 'value', 'url', 'attachment')}
                        operation['timestamp'] = client_op.get('timestamp') or int(time.time() * 1000)
                        verdict, current = (apply_op(operation, variant) or ('applied', None)) if apply_op is not None else ('applied', None)
                        if verdict == 'stale':
                            assigned.append({'clientOpId': client_id, 'serverOpId': None, 'duplicate': False,
                                             'stale': True, 'entry': current})
                            continue
                        if verdict == 'missing':
                            rejected.append({'clientOpId': client_id, 'entryId': operation['entryId'], 'reason': 'not_found'})
                            continue
                        op_id = self.append_operation(operation, variant)
                    assigned.append({'clientOpId': client_id, 'serverOpId': op_id, 'duplicate': False})
            except Exception as exc:
                failures.append({'clientOpId': client_op.get('clientOpId'), 'entryId': client_op.get('entryId'), 'error': str(exc)})
        return {'success': not failures, 'operations': assigned, 'failures': failures, 'rejected': rejected,
                'serverTime': int(time.time() * 1000)}, 500 if failures else 200

    def handle_pull_operations(self, since_op_id: int, variant: str, limit=None, snapshot_offset=0, snapshot_id=None):
        """Return the operations after *since_op_id*, or a snapshot when the
        device needs a full sync.

        With *limit*, the response is paged so years of data never arrive as
        one huge response: a full sync returns the snapshot `limit` entries at
        a time (`snapshotNextOffset` until done), then operations `limit` at a
        time (`hasMore`). A device pages the snapshot with the `snapshotId` it
        started from; if compaction replaced the snapshot meanwhile it gets
        `snapshotChanged` and starts over. Without *limit* (older app
        versions) everything comes in one response, as before.
        """
        with self.store._db.conn():
            snapshot = None
            if limit:
                limit = max(1, min(int(limit), 10000))
                snapshot_id_now = self.store.get_snapshot_id(variant)
            else:
                snapshot = self.get_snapshot_for_variant(variant)
                snapshot_id_now = snapshot.get('snapshotId', 0)

            # sinceOpId=0 is the normal "never synced" baseline for a brand-new client and
            # must NOT force a full sync by itself — with a fresh snapshotId of 0 that's a
            # legitimate first-time incremental pull (replaying the whole op log builds the
            # same state as a snapshot would). A client healing drift instead sends an
            # explicit negative sinceOpId to REQUEST a full-sync replace (rather than merge
            # ops onto its stale existing entries, which could leave orphans the server no
            # longer has). See memo-operation-queue.js's one-time reconcile.
            full_sync = since_op_id < 0 or since_op_id < snapshot_id_now
            if full_sync and not limit:
                operations = self.get_operations_since(snapshot_id_now, variant)
                return {
                    'needsFullSync': True,
                    'snapshot': snapshot,
                    'operations': operations,
                    'serverTime': int(time.time() * 1000),
                }, 200

            if full_sync:
                if snapshot_id is not None and int(snapshot_id) != snapshot_id_now:
                    return {'needsFullSync': True, 'snapshotChanged': True, 'operations': [],
                            'serverTime': int(time.time() * 1000)}, 200
                page = self.store.get_snapshot_page(variant, snapshot_offset, limit)
                next_offset = snapshot_offset + len(page['entries'])
                done = next_offset >= page['total']
                operations = self.get_operations_since(snapshot_id_now, variant, limit) if done else []
                return {
                    'needsFullSync': True,
                    'snapshot': {'snapshotId': snapshot_id_now, 'timestamp': page['timestamp'], 'entries': page['entries']},
                    'snapshotTotal': page['total'],
                    'snapshotNextOffset': None if done else next_offset,
                    'operations': operations,
                    'latestOpId': operations[-1]['opId'] if operations else snapshot_id_now,
                    'hasMore': done and len(operations) == limit,
                    'serverTime': int(time.time() * 1000),
                }, 200

            operations = self.get_operations_since(since_op_id, variant, limit)
            return {
                'needsFullSync': False,
                'operations': operations,
                'latestOpId': operations[-1]['opId'] if operations else since_op_id,
                'hasMore': bool(limit) and len(operations) == limit,
                'serverTime': int(time.time() * 1000),
            }, 200

    def reseat_snapshot_from_entries(self, entries, variant: str, minimum_op_id=0):
        result = self._reseat_snapshot_from_entries(entries, variant, minimum_op_id)
        self.store._db.reclaim_space()
        return result

    def _reseat_snapshot_from_entries(self, entries, variant: str, minimum_op_id=0):
        with self.store._db.conn():
            """Make *entries* the authoritative baseline and rebuild the log from it.

            Used to reconcile historical drift where the entry table (served by
            GET /api/memos) and the operation log (served by pull) disagreed. Writes
            a fresh snapshot holding exactly *entries* and clears the superseded ops.

            The new snapshotId is set one above the previous high-water mark
            (max existing opId or old snapshotId) so every current client — whose
            lastServerOpId can be at most that mark — sees `lastServerOpId <
            snapshotId` on its next pull and performs a full-sync *replace*,
            converging on this baseline without needing any client-side reset.
            """
            snapshot = self.get_snapshot_for_variant(variant)
            old_snapshot_id = snapshot.get('snapshotId', 0)
            max_op = self.store.max_op_id(variant)
            new_snapshot_id = max(max_op, old_snapshot_id, minimum_op_id) + 1

            self.save_snapshot_for_variant({
                'snapshotId': new_snapshot_id,
                'timestamp': int(time.time() * 1000),
                'entries': list(entries),
            }, variant)
            self.save_operations_for_variant([], variant)

            return {
                'variant': variant,
                'entries': len(entries),
                'oldSnapshotId': old_snapshot_id,
                'maxOpId': max_op,
                'newSnapshotId': new_snapshot_id,
            }

    def handle_compact_operations(self, payload, variant: str):
        result, status = self._compact_operations(payload, variant)
        if status == 200 and result.get('compactedCount'):
            # The deleted ops and the rewritten snapshot leave free pages behind.
            result['spaceReclaimed'] = self.store._db.reclaim_space()
        return result, status

    def _compact_operations(self, payload, variant: str):
        with self.store._db.conn():
            keep_days = payload.get('keepDays', 30)
            if isinstance(keep_days, bool) or not isinstance(keep_days, (int, float)) or not 0 <= keep_days <= 36500:
                return {'success': False, 'message': 'keepDays must be between 0 and 36500'}, 400
            cutoff_timestamp = int((time.time() - (keep_days * 24 * 60 * 60)) * 1000)

            operations = self.get_operations_for_variant(variant)
            ops_before_cutoff = [op for op in operations if op.get('timestamp', 0) < cutoff_timestamp]

            if not ops_before_cutoff:
                return {'success': True, 'message': 'No operations to compact', 'compactedCount': 0}, 200

            last_op_before_cutoff = max(ops_before_cutoff, key=lambda op: op.get('opId', 0))
            snapshot_op_id = last_op_before_cutoff['opId']
            entries = self.rebuild_state_from_operations(variant, up_to_op_id=snapshot_op_id)

            snapshot = {
                'snapshotId': snapshot_op_id,
                'timestamp': last_op_before_cutoff['timestamp'],
                'entries': entries,
            }
            self.save_snapshot_for_variant(snapshot, variant)

            remaining_ops = [op for op in operations if op.get('opId', 0) > snapshot_op_id]
            self.store._db.execute('DELETE FROM operations WHERE variant=? AND op_id<=?', [variant, snapshot_op_id])

            compacted_count = len(operations) - len(remaining_ops)
            print(f"✂️ Compacted {compacted_count} operations into snapshot (opId: {snapshot_op_id})")

            return {
                'success': True,
                'message': f'Compacted {compacted_count} operations',
                'snapshotId': snapshot_op_id,
                'remainingOps': len(remaining_ops),
                'compactedCount': compacted_count,
            }, 200

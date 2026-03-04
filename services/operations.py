from datetime import datetime


class OperationsService:
    def __init__(self, lock, read_json, write_json, operations_file_for_variant, snapshot_file_for_variant):
        self.lock = lock
        self.read_json = read_json
        self.write_json = write_json
        self.operations_file_for_variant = operations_file_for_variant
        self.snapshot_file_for_variant = snapshot_file_for_variant

    def get_operations_for_variant(self, variant: str):
        path = self.operations_file_for_variant(variant)
        with self.lock:
            return self.read_json(path)

    def save_operations_for_variant(self, operations, variant: str):
        path = self.operations_file_for_variant(variant)
        with self.lock:
            self.write_json(path, operations)

    def append_operation(self, operation, variant: str):
        with self.lock:
            operations = self.get_operations_for_variant(variant)
            if 'opId' not in operation:
                max_id = 0
                for op in operations:
                    if isinstance(op.get('opId'), int):
                        max_id = max(max_id, op['opId'])
                operation['opId'] = max_id + 1

            if 'timestamp' not in operation:
                operation['timestamp'] = int(datetime.utcnow().timestamp() * 1000)

            operations.append(operation)
            self.save_operations_for_variant(operations, variant)
            return operation['opId']

    def get_operations_since(self, since_op_id, variant: str):
        operations = self.get_operations_for_variant(variant)
        return [op for op in operations if op.get('opId', 0) > since_op_id]

    def get_snapshot_for_variant(self, variant: str):
        path = self.snapshot_file_for_variant(variant)
        with self.lock:
            data = self.read_json(path)
            if not data or 'entries' not in data:
                return {'snapshotId': 0, 'timestamp': 0, 'entries': []}
            return data

    def save_snapshot_for_variant(self, snapshot, variant: str):
        path = self.snapshot_file_for_variant(variant)
        with self.lock:
            self.write_json(path, snapshot)

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

    def handle_push_operations(self, payload, variant: str, save_memos_for_variant):
        client_operations = payload.get('operations', [])
        if not client_operations:
            return {'success': True, 'operations': []}, 200

        assigned_ops = []
        for client_op in client_operations:
            if 'type' not in client_op or 'entryId' not in client_op:
                continue

            client_op_id = client_op.get('clientOpId')
            if client_op_id:
                existing_ops = self.get_operations_for_variant(variant)
                if any(op.get('clientOpId') == client_op_id for op in existing_ops):
                    existing_op = next(op for op in existing_ops if op.get('clientOpId') == client_op_id)
                    assigned_ops.append({'clientOpId': client_op_id, 'serverOpId': existing_op['opId'], 'duplicate': True})
                    continue

            operation = {
                'type': client_op['type'],
                'entryId': client_op['entryId'],
                'timestamp': client_op.get('timestamp', int(datetime.utcnow().timestamp() * 1000)),
                'deviceId': client_op.get('deviceId', 'unknown'),
                'clientOpId': client_op_id,
                'data': client_op.get('data'),
                'field': client_op.get('field'),
                'value': client_op.get('value'),
                'url': client_op.get('url'),
                'attachment': client_op.get('attachment'),
            }

            server_op_id = self.append_operation(operation, variant)
            assigned_ops.append({'clientOpId': client_op_id, 'serverOpId': server_op_id, 'duplicate': False})

        try:
            current_state = self.rebuild_state_from_operations(variant)
            save_memos_for_variant(current_state, variant)
        except Exception as exc:
            print(f"⚠️ Failed to update legacy memos.json: {exc}")

        return {
            'success': True,
            'operations': assigned_ops,
            'serverTime': int(datetime.utcnow().timestamp() * 1000),
        }, 200

    def handle_pull_operations(self, since_op_id: int, variant: str):
        snapshot = self.get_snapshot_for_variant(variant)
        snapshot_id = snapshot.get('snapshotId', 0)

        if since_op_id < snapshot_id:
            operations = self.get_operations_since(snapshot_id, variant)
            return {
                'needsFullSync': True,
                'snapshot': snapshot,
                'operations': operations,
                'serverTime': int(datetime.utcnow().timestamp() * 1000),
            }, 200

        operations = self.get_operations_since(since_op_id, variant)
        return {
            'needsFullSync': False,
            'operations': operations,
            'latestOpId': operations[-1]['opId'] if operations else since_op_id,
            'serverTime': int(datetime.utcnow().timestamp() * 1000),
        }, 200

    def handle_compact_operations(self, payload, variant: str):
        keep_days = payload.get('keepDays', 30)
        cutoff_timestamp = int((datetime.utcnow().timestamp() - (keep_days * 24 * 60 * 60)) * 1000)

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
        self.save_operations_for_variant(remaining_ops, variant)

        compacted_count = len(operations) - len(remaining_ops)
        print(f"✂️ Compacted {compacted_count} operations into snapshot (opId: {snapshot_op_id})")

        return {
            'success': True,
            'message': f'Compacted {compacted_count} operations',
            'snapshotId': snapshot_op_id,
            'remainingOps': len(remaining_ops),
            'compactedCount': compacted_count,
        }, 200

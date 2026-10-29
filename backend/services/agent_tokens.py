"""
services/agent_tokens.py — access tokens for outside agents.

An outside agent (say, one that collects receipts from a mailbox) gets its own
token instead of the sync password. Each token has a name and, per page, a
level:

    read     search and open items
    propose  read, and send changes as cards that wait for a tap in the app
    write    read, propose, and add items directly

Pages are notes, spending and plans; a page left out is off limits. Safe notes
are never shown to an agent. Tokens are stored as SHA-256 hashes only (the
token itself is shown once, when it is made) and can be revoked one by one.
"""

import hashlib
import hmac
import secrets
import time
from typing import Dict, List, Optional, Tuple

PAGES = ('notes', 'spending', 'plans')
LEVELS = ('read', 'propose', 'write')
VARIANT = {'notes': 'default', 'spending': 'finance', 'plans': 'planner'}
_KEY = 'agent_tokens'


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


def _now_ms() -> int:
    return int(time.time() * 1000)


def clean_scopes(scopes) -> Dict[str, str]:
    """{'notes': 'read', 'spending': 'propose'} with unknown pages/levels dropped."""
    out = {}
    for page, level in (scopes or {}).items():
        if page in PAGES and level in LEVELS:
            out[page] = level
    return out


class AgentTokens:
    def __init__(self, settings, lock):
        """settings: an object with get_setting(key) / save_setting(key, value)."""
        self._settings = settings
        self._lock = lock

    def _all(self) -> List[Dict]:
        return list(self._settings.get_setting(_KEY) or [])

    def _save(self, records: List[Dict]):
        self._settings.save_setting(_KEY, records)

    @staticmethod
    def public(record: Dict) -> Dict:
        return {k: v for k, v in record.items() if k != 'hash'}

    def create(self, name: str, scopes) -> Tuple[Dict, str]:
        name = str(name or '').strip()[:60]
        if not name:
            raise ValueError('An agent token needs a name.')
        scopes = clean_scopes(scopes)
        if not scopes:
            raise ValueError('Give the token at least one page: notes, spending or plans, each read, propose or write.')
        token = 'mk_' + secrets.token_urlsafe(32)
        record = {'id': secrets.token_hex(6), 'name': name, 'prefix': token[:10], 'hash': _hash(token), 'scopes': scopes,
                  'createdAt': _now_ms(), 'lastUsedAt': None, 'revoked': False}
        with self._lock:
            records = self._all()
            records.append(record)
            self._save(records)
        return self.public(record), token

    def list(self) -> List[Dict]:
        return [self.public(r) for r in self._all()]

    def revoke(self, token_id: str) -> bool:
        with self._lock:
            records = self._all()
            hit = False
            for r in records:
                if r.get('id') == token_id and not r.get('revoked'):
                    r['revoked'] = True
                    r['revokedAt'] = _now_ms()
                    hit = True
            if hit:
                self._save(records)
            return hit

    def check(self, token: Optional[str]) -> Optional[Dict]:
        """The live record for this token, or None."""
        if not token or not token.startswith('mk_'):
            return None
        digest = _hash(token)
        found = None
        for r in self._all():
            if hmac.compare_digest(str(r.get('hash', '')), digest):   # every record compared
                found = r
        if not found or found.get('revoked'):
            return None
        # Note when it was last used, at most once a minute.
        now = _now_ms()
        if not found.get('lastUsedAt') or now - found['lastUsedAt'] > 60000:
            with self._lock:
                records = self._all()
                for r in records:
                    if r.get('id') == found['id']:
                        r['lastUsedAt'] = now
                self._save(records)
        return self.public(found)

    @staticmethod
    def allows(record: Dict, page: str, level: str) -> bool:
        have = (record.get('scopes') or {}).get(page)
        return bool(have) and LEVELS.index(have) >= LEVELS.index(level)

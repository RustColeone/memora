"""Optional shared-password gate for the sync/API surface.

When a password is configured the server rejects any ``/api`` request that does
not present a matching ``X-Sync-Password`` header (``/api/config`` stays open so
clients can discover that a password is required). With no password configured
the server behaves exactly as before — fully open, for purely local use.

The password is read from (in priority order):
  1. the ``MEMO_SYNC_PASSWORD`` environment variable, or
  2. ``<data_dir>/sync_auth.json`` → ``{"password": "..."}`` (gitignored, never served).

This is authentication, not encryption: pair it with HTTPS so the password and
payloads are also private in transit. Data remains readable on the server, which
is what keeps server-side OCR / chat / AI / PDF working.
"""

import hashlib
import hmac
import json
import os
import time


class SyncAuth:
    def __init__(self, data_dir):
        self._password = self._load(data_dir)

    @staticmethod
    def _load(data_dir):
        env = os.environ.get('MEMO_SYNC_PASSWORD')
        if env:
            return env
        path = os.path.join(data_dir, 'sync_auth.json')
        try:
            with open(path, encoding='utf-8') as handle:
                data = json.load(handle)
            password = (data.get('password') or '').strip()
            return password or None
        except (OSError, ValueError):
            return None

    @property
    def required(self):
        return bool(self._password)

    def prove(self, challenge, server_id):
        """HMAC-SHA256 of "<challenge>:<server id>" keyed by the password.

        A client that already knows the password checks this before sending
        the password to a server it found at a new address, so a different
        device on the network cannot pose as this server. None when no
        password is set."""
        if not self.required:
            return None
        return hmac.new(str(self._password).encode('utf-8'), (str(challenge) + ':' + str(server_id)).encode('utf-8'), hashlib.sha256).hexdigest()

    def check(self, provided):
        """Constant-time comparison; True when no password is configured."""
        if not self.required:
            return True
        if not provided:
            return False
        return hmac.compare_digest(str(provided), str(self._password))

    # ── Short-lived upload tokens ──────────────────────────────────────────
    # <img> tags can't send the auth header, so image requests are authorised by
    # a signed, time-limited token (delivered as a same-origin cookie, or a ?t=
    # query param). The token is an HMAC of its own expiry under the password —
    # so only holders of the password can mint one, and it can't be forged.
    def _sign(self, exp):
        return hmac.new(str(self._password).encode('utf-8'),
                        str(exp).encode('utf-8'), hashlib.sha256).hexdigest()

    def make_upload_token(self, ttl_seconds=86400):
        if not self.required:
            return ''
        exp = int(time.time()) + int(ttl_seconds)
        return f'{exp}.{self._sign(exp)}'

    def verify_upload_token(self, token):
        if not self.required:
            return True
        if not token or '.' not in token:
            return False
        exp_str, sig = token.split('.', 1)
        try:
            exp = int(exp_str)
        except ValueError:
            return False
        if exp < int(time.time()):
            return False
        return hmac.compare_digest(sig, self._sign(exp))

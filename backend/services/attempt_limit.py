"""
services/attempt_limit.py — slow down password and token guessing.

Each address may present a wrong sync password or agent token at most
MAX_FAILS times per WINDOW seconds; after that it gets 429 until its oldest
failure in the window ages out (at most WINDOW seconds). A correct
credential clears the count. Behind a reverse proxy every client shares the
proxy's address, so a guesser there slows everyone down instead — the safer
side to fail on.
"""

import threading
import time
from collections import deque

MAX_FAILS = 10
WINDOW = 60.0


class AttemptLimiter:
    def __init__(self, max_fails: int = MAX_FAILS, window: float = WINDOW):
        self.max_fails = max_fails
        self.window = window
        self._fails = {}
        self._lock = threading.Lock()

    def _recent(self, key, now):
        q = self._fails.get(key)
        if q is None:
            return None
        while q and now - q[0] > self.window:
            q.popleft()
        if not q:
            self._fails.pop(key, None)
            return None
        return q

    def retry_after(self, key) -> int:
        """Seconds until this address may try again; 0 when it may now."""
        now = time.monotonic()
        with self._lock:
            q = self._recent(key, now)
            if not q or len(q) < self.max_fails:
                return 0
            return max(1, int(self.window - (now - q[0])) + 1)

    def fail(self, key):
        now = time.monotonic()
        with self._lock:
            self._recent(key, now)
            self._fails.setdefault(key, deque()).append(now)
            if len(self._fails) > 10000:   # bound memory: forget the oldest addresses
                for k in list(self._fails)[:1000]:
                    self._fails.pop(k, None)

    def success(self, key):
        with self._lock:
            self._fails.pop(key, None)

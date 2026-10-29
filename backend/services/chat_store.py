"""
services/chat_store.py — SQLite-backed chat message store.

Provides the same dict-based interface as the JSON chat files:
  {
      "prompt": "",
      "meta": {"finalized_days": [], "last_rollover_check_date": ""},
      "summaries": {"day": [], "week": [], "month": [], "quarter": [], "year": []},
      "messages": [...]
  }

Public interface:
  store.get_store(variant)          -> dict
  store.save_store(store, variant)  -> None
  store.get_messages(variant)       -> List[dict]
  store.append_message(msg, variant)-> None
"""

import json
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from services.db import Database


def _ms_to_iso(ms: Optional[int]) -> Optional[str]:
    if ms is None:
        return None
    try:
        return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"
    except (OSError, OverflowError, ValueError):
        return None


def _iso_to_ms(iso: Optional[str]) -> Optional[int]:
    if not iso:
        return None
    try:
        return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)
    except (ValueError, AttributeError):
        return None


def _j(obj) -> Optional[str]:
    if obj is None:
        return None
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _p(text: Optional[str]) -> Any:
    if text is None:
        return None
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None


class ChatStore:
    """
    Stores chat messages in the `chat_messages` table.
    Stores prompt/meta/summaries in the `settings` table under key
    'chat_meta_<variant>'.
    """

    def __init__(self, db: Database):
        self._db = db

    def _meta_key(self, variant: str) -> str:
        return f"chat_meta_{variant}"

    def _upsert_setting(self, key: str, value: Any):
        self._db.execute(
            "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [key, _j(value)],
        )

    def _read_setting(self, key: str) -> Any:
        row = self._db.fetchone("SELECT value FROM settings WHERE key=?", [key])
        return _p(row["value"]) if row else None

    # ------------------------------------------------------------------
    # Full store read / write (matches backend_context interface)
    # ------------------------------------------------------------------

    def get_store(self, variant: str) -> Dict:
        from services.chat_summary import empty_store as _empty
        base = _empty()
        meta_blob = self._read_setting(self._meta_key(variant)) or {}
        messages = self.get_messages(variant)
        base["prompt"] = meta_blob.get("prompt", "")
        base["meta"] = meta_blob.get("meta", base["meta"])
        base["summaries"] = meta_blob.get("summaries", base["summaries"])
        base["messages"] = messages
        return base

    def save_store(self, store: Dict, variant: str):
        messages = store.get("messages", [])
        self._save_messages(messages, variant)
        self._upsert_setting(self._meta_key(variant), {
            "prompt": store.get("prompt", ""),
            "meta": store.get("meta", {}),
            "summaries": store.get("summaries", {}),
        })

    # ------------------------------------------------------------------
    # Messages
    # ------------------------------------------------------------------

    def get_messages(self, variant: str) -> List[Dict]:
        rows = self._db.fetchall(
            "SELECT * FROM chat_messages WHERE variant=? ORDER BY created_at",
            [variant],
        )
        return [
            {
                "id": r["id"],
                "role": r["role"],
                "content": r["content"],
                "created_at": _ms_to_iso(r["created_at"]),
            }
            for r in rows
        ]

    def _save_messages(self, messages: List[Dict], variant: str):
        """Replace all messages for this variant."""
        self._db.execute("DELETE FROM chat_messages WHERE variant=?", [variant])
        if not messages:
            return
        rows = []
        for m in messages:
            created_at = _iso_to_ms(m.get("created_at")) or int(time.time() * 1000)
            rows.append((m["id"], variant, m.get("role", ""), m.get("content", ""), created_at))
        self._db.executemany(
            "INSERT OR REPLACE INTO chat_messages (id,variant,role,content,created_at) VALUES (?,?,?,?,?)",
            rows,
        )

    def append_message(self, message: Dict, variant: str):
        created_at = _iso_to_ms(message.get("created_at")) or int(time.time() * 1000)
        self._db.execute(
            "INSERT OR REPLACE INTO chat_messages (id,variant,role,content,created_at) VALUES (?,?,?,?,?)",
            [message["id"], variant, message.get("role", ""), message.get("content", ""), created_at],
        )

    # ------------------------------------------------------------------
    # LLM config helpers (stored in settings table)
    # ------------------------------------------------------------------

    def get_setting(self, key: str) -> Any:
        return self._read_setting(key)

    def save_setting(self, key: str, value: Any):
        self._upsert_setting(key, value)

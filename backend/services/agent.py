"""
services/agent.py — agentic personal-assistant layer for MemoSystem.

Turns the chat from a read-only Q&A into an assistant that can *act*: search,
read, create, update and delete entries via tool-calling.  Uses the OpenAI-
compatible function-calling API (DeepSeek / OpenAI).

Design:
  - MemoAgentTools: the tool implementations, bound to a BackendContext + variant.
    Each mutation goes through the same store + operation journal as the REST
    API, so agent actions sync exactly like user actions.
  - run_agent(client, ...): the provider-agnostic tool-calling loop.  The LLM
    client is injected, so the loop is unit-testable with a fake client (no
    network, no API key).
  - The Agent API (api/agent_routes.py) runs these tools in propose mode for
    outside agents with their own tokens; changes become cards in the app.
"""

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

try:
    from openai import OpenAI  # type: ignore
    _openai_available = True
except Exception:  # pragma: no cover
    OpenAI = None  # type: ignore
    _openai_available = False


# DeepSeek's fast, low-cost model (its current name; the older
# "deepseek-v4-flash" still routes to it). Overridable via the LLM config 'model'.
DEFAULT_AGENT_MODEL = "deepseek-flash"

# The assistant is one personal-assistant conversation spanning the whole DB, so
# its history is stored under a single shared key regardless of which page (memo,
# finance, planner) the user is chatting from.
ASSISTANT_CHAT_KEY = "assistant"

AGENT_SYSTEM_PROMPT = (
    "You are the user's personal assistant and search agent over their entire personal database. "
    "The database has three collections (a 'source'): "
    "'default' = notes/memos, 'finance' = purchases & receipts, "
    "'planner' = calendar items, todos, projects and habits. "
    "Treat them as one unified personal DB: search across all of them, and read, create, "
    "update or delete items in the right source using the provided tools. "
    "Prefer searching before answering questions about existing items. "
    "Search results are sorted most-recent-first and each carries a 'date' field; "
    "use that 'date' to answer questions about what is latest/recent/oldest — do NOT assume "
    "the first result you happen to see is the newest unless you have compared dates. "
    "When the user asks to record/log/add something, create it in the most fitting source "
    "(a task or reminder → planner as a todo; a purchase → finance; a general note → default). "
    "When they ask to change or remove something, find it first, then update or delete it. "
    "After acting, briefly confirm what you did. Be concise and helpful."
)


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


def _new_id() -> str:
    return "e_" + uuid.uuid4().hex[:18]


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

SOURCES = ("default", "finance", "planner")


class MemoAgentTools:
    """Cross-DB assistant tools bound to a BackendContext.

    The assistant operates over the whole personal database — memos (default),
    finance, and planner — via ctx._store_for_variant(source). Mutations route
    through the right store + ctx.journal_operation so agent actions persist and
    sync identically to user actions, in whichever source.
    """

    def __init__(self, ctx, default_source: str = "default", propose: bool = False, allowed=None):
        """propose=True: create/update/delete become cards (self.proposals) the
        person approves in the app; nothing is written. allowed(page, level)
        limits what an agent token may read ('read') or change ('propose')."""
        self.ctx = ctx
        self.default_source = default_source if default_source in SOURCES else "default"
        self.actions: List[Dict[str, Any]] = []
        self.propose = propose
        self.allowed = allowed
        self.proposals: List[Dict[str, Any]] = []

    _PAGE = {"default": "notes", "finance": "spending", "planner": "plans"}

    def _may(self, source: str, level: str) -> bool:
        return self.allowed is None or bool(self.allowed(self._PAGE[source], level))

    def _readable(self) -> List[str]:
        return [s for s in SOURCES if self._may(s, "read")]

    def _proposal(self, card: Dict[str, Any]) -> Dict[str, Any]:
        self.proposals.append(card)
        return {"proposed": "card %d" % len(self.proposals), "note": "Shown to the person as a card; nothing is saved until they tap it."}

    def _store(self, source: str):
        return self.ctx._store_for_variant(source)

    @staticmethod
    def _norm_source(source: Optional[str], fallback: str) -> str:
        s = (source or fallback or "default").strip().lower()
        if s in ("memo", "memos", "note", "notes", "default"):
            return "default"
        if s in ("finance", "purchase", "purchases", "receipt", "receipts"):
            return "finance"
        if s in ("planner", "calendar", "todo", "todos", "task", "tasks", "habit", "habits", "project", "projects", "event", "events"):
            return "planner"
        return s if s in SOURCES else "default"

    # ---- OpenAI-compatible tool schema --------------------------------
    def specs(self) -> List[Dict[str, Any]]:
        source = {"type": "string", "enum": self._readable() or list(SOURCES),
                  "description": "collection: 'default'=notes/memos, 'finance'=purchases, 'planner'=calendar/todos/projects/habits"}
        return [
            _fn("search_entries", "Search across the whole personal DB (memos, finance, planner). Each result is tagged with its source.", {
                "query": {"type": "string", "description": "free text to match"},
                "source": dict(source, description=source["description"] + " — omit to search all sources"),
                "limit": {"type": "integer", "description": "max results (default 20)"},
            }, required=[]),
            _fn("get_entry", "Fetch one item by id from a source.", {"id": {"type": "string"}, "source": source}, required=["id", "source"]),
            _fn("create_entry", "Create an item. For default/finance, 'text' is the description; for planner it's the todo/event title.", {
                "text": {"type": "string", "description": "note/description, or planner item title"},
                "source": source,
                "category": {"type": "string", "description": "default/finance only"},
                "tags": {"type": "array", "items": {"type": "string"}, "description": "default/finance only"},
                "kind": {"type": "string", "enum": ["todo", "event"], "description": "planner only (default todo)"},
                "due": {"type": "string", "description": "planner only, YYYY-MM-DD"},
            }, required=["text", "source"]),
            _fn("update_entry", "Update fields of an item by id.", {
                "id": {"type": "string"}, "source": source,
                "text": {"type": "string"}, "category": {"type": "string"},
                "tags": {"type": "array", "items": {"type": "string"}},
                "done": {"type": "boolean", "description": "planner todo completion"},
            }, required=["id", "source"]),
            _fn("delete_entry", "Soft-delete an item by id (recycle bin).", {"id": {"type": "string"}, "source": source}, required=["id", "source"]),
        ][:2 if self.allowed is not None and not any(self._may(s, "propose") for s in SOURCES) else 5]

    # ---- dispatch -----------------------------------------------------
    def call(self, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        fn = getattr(self, f"_tool_{name}", None)
        if not fn:
            return {"error": f"unknown tool '{name}'"}
        if not isinstance(args, dict):
            args = {}
        try:
            return fn(**args)
        except TypeError as exc:
            return {"error": f"bad arguments for {name}: {exc}"}
        except Exception as exc:  # pragma: no cover - defensive
            return {"error": f"{type(exc).__name__}: {exc}"}

    # ---- helpers ------------------------------------------------------
    @staticmethod
    def _entry_date(e: Dict[str, Any], source: str) -> str:
        """Best date string for recency ranking (lexicographically sortable).

        Both YYYY-MM-DD and full ISO timestamps sort correctly against each
        other because they share the leading YYYY-MM-DD prefix.
        """
        if source == "finance":
            return e.get("purchaseDate") or e.get("createdAt") or e.get("updatedAt") or ""
        if source == "planner":
            return e.get("due") or e.get("date") or e.get("createdAt") or e.get("updatedAt") or ""
        return e.get("createdAt") or e.get("updatedAt") or ""

    @classmethod
    def _brief(cls, e: Dict[str, Any], source: str) -> Dict[str, Any]:
        out: Dict[str, Any] = {"id": e.get("id"), "source": source}
        # A single 'date' field every result carries, so the model can reason
        # about latest/recent/oldest without guessing from result order.
        out["date"] = cls._entry_date(e, source)
        if source == "planner":
            out["kind"] = e.get("kind")
            out["text"] = e.get("title") or e.get("name") or e.get("description") or ""
            for k in ("due", "done", "priority"):
                if e.get(k) is not None:
                    out[k] = e.get(k)
        else:
            out["text"] = e.get("description") or ""
            if e.get("category"):
                out["category"] = e.get("category")
            if e.get("tags"):
                out["tags"] = e.get("tags")
            if source == "finance":
                for k in ("total", "price", "purchaseDate"):
                    if e.get(k) is not None:
                        out[k] = e.get(k)
        return out

    # ---- tool implementations -----------------------------------------
    def _tool_search_entries(self, query: str = "", source: Optional[str] = None, limit: int = 20) -> Dict[str, Any]:
        q = (query or "").lower()
        try:
            limit = int(limit)
        except (TypeError, ValueError):
            limit = 20
        sources = [self._norm_source(source, "")] if source else list(SOURCES)
        sources = [src for src in sources if self._may(src, "read")]
        if not sources:
            return {"error": "not allowed to read that source"}
        matches = []
        for src in sources:
            for e in self.ctx.get_memos_for_variant(src):
                if e.get("deletedAt") or (self.allowed is not None and e.get("safe")):
                    continue
                text = (e.get("description") or e.get("title") or e.get("name") or "")
                if q and q not in text.lower() and not any(q in str(t).lower() for t in (e.get("tags") or [])):
                    continue
                matches.append((self._entry_date(e, src), self._brief(e, src)))
        # Most-recent-first so "latest/recent" questions are answered correctly,
        # and truncation keeps the newest items rather than arbitrary store order.
        matches.sort(key=lambda m: m[0], reverse=True)
        out = [b for _, b in matches[:limit]]
        return {"count": len(out), "total_matches": len(matches), "entries": out}

    def _tool_get_entry(self, id: str, source: str) -> Dict[str, Any]:
        src = self._norm_source(source, self.default_source)
        if not self._may(src, "read"):
            return {"error": "not allowed to read that source"}
        e = self._store(src).get_one(id, src)
        if not e or (self.allowed is not None and e.get("safe")):
            return {"error": "not found"}
        return self._brief(e, src)

    def _tool_create_entry(self, text: str, source: str, category: Optional[str] = None,
                          tags: Optional[List[str]] = None, kind: Optional[str] = None,
                          due: Optional[str] = None) -> Dict[str, Any]:
        src = self._norm_source(source, self.default_source)
        if self.propose:
            if not self._may(src, "propose"):
                return {"error": "not allowed to change that source"}
            page = self._PAGE[src]
            if src == "planner":
                k = (kind or "todo").lower()
                item = {"kind": "todo", "title": text or ""} if k != "event" else {"kind": "event", "title": text or "", "date": due, "allDay": True, "start": "09:00", "end": "10:00", "description": ""}
                if k != "event" and due:
                    item["due"] = due
                if k == "event" and not due:
                    return {"error": "an event needs a date (due, YYYY-MM-DD)"}
            elif src == "finance":
                item = {"description": text or "", "category": category or "Uncategorized", "tags": tags or [], "total": 0, "tax": 0, "items": [], "purchaseDate": None}
            else:
                item = {"description": text or "", "category": category or "Uncategorized", "tags": tags or []}
            return self._proposal({"type": "create", "page": page, "items": [item]})
        eid = _new_id()
        if src == "planner":
            k = (kind or "todo").lower()
            entry = {"id": eid, "kind": k, "createdAt": _now_iso(), "updatedAt": _now_iso(), "title": text or ""}
            if k == "todo":
                entry.update({"done": False, "priority": "normal"})
                if due:
                    entry["due"] = due
            elif due:
                entry["date"] = due
        else:
            entry = {"id": eid, "description": text or "", "category": category or "Uncategorized",
                     "tags": tags or [], "images": [], "attachments": [],
                     "createdAt": _now_iso(), "updatedAt": _now_iso()}
        saved = self._store(src).upsert(entry, src)
        self.ctx.journal_operation("create", saved["id"], src, saved)
        self.actions.append({"type": "create", "id": saved["id"], "source": src})
        return {"created": self._brief(saved, src)}

    def _tool_update_entry(self, id: str, source: str, text: Optional[str] = None,
                          category: Optional[str] = None, tags: Optional[List[str]] = None,
                          done: Optional[bool] = None) -> Dict[str, Any]:
        src = self._norm_source(source, self.default_source)
        if self.propose:
            if not self._may(src, "propose"):
                return {"error": "not allowed to change that source"}
            current = self._store(src).get_one(id, src)
            if not current or current.get("deletedAt"):
                return {"error": "not found"}
            change: Dict[str, Any] = {}
            if text is not None:
                change["text"] = text
            if category is not None:
                change["category"] = category
            if done is not None:
                change["done"] = bool(done)
            if tags is not None:
                have = [str(t).lower() for t in (current.get("tags") or [])]
                want = [str(t) for t in tags]
                add = [t for t in want if t.lower() not in have]
                drop = [t for t in (current.get("tags") or []) if str(t).lower() not in [w.lower() for w in want]]
                if add:
                    change["addTags"] = add
                if drop:
                    change["removeTags"] = drop
            if not change:
                return {"error": "no fields to update"}
            return self._proposal({"type": "update", "page": self._PAGE[src], "ids": [id], "change": change})
        fields: Dict[str, Any] = {}
        if text is not None:
            fields["title" if src == "planner" else "description"] = text
        if category is not None:
            fields["category"] = category
        if tags is not None:
            fields["tags"] = tags
        if done is not None:
            fields["done"] = done
        if not fields:
            return {"error": "no fields to update"}
        updated = self._store(src).update_fields(id, fields, src)
        if not updated:
            return {"error": "not found"}
        self.ctx.journal_operation("update", id, src, fields)
        self.actions.append({"type": "update", "id": id, "source": src})
        return {"updated": self._brief(updated, src)}

    def _tool_delete_entry(self, id: str, source: str) -> Dict[str, Any]:
        src = self._norm_source(source, self.default_source)
        if self.propose:
            if not self._may(src, "propose"):
                return {"error": "not allowed to change that source"}
            current = self._store(src).get_one(id, src)
            if not current or current.get("deletedAt"):
                return {"error": "not found"}
            return self._proposal({"type": "delete", "page": self._PAGE[src], "ids": [id]})
        res = self._store(src).soft_delete(id, src)
        if not res:
            return {"error": "not found"}
        self.ctx.journal_operation("delete", id, src)
        self.actions.append({"type": "delete", "id": id, "source": src})
        return {"deleted": id, "source": src}


def _fn(name: str, description: str, properties: Dict[str, Any], required: List[str]) -> Dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": properties, "required": required},
        },
    }


# ---------------------------------------------------------------------------
# Agent loop (provider-agnostic; client is injected)
# ---------------------------------------------------------------------------

def run_agent(client, model: str, system_prompt: str, history_messages: List[Dict[str, Any]],
              user_text: str, tools: MemoAgentTools, max_iters: int = 6) -> Dict[str, Any]:
    """Run the tool-calling loop until the model returns a final text answer."""
    msgs: List[Dict[str, Any]] = []
    if system_prompt:
        msgs.append({"role": "system", "content": system_prompt})
    for m in (history_messages or []):
        if m.get("role") in ("user", "assistant"):
            content = (m.get("content") or "")[:4000]
            if content:
                msgs.append({"role": m["role"], "content": content})
    msgs.append({"role": "user", "content": user_text})

    tool_specs = tools.specs()
    final_text = ""
    for _ in range(max_iters):
        from services.llm import openai_reasoning
        extra = {'reasoning_effort': 'none'} if openai_reasoning(model) else {'temperature': 0.4}
        resp = client.chat.completions.create(model=model, messages=msgs, tools=tool_specs, **extra)
        choice = resp.choices[0].message
        tool_calls = getattr(choice, "tool_calls", None)
        if not tool_calls:
            final_text = (getattr(choice, "content", None) or "").strip()
            break
        msgs.append({
            "role": "assistant",
            "content": getattr(choice, "content", None) or "",
            "tool_calls": [
                {"id": tc.id, "type": "function",
                 "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                for tc in tool_calls
            ],
        })
        for tc in tool_calls:
            try:
                args = json.loads(tc.function.arguments or "{}")
            except (json.JSONDecodeError, TypeError):
                args = {}
            result = tools.call(tc.function.name, args)
            msgs.append({"role": "tool", "tool_call_id": tc.id,
                         "content": json.dumps(result, ensure_ascii=False)})
    return {"reply": final_text or "(no reply)", "actions": tools.actions}


# ---------------------------------------------------------------------------
# Endpoint glue
# ---------------------------------------------------------------------------

def make_agent_client(provider: str, openai_key: Optional[str], deepseek_key: Optional[str],
                      custom_key: Optional[str] = None, custom_base_url: Optional[str] = None):
    """Build an OpenAI-compatible client for the agent, or None if unavailable."""
    if not _openai_available:
        return None
    provider = (provider or "").lower()
    if provider == "deepseek" and deepseek_key:
        return OpenAI(api_key=deepseek_key, base_url="https://api.deepseek.com")
    if provider == "openai" and openai_key:
        return OpenAI(api_key=openai_key)
    if provider == "custom" and custom_key and custom_base_url:
        return OpenAI(api_key=custom_key, base_url=custom_base_url)
    return None


def _norm(s: str) -> str:
    return "".join(ch for ch in (s or "").lower() if ch.isalnum())


# Cache resolved model ids so we don't hit models.list() on every message.
_model_cache: Dict[str, str] = {}


def resolve_agent_model(client, requested: Optional[str]) -> str:
    """Resolve the actual model id to use by querying the provider's catalogue.

    Confirms `requested` exists via client.models.list(); if the exact id isn't
    present it matches case/punctuation-insensitively (e.g. 'DeepSeek-V4-Flash'
    -> 'deepseek-v4-flash'), then by closest substring, falling back to the
    requested string if the listing is unavailable.
    """
    requested = requested or DEFAULT_AGENT_MODEL
    cache_key = f"{getattr(getattr(client, 'base_url', ''), 'host', client.__class__.__name__)}:{requested}"
    if cache_key in _model_cache:
        return _model_cache[cache_key]

    resolved = requested
    try:
        listing = client.models.list()
        ids = [getattr(m, "id", m) for m in getattr(listing, "data", listing)]
        ids = [i for i in ids if isinstance(i, str)]
        if requested in ids:
            resolved = requested
        else:
            rn = _norm(requested)
            exact = next((i for i in ids if _norm(i) == rn), None)
            partial = next((i for i in ids if rn and (rn in _norm(i) or _norm(i) in rn)), None)
            resolved = exact or partial or (ids[0] if ids else requested)
    except Exception:
        resolved = requested

    _model_cache[cache_key] = resolved
    return resolved

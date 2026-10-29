"""
Automatic chat summarization service.

Chat store schema (for chat.json and chat_finance.json):
{
    "prompt": str,          # optional custom system-prompt prefix
    "meta": {
        "finalized_days": [...],           # YYYY-MM-DD days already finalised
        "last_rollover_check_date": str    # YYYY-MM-DD date when pipeline last ran
    },
    "summaries": {
        "day":     [...],   # rolling 14, each has "date" (YYYY-MM-DD)
        "week":    [...],   # rolling 8,  each has "week_key" (YYYY-WNN)
        "month":   [...],   # rolling 4,  each has "month_key" (YYYY-MM)
        "quarter": [...],   # rolling 5,  each has "quarter_key" (YYYY-QN)
        "year":    [...]    # unlimited,  each has "year_key" (YYYY)
    },
    "messages": [...]       # raw chat messages (unchanged format)
}

Rollup triggers (all calendar-time-based, not count-based):
  - Day:     created for any completed day (yesterday+) with activity
  - Week:    created when current ISO week >= that week + 2
  - Month:   created when current month > week's month
  - Quarter: created when current quarter > month's quarter
  - Year:    created when current year > quarter's year
"""

import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Callable, List, Optional
import logging

log = logging.getLogger('chat_summary')
if not log.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter('[%(asctime)s] %(levelname)s [%(name)s] %(message)s', datefmt='%H:%M:%S'))
    log.addHandler(_h)
log.setLevel(logging.DEBUG)

# ---------------------------------------------------------------------------
# Schema helpers
# ---------------------------------------------------------------------------

def empty_store() -> dict:
    return {
        "prompt": "",
        "meta": {
            "finalized_days": [],
            "last_rollover_check_date": "",
        },
        "summaries": {
            "day": [],
            "week": [],
            "month": [],
            "quarter": [],
            "year": [],
        },
        "messages": [],
    }


def migrate_legacy(data) -> dict:
    """Convert old array-only format (or partial dict) to the full store schema."""
    if isinstance(data, list):
        store = empty_store()
        store["messages"] = data
        return store
    if isinstance(data, dict):
        store = empty_store()
        store["prompt"] = data.get("prompt") or ""
        raw_meta = data.get("meta") or {}
        finalized_days = raw_meta.get("finalized_days")
        store["meta"]["finalized_days"] = finalized_days if isinstance(finalized_days, list) else []
        last_rollover = raw_meta.get("last_rollover_check_date")
        store["meta"]["last_rollover_check_date"] = last_rollover if isinstance(last_rollover, str) else ""
        raw = data.get("summaries") or {}
        for key in ("day", "week", "month", "quarter", "year"):
            v = raw.get(key)
            store["summaries"][key] = v if isinstance(v, list) else []
        msgs = data.get("messages")
        store["messages"] = msgs if isinstance(msgs, list) else []
        # Backfill finalized day metadata from any currently retained day summaries.
        existing_days = [s.get("date") for s in store["summaries"]["day"] if isinstance(s.get("date"), str)]
        merged_days = sorted({d for d in (store["meta"]["finalized_days"] + existing_days) if d})
        store["meta"]["finalized_days"] = merged_days
        return store
    return empty_store()


def _ensure_meta(store: dict) -> dict:
    meta = store.setdefault("meta", {})
    if not isinstance(meta, dict):
        meta = {}
        store["meta"] = meta
    finalized_days = meta.get("finalized_days")
    meta["finalized_days"] = finalized_days if isinstance(finalized_days, list) else []
    last_rollover = meta.get("last_rollover_check_date")
    meta["last_rollover_check_date"] = last_rollover if isinstance(last_rollover, str) else ""
    return meta


def should_run_rollover(store: dict, today: Optional[date] = None) -> bool:
    """Return True only when the calendar day has changed since the last run."""
    today = today or date.today()
    meta = _ensure_meta(store)
    today_str = today.isoformat()
    last_check = meta.get("last_rollover_check_date") or ""
    has_data = bool(store.get("messages") or any(store.get("summaries", {}).get(k) for k in ("day", "week", "month", "quarter", "year")))
    if not has_data:
        return False
    return last_check != today_str


# ---------------------------------------------------------------------------
# Calendar helpers
# ---------------------------------------------------------------------------

def _quarter(d: date) -> int:
    return (d.month - 1) // 3 + 1


def _week_key(d: date) -> str:
    iso_year, iso_week, _ = d.isocalendar()
    return f"{iso_year}-W{iso_week:02d}"


def _month_key(d: date) -> str:
    return f"{d.year}-{d.month:02d}"


def _quarter_key(d: date) -> str:
    return f"{d.year}-Q{_quarter(d)}"


def _year_key(d: date) -> str:
    return str(d.year)


def _week_start_of(iso_year: int, iso_week: int) -> date:
    """Return the Monday of the given ISO week."""
    # ISO week 1 contains Jan 4
    jan4 = date(iso_year, 1, 4)
    # weekday(): Mon=0 … Sun=6
    monday_of_week1 = jan4 - timedelta(days=jan4.weekday())
    return monday_of_week1 + timedelta(weeks=iso_week - 1)


def _abs_week(iso_year: int, iso_week: int) -> int:
    """Absolute week number for comparison (good for ~±20 years around now)."""
    return iso_year * 53 + iso_week


# ---------------------------------------------------------------------------
# Text formatting helpers for LLM input
# ---------------------------------------------------------------------------

def _fmt_messages(messages: list) -> str:
    lines = []
    for m in messages:
        role = (m.get("role") or "?").capitalize()
        content = (m.get("content") or "")[:400]
        ts = (m.get("ts") or "")[:10]
        lines.append(f"[{ts}] {role}: {content}")
    return "\n".join(lines) if lines else "(no messages)"


def _fmt_entries(entries: list, variant: str) -> str:
    lines = []
    for e in entries:
        desc = (e.get("description") or "")[:200]
        tags = ",".join(e.get("tags") or [])
        cat = e.get("category") or ""
        if variant == "finance":
            lines.append(
                f"[{e.get('purchaseDate', '')}] {cat} "
                f"${e.get('total', '')} {desc} tags={tags}"
            )
        else:
            created = (e.get("createdAt") or "")[:10]
            if not created:
                raw_ts = e.get("ts")
                if isinstance(raw_ts, (int, float)):
                    try:
                        created = datetime.utcfromtimestamp(raw_ts / 1000).date().isoformat()
                    except Exception:
                        created = ""
                elif isinstance(raw_ts, str):
                    created = raw_ts[:10]
            lines.append(f"[{created}] {cat} {desc} tags={tags}")
    return "\n".join(lines) if lines else "(no entries)"


# ---------------------------------------------------------------------------
# LLM summarization wrapper
# ---------------------------------------------------------------------------

def _call_llm(prompt: str, llm_fn: Optional[Callable], stage: str) -> str:
    """Call llm_fn(prompt, stage=...) -> str, or fall back to a truncation."""
    if llm_fn is None:
        log.debug('LLM fn is None – using truncated prompt as summary fallback (len=%d)', len(prompt))
        return prompt[:600] + ("\u2026" if len(prompt) > 600 else "")
    log.debug('Calling LLM – stage=%s prompt length=%d chars', stage, len(prompt))
    try:
        try:
            result = llm_fn(prompt, stage=stage)
        except TypeError:
            result = llm_fn(prompt)
        result = (result or '').strip() or prompt[:300]
        log.debug('LLM returned %d chars', len(result))
        return result
    except Exception as exc:
        log.warning('LLM call failed: %s: %s', exc.__class__.__name__, exc)
        return f'(summary unavailable: {exc.__class__.__name__}: {exc})'


# ---------------------------------------------------------------------------
# Entry lookup helpers
# ---------------------------------------------------------------------------

def _day_str_for_entry(entry: dict, variant: str) -> str:
    """Return YYYY-MM-DD for an entry's primary date."""
    if variant == "finance":
        return (entry.get("purchaseDate") or "")[:10]
    # Try ISO string first (createdAt is always a string)
    created = entry.get("createdAt") or ""
    if isinstance(created, str) and len(created) >= 10:
        return created[:10]
    # Fall back to ts, which may be an ISO string OR a ms-epoch integer
    raw = entry.get("ts")
    if raw is None:
        return ""
    if isinstance(raw, (int, float)):
        # JavaScript millisecond epoch → date
        try:
            return datetime.utcfromtimestamp(raw / 1000).date().isoformat()
        except Exception:
            return ""
    if isinstance(raw, str) and raw:
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).date().isoformat()
        except Exception:
            return raw[:10] if len(raw) >= 10 else ""
    return ""


def _entries_for_day(all_entries: list, day_str: str, variant: str) -> list:
    return [e for e in all_entries if _day_str_for_entry(e, variant) == day_str]


def _entry_date(entry: dict, variant: str) -> Optional[date]:
    day_str = _day_str_for_entry(entry, variant)
    if not day_str:
        return None
    try:
        return date.fromisoformat(day_str)
    except Exception:
        return None


def _entries_in_range(all_entries: list, start_day: date, end_day: date, variant: str) -> list:
    found = []
    for entry in all_entries:
        entry_day = _entry_date(entry, variant)
        if entry_day is None:
            continue
        if start_day <= entry_day <= end_day:
            found.append(entry)
    return found


def _month_bounds(month_key: str) -> tuple[date, date]:
    start = date.fromisoformat(month_key + '-01')
    if start.month == 12:
        next_month = date(start.year + 1, 1, 1)
    else:
        next_month = date(start.year, start.month + 1, 1)
    return start, next_month - timedelta(days=1)


def _quarter_bounds(quarter_key: str) -> tuple[date, date]:
    year = int(quarter_key[:4])
    quarter = int(quarter_key[-1])
    start_month = (quarter - 1) * 3 + 1
    start = date(year, start_month, 1)
    if quarter == 4:
        next_q = date(year + 1, 1, 1)
    else:
        next_q = date(year, start_month + 3, 1)
    return start, next_q - timedelta(days=1)


def _year_bounds(year_key: str) -> tuple[date, date]:
    year = int(year_key)
    return date(year, 1, 1), date(year, 12, 31)


def _msgs_for_day(messages: list, day_str: str) -> list:
    return [m for m in messages if (m.get("ts") or "")[:10] == day_str]


# ---------------------------------------------------------------------------
# Pass 1 – Day summaries
# ---------------------------------------------------------------------------

def _run_day_summaries(
    store: dict,
    all_entries: list,
    variant: str,
    llm_fn,
    today: date,
) -> bool:
    """
    Create a day summary for every past day that has activity but hasn't
    been summarized yet.  Keeps rolling 14 most-recent day summaries.
    Returns True if the store was modified.
    """
    changed = False
    meta = _ensure_meta(store)
    finalized_days = set(d for d in meta.get("finalized_days", []) if isinstance(d, str))
    existing = {s["date"] for s in store["summaries"]["day"]}
    today_str = today.isoformat()

    log.debug("Pass 1 (day) – existing=%d, finalized=%d, today=%s", len(existing), len(finalized_days), today)

    # Only summarize days where the user actually chatted.
    # Database entries are included as context in the prompt but do NOT
    # trigger day creation on their own (avoids burning tokens when the
    # user has entries but no chat history).
    activity_days: set = set()
    for m in store["messages"]:
        d = (m.get("ts") or "")[:10]
        if d:
            activity_days.add(d)

    log.debug("  activity_days found: %d  ->  %s", len(activity_days),
              sorted(activity_days)[-5:] if activity_days else "(none)")

    new_days = 0
    skipped_open_day = 0
    skipped_existing = 0
    skipped_finalized = 0
    for day_str in sorted(activity_days):
        if day_str >= today_str:
            skipped_open_day += 1
            continue          # current day is still open; finalize only after rollover
        if day_str in finalized_days:
            skipped_finalized += 1
            continue
        if day_str in existing:
            finalized_days.add(day_str)
            skipped_existing += 1
            continue          # already done

        day_msgs = _msgs_for_day(store["messages"], day_str)
        day_ents = _entries_for_day(all_entries, day_str, variant)
        log.info("  Creating day summary for %s  (msgs=%d, entries=%d)",
                 day_str, len(day_msgs), len(day_ents))
        prompt = (
            f"You are a summarization assistant. Concisely summarize the "
            f"user's activity on {day_str} based on their chat messages and "
            f"personal database entries. Be factual and brief (3–6 sentences "
            f"max).\n\n"
            f"Chat messages:\n{_fmt_messages(day_msgs)}\n\n"
            f"Entries/memos:\n{_fmt_entries(day_ents, variant)}"
        )
        store["summaries"]["day"].append({
            "id": str(uuid.uuid4()),
            "date": day_str,
            "summary": _call_llm(prompt, llm_fn, stage='day'),
            "created_at": datetime.utcnow().isoformat() + "Z",
        })
        finalized_days.add(day_str)
        new_days += 1
        changed = True

    merged_finalized = sorted(finalized_days)
    if merged_finalized != meta.get("finalized_days", []):
        meta["finalized_days"] = merged_finalized
        changed = True

    if finalized_days:
        kept_messages = [
            m for m in store.get("messages", [])
            if ((m.get("ts") or "")[:10] not in finalized_days)
        ]
        removed_count = len(store.get("messages", [])) - len(kept_messages)
        if removed_count > 0:
            store["messages"] = kept_messages
            log.debug("  Removed %d raw chat message(s) for finalized day(s)", removed_count)
            changed = True

    log.debug("  day pass done – new=%d, skipped_open_day=%d, skipped_existing=%d, skipped_finalized=%d",
              new_days, skipped_open_day, skipped_existing, skipped_finalized)

    # Sort and cap at 14
    store["summaries"]["day"].sort(key=lambda s: s["date"])
    before_cap = len(store["summaries"]["day"])
    if before_cap > 14:
        store["summaries"]["day"] = store["summaries"]["day"][-14:]
        log.info("  Day window capped: %d -> 14", before_cap)
        changed = True

    return changed


# ---------------------------------------------------------------------------
# Pass 2 – Week summaries
# ---------------------------------------------------------------------------

def _run_week_summaries(store: dict, all_entries: list, variant: str, llm_fn, today: date) -> bool:
    """
    When the current ISO week is at least 2 ahead of a day summary's week,
    roll up all day summaries from that week into a single week summary and
    remove those day entries.  Keeps rolling 8 most-recent week summaries.
    """
    changed = False
    today_iso = today.isocalendar()
    today_abs = _abs_week(today_iso[0], today_iso[1])
    existing_wk = {s["week_key"] for s in store["summaries"]["week"]}

    log.debug("Pass 2 (week) – today_abs=%d, existing_weeks=%d, day_summaries_in=%d",
              today_abs, len(existing_wk), len(store["summaries"]["day"]))

    # Group day summaries by ISO week
    by_week: dict[str, list] = defaultdict(list)
    for ds in store["summaries"]["day"]:
        d = date.fromisoformat(ds["date"])
        by_week[_week_key(d)].append(ds)

    days_to_remove: list = []

    for wk, day_sums in sorted(by_week.items()):
        sample = date.fromisoformat(day_sums[0]["date"])
        iso_y, iso_w, _ = sample.isocalendar()
        week_abs = _abs_week(iso_y, iso_w)
        gap = today_abs - week_abs

        if gap < 2:
            log.debug("  Week %s too recent (gap=%d weeks) – skipping", wk, gap)
            continue   # too recent – don't roll up yet

        if wk in existing_wk:
            log.debug("  Week %s already summarised – removing %d day(s)", wk, len(day_sums))
            days_to_remove.extend(day_sums)
            continue

        log.info("  Rolling up %d day(s) into week summary %s", len(day_sums), wk)
        combined = "\n\n".join(
            f"[{ds['date']}] {ds['summary']}"
            for ds in sorted(day_sums, key=lambda x: x["date"])
        )
        prompt = (
            f"Combine the following daily summaries for ISO week {wk} into "
            f"one concise but information-rich week summary. Include the actual "
            f"entries logged during the week as supporting context.\n\n"
            f"Daily summaries:\n{combined}\n\n"
            f"Entries/memos for the week:\n{{entries_block}}"
        )
        wk_start = _week_start_of(iso_y, iso_w)
        wk_end = wk_start + timedelta(days=6)
        period_entries = _entries_in_range(all_entries, wk_start, wk_end, variant)
        prompt = prompt.format(entries_block=_fmt_entries(period_entries, variant))
        store["summaries"]["week"].append({
            "id": str(uuid.uuid4()),
            "week_key": wk,
            "date_from": wk_start.isoformat(),
            "date_to": wk_end.isoformat(),
            "summary": _call_llm(prompt, llm_fn, stage='week'),
            "created_at": datetime.utcnow().isoformat() + "Z",
        })
        days_to_remove.extend(day_sums)
        changed = True

    if days_to_remove:
        remove_ids = {ds["id"] for ds in days_to_remove}
        store["summaries"]["day"] = [
            ds for ds in store["summaries"]["day"] if ds["id"] not in remove_ids
        ]
        log.debug("  Removed %d day summaries after week rollup", len(days_to_remove))
        changed = True

    store["summaries"]["week"].sort(key=lambda s: s["week_key"])
    before_cap = len(store["summaries"]["week"])
    if before_cap > 8:
        store["summaries"]["week"] = store["summaries"]["week"][-8:]
        log.info("  Week window capped: %d -> 8", before_cap)
        changed = True

    return changed


# ---------------------------------------------------------------------------
# Pass 3 – Month summaries
# ---------------------------------------------------------------------------

def _run_month_summaries(store: dict, all_entries: list, variant: str, llm_fn, today: date) -> bool:
    """
    When all week summaries for a month belong to a month that is before the
    current calendar month, roll them up into a month summary.
    Keeps rolling 4 most-recent month summaries.
    """
    changed = False
    today_mk = _month_key(today)
    existing_mk = {s["month_key"] for s in store["summaries"]["month"]}

    log.debug("Pass 3 (month) – today_mk=%s, existing_months=%d, week_summaries_in=%d",
              today_mk, len(existing_mk), len(store["summaries"]["week"]))

    by_month: dict[str, list] = defaultdict(list)
    for ws in store["summaries"]["week"]:
        d = date.fromisoformat(ws["date_from"])
        by_month[_month_key(d)].append(ws)

    weeks_to_remove: list = []

    for mk, week_sums in sorted(by_month.items()):
        if mk >= today_mk:
            log.debug("  Month %s is current/future – skipping", mk)
            continue   # current or future month

        if mk in existing_mk:
            log.debug("  Month %s already summarised – removing %d week(s)", mk, len(week_sums))
            weeks_to_remove.extend(week_sums)
            continue

        log.info("  Rolling up %d week(s) into month summary %s", len(week_sums), mk)
        combined = "\n\n".join(
            f"[{ws['week_key']}] {ws['summary']}"
            for ws in sorted(week_sums, key=lambda x: x["week_key"])
        )
        month_start, month_end = _month_bounds(mk)
        period_entries = _entries_in_range(all_entries, month_start, month_end, variant)
        prompt = (
            f"Combine the following weekly summaries for {mk} into one "
            f"detailed month summary. Use the weekly summaries plus all entries "
            f"from the month as source material.\n\n"
            f"Weekly summaries:\n{combined}\n\n"
            f"Entries/memos for the month:\n{_fmt_entries(period_entries, variant)}"
        )
        store["summaries"]["month"].append({
            "id": str(uuid.uuid4()),
            "month_key": mk,
            "summary": _call_llm(prompt, llm_fn, stage='month'),
            "created_at": datetime.utcnow().isoformat() + "Z",
        })
        weeks_to_remove.extend(week_sums)
        changed = True

    if weeks_to_remove:
        remove_ids = {ws["id"] for ws in weeks_to_remove}
        store["summaries"]["week"] = [
            ws for ws in store["summaries"]["week"] if ws["id"] not in remove_ids
        ]
        log.debug("  Removed %d week summaries after month rollup", len(weeks_to_remove))
        changed = True

    store["summaries"]["month"].sort(key=lambda s: s["month_key"])
    before_cap = len(store["summaries"]["month"])
    if before_cap > 4:
        store["summaries"]["month"] = store["summaries"]["month"][-4:]
        log.info("  Month window capped: %d -> 4", before_cap)
        changed = True

    return changed


# ---------------------------------------------------------------------------
# Pass 4 – Quarter summaries
# ---------------------------------------------------------------------------

def _run_quarter_summaries(store: dict, all_entries: list, variant: str, llm_fn, today: date) -> bool:
    """
    When month summaries belong to a completed quarter, roll them up.
    Keeps rolling 5 most-recent quarter summaries.
    """
    changed = False
    today_qk = _quarter_key(today)
    existing_qk = {s["quarter_key"] for s in store["summaries"]["quarter"]}

    log.debug("Pass 4 (quarter) – today_qk=%s, existing_quarters=%d, month_summaries_in=%d",
              today_qk, len(existing_qk), len(store["summaries"]["month"]))

    by_quarter: dict[str, list] = defaultdict(list)
    for ms in store["summaries"]["month"]:
        d = date.fromisoformat(ms["month_key"] + "-01")
        by_quarter[_quarter_key(d)].append(ms)

    months_to_remove: list = []

    for qk, month_sums in sorted(by_quarter.items()):
        if qk >= today_qk:
            log.debug("  Quarter %s is current/future – skipping", qk)
            continue

        if qk in existing_qk:
            log.debug("  Quarter %s already summarised – removing %d month(s)", qk, len(month_sums))
            months_to_remove.extend(month_sums)
            continue

        log.info("  Rolling up %d month(s) into quarter summary %s", len(month_sums), qk)
        combined = "\n\n".join(
            f"[{ms['month_key']}] {ms['summary']}"
            for ms in sorted(month_sums, key=lambda x: x["month_key"])
        )
        quarter_start, quarter_end = _quarter_bounds(qk)
        period_entries = _entries_in_range(all_entries, quarter_start, quarter_end, variant)
        prompt = (
            f"Combine the following monthly summaries for {qk} into one "
            f"detailed quarter summary. Use the monthly summaries plus all entries "
            f"from the quarter as source material.\n\n"
            f"Monthly summaries:\n{combined}\n\n"
            f"Entries/memos for the quarter:\n{_fmt_entries(period_entries, variant)}"
        )
        store["summaries"]["quarter"].append({
            "id": str(uuid.uuid4()),
            "quarter_key": qk,
            "summary": _call_llm(prompt, llm_fn, stage='quarter'),
            "created_at": datetime.utcnow().isoformat() + "Z",
        })
        months_to_remove.extend(month_sums)
        changed = True

    if months_to_remove:
        remove_ids = {ms["id"] for ms in months_to_remove}
        store["summaries"]["month"] = [
            ms for ms in store["summaries"]["month"] if ms["id"] not in remove_ids
        ]
        log.debug("  Removed %d month summaries after quarter rollup", len(months_to_remove))
        changed = True

    store["summaries"]["quarter"].sort(key=lambda s: s["quarter_key"])
    before_cap = len(store["summaries"]["quarter"])
    if before_cap > 5:
        store["summaries"]["quarter"] = store["summaries"]["quarter"][-5:]
        log.info("  Quarter window capped: %d -> 5", before_cap)
        changed = True

    return changed


# ---------------------------------------------------------------------------
# Pass 5 – Year summaries
# ---------------------------------------------------------------------------

def _run_year_summaries(store: dict, all_entries: list, variant: str, llm_fn, today: date) -> bool:
    """
    When quarter summaries belong to a completed year, roll them up.
    Retained indefinitely.
    """
    changed = False
    today_yk = _year_key(today)
    existing_yk = {s["year_key"] for s in store["summaries"]["year"]}

    log.debug("Pass 5 (year) – today_yk=%s, existing_years=%d, quarter_summaries_in=%d",
              today_yk, len(existing_yk), len(store["summaries"]["quarter"]))

    by_year: dict[str, list] = defaultdict(list)
    for qs in store["summaries"]["quarter"]:
        yk = qs["quarter_key"][:4]
        by_year[yk].append(qs)

    quarters_to_remove: list = []

    for yk, quarter_sums in sorted(by_year.items()):
        if yk >= today_yk:
            log.debug("  Year %s is current/future – skipping", yk)
            continue

        if yk in existing_yk:
            log.debug("  Year %s already summarised – removing %d quarter(s)", yk, len(quarter_sums))
            quarters_to_remove.extend(quarter_sums)
            continue

        log.info("  Rolling up %d quarter(s) into year summary %s", len(quarter_sums), yk)
        combined = "\n\n".join(
            f"[{qs['quarter_key']}] {qs['summary']}"
            for qs in sorted(quarter_sums, key=lambda x: x["quarter_key"])
        )
        year_start, year_end = _year_bounds(yk)
        period_entries = _entries_in_range(all_entries, year_start, year_end, variant)
        prompt = (
            f"Combine the following quarterly summaries for {yk} into one "
            f"rich year summary. Use the quarterly summaries plus all entries from "
            f"the year as source material.\n\n"
            f"Quarterly summaries:\n{combined}\n\n"
            f"Entries/memos for the year:\n{_fmt_entries(period_entries, variant)}"
        )
        store["summaries"]["year"].append({
            "id": str(uuid.uuid4()),
            "year_key": yk,
            "summary": _call_llm(prompt, llm_fn, stage='year'),
            "created_at": datetime.utcnow().isoformat() + "Z",
        })
        quarters_to_remove.extend(quarter_sums)
        changed = True

    if quarters_to_remove:
        remove_ids = {qs["id"] for qs in quarters_to_remove}
        store["summaries"]["quarter"] = [
            qs for qs in store["summaries"]["quarter"] if qs["id"] not in remove_ids
        ]
        log.debug("  Removed %d quarter summaries after year rollup", len(quarters_to_remove))
        changed = True

    # No trim – year summaries are kept indefinitely
    return changed


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def run_summarization(
    store: dict,
    all_entries: list,
    variant: str,
    llm_fn: Optional[Callable] = None,
) -> tuple:
    """
    Run the full summarization pipeline on the chat store in-place.

    Args:
        store:       The full chat store dict (mutated in-place).
        all_entries: All memo/finance entries for this variant.
        variant:     'default' or 'finance'.
        llm_fn:      Optional callable(prompt: str) -> str.
                     When None, summaries fall back to truncated raw text.

    Returns:
        (store, changed: bool)
    """
    today = date.today()
    meta = _ensure_meta(store)
    today_str = today.isoformat()
    log.info('--- Summarization pipeline start | variant=%s | today=%s | '
             'messages=%d | entries=%d | llm=%s ---',
             variant, today, len(store.get('messages', [])), len(all_entries),
             'provided' if llm_fn else 'NONE (truncation fallback)')
    _snapshot_before = {
        k: len(v) for k, v in store.get('summaries', {}).items()
    }
    changed = False
    changed |= _run_day_summaries(store, all_entries, variant, llm_fn, today)
    changed |= _run_week_summaries(store, all_entries, variant, llm_fn, today)
    changed |= _run_month_summaries(store, all_entries, variant, llm_fn, today)
    changed |= _run_quarter_summaries(store, all_entries, variant, llm_fn, today)
    changed |= _run_year_summaries(store, all_entries, variant, llm_fn, today)
    if meta.get("last_rollover_check_date") != today_str:
        meta["last_rollover_check_date"] = today_str
        changed = True
    _snapshot_after = {
        k: len(v) for k, v in store.get('summaries', {}).items()
    }
    log.info('--- Summarization pipeline done | changed=%s | counts before=%s after=%s ---',
             changed, _snapshot_before, _snapshot_after)
    return store, changed

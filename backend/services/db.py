"""
services/db.py — SQLite database layer for MemoSystem.

Provides:
  - Database class: opens/creates the .db file, runs migrations, thread-safe
  - Schema definitions + auto-migration via schema_version table
  - execute / fetchall / fetchone / executemany helpers
  - get_db() module-level singleton accessor

No ORM — plain sqlite3 to keep zero new Python dependencies.
"""

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Schema — keep in version order; only append, never modify existing entries
# ---------------------------------------------------------------------------

_MIGRATIONS: List[Tuple[int, str]] = [
    (1, """
        CREATE TABLE IF NOT EXISTS memos (
            id          TEXT PRIMARY KEY,
            description TEXT,
            category    TEXT,
            tags        TEXT,
            images      TEXT,
            attachments TEXT,
            created_at  INTEGER,
            updated_at  INTEGER,
            deleted     INTEGER DEFAULT 0,
            deleted_at  INTEGER
        );

        CREATE TABLE IF NOT EXISTS finance_entries (
            id            TEXT PRIMARY KEY,
            description   TEXT,
            category      TEXT,
            tags          TEXT,
            images        TEXT,
            attachments   TEXT,
            purchase_date TEXT,
            price         REAL DEFAULT 0,
            tax           REAL DEFAULT 0,
            adjustment    REAL DEFAULT 0,
            total         REAL DEFAULT 0,
            items         TEXT,
            created_at    INTEGER,
            updated_at    INTEGER,
            deleted       INTEGER DEFAULT 0,
            deleted_at    INTEGER
        );

        CREATE TABLE IF NOT EXISTS chat_messages (
            id         TEXT PRIMARY KEY,
            variant    TEXT DEFAULT 'default',
            role       TEXT,
            content    TEXT,
            created_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS operations (
            id         TEXT PRIMARY KEY,
            variant    TEXT DEFAULT 'default',
            type       TEXT,
            entry_id   TEXT,
            payload    TEXT,
            created_at INTEGER,
            synced     INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS hashbook (
            sha256      TEXT PRIMARY KEY,
            stored_path TEXT,
            ref_count   INTEGER DEFAULT 1,
            created_at  INTEGER
        );

        CREATE TABLE IF NOT EXISTS ocr_drafts (
            draft_id   TEXT PRIMARY KEY,
            memo_id    TEXT,
            variant    TEXT DEFAULT 'default',
            status     TEXT DEFAULT 'pending',
            temp_bin   TEXT,
            proposed   TEXT,
            error      TEXT,
            created_at INTEGER,
            updated_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS schema_version (
            version    INTEGER PRIMARY KEY,
            applied_at INTEGER
        );
    """),
    # -------------------------------------------------------------------
    # v2 — make operations a proper relational table (one row per op,
    # per-variant monotonic op_id, full fidelity) and add a snapshots
    # table.  Migrates any existing data so no operations are lost:
    #   - rows from the v1 `operations` table (created by early imports)
    #   - operation lists previously stuffed into the settings table
    #     under "__ops__:<variant>" JSON blobs
    #   - snapshots previously stored under "__snap__:<variant>" blobs
    # -------------------------------------------------------------------
    (2, """
        ALTER TABLE operations RENAME TO operations_legacy;

        CREATE TABLE operations (
            variant      TEXT NOT NULL DEFAULT 'default',
            op_id        INTEGER NOT NULL,
            type         TEXT,
            entry_id     TEXT,
            timestamp    INTEGER,
            device_id    TEXT,
            client_op_id TEXT,
            payload      TEXT,
            PRIMARY KEY (variant, op_id)
        );

        CREATE INDEX idx_operations_client ON operations(variant, client_op_id);

        CREATE TABLE snapshots (
            variant     TEXT PRIMARY KEY,
            snapshot_id INTEGER NOT NULL DEFAULT 0,
            timestamp   INTEGER NOT NULL DEFAULT 0,
            entries     TEXT NOT NULL DEFAULT '[]'
        );

        INSERT OR IGNORE INTO operations
            (variant, op_id, type, entry_id, timestamp, device_id, client_op_id, payload)
        SELECT
            variant,
            CAST(CASE WHEN instr(id, ':') > 0
                      THEN substr(id, instr(id, ':') + 1)
                      ELSE id END AS INTEGER),
            type,
            entry_id,
            created_at,
            NULL,
            NULL,
            json_object('data', json(payload))
        FROM operations_legacy
        WHERE id IS NOT NULL;

        INSERT OR IGNORE INTO operations
            (variant, op_id, type, entry_id, timestamp, device_id, client_op_id, payload)
        SELECT
            substr(s.key, length('__ops__:') + 1),
            json_extract(j.value, '$.opId'),
            json_extract(j.value, '$.type'),
            json_extract(j.value, '$.entryId'),
            json_extract(j.value, '$.timestamp'),
            json_extract(j.value, '$.deviceId'),
            json_extract(j.value, '$.clientOpId'),
            json_object(
                'data',       json_extract(j.value, '$.data'),
                'field',      json_extract(j.value, '$.field'),
                'value',      json_extract(j.value, '$.value'),
                'url',        json_extract(j.value, '$.url'),
                'attachment', json_extract(j.value, '$.attachment')
            )
        FROM settings s, json_each(s.value) j
        WHERE s.key LIKE '__ops__:%';

        INSERT OR IGNORE INTO snapshots (variant, snapshot_id, timestamp, entries)
        SELECT
            substr(key, length('__snap__:') + 1),
            COALESCE(json_extract(value, '$.snapshotId'), 0),
            COALESCE(json_extract(value, '$.timestamp'), 0),
            COALESCE(json_extract(value, '$.entries'), '[]')
        FROM settings
        WHERE key LIKE '__snap__:%';

        DELETE FROM settings WHERE key LIKE '__ops__:%' OR key LIKE '__snap__:%';

        DROP TABLE operations_legacy;
    """),
    # -------------------------------------------------------------------
    # v3 — generic JSON document store for the Planner variant (and any
    # future doc-shaped variant). Unlike memos/finance_entries this has no
    # fixed domain columns: the whole entry rides in `data` (JSON), with the
    # discriminator pulled out to `kind` for querying. Operations sync stays
    # variant-agnostic (operations/snapshots tables); this is just the
    # authoritative materialised store the push path writes to.
    # -------------------------------------------------------------------
    (3, """
        CREATE TABLE IF NOT EXISTS planner_entries (
            id          TEXT PRIMARY KEY,
            kind        TEXT,
            data        TEXT,
            created_at  INTEGER,
            updated_at  INTEGER,
            deleted     INTEGER DEFAULT 0,
            deleted_at  INTEGER
        );
    """),
    # -------------------------------------------------------------------
    # v4 — finance entries gain a 'sheet' label so one finance dataset can hold
    # multiple sheets (e.g. Company vs Personal). Existing rows default to
    # 'General'. The sheet rides with the entry through the operations log.
    # -------------------------------------------------------------------
    (4, """
        ALTER TABLE finance_entries ADD COLUMN sheet TEXT DEFAULT 'General';
    """),
    # -------------------------------------------------------------------
    # v5 — per-image metadata for multi-image entries. Embedded EXIF's
    # original-segment backup is keyed by the image's stable stored path.
    # -------------------------------------------------------------------
    (5, """
        ALTER TABLE memos ADD COLUMN image_meta TEXT;
        ALTER TABLE finance_entries ADD COLUMN image_meta TEXT;
    """),
]

_MIGRATIONS.append((6, """
    CREATE TABLE IF NOT EXISTS operation_receipts (
        variant TEXT NOT NULL, client_op_id TEXT NOT NULL, op_id INTEGER NOT NULL,
        PRIMARY KEY (variant, client_op_id)
    );
    INSERT OR IGNORE INTO operation_receipts (variant, client_op_id, op_id)
        SELECT variant, client_op_id, op_id FROM operations
        WHERE client_op_id IS NOT NULL AND client_op_id != '';
"""))

# v7 — the Vault: end-to-end encrypted documents (the device encrypts each
# item before it syncs; the server stores and orders them but cannot read them).
_MIGRATIONS.append((7, """
    CREATE TABLE IF NOT EXISTS vault_entries (
        id          TEXT PRIMARY KEY,
        kind        TEXT,
        data        TEXT,
        created_at  INTEGER,
        updated_at  INTEGER,
        deleted     INTEGER DEFAULT 0,
        deleted_at  INTEGER
    );
"""))

# v8 — AI contacts (and the Me profile) and chat messages, synced like
# planner documents (one message per document, so threads merge cleanly).
_MIGRATIONS.append((8, """
    CREATE TABLE IF NOT EXISTS ai_contacts (
        id TEXT PRIMARY KEY, kind TEXT, data TEXT, created_at INTEGER, updated_at INTEGER,
        deleted INTEGER DEFAULT 0, deleted_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS ai_messages (
        id TEXT PRIMARY KEY, kind TEXT, data TEXT, created_at INTEGER, updated_at INTEGER,
        deleted INTEGER DEFAULT 0, deleted_at INTEGER
    );
"""))

# v9 — a purchase's store, how it was paid and notes, as one JSON column.
_MIGRATIONS.append((9, """
    ALTER TABLE finance_entries ADD COLUMN details TEXT;
"""))

_CURRENT_VERSION = max(v for v, _ in _MIGRATIONS)

# ---------------------------------------------------------------------------
# Schema self-heal
# ---------------------------------------------------------------------------
# Columns this code writes that were introduced by a numbered migration above.
#
# The version counter alone is not trustworthy: a database migrated by a
# DIFFERENT branch can report a HIGHER schema_version than this code line knows
# about (e.g. an abandoned branch took the DB to v11 while this line stops at
# v5). Every `version > applied` migration then silently no-ops, so a column
# like finance_entries.image_meta is never added — and every INSERT that writes
# it fails at runtime. That is exactly how a synced entry was lost: the push
# was logged, the materialised write raised "no column named image_meta", and
# the failure was swallowed.
#
# This guard is additive, idempotent, and version-independent: it re-adds only
# what is genuinely missing, whatever the counter says. It never drops or
# rewrites a column, so columns an unrelated branch added are left untouched.
_REQUIRED_COLUMNS: Dict[str, Dict[str, str]] = {
    'memos': {
        'image_meta': 'TEXT',
        # A note's Safe flag (privacy level 2) so it survives sync.
        'safe': 'INTEGER DEFAULT 0',
    },
    'finance_entries': {
        'sheet': "TEXT DEFAULT 'General'",
        'image_meta': 'TEXT',
        'details': 'TEXT',
    },
}


# ---------------------------------------------------------------------------
# Database class
# ---------------------------------------------------------------------------

class DatabaseIntegrityError(RuntimeError):
    """Raised when an existing backend database cannot be verified safely."""

    def __init__(self, db_path: str, detail: str):
        absolute_path = os.path.abspath(db_path)
        super().__init__(
            f"SQLite integrity check failed for '{absolute_path}': {detail}. "
            "Server startup stopped before schema changes; the existing database "
            "was not replaced. Stop every MemoSystem server, preserve the database "
            "together with its matching -wal and -shm files, then restore a verified "
            "backup or run SQLite recovery against a copy."
        )
        self.db_path = absolute_path
        self.detail = detail


class Database:
    """
    Thread-safe SQLite wrapper.

    Usage:
        db = Database("data/memosystem.db")
        with db.conn() as con:
            con.execute("INSERT INTO memos ...")

    Or use the shorthand helpers:
        rows = db.fetchall("SELECT * FROM memos WHERE deleted=0")
        db.execute("UPDATE memos SET description=? WHERE id=?", [desc, id])
    """

    def __init__(self, db_path: str):
        self._path = db_path
        self._lock = threading.RLock()
        self._local = threading.local()
        os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
        if os.path.exists(db_path):
            self._validate_existing_database()
        self._ensure_schema()

    # ------------------------------------------------------------------
    # Internal connection management
    # ------------------------------------------------------------------

    def _validate_existing_database(self):
        """Read-check an existing primary before WAL setup or migrations.

        Opening with ``mode=ro`` prevents this gate from turning a corrupt file
        into a fresh empty database.  A normal read-only connection (rather than
        SQLite's ``immutable`` mode) is intentional so committed WAL content is
        included in the check.
        """
        uri = Path(os.path.abspath(self._path)).as_uri() + "?mode=ro"
        con = None
        try:
            con = sqlite3.connect(uri, uri=True, isolation_level=None)
            rows = con.execute("PRAGMA quick_check").fetchall()
            findings = [str(row[0]) for row in rows if row and row[0] is not None]
            if not findings or any(item.lower() != "ok" for item in findings):
                detail = "; ".join(findings) if findings else "quick_check returned no result"
                raise DatabaseIntegrityError(self._path, detail)
        except DatabaseIntegrityError:
            raise
        except sqlite3.Error as exc:
            raise DatabaseIntegrityError(self._path, str(exc)) from exc
        finally:
            if con is not None:
                con.close()

    def _get_connection(self) -> sqlite3.Connection:
        """Return a per-thread connection, creating it if necessary."""
        con = getattr(self._local, "con", None)
        if con is None:
            con = sqlite3.connect(
                self._path,
                check_same_thread=False,
                isolation_level=None,   # autocommit; we manage transactions manually
            )
            try:
                con.row_factory = sqlite3.Row
                con.execute("PRAGMA journal_mode=WAL")
                con.execute("PRAGMA foreign_keys=ON")
                self._local.con = con
            except Exception:
                con.close()
                raise
        return con

    def close(self):
        """Close the per-thread connection (call from the same thread that opened it)."""
        con = getattr(self._local, "con", None)
        if con is not None:
            con.close()
            self._local.con = None

    # ------------------------------------------------------------------
    # Migration / schema bootstrap
    # ------------------------------------------------------------------

    def _ensure_schema(self):
        con = self._get_connection()
        # Create schema_version first so we can read it
        con.execute("""
            CREATE TABLE IF NOT EXISTS schema_version (
                version    INTEGER PRIMARY KEY,
                applied_at INTEGER
            )
        """)
        cur = con.execute("SELECT MAX(version) FROM schema_version")
        row = cur.fetchone()
        applied = row[0] if row[0] is not None else 0

        import time
        for version, sql in _MIGRATIONS:
            if version > applied:
                with self._transaction(con):
                    # sqlite3 executescript doesn't support parameters so we
                    # use a plain execute loop split on ";"
                    for statement in sql.split(";"):
                        stmt = statement.strip()
                        if stmt:
                            con.execute(stmt)
                    con.execute(
                        "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)",
                        (version, int(time.time() * 1000)),
                    )

        # Version-independent backstop — see _REQUIRED_COLUMNS.
        self._ensure_required_columns(con)

    @staticmethod
    def _ensure_required_columns(con: sqlite3.Connection):
        """Add any column this code needs that the migrations didn't produce.

        Additive and idempotent. Runs on every startup so a database whose
        schema_version was advanced by another branch still gets the columns
        this code writes, instead of failing every INSERT at runtime.
        """
        for table, columns in _REQUIRED_COLUMNS.items():
            try:
                existing = {row[1] for row in con.execute(f"PRAGMA table_info({table})")}
            except sqlite3.Error:
                continue
            if not existing:
                continue  # table not created (yet) — migrations own that
            for name, declaration in columns.items():
                if name in existing:
                    continue
                try:
                    con.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")
                    print(f"🛠️  schema self-heal: added missing column {table}.{name}")
                except sqlite3.Error as exc:
                    print(f"⚠️  schema self-heal could not add {table}.{name}: {exc}")

    @staticmethod
    @contextmanager
    def _transaction(con: sqlite3.Connection):
        nested = con.in_transaction
        con.execute("SAVEPOINT nested_write" if nested else "BEGIN IMMEDIATE")
        try:
            yield con
            con.execute("RELEASE nested_write" if nested else "COMMIT")
        except Exception:
            if nested:
                con.execute("ROLLBACK TO nested_write")
                con.execute("RELEASE nested_write")
            else:
                con.execute("ROLLBACK")
            raise

    # ------------------------------------------------------------------
    # Public context manager (gives callers a connection inside a transaction)
    # ------------------------------------------------------------------

    @contextmanager
    def conn(self) -> Iterator[sqlite3.Connection]:
        """
        Yield a connection inside a transaction.  Commits on clean exit,
        rolls back on exception.
        """
        with self._lock:
            con = self._get_connection()
            with self._transaction(con):
                yield con

    # ------------------------------------------------------------------
    # Convenience helpers
    # ------------------------------------------------------------------

    def execute(self, sql: str, params: Optional[List[Any]] = None) -> sqlite3.Cursor:
        """Execute a single statement (INSERT/UPDATE/DELETE) inside a transaction."""
        with self._lock:
            con = self._get_connection()
            with self._transaction(con):
                return con.execute(sql, params or [])

    def executemany(self, sql: str, param_list: List[List[Any]]) -> sqlite3.Cursor:
        """Execute a statement for each parameter list inside a single transaction."""
        with self._lock:
            con = self._get_connection()
            with self._transaction(con):
                return con.executemany(sql, param_list)

    def fetchall(self, sql: str, params: Optional[List[Any]] = None) -> List[sqlite3.Row]:
        """Execute a SELECT and return all rows."""
        with self._lock:
            cur = self._get_connection().execute(sql, params or [])
            return cur.fetchall()

    def fetchone(self, sql: str, params: Optional[List[Any]] = None) -> Optional[sqlite3.Row]:
        """Execute a SELECT and return the first row (or None)."""
        with self._lock:
            cur = self._get_connection().execute(sql, params or [])
            return cur.fetchone()

    def reclaim_space(self) -> bool:
        """Give freed pages back to the filesystem (VACUUM + WAL truncate).

        Deleting rows (e.g. compacting the sync log) leaves free pages that
        SQLite reuses but never returns, so the file only grows. Must run
        outside a transaction; returns False if SQLite refused (busy).
        """
        with self._lock:
            con = self._get_connection()
            if con.in_transaction:
                return False
            try:
                con.execute("VACUUM")
                con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                return True
            except sqlite3.OperationalError as exc:
                print(f"⚠️ Could not reclaim database space: {exc}")
                return False

    def restore_from(self, source: 'Database'):
        """Restore through SQLite itself, keeping existing WAL connections valid.

        The caller has verified/migrated the staged source. Readers and writers
        share this lock; SQLite's backup transaction replaces the destination
        atomically instead of copying over a live database file.
        """
        with self._lock, source._lock:
            destination = self._get_connection()
            if destination.in_transaction:
                raise RuntimeError('Cannot restore during an active database transaction')
            source._get_connection().backup(destination)
            if destination.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise DatabaseIntegrityError(self._path, 'Restored database verification failed')

    def schema_version(self) -> int:
        """Return the currently applied schema version."""
        row = self.fetchone("SELECT MAX(version) FROM schema_version")
        return row[0] if row and row[0] is not None else 0

    # ------------------------------------------------------------------
    # JSON helpers (used by store modules)
    # ------------------------------------------------------------------

    @staticmethod
    def json_dumps(obj) -> Optional[str]:
        if obj is None:
            return None
        return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))

    @staticmethod
    def json_loads(text: Optional[str]) -> Any:
        if text is None:
            return None
        try:
            return json.loads(text)
        except (json.JSONDecodeError, TypeError):
            return None


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

_instance: Optional[Database] = None


def init_db(db_path: str) -> Database:
    """Initialise the module-level singleton.  Call once at app startup."""
    global _instance
    _instance = Database(db_path)
    return _instance


def get_db() -> Database:
    """Return the module-level singleton.  Raises if not initialised."""
    if _instance is None:
        raise RuntimeError("Database not initialised — call init_db() first")
    return _instance

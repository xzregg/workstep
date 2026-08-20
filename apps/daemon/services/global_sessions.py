"""Global session store for project-less assistant conversations.

Flow-template editing runs outside any project, so its assistant sessions
persist in a daemon-global SQLite database instead of a project's
``.workstep/workstep.db``. Project-scoped conversations keep using their
project database; only an empty ``project_id`` routes here.
"""

from contextlib import contextmanager

import peewee as pw

from models.base import db_proxy
from models.gen_session import WorkflowGenSession
from services.config import CONFIG_DIR

GLOBAL_SESSIONS_DB_PATH = CONFIG_DIR / "data" / "gen_sessions.db"

_global_db: pw.SqliteDatabase | None = None


def global_sessions_db() -> pw.SqliteDatabase:
    """Lazily open (and create tables for) the global sessions database."""
    global _global_db
    if _global_db is None:
        path = GLOBAL_SESSIONS_DB_PATH
        path.parent.mkdir(parents=True, exist_ok=True)
        db = pw.SqliteDatabase(str(path), pragmas={"journal_mode": "wal"})
        db.connect(reuse_if_open=True)
        token = db_proxy.activate(db)
        try:
            db.create_tables([WorkflowGenSession], safe=True)
        finally:
            db_proxy.reset(token)
        _global_db = db
    return _global_db


def reset_global_sessions_db() -> None:
    """Drop the cached handle (used by tests and config moves)."""
    global _global_db
    _global_db = None


@contextmanager
def global_sessions_ctx():
    """Activate the global DB for shared Peewee models in this context."""
    db = global_sessions_db()
    if db.is_closed():
        db.connect(reuse_if_open=True)
    token = db_proxy.activate(db)
    try:
        yield
    finally:
        db_proxy.reset(token)

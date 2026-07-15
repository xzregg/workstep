"""Data models — Peewee ORM for per-project SQLite."""

import peewee as pw
from models.base import db_proxy, BaseModel
from models.task import Task, TaskStep
from models.message import Message

# All models for table creation
ALL_MODELS = [Task, TaskStep, Message]


def init_db(db_path: str) -> pw.SqliteDatabase:
    """Initialize a project's SQLite database.

    Binds db_proxy to the given path and creates tables if they don't exist.
    Returns the database instance.
    """
    db = pw.SqliteDatabase(db_path, pragmas={
        "journal_mode": "wal",
        "foreign_keys": 1,
    })
    db_proxy.initialize(db)
    db.connect(reuse_if_open=True)
    db.create_tables(ALL_MODELS)
    return db

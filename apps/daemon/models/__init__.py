"""Data models — Peewee ORM for per-project SQLite."""

import peewee as pw
from models.base import db_proxy, BaseModel
from models.task import Task, TaskStep
from models.message import Message
from models.schema import SchemaVersion
from models.run import StepRun, WorkflowRun
from models.review import ReviewRun
from models.migrations import LATEST_SCHEMA_VERSION, migrate_database

# Complete model registry for callers that need model metadata.
ALL_MODELS = [
    SchemaVersion, Task, TaskStep, Message, WorkflowRun, StepRun, ReviewRun
]


def init_db(db_path: str) -> pw.SqliteDatabase:
    """Initialize a project's SQLite database.

    Binds db_proxy to the given path and applies pending migrations.
    Returns the database instance.
    """
    db = pw.SqliteDatabase(db_path, pragmas={
        "journal_mode": "wal",
        "foreign_keys": 1,
    })
    db_proxy.initialize(db)
    db.connect(reuse_if_open=True)
    migrate_database(db)
    return db

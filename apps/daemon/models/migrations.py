"""Idempotent migrations for per-project SQLite databases."""

from collections.abc import Callable

import peewee as pw

from models.base import db_proxy
from models.schema import SchemaVersion
from models.run import StepRun, WorkflowRun
from models.review import ReviewRun
from models.message import Message
from models.task import Task, TaskStep
from models.workflow import Workflow

LATEST_SCHEMA_VERSION = 9


def _create_initial_tables(db: pw.SqliteDatabase) -> None:
    # Rename legacy `task` → `tasks` before creating tables so Peewee
    # does not create an empty `tasks` alongside the old `task` table.
    tables = {r[0] for r in db.execute_sql(
        "SELECT name FROM sqlite_master WHERE type='table'"
    )}
    if "task" in tables and "tasks" not in tables:
        db.execute_sql("ALTER TABLE task RENAME TO tasks")
    db.create_tables([Task, TaskStep, Message], safe=True)


def _create_workflow_runs_table(db: pw.SqliteDatabase) -> None:
    db.create_tables([WorkflowRun], safe=True)


def _create_step_runs_table(db: pw.SqliteDatabase) -> None:
    db.create_tables([StepRun], safe=True)


def _create_review_runs_table(db: pw.SqliteDatabase) -> None:
    db.create_tables([ReviewRun], safe=True)


def _create_workflows_table(db: pw.SqliteDatabase) -> None:
    db.create_tables([Workflow], safe=True)


def _add_workflow_deleted_column(db: pw.SqliteDatabase) -> None:
    """Soft-delete support: add `deleted` column to the workflows table."""
    cols = {row[1] for row in db.execute_sql("PRAGMA table_info(workflows)")}
    if "deleted" not in cols:
        db.execute_sql("ALTER TABLE workflows ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0")


def _add_task_review_overrides_column(db: pw.SqliteDatabase) -> None:
    """Add review_overrides_json column to tasks table."""
    target = "tasks" if "tasks" in {r[0] for r in db.execute_sql("SELECT name FROM sqlite_master WHERE type='table'")} else "task"
    cols = {row[1] for row in db.execute_sql(f"PRAGMA table_info({target})")}
    if "review_overrides_json" not in cols:
        db.execute_sql(f"ALTER TABLE {target} ADD COLUMN review_overrides_json TEXT")


def _rename_task_table(db: pw.SqliteDatabase) -> None:
    """Rename legacy `task` table to `tasks` for consistency."""
    tables = {row[0] for row in db.execute_sql(
        "SELECT name FROM sqlite_master WHERE type='table'"
    )}
    if "task" in tables and "tasks" not in tables:
        db.execute_sql("ALTER TABLE task RENAME TO tasks")


def _add_workflow_id_column(db: pw.SqliteDatabase) -> None:
    target = "tasks" if "tasks" in {r[0] for r in db.execute_sql("SELECT name FROM sqlite_master WHERE type='table'")} else "task"
    cols = {row[1] for row in db.execute_sql(f"PRAGMA table_info({target})")}
    if "workflow_id" not in cols:
        db.execute_sql(f"ALTER TABLE {target} ADD COLUMN workflow_id TEXT")


MIGRATIONS: dict[int, Callable[[pw.SqliteDatabase], None]] = {
    1: _create_initial_tables,
    2: _create_workflow_runs_table,
    3: _create_step_runs_table,
    4: _create_review_runs_table,
    5: _create_workflows_table,
    6: _add_workflow_deleted_column,
    7: _add_task_review_overrides_column,
    8: _rename_task_table,
    9: _add_workflow_id_column,
}


def migrate_database(db: pw.SqliteDatabase) -> int:
    """Bind and upgrade an open project database, returning its schema version."""
    db_proxy.initialize(db)
    SchemaVersion.create_table(safe=True)
    row = SchemaVersion.get_or_none(SchemaVersion.id == 1)
    current_version = row.version if row else 0

    for version in range(current_version + 1, LATEST_SCHEMA_VERSION + 1):
        with db.atomic():
            MIGRATIONS[version](db)
            (
                SchemaVersion.insert(id=1, version=version)
                .on_conflict(
                    conflict_target=[SchemaVersion.id],
                    update={SchemaVersion.version: version},
                )
                .execute()
            )

    return LATEST_SCHEMA_VERSION

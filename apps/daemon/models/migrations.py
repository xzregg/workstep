"""Idempotent migrations for per-project SQLite databases."""

from collections.abc import Callable

import peewee as pw
from playhouse.migrate import SqliteMigrator, migrate

from models.base import db_proxy
from models.fields import UTCDateTimeField
from models.schema import SchemaVersion
from models.run import StepRun, WorkflowRun
from models.review import ReviewRun
from models.message import Message
from models.task import Task, TaskStep
from models.workflow import Workflow
from models.coordinator import (
    ActionProposal,
    CoordinatorSession,
    CoordinatorTurn,
    StageSupplement,
)

LATEST_SCHEMA_VERSION = 14


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


DATETIME_COLUMNS = {
    "taskstep": ("started_at", "ended_at"),
    "message": ("started_at", "ended_at"),
    "workflow_runs": ("started_at", "ended_at"),
    "step_runs": ("started_at", "ended_at"),
    "review_runs": ("started_at", "ended_at"),
}

REMAINING_DATETIME_COLUMNS = {
    "tasks": ("created_at", "updated_at"),
    "message": ("created_at",),
    "workflows": ("created_at", "updated_at"),
    "review_runs": ("decided_at",),
}

ALL_DATETIME_COLUMNS = {
    table: tuple(dict.fromkeys(
        DATETIME_COLUMNS.get(table, ())
        + REMAINING_DATETIME_COLUMNS.get(table, ())
    ))
    for table in DATETIME_COLUMNS.keys() | REMAINING_DATETIME_COLUMNS.keys()
}


def _convert_columns_to_datetime(
    db: pw.SqliteDatabase,
    datetime_columns: dict[str, tuple[str, ...]],
) -> None:
    migrator = SqliteMigrator(db)
    tables = set(db.get_tables())
    db.execute_sql("PRAGMA foreign_keys = OFF")
    try:
        for table, column_names in datetime_columns.items():
            if table not in tables:
                continue
            column_types = {
                column.name: (column.data_type or "").upper()
                for column in db.get_columns(table)
            }
            for column_name in column_names:
                if column_types.get(column_name) == "DATETIME":
                    continue
                db.execute_sql(
                    f'''UPDATE "{table}"
                        SET "{column_name}" = strftime(
                            '%Y-%m-%d %H:%M:%S+00:00',
                            "{column_name}",
                            'unixepoch'
                        )
                        WHERE typeof("{column_name}") IN ('integer', 'real')'''
                )
                migrate(migrator.alter_column_type(
                    table,
                    column_name,
                    UTCDateTimeField(null=True),
                ))
    finally:
        db.execute_sql("PRAGMA foreign_keys = ON")


def _convert_execution_times_to_datetime(db: pw.SqliteDatabase) -> None:
    """Convert legacy execution epoch seconds to DATETIME."""
    _convert_columns_to_datetime(db, DATETIME_COLUMNS)


def _convert_remaining_times_to_datetime(db: pw.SqliteDatabase) -> None:
    """Convert every remaining project-table epoch field to DATETIME."""
    _convert_columns_to_datetime(db, REMAINING_DATETIME_COLUMNS)


def _add_column_if_missing(
    db: pw.SqliteDatabase,
    table: str,
    column: str,
    definition: str,
) -> None:
    columns = {row[1] for row in db.execute_sql(f'PRAGMA table_info("{table}")')}
    if column not in columns:
        db.execute_sql(
            f'ALTER TABLE "{table}" ADD COLUMN "{column}" {definition}'
        )


def _add_coordinator_columns(db: pw.SqliteDatabase) -> None:
    """Add coordinator routing, message identity, and run lineage columns."""
    for column, definition in (
        ("coordinator_engine", "TEXT"),
        ("coordinator_model", "TEXT"),
        ("active_workflow_run_id", "TEXT"),
        ("state_version", "INTEGER NOT NULL DEFAULT 0"),
        ("next_message_sequence", "INTEGER NOT NULL DEFAULT 1"),
    ):
        _add_column_if_missing(db, "tasks", column, definition)

    for column, definition in (
        ("context_step_key", "TEXT"),
        ("channel", "TEXT NOT NULL DEFAULT 'execution'"),
        ("sequence", "INTEGER"),
        ("reply_to_message_id", "TEXT"),
    ):
        _add_column_if_missing(db, "message", column, definition)

    _add_column_if_missing(db, "workflow_runs", "parent_run_id", "TEXT")
    _add_column_if_missing(
        db,
        "workflow_runs",
        "restart_from_step_key",
        "TEXT",
    )
    _add_column_if_missing(db, "step_runs", "source_step_run_id", "TEXT")

    db.execute_sql(
        "UPDATE message SET channel = 'review', role = 'assistant' "
        "WHERE role = 'review'"
    )
    rows = db.execute_sql(
        "SELECT id, task_id FROM message ORDER BY task_id, created_at, id"
    ).fetchall()
    next_by_task: dict[str, int] = {}
    for message_id, task_id in rows:
        sequence = next_by_task.get(task_id, 1)
        db.execute_sql(
            "UPDATE message SET sequence = ? WHERE id = ?",
            (sequence, message_id),
        )
        next_by_task[task_id] = sequence + 1
    for task_id, next_sequence in next_by_task.items():
        db.execute_sql(
            "UPDATE tasks SET next_message_sequence = ? WHERE id = ?",
            (next_sequence, task_id),
        )

    db.execute_sql(
        "CREATE UNIQUE INDEX IF NOT EXISTS message_task_sequence "
        "ON message(task_id, sequence)"
    )
    db.execute_sql(
        "CREATE INDEX IF NOT EXISTS message_task_channel_sequence "
        "ON message(task_id, channel, sequence)"
    )


def _create_coordinator_tables(db: pw.SqliteDatabase) -> None:
    db.create_tables(
        [
            CoordinatorSession,
            CoordinatorTurn,
            ActionProposal,
            StageSupplement,
        ],
        safe=True,
    )


def _add_coordinator_fast_model_column(db: pw.SqliteDatabase) -> None:
    _add_column_if_missing(db, "tasks", "coordinator_fast_model", "TEXT")


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
    10: _convert_execution_times_to_datetime,
    11: _convert_remaining_times_to_datetime,
    12: _add_coordinator_columns,
    13: _create_coordinator_tables,
    14: _add_coordinator_fast_model_column,
}

NON_ATOMIC_MIGRATIONS = {10, 11}


def migrate_database(db: pw.SqliteDatabase) -> int:
    """Bind and upgrade an open project database, returning its schema version."""
    db_proxy.initialize(db)
    SchemaVersion.create_table(safe=True)
    row = SchemaVersion.get_or_none(SchemaVersion.id == 1)
    current_version = row.version if row else 0

    for version in range(current_version + 1, LATEST_SCHEMA_VERSION + 1):
        if version in NON_ATOMIC_MIGRATIONS:
            MIGRATIONS[version](db)
            (
                SchemaVersion.insert(id=1, version=version)
                .on_conflict(
                    conflict_target=[SchemaVersion.id],
                    update={SchemaVersion.version: version},
                )
                .execute()
            )
            continue
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

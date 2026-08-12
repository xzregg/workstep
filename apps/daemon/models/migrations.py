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
from models.gen_session import WorkflowGenSession
from models.schedule import Schedule, ScheduleRun
from models.share import TaskShare
from models.chat_session import ChatSession, ChatMessage, ProjectSetting

LATEST_SCHEMA_VERSION = 34


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


def _add_workflow_sort_order_column(db: pw.SqliteDatabase) -> None:
    """Drag-and-drop reordering support: add `sort_order` column to the workflows table."""
    cols = {row[1] for row in db.execute_sql("PRAGMA table_info(workflows)")}
    if "sort_order" not in cols:
        db.execute_sql("ALTER TABLE workflows ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")


def _create_task_shares_table(db: pw.SqliteDatabase) -> None:
    """Create the task_shares table with a unique constraint on task_id
    so each task has at most one active share link."""
    db.create_tables([TaskShare], safe=True)
    db.execute_sql(
        "CREATE UNIQUE INDEX IF NOT EXISTS task_shares_task_unique "
        "ON task_shares(task_id)"
    )


def _make_task_shares_password_nullable(db: pw.SqliteDatabase) -> None:
    """Migration 31: Make password_hash and salt columns nullable so
    shares can be created without a password."""
    migrator = SqliteMigrator(db)
    for col_name in ("password_hash", "salt"):
        _add_column_if_missing(db, "task_shares", col_name, "TEXT")
    # SQLite can't ALTER COLUMN directly; use the migrator to recreate
    # the table with the new nullable column definition.
    migrate(
        migrator.alter_column_type("task_shares", "password_hash", pw.TextField(null=True)),
        migrator.alter_column_type("task_shares", "salt", pw.TextField(null=True)),
    )


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


def _add_coordinator_vision_model_column(db: pw.SqliteDatabase) -> None:
    """Multimodal fallback model for coordinator image analysis."""
    _add_column_if_missing(db, "tasks", "coordinator_vision_model", "TEXT")


def _add_coordinator_thinking_effort_column(db: pw.SqliteDatabase) -> None:
    """Per-task coordinator thinking effort (minimal/low/medium/high)."""
    _add_column_if_missing(db, "tasks", "coordinator_thinking_effort", "TEXT")


def _add_task_step_session_id_column(db: pw.SqliteDatabase) -> None:
    """Per-stage engine session: same task+stage reuses the same session id."""
    _add_column_if_missing(db, "taskstep", "session_id", "TEXT")


def _add_task_step_review_session_id_column(db: pw.SqliteDatabase) -> None:
    """Per-stage review session: isolated from the execution session, reused
    across automatic review attempts of the same task+stage."""
    _add_column_if_missing(db, "taskstep", "review_session_id", "TEXT")


def _add_task_step_rework_feedback_column(db: pw.SqliteDatabase) -> None:
    """Rework feedback sent from a downstream verifier to an upstream producer."""
    _add_column_if_missing(db, "taskstep", "rework_feedback", "TEXT")


def _add_task_step_review_feedback_column(db: pw.SqliteDatabase) -> None:
    """Human review rejection reason injected into the next stage attempt."""
    _add_column_if_missing(db, "taskstep", "review_feedback", "TEXT")


def _add_task_archived_column(db: pw.SqliteDatabase) -> None:
    """Archive support: add `archived` flag to the tasks table."""
    _add_column_if_missing(db, "tasks", "archived", "INTEGER NOT NULL DEFAULT 0")


def _make_stage_supplement_source_optional(db: pw.SqliteDatabase) -> None:
    """Live stage messages may add guidance without a coordinator proposal."""
    migrator = SqliteMigrator(db)
    migrate(
        migrator.alter_column_type(
            "stage_supplements",
            "source_proposal_id",
            pw.IntegerField(null=True),
        ),
    )


def _create_gen_sessions_table(db: pw.SqliteDatabase) -> None:
    db.create_tables([WorkflowGenSession], safe=True)


def _add_gen_sessions_engine_state_column(db: pw.SqliteDatabase) -> None:
    """Persist engine-side conversation state (e.g. Pydantic AI messages)."""
    _add_column_if_missing(
        db, "gen_sessions", "engine_state_json", "TEXT"
    )


def _add_coordinator_engine_state_column(db: pw.SqliteDatabase) -> None:
    """Persist engine-side conversation state for task coordinator chats."""
    _add_column_if_missing(
        db, "coordinator_sessions", "engine_state_json", "TEXT"
    )


def _add_workflow_run_recovery_columns(db: pw.SqliteDatabase) -> None:
    """Track restart recovery so the UI can show a resume hint."""
    _add_column_if_missing(db, "workflow_runs", "recovered_at", "DATETIME")
    _add_column_if_missing(
        db, "workflow_runs", "recovered_count", "INTEGER NOT NULL DEFAULT 0"
    )


def _create_schedule_tables(db: pw.SqliteDatabase) -> None:
    db.create_tables([Schedule, ScheduleRun], safe=True)


def _create_statistics_indexes(db: pw.SqliteDatabase) -> None:
    """Speed up dashboard time-window scans without duplicating facts."""
    for statement in (
        "CREATE INDEX IF NOT EXISTS tasks_created_at ON tasks(created_at)",
        "CREATE INDEX IF NOT EXISTS tasks_workflow_created ON tasks(workflow_id, created_at)",
        "CREATE INDEX IF NOT EXISTS workflow_runs_started_at ON workflow_runs(started_at)",
        "CREATE INDEX IF NOT EXISTS step_runs_started_at ON step_runs(started_at)",
        "CREATE INDEX IF NOT EXISTS review_runs_started_at ON review_runs(started_at)",
        "CREATE INDEX IF NOT EXISTS message_started_at ON message(started_at)",
    ):
        db.execute_sql(statement)


def _create_chat_session_tables(db: pw.SqliteDatabase) -> None:
    """Codex-style chat sessions, their messages and project settings."""
    db.create_tables([ChatSession, ChatMessage, ProjectSetting], safe=True)


def _add_chat_session_sort_order_column(db: pw.SqliteDatabase) -> None:
    """Drag-and-drop reordering support: add `sort_order` to chat_sessions."""
    cols = {row[1] for row in db.execute_sql("PRAGMA table_info(chat_sessions)")}
    if "sort_order" not in cols:
        db.execute_sql("ALTER TABLE chat_sessions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
        # Backfill: preserve the existing newest-first order per workflow.
        rows = db.execute_sql(
            "SELECT id, project_id, workflow_id FROM chat_sessions "
            "ORDER BY updated_at DESC, created_at DESC"
        ).fetchall()
        per_workflow: dict[tuple, int] = {}
        for row in rows:
            key = (row[1], row[2])
            index = per_workflow.get(key, 0)
            db.execute_sql(
                "UPDATE chat_sessions SET sort_order = ? WHERE id = ?",
                (index, row[0]),
            )
            per_workflow[key] = index + 1


def _add_chat_session_permission_mode_column(db: pw.SqliteDatabase) -> None:
    """Per-session permission mode selection for the session chat."""
    cols = {row[1] for row in db.execute_sql("PRAGMA table_info(chat_sessions)")}
    if "permission_mode" not in cols:
        db.execute_sql(
            "ALTER TABLE chat_sessions ADD COLUMN permission_mode TEXT"
        )


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
    15: _add_task_step_session_id_column,
    16: _add_task_step_rework_feedback_column,
    17: _make_stage_supplement_source_optional,
    18: _add_task_archived_column,
    19: _add_workflow_run_recovery_columns,
    20: _add_coordinator_vision_model_column,
    21: _add_task_step_review_feedback_column,
    22: _create_gen_sessions_table,
    23: _add_gen_sessions_engine_state_column,
    24: _add_coordinator_engine_state_column,
    25: _add_coordinator_thinking_effort_column,
    26: _create_schedule_tables,
    27: _create_statistics_indexes,
    28: _add_task_step_review_session_id_column,
    29: _add_workflow_sort_order_column,
    30: _create_task_shares_table,
    31: _make_task_shares_password_nullable,
    32: _create_chat_session_tables,
    33: _add_chat_session_sort_order_column,
    34: _add_chat_session_permission_mode_column,
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

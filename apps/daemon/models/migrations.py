"""Latest-schema bootstrap for per-project SQLite databases.

New projects and existing projects converge on the same code path: tables
are created directly from the current model definitions (idempotent), the
dashboard statistics indexes are recreated, and the schema_version row
records the current baseline. The historical incremental migration chain
was removed — `schema_version` no longer counts migration steps, it only
marks a database as bootstrapped against the current schema (0).
"""

import peewee as pw

from models.base import db_proxy
from models.schema import SchemaVersion

LATEST_SCHEMA_VERSION = 0

# Dashboard statistics + hot-query indexes.  Model declarations in
# ``Meta.indexes`` cover fresh databases; these statements converge existing
# per-project databases onto the same schema (idempotent).
_EXTRA_INDEXES = (
    "CREATE INDEX IF NOT EXISTS tasks_created_at ON tasks(created_at)",
    "CREATE INDEX IF NOT EXISTS tasks_workflow_created ON tasks(workflow_id, created_at)",
    "CREATE INDEX IF NOT EXISTS workflow_runs_started_at ON workflow_runs(started_at)",
    "CREATE INDEX IF NOT EXISTS step_runs_started_at ON step_runs(started_at)",
    "CREATE INDEX IF NOT EXISTS review_runs_started_at ON review_runs(started_at)",
    "CREATE INDEX IF NOT EXISTS message_started_at ON message(started_at)",
    # Hot-query indexes — names match the indexes Peewee generates from the
    # model ``Meta.indexes`` declarations (model-class + column names), so
    # fresh and pre-existing databases converge to identical schemas.
    "CREATE INDEX IF NOT EXISTS task_archived_updated_at ON tasks(archived, updated_at)",
    "CREATE INDEX IF NOT EXISTS task_workflow_id_archived_updated_at ON tasks(workflow_id, archived, updated_at)",
    "CREATE INDEX IF NOT EXISTS message_task_id_position ON message(task_id, position)",
    "CREATE INDEX IF NOT EXISTS message_task_id_created_at ON message(task_id, created_at)",
    "CREATE INDEX IF NOT EXISTS chatsession_project_id_sort_order ON chat_sessions(project_id, sort_order)",
    "CREATE INDEX IF NOT EXISTS workflowrun_status ON workflow_runs(status)",
    "CREATE INDEX IF NOT EXISTS schedule_status_next_run_at ON schedules(status, next_run_at)",
    "CREATE INDEX IF NOT EXISTS schedulerun_status ON schedule_runs(status)",
    "CREATE INDEX IF NOT EXISTS task_scheduled_start_state_at ON tasks(scheduled_start_state, scheduled_start_at)",
    "CREATE INDEX IF NOT EXISTS projectauditevent_upload_status_created_at "
    "ON project_audit_events(upload_status, created_at)",
)

# Older builds could create this quoted index before the scheduled-start
# columns existed.  SQLite accepted those names as constant expressions, then
# reported every existing task as missing after the columns were added.
_LEGACY_MALFORMED_INDEXES = (
    "task_scheduled_start_state_scheduled_start_at",
)

_ADDITIVE_COLUMNS = {
    "notification_hooks": {
        "markdown_template": "TEXT",
    },
    "project_audit_events": {
        "upload_status": "TEXT NOT NULL DEFAULT 'pending'",
        "upload_error": "TEXT",
    },
    "pending_message_inserts": {
        "author_id": "TEXT",
        "author_username": "TEXT",
        "author_name": "TEXT",
        "author_device_id": "TEXT",
        "author_device_name": "TEXT",
        "author_source": "TEXT",
    },
    "message": {
        "schedule_run_id": "TEXT",
        "author_id": "TEXT",
        "author_username": "TEXT",
        "author_name": "TEXT",
        "author_type": "TEXT",
        "initiated_by_user_id": "TEXT",
        "initiated_by_username": "TEXT",
        "author_device_id": "TEXT",
        "author_device_name": "TEXT",
        "event_log_path": "TEXT",
        "event_summary_json": "TEXT",
        "event_count": "INTEGER DEFAULT 0",
        "last_event_seq": "INTEGER DEFAULT 0",
        "step_run_id": "TEXT",
        "artifact_round": "INTEGER",
    },
    "chat_messages": {
        "author_id": "TEXT",
        "author_username": "TEXT",
        "author_name": "TEXT",
        "author_type": "TEXT",
        "initiated_by_user_id": "TEXT",
        "initiated_by_username": "TEXT",
        "author_device_id": "TEXT",
        "author_device_name": "TEXT",
        "event_log_path": "TEXT",
        "event_summary_json": "TEXT",
        "event_count": "INTEGER DEFAULT 0",
        "last_event_seq": "INTEGER DEFAULT 0",
    },
    "review_runs": {
        "reviewer_id": "TEXT",
        "reviewer_name": "TEXT",
        "reviewer_device_id": "TEXT",
        "reviewer_device_name": "TEXT",
    },
    "chat_sessions": {
        "role_binding_json": "TEXT",
        "role_checkpoint_json": "TEXT",
        "archived": "INTEGER NOT NULL DEFAULT 0",
        "vision_model": "TEXT",
        "parent_session_id": "TEXT",
        "forked_from_message_id": "TEXT",
        "fork_context_mode": "TEXT",
        "fork_context_json": "TEXT",
        "fork_status": "TEXT DEFAULT 'ready'",
    },
    "gen_sessions": {
        "vision_model": "TEXT",
    },
    "schedules": {
        "target_type": "TEXT NOT NULL DEFAULT 'project'",
        "target_task_id": "TEXT",
        "instruction": "TEXT",
        "stop_condition": "TEXT NOT NULL DEFAULT 'manual'",
        "notification_json": 'TEXT NOT NULL DEFAULT \'{"enabled": false}\'',
    },
    "schedule_runs": {"created_tasks_json": "TEXT", "coordinator_turn_id": "TEXT", "instruction": "TEXT", "notification_json": "TEXT", "notification_status": "TEXT NOT NULL DEFAULT 'pending'", "notification_error": "TEXT"},
    "coordinator_turns": {
        "execution_scope": "TEXT NOT NULL DEFAULT 'main'",
        "schedule_run_id": "TEXT",
    },
    "tasks": {
        "status": "TEXT NOT NULL DEFAULT 'ready'",
        "status_reason": "TEXT",
        "active_workflow_run_id": "TEXT",
        "workflow_overrides_json": "TEXT",
        "queued_run_json": "TEXT",
        "creator_id": "TEXT",
        "creator_username": "TEXT",
        "creator_name": "TEXT",
        "creator_device_id": "TEXT",
        "creator_device_name": "TEXT",
        "scheduled_start_at": "DATETIME",
        "scheduled_start_state": "TEXT",
        "scheduled_start_error": "TEXT",
        "source_dispatch_id": "TEXT",
        "source_project_id": "TEXT",
        "source_task_id": "TEXT",
        "source_step_key": "TEXT",
        "input_manifest_json": "TEXT",
        "dispatch_lineage_json": "TEXT",
    },
    "taskstep": {
        "waiting_interactions_json": "TEXT",
        "execution_config_json": "TEXT",
        "pending_handoff_json": "TEXT",
        "session_provider": "TEXT",
    },
    "workflow_runs": {
        "task_id": "TEXT",
        "workflow_snapshot_json": "TEXT NOT NULL DEFAULT '{}'",
        "owner_id": "TEXT",
        "heartbeat_at": "DATETIME",
        "routing_state_json": "TEXT",
        "trigger_source": "TEXT",
        "initiated_by_user_id": "TEXT",
        "initiated_by_username": "TEXT",
        "initiated_by_name": "TEXT",
        "initiated_by_device_id": "TEXT",
        "initiated_by_device_name": "TEXT",
    },
    "step_runs": {
        "artifact_round": "INTEGER",
        "input_rounds_json": "TEXT",
        "input_snapshot_json": "TEXT",
        "io_contract_json": "TEXT",
    },
    "stage_supplements": {
        "origin": "TEXT",
    },
    "task_shares": {
        "password_ciphertext": "TEXT",
        "mode": "TEXT DEFAULT 'read_only'",
        "expires_at": "DATETIME",
    },
}


def migrate_database(db: pw.SqliteDatabase) -> int:
    """Ensure an open database matches the current model schema.

    Creates any missing tables/columns from the current models, recreates
    the dashboard statistics and hot-query indexes, and records the baseline
    version.
    Returns LATEST_SCHEMA_VERSION.
    """
    # Local import avoids the models/__init__ ↔ models/migrations import cycle.
    from models import ALL_MODELS

    db_proxy.initialize(db)

    # Existing tables must gain current model columns before Peewee recreates
    # model indexes. SQLite otherwise treats a quoted missing column as a
    # constant expression, so a unique index fails as soon as two legacy rows
    # exist (for example task_source_dispatch_id).
    tables = set(db.get_tables())
    for table_name, columns in _ADDITIVE_COLUMNS.items():
        if table_name not in tables:
            continue
        existing = {column.name for column in db.get_columns(table_name)}
        for column_name, column_type in columns.items():
            if column_name not in existing:
                db.execute_sql(
                    f'ALTER TABLE "{table_name}" ADD COLUMN "{column_name}" {column_type}'
                )
    db.create_tables(ALL_MODELS, safe=True)
    # Legacy paused conflated review waits, failures and explicit user stops.
    # Only migrate ambiguous terminal snapshots; live runners own recovery.
    from models import Task
    from services.task_state import reconcile_task_state
    candidates = list(Task.select(Task.id).where(Task.status.in_(['paused', 'stopped']) & Task.status_reason.is_null()))
    for candidate in candidates:
        reconcile_task_state(Task.get_by_id(candidate.id), settled=True)
    # Old runners used ready for both unstarted and successfully finished tasks.
    # Only the task's current run is authoritative; an older success may have
    # been followed by a failed or interrupted rerun. Preserve timestamps.
    db.execute_sql(
        "UPDATE tasks SET status = 'completed' WHERE status = 'ready' "
        "AND EXISTS (SELECT 1 FROM workflow_runs r "
        "WHERE r.id = tasks.active_workflow_run_id AND r.task_id = tasks.id "
        "AND r.status = 'succeeded')"
    )
    # Full workflow definitions are no longer execution state.  Keep the
    # legacy NOT NULL column small for compatibility with existing SQLite
    # tables and make their pages reusable without running a blocking VACUUM.
    if "workflow_runs" in tables:
        db.execute_sql(
            "UPDATE workflow_runs SET workflow_snapshot_json = '{}' "
            "WHERE workflow_snapshot_json IS NOT NULL "
            "AND workflow_snapshot_json != '{}'"
        )
    for statement in _EXTRA_INDEXES:
        db.execute_sql(statement)
    for index_name in _LEGACY_MALFORMED_INDEXES:
        db.execute_sql(f'REINDEX "{index_name}"')
    (
        SchemaVersion.insert(id=1, version=LATEST_SCHEMA_VERSION)
        .on_conflict(
            conflict_target=[SchemaVersion.id],
            update={SchemaVersion.version: LATEST_SCHEMA_VERSION},
        )
        .execute()
    )
    return LATEST_SCHEMA_VERSION

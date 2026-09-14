"""Database schema bootstrap behavior exercised through the public model interface."""


def test_init_db_records_latest_schema_version(tmp_path):
    """A freshly initialized project records the schema version it uses."""
    from models import LATEST_SCHEMA_VERSION, SchemaVersion, init_db

    db = init_db(str(tmp_path / "workstep.db"))
    try:
        assert SchemaVersion.get_by_id(1).version == LATEST_SCHEMA_VERSION
        columns = {column.name for column in db.get_columns("tasks")}
        assert "coordinator_fast_model" in columns
        assert "coordinator_vision_model" in columns
    finally:
        db.close()


def test_init_db_creates_latest_schema_for_fresh_projects(tmp_path):
    """A fresh project database contains every model table and current columns."""
    from models import ALL_MODELS, LATEST_SCHEMA_VERSION, SchemaVersion, init_db

    db = init_db(str(tmp_path / "workstep.db"))
    try:
        assert SchemaVersion.get_by_id(1).version == LATEST_SCHEMA_VERSION
        tables = set(db.get_tables())
        assert {model._meta.table_name for model in ALL_MODELS} <= tables

        tasks = {column.name for column in db.get_columns("tasks")}
        assert "coordinator_provider_id" in tasks
        assert "coordinator_thinking_effort" in tasks
        assert "archived" in tasks
        assert "next_message_sequence" in tasks

        chat_sessions = {column.name for column in db.get_columns("chat_sessions")}
        assert "provider_id" in chat_sessions
        assert "permission_mode" in chat_sessions
        assert "sort_order" in chat_sessions

        workflows = {column.name for column in db.get_columns("workflows")}
        assert "sort_order" in workflows
    finally:
        db.close()


def test_workflow_run_persists_the_workflow_snapshot(tmp_path):
    """A workflow run keeps the task and exact definition used for that run."""
    from datetime import datetime, timezone
    import json
    import time
    import uuid

    from models import Task, WorkflowRun, init_db

    db = init_db(str(tmp_path / "workstep.db"))
    try:
        now = int(time.time())
        task = Task.create(
            id=str(uuid.uuid4()),
            title="Run workflow",
            cwd="/tmp/project",
            created_at=now,
            updated_at=now,
        )
        snapshot = {"schemaVersion": 1, "nodes": [{"key": "req"}], "edges": []}

        run = WorkflowRun.create(
            id=str(uuid.uuid4()),
            task=task,
            workflow_schema_version=1,
            workflow_snapshot_json=json.dumps(snapshot),
            started_at=now,
        )

        fetched = WorkflowRun.get_by_id(run.id)
        assert fetched.task.id == task.id
        assert fetched.status == "running"
        assert json.loads(fetched.workflow_snapshot_json) == snapshot
        assert fetched.started_at == datetime.fromtimestamp(now, timezone.utc)
        assert fetched.ended_at is None
    finally:
        db.close()


def test_step_run_keeps_each_attempt_separate(tmp_path):
    """Retries create distinct step-run records under one workflow run."""
    import time
    import uuid

    from models import StepRun, Task, WorkflowRun, init_db

    db = init_db(str(tmp_path / "workstep.db"))
    try:
        now = int(time.time())
        task = Task.create(
            id=str(uuid.uuid4()),
            title="Retry workflow step",
            cwd="/tmp/project",
            created_at=now,
            updated_at=now,
        )
        run = WorkflowRun.create(
            id=str(uuid.uuid4()),
            task=task,
            workflow_schema_version=1,
            workflow_snapshot_json="{}",
            started_at=now,
        )

        failed = StepRun.create(
            id=str(uuid.uuid4()),
            run=run,
            step_key="requirements",
            attempt=1,
            status="failed",
            engine="codex",
            model="gpt-test",
            error="process exited",
            started_at=now,
            ended_at=now + 1,
        )
        retry = StepRun.create(
            id=str(uuid.uuid4()),
            run=run,
            step_key="requirements",
            attempt=2,
            engine="codex",
            model="gpt-test",
            started_at=now + 2,
        )

        attempts = list(
            StepRun.select()
            .where(
                (StepRun.run == run)
                & (StepRun.step_key == "requirements")
            )
            .order_by(StepRun.attempt)
        )
        assert [step.id for step in attempts] == [failed.id, retry.id]
        assert attempts[0].error == "process exited"
        assert attempts[1].status == "running"
        assert attempts[1].ended_at is None
    finally:
        db.close()


def test_migrate_database_bootstraps_an_unbound_database(tmp_path):
    """migrate_database does not require callers to bind model globals."""
    import peewee as pw

    from models import LATEST_SCHEMA_VERSION, migrate_database

    db = pw.SqliteDatabase(str(tmp_path / "direct-bootstrap.db"))
    db.connect()
    try:
        assert migrate_database(db) == LATEST_SCHEMA_VERSION
        assert "workflow_runs" in db.get_tables()
        assert "step_runs" in db.get_tables()
    finally:
        db.close()


def test_migrate_database_adds_remote_actor_columns_to_existing_message_tables(tmp_path):
    """Existing per-project databases gain author snapshots without data loss."""
    import peewee as pw

    from models import migrate_database

    db = pw.SqliteDatabase(tmp_path / "legacy-author-columns.db")
    db.connect()
    db.execute_sql('CREATE TABLE "message" ("id" TEXT PRIMARY KEY, "started_at" DATETIME)')
    db.execute_sql('CREATE TABLE "chat_messages" ("id" TEXT PRIMARY KEY)')

    migrate_database(db)

    expected = {
        "author_id",
        "author_name",
        "author_device_id",
        "author_device_name",
    }
    assert expected.issubset({column.name for column in db.get_columns("message")})
    assert {
        "event_log_path",
        "event_summary_json",
        "event_count",
        "last_event_seq",
    }.issubset({column.name for column in db.get_columns("message")})
    chat_columns = {column.name for column in db.get_columns("chat_messages")}
    assert expected.issubset(chat_columns)
    assert {
        "event_log_path",
        "event_summary_json",
        "event_count",
        "last_event_seq",
    }.issubset(chat_columns)
    db.close()


def test_migrate_database_adds_reviewer_columns_to_existing_review_runs(tmp_path):
    """Existing review history gains reviewer snapshots without data loss."""
    import peewee as pw

    from models import migrate_database

    db = pw.SqliteDatabase(tmp_path / "legacy-reviewer-columns.db")
    db.connect()
    db.execute_sql(
        'CREATE TABLE "review_runs" ('
        '"id" TEXT PRIMARY KEY, "started_at" DATETIME)'
    )

    migrate_database(db)

    assert {
        "reviewer_id",
        "reviewer_name",
        "reviewer_device_id",
        "reviewer_device_name",
    }.issubset({column.name for column in db.get_columns("review_runs")})
    db.close()


def test_migrate_database_adds_dispatch_columns_before_unique_index(tmp_path):
    """Legacy task rows survive dispatch-column and unique-index migration."""
    import peewee as pw

    from models import migrate_database

    db = pw.SqliteDatabase(tmp_path / "legacy-dispatch-columns.db")
    db.connect()
    db.execute_sql(
        'CREATE TABLE "tasks" ('
        '"id" TEXT PRIMARY KEY, "archived" INTEGER, "workflow_id" TEXT, '
        '"scheduled_start_at" DATETIME, "scheduled_start_state" TEXT, '
        '"created_at" DATETIME, "updated_at" DATETIME)'
    )
    db.execute_sql('INSERT INTO "tasks" ("id") VALUES ("task-1"), ("task-2")')

    migrate_database(db)

    columns = {column.name for column in db.get_columns("tasks")}
    assert "source_dispatch_id" in columns
    indexes = {index.name for index in db.get_indexes("tasks")}
    assert "task_source_dispatch_id" in indexes
    assert db.execute_sql('SELECT COUNT(*) FROM "tasks"').fetchone()[0] == 2
    db.close()


def test_migrate_database_repairs_index_created_before_scheduled_columns(tmp_path):
    """A legacy constant-expression index is rebuilt after its columns exist."""
    import peewee as pw

    from models import migrate_database

    db = pw.SqliteDatabase(tmp_path / "legacy-scheduled-index.db")
    db.connect()
    db.execute_sql(
        'CREATE TABLE "tasks" ('
        '"id" TEXT PRIMARY KEY, "archived" INTEGER, "workflow_id" TEXT, '
        '"created_at" DATETIME, "updated_at" DATETIME)'
    )
    db.execute_sql('INSERT INTO "tasks" ("id") VALUES ("task-1"), ("task-2")')
    db.execute_sql(
        'CREATE INDEX "task_scheduled_start_state_scheduled_start_at" '
        'ON "tasks" ("scheduled_start_state", "scheduled_start_at")'
    )
    db.execute_sql('ALTER TABLE "tasks" ADD COLUMN "scheduled_start_at" DATETIME')
    db.execute_sql('ALTER TABLE "tasks" ADD COLUMN "scheduled_start_state" TEXT')

    assert "missing from index" in db.execute_sql(
        "PRAGMA integrity_check"
    ).fetchone()[0]

    migrate_database(db)

    assert db.execute_sql("PRAGMA integrity_check").fetchone()[0] == "ok"
    db.close()


_HOT_QUERY_INDEXES = {
    "message": {"message_task_id_sequence", "message_task_id_channel_sequence",
                "message_task_id_position", "message_task_id_created_at"},
    "chat_messages": {"chatmessage_session_id_created_at"},
    "tasks": {"task_archived_updated_at", "task_workflow_id_archived_updated_at"},
    "chat_sessions": {"chatsession_project_id_sort_order"},
    "workflow_runs": {"workflowrun_status"},
    "schedules": {"schedule_status_next_run_at"},
    "schedule_runs": {"schedulerun_status"},
}


def test_init_db_creates_hot_query_indexes(tmp_path):
    """Conversation and board queries are backed by composite indexes."""
    from models import init_db

    db = init_db(str(tmp_path / "workstep.db"))
    try:
        for table, expected in _HOT_QUERY_INDEXES.items():
            names = {index.name for index in db.get_indexes(table)}
            assert expected <= names, f"missing indexes on {table}"
    finally:
        db.close()


def test_migrate_database_adds_hot_query_indexes_to_existing_tables(tmp_path):
    """Existing databases converge onto the same indexes, idempotently."""
    import peewee as pw

    from models import migrate_database

    db = pw.SqliteDatabase(tmp_path / "legacy-indexes.db")
    db.connect()
    db.execute_sql('CREATE TABLE "message" ("id" TEXT PRIMARY KEY, "task_id" TEXT,'
                   ' "position" INTEGER, "created_at" DATETIME, "started_at" DATETIME)')
    db.execute_sql('CREATE TABLE "chat_messages" ("id" TEXT PRIMARY KEY,'
                   ' "session_id" TEXT, "created_at" DATETIME)')
    db.execute_sql('CREATE TABLE "tasks" ("id" TEXT PRIMARY KEY, "archived" INTEGER,'
                   ' "updated_at" DATETIME, "workflow_id" TEXT, "created_at" DATETIME)')
    db.execute_sql('CREATE TABLE "chat_sessions" ("id" TEXT PRIMARY KEY,'
                   ' "project_id" TEXT, "sort_order" INTEGER)')
    db.execute_sql('CREATE TABLE "workflow_runs" ("id" TEXT PRIMARY KEY,'
                   ' "status" TEXT, "started_at" DATETIME)')
    db.execute_sql('CREATE TABLE "schedules" ("id" TEXT PRIMARY KEY,'
                   ' "status" TEXT, "next_run_at" DATETIME)')
    db.execute_sql('CREATE TABLE "schedule_runs" ("id" TEXT PRIMARY KEY,'
                   ' "status" TEXT)')

    migrate_database(db)
    migrate_database(db)  # second pass must stay idempotent

    for table, expected in _HOT_QUERY_INDEXES.items():
        names = {index.name for index in db.get_indexes(table)}
        assert expected <= names, f"missing indexes on {table}"
    db.close()

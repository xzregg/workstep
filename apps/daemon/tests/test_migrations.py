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
        assert "queued_run_json" in tasks
        assert {
            "creator_id",
            "creator_username",
            "creator_name",
            "creator_device_id",
            "creator_device_name",
        }.issubset(tasks)

        chat_sessions = {column.name for column in db.get_columns("chat_sessions")}
        assert "provider_id" in chat_sessions
        assert "permission_mode" in chat_sessions
        assert "sort_order" in chat_sessions

        workflows = {column.name for column in db.get_columns("workflows")}
        assert "sort_order" in workflows

        task_shares = {column.name for column in db.get_columns("task_shares")}
        assert "mode" in task_shares

        workflow_runs = {
            column.name for column in db.get_columns("workflow_runs")
        }
        assert "routing_state_json" in workflow_runs
        assert "trigger_source" in workflow_runs
        assert {
            "initiated_by_user_id", "initiated_by_username", "initiated_by_name",
            "initiated_by_device_id", "initiated_by_device_name",
        }.issubset(workflow_runs)
        step_runs = {column.name for column in db.get_columns("step_runs")}
        assert "input_snapshot_json" in step_runs
        assert "io_contract_json" in step_runs
        stage_supplements = {
            row[1] for row in db.execute_sql("PRAGMA table_info(stage_supplements)")
        }
        assert "origin" in stage_supplements

        pending = {
            column.name for column in db.get_columns("pending_message_inserts")
        }
        assert pending == {
            "id",
            "target_message_id",
            "content",
            "position",
            "username",
            "author_id",
            "author_username",
            "author_name",
            "author_device_id",
            "author_device_name",
            "author_source",
            "created_at",
            "updated_at",
        }
    finally:
        db.close()


def test_legacy_pending_insert_keeps_unknown_author_after_migration(tmp_path):
    import peewee
    from models.migrations import migrate_database

    db = peewee.SqliteDatabase(str(tmp_path / "legacy-pending.db"))
    db.connect()
    try:
        db.execute_sql(
            'CREATE TABLE "pending_message_inserts" ('
            '"id" TEXT PRIMARY KEY, "target_message_id" TEXT, "content" TEXT, '
            '"position" INTEGER, "username" TEXT, '
            '"created_at" DATETIME, "updated_at" DATETIME)'
        )
        db.execute_sql(
            'INSERT INTO "pending_message_inserts" '
            '("id", "target_message_id", "content", "position", "username") '
            'VALUES ("legacy", "reply", "old", 0, "Old Name")'
        )
        migrate_database(db)
        assert db.execute_sql(
            'SELECT username, author_id, author_username '
            'FROM "pending_message_inserts" WHERE id = ?', ("legacy",),
        ).fetchone() == ("Old Name", None, None)
    finally:
        db.close()


def test_workflow_run_uses_only_the_legacy_empty_snapshot_value(tmp_path):
    """New runs do not need a duplicated workflow definition."""
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
        run = WorkflowRun.create(
            id=str(uuid.uuid4()),
            task=task,
            workflow_schema_version=1,
            started_at=now,
        )

        fetched = WorkflowRun.get_by_id(run.id)
        assert fetched.task.id == task.id
        assert fetched.status == "running"
        assert json.loads(fetched.workflow_snapshot_json) == {}
        assert fetched.started_at == datetime.fromtimestamp(now, timezone.utc)
        assert fetched.ended_at is None
    finally:
        db.close()


def test_migration_discards_legacy_full_workflow_snapshots(tmp_path):
    import json
    import time
    import uuid

    from models import Task, WorkflowRun, init_db
    from models.migrations import migrate_database

    db = init_db(str(tmp_path / "workstep.db"))
    try:
        now = int(time.time())
        task = Task.create(
            id=str(uuid.uuid4()),
            title="Legacy snapshot",
            cwd="/tmp/project",
            created_at=now,
            updated_at=now,
        )
        run = WorkflowRun.create(
            id=str(uuid.uuid4()),
            task=task,
            workflow_schema_version=1,
            workflow_snapshot_json=json.dumps({
                "nodes": [{"type": "build", "prompt": "large prompt"}],
            }),
            started_at=now,
        )

        migrate_database(db)

        assert WorkflowRun.get_by_id(run.id).workflow_snapshot_json == "{}"
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
    db.execute_sql('INSERT INTO "message" ("id") VALUES (?)', ("legacy-task",))
    db.execute_sql('INSERT INTO "chat_messages" ("id") VALUES (?)', ("legacy-chat",))

    migrate_database(db)

    expected = {
        "author_id",
        "author_name",
        "author_device_id",
        "author_device_name",
        "author_username",
        "author_type",
        "initiated_by_user_id",
        "initiated_by_username",
    }
    assert expected.issubset({column.name for column in db.get_columns("message")})
    assert {
        "event_log_path",
        "event_summary_json",
        "event_count",
        "last_event_seq",
        "step_run_id",
        "artifact_round",
    }.issubset({column.name for column in db.get_columns("message")})
    chat_columns = {column.name for column in db.get_columns("chat_messages")}
    assert expected.issubset(chat_columns)
    for table_name in ("message", "chat_messages"):
        legacy = db.execute_sql(
            f'SELECT author_username, author_type, initiated_by_user_id, '
            f'initiated_by_username FROM "{table_name}"'
        ).fetchone()
        assert legacy == (None, None, None, None)
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
    assert "queued_run_json" in columns
    assert {
        "creator_id",
        "creator_username",
        "creator_name",
        "creator_device_id",
        "creator_device_name",
    }.issubset(columns)
    assert db.execute_sql(
        'SELECT creator_username FROM "tasks" WHERE id = ?', ("task-1",)
    ).fetchone()[0] is None
    assert db.execute_sql(
        'SELECT queued_run_json FROM "tasks" WHERE id = ?', ("task-1",)
    ).fetchone()[0] is None
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
    db.execute_sql('INSERT INTO "workflow_runs" ("id") VALUES ("legacy-run")')
    db.execute_sql('CREATE TABLE "schedules" ("id" TEXT PRIMARY KEY,'
                   ' "status" TEXT, "next_run_at" DATETIME)')
    db.execute_sql('CREATE TABLE "schedule_runs" ("id" TEXT PRIMARY KEY,'
                   ' "status" TEXT)')

    migrate_database(db)
    migrate_database(db)  # second pass must stay idempotent

    assert db.execute_sql(
        'SELECT initiated_by_username FROM "workflow_runs" WHERE id = ?',
        ("legacy-run",),
    ).fetchone()[0] is None
    assert db.execute_sql(
        'SELECT trigger_source FROM "workflow_runs" WHERE id = ?',
        ("legacy-run",),
    ).fetchone()[0] is None

    for table, expected in _HOT_QUERY_INDEXES.items():
        names = {index.name for index in db.get_indexes(table)}
        assert expected <= names, f"missing indexes on {table}"
    db.close()

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
    assert expected.issubset({column.name for column in db.get_columns("chat_messages")})
    db.close()

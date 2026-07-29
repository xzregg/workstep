"""Database migration behavior exercised through the public model interface."""


def test_init_db_records_latest_schema_version(tmp_path):
    """A freshly initialized project records the schema version it uses."""
    from models import LATEST_SCHEMA_VERSION, SchemaVersion, init_db

    db = init_db(str(tmp_path / "workstep.db"))
    try:
        assert SchemaVersion.get_by_id(1).version == LATEST_SCHEMA_VERSION
    finally:
        db.close()


def test_workflow_run_persists_the_workflow_snapshot(tmp_path):
    """A workflow run keeps the task and exact definition used for that run."""
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
        assert fetched.started_at == now
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


def test_init_db_migrates_a_legacy_database_idempotently(tmp_path):
    """Opening an old three-table database upgrades it once without data loss."""
    import time

    import peewee as pw

    from models import (
        LATEST_SCHEMA_VERSION,
        Message,
        SchemaVersion,
        Task,
        TaskStep,
        db_proxy,
        init_db,
    )

    db_path = str(tmp_path / "legacy.db")
    legacy_db = pw.SqliteDatabase(db_path, pragmas={"foreign_keys": 1})
    db_proxy.initialize(legacy_db)
    legacy_db.connect()
    legacy_db.create_tables([Task, TaskStep, Message])
    now = int(time.time())
    Task.create(
        id="legacy-task",
        title="Keep me",
        cwd="/tmp/legacy",
        created_at=now,
        updated_at=now,
    )
    assert set(legacy_db.get_tables()) == {"message", "task", "taskstep"}
    legacy_db.close()

    migrated_db = init_db(db_path)
    migrated_db.close()
    reopened_db = init_db(db_path)
    try:
        assert {
            "message",
            "schema_version",
            "step_runs",
            "task",
            "taskstep",
            "workflow_runs",
        }.issubset(reopened_db.get_tables())
        assert Task.get_by_id("legacy-task").title == "Keep me"
        assert SchemaVersion.select().count() == 1
        assert SchemaVersion.get_by_id(1).version == LATEST_SCHEMA_VERSION
    finally:
        reopened_db.close()


def test_migration_runner_binds_the_database_it_is_given(tmp_path):
    """The migration interface does not require callers to bind model globals."""
    import peewee as pw

    from models import LATEST_SCHEMA_VERSION, migrate_database

    db = pw.SqliteDatabase(str(tmp_path / "direct-migration.db"))
    db.connect()
    try:
        assert migrate_database(db) == LATEST_SCHEMA_VERSION
        assert "workflow_runs" in db.get_tables()
        assert "step_runs" in db.get_tables()
    finally:
        db.close()

"""Database migration behavior exercised through the public model interface."""


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


def test_schema_v11_converts_all_project_times_to_datetime(tmp_path):
    """Every project-table timestamp migrates from epoch seconds to DATETIME."""
    from datetime import datetime, timezone
    import json

    import peewee as pw
    from playhouse.migrate import SqliteMigrator, migrate

    from models import (
        Message,
        ReviewRun,
        SchemaVersion,
        StepRun,
        Task,
        TaskStep,
        Workflow,
        WorkflowRun,
        init_db,
    )
    from models.migrations import ALL_DATETIME_COLUMNS, LATEST_SCHEMA_VERSION

    db_path = str(tmp_path / "workstep.db")
    db = init_db(db_path)
    task = Task.create(
        id="task-datetime",
        title="Datetime migration",
        cwd="/tmp/project",
        created_at=1_700_000_000,
        updated_at=1_700_000_100,
    )
    TaskStep.create(
        task=task,
        step_key="req",
        status="passed",
        started_at=1_700_000_000,
        ended_at=1_700_000_100,
    )
    workflow_run = WorkflowRun.create(
        id="workflow-run-datetime",
        task=task,
        status="succeeded",
        workflow_schema_version=1,
        workflow_snapshot_json=json.dumps({}),
        started_at=1_700_000_000,
        ended_at=1_700_000_100,
    )
    step_run = StepRun.create(
        id="step-run-datetime",
        run=workflow_run,
        step_key="req",
        attempt=1,
        status="succeeded",
        started_at=1_700_000_000,
        ended_at=1_700_000_100,
    )
    review_run = ReviewRun.create(
        id="review-run-datetime",
        workflow_run=workflow_run,
        step_run=step_run,
        task=task,
        step_key="req",
        mode="auto",
        status="passed",
        decided_at=1_700_000_000,
        started_at=1_700_000_000,
        ended_at=1_700_000_100,
    )
    Message.create(
        id="message-datetime",
        task=task,
        step_key="req",
        role="assistant",
        position=1,
        created_at=1_700_000_000,
        started_at=1_700_000_000,
        ended_at=1_700_000_100,
    )
    Workflow.create(
        id="workflow-datetime",
        name="Datetime workflow",
        steps_json="{}",
        created_at=1_700_000_000,
        updated_at=1_700_000_100,
    )

    migrator = SqliteMigrator(db)
    db.execute_sql("PRAGMA foreign_keys = OFF")
    for table, column_names in ALL_DATETIME_COLUMNS.items():
        for column_name in column_names:
            migrate(migrator.alter_column_type(
                table, column_name, pw.IntegerField(null=True)
            ))
            db.execute_sql(
                f'UPDATE "{table}" SET "{column_name}" = ?',
                (
                    1_700_000_100
                    if column_name in {"ended_at", "updated_at"}
                    else 1_700_000_000,
                ),
            )
    SchemaVersion.update(version=9).where(SchemaVersion.id == 1).execute()
    db.execute_sql("PRAGMA foreign_keys = ON")
    db.close()

    migrated_db = init_db(db_path)
    try:
        for table, column_names in ALL_DATETIME_COLUMNS.items():
            column_types = {
                column.name: column.data_type.upper()
                for column in migrated_db.get_columns(table)
            }
            assert all(column_types[name] == "DATETIME" for name in column_names)

        expected_start = datetime.fromtimestamp(1_700_000_000, timezone.utc)
        expected_end = datetime.fromtimestamp(1_700_000_100, timezone.utc)
        records = [
            TaskStep.get_by_id((task.id, "req")),
            Message.get_by_id("message-datetime"),
            WorkflowRun.get_by_id("workflow-run-datetime"),
            StepRun.get_by_id("step-run-datetime"),
            ReviewRun.get_by_id("review-run-datetime"),
        ]
        assert all(record.started_at == expected_start for record in records)
        assert all(record.ended_at == expected_end for record in records)
        migrated_task = Task.get_by_id(task.id)
        migrated_message = Message.get_by_id("message-datetime")
        migrated_workflow = Workflow.get_by_id("workflow-datetime")
        migrated_review = ReviewRun.get_by_id(review_run.id)
        assert migrated_task.created_at == expected_start
        assert migrated_task.updated_at == expected_end
        assert migrated_message.created_at == expected_start
        assert migrated_workflow.created_at == expected_start
        assert migrated_workflow.updated_at == expected_end
        assert migrated_review.decided_at == expected_start
        assert SchemaVersion.get_by_id(1).version == LATEST_SCHEMA_VERSION
        assert migrated_db.execute_sql("PRAGMA foreign_key_check").fetchall() == []
    finally:
        migrated_db.close()


def test_schema_v17_makes_stage_supplement_source_optional(tmp_path):
    """Live stage guidance (as_guidance) may exist without a coordinator proposal."""
    import peewee as pw
    from playhouse.migrate import SqliteMigrator, migrate

    from models import SchemaVersion, Task, init_db
    from models import StageSupplement
    from models.migrations import LATEST_SCHEMA_VERSION

    db_path = str(tmp_path / "workstep.db")
    db = init_db(db_path)
    task = Task.create(
        id="task-supplement-optional",
        title="Supplement",
        cwd="/tmp/project",
        created_at=1,
        updated_at=1,
    )
    # Simulate the pre-v17 schema where the FK is NOT NULL.
    migrator = SqliteMigrator(db)
    migrate(migrator.alter_column_type(
        "stage_supplements", "source_proposal_id", pw.IntegerField()
    ))
    SchemaVersion.update(version=16).where(SchemaVersion.id == 1).execute()
    db.close()

    migrated_db = init_db(db_path)
    try:
        assert SchemaVersion.get_by_id(1).version == LATEST_SCHEMA_VERSION
        column = next(
            column
            for column in migrated_db.get_columns("stage_supplements")
            if column.name == "source_proposal_id"
        )
        assert column.null is True
        # Guidance created without a proposal is allowed after migration.
        now = 1_700_000_000
        StageSupplement.create(
            id="supplement-optional",
            task=task,
            step_key="do",
            content="请改用中文输出",
            source_proposal=None,
            created_sequence=0,
            created_at=now,
        )
        fetched = StageSupplement.get_by_id("supplement-optional")
        assert fetched.source_proposal is None
    finally:
        migrated_db.close()


def test_schema_v20_adds_coordinator_vision_model_column(tmp_path):
    """An existing v19 project gains the coordinator vision model column."""
    from models import SchemaVersion, init_db
    from models.migrations import LATEST_SCHEMA_VERSION

    db_path = str(tmp_path / "workstep.db")
    db = init_db(db_path)
    SchemaVersion.update(version=19).where(SchemaVersion.id == 1).execute()
    db.close()

    migrated_db = init_db(db_path)
    try:
        assert SchemaVersion.get_by_id(1).version == LATEST_SCHEMA_VERSION
        columns = {column.name for column in migrated_db.get_columns("tasks")}
        assert "coordinator_vision_model" in columns
    finally:
        migrated_db.close()


def test_schema_v19_adds_workflow_run_recovery_columns(tmp_path):
    """Recovery markers persist so the UI can show a resume hint."""
    from models import SchemaVersion, Task, WorkflowRun, init_db
    from models.migrations import LATEST_SCHEMA_VERSION

    db_path = str(tmp_path / "workstep.db")
    db = init_db(db_path)
    task = Task.create(
        id="task-recovery-markers",
        title="Recovery markers",
        cwd="/tmp/project",
        created_at=1,
        updated_at=1,
    )
    run = WorkflowRun.create(
        id="run-recovery-markers",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json="{}",
        started_at=1,
    )
    # Simulate the pre-v19 schema without the recovery columns.
    db.execute_sql('ALTER TABLE workflow_runs DROP COLUMN recovered_at')
    db.execute_sql('ALTER TABLE workflow_runs DROP COLUMN recovered_count')
    SchemaVersion.update(version=18).where(SchemaVersion.id == 1).execute()
    db.close()

    migrated_db = init_db(db_path)
    try:
        assert SchemaVersion.get_by_id(1).version == LATEST_SCHEMA_VERSION
        columns = {
            column.name for column in migrated_db.get_columns("workflow_runs")
        }
        assert "recovered_at" in columns
        assert "recovered_count" in columns
        migrated_run = WorkflowRun.get_by_id(run.id)
        assert migrated_run.recovered_count == 0
        assert migrated_run.recovered_at is None
    finally:
        migrated_db.close()


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
    # Simulate old database with legacy table name "task" (before rename to "tasks")
    legacy_db.execute_sql("""CREATE TABLE IF NOT EXISTS task (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        cwd TEXT DEFAULT '',
        status TEXT DEFAULT 'ready',
        engine TEXT,
        model TEXT,
        pipeline_version TEXT,
        review_overrides_json TEXT,
        created_at INTEGER,
        updated_at INTEGER
    )""")
    legacy_db.create_tables([TaskStep, Message])
    now = int(time.time())
    legacy_db.execute_sql(
        "INSERT INTO task (id, title, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ("legacy-task", "Keep me", "/tmp/legacy", now, now)
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
            "tasks",
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

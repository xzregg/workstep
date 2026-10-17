"""Task-targeted schedules preserve project scheduling and coordinator isolation."""
from datetime import datetime, timedelta, timezone
import pytest


def test_minute_preview_uses_anchor():
    from services.schedule_rules import preview_rule
    now = datetime(2026, 10, 16, 0, 3, tzinfo=timezone.utc)
    rule = {"kind": "minutes", "every": 10, "timezone": "UTC", "anchor_at": now.isoformat()}
    assert preview_rule(rule, now=now)["next_runs"][0] == (now + timedelta(minutes=10)).isoformat()
    assert preview_rule(rule, now=now + timedelta(minutes=23))["next_runs"][0] == (now + timedelta(minutes=30)).isoformat()


@pytest.mark.parametrize("every", [0, -1, 10081, 1.5, True, "bad"])
def test_minute_preview_rejects_invalid_intervals(every):
    from services.schedule_rules import preview_rule, ScheduleValidationError
    with pytest.raises(ScheduleValidationError):
        preview_rule({"kind": "minutes", "every": every, "timezone": "UTC"})


def test_task_schedule_crud_and_history(tmp_path):
    from services.project import ProjectManager
    from services.schedule import ScheduleModule, ScheduleValidationError
    from models import Task, ScheduleRun
    from models.fields import utc_now
    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    module = ScheduleModule(manager, None, None)
    with manager.activate_project_by_id(project.id):
        task = Task.create(id="target", title="目标", cwd=str(project.path), status="pending", created_at=utc_now(), updated_at=utc_now())
        row = module.create(project.id, name="汇报", target_type="task", target_task_id=task.id,
                            instruction="汇报并通过 CLI 发送", rule={"kind":"minutes", "every":10, "timezone":"UTC"})
        assert row["target_task_id"] == task.id
        assert row["instruction"] == "汇报并通过 CLI 发送"
        assert module.list(project.id, task_id=task.id)[0]["id"] == row["id"]
        assert module.list(project.id)[0]["target_task_title"] == "目标"
        task.title = "改名后的目标"
        task.save()
        assert module.list(project.id)[0]["target_task_title"] == "改名后的目标"
        assert module.pause(project.id, row["id"])["status"] == "paused"
        assert module.resume(project.id, row["id"])["status"] == "active"
        assert module.update(project.id, row["id"], instruction="检查阻塞")["instruction"] == "检查阻塞"
        with pytest.raises(ScheduleValidationError):
            module.update(project.id, row["id"], target_task_id="other")
        ScheduleRun.create(id="run", schedule=row["id"], scheduled_for=utc_now(), created_at=utc_now())
        module.delete(project.id, row["id"])
        assert ScheduleRun.get_by_id("run")
        assert module.list(project.id) == []


def test_task_archive_invalidates_only_its_rules_and_restore_does_not_resume(tmp_path):
    from services.project import ProjectManager
    from services.schedule import ScheduleModule
    from services.task import TaskService
    from models import Task
    from models.fields import utc_now
    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    module = ScheduleModule(manager, None, None)
    with manager.activate_project_by_id(project.id):
        for tid in ["a", "b"]:
            Task.create(id=tid, title=tid, cwd=str(project.path), created_at=utc_now(), updated_at=utc_now())
        rules = [module.create(project.id, name=tid, target_type="task", target_task_id=tid, instruction="检查", rule={"kind":"minutes","every":10,"timezone":"UTC"}) for tid in ["a", "b"]]
        service = TaskService(None)
        assert service.archive_task("a", project.id)
        assert module.get(project.id, rules[0]["id"])["status"] == "invalid"
        assert module.get(project.id, rules[1]["id"])["status"] == "active"
        assert service.unarchive_task("a", project.id)
        assert module.get(project.id, rules[0]["id"])["status"] == "invalid"
        assert module.resume(project.id, rules[0]["id"])["status"] == "active"


def test_task_terminal_uses_actual_ready_status_and_does_not_resume_automatically(tmp_path):
    from services.project import ProjectManager
    from services.schedule import ScheduleModule
    from services.task_schedule_runtime import reconcile_task_schedules
    from models import Task
    from models.fields import utc_now
    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    module = ScheduleModule(manager, None, None)
    with manager.activate_project_by_id(project.id):
        task = Task.create(id="a", title="a", cwd=str(project.path), created_at=utc_now(), updated_at=utc_now())
        rule = module.create(project.id, name="检查", target_type="task", target_task_id=task.id, instruction="检查", stop_condition="task_terminal", rule={"kind":"minutes","every":10,"timezone":"UTC"})
        from models import TaskStep
        TaskStep.create(task=task, step_key="a", status="passed", started_at=utc_now())
        task.status="ready"; task.save()
        reconcile_task_schedules(startup=False, current=utc_now())
        assert module.get(project.id,rule["id"])["status"] == "completed"
        task.status="running"; task.save()
        reconcile_task_schedules(startup=False, current=utc_now())
        assert module.get(project.id,rule["id"])["status"] == "completed"


def test_migration_adds_target_and_scope_defaults_to_old_database(tmp_path):
    from models import init_db, Schedule, CoordinatorTurn
    from models.fields import utc_now
    path = str(tmp_path / "old.db")
    db = init_db(path)
    Schedule.create(id="old", name="旧计划", workflow_id="flow", task_template_json='{"title":"旧任务"}', rule_json='{"kind":"daily","time":"09:00","timezone":"UTC"}', timezone="UTC", created_at=utc_now(), updated_at=utc_now())
    for table, columns in {"schedules":["target_type","target_task_id","instruction","stop_condition"], "schedule_runs":["coordinator_turn_id","instruction"], "coordinator_turns":["execution_scope","schedule_run_id"], "message":["schedule_run_id"]}.items():
        for column in columns:
            db.execute_sql(f'ALTER TABLE "{table}" DROP COLUMN "{column}"')
    db.close()
    db = init_db(path)
    try:
        old = Schedule.get_by_id("old")
        assert old.target_type == "project"
        assert old.stop_condition == "manual"
        assert old.target_task_id is None
        assert "execution_scope" in {column.name for column in db.get_columns("coordinator_turns")}
        assert "schedule_run_id" in {column.name for column in db.get_columns("message")}
    finally:
        db.close()

"""Project schedule behavior through the public schedule module interface."""

import asyncio
from datetime import datetime, timezone
import threading
import time

import pytest
from httpx import ASGITransport, AsyncClient


def test_preview_compiles_friendly_rules_and_returns_future_occurrences():
    from services.schedule import preview_rule

    preview = preview_rule(
        {
            "kind": "weekly",
            "weekdays": [1, 5],
            "time": "09:30",
            "timezone": "Asia/Shanghai",
        },
        now=datetime(2026, 8, 11, 0, 0, tzinfo=timezone.utc),
    )

    assert preview["cron_expression"] == "30 9 * * 1,5"
    assert preview["next_runs"][:2] == [
        "2026-08-14T01:30:00+00:00",
        "2026-08-17T01:30:00+00:00",
    ]


def test_preview_rejects_six_field_cron():
    from services.schedule import ScheduleValidationError, preview_rule

    with pytest.raises(ScheduleValidationError, match="five fields"):
        preview_rule({
            "kind": "cron",
            "expression": "0 0 9 * * 1",
            "timezone": "UTC",
        })


def test_preview_supports_hour_intervals_on_selected_weekdays():
    from services.schedule import preview_rule

    preview = preview_rule(
        {
            "kind": "interval",
            "every": 2,
            "unit": "hours",
            "weekdays": [1],
            "timezone": "Asia/Shanghai",
        },
        now=datetime(2026, 8, 11, 0, 0, tzinfo=timezone.utc),
    )

    assert preview["cron_expression"] is None
    assert preview["next_runs"][:2] == [
        "2026-08-16T16:00:00+00:00",
        "2026-08-16T18:00:00+00:00",
    ]


def test_preview_limits_recurring_rules_to_effective_date_range():
    from services.schedule import preview_rule

    preview = preview_rule(
        {
            "kind": "daily",
            "time": "09:00",
            "timezone": "Asia/Shanghai",
            "start_date": "2026-08-14",
            "end_date": "2026-08-14",
        },
        now=datetime(2026, 8, 11, 0, 0, tzinfo=timezone.utc),
    )

    assert preview["next_runs"] == ["2026-08-14T01:00:00+00:00"]


def test_schedule_models_are_created_by_project_migration(tmp_path):
    from models import Schedule, ScheduleRun, init_db

    db = init_db(str(tmp_path / "workstep.db"))
    try:
        assert {"schedules", "schedule_runs"}.issubset(set(db.get_tables()))
        indexes = db.get_indexes("schedule_runs")
        assert any(
            index.unique and index.columns == ["schedule_id", "scheduled_for"]
            for index in indexes
        )
        assert Schedule.table_exists()
        assert ScheduleRun.table_exists()
    finally:
        db.close()


def test_user_can_create_pause_and_resume_a_project_schedule(tmp_path, monkeypatch):
    from services.project import ProjectManager
    from services.schedule import ScheduleModule
    from models import ProjectAuditEvent, Schedule
    from services import project_audit

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    from services.project import DEFAULT_STEPS
    manager.create_workflow(project, "测试流程", DEFAULT_STEPS)
    workflow_id = project.default_workflow()["id"]
    module = ScheduleModule(manager, task_service=None, workflow_runtime=None)

    def create_schedule():
        return module.create(
            project.id,
            name="Weekly report",
            workflow_id=workflow_id,
            task_template={"title": "Prepare report", "description": "Summarize changes"},
            rule={
                "kind": "weekly",
                "weekdays": [1],
                "time": "09:00",
                "timezone": "Asia/Shanghai",
            },
        )

    with monkeypatch.context() as patcher:
        patcher.setattr(
            project_audit, "record_project_audit",
            lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("audit unavailable")),
        )
        with pytest.raises(RuntimeError, match="audit unavailable"):
            create_schedule()
    with manager.activate_project_by_id(project.id):
        assert Schedule.select().count() == 0
    created = create_schedule()

    assert created["status"] == "active"
    assert created["cron_expression"] == "0 9 * * 1"
    assert created["next_run_at"] is not None
    with monkeypatch.context() as patcher:
        patcher.setattr(
            project_audit, "record_project_audit",
            lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("audit unavailable")),
        )
        with pytest.raises(RuntimeError, match="audit unavailable"):
            module.pause(project.id, created["id"])
    with manager.activate_project_by_id(project.id):
        assert Schedule.get_by_id(created["id"]).status == "active"
    assert module.pause(project.id, created["id"])["status"] == "paused"
    resumed = module.resume(project.id, created["id"])
    assert resumed["status"] == "active"
    assert resumed["next_run_at"] is not None
    with monkeypatch.context() as patcher:
        patcher.setattr(
            project_audit, "record_project_audit",
            lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("audit unavailable")),
        )
        with pytest.raises(RuntimeError, match="audit unavailable"):
            module.update(project.id, created["id"], name="Updated report")
    assert module.get(project.id, created["id"])["name"] == "Weekly report"
    assert module.update(project.id, created["id"], name="Updated report")["name"] == "Updated report"
    with monkeypatch.context() as patcher:
        patcher.setattr(
            project_audit, "record_project_audit",
            lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("audit unavailable")),
        )
        with pytest.raises(RuntimeError, match="audit unavailable"):
            module.delete(project.id, created["id"])
    assert module.get(project.id, created["id"])["name"] == "Updated report"
    module.delete(project.id, created["id"])
    with manager.activate_project_by_id(project.id):
        assert Schedule.select().count() == 0
        events = list(ProjectAuditEvent.select().where(
            ProjectAuditEvent.metadata_json.contains(created["id"]),
        ).order_by(ProjectAuditEvent.created_at))
    assert [event.action for event in events] == [
        "schedule.create", "schedule.pause", "schedule.resume",
        "schedule.update", "schedule.delete",
    ]


@pytest.mark.anyio
async def test_schedule_pause_slow_sql_keeps_health_responsive(tmp_path, monkeypatch):
    import main
    from services.project import ProjectManager, DEFAULT_STEPS
    from services.schedule import ScheduleModule

    manager = ProjectManager()

    def prepare():
        project = manager.init_project(tmp_path / "project")
        manager.create_workflow(project, "Test flow", DEFAULT_STEPS)
        module = ScheduleModule(manager, task_service=None, workflow_runtime=None)
        created = module.create(
            project.id,
            name="Daily",
            workflow_id=project.default_workflow()["id"],
            task_template={"title": "Daily task"},
            rule={"kind": "daily", "time": "09:00", "timezone": "UTC"},
        )
        return project, module, created

    project, module, created = await asyncio.to_thread(prepare)
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "schedule_module", module)
    write_started = threading.Event()
    original_execute_sql = project.db.execute_sql

    def slow_schedule_write(sql, *args, **kwargs):
        if sql.upper().startswith("UPDATE") and "schedule" in sql and not write_started.is_set():
            write_started.set()
            time.sleep(0.35)
        return original_execute_sql(sql, *args, **kwargs)

    monkeypatch.setattr(project.db, "execute_sql", slow_schedule_write)
    async with AsyncClient(
        transport=ASGITransport(app=main.app), base_url="http://test",
    ) as client:
        pause_request = asyncio.create_task(client.post(
            f"/api/schedule/{created['id']}/pause?project_id={project.id}",
        ))
        assert await asyncio.to_thread(write_started.wait, 1)
        health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
        paused = await pause_request
    assert health.status_code == 200
    assert paused.status_code == 200
    assert paused.json()["status"] == "paused"


def test_user_can_create_schedule_without_a_task_title(tmp_path):
    from services.project import ProjectManager
    from services.schedule import ScheduleModule

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    from services.project import DEFAULT_STEPS
    manager.create_workflow(project, "测试流程", DEFAULT_STEPS)
    workflow_id = project.default_workflow()["id"]
    module = ScheduleModule(manager, task_service=None, workflow_runtime=None)

    created = module.create(
        project.id,
        name="Daily task",
        workflow_id=workflow_id,
        task_template={"description": "这是一个超过十个字的任务内容"},
        rule={
            "kind": "daily",
            "time": "09:00",
            "timezone": "Asia/Shanghai",
        },
    )

    assert created["task_template"]["title"] == "这是一个超过十个字的..."


@pytest.mark.anyio
async def test_schedule_api_creates_and_previews_through_the_module(monkeypatch):
    import main

    calls = []

    class ModuleStub:
        def create(self, project_id, **payload):
            calls.append((project_id, payload))
            return {"id": "schedule-1", "status": "active"}

    async def run_db(project_id, operation):
        return operation(object())

    monkeypatch.setattr(main, "schedule_module", ModuleStub(), raising=False)
    monkeypatch.setattr(main.project_manager, "run_db", run_db)
    async with AsyncClient(
        transport=ASGITransport(app=main.app), base_url="http://test"
    ) as client:
        preview = await client.post("/api/schedule/preview", json={
            "kind": "daily", "time": "08:15", "timezone": "UTC",
        })
        created = await client.post(
            "/api/schedule/create?project_id=project-1",
            json={
                "name": "Daily",
                "workflow_id": "workflow-1",
                "task_template": {"title": "Daily task"},
                "rule": {"kind": "daily", "time": "08:15", "timezone": "UTC"},
                "execution_mode": "immediate",
                "overlap_policy": "queue",
            },
        )

    assert preview.status_code == 200
    assert preview.json()["cron_expression"] == "15 8 * * *"
    assert created.json() == {"id": "schedule-1", "status": "active"}
    assert calls[0][0] == "project-1"
    assert calls[0][1]["execution_mode"] == "immediate"


@pytest.mark.anyio
async def test_due_manual_schedule_creates_a_task_and_execution_log(tmp_path):
    from services.project import ProjectManager
    from services.schedule import ScheduleModule
    from services.task import TaskService
    from streaming.bus import EventBus
    from services.remote_project import ActorSnapshot, _current_actor

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    from services.project import DEFAULT_STEPS
    await manager.run_db(project.id, lambda project: manager.create_workflow(project, "测试流程", DEFAULT_STEPS))
    workflow_id = project.default_workflow()["id"]
    actor_token = _current_actor.set(
        ActorSnapshot(
            "browser-1", "浏览器用户", "browser-device-1", "Chrome", "browser",
            username="browser-user",
        )
    )
    try:
        module = ScheduleModule(manager, TaskService(EventBus()), workflow_runtime=None)
        created = module.create(
            project.id,
            name="One shot",
            workflow_id=workflow_id,
            task_template={"title": "Scheduled work", "description": "Do it"},
            rule={"kind": "once", "run_at": "2099-01-02T03:04:00", "timezone": "UTC"},
            execution_mode="manual",
        )
    finally:
        _current_actor.reset(actor_token)

    await module.tick(datetime(2099, 1, 2, 3, 4, 1, tzinfo=timezone.utc))
    await module.wait_idle()

    runs = module.list_runs(project.id, created["id"])
    assert len(runs) == 1
    assert runs[0]["status"] == "created"
    assert runs[0]["task_id"]
    with manager.activate_project_by_id(project.id):
        from models import Task
        task = Task.get_by_id(runs[0]["task_id"])
        assert task.title == "Scheduled work"
        assert task.status == "ready"
        assert (
            task.creator_id,
            task.creator_username,
            task.creator_name,
            task.creator_device_id,
            task.creator_device_name,
        ) == (
            "browser-1", "browser-user", "浏览器用户", "browser-device-1", "Chrome",
        )

    public = module.get(project.id, created["id"])
    assert "_creator" not in public["task_template"]


@pytest.mark.anyio
async def test_schedule_run_finishes_when_task_is_created_even_if_workflow_keeps_running(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from threading import Event
    from time import sleep
    from models import ScheduleRun
    from models.fields import utc_now
    from services.project import ProjectManager
    from services.schedule import ScheduleModule

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    module = ScheduleModule(manager, None, None)
    schedule = module.create(
        project.id, name="Dynamic", workflow_id="",
        task_template={"mode": "agent", "instruction": "Create a task"},
        rule={"kind": "once", "run_at": "2099-01-02T03:04:00", "timezone": "UTC"},
    )

    def create_run():
        return ScheduleRun.create(
            id="scheduled-run", schedule=schedule["id"],
            scheduled_for=datetime(2099, 1, 2, 3, 4, tzinfo=timezone.utc),
            status="running", created_at=utc_now(),
        )

    await module._run_db(project.id, create_run)
    result = SimpleNamespace(
        task={"id": "created-task"}, run_handle=SimpleNamespace(id="workflow-run")
    )
    original_save = ScheduleRun.save
    slow_save_started = Event()

    def slow_save(self, *args, **kwargs):
        slow_save_started.set()
        sleep(0.15)
        return original_save(self, *args, **kwargs)

    monkeypatch.setattr(ScheduleRun, "save", slow_save)
    attach = asyncio.create_task(module._attach_task_result(project.id, "scheduled-run", result))
    assert await asyncio.to_thread(slow_save_started.wait, 1)
    await asyncio.wait_for(asyncio.sleep(0.01), timeout=0.08)
    assert not attach.done()
    await attach

    run = module.list_runs(project.id, schedule["id"])[0]
    assert run["status"] == "created"
    assert run["reason"] is None
    assert run["task_id"] == "created-task"
    assert run["workflow_run_id"] == "workflow-run"
    assert run["ended_at"] is not None


def test_schedule_history_reports_existing_created_tasks_as_created(tmp_path):
    from models import ScheduleRun
    from models.fields import utc_now
    from services.project import ProjectManager
    from services.schedule import ScheduleModule

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    module = ScheduleModule(manager, None, None)
    schedule = module.create(
        project.id, name="Dynamic", workflow_id="",
        task_template={"mode": "agent", "instruction": "Create a task"},
        rule={"kind": "once", "run_at": "2099-01-02T03:04:00", "timezone": "UTC"},
    )
    with manager.activate_project_by_id(project.id):
        ScheduleRun.create(
            id="old-run", schedule=schedule["id"],
            scheduled_for=datetime(2099, 1, 2, 3, 4, tzinfo=timezone.utc),
            status="failed", reason="paused", task_id="created-task",
            created_at=utc_now(),
        )

    run = module.list_runs(project.id, schedule["id"])[0]
    assert run["status"] == "created"
    assert run["reason"] is None


@pytest.mark.anyio
async def test_one_shot_task_timer_starts_once_and_clears(tmp_path):
    from services.project import ProjectManager
    from services.schedule import ScheduleModule
    from services.task import TaskService
    from streaming.bus import EventBus

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    bus = EventBus()
    tasks = TaskService(bus)
    with manager.activate_project_by_id(project.id):
        task = tasks.create_task(
            title="Timer", cwd=str(project.path),
            scheduled_start_at=datetime(2099, 1, 2, 3, 4, tzinfo=timezone.utc),
        )
    started = []

    class Runtime:
        async def start(self, project_id, task_id, prompt, source="manual"):
            started.append((project_id, task_id))

    module = ScheduleModule(manager, tasks, Runtime())
    await module.tick(datetime(2099, 1, 2, 3, 4, 1, tzinfo=timezone.utc))
    await module.wait_idle()
    assert started == [(project.id, task["id"])]
    with manager.activate_project_by_id(project.id):
        current = tasks.get_task(task["id"])
        assert current["scheduled_start_at"] is None
        assert current["scheduled_start_state"] is None
    await bus.close()


@pytest.mark.anyio
async def test_stopped_one_shot_task_does_not_restart_on_next_tick(tmp_path):
    from services.project import ProjectManager
    from services.schedule import ScheduleModule
    from services.task import TaskService
    from streaming.bus import EventBus

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    bus = EventBus()
    tasks = TaskService(bus)
    with manager.activate_project_by_id(project.id):
        task = tasks.create_task(
            title="Stopped timer", cwd=str(project.path),
            scheduled_start_at=datetime(2099, 1, 2, 3, 4, tzinfo=timezone.utc),
        )
    starts = 0

    class Runtime:
        async def start(self, project_id, task_id, prompt, source="manual"):
            nonlocal starts
            starts += 1
            raise asyncio.CancelledError

    module = ScheduleModule(manager, tasks, Runtime())
    due = datetime(2099, 1, 2, 3, 4, 1, tzinfo=timezone.utc)
    await module.tick(due)
    await module.wait_idle()
    await module.tick(due)
    await module.wait_idle()

    assert starts == 1
    with manager.activate_project_by_id(project.id):
        current = tasks.get_task(task["id"])
        assert current["scheduled_start_at"] is None
        assert current["scheduled_start_state"] is None
    await bus.close()


@pytest.mark.anyio
async def test_one_shot_task_timer_is_marked_missed_on_startup(tmp_path):
    from services.project import ProjectManager
    from services.schedule import ScheduleModule
    from services.task import TaskService
    from streaming.bus import EventBus

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    bus = EventBus()
    tasks = TaskService(bus)
    with manager.activate_project_by_id(project.id):
        task = tasks.create_task(
            title="Missed", cwd=str(project.path),
            scheduled_start_at=datetime(2099, 1, 2, 3, 4, tzinfo=timezone.utc),
        )
    class Runtime:
        async def start(self, *args):
            raise AssertionError("missed timer must not start")
    module = ScheduleModule(manager, tasks, Runtime())
    project_events = bus.subscribe(lambda event: event.get("project_id") == project.id)
    await module.tick(datetime(2099, 1, 2, 3, 5, tzinfo=timezone.utc), startup=True)
    assert (await asyncio.wait_for(project_events.get(), timeout=1))["name"] == "workstep.scheduled_start"
    with manager.activate_project_by_id(project.id):
        current = tasks.get_task(task["id"])
        assert current["scheduled_start_state"] == "missed"
    await bus.close()


@pytest.mark.anyio
async def test_schedule_agent_tool_requires_confirmation_and_posts_rule():
    import json
    import httpx

    from services.tool_registry import WorkstepClient

    captured = {}

    async def handler(request):
        captured["path"] = request.url.path
        captured["query"] = dict(request.url.params)
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"id": "schedule-1"})

    client = WorkstepClient(transport=httpx.MockTransport(handler))
    denied = await client.call("workstep_create_schedule", {
        "project_id": "p1", "workflow_id": "w1", "name": "Daily",
        "task_template": {"title": "T"},
        "rule": {"kind": "cron", "expression": "0 9 * * *"},
    })
    result = await client.call("workstep_create_schedule", {
        "project_id": "p1", "workflow_id": "w1", "name": "Daily",
        "task_template": {"title": "T"},
        "rule": {"kind": "cron", "expression": "0 9 * * *"},
        "confirm": "yes",
    })

    assert denied["ok"] is False
    assert result["id"] == "schedule-1"
    assert captured == {
        "path": "/api/schedule/create",
        "query": {"project_id": "p1"},
        "body": {
            "workflow_id": "w1", "name": "Daily",
            "task_template": {"title": "T"},
            "rule": {"kind": "cron", "expression": "0 9 * * *"},
        },
    }


@pytest.mark.anyio
async def test_schedule_cli_create_maps_to_the_shared_tool():
    from cli import build_parser, dispatch

    calls = []

    class ClientStub:
        async def call(self, operation, arguments):
            calls.append((operation, arguments))
            return {"id": "schedule-1"}

    args = build_parser().parse_args([
        "schedule", "create", "--project", "p1", "--workflow", "w1",
        "--name", "Daily", "--title", "T", "--cron", "0 9 * * *",
        "--timezone", "Asia/Shanghai", "--execution", "immediate",
    ])
    result = await dispatch(args, ClientStub())

    assert result["id"] == "schedule-1"
    assert calls[0][0] == "workstep_create_schedule"
    assert calls[0][1]["confirm"] == "yes"
    assert calls[0][1]["rule"] == {
        "kind": "cron", "expression": "0 9 * * *", "timezone": "Asia/Shanghai",
    }


def test_deleting_a_workflow_invalidates_its_schedules(tmp_path):
    from services.project import ProjectManager
    from services.schedule import ScheduleModule

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    from services.project import DEFAULT_STEPS
    manager.create_workflow(project, "测试流程", DEFAULT_STEPS)
    with manager.activate_project_by_id(project.id):
        workflow = manager.create_workflow(project, "scheduled")
    module = ScheduleModule(manager, None, None)
    schedule = module.create(
        project.id, name="Daily", workflow_id=workflow["id"],
        task_template={"title": "T"},
        rule={"kind": "cron", "expression": "0 9 * * *", "timezone": "UTC"},
    )

    with manager.activate_project_by_id(project.id):
        manager.delete_workflow(project, workflow["id"])

    invalid = module.get(project.id, schedule["id"])
    assert invalid["status"] == "invalid"
    assert invalid["next_run_at"] is None


@pytest.mark.anyio
async def test_queue_overlap_waits_for_previous_run_then_creates_task(tmp_path):
    from models import ScheduleRun
    from models.fields import utc_now
    from services.project import ProjectManager
    from services.schedule import ScheduleModule
    from services.task import TaskService
    from streaming.bus import EventBus

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    from services.project import DEFAULT_STEPS
    await manager.run_db(project.id, lambda project: manager.create_workflow(project, "测试流程", DEFAULT_STEPS))
    module = ScheduleModule(manager, TaskService(EventBus()), None)
    schedule = module.create(
        project.id, name="Queued", workflow_id=project.default_workflow()["id"],
        task_template={"title": "Queued task"},
        rule={"kind": "once", "run_at": "2099-01-02T03:04:00", "timezone": "UTC"},
        execution_mode="manual", overlap_policy="queue",
    )
    with manager.activate_project_by_id(project.id):
        previous = ScheduleRun.create(
            id="previous", schedule=schedule["id"],
            scheduled_for=datetime(2099, 1, 1, tzinfo=timezone.utc),
            status="running", created_at=utc_now(),
        )

    await module.tick(datetime(2099, 1, 2, 3, 4, 1, tzinfo=timezone.utc))
    assert [run["status"] for run in module.list_runs(project.id, schedule["id"])] == ["queued", "running"]
    with manager.activate_project_by_id(project.id):
        previous.status = "failed"
        previous.save()
    await module.tick(datetime(2099, 1, 2, 3, 5, tzinfo=timezone.utc))
    await module.wait_idle()
    assert [run["status"] for run in module.list_runs(project.id, schedule["id"])] == ["created", "failed"]


def test_removing_scheduled_start_step_invalidates_schedule(tmp_path):
    from services.project import ProjectManager
    from services.schedule import ScheduleModule

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    from services.project import DEFAULT_STEPS
    manager.create_workflow(project, "测试流程", DEFAULT_STEPS)
    workflow = project.default_workflow()
    first_key = workflow["steps"]["nodes"][0]["type"]
    module = ScheduleModule(manager, None, None)
    schedule = module.create(
        project.id, name="Stage", workflow_id=workflow["id"],
        task_template={"title": "T", "start_step_key": first_key},
        rule={"kind": "cron", "expression": "0 9 * * *", "timezone": "UTC"},
    )

    with manager.activate_project_by_id(project.id):
        manager.update_workflow(
            project, workflow["id"], steps={"nodes": [], "connections": []}
        )

    assert module.get(project.id, schedule["id"])["status"] == "invalid"


# ── agent mode (scheduled task assistant) ──────────────────────────────


class StubTaskAgent:
    """Fake task-agent hook for schedule dispatch tests."""

    def __init__(self, results):
        self.results = list(results)
        self.calls: list[dict] = []
        self.feedbacks: list[str] = []

    async def run_schedule(
        self, project_id, *, instruction, title, description,
        candidate_workflow_ids, retry_feedback, timeout,
    ):
        self.calls.append({
            "instruction": instruction,
            "title": title,
            "description": description,
            "candidate_workflow_ids": candidate_workflow_ids,
            "retry_feedback": retry_feedback,
        })
        if retry_feedback is not None:
            self.feedbacks.append(retry_feedback)
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def _agent_schedule(module, project, *, instruction="生成一个任务", **template):
    return module.create(
        project.id,
        name="Agent once",
        workflow_id="",
        task_template={"mode": "agent", "instruction": instruction, **template},
        rule={"kind": "once", "run_at": "2099-01-02T03:04:00", "timezone": "UTC"},
        execution_mode="manual",
    )


def test_agent_mode_requires_instruction_and_valid_candidates(tmp_path):
    from services.project import ProjectManager
    from services.schedule import ScheduleModule, ScheduleValidationError

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    module = ScheduleModule(manager, None, None)

    with pytest.raises(ScheduleValidationError, match="instruction"):
        _agent_schedule(module, project, instruction="")
    with pytest.raises(ScheduleValidationError, match="candidate workflow not found"):
        _agent_schedule(
            module, project, candidate_workflow_ids=["missing-workflow"]
        )


@pytest.mark.anyio
async def test_agent_mode_run_creates_task_from_agent_result(tmp_path):
    from services.project import ProjectManager
    from services.schedule import ScheduleModule
    from services.task import TaskService
    from streaming.bus import EventBus

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    from services.project import DEFAULT_STEPS
    await manager.run_db(project.id, lambda project: manager.create_workflow(project, "测试流程", DEFAULT_STEPS))
    workflow = project.default_workflow()
    agent = StubTaskAgent([{
        "title": "Agent task",
        "description": "## 内容",
        "workflow_id": workflow["id"],
        "start_step_key": "req",
    }])
    module = ScheduleModule(
        manager, TaskService(EventBus()), workflow_runtime=None, task_agent=agent
    )
    created = _agent_schedule(module, project)

    assert created["workflow_id"] == ""
    await module.tick(datetime(2099, 1, 2, 3, 4, 1, tzinfo=timezone.utc))
    await module.wait_idle()

    runs = module.list_runs(project.id, created["id"])
    assert len(runs) == 1
    assert runs[0]["status"] == "created"
    assert runs[0]["task_id"]
    assert agent.calls[0]["candidate_workflow_ids"] == []
    assert agent.calls[0]["instruction"] == "生成一个任务"
    with manager.activate_project_by_id(project.id):
        from models import Task
        task = Task.get_by_id(runs[0]["task_id"])
        assert task.title == "Agent task"
        assert task.description == "## 内容"
        assert task.workflow_id == workflow["id"]
        assert task.status == "ready"


@pytest.mark.anyio
async def test_agent_mode_run_retries_with_feedback_then_succeeds(tmp_path):
    from services.project import ProjectManager
    from services.schedule import ScheduleModule
    from services.task import TaskService
    from streaming.bus import EventBus

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    from services.project import DEFAULT_STEPS
    await manager.run_db(project.id, lambda project: manager.create_workflow(project, "测试流程", DEFAULT_STEPS))
    workflow = project.default_workflow()
    agent = StubTaskAgent([
        RuntimeError("engine down"),
        {"title": "OK", "description": "内容", "workflow_id": workflow["id"]},
    ])
    module = ScheduleModule(
        manager, TaskService(EventBus()), workflow_runtime=None, task_agent=agent
    )
    created = module.create(
        project.id,
        name="Agent recurring",
        workflow_id="",
        task_template={
            "mode": "agent",
            "instruction": "生成一个任务",
            "retry_count": 2,
        },
        rule={"kind": "cron", "expression": "0 9 * * *", "timezone": "UTC"},
        execution_mode="manual",
    )

    await module.tick(datetime(2099, 1, 2, 3, 4, 1, tzinfo=timezone.utc))
    await module.wait_idle()

    assert len(agent.calls) == 2
    assert agent.calls[1]["retry_feedback"] is not None
    assert "engine down" in agent.calls[1]["retry_feedback"]
    assert module.list_runs(project.id, created["id"])[0]["status"] == "created"


@pytest.mark.anyio
async def test_agent_mode_run_fails_after_retries_but_keeps_schedule(tmp_path):
    from services.project import ProjectManager
    from services.schedule import ScheduleModule
    from services.task import TaskService
    from streaming.bus import EventBus

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    agent = StubTaskAgent([RuntimeError("boom"), RuntimeError("boom"), RuntimeError("boom")])
    module = ScheduleModule(
        manager, TaskService(EventBus()), workflow_runtime=None, task_agent=agent
    )
    created = module.create(
        project.id,
        name="Agent recurring",
        workflow_id="",
        task_template={
            "mode": "agent",
            "instruction": "生成一个任务",
            "retry_count": 2,
        },
        rule={"kind": "cron", "expression": "0 9 * * *", "timezone": "UTC"},
        execution_mode="manual",
    )

    await module.tick(datetime(2099, 1, 2, 3, 4, 1, tzinfo=timezone.utc))
    await module.wait_idle()

    assert len(agent.calls) == 3
    run = module.list_runs(project.id, created["id"])[0]
    assert run["status"] == "failed"
    assert "after 3 attempts" in run["reason"]
    assert module.get(project.id, created["id"])["status"] == "active"


def test_deleting_candidate_workflow_prunes_agent_schedule(tmp_path):
    from services.project import ProjectManager
    from services.schedule import ScheduleModule

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    from services.project import DEFAULT_STEPS
    manager.create_workflow(project, "测试流程", DEFAULT_STEPS)
    with manager.activate_project_by_id(project.id):
        workflow = manager.create_workflow(project, "scheduled")
    module = ScheduleModule(manager, None, None)
    schedule = module.create(
        project.id,
        name="Agent",
        workflow_id="",
        task_template={
            "mode": "agent",
            "instruction": "生成",
            "candidate_workflow_ids": [workflow["id"]],
        },
        rule={"kind": "cron", "expression": "0 9 * * *", "timezone": "UTC"},
    )

    with manager.activate_project_by_id(project.id):
        manager.delete_workflow(project, workflow["id"])

    invalid = module.get(project.id, schedule["id"])
    assert invalid["status"] == "invalid"
    assert "Candidate workflow was deleted" in invalid["invalid_reason"]


@pytest.mark.anyio
async def test_schedule_cli_create_agent_mode_maps_candidates_and_instruction():
    from cli import build_parser, dispatch

    calls = []

    class ClientStub:
        async def call(self, operation, arguments):
            calls.append((operation, arguments))
            return {"id": "schedule-2", "status": "active"}

    args = build_parser().parse_args([
        "schedule", "create", "--project", "p1", "--mode", "agent",
        "--name", "Agent", "--instruction", "生成日报",
        "--candidates", "w1,w2", "--retry-count", "3",
        "--cron", "0 9 * * *", "--timezone", "UTC",
    ])
    result = await dispatch(args, ClientStub())

    assert result["id"] == "schedule-2"
    op, arguments = calls[0]
    assert op == "workstep_create_schedule"
    assert arguments["workflow_id"] == ""
    assert arguments["task_template"] == {
        "mode": "agent",
        "instruction": "生成日报",
        "candidate_workflow_ids": ["w1", "w2"],
        "retry_count": 3,
    }
def test_schedule_rule_module_owns_compilation_and_keeps_public_aliases():
    from services.schedule import ScheduleValidationError as PublicError
    from services.schedule import compile_rule as public_compile_rule
    from services.schedule_rules import ScheduleValidationError, compile_rule

    assert PublicError is ScheduleValidationError
    assert public_compile_rule is compile_rule
    expression, zone, run_at = compile_rule({
        "kind": "daily", "time": "09:30", "timezone": "UTC",
    })
    assert (expression, zone, run_at) == ("30 9 * * *", "UTC", None)


@pytest.mark.parametrize("creator", [
    {"name": "张三", "username": "zhangsan"},
    {"name": "", "username": "lisi"},
    {"name": "旧用户"},
    None,
])
def test_schedule_list_exposes_creator_display_fields(tmp_path, creator):
    import json
    from models import Schedule
    from services.project import ProjectManager
    from services.schedule import ScheduleModule

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    module = ScheduleModule(manager, None, None)
    created = module.create(
        project.id, name="Creator display", workflow_id="",
        task_template={"mode": "agent", "instruction": "生成任务"},
        rule={"kind": "once", "run_at": "2099-01-01T00:00:00Z", "timezone": "UTC"},
    )
    with manager.activate_project_by_id(project.id):
        template = {"mode": "agent", "instruction": "生成任务"}
        if creator is not None:
            template["_creator"] = {**creator, "id": "private-id", "source": "browser"}
        Schedule.update(task_template_json=json.dumps(template)).where(Schedule.id == created["id"]).execute()
    public = module.list(project.id)[0]
    assert public["creator_name"] == ((creator or {}).get("name") or None)
    assert public["creator_username"] == ((creator or {}).get("username") or None)
    assert "_creator" not in public["task_template"]


@pytest.mark.anyio
async def test_dynamic_schedule_creates_five_tasks_with_independent_start_times(tmp_path):
    from services.project import ProjectManager, DEFAULT_STEPS
    from services.schedule import ScheduleModule
    from services.task import TaskService
    from streaming.bus import EventBus
    from models import Task

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    await manager.run_db(project.id, lambda p: manager.create_workflow(p, "流程", DEFAULT_STEPS))
    workflow_id = project.default_workflow()["id"]
    drafts = [{"title": f"任务{i}", "description": "内容", "workflow_id": workflow_id,
               "scheduled_start_at": f"2099-02-0{i+1}T09:00:00+08:00", "engine": "codex"} for i in range(5)]
    started = []

    class Runtime:
        async def start(self, project_id, task_id, prompt, source="manual"):
            started.append((task_id, source))

    module = ScheduleModule(manager, TaskService(EventBus()), Runtime(), task_agent=StubTaskAgent([drafts]))
    schedule = _agent_schedule(module, project)
    await module.tick(datetime(2099, 1, 2, 3, 4, 1, tzinfo=timezone.utc))
    await module.wait_idle()
    run = module.list_runs(project.id, schedule["id"])[0]
    assert run["status"] == "created", run
    assert len(run["created_tasks"]) == 5
    tasks = await manager.run_db(project.id, lambda _: [
        (t.id, t.title, t.scheduled_start_at, t.scheduled_start_state, t.engine) for t in Task.select()
    ])
    assert {t[0] for t in tasks} == {t["id"] for t in run["created_tasks"]}
    assert len({t[2] for t in tasks}) == 5
    assert all(t[3:] == ("pending", "codex") for t in tasks)
    assert run["task_id"] == run["created_tasks"][0]["id"]
    await module.tick(datetime(2099, 1, 2, 3, 5, 1, tzinfo=timezone.utc))
    await module.wait_idle()
    assert await manager.run_db(project.id, lambda _: Task.select().count()) == 5

    assert started == []
    for day in range(1, 6):
        await module.tick(datetime(2099, 2, day, 1, 0, 1, tzinfo=timezone.utc))
        await module.wait_idle()
        assert len(started) == day
    assert {item[0] for item in started} == {item[0] for item in tasks}
    assert all(item[1] == "scheduled_start" for item in started)


@pytest.mark.anyio
@pytest.mark.parametrize("invalid_batch", [None, "time", "workflow", "step"])
async def test_dynamic_batch_keeps_partial_results_and_does_not_repeat_creations(tmp_path, monkeypatch, invalid_batch):
    from services.project import ProjectManager, DEFAULT_STEPS
    from services.schedule import ScheduleModule
    from services.task import TaskService
    from streaming.bus import EventBus
    from models import Task

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    await manager.run_db(project.id, lambda p: manager.create_workflow(p, "流程", DEFAULT_STEPS))
    drafts = [{"title": f"任务{i}", "description": "内容", "workflow_id": project.default_workflow()["id"]} for i in range(3)]
    if invalid_batch == "time":
        drafts[2]["scheduled_start_at"] = "invalid"
    elif invalid_batch == "workflow":
        drafts[2]["workflow_id"] = "missing"
    elif invalid_batch == "step":
        drafts[2]["start_step_key"] = "missing"
    service = TaskService(EventBus())
    original = service.create_task
    calls = []

    def create(**kwargs):
        calls.append(kwargs)
        if len(calls) == 2:
            raise RuntimeError("disk full")
        return original(**kwargs)

    monkeypatch.setattr(service, "create_task", create)
    module = ScheduleModule(manager, service, None, task_agent=StubTaskAgent([drafts]))
    schedule = _agent_schedule(module, project)
    await module.tick(datetime(2099, 1, 2, 3, 4, 1, tzinfo=timezone.utc))
    await module.wait_idle()
    run = module.list_runs(project.id, schedule["id"])[0]
    assert run["status"] == "failed"
    assert len(run["created_tasks"]) == (0 if invalid_batch else 1)
    assert len(calls) == (0 if invalid_batch else 2)
    await module.tick(datetime(2099, 1, 2, 3, 5, 1, tzinfo=timezone.utc))
    await module.wait_idle()
    assert await manager.run_db(project.id, lambda _: Task.select().count()) == (0 if invalid_batch else 1)


@pytest.mark.anyio
async def test_slow_batch_creation_does_not_block_event_loop(tmp_path, monkeypatch):
    from services.project import ProjectManager, DEFAULT_STEPS
    from services.schedule import ScheduleModule
    from services.task import TaskService
    from streaming.bus import EventBus

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    await manager.run_db(project.id, lambda p: manager.create_workflow(p, "流程", DEFAULT_STEPS))
    drafts = [{"title": f"任务{i}", "description": "内容", "workflow_id": project.default_workflow()["id"]} for i in range(2)]
    service = TaskService(EventBus())
    original = service.create_task
    entered, release = threading.Event(), threading.Event()

    def slow_create(**kwargs):
        if kwargs["title"] == "任务1":
            entered.set()
            assert release.wait(3)
        return original(**kwargs)

    monkeypatch.setattr(service, "create_task", slow_create)
    module = ScheduleModule(manager, service, None, task_agent=StubTaskAgent([drafts]))
    schedule = _agent_schedule(module, project)
    await module.tick(datetime(2099, 1, 2, 3, 4, 1, tzinfo=timezone.utc))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        started = time.perf_counter()
        await asyncio.sleep(0.02)
        assert time.perf_counter() - started < 0.2
    finally:
        release.set()
    await module.wait_idle()
    run = module.list_runs(project.id, schedule["id"])[0]
    assert run["status"] == "created"
    assert len(run["created_tasks"]) == 2


@pytest.mark.anyio
async def test_batch_records_created_task_even_when_immediate_start_fails(tmp_path):
    from services.project import ProjectManager, DEFAULT_STEPS
    from services.schedule import ScheduleModule
    from services.task import TaskService
    from streaming.bus import EventBus
    from models import Task

    manager = ProjectManager()
    project = manager.init_project(tmp_path / 'project')
    workflow = await manager.run_db(project.id, lambda p: manager.create_workflow(p, '流程', DEFAULT_STEPS))
    drafts = [{'title': '已创建但启动失败', 'description': '内容', 'workflow_id': workflow['id'], 'auto_start': True}]

    class Runtime:
        async def start(self, *args, **kwargs):
            raise RuntimeError('engine unavailable')

    module = ScheduleModule(manager, TaskService(EventBus()), Runtime(), task_agent=StubTaskAgent([drafts]))
    schedule = _agent_schedule(module, project)
    await module.tick(datetime(2099, 1, 2, 3, 4, 1, tzinfo=timezone.utc))
    await module.wait_idle()
    run = module.list_runs(project.id, schedule['id'])[0]
    assert run['status'] == 'failed'
    assert 'engine unavailable' in run['reason']
    assert len(run['created_tasks']) == 1
    assert await manager.run_db(project.id, lambda _: Task.get_by_id(run['created_tasks'][0]['id']).title) == '已创建但启动失败'


@pytest.mark.anyio
async def test_zero_agent_retries_means_one_attempt(tmp_path):
    from services.project import ProjectManager
    from services.schedule import ScheduleModule

    manager = ProjectManager()
    project = manager.init_project(tmp_path / 'project')
    agent = StubTaskAgent([RuntimeError('generation failed')] * 3)
    module = ScheduleModule(manager, None, None, task_agent=agent)
    schedule = _agent_schedule(module, project, retry_count=0)
    await module.tick(datetime(2099, 1, 2, 3, 4, 1, tzinfo=timezone.utc))
    await module.wait_idle()
    assert len(agent.calls) == 1
    assert module.list_runs(project.id, schedule['id'])[0]['status'] == 'failed'


@pytest.mark.anyio
async def test_batch_task_and_run_index_roll_back_together(tmp_path, monkeypatch):
    from services.project import ProjectManager, DEFAULT_STEPS
    from services.schedule import ScheduleModule
    from services.task import TaskService
    from streaming.bus import EventBus
    from models import ScheduleRun, Task

    manager = ProjectManager()
    project = manager.init_project(tmp_path / 'project')
    workflow = await manager.run_db(project.id, lambda p: manager.create_workflow(p, '流程', DEFAULT_STEPS))
    module = ScheduleModule(manager, TaskService(EventBus()), None, task_agent=StubTaskAgent([[
        {'title': '索引写入失败', 'description': '内容', 'workflow_id': workflow['id']},
    ]]))
    schedule = _agent_schedule(module, project)
    original = ScheduleRun.save

    def fail_index(row, *args, **kwargs):
        if row.created_tasks_json:
            raise RuntimeError('index write failed')
        return original(row, *args, **kwargs)

    monkeypatch.setattr(ScheduleRun, 'save', fail_index)
    await module.tick(datetime(2099, 1, 2, 3, 4, 1, tzinfo=timezone.utc))
    await module.wait_idle()
    run = module.list_runs(project.id, schedule['id'])[0]
    assert run['status'] == 'failed'
    assert 'index write failed' in run['reason']
    assert run['created_tasks'] == []
    assert await manager.run_db(project.id, lambda _: Task.select().count()) == 0


@pytest.mark.anyio
async def test_cancelled_batch_keeps_committed_task_and_restart_does_not_duplicate_it(tmp_path, monkeypatch):
    from services.project import ProjectManager, DEFAULT_STEPS
    from services.schedule import ScheduleModule
    from services.task import TaskService
    from streaming.bus import EventBus
    from models import Task

    manager = ProjectManager()
    project = manager.init_project(tmp_path / 'project')
    workflow = await manager.run_db(project.id, lambda p: manager.create_workflow(p, '流程', DEFAULT_STEPS))
    drafts = [{'title': str(i), 'description': '内容', 'workflow_id': workflow['id']} for i in range(2)]
    service = TaskService(EventBus())
    original = service.create_task
    entered, release = threading.Event(), threading.Event()

    def slow_create(**kwargs):
        entered.set()
        assert release.wait(3)
        return original(**kwargs)

    monkeypatch.setattr(service, 'create_task', slow_create)
    module = ScheduleModule(manager, service, None, task_agent=StubTaskAgent([drafts]))
    schedule = _agent_schedule(module, project)
    await module.tick(datetime(2099, 1, 2, 3, 4, 1, tzinfo=timezone.utc))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        worker = next(item for item in module._workers if item.get_name().startswith('schedule-run:'))
        worker.cancel()
    finally:
        release.set()
    await module.wait_idle()
    assert await manager.run_db(project.id, lambda _: Task.select().count()) == 1
    # Ordinary ticks must not turn a partially recorded batch into success.
    await module.tick(datetime(2099, 1, 2, 3, 5, 1, tzinfo=timezone.utc))
    assert module.list_runs(project.id, schedule['id'])[0]['status'] == 'running'
    await module.tick(datetime(2099, 1, 2, 3, 6, 1, tzinfo=timezone.utc), startup=True)
    run = module.list_runs(project.id, schedule['id'])[0]
    assert run['status'] == 'failed'
    assert len(run['created_tasks']) == 1
    await module.wait_idle()
    assert await manager.run_db(project.id, lambda _: Task.select().count()) == 1


def test_batch_history_column_migrates_without_losing_legacy_runs(tmp_path):
    from models import init_db, Schedule, ScheduleRun
    from models.fields import utc_now
    from services.schedule import ScheduleModule

    path = str(tmp_path / 'legacy.db')
    db = init_db(path)
    try:
        Schedule.create(id='old', name='旧定时', workflow_id='flow', task_template_json='{}', rule_json='{}',
                        timezone='UTC', created_at=utc_now(), updated_at=utc_now())
        ScheduleRun.create(id='old-run', schedule='old', task_id='old-task', status='failed',
                           scheduled_for=utc_now(), created_at=utc_now())
        db.execute_sql('ALTER TABLE schedule_runs DROP COLUMN created_tasks_json')
        db.close()
        db = init_db(path)
        run = ScheduleModule._run_to_dict(ScheduleRun.get_by_id('old-run'))
        assert run['task_id'] == 'old-task'
        assert run['created_tasks'] == []
        assert run['status'] == 'created'
    finally:
        db.close()


@pytest.mark.anyio
async def test_restart_terminates_interrupted_generation_without_blocking_future_occurrences(tmp_path):
    from services.project import ProjectManager
    from services.schedule import ScheduleModule
    from models import ScheduleRun
    from models.fields import utc_now

    manager = ProjectManager()
    project = manager.init_project(tmp_path / 'project')
    agent = StubTaskAgent([RuntimeError("new generation")])
    module = ScheduleModule(manager, None, None, task_agent=agent)
    schedule = _agent_schedule(module, project, retry_count=0)
    await manager.run_db(project.id, lambda _: ScheduleRun.create(
        id='interrupted-generation', schedule=schedule['id'], status='running',
        scheduled_for=utc_now(), created_at=utc_now(),
    ))
    await module.tick(utc_now(), startup=True)
    run = module.list_runs(project.id, schedule['id'])[0]
    assert run['status'] == 'failed'
    assert run['created_tasks'] == []
    assert '重启' in run['reason']

    await module.tick(datetime(2099, 1, 2, 3, 4, 1, tzinfo=timezone.utc))
    await module.wait_idle()
    assert len(agent.calls) == 1
    assert len(module.list_runs(project.id, schedule['id'])) == 2

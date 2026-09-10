"""Project schedule behavior through the public schedule module interface."""

import asyncio
from datetime import datetime, timezone

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


def test_user_can_create_pause_and_resume_a_project_schedule(tmp_path):
    from services.project import ProjectManager
    from services.schedule import ScheduleModule

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    workflow_id = project.default_workflow()["id"]
    module = ScheduleModule(manager, task_service=None, workflow_runtime=None)

    created = module.create(
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

    assert created["status"] == "active"
    assert created["cron_expression"] == "0 9 * * 1"
    assert created["next_run_at"] is not None
    assert module.pause(project.id, created["id"])["status"] == "paused"
    resumed = module.resume(project.id, created["id"])
    assert resumed["status"] == "active"
    assert resumed["next_run_at"] is not None


def test_user_can_create_schedule_without_a_task_title(tmp_path):
    from services.project import ProjectManager
    from services.schedule import ScheduleModule

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
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

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    workflow_id = project.default_workflow()["id"]
    module = ScheduleModule(manager, TaskService(EventBus()), workflow_runtime=None)
    created = module.create(
        project.id,
        name="One shot",
        workflow_id=workflow_id,
        task_template={"title": "Scheduled work", "description": "Do it"},
        rule={"kind": "once", "run_at": "2099-01-02T03:04:00", "timezone": "UTC"},
        execution_mode="manual",
    )

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
    await module.tick(datetime(2099, 1, 2, 3, 5, tzinfo=timezone.utc), startup=True)
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

"""Tests for the ephemeral AI task-creation assistant."""

import asyncio
import json
import time
from types import SimpleNamespace

import pytest

from models import Task
from services.project import ProjectManager
from streaming.bus import EventBus


class MemoryConfigStore:
    def __init__(self):
        self.values = {}

    def get(self, key, default=None):
        return self.values.get(key, default)

    def set(self, key, value):
        self.values[key] = value

    def get_coordinator_default_engine(self):
        return self.values.get("coordinator_default_engine", "")

    def get_coordinator_default_model(self):
        return self.values.get("coordinator_default_model", "")

    def get_coordinator_default_fast_model(self):
        return self.values.get("coordinator_default_fast_model", "")

    def get_engine_default_model(self, engine_id):
        return self.values.get("engine_default_models", {}).get(engine_id, "")


class FakeEngine:
    capabilities = SimpleNamespace(supports_coordinator=True)
    supports_resume = False


async def _wait_turn(module, turn_id, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = module._turn_states.get(turn_id)
        if state and state["status"] in ("completed", "error", "stopped"):
            return state["status"]
        await asyncio.sleep(0.01)
    raise AssertionError("turn did not finish")


@pytest.fixture
async def draft_module(tmp_path, monkeypatch):
    import services.config as config_service
    import services.project as project_service
    import agent_assistants.task_draft as task_draft_service

    store = MemoryConfigStore()
    monkeypatch.setattr(config_service, "config_store", store)
    monkeypatch.setattr(project_service, "config_store", store)
    monkeypatch.setattr(task_draft_service, "config_store", store)
    monkeypatch.setattr(
        task_draft_service, "create_engine", lambda engine_id: FakeEngine()
    )

    manager = ProjectManager()
    bus = EventBus()
    module = task_draft_service.TaskDraftModule(bus, manager)
    project = manager.init_project(tmp_path / "draft-proj")
    project.workstep_dir.joinpath("MEMORY.md").write_text(
        "# 约定\n\n只使用简体中文。", encoding="utf-8"
    )
    yield module, bus, manager, project, store
    await module.shutdown()
    await bus.close()
    manager.close_all()


@pytest.mark.anyio
async def test_task_draft_publishes_description_without_creating_task(
    draft_module, monkeypatch
):
    module, bus, _, project, _ = draft_module
    prompts = []

    async def fake_invoke(
        engine_id, model, cwd, prompt, session_id, on_event=None,
        message_history=None,
    ):
        prompts.append(prompt)
        return json.dumps({
            "reply": "任务描述已经整理完成。",
            "task_draft": {
                "description": "## 目标\n\n完成任务创建。",
                "start_step_key": "test",
            },
        }), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    queue = bus.subscribe()
    workflow = project.default_workflow()
    accepted = module.submit_message(
        project.id,
        None,
        "请完善描述",
        "idem-1",
        title="新增 AI 创建",
        description="现有草稿",
        workflow_id=workflow["id"],
        start_step_key="req",
    )

    assert await _wait_turn(module, accepted.turn_id) == "completed"
    draft_event = None
    while draft_event is None:
        event = await asyncio.wait_for(queue.get(), timeout=2)
        if event["type"] == "CUSTOM" and event["name"] == "workstep.task_draft":
            draft_event = event

    assert draft_event["channel"] == "task_create"
    assert draft_event["session_id"] == accepted.session_id
    assert draft_event["value"] == {
        "description": "## 目标\n\n完成任务创建。",
        "start_step_key": "test",
    }
    assert "新增 AI 创建" in prompts[0]
    assert "现有草稿" in prompts[0]
    assert "只使用简体中文" in prompts[0]
    assert '"start_step_key": "req"' in prompts[0]
    with project.db.bind_ctx([Task]):
        assert Task.select().count() == 0


@pytest.mark.anyio
async def test_task_draft_clarification_does_not_publish_draft(
    draft_module, monkeypatch
):
    module, bus, _, project, _ = draft_module

    async def fake_invoke(*args, **kwargs):
        return json.dumps({
            "reply": "请补充验收标准。",
            "task_draft": None,
        }), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    queue = bus.subscribe()
    accepted = module.submit_message(
        project.id, None, "帮我完善", "idem-2", title="测试任务"
    )
    assert await _wait_turn(module, accepted.turn_id) == "completed"

    events = []
    while not any(event["type"] == "TEXT_MESSAGE_END" for event in events):
        events.append(await asyncio.wait_for(queue.get(), timeout=2))
    assert not any(
        event["type"] == "CUSTOM" and event["name"] == "workstep.task_draft"
        for event in events
    )


@pytest.mark.anyio
async def test_task_draft_repairs_unknown_start_stage(draft_module, monkeypatch):
    module, bus, _, project, _ = draft_module
    replies = iter([
        json.dumps({
            "reply": "完成",
            "task_draft": {
                "description": "执行测试",
                "start_step_key": "unknown-stage",
            },
        }),
        json.dumps({
            "reply": "完成",
            "task_draft": {
                "description": "执行测试",
                "start_step_key": "test",
            },
        }),
    ])

    async def fake_invoke(*args, **kwargs):
        return next(replies), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    queue = bus.subscribe()
    accepted = module.submit_message(
        project.id, None, "创建测试任务", "idem-repair", title="回归测试"
    )
    assert await _wait_turn(module, accepted.turn_id) == "completed"

    draft = None
    while draft is None:
        event = await asyncio.wait_for(queue.get(), timeout=2)
        if event["type"] == "CUSTOM" and event["name"] == "workstep.task_draft":
            draft = event["value"]
    assert draft["start_step_key"] == "test"


@pytest.mark.anyio
async def test_task_draft_http_contract(tmp_path, monkeypatch):
    import main
    import services.project as project_service
    import agent_assistants.task_draft as task_draft_service
    from httpx import ASGITransport, AsyncClient

    store = MemoryConfigStore()
    manager = ProjectManager()
    monkeypatch.setattr(project_service, "config_store", store)
    monkeypatch.setattr(task_draft_service, "config_store", store)
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(
        task_draft_service, "create_engine", lambda engine_id: FakeEngine()
    )
    bus = EventBus()
    module = task_draft_service.TaskDraftModule(bus, manager)
    monkeypatch.setattr(main, "task_draft_module", module)
    project = manager.init_project(tmp_path / "http-draft")

    async def fake_invoke(*args, **kwargs):
        return json.dumps({"reply": "ok", "task_draft": None}), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    transport = ASGITransport(app=main.app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/api/task-draft/chat",
                json={
                    "project_id": project.id,
                    "content": "完善任务描述",
                    "title": "任务标题",
                    "thinking_effort": "high",
                },
                headers={"Idempotency-Key": "idem-http"},
            )
            assert response.status_code == 200
            body = response.json()
            assert body["session_id"]
            assert body["status"] == "queued"
            assert module._turn_states[body["turn_id"]]["thinking_effort"] == "high"

            invalid = await client.post(
                "/api/task-draft/chat",
                json={
                    "project_id": project.id,
                    "content": "完善任务描述",
                    "title": "   ",
                },
                headers={"Idempotency-Key": "idem-invalid"},
            )
            assert invalid.status_code == 400
    finally:
        await module.shutdown()
        await bus.close()
        manager.close_all()

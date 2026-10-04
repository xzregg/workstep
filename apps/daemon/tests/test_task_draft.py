"""Tests for the ephemeral AI task-creation assistant."""

import asyncio
import json
import time
from types import SimpleNamespace

import pytest

from models import Task
from services.project import DEFAULT_STEPS, ProjectManager
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

    def get_execution_default_engine(self):
        return self.values.get("execution_default_engine", "claude")

    def get_coordinator_default_model(self):
        return self.values.get("coordinator_default_model", "")

    def get_coordinator_default_fast_model(self):
        return self.values.get("coordinator_default_fast_model", "")

    def get_engine_default_model(self, engine_id):
        return self.values.get("engine_default_models", {}).get(engine_id, "")

    def get_assistant_defaults(self, name):
        merged = {
            "engine": self.get_coordinator_default_engine(),
            "model": self.get_coordinator_default_model(),
            "fast_model": self.get_coordinator_default_fast_model(),
            "vision_model": "",
            "thinking_effort": "",
        }
        overrides = self.get("assistant_defaults", {})
        overlay = overrides.get(name) if isinstance(overrides, dict) else None
        if isinstance(overlay, dict):
            for key in merged:
                value = overlay.get(key)
                if isinstance(value, str) and value.strip():
                    merged[key] = value.strip()
        return merged

    def get_assistant_config(self, name):
        overlay = self.values.get("assistant_defaults", {}).get(name, {})
        return {
            key: value
            for key, value in overlay.items()
            if isinstance(value, str) and value.strip()
        }

    def get_user_name(self):
        return "Test User"

    def get_device_identity(self):
        return {"device_id": "test-device", "device_name": "Test Device"}


@pytest.fixture(autouse=True)
def _named_test_user(monkeypatch):
    """HTTP contract tests hit the real global config store: seed a user.

    Module-level tests replace ``services.config.config_store`` with the
    ``MemoryConfigStore`` above (which now also carries an identity), so this
    only affects the tests that go through ``main.app``. (commit 45c02827)
    """
    import services.config as config_mod

    monkeypatch.setattr(config_mod.config_store, "get_user_name", lambda: "Test User")
    monkeypatch.setattr(
        config_mod.config_store,
        "get_device_identity",
        lambda: {"device_id": "test-device", "device_name": "Test Device"},
    )


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
    import agent_assistants.base as assistant_base
    import services.config as config_service
    import services.project as project_service
    import agent_assistants.task_draft as task_draft_service

    store = MemoryConfigStore()
    monkeypatch.setattr(config_service, "config_store", store)
    monkeypatch.setattr(assistant_base, "config_store", store)
    monkeypatch.setattr(project_service, "config_store", store)
    monkeypatch.setattr(task_draft_service, "config_store", store)
    monkeypatch.setattr(
        task_draft_service, "create_engine", lambda engine_id: FakeEngine()
    )

    manager = ProjectManager()
    bus = EventBus()
    module = task_draft_service.TaskDraftModule(bus, manager)
    project = manager.init_project(tmp_path / "draft-proj")
    await manager.run_db(project.id, lambda project: manager.create_workflow(project, "测试流程", DEFAULT_STEPS))
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
        message_history=None, system_prompt=None,
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
async def test_task_create_assistant_routes_image_message_to_vision_model(
    draft_module, monkeypatch
):
    module, _bus, _manager, project, config_store = draft_module
    config_store.values["assistant_defaults"] = {
        "task_create": {
            "engine": "claude",
            "model": "task-reasoning",
            "fast_model": "task-fast",
            "vision_model": "task-vision",
        }
    }
    upload = project.workstep_dir / "uploads" / "requirement.png"
    upload.parent.mkdir(parents=True, exist_ok=True)
    upload.write_bytes(b"fake-png")
    captured = {}

    async def fake_invoke(*args, **kwargs):
        captured.update(model=args[1], images=kwargs.get("images"))
        return json.dumps({
            "reply": "已读取需求图",
            "task_draft": {
                "description": "按图实现需求",
                "start_step_key": "req",
            },
        }), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    accepted = module.submit_message(
        project.id,
        None,
        "读取需求图 ![需求](.workstep/uploads/requirement.png)",
        "idem-image",
        title="图片任务",
        workflow_id=project.default_workflow()["id"],
        start_step_key="req",
    )

    assert await _wait_turn(module, accepted.turn_id) == "completed"
    assert captured["model"] == "task-vision"
    assert captured["images"][0].path == str(upload.resolve())


@pytest.mark.anyio
async def test_task_draft_can_generate_and_publish_a_missing_title(
    draft_module, monkeypatch
):
    module, bus, _, project, _ = draft_module
    prompts = []

    async def fake_invoke(*args, **kwargs):
        prompts.append(args[3])
        return json.dumps({
            "reply": "任务信息已经整理完成。",
            "task_draft": {
                "title": "生成的任务标题",
                "description": "## 目标\n\n完成发布。",
                "start_step_key": "test",
            },
        }), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    queue = bus.subscribe()
    accepted = module.submit_message(
        project.id,
        None,
        "帮我创建一个发布任务",
        "idem-generated-title",
        title="",
        workflow_id=project.default_workflow()["id"],
        allow_generate_title=True,
    )

    assert await _wait_turn(module, accepted.turn_id) == "completed"
    draft = None
    while draft is None:
        event = await asyncio.wait_for(queue.get(), timeout=2)
        if event["type"] == "CUSTOM" and event["name"] == "workstep.task_draft":
            draft = event["value"]

    assert draft["title"] == "生成的任务标题"
    assert draft["start_step_key"] == "test"
    assert "定时模式" not in prompts[0]


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
async def test_task_draft_repairs_unknown_start_step(draft_module, monkeypatch):
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
    await manager.run_db(project.id, lambda project: manager.create_workflow(project, "测试流程", DEFAULT_STEPS))

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
            workflow = project.default_workflow()
            agent_req = await client.post(
                "/api/task-draft/chat",
                json={
                    "project_id": project.id,
                    "content": "生成定时任务",
                    "title": "",
                    "allow_generate_title": True,
                    "candidate_workflow_ids": [workflow["id"]],
                    "instruction": "每日生成日报",
                },
                headers={"Idempotency-Key": "idem-agent"},
            )
            assert agent_req.status_code == 200
            bad_candidate = await client.post(
                "/api/task-draft/chat",
                json={
                    "project_id": project.id,
                    "content": "生成定时任务",
                    "title": "",
                    "allow_generate_title": True,
                    "candidate_workflow_ids": ["missing"],
                },
                headers={"Idempotency-Key": "idem-bad-candidate"},
            )
            assert bad_candidate.status_code == 400
    finally:
        await module.shutdown()
        await bus.close()
        manager.close_all()


# ── scheduled (headless) mode ──────────────────────────────────────────


def _first_step_key(project) -> str:
    from services.workflow_definition import WorkflowDefinition

    workflow = project.default_workflow()
    return WorkflowDefinition.load(workflow["steps"]).compile().steps[0]["key"]


@pytest.mark.anyio
async def test_run_schedule_returns_validated_result_without_creating_task(
    draft_module, monkeypatch
):
    module, bus, _, project, _ = draft_module
    workflow = project.default_workflow()
    first_key = _first_step_key(project)
    prompts = []

    async def fake_invoke(*args, **kwargs):
        prompts.append(args[3])
        return json.dumps({
            "reply": "已生成。",
            "task_draft": {
                "title": "生成的标题",
                "description": "## 内容\n\n任务说明。",
                "workflow_id": workflow["id"],
                "start_step_key": first_key,
            },
        }), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    result = await module.run_schedule(
        project.id,
        instruction="生成日报任务",
        candidate_workflow_ids=[workflow["id"]],
    )

    assert result == {
        "title": "生成的标题",
        "description": "## 内容\n\n任务说明。",
        "workflow_id": workflow["id"],
        "start_step_key": first_key,
    }
    assert "生成日报任务" in prompts[0]
    assert "scheduled task execution assistant" not in prompts[0]
    from agent_assistants.task_draft import SYSTEM_PROMPT_SCHEDULE
    assert "scheduled task execution assistant" in SYSTEM_PROMPT_SCHEDULE
    with project.db.bind_ctx([Task]):
        assert Task.select().count() == 0


@pytest.mark.anyio
async def test_run_schedule_rejects_workflow_outside_candidates(
    draft_module, monkeypatch
):
    module, bus, _, project, _ = draft_module

    async def fake_invoke(*args, **kwargs):
        return json.dumps({
            "reply": "完成",
            "task_draft": {
                "title": "标题",
                "description": "内容",
                "workflow_id": "not-a-candidate",
            },
        }), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    with pytest.raises(RuntimeError, match="outside the candidates"):
        await module.run_schedule(
            project.id,
            instruction="生成任务",
            candidate_workflow_ids=[project.default_workflow()["id"]],
        )


@pytest.mark.anyio
async def test_run_schedule_includes_retry_feedback_in_prompt(
    draft_module, monkeypatch
):
    module, bus, _, project, _ = draft_module
    workflow = project.default_workflow()
    prompts = []

    async def fake_invoke(*args, **kwargs):
        prompts.append(args[3])
        return json.dumps({
            "reply": "完成",
            "task_draft": {
                "title": "标题",
                "description": "内容",
                "workflow_id": workflow["id"],
            },
        }), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    await module.run_schedule(
        project.id,
        instruction="生成任务",
        retry_feedback="attempt 1: 返回了非法 JSON",
    )

    assert "attempt 1: 返回了非法 JSON" in prompts[0]


@pytest.mark.anyio
async def test_await_turn_raises_on_engine_error(draft_module, monkeypatch):
    module, bus, _, project, _ = draft_module

    async def fake_invoke(*args, **kwargs):
        raise RuntimeError("engine down")

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    accepted = module.submit_message(
        project.id, None, "完善", "idem-error", title="测试"
    )
    with pytest.raises(RuntimeError, match="engine down"):
        await module.await_turn(accepted.turn_id)
    assert module._turn_states[accepted.turn_id]["status"] == "error"


@pytest.mark.anyio
async def test_await_turn_times_out_without_cancelling_background(
    draft_module, monkeypatch
):
    module, bus, _, project, _ = draft_module

    async def fake_invoke(*args, **kwargs):
        await asyncio.sleep(60)

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    accepted = module.submit_message(
        project.id, None, "完善", "idem-timeout", title="测试"
    )
    with pytest.raises(TimeoutError):
        await module.await_turn(accepted.turn_id, timeout=0.05)
    assert module._turn_states[accepted.turn_id]["status"] == "running"
    assert await module.stop_current(accepted.session_id) is True
    assert await _wait_turn(module, accepted.turn_id) == "stopped"


@pytest.mark.anyio
@pytest.mark.parametrize("schedule_mode", [False, True])
async def test_task_assistant_actual_system_input(draft_module, monkeypatch, schedule_mode):
    import agent_assistants.base as base
    import agent_assistants.task_draft as draft
    from engines.core.acp_base import AcpEngineBase
    from engines.core.events import InternalEvent
    module, bus, manager, project, _ = draft_module
    calls = []
    class Engine(AcpEngineBase):
        @staticmethod
        def is_installed():
            return True
        @staticmethod
        def get_version():
            return "test"
        @staticmethod
        def resolve_binary():
            return "test"
        @property
        def supports_coordinator(self):
            return True
        SYSTEM_PROMPT_MODE = "system"
        async def spawn(self, **kwargs):
            calls.append(kwargs)
            yield InternalEvent("agent_message_chunk", {"content":{"text":json.dumps({"reply":"请补充", "task_draft":None})}})
    monkeypatch.setattr(base, "create_engine", lambda _: Engine())
    accepted = module.submit_message(project.id, None, "实际用户要求", "actual-input", title="创建任务")
    session = next(iter(module._sessions.values()))
    session.extra["schedule_mode"] = schedule_mode
    assert await _wait_turn(module, accepted.turn_id) == "completed"
    expected = draft.SYSTEM_PROMPT_SCHEDULE if schedule_mode else draft.SYSTEM_PROMPT
    assert calls[0]["system_prompt"] == expected
    assert expected not in calls[0]["prompt"]
    assert "实际用户要求" in calls[0]["prompt"]
    view = session.messages[-1]["prompt"]
    assert expected in view and calls[0]["prompt"] in view
    assert "独立指令（system）" in view

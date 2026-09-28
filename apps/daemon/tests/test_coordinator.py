"""Coordinator conversation, engine switching, and action tests."""

import asyncio
import json
import uuid
from contextlib import AsyncExitStack
from pathlib import Path
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient

from engines.core.acp_base import AcpEngineBase
from engines.core.events import InternalEvent
from agent_assistants.coordinator import CoordinatorModule
from agent_assistants.coordinator_context import (
    artifact_index, assemble_context, coordinator_root,
)
from services.project import ProjectManager
from services.task import TaskService
from services.workflow_runtime import WorkflowRuntime
from streaming.bus import EventBus


@pytest.mark.anyio
async def test_coordinator_live_event_carries_project_scope():
    bus = EventBus()
    module = object.__new__(CoordinatorModule)
    module._event_bus = bus
    queue = bus.subscribe(lambda event: event.get("project_id") == "project-1")
    message = SimpleNamespace(
        channel="coordinator", id="message-1", engine="test", model="test",
        context_step_key="coordinator",
    )
    await module._publish_message_event(
        "project-1", "task-1", message, "message_started",
        {"content": "hello", "role": "assistant"}, 0,
    )
    assert not queue.empty()
    assert (await queue.get())["project_id"] == "project-1"
    await bus.close()


@pytest.mark.parametrize("script_path", ["../outside.sh", "nested/start.sh", "action.json"])
def test_coordinator_action_proposal_rejects_unsafe_script_paths(script_path):
    from agent_assistants.coordinator_actions import CoordinatorActionService

    with pytest.raises(ValueError):
        CoordinatorActionService._normalize_workflow_action_payload({
            "action_id": "start-services",
            "title": "启动服务",
            "script_path": script_path,
            "script_content": "#!/bin/bash\necho ready\n",
        })


@pytest.mark.anyio
async def test_coordinator_workflow_action_requires_confirmation(api_context, monkeypatch):
    from engines.core.registry import ENGINE_REGISTRY
    from models import Task, Workflow
    import main

    client, tmp_path = api_context
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", CoordinatorFakeEngine)
    project_id, task_id = await _create_task(client, tmp_path)
    action_id = "start-services"
    CoordinatorFakeEngine.reply = {
        "version": 1,
        "reply": "已准备启动服务的快捷按钮，请先检查脚本。",
        "intent": "propose_action",
        "proposal": {
            "type": "create_workflow_action",
            "payload": {
                "action_id": action_id,
                "title": "启动服务",
                "script_path": "start.sh",
                "script_content": "#!/bin/bash\necho http://localhost:3000\n",
                "cwd_mode": "task",
                "require_confirmation": True,
            },
        },
    }
    try:
        await client.post(
            f"/api/task/{task_id}/chat?project_id={project_id}",
            headers={"Idempotency-Key": "chat-action-create"},
            json={"content": "生成启动服务的快捷按钮"},
        )
        assistant = await _wait_for_reply(client, project_id, task_id)
        proposal = assistant["proposals"][0]
        assert proposal["type"] == "create_workflow_action"
        workflow_id = await main.project_manager.run_db(
            project_id, lambda _: Task.get_by_id(task_id).workflow_id
        )
        action_root = tmp_path / "coordinator-project" / ".workstep" / "artifacts" / workflow_id / "actions" / action_id
        assert not action_root.exists()
        confirmed = await client.post(
            f"/api/task/{task_id}/actions/{proposal['id']}/confirm?project_id={project_id}",
            headers={"Idempotency-Key": "confirm-action-create"},
        )
        assert confirmed.status_code == 200, confirmed.text
        assert (action_root / "start.sh").read_text() == CoordinatorFakeEngine.reply["proposal"]["payload"]["script_content"]
        assert json.loads((action_root / "action.json").read_text())["timeout_seconds"] == 0
        steps = await main.project_manager.run_db(
            project_id, lambda _: json.loads(Workflow.get_by_id(workflow_id).steps_json)
        )
        assert any(button["action_id"] == action_id for button in steps["quickButtons"])
        repeated = await client.post(
            f"/api/task/{task_id}/actions/{proposal['id']}/confirm?project_id={project_id}",
            headers={"Idempotency-Key": "confirm-action-create"},
        )
        assert repeated.status_code == 200
        assert len([button for button in steps["quickButtons"] if button["action_id"] == action_id]) == 1
        CoordinatorFakeEngine.reply = {
            **CoordinatorFakeEngine.reply,
            "proposal": {
                "type": "create_workflow_action",
                "payload": {
                    **CoordinatorFakeEngine.reply["proposal"]["payload"],
                    "title": "重新启动服务",
                    "script_content": "#!/bin/bash\necho updated\n",
                },
            },
        }
        submitted = await client.post(
            f"/api/task/{task_id}/chat?project_id={project_id}",
            headers={"Idempotency-Key": "chat-action-overwrite"},
            json={"content": "更新启动服务快捷按钮"},
        )
        replacement = await _wait_for_reply(
            client, project_id, task_id, submitted.json()["assistant_message_id"]
        )
        replacement_proposal = replacement["proposals"][0]
        failed_replacement = await client.post(
            f"/api/task/{task_id}/actions/{replacement_proposal['id']}/confirm?project_id={project_id}",
            headers={"Idempotency-Key": "confirm-action-duplicate"},
        )
        assert failed_replacement.status_code == 409
        history = await client.get(f"/api/task/{task_id}/history?project_id={project_id}")
        failed = next(proposal for message in history.json()["messages"] for proposal in message.get("proposals", []) if proposal["id"] == replacement_proposal["id"])
        assert failed["status"] == "failed"
        confirmed_replacement = await client.post(
            f"/api/task/{task_id}/actions/{replacement_proposal['id']}/confirm?project_id={project_id}",
            headers={"Idempotency-Key": "confirm-action-overwrite"},
            json={"overwrite": True},
        )
        assert confirmed_replacement.status_code == 200, confirmed_replacement.text
        assert (action_root / "start.sh").read_text() == "#!/bin/bash\necho updated\n"
    finally:
        CoordinatorFakeEngine.reply = {"version": 1, "reply": "协调回复", "intent": "answer", "proposal": None}


class MemoryConfigStore:
    def __init__(self):
        self.values = {}

    def get(self, key, default=None):
        return self.values.get(key, default)

    def set(self, key, value):
        self.values[key] = value

    def get_execution_default_engine(self):
        return self.values.get("execution_default_engine", "")

    def get_coordinator_default_engine(self):
        return self.values.get("coordinator_default_engine", "")

    def get_coordinator_default_model(self):
        return self.values.get("coordinator_default_model", "")

    def get_coordinator_default_fast_model(self):
        return self.values.get("coordinator_default_fast_model", "")

    def get_coordinator_default_vision_model(self):
        return self.values.get("coordinator_default_vision_model", "")

    def get_coordinator_default_thinking_effort(self):
        return self.values.get("coordinator_default_thinking_effort", "")

    def get_engine_default_model(self, engine_id):
        return ""

    def get_engine_provider(self, engine_id):
        return ""

    def model_supports_multimodal(self, engine_id, model, provider_id=""):
        return any(
            item.get("model") == model
            and item.get("engine_id") == engine_id
            and item.get("supports_multimodal") is True
            for item in self.values.get("model_pricing", {}).get("prices", [])
        )

    def is_engine_verified(self, engine_id):
        return True

    def get_provider(self, provider_id):
        for item in self.values.get("providers", []):
            if item.get("id") == provider_id:
                return dict(item)
        return None

    def get_pydantic_ai_engine_config(self):
        return {
            "provider_id": "",
            "model": "",
            "mcp_servers": [],
            "harness": "auto",
        }


def test_coordinator_parses_json_after_plain_language_explanation():
    module = CoordinatorModule.__new__(CoordinatorModule)
    raw = (
        "我先核对了任务状态，旧结果是 {不是 JSON}，建议重新执行开发阶段。\n\n"
        '{"version":1,"reply":"开始重跑","intent":"propose_action",'
        '"proposal":{"type":"supplement_stage","target_step_key":"dev",'
        '"payload":{"content":"入口移到设置页"}}}'
    )

    parsed = module._parse_result(raw)

    assert parsed["reply"] == "开始重跑"
    assert parsed["proposal"]["target_step_key"] == "dev"


def test_default_coordinator_engine_follows_global_execution_default(monkeypatch):
    import agent_assistants.coordinator as coordinator_service

    store = MemoryConfigStore()
    store.set("execution_default_engine", "codex")
    monkeypatch.setattr(coordinator_service, "config_store", store)
    monkeypatch.setattr(
        coordinator_service,
        "create_engine",
        lambda engine_id: SimpleNamespace(
            capabilities=SimpleNamespace(supports_coordinator=True)
        ),
    )
    task = SimpleNamespace(
        engine="claude",
        coordinator_engine="",
        coordinator_model="",
        coordinator_fast_model="",
        coordinator_vision_model="",
    )

    engine_id, _, _, _ = CoordinatorModule.__new__(CoordinatorModule)._resolve_engine_models(task)

    assert engine_id == "codex"


@pytest.fixture
async def api_context(tmp_path, monkeypatch):
    import api.history as history_api
    import api.project as project_api
    import api.search as search_api
    import api.task as task_api
    import api.templates as templates_api
    import api.workflow as workflow_api
    import main
    import services.project as project_service
    import agent_assistants.coordinator as coordinator_service

    config_store = MemoryConfigStore()
    # 默认执行引擎固定为 claude：协调器按 task.engine 回退时会命中
    # 测试注册到 "claude" 的假引擎；需要验证全局默认的测试会自行覆盖。
    config_store.set("execution_default_engine", "claude")
    manager = ProjectManager()
    bus = EventBus()
    task_service = TaskService(bus)
    runtime = WorkflowRuntime(bus, manager)
    coordinator = CoordinatorModule(bus, manager, runtime)
    monkeypatch.setattr(project_service, "config_store", config_store)
    monkeypatch.setattr(coordinator_service, "config_store", config_store)
    monkeypatch.setattr(task_api, "config_store", config_store)
    monkeypatch.setattr(project_api, "project_manager", manager)
    monkeypatch.setattr(history_api, "project_manager", manager)
    monkeypatch.setattr(search_api, "project_manager", manager)
    monkeypatch.setattr(workflow_api, "project_manager", manager)
    monkeypatch.setattr(templates_api, "GLOBAL_TEMPLATES_DIR", tmp_path / "templates")
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "task_service", task_service)
    monkeypatch.setattr(main, "workflow_runtime", runtime)
    monkeypatch.setattr(main, "coordinator_module", coordinator)

    transport = ASGITransport(app=main.app)
    async with AsyncExitStack() as stack:
        client = await stack.enter_async_context(
            AsyncClient(transport=transport, base_url="http://test")
        )
        yield client, tmp_path

    await coordinator.shutdown()
    await runtime.shutdown()
    await bus.close()
    manager.close_all()


class CoordinatorFakeEngine(AcpEngineBase):
    calls: list[dict] = []
    reply = {
        "version": 1,
        "reply": "协调回复",
        "intent": "answer",
        "target_step_key": None,
        "artifact_requests": [],
        "proposal": None,
    }

    @staticmethod
    def is_installed():
        return True

    @staticmethod
    def get_version():
        return "fake"

    @staticmethod
    def resolve_binary():
        return "fake"

    async def spawn(self, prompt, cwd, model=None, session_id=None, **kwargs):
        type(self).calls.append({
            "prompt": prompt,
            "cwd": cwd,
            "model": model,
            "session_id": session_id,
        })
        yield InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": json.dumps(type(self).reply, ensure_ascii=False)}},
        )
        yield InternalEvent(
            type="usage_update",
            data={"input_tokens": 120, "output_tokens": 30, "total_tokens": 150},
        )

    async def stop(self):
        return None

    async def inject_response(self, tool_use_id, content):
        return None

    @property
    def supports_resume(self):
        return False

    @property
    def supports_interactive(self):
        return False

    def build_resume_params(self, session_id):
        return {}


class ThinkingJournalCoordinatorFakeEngine(CoordinatorFakeEngine):
    async def spawn(self, prompt, cwd, model=None, session_id=None, **kwargs):
        yield InternalEvent(
            type="agent_thought_chunk",
            data={"content": {"text": "协调器内部思考"}},
        )
        yield InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": json.dumps(type(self).reply, ensure_ascii=False)}},
        )


class SecondCoordinatorFakeEngine(CoordinatorFakeEngine):
    calls: list[dict] = []


class ArchiveProgressCoordinatorFakeEngine(CoordinatorFakeEngine):
    calls: list[dict] = []

    async def spawn(self, prompt, cwd, model=None, session_id=None, **kwargs):
        type(self).calls.append({"prompt": prompt, "cwd": cwd, "model": model})
        yield InternalEvent(
            type="agent_thought_chunk",
            data={"content": {"text": "正在核对失败记录"}},
        )
        yield InternalEvent(
            type="tool_call",
            data={
                "tool_call_id": "inspect-errors",
                "title": "检查任务错误",
                "kind": "read",
                "raw_input": {"task": "current"},
            },
        )
        yield InternalEvent(
            type="tool_call_update",
            data={
                "tool_call_id": "inspect-errors",
                "status": "completed",
                "raw_output": "发现一条构建错误",
            },
        )
        yield InternalEvent(
            type="agent_message_chunk",
            data={
                "content": {
                    "text": json.dumps(
                        {
                            "version": 1,
                            "reply": "- 错误：忽略类型检查；原因：未先构建；纠正：提交前运行类型检查。",
                            "intent": "answer",
                            "target_step_key": None,
                            "artifact_requests": [],
                            "proposal": None,
                        },
                        ensure_ascii=False,
                    )
                }
            },
        )


class BlockingArchiveCoordinatorFakeEngine(CoordinatorFakeEngine):
    started: asyncio.Event
    released: asyncio.Event
    stopped = False

    async def spawn(self, prompt, cwd, model=None, session_id=None, **kwargs):
        type(self).started.set()
        await type(self).released.wait()
        yield InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": json.dumps(type(self).reply, ensure_ascii=False)}},
        )

    async def stop(self):
        type(self).stopped = True
        type(self).released.set()


class ImageRoutingCoordinatorFakeEngine(CoordinatorFakeEngine):
    calls: list[dict] = []

    @property
    def supports_vision(self):
        return True

    async def spawn(self, prompt, cwd, model=None, session_id=None, **kwargs):
        type(self).calls.append({
            "prompt": prompt,
            "model": model,
            "images": kwargs.get("images"),
        })
        yield InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": json.dumps(type(self).reply, ensure_ascii=False)}},
        )
        yield InternalEvent(
            type="usage_update",
            data={"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
        )


class StreamingCoordinatorFakeEngine(CoordinatorFakeEngine):
    release: asyncio.Event

    async def spawn(self, prompt, cwd, model=None, session_id=None, **kwargs):
        yield InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": '{"version":1,"reply":"实时'}},
        )
        await type(self).release.wait()
        yield InternalEvent(
            type="agent_message_chunk",
            data={
                "content": {"text": (
                    '回复","intent":"answer","target_step_key":null,'
                    '"artifact_requests":[],"proposal":null}'
                )}
            },
        )


class RoutedCoordinatorFakeEngine(CoordinatorFakeEngine):
    calls: list[dict] = []

    async def spawn(self, prompt, cwd, model=None, session_id=None, **kwargs):
        type(self).calls.append({
            "prompt": prompt,
            "cwd": cwd,
            "model": model,
            "session_id": session_id,
        })
        if model == "reasoning-model":
            yield InternalEvent(type="agent_message_chunk", data={"content": {"text": "invalid json"}})
            return
        yield InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": json.dumps(type(self).reply, ensure_ascii=False)}},
        )


class ThinkingEffortCoordinatorFakeEngine(CoordinatorFakeEngine):
    """Fake that records the per-turn thinking effort passed to spawn."""

    calls: list[dict] = []

    @property
    def supports_thinking_effort(self):
        return True

    async def spawn(self, prompt, cwd, model=None, session_id=None, **kwargs):
        type(self).calls.append({
            "prompt": prompt,
            "model": model,
            "thinking_effort": kwargs.get("thinking_effort"),
        })
        yield InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": json.dumps(type(self).reply, ensure_ascii=False)}},
        )


class ResumeCoordinatorFakeEngine(CoordinatorFakeEngine):
    """Resume-capable fake that also maintains engine-side message history."""

    calls: list[dict] = []

    @property
    def supports_resume(self):
        return True

    @property
    def supports_message_history(self):
        return True

    async def spawn(self, prompt, cwd, model=None, session_id=None, **kwargs):
        type(self).calls.append({
            "prompt": prompt,
            "session_id": session_id,
            "message_history": kwargs.get("message_history"),
            "report_engine_state": kwargs.get("report_engine_state"),
        })
        yield InternalEvent(
            type="session_started",
            data={"session_id": "engine-session-1"},
        )
        yield InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": json.dumps(type(self).reply, ensure_ascii=False)}},
        )
        yield InternalEvent(
            type="engine_state",
            data={"state": {"round": len(type(self).calls)}},
        )
        yield InternalEvent(
            type="usage_update",
            data={"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
        )


async def _create_task(client, tmp_path, headers=None):
    project_dir = tmp_path / "coordinator-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]
    from services.project import DEFAULT_STEPS
    import main

    await main.project_manager.run_db(
        project_id,
        lambda project: main.project_manager.create_workflow(project, "测试流程", DEFAULT_STEPS),
    )
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={
            "title": "Coordinator task",
            "cwd": str(project_dir),
            "auto_start": False,
        },
        headers=headers,
    )
    return project_id, created.json()["id"]


async def _wait_for_reply(
    client,
    project_id,
    task_id,
    assistant_message_id=None,
    include_stopped=False,
):
    accepted_statuses = {"succeeded", "failed"}
    if include_stopped:
        accepted_statuses.add("stopped")
    for _ in range(100):
        response = await client.get(
            f"/api/task/{task_id}/history?project_id={project_id}"
        )
        messages = response.json()["messages"]
        assistants = [
            item for item in messages
            if item["channel"] == "coordinator"
            and item["role"] == "assistant"
            and item["run_status"] in accepted_statuses
            and (
                assistant_message_id is None
                or item["id"] == assistant_message_id
            )
        ]
        if assistants:
            return assistants[-1]
        await asyncio.sleep(0.01)
    raise AssertionError("Coordinator reply did not complete")


@pytest.mark.anyio
async def test_stop_orphaned_coordinator_turn_persists_terminal_state(api_context):
    """A persisted running turn remains stoppable after its memory task is lost."""
    import main
    from models import CoordinatorTurn, Message, Task
    from models.fields import utc_now

    client, tmp_path = api_context
    project_id, task_id = await _create_task(client, tmp_path)

    def create_orphan(project):
        task = Task.get_by_id(task_id)
        now = utc_now()
        journal_ref = main.coordinator_module._event_journal.start(
            project.workstep_dir,
            f"task-{task_id}",
            "orphan-coordinator-assistant",
        )
        user = Message.create(
            id="orphan-coordinator-user",
            task=task,
            channel="coordinator",
            step_key="coordinator",
            role="user",
            content="继续",
            run_id="orphan-coordinator-turn",
            run_status="completed",
            position=0,
            sequence=1,
            created_at=now,
        )
        assistant = Message.create(
            id="orphan-coordinator-assistant",
            task=task,
            channel="coordinator",
            step_key="coordinator",
            role="assistant",
            content="",
            run_id="orphan-coordinator-turn",
            run_status="running",
            event_log_path=journal_ref.relative_path,
            position=1,
            sequence=2,
            created_at=now,
            started_at=now,
        )
        CoordinatorTurn.create(
            id="orphan-coordinator-turn",
            task=task,
            user_message=user,
            assistant_message=assistant,
            idempotency_key="orphan-coordinator-key",
            status="running",
            created_at=now,
            started_at=now,
        )

    await main.project_manager.run_db(project_id, create_orphan)

    stopped = await main.coordinator_module.stop_current(project_id, task_id)

    assert stopped is True
    state = await main.project_manager.run_db(
        project_id,
        lambda _project: (
            CoordinatorTurn.get_by_id("orphan-coordinator-turn").status,
            Message.get_by_id("orphan-coordinator-assistant").run_status,
        ),
    )
    assert state == ("stopped", "stopped")


@pytest.mark.anyio
async def test_stop_coordinator_prioritizes_running_turn_over_newer_queue(api_context):
    """Queued follow-ups must not hide the turn whose engine is actually running."""
    import main
    from datetime import timedelta
    from models import CoordinatorTurn, Message, Task
    from models.fields import utc_now

    client, tmp_path = api_context
    project_id, task_id = await _create_task(client, tmp_path)

    def create_turn(project, suffix, status, sequence, created_at):
        task = Task.get_by_id(task_id)
        journal_ref = main.coordinator_module._event_journal.start(
            project.workstep_dir,
            f"task-{task_id}",
            f"priority-{suffix}-assistant",
        )
        user = Message.create(
            id=f"priority-{suffix}-user",
            task=task,
            channel="coordinator",
            step_key="coordinator",
            role="user",
            content=suffix,
            run_id=f"priority-{suffix}-turn",
            run_status="completed",
            position=0,
            sequence=sequence,
            created_at=created_at,
        )
        assistant = Message.create(
            id=f"priority-{suffix}-assistant",
            task=task,
            channel="coordinator",
            step_key="coordinator",
            role="assistant",
            content="",
            run_id=f"priority-{suffix}-turn",
            run_status=status,
            event_log_path=journal_ref.relative_path,
            position=1,
            sequence=sequence + 1,
            created_at=created_at,
            started_at=created_at if status == "running" else None,
        )
        CoordinatorTurn.create(
            id=f"priority-{suffix}-turn",
            task=task,
            user_message=user,
            assistant_message=assistant,
            idempotency_key=f"priority-{suffix}-key",
            status=status,
            created_at=created_at,
            started_at=created_at if status == "running" else None,
        )

    def create_state(project):
        now = utc_now()
        create_turn(project, "running", "running", 1, now)
        create_turn(project, "queued", "queued", 3, now + timedelta(seconds=1))

    await main.project_manager.run_db(project_id, create_state)

    assert await main.coordinator_module.stop_current(project_id, task_id) is True
    states = await main.project_manager.run_db(
        project_id,
        lambda _project: {
            row.id: row.status
            for row in CoordinatorTurn.select().where(
                CoordinatorTurn.task == task_id
            )
        },
    )

    assert states["priority-running-turn"] == "stopped"
    assert states["priority-queued-turn"] == "queued"


@pytest.mark.anyio
async def test_reconcile_orphaned_coordinator_turn_requeues_and_finishes(
    api_context, monkeypatch
):
    """Online reconciliation resumes a persisted turn with no memory runner."""
    import main
    from engines.core.registry import ENGINE_REGISTRY
    from models import CoordinatorTurn, Message, Task
    from models.fields import utc_now

    client, tmp_path = api_context
    project_id, task_id = await _create_task(client, tmp_path)

    def create_orphan(project):
        task = Task.get_by_id(task_id)
        now = utc_now()
        journal_ref = main.coordinator_module._event_journal.start(
            project.workstep_dir,
            f"task-{task_id}",
            "recover-coordinator-assistant",
        )
        user = Message.create(
            id="recover-coordinator-user",
            task=task,
            channel="coordinator",
            step_key="coordinator",
            role="user",
            content="现在进展如何",
            run_id="recover-coordinator-turn",
            run_status="completed",
            position=0,
            sequence=1,
            created_at=now,
        )
        assistant = Message.create(
            id="recover-coordinator-assistant",
            task=task,
            channel="coordinator",
            step_key="coordinator",
            role="assistant",
            content="",
            engine="claude",
            run_id="recover-coordinator-turn",
            run_status="running",
            event_log_path=journal_ref.relative_path,
            position=1,
            sequence=2,
            created_at=now,
            started_at=now,
        )
        CoordinatorTurn.create(
            id="recover-coordinator-turn",
            task=task,
            user_message=user,
            assistant_message=assistant,
            idempotency_key="recover-coordinator-key",
            status="running",
            engine="claude",
            created_at=now,
            started_at=now,
        )

    await main.project_manager.run_db(project_id, create_orphan)
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", CoordinatorFakeEngine)
    CoordinatorFakeEngine.calls = []

    assert await main.coordinator_module.reconcile_orphaned_state() == 1
    reply = await _wait_for_reply(
        client,
        project_id,
        task_id,
        assistant_message_id="recover-coordinator-assistant",
    )

    assert reply["run_status"] == "succeeded"
    state = await main.project_manager.run_db(
        project_id,
        lambda _project: CoordinatorTurn.get_by_id(
            "recover-coordinator-turn"
        ).status,
    )
    assert state == "succeeded"


@pytest.mark.anyio
async def test_reconcile_abandoned_executing_coordinator_action(api_context):
    """An executing proposal without an in-memory operation becomes retryable failure."""
    import main
    from models import ActionProposal, CoordinatorTurn, Message, Task
    from models.fields import utc_now

    client, tmp_path = api_context
    project_id, task_id = await _create_task(client, tmp_path)

    def create_abandoned_action(_project):
        task = Task.get_by_id(task_id)
        now = utc_now()
        user = Message.create(
            id="action-orphan-user",
            task=task,
            channel="coordinator",
            step_key="coordinator",
            role="user",
            content="重跑",
            run_id="action-orphan-turn",
            run_status="completed",
            position=0,
            sequence=1,
            created_at=now,
        )
        assistant = Message.create(
            id="action-orphan-assistant",
            task=task,
            channel="coordinator",
            step_key="coordinator",
            role="assistant",
            content="建议重跑",
            run_id="action-orphan-turn",
            run_status="succeeded",
            position=1,
            sequence=2,
            created_at=now,
            ended_at=now,
        )
        turn = CoordinatorTurn.create(
            id="action-orphan-turn",
            task=task,
            user_message=user,
            assistant_message=assistant,
            idempotency_key="action-orphan-key",
            status="succeeded",
            created_at=now,
            ended_at=now,
        )
        ActionProposal.create(
            id="action-orphan-proposal",
            task=task,
            source_turn=turn,
            source_message=assistant,
            type="rerun_from_step",
            target_step_key="req",
            payload_json=json.dumps({"content": "重跑"}),
            expected_task_version=task.state_version,
            status="executing",
            created_at=now,
            updated_at=now,
        )

    await main.project_manager.run_db(project_id, create_abandoned_action)

    assert await main.coordinator_module.reconcile_orphaned_state() == 1
    state = await main.project_manager.run_db(
        project_id,
        lambda _project: (
            ActionProposal.get_by_id("action-orphan-proposal").status,
            ActionProposal.get_by_id("action-orphan-proposal").error,
        ),
    )
    assert state == ("failed", "协调助手操作中断，请重新发起")


@pytest.mark.anyio
async def test_archive_experience_uses_coordinator_with_task_history(
    api_context, monkeypatch
):
    """The archive draft is generated by the coordinator from task evidence."""
    from engines.core.registry import ENGINE_REGISTRY

    client, tmp_path = api_context
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", CoordinatorFakeEngine)
    CoordinatorFakeEngine.calls = []
    monkeypatch.setattr(
        CoordinatorFakeEngine,
        "reply",
        {
            "version": 1,
            "reply": "- 问题：构建失败\n- 经验：先核对类型错误",
            "intent": "answer",
            "target_step_key": None,
            "artifact_requests": [],
            "proposal": None,
        },
    )
    project_id, task_id = await _create_task(client, tmp_path)
    await client.patch(
        f"/api/task/{task_id}?project_id={project_id}",
        json={"description": "曾遇到构建失败，需要修正类型错误"},
    )

    response = await client.post(
        f"/api/task/{task_id}/archive-experience/prepare?project_id={project_id}"
    )

    assert response.status_code == 200
    assert response.json()["experience"] == "- 问题：构建失败\n- 经验：先核对类型错误"
    assert len(CoordinatorFakeEngine.calls) == 1
    assert "曾遇到构建失败，需要修正类型错误" in CoordinatorFakeEngine.calls[0]["prompt"]
    assert "Record only directly evidenced mistakes" in CoordinatorFakeEngine.calls[0]["prompt"]


@pytest.mark.anyio
async def test_archive_experience_slow_evidence_keeps_health_responsive(
    api_context, monkeypatch,
):
    import threading
    from engines.core.registry import ENGINE_REGISTRY
    import main

    client, tmp_path = api_context
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", CoordinatorFakeEngine)
    project_id, task_id = await _create_task(client, tmp_path)
    drafts = main.coordinator_module._archive_drafts
    original = drafts._load_archive_evidence_sync
    entered = threading.Event()
    release = threading.Event()

    def slow_evidence(project_id, task_id):
        entered.set()
        release.wait(timeout=2)
        return original(project_id, task_id)

    monkeypatch.setattr(drafts, "_load_archive_evidence_sync", slow_evidence)
    prepare = asyncio.create_task(client.post(
        f"/api/task/{task_id}/archive-experience/prepare?project_id={project_id}"
    ))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
        assert health.status_code == 200
    finally:
        release.set()
    assert (await prepare).status_code == 200


@pytest.mark.anyio
async def test_archive_experience_streams_visible_coordinator_progress(
    api_context, monkeypatch
):
    """Archive preparation exposes reasoning, tools, and reply over AG-UI."""
    from engines.core.registry import ENGINE_REGISTRY
    import main

    client, tmp_path = api_context
    monkeypatch.setitem(
        ENGINE_REGISTRY,
        "claude",
        ArchiveProgressCoordinatorFakeEngine,
    )
    ArchiveProgressCoordinatorFakeEngine.calls = []
    project_id, task_id = await _create_task(client, tmp_path)
    event_queue = main.coordinator_module._event_bus.subscribe()
    message_id = "archive-progress-visible"
    try:
        response = await client.post(
            f"/api/task/{task_id}/archive-experience/prepare"
            f"?project_id={project_id}&message_id={message_id}"
        )
        events = []
        while not event_queue.empty():
            event = event_queue.get_nowait()
            if event.get("messageId") == message_id:
                events.append(event)
    finally:
        main.coordinator_module._event_bus.unsubscribe(event_queue)

    assert response.status_code == 200
    assert response.json() == {
        "message_id": message_id,
        "experience": "- 错误：忽略类型检查；原因：未先构建；纠正：提交前运行类型检查。",
        "has_experience": True,
        "cached": False,
    }
    assert [event["type"] for event in events] == [
        "TEXT_MESSAGE_START",
        "REASONING_MESSAGE_CHUNK",
        "REASONING_MESSAGE_CHUNK",
        "REASONING_MESSAGE_CHUNK",
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_RESULT",
        "TEXT_MESSAGE_CHUNK",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
    ]
    assert all(event["channel"] == "archive_experience" for event in events)
    assert "Task evidence" in events[0]["prompt"]
    assert "must not be written to Memory now" in events[0]["prompt"]
    assert "not a task summary" in ArchiveProgressCoordinatorFakeEngine.calls[0]["prompt"]
    assert "at most 3" in ArchiveProgressCoordinatorFakeEngine.calls[0]["prompt"]

    reopened = await client.get(
        f"/api/task/{task_id}/archive-experience/draft?project_id={project_id}"
    )
    assert reopened.status_code == 200
    history = reopened.json()
    assert history["found"] is True
    assert "Task evidence" in history["prompt"]
    assert [event["type"] for event in history["events"]] == [
        event["type"] for event in events
    ]
    project = main.project_manager.get_project_by_id(project_id)
    assert (
        project.workstep_dir
        / "event_logs"
        / f"task-{task_id}"
        / f"{message_id}.jsonl"
    ).is_file()


@pytest.mark.anyio
async def test_archive_experience_can_be_stopped_by_message_id(
    api_context, monkeypatch
):
    """A visible archive draft run has its own stoppable lifecycle."""
    from engines.core.registry import ENGINE_REGISTRY

    client, tmp_path = api_context
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", BlockingArchiveCoordinatorFakeEngine)
    BlockingArchiveCoordinatorFakeEngine.started = asyncio.Event()
    BlockingArchiveCoordinatorFakeEngine.released = asyncio.Event()
    BlockingArchiveCoordinatorFakeEngine.stopped = False
    project_id, task_id = await _create_task(client, tmp_path)
    message_id = "archive-progress-stoppable"

    prepare = asyncio.create_task(
        client.post(
            f"/api/task/{task_id}/archive-experience/prepare"
            f"?project_id={project_id}&message_id={message_id}"
        )
    )
    await asyncio.wait_for(BlockingArchiveCoordinatorFakeEngine.started.wait(), 1)

    stopped = await client.post(
        f"/api/task/{task_id}/archive-experience/stop"
        f"?project_id={project_id}&message_id={message_id}"
    )
    prepared = await asyncio.wait_for(prepare, 1)

    assert stopped.status_code == 200
    assert stopped.json() == {"stopped": True}
    assert BlockingArchiveCoordinatorFakeEngine.stopped is True
    assert prepared.status_code == 409


@pytest.mark.anyio
async def test_archive_experience_reports_progress_before_engine_reply(
    api_context, monkeypatch
):
    """The process view advances even while the coordinator has not replied."""
    from engines.core.registry import ENGINE_REGISTRY
    import main

    client, tmp_path = api_context
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", BlockingArchiveCoordinatorFakeEngine)
    BlockingArchiveCoordinatorFakeEngine.started = asyncio.Event()
    BlockingArchiveCoordinatorFakeEngine.released = asyncio.Event()
    BlockingArchiveCoordinatorFakeEngine.stopped = False
    project_id, task_id = await _create_task(client, tmp_path)
    message_id = "archive-progress-before-reply"
    event_queue = main.coordinator_module._event_bus.subscribe()
    prepare = asyncio.create_task(
        client.post(
            f"/api/task/{task_id}/archive-experience/prepare"
            f"?project_id={project_id}&message_id={message_id}"
        )
    )
    try:
        await asyncio.wait_for(BlockingArchiveCoordinatorFakeEngine.started.wait(), 1)
        events = []
        while not event_queue.empty():
            event = event_queue.get_nowait()
            if event.get("messageId") == message_id:
                events.append(event)
        progress = [
            str(event.get("delta") or "")
            for event in events
            if event.get("type") == "REASONING_MESSAGE_CHUNK"
        ]
        assert any("Read task record" in item for item in progress)
        assert any("waiting for a response" in item for item in progress)
    finally:
        await client.post(
            f"/api/task/{task_id}/archive-experience/stop"
            f"?project_id={project_id}&message_id={message_id}"
        )
        await asyncio.wait_for(prepare, 1)
        main.coordinator_module._event_bus.unsubscribe(event_queue)


@pytest.mark.anyio
async def test_chat_message_ids_are_monotonic_uuid7(api_context, monkeypatch):
    """新消息 ID 自带时间，并且可直接按字符串还原创建顺序。"""
    from engines.core.registry import ENGINE_REGISTRY

    client, tmp_path = api_context
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", CoordinatorFakeEngine)
    project_id, task_id = await _create_task(client, tmp_path)

    responses = []
    for index in range(2):
        response = await client.post(
            f"/api/task/{task_id}/chat?project_id={project_id}",
            headers={"Idempotency-Key": f"sortable-{index}"},
            json={"content": f"第 {index + 1} 条消息"},
        )
        assert response.status_code == 200
        responses.append(response.json())

    message_ids = [
        message_id
        for response in responses
        for message_id in (
            response["user_message_id"],
            response["assistant_message_id"],
        )
    ]
    assert all(uuid.UUID(message_id).version == 7 for message_id in message_ids)
    assert message_ids == sorted(message_ids)


@pytest.mark.anyio
async def test_coordinator_publishes_user_message_as_live_event(api_context, monkeypatch):
    """远端 B 依赖 TEXT_MESSAGE_START 事件刷新对话，而不是等重新打开详情。"""
    import main

    client, tmp_path = api_context
    from engines.core.registry import ENGINE_REGISTRY

    monkeypatch.setitem(ENGINE_REGISTRY, "claude", CoordinatorFakeEngine)

    class RecordingEventBus:
        def __init__(self, original):
            self.original = original
            self.events = []

        async def publish(self, event):
            self.events.append(event)
            await self.original.publish(event)

    recorder = RecordingEventBus(main.coordinator_module._event_bus)
    monkeypatch.setattr(main.coordinator_module, "_event_bus", recorder)

    project_id, task_id = await _create_task(client, tmp_path)
    response = await client.post(
        f"/api/task/{task_id}/chat?project_id={project_id}",
        headers={"Idempotency-Key": "live-user-1"},
        json={"content": "请继续推进"},
    )
    assert response.status_code == 200
    payload = response.json()

    user_start = next(
        event for event in recorder.events
        if event.get("type") == "TEXT_MESSAGE_START"
        and event.get("messageId") == payload["user_message_id"]
    )
    assert user_start["role"] == "user"
    assert user_start["channel"] == "coordinator"
    assert user_start["task_id"] == task_id
    assert user_start["content"] == "请继续推进"


@pytest.mark.anyio
async def test_browser_actor_is_persisted_on_task_and_coordinator_user_message(
    api_context, monkeypatch
):
    import main
    from models import Message, Task

    client, tmp_path = api_context
    headers = {
        "Idempotency-Key": "browser-actor-1",
        "X-WorkStep-Actor-Id": "browser-1",
        "X-WorkStep-Actor-Name": "%E6%B5%8F%E8%A7%88%E5%99%A8%E7%94%A8%E6%88%B7",
        "X-WorkStep-Actor-Device-Id": "browser-device-1",
        "X-WorkStep-Actor-Device-Name": "Chrome",
    }
    project_id, task_id = await _create_task(client, tmp_path, headers)
    response = await client.post(
        f"/api/task/{task_id}/chat?project_id={project_id}",
        headers=headers,
        json={"content": "请记录作者"},
    )
    assert response.status_code == 200, response.text

    def load():
        task = Task.get_by_id(task_id)
        message = Message.get_by_id(response.json()["user_message_id"])
        return {
            "task_creator": (
                task.creator_id,
                task.creator_name,
                task.creator_device_id,
                task.creator_device_name,
            ),
            "message_author": (
                message.author_id,
                message.author_name,
                message.author_device_id,
                message.author_device_name,
            ),
        }

    stored = await main.project_manager.run_db(project_id, lambda _project: load())
    assert stored == {
        "task_creator": (
            "browser-1",
            "浏览器用户",
            "browser-device-1",
            "Chrome",
        ),
        "message_author": (
            "browser-1",
            "浏览器用户",
            "browser-device-1",
            "Chrome",
        ),
    }


@pytest.mark.anyio
async def test_coordinator_keeps_thinking_only_in_event_log(api_context, monkeypatch):
    from engines.core.registry import ENGINE_REGISTRY
    from models import Message
    import main

    client, tmp_path = api_context
    monkeypatch.setitem(
        ENGINE_REGISTRY,
        "claude",
        ThinkingJournalCoordinatorFakeEngine,
    )
    project_id, task_id = await _create_task(client, tmp_path)
    accepted = await client.post(
        f"/api/task/{task_id}/chat?project_id={project_id}",
        headers={"Idempotency-Key": "thinking-journal-1"},
        json={"content": "请分析"},
    )
    assistant_id = accepted.json()["assistant_message_id"]
    await _wait_for_reply(client, project_id, task_id, assistant_id)

    with main.project_manager.activate_project_by_id(project_id) as project:
        message = Message.get_by_id(assistant_id)
        assert "协调器内部思考" not in (message.events_json or "")
        assert message.event_log_path
        records = [
            json.loads(line)
            for line in (project.workstep_dir / message.event_log_path)
            .read_text()
            .splitlines()
        ]

    assert "agent_thought_chunk" in {record["type"] for record in records}


def test_assemble_context_includes_review_mode(tmp_path):
    """协调上下文必须带每阶段 review_mode（auto/manual/无）与审核记录 mode，避免协调 agent 猜测。"""
    from models import (
        CoordinatorSession,
        CoordinatorTurn,
        ReviewRun,
        StepRun,
        Task,
        TaskStep,
        WorkflowRun,
        init_db,
    )
    from agent_assistants.coordinator import CoordinatorModule
    from streaming.bus import EventBus

    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="ctx-review-task",
        title="t",
        cwd=str(tmp_path),
        engine="claude",
        review_overrides_json=json.dumps({"build": {"auto": False}}),
        created_at=1,
        updated_at=1,
    )
    TaskStep.create(
        task=task, step_key="build", status="awaiting_review", engine="claude"
    )
    TaskStep.create(task=task, step_key="plan", status="pending", engine="claude")
    workflow_run = WorkflowRun.create(
        id="ctx-review-wf",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json="{}",
        started_at=1,
    )
    step_run = StepRun.create(
        id="ctx-step-run",
        run=workflow_run,
        step_key="build",
        attempt=1,
        status="succeeded",
        engine="claude",
    )
    ReviewRun.create(
        id="ctx-review-run",
        workflow_run=workflow_run,
        step_run=step_run,
        task=task,
        step_key="build",
        attempt=1,
        mode="manual",
        status="pending",
        started_at=1,
    )
    from models import Message

    user_message = Message.create(
        id="ctx-user-msg",
        task=task,
        channel="coordinator",
        step_key="build",
        role="user",
        content="进行到哪里了",
        run_id="ctx-user-msg",
        run_status="completed",
        position=1,
        created_at=1,
    )
    assistant_message = Message.create(
        id="ctx-assistant-msg",
        task=task,
        channel="coordinator",
        step_key="build",
        role="assistant",
        content="",
        run_id="ctx-assistant-msg",
        run_status="running",
        position=2,
        created_at=1,
    )
    turn = CoordinatorTurn.create(
        id="ctx-turn",
        task=task,
        user_message_id=user_message.id,
        assistant_message_id=assistant_message.id,
        idempotency_key="ctx-ik",
        status="running",
        created_at=1,
    )

    class StubProject:
        steps = {
            "steps": [{
                "key": "build",
                "label": "构建",
                "engine": "claude",
                "review": {"auto": True, "maxRetries": 1},
            }]
        }
        workstep_dir = tmp_path
        path = tmp_path

        def workflow_by_id(self, workflow_id):
            return None

    prompt, _ = assemble_context(StubProject(), task, turn)
    try:
        context_json = prompt.split("Context:\n", 1)[1]
        context = json.loads(context_json)
        by_key = {step["step_key"]: step for step in context["steps"]}
        # 工作流 auto:true 被任务级覆盖为 manual
        assert by_key["build"]["review_mode"] == "manual"
        # 无审核配置的阶段不声明模式
        assert by_key["plan"]["review_mode"] is None
        assert context["reviews"][0]["mode"] == "manual"
    finally:
        db.close()


def test_coordinator_root_uses_project_root_with_workflow(tmp_path):
    """协调 Agent 始终从项目根目录启动，不在产物目录创建运行数据。"""
    workstep_dir = tmp_path / ".workstep"
    project = SimpleNamespace(path=tmp_path, workstep_dir=workstep_dir)
    task = SimpleNamespace(workflow_id="f0e8bc06", cwd=str(tmp_path / "other"))
    root = coordinator_root(project, task)
    assert root == str(tmp_path)
    assert not (workstep_dir / "artifacts" / "f0e8bc06").exists()


def test_coordinator_root_uses_project_root_without_workflow(tmp_path):
    """无工作流时也不把任意任务 cwd 当作项目根。"""
    project = SimpleNamespace(path=tmp_path, workstep_dir=tmp_path / ".workstep")
    task = SimpleNamespace(workflow_id=None, cwd=str(tmp_path / "other"))
    root = coordinator_root(project, task)
    assert root == str(tmp_path)


def test_normalize_input_rounds_rejects_invalid_and_ignores_target():
    from agent_assistants.coordinator_actions import CoordinatorActionService

    assert CoordinatorActionService._normalize_input_rounds(
        {"req": "2", "ui": 1, "build": 3},
        "build",
    ) == {"req": 2, "ui": 1}
    with pytest.raises(ValueError, match="非法产物轮次"):
        CoordinatorActionService._normalize_input_rounds({"req": "bad"}, "build")
    with pytest.raises(ValueError, match="非法产物轮次"):
        CoordinatorActionService._normalize_input_rounds({"req": 0}, "build")


def test_artifact_index_marks_only_latest_eligible_round_selected(tmp_path):
    from models import Task, init_db
    from services.artifact_rounds import write_round_manifest

    db = init_db(str(tmp_path / "coordinator-artifact-rounds.db"))
    try:
        task = Task.create(
            id="artifact-round-task",
            title="Artifact rounds",
            cwd=str(tmp_path),
            workflow_id="dev",
            engine="claude",
            created_at=1,
            updated_at=1,
        )
        artifacts_root = tmp_path / ".workstep" / "artifacts"
        for round_number in (1, 2):
            write_round_manifest(
                artifacts_root=artifacts_root,
                workflow_id="dev",
                task_id=task.id,
                step_key="req",
                artifact_round=round_number,
                status="passed",
                eligible_for_downstream=True,
            )
            (artifacts_root / "dev" / task.id / "req" / str(round_number) / "prd.md").write_text(
                f"round {round_number}",
                encoding="utf-8",
            )

        project = SimpleNamespace(
            workstep_dir=str(tmp_path / ".workstep"),
            id="project-artifact-rounds",
        )
        index = artifact_index(project, task)
        selected = [
            metadata
            for metadata, _path in index.values()
            if metadata["is_selected"]
        ]

        assert [item["round"] for item in selected] == [2]
        assert all(
            metadata["eligible_for_downstream"]
            for metadata, _path in index.values()
        )
    finally:
        db.close()


def test_assemble_context_includes_coordinator_root_dir(tmp_path):
    """协调上下文必须带上根目录，让 agent 知道从哪读任务产物。"""
    from agent_assistants.coordinator import COORDINATOR_CONFIG
    from models import CoordinatorTurn, Message, Task, init_db

    db = init_db(str(tmp_path / "root-ctx.db"))
    task = Task.create(
        id="ctx-root-task",
        title="t",
        cwd=str(tmp_path),
        workflow_id="wf-1",
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    user_message = Message.create(
        id="root-user",
        task=task,
        channel="coordinator",
        step_key="req",
        role="user",
        content="看下产物",
        run_id="root-user",
        run_status="completed",
        position=0,
        created_at=1,
    )
    assistant_message = Message.create(
        id="root-assistant",
        task=task,
        channel="coordinator",
        step_key="req",
        role="assistant",
        content="",
        run_id="root-assistant",
        run_status="running",
        position=1,
        created_at=1,
    )
    turn = CoordinatorTurn.create(
        id="ctx-root-turn",
        task=task,
        user_message=user_message,
        assistant_message=assistant_message,
        idempotency_key="root-ik",
        status="running",
        created_at=1,
    )

    class StubProject:
        steps = {"steps": []}
        workstep_dir = tmp_path / ".workstep"
        path = tmp_path

        def workflow_by_id(self, workflow_id):
            return None

    prompt, _ = assemble_context(StubProject(), task, turn)
    try:
        context = json.loads(prompt.split("Context:\n", 1)[1])
        assert context["coordinator_root_dir"] == str(tmp_path)
        assert "workstep-cli" in COORDINATOR_CONFIG.system_prompt
        assert "inspect the workstep-cli skill" in COORDINATOR_CONFIG.system_prompt
        assert "operate on WorkStep workflows" in COORDINATOR_CONFIG.system_prompt
        assert "# WorkStep CLI" not in prompt
        assert "WORKSTEP_CLI_PYTHON" not in prompt
    finally:
        db.close()


def test_assemble_context_history_handling_depends_on_engine_resume(tmp_path, monkeypatch):
    """resume 引擎不再拼接历史（只带当前用户消息），无状态引擎保留。"""
    from models import (
        CoordinatorSession,
        CoordinatorTurn,
        Message,
        Task,
        init_db,
    )
    from agent_assistants.coordinator import CoordinatorModule
    import agent_assistants.coordinator_context as coordinator_service
    from streaming.bus import EventBus

    class StubProject:
        steps = {}
        workstep_dir = tmp_path
        path = tmp_path

        def workflow_by_id(self, workflow_id):
            return None

    class ResumeEngine:
        capabilities = SimpleNamespace(supports_workstep_tools=False)
        supports_resume = True

    class StatelessEngine:
        capabilities = SimpleNamespace(supports_workstep_tools=False)
        supports_resume = False

    db = init_db(str(tmp_path / "workstep.db"))
    try:
        task = Task.create(
            id="ctx-hist-task",
            title="t",
            description="D" * 10000,
            cwd=str(tmp_path),
            engine="claude",
            created_at=1,
            updated_at=1,
        )
        for index, (mid, role, content, status) in enumerate([
            ("ctx-old-user", "user", "第一问", "completed"),
            ("ctx-old-assist", "assistant", "第一答", "succeeded"),
            ("ctx-curr-user", "user", "现在呢", "completed"),
        ]):
            Message.create(
                id=mid,
                task=task,
                channel="coordinator",
                step_key="build",
                role=role,
                content=content,
                run_id=mid,
                run_status=status,
                position=index + 1,
                sequence=index + 1,
                created_at=1,
            )
        Message.create(
            id="ctx-curr-assist",
            task=task,
            channel="coordinator",
            step_key="build",
            role="assistant",
            content="",
            run_id="ctx-curr-assist",
            run_status="running",
            position=4,
            sequence=4,
            created_at=1,
        )
        turn = CoordinatorTurn.create(
            id="ctx-hist-turn",
            task=task,
            user_message_id="ctx-curr-user",
            assistant_message_id="ctx-curr-assist",
            idempotency_key="ctx-hist-ik",
            engine="claude",
            status="running",
            created_at=1,
        )
        CoordinatorSession.create(
            task=task,
            engine="claude",
            summary="旧摘要",
            created_at=1,
            updated_at=1,
        )

        monkeypatch.setattr(
            coordinator_service,
            "create_engine",
            lambda engine_id: ResumeEngine(),
        )
        prompt, _ = assemble_context(StubProject(), task, turn)
        context = json.loads(prompt.split("Context:\n", 1)[1])
        assert [
            m["content"] for m in context["recent_coordinator_messages"]
        ] == ["现在呢"]
        assert context["coordinator_summary"] is None
        assert "workflow" not in context
        assert "reviews" not in context
        assert "artifacts" not in context
        assert "workstep-cli" in prompt
        assert len(context["task"]["description"]) == 4000

        Message.create(
            id="ctx-next-user", task=task, channel="coordinator",
            step_key="build", role="user", content="排队中的下一问",
            run_id="ctx-next-user", run_status="completed", position=5,
            sequence=5, created_at=1,
        )
        queued_prompt, _ = assemble_context(StubProject(), task, turn)
        queued_context = json.loads(queued_prompt.split("Context:\n", 1)[1])
        assert queued_context["recent_coordinator_messages"] == [
            {"role": "user", "content": "现在呢"}
        ]
        Message.delete_by_id("ctx-next-user")

        monkeypatch.setattr(
            coordinator_service,
            "create_engine",
            lambda engine_id: StatelessEngine(),
        )
        prompt, _ = assemble_context(StubProject(), task, turn)
        context = json.loads(prompt.split("Context:\n", 1)[1])
        assert [
            m["content"] for m in context["recent_coordinator_messages"]
        ] == ["第一问", "第一答", "现在呢"]
        assert context["coordinator_summary"] == "旧摘要"
        assert "workflow" in context
        assert "reviews" in context
        assert "artifacts" in context
        assert len(context["task"]["description"]) == 10000
    finally:
        db.close()


@pytest.mark.anyio
async def test_slow_coordinator_artifact_discovery_keeps_health_responsive(
    api_context, monkeypatch,
):
    import threading
    from agent_assistants import coordinator_context
    from engines.core.registry import ENGINE_REGISTRY

    client, tmp_path = api_context
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", CoordinatorFakeEngine)
    project_id, task_id = await _create_task(client, tmp_path)
    entered = threading.Event()
    release = threading.Event()
    original = coordinator_context.artifact_index

    def slow_artifact_index(project, task):
        entered.set()
        release.wait(timeout=2)
        return original(project, task)

    monkeypatch.setattr(coordinator_context, "artifact_index", slow_artifact_index)
    request = asyncio.create_task(client.post(
        f"/api/task/{task_id}/chat?project_id={project_id}",
        headers={"Idempotency-Key": "slow-artifact-context"},
        json={"content": "查看任务产物"},
    ))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
        assert health.status_code == 200
    finally:
        release.set()
    accepted = await request
    assert accepted.status_code == 200
    await _wait_for_reply(client, project_id, task_id)


@pytest.mark.anyio
async def test_coordinator_resume_engine_keeps_history_engine_side(
    api_context,
    monkeypatch,
):
    """任务协调走 resume 引擎：prompt 不带历史，引擎状态跨轮传递并持久化。"""
    from engines.core.registry import ENGINE_REGISTRY

    client, tmp_path = api_context
    ResumeCoordinatorFakeEngine.calls.clear()
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", ResumeCoordinatorFakeEngine)
    project_id, task_id = await _create_task(client, tmp_path)

    sent = await client.post(
        f"/api/task/{task_id}/chat?project_id={project_id}",
        headers={"Idempotency-Key": "chat-r1"},
        json={"content": "第一问"},
    )
    assert sent.status_code == 200
    await _wait_for_reply(
        client,
        project_id,
        task_id,
        assistant_message_id=sent.json()["assistant_message_id"],
    )

    assert ResumeCoordinatorFakeEngine.calls[0]["message_history"] is None
    first_context = json.loads(
        ResumeCoordinatorFakeEngine.calls[0]["prompt"].split("Context:\n", 1)[1]
    )
    assert [
        m["content"] for m in first_context["recent_coordinator_messages"]
    ] == ["第一问"]
    assert first_context["project_id"] == project_id
    assert first_context["task"]["id"] == task_id
    assert "steps" in first_context
    assert "workstep-cli" in ResumeCoordinatorFakeEngine.calls[0]["prompt"]
    assert first_context["coordinator_summary"] is None

    second = await client.post(
        f"/api/task/{task_id}/chat?project_id={project_id}",
        headers={"Idempotency-Key": "chat-r2"},
        json={"content": "第二问"},
    )
    assert second.status_code == 200
    await _wait_for_reply(
        client,
        project_id,
        task_id,
        assistant_message_id=second.json()["assistant_message_id"],
    )

    # 第二轮：引擎状态被传回，会话 id 保持稳定，prompt 依旧只带当前用户消息。
    assert ResumeCoordinatorFakeEngine.calls[1]["message_history"] == {
        "round": 1
    }
    # 第二轮复用第一轮建立的引擎会话 id。
    assert ResumeCoordinatorFakeEngine.calls[1]["session_id"] == "engine-session-1"
    assert ResumeCoordinatorFakeEngine.calls[1]["prompt"] == "第二问"

    third = await client.post(
        f"/api/task/{task_id}/chat?project_id={project_id}",
        headers={"Idempotency-Key": "chat-r3"},
        json={"content": "重新开始", "reset_session": True},
    )
    assert third.status_code == 200
    await _wait_for_reply(
        client,
        project_id,
        task_id,
        assistant_message_id=third.json()["assistant_message_id"],
    )
    assert ResumeCoordinatorFakeEngine.calls[2]["session_id"] is None
    assert ResumeCoordinatorFakeEngine.calls[2]["message_history"] is None
    reset_prompt = ResumeCoordinatorFakeEngine.calls[2]["prompt"]
    reset_context = json.loads(reset_prompt.split("Context:\n", 1)[1])
    assert reset_context["task"]["id"] == task_id
    assert reset_context["project_id"] == project_id
    assert "steps" in reset_context
    assert "workstep-cli" in reset_prompt
    assert [
        message["content"] for message in reset_context["recent_coordinator_messages"]
    ] == ["重新开始"]


@pytest.mark.anyio
async def test_chat_calls_selected_engine_without_starting_workflow(
    api_context,
    monkeypatch,
):
    from engines.core.registry import ENGINE_REGISTRY
    from models import CoordinatorTurn, WorkflowRun
    import main

    client, tmp_path = api_context
    CoordinatorFakeEngine.calls.clear()
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", CoordinatorFakeEngine)
    project_id, task_id = await _create_task(client, tmp_path)
    event_queue = main.coordinator_module._event_bus.subscribe()

    try:
        accepted = await client.post(
            f"/api/task/{task_id}/chat?project_id={project_id}",
            headers={"Idempotency-Key": "chat-1"},
            json={"content": "现在进展如何？"},
        )

        assert accepted.status_code == 200
        assistant = await _wait_for_reply(client, project_id, task_id)
        assert assistant["content"] == "协调回复"
        assert assistant["prompt"]
        assert "Context:" in assistant["prompt"]
        assert assistant["usage"] == {
            "input_tokens": 120,
            "output_tokens": 30,
            "total_tokens": 150,
        }
        published = []
        while not event_queue.empty():
            published.append(event_queue.get_nowait())
        assistant_events = [
            event for event in published
            if event.get("messageId") == accepted.json()["assistant_message_id"]
        ]
        assert [
            event.get("delta")
            for event in assistant_events
            if event["type"] == "TEXT_MESSAGE_CHUNK"
        ] == ["协调回复"]
        assert next(
            event for event in assistant_events
            if event["type"] == "TEXT_MESSAGE_CONTENT"
        )["content"] == "协调回复"
        assert CoordinatorFakeEngine.calls
        with main.project_manager.activate_project_by_id(project_id):
            assert WorkflowRun.select().count() == 0
            assert CoordinatorTurn.select().count() == 1

        duplicate = await client.post(
            f"/api/task/{task_id}/chat?project_id={project_id}",
            headers={"Idempotency-Key": "chat-1"},
            json={"content": "不会重复"},
        )
        assert duplicate.json()["turn_id"] == accepted.json()["turn_id"]
        assert len(CoordinatorFakeEngine.calls) == 1
    finally:
        main.coordinator_module._event_bus.unsubscribe(event_queue)


@pytest.mark.anyio
async def test_coordinator_engine_runtime_data_stays_at_project_root(api_context, monkeypatch):
    from engines.core.registry import ENGINE_REGISTRY

    class RuntimeWritingEngine(CoordinatorFakeEngine):
        calls: list[dict] = []

        async def spawn(self, prompt, cwd, model=None, session_id=None, **kwargs):
            def write_marker():
                marker = Path(cwd) / ".workstep" / "runtime" / "coordinator-marker"
                marker.parent.mkdir(parents=True, exist_ok=True)
                marker.write_text("runtime", encoding="utf-8")

            await asyncio.to_thread(write_marker)
            async for event in super().spawn(prompt, cwd, model=model, session_id=session_id, **kwargs):
                yield event

    client, tmp_path = api_context
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", RuntimeWritingEngine)
    project_id, task_id = await _create_task(client, tmp_path)
    project_dir = tmp_path / "coordinator-project"
    response = await client.post(
        f"/api/task/{task_id}/chat?project_id={project_id}",
        headers={"Idempotency-Key": "runtime-root"},
        json={"content": "检查运行目录"},
    )
    assert response.status_code == 200
    await _wait_for_reply(client, project_id, task_id)
    assert RuntimeWritingEngine.calls[0]["cwd"] == str(project_dir)
    assert (project_dir / ".workstep" / "runtime" / "coordinator-marker").is_file()
    assert not list((project_dir / ".workstep" / "artifacts").rglob("coordinator-marker"))


@pytest.mark.anyio
async def test_coordinator_pushes_reply_before_engine_turn_finishes(
    api_context,
    monkeypatch,
):
    from engines.core.registry import ENGINE_REGISTRY
    import main

    client, tmp_path = api_context
    StreamingCoordinatorFakeEngine.release = asyncio.Event()
    monkeypatch.setitem(
        ENGINE_REGISTRY,
        "claude",
        StreamingCoordinatorFakeEngine,
    )
    project_id, task_id = await _create_task(client, tmp_path)
    event_queue = main.coordinator_module._event_bus.subscribe()
    try:
        accepted = await client.post(
            f"/api/task/{task_id}/chat?project_id={project_id}",
            headers={"Idempotency-Key": "chat-streaming"},
            json={"content": "实时告诉我进展"},
        )
        assistant_id = accepted.json()["assistant_message_id"]

        while True:
            event = await asyncio.wait_for(event_queue.get(), timeout=1)
            if (
                event.get("messageId") == assistant_id
                and event.get("type") == "TEXT_MESSAGE_CHUNK"
            ):
                break

        assert event["delta"] == "实时"
        history = await client.get(
            f"/api/task/{task_id}/history?project_id={project_id}"
        )
        running_message = next(
            message for message in history.json()["messages"]
            if message["id"] == assistant_id
        )
        assert running_message["run_status"] == "running"

        StreamingCoordinatorFakeEngine.release.set()
        assistant = await _wait_for_reply(
            client,
            project_id,
            task_id,
            assistant_id,
        )
        assert assistant["content"] == "实时回复"
    finally:
        StreamingCoordinatorFakeEngine.release.set()
        main.coordinator_module._event_bus.unsubscribe(event_queue)


@pytest.mark.anyio
async def test_coordinator_can_send_pending_inserts_immediately(
    api_context,
    monkeypatch,
):
    from engines.core.registry import ENGINE_REGISTRY

    client, tmp_path = api_context
    StreamingCoordinatorFakeEngine.release = asyncio.Event()
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", StreamingCoordinatorFakeEngine)
    project_id, task_id = await _create_task(client, tmp_path)
    current = await client.post(
        f"/api/task/{task_id}/chat?project_id={project_id}",
        headers={"Idempotency-Key": "chat-before-manual-pending"},
        json={"content": "先执行当前消息"},
    )
    target_message_id = current.json()["assistant_message_id"]
    queued_ids = []
    for content in ("补充第一条", "补充第二条"):
        queued = await client.post(
            "/api/pending-message-inserts",
            json={
                "project_id": project_id,
                "target_message_id": target_message_id,
                "content": content,
            },
        )
        queued_ids.append(queued.json()["id"])

    sent = await client.post(
        f"/api/task/{task_id}/chat?project_id={project_id}",
        headers={"Idempotency-Key": "manual-send-pending"},
        json={
            "content": "补充第一条\n\n补充第二条",
            "pending_insert_ids": queued_ids,
        },
    )
    assert sent.status_code == 200
    pending = await client.get(
        "/api/pending-message-inserts",
        params={"project_id": project_id, "target_message_id": target_message_id},
    )
    assert pending.json()["items"] == []
    StreamingCoordinatorFakeEngine.release.set()


@pytest.mark.anyio
async def test_coordinator_keeps_unsent_pending_inserts_after_sending_one(
    api_context,
    monkeypatch,
):
    import threading

    from engines.core.registry import ENGINE_REGISTRY
    import main

    client, tmp_path = api_context
    StreamingCoordinatorFakeEngine.release = asyncio.Event()
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", StreamingCoordinatorFakeEngine)
    project_id, task_id = await _create_task(client, tmp_path)
    current = await client.post(
        f"/api/task/{task_id}/chat?project_id={project_id}",
        headers={"Idempotency-Key": "chat-before-partial-pending"},
        json={"content": "先执行当前消息"},
    )
    target_message_id = current.json()["assistant_message_id"]
    queued_ids = []
    for content in ("消息 A", "消息 B"):
        queued = await client.post(
            "/api/pending-message-inserts",
            json={
                "project_id": project_id,
                "target_message_id": target_message_id,
                "content": content,
            },
        )
        queued_ids.append(queued.json()["id"])

    entered_db = threading.Event()
    release_db = threading.Event()
    persist_submission = main.coordinator_module._persist_submission

    def slow_persist_submission(*args, **kwargs):
        entered_db.set()
        release_db.wait(timeout=2)
        return persist_submission(*args, **kwargs)

    monkeypatch.setattr(main.coordinator_module, "_persist_submission", slow_persist_submission)
    sending = asyncio.create_task(client.post(
        f"/api/task/{task_id}/chat?project_id={project_id}",
        headers={"Idempotency-Key": "manual-send-second-pending"},
        json={"content": "消息 B", "pending_insert_ids": [queued_ids[1]]},
    ))
    try:
        assert await asyncio.to_thread(entered_db.wait, 1)
        health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
        assert health.status_code == 200
    finally:
        release_db.set()
    sent = await sending
    assert sent.status_code == 200
    next_target = sent.json()["assistant_message_id"]
    old_pending = await client.get(
        "/api/pending-message-inserts",
        params={"project_id": project_id, "target_message_id": target_message_id},
    )
    new_pending = await client.get(
        "/api/pending-message-inserts",
        params={"project_id": project_id, "target_message_id": next_target},
    )
    assert old_pending.json()["items"] == []
    assert [(item["id"], item["content"]) for item in new_pending.json()["items"]] == [
        (queued_ids[0], "消息 A"),
    ]
    StreamingCoordinatorFakeEngine.release.set()


@pytest.mark.anyio
async def test_coordinator_merges_pending_inserts_after_running_turn(
    api_context,
    monkeypatch,
):
    from engines.core.registry import ENGINE_REGISTRY

    client, tmp_path = api_context
    StreamingCoordinatorFakeEngine.release = asyncio.Event()
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", StreamingCoordinatorFakeEngine)
    project_id, task_id = await _create_task(client, tmp_path)
    accepted = await client.post(
        f"/api/task/{task_id}/chat?project_id={project_id}",
        headers={"Idempotency-Key": "chat-with-pending"},
        json={"content": "先执行当前消息"},
    )
    target_message_id = accepted.json()["assistant_message_id"]
    actor_headers = {
        "X-WorkStep-Actor-Id": "browser-pending",
        "X-WorkStep-Actor-Name": "%E5%BE%85%E6%8F%92%E5%85%A5%E7%94%A8%E6%88%B7",
        "X-WorkStep-Actor-Device-Id": "browser-device-pending",
        "X-WorkStep-Actor-Device-Name": "Chrome",
    }

    for content in ("补充第一条", "补充第二条"):
        queued = await client.post(
            "/api/pending-message-inserts",
            json={
                "project_id": project_id,
                "target_message_id": target_message_id,
                "content": content,
            },
            headers=actor_headers,
        )
        assert queued.status_code == 200
        assert queued.json()["username"] == "待插入用户"

    StreamingCoordinatorFakeEngine.release.set()
    for _ in range(100):
        history = await client.get(
            f"/api/task/{task_id}/history?project_id={project_id}"
        )
        messages = history.json()["messages"]
        merged = [
            message for message in messages
            if message["role"] == "user"
            and message["content"] == "补充第一条\n\n补充第二条"
        ]
        completed = [
            message for message in messages
            if message["channel"] == "coordinator"
            and message["role"] == "assistant"
            and message["run_status"] == "succeeded"
        ]
        if merged and len(completed) == 2:
            break
        await asyncio.sleep(0.01)
    else:
        raise AssertionError("pending coordinator inserts were not consumed")
    assert merged[0]["author_name"] == "待插入用户"

    pending = await client.get(
        "/api/pending-message-inserts",
        params={"project_id": project_id, "target_message_id": target_message_id},
    )
    assert pending.json()["items"] == []


@pytest.mark.anyio
async def test_coordinator_engine_switch_only_affects_new_turns(
    api_context,
    monkeypatch,
):
    from engines.core.registry import ENGINE_REGISTRY

    client, tmp_path = api_context
    CoordinatorFakeEngine.calls.clear()
    SecondCoordinatorFakeEngine.calls.clear()
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", CoordinatorFakeEngine)
    monkeypatch.setitem(ENGINE_REGISTRY, "codex", SecondCoordinatorFakeEngine)

    async def fail_if_called(*args, **kwargs):
        raise AssertionError("engine switching must not validate model lists")

    monkeypatch.setattr(SecondCoordinatorFakeEngine, "list_models", fail_if_called)
    project_id, task_id = await _create_task(client, tmp_path)

    updated = await client.patch(
        f"/api/task/{task_id}/coordinator-config?project_id={project_id}",
        json={"engine": "codex", "model": None},
    )
    assert updated.status_code == 200
    assert updated.json()["resolved"]["engine"] == "codex"

    sent = await client.post(
        f"/api/task/{task_id}/chat?project_id={project_id}",
        headers={"Idempotency-Key": "chat-codex"},
        json={"content": "使用 Codex 协调"},
    )
    assert sent.status_code == 200
    await _wait_for_reply(client, project_id, task_id)
    assert SecondCoordinatorFakeEngine.calls
    assert not CoordinatorFakeEngine.calls


@pytest.mark.anyio
async def test_coordinator_model_switch_preserves_engine_session_id(
    api_context,
    monkeypatch,
):
    import main
    from engines.core.registry import ENGINE_REGISTRY
    from models import CoordinatorSession, Task
    from models.fields import utc_now

    client, tmp_path = api_context
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", CoordinatorFakeEngine)
    project_id, task_id = await _create_task(client, tmp_path)

    configured = await client.patch(
        f"/api/task/{task_id}/coordinator-config?project_id={project_id}",
        json={"engine": "claude", "model": "sonnet"},
    )
    assert configured.status_code == 200
    with main.project_manager.activate_project_by_id(project_id):
        task = Task.get_by_id(task_id)
        session = CoordinatorSession.create(
            task=task,
            engine="claude",
            model="sonnet",
            session_id="engine-session-1",
            created_at=utc_now(),
            updated_at=utc_now(),
        )

    updated = await client.patch(
        f"/api/task/{task_id}/coordinator-config?project_id={project_id}",
        json={"engine": "claude", "model": "opus"},
    )

    assert updated.status_code == 200
    with main.project_manager.activate_project_by_id(project_id):
        session = CoordinatorSession.get_by_id(task_id)
        assert session.model == "opus"
        assert session.session_id == "engine-session-1"


@pytest.mark.anyio
async def test_coordinator_routes_reasoning_and_repair_to_separate_models(
    api_context,
    monkeypatch,
):
    from engines.core.registry import ENGINE_REGISTRY

    client, tmp_path = api_context
    RoutedCoordinatorFakeEngine.calls.clear()
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", RoutedCoordinatorFakeEngine)
    project_id, task_id = await _create_task(client, tmp_path)

    updated = await client.patch(
        f"/api/task/{task_id}/coordinator-config?project_id={project_id}",
        json={
            "engine": "claude",
            "model": "reasoning-model",
            "fast_model": "fast-model",
            "vision_model": "vision-model",
        },
    )
    assert updated.status_code == 200
    assert updated.json()["configured"] == {
        "engine": "claude",
        "model": "reasoning-model",
        "fast_model": "fast-model",
        "vision_model": "vision-model",
        "thinking_effort": "",
        "provider_id": "",
    }
    assert updated.json()["resolved"]["vision_model"] == "vision-model"

    accepted = await client.post(
        f"/api/task/{task_id}/chat?project_id={project_id}",
        headers={"Idempotency-Key": "dual-model-routing"},
        json={"content": "分析后回复"},
    )
    assistant = await _wait_for_reply(
        client,
        project_id,
        task_id,
        accepted.json()["assistant_message_id"],
    )

    assert assistant["content"] == "协调回复"
    assert [call["model"] for call in RoutedCoordinatorFakeEngine.calls] == [
        "reasoning-model",
        "fast-model",
    ]


@pytest.mark.anyio
async def test_coordinator_vision_model_global_default_and_task_override(
    api_context,
    monkeypatch,
):
    from engines.core.registry import ENGINE_REGISTRY
    import agent_assistants.coordinator as coordinator_service

    client, tmp_path = api_context
    RoutedCoordinatorFakeEngine.calls.clear()
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", RoutedCoordinatorFakeEngine)
    project_id, task_id = await _create_task(client, tmp_path)

    coordinator_service.config_store.set(
        "coordinator_default_vision_model", "global-vision-model"
    )
    loaded = await client.get(
        f"/api/task/{task_id}/coordinator-config?project_id={project_id}"
    )
    assert loaded.status_code == 200
    assert loaded.json()["resolved"]["vision_model"] == "global-vision-model"
    assert loaded.json()["configured"]["vision_model"] is None

    updated = await client.patch(
        f"/api/task/{task_id}/coordinator-config?project_id={project_id}",
        json={"engine": "claude", "vision_model": "task-vision-model"},
    )
    assert updated.status_code == 200
    assert updated.json()["configured"]["vision_model"] == "task-vision-model"
    assert updated.json()["resolved"]["vision_model"] == "task-vision-model"


@pytest.mark.anyio
async def test_coordinator_thinking_effort_persists_and_reaches_engine(
    api_context,
    monkeypatch,
):
    from engines.core.registry import ENGINE_REGISTRY

    client, tmp_path = api_context
    ThinkingEffortCoordinatorFakeEngine.calls.clear()
    monkeypatch.setitem(
        ENGINE_REGISTRY,
        "claude",
        ThinkingEffortCoordinatorFakeEngine,
    )
    project_id, task_id = await _create_task(client, tmp_path)

    updated = await client.patch(
        f"/api/task/{task_id}/coordinator-config?project_id={project_id}",
        json={"engine": "claude", "thinking_effort": "high"},
    )
    assert updated.status_code == 200
    assert updated.json()["configured"]["thinking_effort"] == "high"
    assert updated.json()["resolved"]["thinking_effort"] == "high"

    rejected = await client.patch(
        f"/api/task/{task_id}/coordinator-config?project_id={project_id}",
        json={"thinking_effort": "insane"},
    )
    assert rejected.status_code == 400

    sent = await client.post(
        f"/api/task/{task_id}/chat?project_id={project_id}",
        headers={"Idempotency-Key": "effort-chat"},
        json={"content": "深度思考后回复"},
    )
    assert sent.status_code == 200
    assistant = await _wait_for_reply(
        client,
        project_id,
        task_id,
        sent.json()["assistant_message_id"],
    )
    assert assistant["content"] == "协调回复"
    assert ThinkingEffortCoordinatorFakeEngine.calls
    assert (
        ThinkingEffortCoordinatorFakeEngine.calls[0]["thinking_effort"] == "high"
    )


@pytest.mark.anyio
async def test_coordinator_inherits_global_thinking_effort(
    api_context,
    monkeypatch,
):
    from engines.core.registry import ENGINE_REGISTRY
    import agent_assistants.coordinator as coordinator_service

    client, tmp_path = api_context
    ThinkingEffortCoordinatorFakeEngine.calls.clear()
    monkeypatch.setitem(
        ENGINE_REGISTRY,
        "claude",
        ThinkingEffortCoordinatorFakeEngine,
    )
    coordinator_service.config_store.set(
        "coordinator_default_thinking_effort", "medium"
    )
    project_id, task_id = await _create_task(client, tmp_path)

    loaded = await client.get(
        f"/api/task/{task_id}/coordinator-config?project_id={project_id}"
    )
    assert loaded.json()["configured"]["thinking_effort"] == ""
    assert loaded.json()["resolved"]["thinking_effort"] == "medium"

    sent = await client.post(
        f"/api/task/{task_id}/chat?project_id={project_id}",
        headers={"Idempotency-Key": "global-effort-chat"},
        json={"content": "按全局思考强度回复"},
    )
    await _wait_for_reply(
        client,
        project_id,
        task_id,
        sent.json()["assistant_message_id"],
    )
    assert ThinkingEffortCoordinatorFakeEngine.calls[0]["thinking_effort"] == "medium"


@pytest.mark.anyio
async def test_coordinator_routes_message_images_to_engine(api_context, monkeypatch):
    from engines.core.registry import ENGINE_REGISTRY
    import agent_assistants.coordinator as coordinator_service

    client, tmp_path = api_context
    ImageRoutingCoordinatorFakeEngine.calls.clear()
    monkeypatch.setitem(
        ENGINE_REGISTRY, "claude", ImageRoutingCoordinatorFakeEngine
    )
    coordinator_service.config_store.set(
        "coordinator_default_model", "reasoning-model"
    )
    coordinator_service.config_store.set(
        "coordinator_default_vision_model", "vision-model"
    )
    coordinator_service.config_store.set("model_pricing", {
        "prices": [{
            "provider_id": None,
            "engine_id": "claude",
            "model": "vision-model",
            "supports_multimodal": True,
        }],
    })
    project_id, task_id = await _create_task(client, tmp_path)

    project_dir = tmp_path / "coordinator-project"
    upload_dir = project_dir / ".workstep" / "uploads"
    upload_dir.mkdir(parents=True)
    shot = upload_dir / "shot.png"
    shot.write_bytes(b"\x89PNG\r\n\x1a\nfakepngbytes")

    accepted = await client.post(
        f"/api/task/{task_id}/chat?project_id={project_id}",
        headers={"Idempotency-Key": "with-image"},
        json={
            "content": (
                "请看截图 ![运行截图](coordinator-project/.workstep/uploads/shot.png)"
            )
        },
    )
    assistant = await _wait_for_reply(
        client,
        project_id,
        task_id,
        accepted.json()["assistant_message_id"],
    )

    assert assistant["content"] == "协调回复"
    call = ImageRoutingCoordinatorFakeEngine.calls[-1]
    assert call["model"] == "vision-model"
    images = call["images"]
    assert images is not None
    assert len(images) == 1
    assert images[0].path == str(shot.resolve())
    assert images[0].description == "运行截图"
    assert "coordinator-project/.workstep/uploads/shot.png" in call["prompt"]


@pytest.mark.anyio
async def test_coordinator_ignores_images_outside_uploads(api_context, monkeypatch):
    from engines.core.registry import ENGINE_REGISTRY

    client, tmp_path = api_context
    ImageRoutingCoordinatorFakeEngine.calls.clear()
    monkeypatch.setitem(
        ENGINE_REGISTRY, "claude", ImageRoutingCoordinatorFakeEngine
    )
    project_id, task_id = await _create_task(client, tmp_path)

    outside = tmp_path / "secret.png"
    outside.write_bytes(b"\x89PNG\r\n\x1a\nfakepngbytes")
    accepted = await client.post(
        f"/api/task/{task_id}/chat?project_id={project_id}",
        headers={"Idempotency-Key": "outside-image"},
        json={"content": f"看图 ![x]({outside})"},
    )
    await _wait_for_reply(
        client,
        project_id,
        task_id,
        accepted.json()["assistant_message_id"],
    )

    call = ImageRoutingCoordinatorFakeEngine.calls[-1]
    assert call["images"] in (None, [])


@pytest.mark.anyio
async def test_global_defaults_apply_without_overriding_task_selection(
    api_context,
    monkeypatch,
):
    from engines.core.registry import ENGINE_REGISTRY
    import agent_assistants.coordinator as coordinator_service

    client, tmp_path = api_context
    CoordinatorFakeEngine.calls.clear()
    SecondCoordinatorFakeEngine.calls.clear()
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", CoordinatorFakeEngine)
    monkeypatch.setitem(ENGINE_REGISTRY, "codex", SecondCoordinatorFakeEngine)
    coordinator_service.config_store.set("coordinator_default_engine", "codex")
    project_id, task_id = await _create_task(client, tmp_path)

    accepted = await client.post(
        f"/api/task/{task_id}/chat?project_id={project_id}",
        headers={"Idempotency-Key": "global-codex"},
        json={"content": "使用全局协调默认引擎"},
    )
    await _wait_for_reply(
        client,
        project_id,
        task_id,
        accepted.json()["assistant_message_id"],
    )
    assert SecondCoordinatorFakeEngine.calls
    assert not CoordinatorFakeEngine.calls

    updated = await client.patch(
        f"/api/task/{task_id}/coordinator-config?project_id={project_id}",
        json={"engine": "claude", "model": None},
    )
    assert "available_engines" not in updated.json()
    CoordinatorFakeEngine.calls.clear()
    SecondCoordinatorFakeEngine.calls.clear()
    accepted = await client.post(
        f"/api/task/{task_id}/chat?project_id={project_id}",
        headers={"Idempotency-Key": "task-claude"},
        json={"content": "使用任务级协调引擎"},
    )
    await _wait_for_reply(
        client,
        project_id,
        task_id,
        accepted.json()["assistant_message_id"],
    )
    assert CoordinatorFakeEngine.calls
    assert not SecondCoordinatorFakeEngine.calls


@pytest.mark.anyio
async def test_new_task_uses_global_execution_default(api_context):
    import agent_assistants.coordinator as coordinator_service

    client, tmp_path = api_context
    coordinator_service.config_store.set("execution_default_engine", "codex")
    project_id, task_id = await _create_task(client, tmp_path)

    task = await client.get(
        f"/api/task/{task_id}?project_id={project_id}"
    )
    assert task.json()["engine"] == "codex"


@pytest.mark.anyio
async def test_coordinator_config_lists_unconfigured_builtin_and_api_engines(
    api_context,
    monkeypatch,
):
    from engines.core.registry import ENGINE_REGISTRY
    import agent_assistants.coordinator as coordinator_service

    client, tmp_path = api_context
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", CoordinatorFakeEngine)
    monkeypatch.setattr(
        coordinator_service,
        "get_available_engines",
        lambda: [
            {
                "id": "claude",
                "installed": True,
                "configured": True,
                "built_in": False,
                "mode": "cli",
                "supports_coordinator": True,
            },
            {
                "id": "pydantic_ai",
                "installed": True,
                "configured": False,
                "built_in": True,
                "mode": "agent",
                "supports_coordinator": False,
            },
        ],
    )
    project_id, task_id = await _create_task(client, tmp_path)

    response = await client.get(
        f"/api/task/{task_id}/coordinator-config?project_id={project_id}"
    )

    assert response.status_code == 200
    engines = {item["id"]: item for item in response.json()["available_engines"]}
    assert engines["pydantic_ai"]["built_in"] is True
    assert engines["pydantic_ai"]["configured"] is False
    assert "api" not in engines


@pytest.mark.anyio
async def test_confirmed_step_supplement_is_persisted(
    api_context,
    monkeypatch,
):
    from engines.core.registry import ENGINE_REGISTRY
    from models import StepSupplement
    import main

    client, tmp_path = api_context
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", CoordinatorFakeEngine)
    project_id, task_id = await _create_task(client, tmp_path)
    CoordinatorFakeEngine.reply = {
        "version": 1,
        "reply": "可以补充到执行阶段。",
        "intent": "propose_action",
        "target_step_key": "req",
        "artifact_requests": [],
        "proposal": {
            "type": "supplement_step",
            "target_step_key": "req",
            "payload": {"content": "必须覆盖异常路径"},
        },
    }
    try:
        await client.post(
            f"/api/task/{task_id}/chat?project_id={project_id}",
            headers={"Idempotency-Key": "chat-supplement"},
            json={"content": "补充异常路径"},
        )
        assistant = await _wait_for_reply(client, project_id, task_id)
        proposal = assistant["proposals"][0]
        assert proposal["type"] == "supplement_step"
        confirmed = await client.post(
            f"/api/task/{task_id}/actions/{proposal['id']}/confirm"
            f"?project_id={project_id}",
            headers={"Idempotency-Key": "confirm-supplement"},
        )
        assert confirmed.status_code == 200
        assert confirmed.json()["status"] == "succeeded"
        with main.project_manager.activate_project_by_id(project_id):
            supplement = StepSupplement.get()
            assert supplement.step_key == "req"
            assert supplement.content == "必须覆盖异常路径"
    finally:
        CoordinatorFakeEngine.reply = {
            "version": 1,
            "reply": "协调回复",
            "intent": "answer",
            "target_step_key": None,
            "artifact_requests": [],
            "proposal": None,
        }


@pytest.mark.anyio
async def test_slow_action_confirmation_keeps_health_responsive(api_context, monkeypatch):
    import threading
    from engines.core.registry import ENGINE_REGISTRY
    import main

    client, tmp_path = api_context
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", CoordinatorFakeEngine)
    project_id, task_id = await _create_task(client, tmp_path)
    CoordinatorFakeEngine.reply = {
        "version": 1,
        "reply": "可以补充执行说明。",
        "intent": "propose_action",
        "target_step_key": "req",
        "artifact_requests": [],
        "proposal": {
            "type": "supplement_step",
            "target_step_key": "req",
            "payload": {"content": "慢数据库确认"},
        },
    }
    try:
        await client.post(
            f"/api/task/{task_id}/chat?project_id={project_id}",
            headers={"Idempotency-Key": "slow-action-proposal"},
            json={"content": "补充执行说明"},
        )
        assistant = await _wait_for_reply(client, project_id, task_id)
        proposal_id = assistant["proposals"][0]["id"]
        actions = main.coordinator_module._actions
        original = actions._begin_action_sync
        entered = threading.Event()
        release = threading.Event()

        def slow_begin(*args, **kwargs):
            entered.set()
            release.wait(timeout=2)
            return original(*args, **kwargs)

        monkeypatch.setattr(actions, "_begin_action_sync", slow_begin)
        confirming = asyncio.create_task(client.post(
            f"/api/task/{task_id}/actions/{proposal_id}/confirm?project_id={project_id}",
            headers={"Idempotency-Key": "slow-action-confirm"},
        ))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
            assert health.status_code == 200
        finally:
            release.set()
        confirmed = await confirming
        assert confirmed.status_code == 200
        assert confirmed.json()["status"] == "succeeded"
    finally:
        CoordinatorFakeEngine.reply = {
            "version": 1,
            "reply": "协调回复",
            "intent": "answer",
            "target_step_key": None,
            "artifact_requests": [],
            "proposal": None,
        }


@pytest.mark.anyio
async def test_confirmed_rerun_can_inject_optional_step_prompt(
    api_context,
    monkeypatch,
):
    from engines.core.registry import ENGINE_REGISTRY
    from models import StepSupplement
    import main

    client, tmp_path = api_context
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", CoordinatorFakeEngine)
    project_id, task_id = await _create_task(client, tmp_path)
    injected_prompt = "先复现登录超时，再修复刷新令牌竞争条件并补充回归测试"
    CoordinatorFakeEngine.calls = []
    CoordinatorFakeEngine.reply = {
        "version": 1,
        "reply": "建议从需求阶段开始，并把 bug 约束注入本轮执行。",
        "intent": "propose_action",
        "target_step_key": "req",
        "artifact_requests": [],
        "proposal": {
            "type": "rerun_from_stage",
            "target_step_key": "req",
            "payload": {"content": injected_prompt},
        },
    }
    try:
        accepted = await client.post(
            f"/api/task/{task_id}/chat?project_id={project_id}",
            headers={"Idempotency-Key": "chat-rerun-with-prompt"},
            json={"content": "登录偶发超时，请判断从哪里重新执行"},
        )
        assistant = await _wait_for_reply(
            client,
            project_id,
            task_id,
            accepted.json()["assistant_message_id"],
        )

        proposal = assistant["proposals"][0]
        assert proposal["payload"]["content"] == injected_prompt

        confirmed = await client.post(
            f"/api/task/{task_id}/actions/{proposal['id']}/confirm"
            f"?project_id={project_id}",
            headers={"Idempotency-Key": "confirm-rerun-with-prompt"},
        )

        assert confirmed.status_code == 200
        assert confirmed.json()["status"] == "succeeded"
        assert confirmed.json()["result"]["status"] == "started"
        assert confirmed.json()["result"]["supplement_id"]
        with main.project_manager.activate_project_by_id(project_id):
            supplement = StepSupplement.get(
                StepSupplement.source_proposal == proposal["id"]
            )
            assert supplement.step_key == "req"
            assert supplement.content == injected_prompt

        for _ in range(100):
            if any(
                "## User-confirmed step supplements" in call["prompt"]
                and injected_prompt in call["prompt"]
                for call in CoordinatorFakeEngine.calls
            ):
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("Injected prompt did not reach the target step")
    finally:
        CoordinatorFakeEngine.reply = {
            "version": 1,
            "reply": "协调回复",
            "intent": "answer",
            "target_step_key": None,
            "artifact_requests": [],
            "proposal": None,
        }


@pytest.mark.anyio
async def test_coordinator_can_start_from_step_before_any_workflow_run(
    api_context,
    monkeypatch,
):
    from engines.core.registry import ENGINE_REGISTRY
    from models import Task, WorkflowRun
    import main

    client, tmp_path = api_context
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", CoordinatorFakeEngine)
    project_id, task_id = await _create_task(client, tmp_path)
    CoordinatorFakeEngine.reply = {
        "version": 1,
        "reply": "当前任务还没有可重跑的工作流记录。",
        "intent": "propose_action",
        "target_step_key": "req",
        "artifact_requests": [],
        "proposal": {
            "type": "rerun_from_stage",
            "target_step_key": "req",
            "payload": {},
        },
    }
    try:
        accepted = await client.post(
            f"/api/task/{task_id}/chat?project_id={project_id}",
            headers={"Idempotency-Key": "chat-invalid-rerun"},
            json={"content": "重新执行需求阶段"},
        )
        assistant = await _wait_for_reply(
            client,
            project_id,
            task_id,
            accepted.json()["assistant_message_id"],
        )

        proposal = assistant["proposals"][0]
        confirmed = await client.post(
            f"/api/task/{task_id}/actions/{proposal['id']}/confirm"
            f"?project_id={project_id}",
            headers={"Idempotency-Key": "confirm-first-stage-run"},
        )

        assert confirmed.status_code == 200
        assert confirmed.json()["status"] == "succeeded"
        assert confirmed.json()["result"]["status"] == "started"
        with main.project_manager.activate_project_by_id(project_id):
            task = Task.get_by_id(task_id)
            assert task.active_workflow_run_id
            assert WorkflowRun.get_by_id(task.active_workflow_run_id)
    finally:
        CoordinatorFakeEngine.reply = {
            "version": 1,
            "reply": "协调回复",
            "intent": "answer",
            "target_step_key": None,
            "artifact_requests": [],
            "proposal": None,
        }


@pytest.mark.anyio
async def test_restart_from_step_creates_child_run_and_keeps_outputs(
    api_context,
    monkeypatch,
):
    from engines.core.registry import ENGINE_REGISTRY
    from models import StepRun, Task, WorkflowRun
    import main

    client, tmp_path = api_context
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", CoordinatorFakeEngine)
    project_dir = tmp_path / "restart-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]
    workflow = await client.post(
        f"/api/workflow/create?project_id={project_id}",
        json={
            "name": "RestartFlow",
            "steps": {
                "nodes": [
                    {"id": 1, "type": "req", "title": "Req", "engine": "claude"},
                    {"id": 2, "type": "ui", "title": "UI", "engine": "claude"},
                    {"id": 3, "type": "build", "title": "Build", "engine": "claude"},
                ],
                "connections": [
                    {"from": 1, "to": 2},
                    {"from": 2, "to": 3},
                ],
            },
        },
    )
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={
            "title": "Restart task",
            "cwd": str(project_dir),
            "workflow_id": workflow.json()["id"],
            "auto_start": False,
        },
    )
    task_id = created.json()["id"]
    started = await client.post(
        f"/api/task/run?project_id={project_id}",
        json={"task_id": task_id, "prompt": ""},
    )
    parent_run_id = started.json()["run_id"]
    for _ in range(100):
        with main.project_manager.activate_project_by_id(project_id):
            if WorkflowRun.get_by_id(parent_run_id).status == "succeeded":
                break
        await asyncio.sleep(0.01)

    req_dir = (
        project_dir / ".workstep" / "artifacts" / workflow.json()["id"]
        / task_id / "req" / "1"
    )
    ui_dir = (
        project_dir / ".workstep" / "artifacts" / workflow.json()["id"]
        / task_id / "ui" / "1"
    )
    req_dir.mkdir(parents=True, exist_ok=True)
    ui_dir.mkdir(parents=True, exist_ok=True)
    (req_dir / "req.md").write_text("keep", encoding="utf-8")
    (ui_dir / "ui.md").write_text("archive", encoding="utf-8")

    handle = await main.workflow_runtime.restart_from_step(
        project_id,
        task_id,
        "ui",
        expected_run_id=parent_run_id,
    )
    await main.workflow_runtime.wait(handle)

    with main.project_manager.activate_project_by_id(project_id):
        parent = WorkflowRun.get_by_id(parent_run_id)
        child = WorkflowRun.get_by_id(handle.id)
        task = Task.get_by_id(task_id)
        reused = StepRun.get(
            (StepRun.run == child)
            & (StepRun.step_key == "req")
        )
        assert parent.status == "superseded"
        assert child.parent_run_id == parent.id
        assert child.restart_from_step_key == "ui"
        assert reused.status == "reused"
        assert reused.source_step_run_id
        assert task.active_workflow_run_id == child.id
    assert (req_dir / "req.md").read_text(encoding="utf-8") == "keep"
    assert (ui_dir / "ui.md").read_text(encoding="utf-8") == "archive"
    assert not (
        project_dir
        / ".workstep"
        / "artifact-history"
        / task_id
        / parent_run_id
        / "ui"
    ).exists()


class StoppableStreamingEngine(StreamingCoordinatorFakeEngine):
    calls: list[dict] = []
    stopped: bool = False

    @classmethod
    def reset(cls):
        cls.calls = []
        cls.stopped = False
        cls.release = asyncio.Event()

    async def spawn(self, prompt, cwd, model=None, session_id=None, **kwargs):
        type(self).calls.append({
            "prompt": prompt,
            "cwd": cwd,
            "model": model,
            "session_id": session_id,
        })
        yield InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": '{"version":1,"reply":"实时'}},
        )
        await type(self).release.wait()
        yield InternalEvent(
            type="agent_message_chunk",
            data={
                "content": {"text": (
                    '回复","intent":"answer","target_step_key":null,'
                    '"artifact_requests":[],"proposal":null}'
                )}
            },
        )

    async def stop(self):
        type(self).stopped = True
        type(self).release.set()


class NonCooperativeStopEngine(StoppableStreamingEngine):
    async def stop(self):
        type(self).stopped = True


class HangingStopEngine(StoppableStreamingEngine):
    async def stop(self):
        type(self).stopped = True
        await asyncio.Event().wait()


@pytest.mark.anyio
async def test_coordinator_stop_persists_before_cancelled_stop_request(api_context, monkeypatch):
    from engines.core.registry import ENGINE_REGISTRY
    from models import CoordinatorTurn, Message
    import main

    client, tmp_path = api_context
    HangingStopEngine.reset()
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", HangingStopEngine)
    project_id, task_id = await _create_task(client, tmp_path)
    accepted = await client.post(
        f"/api/task/{task_id}/chat?project_id={project_id}",
        headers={"Idempotency-Key": "cancelled-stop-request"},
        json={"content": "开始后停止"},
    )
    turn_id = accepted.json()["turn_id"]
    assistant_id = accepted.json()["assistant_message_id"]
    for _ in range(100):
        if await main.project_manager.run_db(
            project_id,
            lambda _project: CoordinatorTurn.get_by_id(turn_id).status,
        ) == "running":
            break
        await asyncio.sleep(0.01)
    else:
        raise AssertionError("coordinator turn did not start")

    stop_request = asyncio.create_task(
        main.coordinator_module.stop_current(project_id, task_id)
    )
    for _ in range(100):
        if HangingStopEngine.stopped:
            break
        await asyncio.sleep(0.01)
    else:
        raise AssertionError("engine stop was not called")
    stop_request.cancel()
    with pytest.raises(asyncio.CancelledError):
        await stop_request

    state = await main.project_manager.run_db(
        project_id,
        lambda _project: (
            CoordinatorTurn.get_by_id(turn_id).status,
            Message.get_by_id(assistant_id).run_status,
        ),
    )
    assert state == ("stopped", "stopped")


@pytest.mark.anyio
@pytest.mark.parametrize("engine_type", [NonCooperativeStopEngine, HangingStopEngine])
async def test_coordinator_stop_cancels_turn_when_engine_stop_does_not_end_stream(
    api_context, monkeypatch, engine_type,
):
    from engines.core.registry import ENGINE_REGISTRY
    from models import CoordinatorTurn
    import agent_assistants.coordinator as coordinator_service
    import main

    client, tmp_path = api_context
    engine_type.reset()
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", engine_type)
    monkeypatch.setattr(coordinator_service, "COORDINATOR_STOP_TIMEOUT_SECONDS", 0.01)
    project_id, task_id = await _create_task(client, tmp_path)
    event_queue = main.coordinator_module._event_bus.subscribe()
    try:
        accepted = await client.post(
            f"/api/task/{task_id}/chat?project_id={project_id}",
            headers={"Idempotency-Key": "chat-noncooperative-stop"},
            json={"content": "开始后停下来"},
        )
        assistant_id = accepted.json()["assistant_message_id"]
        turn_id = accepted.json()["turn_id"]
        while True:
            event = await asyncio.wait_for(event_queue.get(), timeout=1)
            if event.get("messageId") == assistant_id and event.get("type") == "TEXT_MESSAGE_CHUNK":
                break
        queued = await client.post(
            "/api/pending-message-inserts",
            json={
                "project_id": project_id,
                "target_message_id": assistant_id,
                "content": "停止后继续处理这条",
            },
        )
        assert queued.status_code == 200

        stopped = await client.post(
            f"/api/task/{task_id}/coordinator/stop?project_id={project_id}"
        )
        assert stopped.json() == {"stopped": True}
        assistant = await _wait_for_reply(
            client, project_id, task_id,
            assistant_message_id=assistant_id, include_stopped=True,
        )
        assert assistant["run_status"] == "stopped"
        assert await main.project_manager.run_db(
            project_id,
            lambda _project: CoordinatorTurn.get_by_id(turn_id).status,
        ) == "stopped"
        engine_type.release.set()
        for _ in range(100):
            history = await client.get(
                f"/api/task/{task_id}/history?project_id={project_id}"
            )
            if any(
                message["role"] == "user"
                and message["content"] == "停止后继续处理这条"
                for message in history.json()["messages"]
            ):
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("queued coordinator insert was lost after stopping")
        followup = await client.post(
            f"/api/task/{task_id}/chat?project_id={project_id}",
            headers={"Idempotency-Key": "chat-after-noncooperative-stop"},
            json={"content": "继续下一轮"},
        )
        assert followup.status_code == 200
        next_reply = await _wait_for_reply(
            client, project_id, task_id,
            assistant_message_id=followup.json()["assistant_message_id"],
        )
        assert next_reply["run_status"] == "succeeded"
    finally:
        engine_type.release.set()
        main.coordinator_module._event_bus.unsubscribe(event_queue)


@pytest.mark.anyio
async def test_coordinator_stop_marks_turn_stopped(
    api_context,
    monkeypatch,
):
    from engines.core.registry import ENGINE_REGISTRY
    from models import CoordinatorTurn
    import main

    client, tmp_path = api_context
    StoppableStreamingEngine.reset()
    monkeypatch.setitem(
        ENGINE_REGISTRY,
        "claude",
        StoppableStreamingEngine,
    )
    project_id, task_id = await _create_task(client, tmp_path)
    event_queue = main.coordinator_module._event_bus.subscribe()
    try:
        accepted = await client.post(
            f"/api/task/{task_id}/chat?project_id={project_id}",
            headers={"Idempotency-Key": "chat-stop"},
            json={"content": "开始后请停下来"},
        )
        assert accepted.status_code == 200
        assistant_id = accepted.json()["assistant_message_id"]
        turn_id = accepted.json()["turn_id"]

        while True:
            event = await asyncio.wait_for(event_queue.get(), timeout=1)
            if (
                event.get("messageId") == assistant_id
                and event.get("type") == "TEXT_MESSAGE_CHUNK"
            ):
                break

        stopped = await client.post(
            f"/api/task/{task_id}/coordinator/stop?project_id={project_id}"
        )
        assert stopped.status_code == 200
        assert stopped.json() == {"stopped": True}
        assert StoppableStreamingEngine.stopped

        assistant = await _wait_for_reply(
            client,
            project_id,
            task_id,
            assistant_message_id=assistant_id,
            include_stopped=True,
        )
        assert assistant["run_status"] == "stopped"

        with main.project_manager.activate_project_by_id(project_id):
            turn = CoordinatorTurn.get_by_id(turn_id)
            assert turn.status == "stopped"

        published = []
        while not event_queue.empty():
            published.append(event_queue.get_nowait())
        completed = next(
            event for event in published
            if event.get("messageId") == assistant_id
            and event.get("type") == "TEXT_MESSAGE_END"
        )
        assert completed["status"] == "stopped"

        # 已结束的 turn 再次停止返回 False，且不会改变状态
        again = await client.post(
            f"/api/task/{task_id}/coordinator/stop?project_id={project_id}"
        )
        assert again.json() == {"stopped": False}

        # 停止后仍可发起新一轮对话
        accepted2 = await client.post(
            f"/api/task/{task_id}/chat?project_id={project_id}",
            headers={"Idempotency-Key": "chat-stop-2"},
            json={"content": "再来一轮"},
        )
        assert accepted2.status_code == 200
    finally:
        main.coordinator_module._event_bus.unsubscribe(event_queue)


@pytest.mark.anyio
async def test_coordinator_provider_override_saved_and_validated(api_context):
    """任务级协调供应商：仅 Pydantic AI 引擎可配；保存后参与解析。"""
    import agent_assistants.coordinator as coordinator_service

    client, tmp_path = api_context
    coordinator_service.config_store.set("providers", [
        {
            "id": "prov_test",
            "name": "Test Provider",
            "type": "deepseek",
            "base_url": "https://api.test/v1",
            "api_key": "k",
            "enabled": True,
        },
    ])
    project_id, task_id = await _create_task(client, tmp_path)

    # 非 Pydantic AI 引擎不能带供应商。
    rejected = await client.patch(
        f"/api/task/{task_id}/coordinator-config?project_id={project_id}",
        json={"engine": "claude", "provider_id": "prov_test"},
    )
    assert rejected.status_code == 400

    # 供应商不存在。
    missing = await client.patch(
        f"/api/task/{task_id}/coordinator-config?project_id={project_id}",
        json={"engine": "pydantic_ai", "provider_id": "prov_missing"},
    )
    assert missing.status_code == 400

    updated = await client.patch(
        f"/api/task/{task_id}/coordinator-config?project_id={project_id}",
        json={"engine": "pydantic_ai", "provider_id": "prov_test"},
    )
    assert updated.status_code == 200
    body = updated.json()
    assert body["configured"]["provider_id"] == "prov_test"
    assert body["resolved"]["provider_id"] == "prov_test"
    assert body["resolved"]["engine"] == "pydantic_ai"

    loaded = await client.get(
        f"/api/task/{task_id}/coordinator-config?project_id={project_id}"
    )
    assert loaded.status_code == 200
    assert loaded.json()["configured"]["provider_id"] == "prov_test"


@pytest.mark.anyio
async def test_explicit_engine_uses_its_own_provider_default(
    api_context,
    monkeypatch,
):
    """明确选择 Codex 后，“跟随默认”应使用 Codex 自己的默认供应商。"""
    import agent_assistants.coordinator as coordinator_service
    from engines.core.registry import ENGINE_REGISTRY

    client, tmp_path = api_context
    monkeypatch.setitem(ENGINE_REGISTRY, "codex", SecondCoordinatorFakeEngine)
    monkeypatch.setattr(
        coordinator_service.config_store,
        "get_assistant_defaults",
        lambda _name: {
            "engine": "codex",
            "provider_id": "prov_chat",
        },
        raising=False,
    )
    project_id, task_id = await _create_task(client, tmp_path)

    updated = await client.patch(
        f"/api/task/{task_id}/coordinator-config?project_id={project_id}",
        json={"engine": "codex", "provider_id": None},
    )

    assert updated.status_code == 200
    assert updated.json()["configured"]["provider_id"] == ""
    assert updated.json()["resolved"]["provider_id"] == ""

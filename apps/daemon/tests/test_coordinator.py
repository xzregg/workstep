"""Coordinator conversation, engine switching, and action tests."""

import asyncio
import json
from contextlib import AsyncExitStack

import pytest
from httpx import ASGITransport, AsyncClient

from engines.base import BaseLLMEngine
from engines.events import InternalEvent
from services.coordinator import CoordinatorModule
from services.project import ProjectManager
from services.task import TaskService
from services.workflow_runtime import WorkflowRuntime
from streaming.bus import EventBus


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

    def get_engine_default_model(self, engine_id):
        return ""

    def is_engine_verified(self, engine_id):
        return True


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
    import services.coordinator as coordinator_service

    config_store = MemoryConfigStore()
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


class CoordinatorFakeEngine(BaseLLMEngine):
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
            type="text_delta",
            data={"delta": json.dumps(type(self).reply, ensure_ascii=False)},
        )
        yield InternalEvent(
            type="usage",
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


class SecondCoordinatorFakeEngine(CoordinatorFakeEngine):
    calls: list[dict] = []


class ImageRoutingCoordinatorFakeEngine(CoordinatorFakeEngine):
    calls: list[dict] = []

    async def spawn(self, prompt, cwd, model=None, session_id=None, **kwargs):
        type(self).calls.append({
            "prompt": prompt,
            "images": kwargs.get("images"),
        })
        yield InternalEvent(
            type="text_delta",
            data={"delta": json.dumps(type(self).reply, ensure_ascii=False)},
        )
        yield InternalEvent(
            type="usage",
            data={"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
        )


class StreamingCoordinatorFakeEngine(CoordinatorFakeEngine):
    release: asyncio.Event

    async def spawn(self, prompt, cwd, model=None, session_id=None, **kwargs):
        yield InternalEvent(
            type="text_delta",
            data={"delta": '{"version":1,"reply":"实时'},
        )
        await type(self).release.wait()
        yield InternalEvent(
            type="text_delta",
            data={
                "delta": (
                    '回复","intent":"answer","target_step_key":null,'
                    '"artifact_requests":[],"proposal":null}'
                )
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
            yield InternalEvent(type="text_delta", data={"delta": "invalid json"})
            return
        yield InternalEvent(
            type="text_delta",
            data={"delta": json.dumps(type(self).reply, ensure_ascii=False)},
        )


async def _create_task(client, tmp_path):
    project_dir = tmp_path / "coordinator-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={
            "title": "Coordinator task",
            "cwd": str(project_dir),
            "auto_start": False,
        },
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
    from services.coordinator import CoordinatorModule
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

        def workflow_by_id(self, workflow_id):
            return None

    module = CoordinatorModule(EventBus(), None, None)
    prompt, _ = module._assemble_context(StubProject(), task, turn)
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


@pytest.mark.anyio
async def test_chat_calls_selected_engine_without_starting_workflow(
    api_context,
    monkeypatch,
):
    from engines.registry import ENGINE_REGISTRY
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
            if event.get("message_id") == accepted.json()["assistant_message_id"]
        ]
        assert [
            event["data"].get("delta")
            for event in assistant_events
            if event["type"] == "text_delta"
        ] == ["协调回复"]
        assert next(
            event for event in assistant_events
            if event["type"] == "message_snapshot"
        )["data"]["content"] == "协调回复"
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
async def test_coordinator_pushes_reply_before_engine_turn_finishes(
    api_context,
    monkeypatch,
):
    from engines.registry import ENGINE_REGISTRY
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
                event.get("message_id") == assistant_id
                and event.get("type") == "text_delta"
            ):
                break

        assert event["data"]["delta"] == "实时"
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
async def test_coordinator_engine_switch_only_affects_new_turns(
    api_context,
    monkeypatch,
):
    from engines.registry import ENGINE_REGISTRY

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
async def test_coordinator_routes_reasoning_and_repair_to_separate_models(
    api_context,
    monkeypatch,
):
    from engines.registry import ENGINE_REGISTRY

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
    from engines.registry import ENGINE_REGISTRY
    import services.coordinator as coordinator_service

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
async def test_coordinator_routes_message_images_to_engine(api_context, monkeypatch):
    from engines.registry import ENGINE_REGISTRY

    client, tmp_path = api_context
    ImageRoutingCoordinatorFakeEngine.calls.clear()
    monkeypatch.setitem(
        ENGINE_REGISTRY, "claude", ImageRoutingCoordinatorFakeEngine
    )
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
    images = call["images"]
    assert images is not None
    assert len(images) == 1
    assert images[0].path == str(shot.resolve())
    assert images[0].description == "运行截图"
    assert "coordinator-project/.workstep/uploads/shot.png" in call["prompt"]


@pytest.mark.anyio
async def test_coordinator_ignores_images_outside_uploads(api_context, monkeypatch):
    from engines.registry import ENGINE_REGISTRY

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
    from engines.registry import ENGINE_REGISTRY
    import services.coordinator as coordinator_service

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
    import services.coordinator as coordinator_service

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
    from engines.registry import ENGINE_REGISTRY
    import services.coordinator as coordinator_service

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
            {
                "id": "api",
                "installed": True,
                "configured": False,
                "built_in": False,
                "mode": "api",
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
    assert engines["api"]["mode"] == "api"
    assert engines["api"]["configured"] is False


@pytest.mark.anyio
async def test_confirmed_stage_supplement_is_persisted(
    api_context,
    monkeypatch,
):
    from engines.registry import ENGINE_REGISTRY
    from models import StageSupplement
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
            "type": "supplement_stage",
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
        confirmed = await client.post(
            f"/api/task/{task_id}/actions/{proposal['id']}/confirm"
            f"?project_id={project_id}",
            headers={"Idempotency-Key": "confirm-supplement"},
        )
        assert confirmed.status_code == 200
        assert confirmed.json()["status"] == "succeeded"
        with main.project_manager.activate_project_by_id(project_id):
            supplement = StageSupplement.get()
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
async def test_coordinator_can_start_from_stage_before_any_workflow_run(
    api_context,
    monkeypatch,
):
    from engines.registry import ENGINE_REGISTRY
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
async def test_restart_from_stage_creates_child_run_and_archives_outputs(
    api_context,
    monkeypatch,
):
    from engines.registry import ENGINE_REGISTRY
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

    req_dir = project_dir / ".workstep" / "artifacts" / "req" / task_id
    ui_dir = project_dir / ".workstep" / "artifacts" / "ui" / task_id
    req_dir.mkdir(parents=True, exist_ok=True)
    ui_dir.mkdir(parents=True, exist_ok=True)
    (req_dir / "req.md").write_text("keep", encoding="utf-8")
    (ui_dir / "ui.md").write_text("archive", encoding="utf-8")

    handle = await main.workflow_runtime.restart_from_stage(
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
    archived = (
        project_dir
        / ".workstep"
        / "artifact-history"
        / task_id
        / parent_run_id
        / "ui"
        / "ui.md"
    )
    assert archived.read_text(encoding="utf-8") == "archive"


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
            type="text_delta",
            data={"delta": '{"version":1,"reply":"实时'},
        )
        await type(self).release.wait()
        yield InternalEvent(
            type="text_delta",
            data={
                "delta": (
                    '回复","intent":"answer","target_step_key":null,'
                    '"artifact_requests":[],"proposal":null}'
                )
            },
        )

    async def stop(self):
        type(self).stopped = True
        type(self).release.set()


@pytest.mark.anyio
async def test_coordinator_stop_marks_turn_stopped(
    api_context,
    monkeypatch,
):
    from engines.registry import ENGINE_REGISTRY
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
                event.get("message_id") == assistant_id
                and event.get("type") == "text_delta"
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
            if event.get("message_id") == assistant_id
            and event.get("type") == "message_completed"
        )
        assert completed["data"] == {"status": "stopped"}

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

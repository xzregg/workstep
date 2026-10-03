"""Tests for the in-memory workflow generation chat module."""

import asyncio
import json
import time
from types import SimpleNamespace

import pytest

from services.project import ProjectManager
from services.workflow_definition import WorkflowDefinition
from agent_assistants.workflow_gen import SYSTEM_PROMPT, WorkflowGenModule
from agent_assistants.workflow_patch import apply_patch
from agent_assistants.base import AssistantConfig, AssistantRuntime
from streaming.bus import EventBus


class MemoryConfigStore:
    """In-memory coordinator config store (module is memory-only anyway)."""

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
            "provider_id": "",
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


def test_assistant_model_switch_preserves_engine_session_id():
    runtime = AssistantRuntime(
        AssistantConfig(
            name="test",
            channel="test",
            cwd_resolver=lambda manager, project_id: "/tmp",
        ),
        EventBus(),
        None,
    )
    session = runtime._get_or_create_session(
        "project-1", "assistant-1", ("project-1", "assistant-1"), None,
        "claude_agent_sdk", "sonnet", None,
    )
    session.resolved_session_id = "engine-session-1"

    updated = runtime._get_or_create_session(
        "project-1", "assistant-1", ("project-1", "assistant-1"), None,
        "claude_agent_sdk", "opus", None,
        model_override="opus",
    )

    assert updated.resolved_session_id == "engine-session-1"


async def _wait_turn(module, turn_id, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = module._turn_states.get(turn_id)
        if state and state["status"] in ("completed", "error"):
            return state["status"]
        await asyncio.sleep(0.01)
    raise AssertionError("turn did not finish")


@pytest.mark.anyio
async def test_stop_current_stops_running_generation(gen_module, monkeypatch):
    import agent_assistants.base as assistant_base
    import agent_assistants.workflow_gen as wfgen_service

    module, bus, _, project, _ = gen_module
    started = asyncio.Event()
    release = asyncio.Event()
    stop_started = asyncio.Event()
    allow_stop = asyncio.Event()

    class CancellationSwallowingEngine:
        capabilities = SimpleNamespace(supports_coordinator=True)
        supports_resume = False
        supports_message_history = False

        def __init__(self):
            self.stop_called = False

        async def spawn(self, **kwargs):
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                await release.wait()
            if False:
                yield None

        async def stop(self):
            self.stop_called = True
            stop_started.set()
            await allow_stop.wait()
            release.set()

    engine = CancellationSwallowingEngine()
    monkeypatch.setattr(assistant_base, "create_engine", lambda engine_id: engine)
    monkeypatch.setattr(wfgen_service, "create_engine", lambda engine_id: engine)

    queue = bus.subscribe()
    accepted = module.submit_message(
        project.id, None, "帮我创建流程", "idem-stop"
    )
    await asyncio.wait_for(started.wait(), timeout=2)

    stop_request = asyncio.create_task(module.stop_current(accepted.session_id))
    await asyncio.wait_for(stop_started.wait(), timeout=2)
    returned_before_engine_cleanup = stop_request.done()
    allow_stop.set()
    assert await stop_request is True
    assert returned_before_engine_cleanup is True
    assert await module.stop_current(accepted.session_id) is True
    assert engine.stop_called is True

    deadline = time.monotonic() + 2
    while module._turn_states[accepted.turn_id]["status"] != "stopped":
        assert time.monotonic() < deadline
        await asyncio.sleep(0.01)

    completed = None
    while completed is None:
        event = await asyncio.wait_for(queue.get(), timeout=2)
        if event["type"] == "TEXT_MESSAGE_END":
            completed = event
    assert completed["session_id"] == accepted.session_id
    assert completed["status"] == "stopped"

    session = module._sessions[(project.id, accepted.session_id)]
    stopped_message = session.messages[-1]
    assert stopped_message["role"] == "assistant"
    assert stopped_message["status"] == "stopped"
    assert stopped_message["ended_at"]

    assert await module.stop_current("missing-session") is False


@pytest.mark.anyio
async def test_shutdown_marks_running_generation_stopped(gen_module, monkeypatch):
    """Daemon shutdown should surface as stopped, not as a generation error."""
    import agent_assistants.base as assistant_base
    import agent_assistants.workflow_gen as wfgen_service

    module, bus, _manager, project, _ = gen_module
    started = asyncio.Event()
    queue = bus.subscribe()

    class ShutdownEngine:
        capabilities = SimpleNamespace(supports_coordinator=True)
        supports_resume = False
        supports_message_history = False

        async def spawn(self, **kwargs):
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                raise RuntimeError(
                    "Codex process closed stdout. stderr_tail=apply_patch failed"
                )
            if False:
                yield None

        async def stop(self):
            return None

    engine = ShutdownEngine()
    monkeypatch.setattr(assistant_base, "create_engine", lambda engine_id: engine)
    monkeypatch.setattr(wfgen_service, "create_engine", lambda engine_id: engine)

    accepted = module.submit_message(
        project.id, None, "帮我创建流程", "idem-shutdown"
    )
    await asyncio.wait_for(started.wait(), timeout=2)

    await module.shutdown()

    completed = None
    while completed is None:
        event = await asyncio.wait_for(queue.get(), timeout=2)
        if event["type"] == "TEXT_MESSAGE_END":
            completed = event
    assert completed["session_id"] == accepted.session_id
    assert completed["status"] == "stopped"
    assert "stderr_tail" not in str(completed)


@pytest.fixture
async def gen_module(tmp_path, monkeypatch):
    import agent_assistants.base as assistant_base
    import services.config as config_service
    import services.project as project_service
    import agent_assistants.workflow_gen as wfgen_service

    config_store = MemoryConfigStore()
    monkeypatch.setattr(config_service, "config_store", config_store)
    monkeypatch.setattr(assistant_base, "config_store", config_store)
    monkeypatch.setattr(project_service, "config_store", config_store)
    monkeypatch.setattr(wfgen_service, "config_store", config_store)

    manager = ProjectManager()
    bus = EventBus()
    module = WorkflowGenModule(bus, manager)
    project = manager.init_project(tmp_path / "gen-proj")
    monkeypatch.setattr(
        wfgen_service,
        "create_engine",
        lambda engine_id: None if engine_id in ("claude", "codex") else FakeEngine(),
    )
    yield module, bus, manager, project, config_store
    await module.shutdown()
    await bus.close()
    manager.close_all()


@pytest.mark.anyio
async def test_submit_creates_session_and_is_idempotent(gen_module, monkeypatch):
    module, bus, manager, project, _ = gen_module

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None):
        return json.dumps({"reply": "先澄清一下", "flow_proposals": []}), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    accepted = module.submit_message(
        project.id, None, "帮我设计一个内容发布流程", "idem-1"
    )
    assert accepted.status == "queued"
    assert accepted.session_id
    status = await _wait_turn(module, accepted.turn_id)
    assert status == "completed"
    assert module._turn_states[accepted.turn_id]["status"] == "completed"

    session = module._sessions[(project.id, accepted.session_id)]
    assistant_message = session.messages[-1]
    assert assistant_message["role"] == "assistant"
    assert assistant_message["status"] == "succeeded"
    assert assistant_message["ended_at"]
    assert assistant_message["created_at"] <= assistant_message["ended_at"]

    replayed = module.submit_message(
        project.id, None, "帮我设计一个内容发布流程", "idem-1"
    )
    assert replayed.turn_id == accepted.turn_id
    assert replayed.session_id == accepted.session_id


@pytest.mark.anyio
async def test_workflow_assistant_routes_image_message_to_vision_model(
    gen_module, monkeypatch
):
    module, _bus, _manager, project, config_store = gen_module
    config_store.values["assistant_defaults"] = {
        "workflow_gen": {
            "engine": "claude",
            "model": "workflow-reasoning",
            "fast_model": "workflow-fast",
            "vision_model": "workflow-vision",
        }
    }
    upload = project.workstep_dir / "uploads" / "canvas.png"
    upload.parent.mkdir(parents=True, exist_ok=True)
    upload.write_bytes(b"fake-png")
    captured = {}

    async def fake_invoke(*args, **kwargs):
        captured.update(model=args[1], images=kwargs.get("images"))
        return json.dumps({"reply": "已分析画布", "flow_proposals": []}), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    accepted = module.submit_message(
        project.id,
        None,
        "按图设计流程 ![画布](.workstep/uploads/canvas.png)",
        "idem-image",
    )

    assert await _wait_turn(module, accepted.turn_id) == "completed"
    assert captured["model"] == "workflow-vision"
    assert captured["images"][0].path == str(upload.resolve())


@pytest.mark.anyio
async def test_template_mode_runs_without_project(gen_module, tmp_path, monkeypatch):
    """Flow-template editing (empty project_id) runs and persists globally."""
    import services.global_sessions as global_sessions
    import agent_assistants.workflow_gen as wfgen_service
    from models.gen_session import WorkflowGenSession

    monkeypatch.setattr(
        wfgen_service, "CONFIG_DIR", tmp_path / "config"
    )
    monkeypatch.setattr(
        global_sessions, "GLOBAL_SESSIONS_DB_PATH", tmp_path / "gen_sessions.db"
    )
    global_sessions.reset_global_sessions_db()

    module, bus, manager, project, _ = gen_module

    async def fake_invoke(
        engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None
    ):
        assert cwd == str(tmp_path / "config" / "data" / "templates")
        return json.dumps({"reply": "模板方案", "flow_proposals": []}), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    accepted = module.submit_message(
        "",
        None,
        "设计一个内容发布模板",
        "idem-template-1",
        workflow_id="template:release",
    )
    assert accepted.status == "queued"
    assert accepted.session_id == "wf::template:release"
    status = await _wait_turn(module, accepted.turn_id)
    assert status == "completed"

    session = module._sessions[("wf", "", "template:release")]
    assert session.cwd == str(tmp_path / "config" / "data" / "templates")
    assert session.project_id == ""

    with global_sessions.global_sessions_ctx():
        row = WorkflowGenSession.get_or_none(
            WorkflowGenSession.project_id == "",
            WorkflowGenSession.workflow_id == "template:release",
        )
    assert row is not None
    assert row.cwd == str(tmp_path / "config" / "data" / "templates")

    history = module.history("", "template:release")
    assert history["session_id"] == "wf::template:release"
    assert any(item["role"] == "assistant" for item in history["messages"])

    assert module.reset_session("", "template:release") is True
    with global_sessions.global_sessions_ctx():
        gone = WorkflowGenSession.get_or_none(
            WorkflowGenSession.project_id == "",
            WorkflowGenSession.workflow_id == "template:release",
        )
    assert gone is None


@pytest.mark.anyio
async def test_thinking_effort_reaches_workflow_generation_engine(
    gen_module,
    monkeypatch,
):
    import agent_assistants.base as assistant_base
    import agent_assistants.workflow_gen as wfgen_service
    from engines.core.events import InternalEvent

    module, _, _, project, _ = gen_module
    calls: list[dict] = []

    class ThinkingEngine:
        capabilities = SimpleNamespace(
            supports_coordinator=True,
            supports_thinking_effort=True,
        )
        supports_resume = False
        supports_message_history = False

        async def spawn(self, **kwargs):
            calls.append(kwargs)
            yield InternalEvent(
                type="agent_message_chunk",
                data={
                    "content": {
                        "text": json.dumps(
                            {"reply": "ok", "flow_proposals": []}
                        )
                    }
                },
                timestamp=time.time(),
            )

        async def stop(self):
            return None

    engine = ThinkingEngine()
    monkeypatch.setattr(assistant_base, "create_engine", lambda engine_id: engine)
    monkeypatch.setattr(wfgen_service, "create_engine", lambda engine_id: engine)

    accepted = module.submit_message(
        project.id,
        None,
        "设计流程",
        "idem-thinking",
        thinking_effort="high",
    )
    assert await _wait_turn(module, accepted.turn_id) == "completed"
    assert calls[0]["thinking_effort"] == "high"


@pytest.mark.anyio
async def test_flow_proposal_event_is_validated_and_taskless(gen_module, monkeypatch):
    module, bus, manager, project, _ = gen_module
    queue = bus.subscribe()
    collected: list[dict] = []
    stop = asyncio.Event()

    async def collector():
        while not stop.is_set():
            try:
                event = await asyncio.wait_for(queue.get(), timeout=0.05)
            except asyncio.TimeoutError:
                continue
            collected.append(event)

    collector_task = asyncio.create_task(collector())
    proposal = {
        "nodes": [
            {"id": 1, "type": "req", "title": "需求"},
            {"id": 2, "type": "publish", "title": "发布"},
        ],
        "connections": [
            {"from": 1, "fromPort": 0, "to": 2, "toPort": 0, "kind": "solid"}
        ],
    }
    raw = json.dumps(
        {
            "reply": "这是完整流程",
            "flow_proposals": [
                {
                    "title": "标准版",
                    "workflowName": "发布流程",
                    "summary": "需求到发布",
                    "steps": proposal,
                }
            ],
        }
    )

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None):
        if on_event is not None:
            # Simulate a streamed JSON reply with an escaped reply field
            from engines.core.events import InternalEvent
            chunk = '"reply":"这是完整流程"'
            for char in chunk:
                await on_event(
                    InternalEvent(
                        type="agent_message_chunk",
                        data={"content": {"text": char}},
                        timestamp=time.time(),
                    )
                )
        return raw, [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    accepted = module.submit_message(project.id, None, "设计一个发布流程", "idem-2")
    status = await _wait_turn(module, accepted.turn_id)
    assert status == "completed"

    stop.set()
    await asyncio.wait_for(collector_task, timeout=2)

    proposal_events = [
        e for e in collected
        if e["type"] == "CUSTOM" and e["name"] == "workstep.flow_proposals"
    ]
    assert proposal_events, "expected a flow_proposals event"
    event = proposal_events[0]
    assert "task_id" not in event
    assert event["session_id"] == accepted.session_id
    assert event["channel"] == "flow_gen"
    cards = event["value"]["proposals"]
    assert len(cards) == 1
    assert cards[0]["title"] == "标准版"
    assert cards[0]["workflowName"] == "发布流程"
    assert cards[0]["nodeCount"] == 2
    steps = cards[0]["steps"]
    WorkflowDefinition.load(steps).validate()

    deltas = [e for e in collected if e["type"] == "TEXT_MESSAGE_CHUNK"]
    assert deltas
    streamed = "".join(e["delta"] for e in deltas)
    assert streamed == "这是完整流程"

    # No rows written to the project DB
    with manager.activate_project_by_id(project.id):
        from models import Task
        assert Task.select().count() == 0

    # Conversation history is kept in memory only
    session = module._sessions[(project.id, accepted.session_id)]
    assert [m["role"] for m in session.messages] == ["user", "assistant"]


@pytest.mark.anyio
async def test_flow_proposals_persist_and_survive_history(gen_module, monkeypatch):
    """flow_proposals 需随 assistant message 持久化，重开对话框后仍可恢复方案。"""
    module, bus, manager, project, _ = gen_module
    raw = json.dumps(
        {
            "reply": "请选择一个方案",
            "flow_proposals": [
                {
                    "title": "标准版",
                    "summary": "需求到发布",
                    "steps": {
                        "nodes": [
                            {"id": 1, "type": "req", "title": "需求"},
                            {"id": 2, "type": "publish", "title": "发布"},
                        ],
                        "connections": [
                            {"from": 1, "fromPort": 0, "to": 2, "toPort": 0, "kind": "solid"}
                        ],
                    },
                }
            ],
        }
    )

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None):
        return raw, [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    accepted = module.submit_message(
        project.id,
        None,
        "设计一个发布流程",
        "idem-persist",
        workflow_id="wf-x",
    )
    status = await _wait_turn(module, accepted.turn_id)
    assert status == "completed"

    session = module._sessions[("wf", project.id, "wf-x")]
    assert session.session_id == accepted.session_id
    assistant_message = session.messages[-1]
    assert assistant_message["role"] == "assistant"
    persisted_types = [e["type"] for e in assistant_message["events"]]
    assert "flow_proposals" in persisted_types
    event = next(e for e in assistant_message["events"] if e["type"] == "flow_proposals")
    assert event["data"]["proposals"][0]["title"] == "标准版"
    assert event["data"]["proposals"][0]["nodeCount"] == 2

    # 重新打开对话框：history API 必须把方案事件带回来
    history = module.history(project.id, "wf-x")
    assert history is not None
    history_events = history["messages"][-1]["events"]
    assert any(e["type"] == "flow_proposals" for e in history_events)
    restored = next(e for e in history_events if e["type"] == "flow_proposals")
    assert restored["data"]["proposals"][0]["title"] == "标准版"
    assert restored["data"]["proposals"][0]["steps"]["nodes"][0]["title"] == "需求"


@pytest.mark.anyio
async def test_invalid_proposal_is_repaired(gen_module, monkeypatch):
    module, bus, manager, project, _ = gen_module
    calls: list[str] = []

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None):
        calls.append(prompt)
        if len(calls) == 1:
            return (
                json.dumps(
                    {
                        "reply": "有重复",
                        "flow_proposals": [
                            {
                                "title": "有重复",
                                "summary": "",
                                "steps": {
                                    "nodes": [
                                        {"id": 1, "type": "req", "title": "需求"},
                                        {"id": 2, "type": "req", "title": "需求2"},
                                    ],
                                    "connections": [],
                                },
                            }
                        ],
                    }
                ),
                [],
                None,
            )
        return (
            json.dumps(
                {
                    "reply": "已修复",
                    "flow_proposals": [
                        {
                            "title": "已修复",
                            "summary": "",
                            "steps": {
                                "nodes": [
                                    {"id": 1, "type": "req", "title": "需求"},
                                    {"id": 2, "type": "test", "title": "测试"},
                                ],
                                "connections": [],
                            },
                        }
                    ],
                }
            ),
            [],
            None,
        )

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    accepted = module.submit_message(project.id, None, "设计一个流程", "idem-3")
    status = await _wait_turn(module, accepted.turn_id)
    assert status == "completed"
    assert len(calls) == 2

    session = module._sessions[(project.id, accepted.session_id)]
    # The repaired reply also carries the auto-generated a2ui choice UI.
    assert session.messages[-1]["content"].startswith("已修复")
    assert "```a2ui" not in session.messages[-1]["content"]


@pytest.mark.anyio
async def test_assistant_shape_missing_canvas_fields_is_repaired(gen_module, monkeypatch):
    module, *_ = gen_module
    invalid = json.dumps(
        {
            "reply": "请选择方案",
            "flow_proposals": [
                {
                    "title": "简洁版",
                    "steps": {
                        "nodes": [
                            {"id": "intake", "name": "需求评估", "outputs": ["review.md"]},
                            {"id": "estimate", "name": "工时评估", "outputs": ["estimate.md"]},
                        ],
                        "edges": [{"from": "intake", "to": "estimate"}],
                    },
                }
            ],
        }
    )
    fixed = json.dumps(
        {
            "reply": "已修复",
            "flow_proposals": [
                {
                    "title": "简洁版",
                    "steps": {
                        "nodes": [
                            {"id": 1, "type": "intake", "title": "需求评估"},
                            {"id": 2, "type": "estimate", "title": "工时评估"},
                        ],
                        "connections": [{"from": 1, "to": 2}],
                    },
                }
            ],
        }
    )
    calls: list[str] = []

    async def fake_invoke(*args, **kwargs):
        calls.append(args[3])
        return fixed, [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    reply, proposals, _events = await module._resolve_proposal_inner(
        SimpleNamespace(engine="claude", fast_model="fast", cwd="/tmp"),
        invalid,
    )

    assert reply == "已修复"
    assert len(calls) == 1
    assert proposals[0]["steps"]["nodes"][0]["title"] == "需求评估"


@pytest.mark.anyio
async def test_multiple_proposals_filter_invalid(gen_module, monkeypatch):
    module, bus, manager, project, _ = gen_module
    queue = bus.subscribe()
    collected: list[dict] = []
    stop = asyncio.Event()

    async def collector():
        while not stop.is_set():
            try:
                event = await asyncio.wait_for(queue.get(), timeout=0.05)
            except asyncio.TimeoutError:
                continue
            collected.append(event)

    collector_task = asyncio.create_task(collector())
    raw = json.dumps(
        {
            "reply": "两个方案",
            "flow_proposals": [
                {
                    "title": "简洁版",
                    "summary": "两个阶段",
                    "steps": {
                        "nodes": [
                            {"id": 1, "type": "req", "title": "需求"},
                            {"id": 2, "type": "publish", "title": "发布"},
                        ],
                        "connections": [],
                    },
                },
                {
                    "title": "非法版",
                    "summary": "重复 type",
                    "steps": {
                        "nodes": [
                            {"id": 1, "type": "req", "title": "需求"},
                            {"id": 2, "type": "req", "title": "需求2"},
                        ],
                        "connections": [],
                    },
                },
            ],
        }
    )

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None):
        return raw, [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    accepted = module.submit_message(project.id, None, "设计一个流程", "idem-5")
    status = await _wait_turn(module, accepted.turn_id)
    assert status == "completed"

    stop.set()
    await asyncio.wait_for(collector_task, timeout=2)
    proposal_events = [
        e for e in collected
        if e["type"] == "CUSTOM" and e["name"] == "workstep.flow_proposals"
    ]
    assert proposal_events
    cards = proposal_events[0]["value"]["proposals"]
    assert [card["title"] for card in cards] == ["简洁版"]


@pytest.mark.anyio
async def test_unrepairable_proposal_drops_proposal(gen_module, monkeypatch):
    module, bus, manager, project, _ = gen_module

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None):
        return (
            json.dumps(
                {
                    "reply": "说明",
                    "flow_proposals": [
                        {
                            "title": "非法",
                            "summary": "",
                            "steps": {
                                "nodes": [{"id": 1, "type": "req", "title": "需求"}],
                                "connections": [
                                    {"from": 99, "fromPort": 0, "to": 1, "toPort": 0}
                                ],
                            },
                        }
                    ],
                }
            ),
            [],
            None,
        )

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    accepted = module.submit_message(project.id, None, "设计一个流程", "idem-4")
    status = await _wait_turn(module, accepted.turn_id)
    assert status == "completed"


@pytest.mark.anyio
async def test_resolve_engine_models_falls_back_when_default_unavailable(gen_module, monkeypatch):
    import agent_assistants.workflow_gen as wfgen_service

    module, bus, manager, project, config_store = gen_module
    config_store.values["coordinator_default_engine"] = "pydantic_ai"
    config_store.values["coordinator_default_model"] = "gpt-x"
    config_store.values["coordinator_default_fast_model"] = "gpt-fast"
    config_store.values["engine_default_models"] = {"hermes": "hermes-default"}

    def fake_create(engine_id):
        if engine_id == "pydantic_ai":
            return None  # 默认引擎未配置/不可用
        return FakeEngine()

    monkeypatch.setattr(wfgen_service, "create_engine", fake_create)

    engine_id, model, fast_model = module._resolve_engine_models()
    # 回退到第一个可用的协调引擎，且不沿用原引擎的协调模型
    assert engine_id == "hermes"
    assert model == "hermes-default"
    assert fast_model == "hermes-default"

    # 没有任何可用引擎时仍给出明确错误
    monkeypatch.setattr(
        wfgen_service,
        "create_engine",
        lambda engine_id: None,
    )
    with pytest.raises(ValueError, match="Coordinator engine is unavailable"):
        module._resolve_engine_models()


@pytest.mark.anyio
async def test_resolve_engine_models_keeps_builtin_with_provider(gen_module, monkeypatch):
    """显式选择 Pydantic AI 并配置供应商后，不参与协调引擎回退。"""
    import agent_assistants.workflow_gen as wfgen_service
    from types import SimpleNamespace

    module, bus, manager, project, config_store = gen_module
    config_store.values["coordinator_default_engine"] = "pydantic_ai"
    config_store.values["engine_default_models"] = {
        "hermes": "hermes-default",
        "pydantic_ai": "pai-default",
    }
    config_store.values["assistant_defaults"] = {
        "workflow_gen": {"provider_id": "p-b"}
    }

    class UnconfiguredBuiltin:
        # 全局未配置：supports_coordinator 为 False，但供应商动态配置仍应生效
        capabilities = SimpleNamespace(supports_coordinator=False)
        supports_resume = False

    def fake_create(engine_id):
        if engine_id == "pydantic_ai":
            return UnconfiguredBuiltin()
        return FakeEngine()

    monkeypatch.setattr(wfgen_service, "create_engine", fake_create)
    engine_id, model, fast_model = module._resolve_engine_models()
    assert engine_id == "pydantic_ai"
    assert model == "pai-default"
    assert fast_model == "pai-default"


@pytest.mark.anyio
async def test_history_survives_unavailable_coordinator_engine(gen_module, monkeypatch):
    import agent_assistants.workflow_gen as wfgen_service

    module, bus, manager, project, config_store = gen_module
    config_store.values["coordinator_default_engine"] = "pydantic_ai"
    config_store.values["engine_default_models"] = {"hermes": "hermes-default"}

    # 默认引擎不可用，但有可用的回退引擎：历史正常返回，并带上回退引擎信息
    def fake_create(engine_id):
        if engine_id == "pydantic_ai":
            return None
        return FakeEngine()

    monkeypatch.setattr(wfgen_service, "create_engine", fake_create)
    history = module.history(project.id, "wf-x")
    assert history["session_id"] == f"wf:{project.id}:wf-x"
    assert history["engine"] == "hermes"
    assert history["model"] == "hermes-default"
    assert history["messages"] == []

    # 任何引擎都不可用时：只读历史仍然不抛错，返回空会话
    monkeypatch.setattr(
        wfgen_service,
        "create_engine",
        lambda engine_id: None,
    )
    empty = module.history(project.id, "wf-x")
    assert empty["session_id"] == f"wf:{project.id}:wf-x"
    assert empty["messages"] == []


async def test_resolve_engine_models_uses_coordinator_defaults(gen_module, monkeypatch):
    import agent_assistants.workflow_gen as wfgen_service

    module, bus, manager, project, config_store = gen_module
    monkeypatch.setattr(
        wfgen_service,
        "create_engine",
        lambda engine_id: None if engine_id in ("claude", "codex") else FakeEngine(),
    )

    config_store.values["coordinator_default_engine"] = "pydantic_ai"
    config_store.values["coordinator_default_model"] = "gpt-x"
    config_store.values["coordinator_default_fast_model"] = "gpt-fast"
    engine_id, model, fast_model = module._resolve_engine_models()
    assert (engine_id, model, fast_model) == ("pydantic_ai", "gpt-x", "gpt-fast")

    config_store.values.clear()
    engine_id, model, fast_model = module._resolve_engine_models()
    assert engine_id == "hermes"
    assert model is None


@pytest.mark.anyio
async def test_chat_http_contract(tmp_path, monkeypatch):
    import main
    import services.project as project_service
    import agent_assistants.workflow_gen as wfgen_service
    from httpx import ASGITransport, AsyncClient
    from services.project import ProjectManager

    manager = ProjectManager()
    store = MemoryConfigStore()
    monkeypatch.setattr(project_service, "config_store", store)
    monkeypatch.setattr(wfgen_service, "config_store", store)
    monkeypatch.setattr(main, "project_manager", manager)

    bus = EventBus()
    module = WorkflowGenModule(bus, manager)

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None):
        return json.dumps({"reply": "ok", "flow_proposals": []}), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    monkeypatch.setattr(main, "workflow_gen_module", module)

    project = manager.init_project(tmp_path / "http-proj")
    transport = ASGITransport(app=main.app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                "/api/workflow/generate/chat",
                json={
                    "project_id": project.id,
                    "content": "设计一个流程",
                    "thinking_effort": "high",
                },
                headers={"Idempotency-Key": "idem-http"},
            )
            assert resp.status_code == 200
            body = resp.json()
            assert body["session_id"]
            assert body["turn_id"]
            assert body["status"] == "queued"
            assert module._turn_states[body["turn_id"]]["thinking_effort"] == "high"

            empty = await client.post(
                "/api/workflow/generate/chat",
                json={"project_id": project.id, "content": "   "},
                headers={"Idempotency-Key": "idem-empty"},
            )
            assert empty.status_code == 400
    finally:
        await module.shutdown()
        await bus.close()
        manager.close_all()


@pytest.mark.anyio
async def test_stop_http_contract_decodes_workflow_session_id(monkeypatch):
    import main
    from httpx import ASGITransport, AsyncClient

    received: list[str] = []

    class StubWorkflowGen:
        async def stop_current(self, session_id):
            received.append(session_id)
            return True

    monkeypatch.setattr(main, "workflow_gen_module", StubWorkflowGen())
    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/workflow/generate/wf%3A383b11e6%3Af0e8bc06/stop"
        )

    assert response.status_code == 200
    assert response.json() == {"stopped": True}
    assert received == ["wf:383b11e6:f0e8bc06"]


@pytest.mark.anyio
async def test_all_invalid_proposals_repaired_by_fast_model(gen_module, monkeypatch):
    module, bus, manager, project, _ = gen_module
    queue = bus.subscribe()
    collected: list[dict] = []
    stop = asyncio.Event()

    async def collector():
        while not stop.is_set():
            try:
                event = await asyncio.wait_for(queue.get(), timeout=0.05)
            except asyncio.TimeoutError:
                continue
            collected.append(event)

    collector_task = asyncio.create_task(collector())
    invalid = {
        "reply": "两个方案都有问题",
        "flow_proposals": [
            {
                "title": "A",
                "summary": "",
                "steps": {
                    "nodes": [{"id": 1, "type": "req", "title": "需求"}],
                    "connections": [{"from": 99, "fromPort": 0, "to": 1, "toPort": 0}],
                },
            },
            {
                "title": "B",
                "summary": "",
                "steps": {
                    "nodes": [
                        {"id": 1, "type": "req", "title": "需求"},
                        {"id": 2, "type": "req", "title": "需求2"},
                    ],
                    "connections": [],
                },
            },
        ],
    }
    fixed = {
        "reply": "修复后的方案",
        "flow_proposals": [
            {
                "title": "A",
                "summary": "",
                "steps": {
                    "nodes": [{"id": 1, "type": "req", "title": "需求"}],
                    "connections": [],
                },
            }
        ],
    }
    calls = {"count": 0}

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None):
        calls["count"] += 1
        return (json.dumps(fixed if calls["count"] > 1 else invalid), [], None)

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    accepted = module.submit_message(project.id, None, "设计一个流程", "idem-6")
    status = await _wait_turn(module, accepted.turn_id)
    assert status == "completed"

    stop.set()
    await asyncio.wait_for(collector_task, timeout=2)
    proposal_events = [
        e for e in collected
        if e["type"] == "CUSTOM" and e["name"] == "workstep.flow_proposals"
    ]
    assert proposal_events, "expected a flow_proposals event after repair"
    cards = proposal_events[0]["value"]["proposals"]
    assert [card["title"] for card in cards] == ["A"]
    rejected = [
        e for e in collected
        if e["type"] == "CUSTOM" and e["name"] == "workstep.flow_proposals_rejected"
    ]
    assert not rejected


@pytest.mark.anyio
async def test_unrepairable_multi_proposals_emit_rejected_event(gen_module, monkeypatch):
    module, bus, manager, project, _ = gen_module
    queue = bus.subscribe()
    collected: list[dict] = []
    stop = asyncio.Event()

    async def collector():
        while not stop.is_set():
            try:
                event = await asyncio.wait_for(queue.get(), timeout=0.05)
            except asyncio.TimeoutError:
                continue
            collected.append(event)

    collector_task = asyncio.create_task(collector())
    invalid = {
        "reply": "两个方案都有问题",
        "flow_proposals": [
            {
                "title": "A",
                "summary": "",
                "steps": {
                    "nodes": [{"id": 1, "type": "req", "title": "需求"}],
                    "connections": [{"from": 99, "fromPort": 0, "to": 1, "toPort": 0}],
                },
            },
            {
                "title": "B",
                "summary": "",
                "steps": {
                    "nodes": [
                        {"id": 1, "type": "req", "title": "需求"},
                        {"id": 2, "type": "req", "title": "需求2"},
                    ],
                    "connections": [],
                },
            },
        ],
    }

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None):
        return json.dumps(invalid), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    accepted = module.submit_message(project.id, None, "设计一个流程", "idem-7")
    status = await _wait_turn(module, accepted.turn_id)
    assert status == "completed"

    stop.set()
    await asyncio.wait_for(collector_task, timeout=2)
    proposal_events = [
        e for e in collected
        if e["type"] == "CUSTOM" and e["name"] == "workstep.flow_proposals"
    ]
    assert not proposal_events
    rejected = [
        e for e in collected
        if e["type"] == "CUSTOM" and e["name"] == "workstep.flow_proposals_rejected"
    ]
    assert rejected, "expected a flow_proposals_rejected event"
    assert "校验" in rejected[0]["value"]["message"]


@pytest.mark.anyio
async def test_engine_model_overrides_are_session_scoped(gen_module, monkeypatch):
    """engine/model/fast_model overrides apply to the generation session
    (not persisted to global coordinator config) and bad engines are rejected."""
    import agent_assistants.workflow_gen as wfgen_service

    module, bus, manager, project, config_store = gen_module
    config_store.values["coordinator_default_engine"] = "hermes"
    config_store.values["coordinator_default_model"] = "hermes-slow"
    config_store.values["coordinator_default_fast_model"] = "hermes-fast"

    seen: list[tuple] = []

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None):
        seen.append((engine_id, model, session_id))
        return json.dumps({"reply": "ok", "flow_proposals": []}), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    accepted = module.submit_message(
        project.id,
        None,
        "设计一个流程",
        "idem-override",
        engine="hermes",
        model="gpt-5",
        fast_model="gpt-5-mini",
    )
    assert accepted.status == "queued"
    status = await _wait_turn(module, accepted.turn_id)
    assert status == "completed"
    assert seen, "expected _invoke to be called"
    engine_id, model, _sid = seen[0]
    assert engine_id == "hermes"
    assert model == "gpt-5"
    session = module._sessions[(project.id, accepted.session_id)]
    assert session.engine == "hermes"
    assert session.model == "gpt-5"
    assert session.fast_model == "gpt-5-mini"

    # Overrides are not persisted to the global config store.
    assert config_store.values.get("coordinator_default_engine") == "hermes"
    assert config_store.values.get("coordinator_default_model") == "hermes-slow"

    # Follow-up turn without overrides falls back to the defaults.
    seen.clear()
    follow = module.submit_message(
        project.id, accepted.session_id, "继续", "idem-override-2"
    )
    status = await _wait_turn(module, follow.turn_id)
    assert status == "completed"
    assert seen
    assert seen[0][0] == "hermes"
    assert seen[0][1] == "hermes-slow"
    assert session.engine == "hermes"
    assert session.model == "hermes-slow"

    # Unsupported engine raises ValueError (surfaced as 400 by the API route).
    monkeypatch.setattr(
        wfgen_service,
        "create_engine",
        lambda engine_id: FakeEngine() if engine_id == "hermes" else None,
    )
    with pytest.raises(ValueError):
        module.submit_message(
            project.id,
            None,
            "设计一个流程",
            "idem-override-3",
            engine="unknown-engine",
        )


@pytest.mark.anyio
async def test_session_cwd_is_project_directory(gen_module, monkeypatch):
    """The generation agent always runs in the corresponding project's directory."""
    module, bus, manager, project, _ = gen_module
    seen: list[tuple[str, str]] = []  # (cwd, prompt)

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None):
        seen.append((cwd, prompt))
        return json.dumps({"reply": "好的", "flow_proposals": []}), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    accepted = module.submit_message(project.id, None, "设计一个发布流程", "idem-cwd-1")
    status = await _wait_turn(module, accepted.turn_id)
    assert status == "completed"

    session = module._sessions[(project.id, accepted.session_id)]
    assert session.cwd == str(project.path)

    assert seen, "expected _invoke to be called"
    cwd, prompt = seen[0]
    assert cwd == str(project.path)
    # The working directory is passed to the engine via `cwd`, not the prompt.
    assert "当前工作目录" not in prompt
    assert str(project.path) not in prompt

    # Follow-up turns keep using the project directory.
    seen.clear()
    follow = module.submit_message(project.id, accepted.session_id, "继续", "idem-cwd-2")
    status = await _wait_turn(module, follow.turn_id)
    assert status == "completed"
    assert seen, "expected a follow-up _invoke call"
    assert seen[0][0] == str(project.path)


@pytest.mark.anyio
async def test_sessions_use_their_own_project_directory(gen_module, monkeypatch):
    """Each project's session resolves to its own directory, not a shared one."""
    module, bus, manager, project, _ = gen_module
    other = manager.init_project(project.path.parent / "other-proj")
    seen: list[tuple[str, str]] = []

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None):
        seen.append((cwd, prompt))
        return json.dumps({"reply": "好的", "flow_proposals": []}), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    first = module.submit_message(project.id, None, "设计一个流程", "idem-cwd-a")
    await _wait_turn(module, first.turn_id)
    second = module.submit_message(other.id, None, "设计另一个流程", "idem-cwd-b")
    await _wait_turn(module, second.turn_id)

    assert seen[0][0] == str(project.path)
    assert seen[1][0] == str(other.path)
    assert module._sessions[(project.id, first.session_id)].cwd == str(project.path)
    assert module._sessions[(other.id, second.session_id)].cwd == str(other.path)


@pytest.mark.anyio
async def test_current_canvas_json_is_injected_into_prompt(gen_module, monkeypatch):
    """Editor context is injected initially and again only after changes."""
    module, bus, manager, project, _ = gen_module
    seen: list[tuple[str, str]] = []

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None):
        seen.append((cwd, prompt))
        return json.dumps({"reply": "好的", "flow_proposals": []}), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    steps = {
        "nodes": [{"id": 1, "type": "req", "title": "需求"}],
        "connections": [],
    }
    accepted = module.submit_message(
        project.id,
        None,
        "把测试阶段加上",
        "idem-steps-1",
        steps=steps,
        workflow_name="发布流程",
        context_mode="initial",
    )
    status = await _wait_turn(module, accepted.turn_id)
    assert status == "completed"

    assert seen, "expected _invoke to be called"
    _cwd, prompt = seen[0]
    assert "Current flow title: 发布流程" in prompt
    assert "Current canvas JSON" in prompt
    assert '"type": "req"' in prompt

    # Unchanged canvas → no repeated title or canvas section.
    seen.clear()
    follow = module.submit_message(
        project.id,
        accepted.session_id,
        "继续",
        "idem-steps-2",
        context_mode="none",
    )
    status = await _wait_turn(module, follow.turn_id)
    assert status == "completed"
    assert seen
    assert "Current canvas JSON" not in seen[0][1]
    assert "Current flow title" not in seen[0][1]

    # Changed live canvas → inject the new unsaved snapshot without the title.
    changed_steps = {"nodes": [], "connections": []}
    seen.clear()
    changed = module.submit_message(
        project.id,
        accepted.session_id,
        "画布刚刚改过",
        "idem-steps-3",
        steps=changed_steps,
        context_mode="canvas_updated",
    )
    assert await _wait_turn(module, changed.turn_id) == "completed"
    assert "Current canvas updated" in seen[0][1]
    assert "Current flow title" not in seen[0][1]

    session = module._sessions[(project.id, accepted.session_id)]
    assert session.steps == changed_steps


@pytest.mark.anyio
async def test_thinking_and_usage_events_are_streamed(gen_module, monkeypatch):
    """thinking_delta and usage from the engine reach the WS event bus."""
    module, bus, manager, project, _ = gen_module
    queue = bus.subscribe()
    collected: list[dict] = []
    stop = asyncio.Event()

    async def collector():
        while not stop.is_set():
            try:
                event = await asyncio.wait_for(queue.get(), timeout=0.05)
            except asyncio.TimeoutError:
                continue
            collected.append(event)

    collector_task = asyncio.create_task(collector())

    from engines.core.events import InternalEvent

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None):
        assert on_event is not None
        await on_event(
            InternalEvent(
                type="agent_thought_chunk",
                data={"content": {"text": "先分析用户需求"}},
                timestamp=time.time(),
            )
        )
        chunk = '"reply":"好的"'
        for char in chunk:
            await on_event(
                InternalEvent(
                    type="agent_message_chunk",
                    data={"content": {"text": char}},
                    timestamp=time.time(),
                )
            )
        await on_event(
            InternalEvent(
                type="usage_update",
                data={
                    "input_tokens": 100,
                    "output_tokens": 50,
                    "total_tokens": 150,
                    "session_id": "sess-x",
                },
                timestamp=time.time(),
            )
        )
        return json.dumps({"reply": "好的", "flow_proposals": []}), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    workflow_id = "wf-thinking-journal"
    accepted = module.submit_message(
        project.id,
        None,
        "设计一个流程",
        "idem-think-1",
        workflow_id=workflow_id,
    )
    status = await _wait_turn(module, accepted.turn_id)
    assert status == "completed"

    stop.set()
    await asyncio.wait_for(collector_task, timeout=2)

    thinking = [e for e in collected if e["type"] == "REASONING_MESSAGE_CHUNK"]
    usage = [
        e for e in collected
        if e["type"] == "CUSTOM" and e["name"] == "workstep.usage"
    ]
    assert thinking, "expected thinking_delta events on the bus"
    assert "".join(e["delta"] for e in thinking) == "先分析用户需求"
    assert usage, "expected usage events on the bus"
    assert usage[-1]["value"]["total_tokens"] == 150
    for event in (*thinking, *usage):
        assert event["session_id"] == accepted.session_id
        assert event["messageId"]
        assert "task_id" not in event

    from models.gen_session import WorkflowGenSession

    with manager.activate_project_by_id(project.id):
        row = WorkflowGenSession.get(
            WorkflowGenSession.workflow_id == workflow_id
        )
        assert "先分析用户需求" not in row.messages_json
    assistant = module.history(project.id, workflow_id)["messages"][-1]
    assert assistant["event_log_path"]
    records = [
        json.loads(line)
        for line in (project.workstep_dir / assistant["event_log_path"])
        .read_text()
        .splitlines()
    ]
    assert "agent_thought_chunk" in {record["type"] for record in records}


@pytest.mark.anyio
async def test_workflow_scoped_session_is_stable_and_persisted(
    gen_module, monkeypatch
):
    """Editing the same workflow always resumes the same conversation."""
    module, bus, manager, project, _ = gen_module
    seen: list[tuple[str, str]] = []

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None):
        seen.append((cwd, prompt))
        return json.dumps({"reply": "ok", "flow_proposals": []}), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    workflow_id = "wf-stable"
    first = module.submit_message(
        project.id, None, "帮我设计发布流程", "idem-wf-1", workflow_id=workflow_id
    )
    assert first.session_id == f"wf:{project.id}:{workflow_id}"
    assert await _wait_turn(module, first.turn_id) == "completed"

    second = module.submit_message(
        project.id,
        first.session_id,
        "加一个审核阶段",
        "idem-wf-2",
        workflow_id=workflow_id,
    )
    assert second.session_id == first.session_id
    assert await _wait_turn(module, second.turn_id) == "completed"

    # The second prompt carries the first exchange (history kept in memory).
    assert "帮我设计发布流程" in seen[1][1]

    # History is persisted and exposed through the history endpoint shape.
    history = module.history(project.id, workflow_id)
    assert history["session_id"] == f"wf:{project.id}:{workflow_id}"
    assert [item["role"] for item in history["messages"]] == [
        "user",
        "assistant",
        "user",
        "assistant",
    ]


@pytest.mark.anyio
async def test_reset_workflow_session_clears_memory_and_persistence(
    gen_module, monkeypatch
):
    module, bus, manager, project, _ = gen_module
    seen_prompts: list[str] = []

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None):
        seen_prompts.append(prompt)
        return json.dumps({"reply": "ok", "flow_proposals": []}), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    workflow_id = "wf-reset"
    first = module.submit_message(
        project.id, None, "旧会话内容", "idem-reset-1", workflow_id=workflow_id
    )
    assert await _wait_turn(module, first.turn_id) == "completed"

    assert module.reset_session(project.id, workflow_id) is True
    assert module.history(project.id, workflow_id)["messages"] == []

    from models.gen_session import WorkflowGenSession

    with manager.activate_project_by_id(project.id):
        assert WorkflowGenSession.select().where(
            WorkflowGenSession.workflow_id == workflow_id
        ).count() == 0

    second = module.submit_message(
        project.id, first.session_id, "新会话内容", "idem-reset-2", workflow_id=workflow_id
    )
    assert await _wait_turn(module, second.turn_id) == "completed"
    assert "旧会话内容" not in seen_prompts[-1]
    assert "新会话内容" in seen_prompts[-1]


@pytest.mark.anyio
async def test_resumed_workflow_prompt_view_shows_only_this_call(
    gen_module, monkeypatch
):
    """正文降级续轮没有新系统注入，查看中也不补造旧指令。"""
    import agent_assistants.workflow_gen as wfgen_service

    module, _bus, _manager, project, _ = gen_module
    sent_prompts: list[str] = []

    class ResumeEngine(FakeEngine):
        supports_resume = True

    monkeypatch.setattr(wfgen_service, "create_engine", lambda _engine_id: ResumeEngine())

    async def fake_invoke(
        engine_id, model, cwd, prompt, session_id, on_event=None,
        message_history=None, system_prompt=None,
    ):
        sent_prompts.append(prompt)
        data = {"prompt": (system_prompt + "\n\n" + prompt) if not session_id else prompt, "instruction_transport":"body", "system_prompt_in_body":not session_id}
        from engines.core.events import InternalEvent
        await on_event(InternalEvent("prompt_input", data))
        return json.dumps({"reply": "ok", "flow_proposals": []}), [], "engine-session"

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    first = module.submit_message(
        project.id, None, "设计发布流程", "display-system-1", workflow_id="wf-display"
    )
    assert await _wait_turn(module, first.turn_id) == "completed"
    second = module.submit_message(
        project.id,
        first.session_id,
        "补充审核阶段",
        "display-system-2",
        workflow_id="wf-display",
    )
    assert await _wait_turn(module, second.turn_id) == "completed"

    assert SYSTEM_PROMPT not in sent_prompts[1]
    visible_prompt = module.history(project.id, "wf-display")["messages"][-1]["prompt"]
    assert SYSTEM_PROMPT not in visible_prompt
    assert "补充审核阶段" in visible_prompt


@pytest.mark.anyio
async def test_different_workflows_have_independent_sessions(
    gen_module, monkeypatch
):
    module, bus, manager, project, _ = gen_module

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None):
        return json.dumps({"reply": "ok", "flow_proposals": []}), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    first = module.submit_message(
        project.id, None, "设计 A", "idem-wf-a", workflow_id="wf-a"
    )
    second = module.submit_message(
        project.id, None, "设计 B", "idem-wf-b", workflow_id="wf-b"
    )
    await _wait_turn(module, first.turn_id)
    await _wait_turn(module, second.turn_id)

    assert first.session_id != second.session_id
    history_a = module.history(project.id, "wf-a")
    history_b = module.history(project.id, "wf-b")
    assert [m["content"] for m in history_a["messages"] if m["role"] == "user"] == ["设计 A"]
    assert [m["content"] for m in history_b["messages"] if m["role"] == "user"] == ["设计 B"]


@pytest.mark.anyio
async def test_ephemeral_chat_never_writes_gen_sessions(gen_module, monkeypatch):
    """Create-mode chats (no workflow) stay memory-only."""
    module, bus, manager, project, _ = gen_module

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None):
        return json.dumps({"reply": "ok", "flow_proposals": []}), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    accepted = module.submit_message(project.id, None, "随便聊聊", "idem-eph-1")
    await _wait_turn(module, accepted.turn_id)

    from models.gen_session import WorkflowGenSession

    with manager.activate_project_by_id(project.id):
        assert WorkflowGenSession.select().count() == 0


@pytest.mark.anyio
async def test_workflow_session_history_survives_module_restart(
    gen_module, monkeypatch
):
    """Reconstructing the module (daemon restart) resumes the same workflow chat."""
    module, bus, manager, project, _ = gen_module
    seen: list[tuple[str, str]] = []

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None):
        seen.append((cwd, prompt))
        return json.dumps({"reply": "ok", "flow_proposals": []}), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    workflow_id = "wf-restart"
    first = module.submit_message(
        project.id, None, "设计一个流程", "idem-wf-r1", workflow_id=workflow_id
    )
    await _wait_turn(module, first.turn_id)
    await module.shutdown()

    bus2 = EventBus()
    restarted = WorkflowGenModule(bus2, manager)
    monkeypatch.setattr(restarted, "_invoke", fake_invoke)
    try:
        history = restarted.history(project.id, workflow_id)
        assert [
            m["content"] for m in history["messages"] if m["role"] == "user"
        ] == ["设计一个流程"]
        assistant_messages = [
            m for m in history["messages"] if m["role"] == "assistant"
        ]
        assert assistant_messages
        assert all(m["ended_at"] for m in assistant_messages)
        assert all(m["created_at"] <= m["ended_at"] for m in assistant_messages)

        follow = restarted.submit_message(
            project.id,
            first.session_id,
            "继续",
            "idem-wf-r2",
            workflow_id=workflow_id,
        )
        assert follow.session_id == first.session_id
        assert await _wait_turn(restarted, follow.turn_id) == "completed"
        # The restored history is injected into the new turn's prompt.
        assert "设计一个流程" in seen[-1][1]
    finally:
        await restarted.shutdown()
        await bus2.close()


def test_history_repairs_legacy_message_without_ended_at():
    """旧数据回补：成功回合无 ended_at、created_at 为完成时刻时，历史接口补全起止时间。"""
    from agent_assistants.base import default_history_message

    legacy = default_history_message({
        "role": "assistant",
        "content": "ok",
        "created_at": "2026-08-12T09:16:25.231045+00:00",
        "events": [
            {"type": "session_started", "data": {}, "timestamp": 1786526183803},
            {"type": "usage", "data": {}, "timestamp": 1786526185230},
        ],
    })
    assert legacy["ended_at"] == "2026-08-12T09:16:25.231045+00:00"
    assert legacy["created_at"] == "2026-08-12T09:16:23.803000+00:00"
    assert legacy["ended_at"] > legacy["created_at"]

    # 新数据（已有 ended_at）原样保留。
    fresh = default_history_message({
        "role": "assistant",
        "content": "ok",
        "created_at": "2026-08-12T09:16:23.803000+00:00",
        "ended_at": "2026-08-12T09:16:25.231045+00:00",
        "events": [{"type": "status", "data": {}, "timestamp": 1786526183803}],
    })
    assert fresh["created_at"] == "2026-08-12T09:16:23.803000+00:00"
    assert fresh["ended_at"] == "2026-08-12T09:16:25.231045+00:00"


@pytest.mark.anyio
async def test_workflow_history_persists_prompt_events_and_session_id(
    gen_module, monkeypatch
):
    """Captured actual inputs, events and engine session id survive restart."""
    module, bus, manager, project, _ = gen_module

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None):
        events = [{"type":"prompt_input", "data":{"prompt":prompt, "system_prompt":system_prompt, "instruction_transport":"system"}},
            {
                "type": "session_started",
                "data": {"session_id": "engine-sid-123"},
                "timestamp": 1000,
            },
            {
                "type": "status",
                "data": {"status": "running"},
                "timestamp": 1001,
            },
            {
                "type": "agent_message_chunk",
                "data": {"content": {"text": "partial"}},
                "timestamp": 1002,
            },
            {
                "type": "usage_update",
                "data": {
                    "input_tokens": 10,
                    "output_tokens": 5,
                    "total_tokens": 15,
                    "session_id": "engine-sid-123",
                },
                "timestamp": 1003,
            },
            {
                "type": "engine_state",
                "data": {"state": [{"role": "user", "content": "hi"}]},
                "timestamp": 1004,
            },
        ]
        return (
            json.dumps({"reply": "ok", "flow_proposals": []}),
            events,
            "engine-sid-123",
        )

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    workflow_id = "wf-events"
    accepted = module.submit_message(
        project.id, None, "设计一个流程", "idem-evt-1", workflow_id=workflow_id
    )
    await _wait_turn(module, accepted.turn_id)

    history = module.history(project.id, workflow_id)
    assert history["session_id"] == f"wf:{project.id}:{workflow_id}"
    assert history["engine_session_id"] == "engine-sid-123"
    assistants = [m for m in history["messages"] if m["role"] == "assistant"]
    assert len(assistants) == 1
    msg = assistants[0]
    assert msg["prompt"] and "设计一个流程" in msg["prompt"]
    event_types = [e["type"] for e in msg["events"]]
    # agent_message_chunk is not persisted (content is already in the message).
    assert "agent_message_chunk" not in event_types
    assert set(event_types) == {"session_started", "usage_update"}
    records = [
        json.loads(line)
        for line in (project.workstep_dir / msg["event_log_path"])
        .read_text()
        .splitlines()
    ]
    assert {record["type"] for record in records} >= {
        "session_started",
        "status",
        "agent_message_chunk",
        "usage_update",
        "engine_state",
    }
    usage = next(e for e in msg["events"] if e["type"] == "usage_update")
    assert usage["data"]["input_tokens"] == 10
    assert usage["data"]["session_id"] == "engine-sid-123"
    assert msg["events"][0]["timestamp"] == 1000

    from models import WorkflowGenSession
    with manager.activate_project_by_id(project.id):
        stored = json.loads(WorkflowGenSession.get().messages_json)
        assert stored[-1]["prompt"] == msg["prompt"]
    assert "prompt_input" not in {record["type"] for record in records}
    # Captured inputs survive a module restart through the existing JSON field.
    await module.shutdown()
    bus2 = EventBus()
    restarted = WorkflowGenModule(bus2, manager)
    monkeypatch.setattr(restarted, "_invoke", fake_invoke)
    try:
        again = restarted.history(project.id, workflow_id)
        assert again["engine_session_id"] == "engine-sid-123"
        restored = [m for m in again["messages"] if m["role"] == "assistant"][0]
        assert restored["prompt"] == msg["prompt"]
        assert [e["type"] for e in restored["events"]] == event_types
        assert restored["events"] == msg["events"]
    finally:
        await restarted.shutdown()
        await bus2.close()


@pytest.mark.anyio
async def test_history_is_fresh_when_turn_completes_under_slow_save(
    gen_module, monkeypatch
):
    """终态可见前必须先落库：慢数据库下 completed 后立即读历史不得读到旧快照。

    回归：save 曾放在 finally 里（status=completed 之后执行），慢盘/锁竞争
    下客户端会在 message_completed 之后读到缺 engine_session_id 的旧行。
    """
    import time

    import agent_assistants.base as assistant_base

    module, bus, manager, project, _ = gen_module

    orig_save = assistant_base.JsonRowPersistence.save

    def slow_save(self, session):
        time.sleep(0.2)  # 模拟 DB 工作线程繁忙（锁竞争/慢盘）
        orig_save(self, session)

    monkeypatch.setattr(assistant_base.JsonRowPersistence, "save", slow_save)

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None):
        events = [
            {
                "type": "session_started",
                "data": {"session_id": "engine-sid-slow"},
                "timestamp": 1000,
            },
        ]
        return (
            json.dumps({"reply": "ok", "flow_proposals": []}),
            events,
            "engine-sid-slow",
        )

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    workflow_id = "wf-slow-save"
    accepted = module.submit_message(
        project.id, None, "设计一个流程", "idem-slow-1", workflow_id=workflow_id
    )
    assert await _wait_turn(module, accepted.turn_id) == "completed"

    # completed 对外可见时，最终快照必须已落库。
    history = module.history(project.id, workflow_id)
    assert history["engine_session_id"] == "engine-sid-slow"
    assistants = [m for m in history["messages"] if m["role"] == "assistant"]
    assert len(assistants) == 1
    assert assistants[0]["status"] == "succeeded"
    assert assistants[0]["content"] == "ok"
    assert assistants[0]["events"] and assistants[0]["events"][0]["type"] == "session_started"


@pytest.mark.anyio
async def test_workflow_history_persists_error_message_prompt(
    gen_module, monkeypatch
):
    """A failure before dispatch must not fabricate an actual input record."""
    module, bus, manager, project, _ = gen_module

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None):
        raise RuntimeError("boom")

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    workflow_id = "wf-error"
    accepted = module.submit_message(
        project.id, None, "设计一个流程", "idem-err-1", workflow_id=workflow_id
    )
    assert await _wait_turn(module, accepted.turn_id) == "error"

    history = module.history(project.id, workflow_id)
    assistants = [m for m in history["messages"] if m["role"] == "assistant"]
    assert len(assistants) == 1
    assert assistants[0]["status"] == "error"
    assert not assistants[0]["prompt"]
    assert [event["type"] for event in assistants[0]["events"]] == ["error"]


@pytest.mark.anyio
async def test_proposals_reply_gets_a2ui_choice_ui(gen_module, monkeypatch):
    """Plan replies always carry an a2ui button list for user selection."""
    module, bus, manager, project, _ = gen_module
    queue = bus.subscribe()
    collected: list[dict] = []
    stop = asyncio.Event()

    async def collector():
        while not stop.is_set():
            try:
                event = await asyncio.wait_for(queue.get(), timeout=0.05)
            except asyncio.TimeoutError:
                continue
            collected.append(event)

    collector_task = asyncio.create_task(collector())

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None):
        return json.dumps({
            "reply": "我准备了两个方案，请选择",
            "flow_proposals": [
                {
                    "title": "简洁版",
                    "summary": "最少阶段",
                    "steps": {"nodes": [{"id": 1, "type": "req", "title": "需求"}], "connections": []},
                },
                {
                    "title": "完整版",
                    "summary": "含审核",
                    "steps": {
                        "nodes": [
                            {"id": 1, "type": "req", "title": "需求"},
                            {"id": 2, "type": "review", "title": "审核"},
                        ],
                        "connections": [],
                    },
                },
            ],
        }), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    accepted = module.submit_message(project.id, None, "设计一个流程", "idem-a2ui-1")
    status = await _wait_turn(module, accepted.turn_id)
    assert status == "completed"

    snapshot = next(
        (e for e in collected if e.get("type") == "TEXT_MESSAGE_CONTENT"),
        None,
    )
    assert snapshot is not None
    assert "```a2ui" not in snapshot["content"]
    assert snapshot["content"] == "我准备了两个方案，请选择"

    a2ui_events = [
        e for e in collected
        if e["type"] == "CUSTOM" and e["name"] == "a2ui.surface"
    ]
    assert len(a2ui_events) == 2
    create = next(e["value"] for e in a2ui_events if "createSurface" in e["value"])
    update = next(e["value"] for e in a2ui_events if "updateComponents" in e["value"])
    assert create["createSurface"]["surfaceId"] == "flow-choice"
    buttons = [
        component
        for component in update["updateComponents"]["components"]
        if component.get("component") == "Button"
    ]
    assert len(buttons) == 2
    assert json.loads(
        buttons[0]["action"]["event"]["context"]["stepsJson"]
    )["nodes"][0]["title"] == "需求"
    # The structured flow_proposals event is still emitted for the canvas.
    proposals_event = next(
        (e for e in collected
         if e["type"] == "CUSTOM" and e["name"] == "workstep.flow_proposals"),
        None,
    )
    assert proposals_event is not None
    assert len(proposals_event["value"]["proposals"]) == 2

    stop.set()
    await collector_task


@pytest.mark.anyio
async def test_a2ui_fence_not_duplicated_and_skipped_without_proposals(
    gen_module, monkeypatch
):
    module, bus, manager, project, _ = gen_module

    session = SimpleNamespace(
        engine="claude",
        fast_model="claude-fast",
        cwd=str(project.path),
    )
    existing = (
        "好的\n\n```a2ui\n"
        '{"version":"v0.9.1","createSurface":{"surfaceId":"s","catalogId":"basic"}}\n'
        '{"version":"v0.9.1","updateComponents":{"surfaceId":"s","components":['
        '{"component":"Text","id":"label","text":"简洁版"},'
        '{"component":"Button","id":"apply","child":"label","action":{"event":{'
        '"name":"apply_flow","context":{"proposal":1}}}}]}}\n'
        "```\n"
    )
    reply, proposals, events = await module._resolve_proposal(
        session,
        json.dumps({
            "reply": existing,
            "flow_proposals": [
                {
                    "title": "A",
                    "steps": {"nodes": [{"id": 1, "type": "req", "title": "需求"}], "connections": []},
                }
            ],
        }),
    )
    assert reply.count("```a2ui") == 1
    assert len(proposals) == 1
    assert events == []
    update_line = next(
        line for line in reply.splitlines() if '"updateComponents"' in line
    )
    update = json.loads(update_line)
    button = next(
        component
        for component in update["updateComponents"]["components"]
        if component.get("component") == "Button"
    )
    assert json.loads(
        button["action"]["event"]["context"]["stepsJson"]
    )["nodes"][0]["title"] == "需求"

    # Clarification replies (no proposals) stay untouched.
    reply, proposals, events = await module._resolve_proposal(
        session,
        json.dumps({"reply": "还需要澄清一下", "flow_proposals": []}),
    )
    assert "```a2ui" not in reply
    assert proposals == []


@pytest.mark.anyio
async def test_canvas_json_in_reply_becomes_hidden_auto_apply_proposal(
    gen_module,
):
    module, bus, manager, project, _ = gen_module
    session = SimpleNamespace(
        engine="claude",
        fast_model="claude-fast",
        cwd=str(project.path),
    )
    canvas = {
        "nodes": [{"id": 1, "type": "req", "title": "需求"}],
        "connections": [],
    }
    reply, proposals, events = await module._resolve_proposal(
        session,
        json.dumps({
            "reply": (
                "已完成调整。\n\n当前完整画布 JSON 如下：\n\n"
                f"```json\n{json.dumps(canvas, ensure_ascii=False)}\n```\n"
            ),
            "flow_proposals": [],
        }),
    )

    assert "```json" not in reply
    assert "完整画布 JSON" not in reply
    assert proposals == [{
        "title": "更新后的流程",
        "summary": "AI 已根据当前对话更新画布",
        "steps": canvas,
        "autoApply": True,
    }]
    assert [event["type"] for event in events] == ["a2ui", "a2ui"]
    assert all("updateComponents" in event["data"] or "createSurface" in event["data"]
               for event in events)


@pytest.mark.anyio
async def test_partial_canvas_json_fence_preserves_untouched_steps(gen_module):
    module, _bus, _manager, project, _ = gen_module
    base = {
        "nodes": [
            {"id": 1, "type": "req", "title": "需求"},
            {"id": 2, "type": "dev", "title": "开发"},
        ],
        "connections": [{"from": 1, "to": 2}],
    }
    session = SimpleNamespace(
        engine="claude",
        fast_model="claude-fast",
        cwd=str(project.path),
        steps=base,
    )
    partial = {"nodes": [{"id": 2, "type": "dev", "title": "开发 v2"}]}
    _reply, proposals, _events = await module._resolve_proposal(
        session,
        json.dumps({
            "reply": f"已调整。\n```json\n{json.dumps(partial)}\n```",
            "flow_proposals": [],
        }),
    )

    assert [node["id"] for node in proposals[0]["steps"]["nodes"]] == [1, 2]
    assert proposals[0]["steps"]["nodes"][1]["title"] == "开发 v2"
    assert proposals[0]["stepChanges"][0]["id"] == 2


class ResumeFakeEngine:
    capabilities = SimpleNamespace(supports_coordinator=True)
    supports_resume = True


@pytest.mark.anyio
async def test_build_prompt_omits_history_for_resume_engines(gen_module, monkeypatch):
    """Resume-capable engines keep context engine-side: no spliced history."""
    import agent_assistants.workflow_gen as wfgen_service

    module, bus, manager, project, _ = gen_module
    seen: list[str] = []

    async def fake_invoke(
        engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None
    ):
        seen.append(prompt)
        return json.dumps({"reply": "好的", "flow_proposals": []}), [], "engine-sid-1"

    monkeypatch.setattr(
        wfgen_service, "create_engine", lambda engine_id: ResumeFakeEngine()
    )
    monkeypatch.setattr(module, "_invoke", fake_invoke)

    first = module.submit_message(
        project.id,
        None,
        "帮我设计发布流程",
        "idem-resume-1",
        workflow_id="wf-resume",
    )
    assert await _wait_turn(module, first.turn_id) == "completed"
    assert "Conversation history" not in seen[0]
    assert "帮我设计发布流程" in seen[0]
    assert "WorkStep workflow design assistant" not in seen[0]

    follow = module.submit_message(
        project.id,
        first.session_id,
        "去掉测试阶段",
        "idem-resume-2",
        workflow_id="wf-resume",
    )
    assert await _wait_turn(module, follow.turn_id) == "completed"
    # 续轮：历史与系统提示都不再拼入，只发当前画布与用户消息。
    assert "Conversation history" not in seen[1]
    assert "帮我设计发布流程" not in seen[1]
    assert "去掉测试阶段" in seen[1]
    assert "WorkStep workflow design assistant" not in seen[1]


@pytest.mark.anyio
async def test_engine_state_flows_through_session_and_survives_restart(
    gen_module, monkeypatch
):
    """Pydantic AI 风格引擎状态作为 message_history 传递并跨重启持久化。"""
    module, bus, manager, project, _ = gen_module
    seen: list[tuple[object, str]] = []

    async def fake_invoke(
        engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None, system_prompt=None
    ):
        seen.append((message_history, prompt))
        return (
            json.dumps({"reply": "ok", "flow_proposals": []}),
            [{"type": "engine_state", "data": {"state": {"turns": len(seen)}}}],
            "engine-sid-1",
        )

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    workflow_id = "wf-state"
    first = module.submit_message(
        project.id, None, "第一轮", "idem-st-1", workflow_id=workflow_id
    )
    assert await _wait_turn(module, first.turn_id) == "completed"
    assert seen[0][0] is None  # 首轮无引擎历史
    session = module._sessions[("wf", project.id, workflow_id)]
    assert session.engine_state == {"turns": 1}

    follow = module.submit_message(
        project.id,
        first.session_id,
        "第二轮",
        "idem-st-2",
        workflow_id=workflow_id,
    )
    assert await _wait_turn(module, follow.turn_id) == "completed"
    assert seen[1][0] == {"turns": 1}  # 上一轮引擎状态被传回

    # daemon 重启后引擎状态从 DB 恢复并继续传递。
    await module.shutdown()
    bus2 = EventBus()
    restarted = WorkflowGenModule(bus2, manager)
    monkeypatch.setattr(restarted, "_invoke", fake_invoke)
    try:
        third = restarted.submit_message(
            project.id,
            first.session_id,
            "第三轮",
            "idem-st-3",
            workflow_id=workflow_id,
        )
        assert await _wait_turn(restarted, third.turn_id) == "completed"
        assert seen[2][0] == {"turns": 2}
    finally:
        await restarted.shutdown()
        await bus2.close()


@pytest.mark.anyio
async def test_invoke_engine_forwards_message_history_only_to_capable_engines(
    monkeypatch,
):
    """invoke_engine 只向支持 message_history 的引擎透传引擎状态。"""
    import agent_assistants.base as assistant_base
    from engines.core.events import InternalEvent

    calls: list[dict] = []

    class CapableEngine:
        supports_resume = True
        supports_message_history = True

        async def spawn(self, **kwargs):
            calls.append(kwargs)
            yield InternalEvent(
                type="session_started", data={"session_id": "s-1"}
            )

    class StatelessEngine:
        supports_resume = False
        supports_message_history = False

        async def spawn(self, **kwargs):
            calls.append(kwargs)
            yield InternalEvent(
                type="session_started", data={"session_id": "s-2"}
            )

    monkeypatch.setattr(
        assistant_base,
        "create_engine",
        lambda engine_id: CapableEngine(),
    )
    await assistant_base.invoke_engine(
        "capable",
        None,
        "/tmp",
        "p",
        "sid",
        message_history=[1, 2],
        report_engine_state=True,
    )
    assert calls[0]["message_history"] == [1, 2]
    assert calls[0]["report_engine_state"] is True
    assert calls[0]["session_id"] == "sid"

    calls.clear()
    monkeypatch.setattr(
        assistant_base,
        "create_engine",
        lambda engine_id: StatelessEngine(),
    )
    await assistant_base.invoke_engine("stateless", None, "/tmp", "p", "sid")
    assert "message_history" not in calls[0]
    assert "report_engine_state" not in calls[0]
    assert calls[0]["session_id"] is None


@pytest.mark.anyio
async def test_invoke_engine_pauses_and_routes_assistant_interactions(monkeypatch):
    """共享助手调用层也必须把交互注册到统一 intervention broker。"""
    import agent_assistants.base as assistant_base
    from engines.core.interactions import elicitation_request
    from services.intervention import intervention_manager

    responded = asyncio.Event()
    received: list[tuple[dict, dict]] = []
    published = []

    async def publish(event):
        published.append(event)

    class InteractiveEngine:
        supports_resume = False
        supports_message_history = False

        async def spawn(self, **kwargs):
            yield elicitation_request(
                interaction_id="assistant-ask-1",
                message="选择范围",
                requested_schema={
                    "type": "object",
                    "properties": {"answer": {"type": "string"}},
                    "required": ["answer"],
                },
            )
            await responded.wait()
            yield assistant_base.InternalEvent(
                type="agent_message_chunk",
                data={"content": {"text": "继续执行"}},
            )

        def normalize_interaction_event(self, event):
            return event

        async def respond_interaction(self, request, response):
            received.append((request, response))
            responded.set()
            return True

    monkeypatch.setattr(
        assistant_base,
        "create_engine",
        lambda engine_id: InteractiveEngine(),
    )
    invocation = asyncio.create_task(assistant_base.invoke_engine(
        "interactive",
        None,
        "/tmp",
        "prompt",
        None,
        publish,
        run_key="assistant-turn-1",
    ))
    try:
        for _ in range(20):
            if "assistant-ask-1" in intervention_manager.list_pending():
                break
            await asyncio.sleep(0)
        assert "assistant-ask-1" in intervention_manager.list_pending()
        response = {"action": "accept", "content": {"answer": "后端"}}
        assert intervention_manager.deliver_response("assistant-ask-1", response)
        text, events, _ = await asyncio.wait_for(invocation, timeout=1)
        assert text == "继续执行"
        assert [event["type"] for event in events] == [
            "interaction_request", "interaction_response", "agent_message_chunk",
        ]
        assert received[0][1] == response
        assert [event.type for event in published] == [
            "interaction_request", "interaction_response", "agent_message_chunk",
        ]
    finally:
        if not invocation.done():
            invocation.cancel()
            with pytest.raises(asyncio.CancelledError):
                await invocation
        intervention_manager.cancel("assistant-ask-1")


@pytest.mark.anyio
async def test_default_assistant_prompt_omits_history_for_resume_engines(
    monkeypatch,
):
    """共享层默认 prompt 构建：resume 引擎不拼历史，无状态引擎保留拼接。"""
    import agent_assistants.base as assistant_base
    from agent_assistants.base import (
        AssistantConfig,
        AssistantRuntime,
        AssistantSession,
    )
    from streaming.bus import EventBus

    class ResumeEngine:
        supports_resume = True

    class StatelessEngine:
        supports_resume = False

    runtime = AssistantRuntime(
        AssistantConfig(
            name="generic",
            channel="gen",
            system_prompt="系统提示",
            scope="ephemeral",
        ),
        EventBus(),
        None,
    )
    messages = [
        {"role": "user", "content": "第一问"},
        {"role": "assistant", "content": "答1"},
        {"role": "user", "content": "第二问"},
    ]
    session = AssistantSession(
        session_id="s1",
        project_id="p",
        scope="ephemeral",
        engine="claude",
        messages=list(messages),
    )
    monkeypatch.setattr(
        assistant_base, "create_engine", lambda engine_id: ResumeEngine()
    )
    prompt = runtime._build_prompt(session)
    assert "系统提示" in prompt
    assert "Conversation history" not in prompt
    assert "第一问" not in prompt
    assert "第二问" in prompt

    resumed = AssistantSession(
        session_id="s1",
        project_id="p",
        scope="ephemeral",
        engine="claude",
        resolved_session_id="engine-1",
        messages=list(messages),
    )
    prompt = runtime._build_prompt(resumed)
    assert "系统提示" not in prompt
    assert "第二问" in prompt

    monkeypatch.setattr(
        assistant_base, "create_engine", lambda engine_id: StatelessEngine()
    )
    prompt = runtime._build_prompt(session)
    assert "Conversation history" in prompt
    assert "第一问" in prompt


@pytest.mark.anyio
async def test_incremental_patch_merges_into_canvas(gen_module, monkeypatch):
    """A patch proposal is merged against the live canvas and tagged with stages."""
    module, bus, _manager, project, _ = gen_module
    queue = bus.subscribe()

    base = {
        "nodes": [
            {"id": 1, "type": "req", "title": "需求"},
            {"id": 2, "type": "dev", "title": "开发"},
        ],
        "connections": [{"from": 1, "fromPort": 0, "to": 2, "toPort": 0}],
    }
    raw = json.dumps(
        {
            "reply": "改开发并加测试",
            "flow_proposals": [
                {
                    "title": "增量调整",
                    "summary": "更新开发阶段并新增测试",
                    "steps": {
                        "upsertNodes": [
                            {"id": 2, "type": "dev", "title": "开发v2"},
                            {"type": "test", "title": "测试"},
                        ],
                        "removeNodeIds": [],
                    },
                }
            ],
        }
    )

    async def fake_invoke(*args, **kwargs):
        return raw, [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    accepted = module.submit_message(
        project.id,
        None,
        "把开发改一下并加测试",
        "idem-patch",
        steps=base,
        context_mode="canvas_updated",
    )
    assert await _wait_turn(module, accepted.turn_id) == "completed"

    cards = None
    while True:
        event = await asyncio.wait_for(queue.get(), timeout=2)
        if event["type"] == "CUSTOM" and event["name"] == "workstep.flow_proposals":
            cards = event["value"]["proposals"]
            break
    assert len(cards) == 1
    card = cards[0]
    # Merged canvas keeps the untouched stage and appends the new one.
    node_ids = [node["id"] for node in card["steps"]["nodes"]]
    assert node_ids == [1, 2, 3]
    assert card["steps"]["nodes"][1]["title"] == "开发v2"
    assert card["steps"]["nodes"][2]["title"] == "测试"
    changes = {entry["id"]: entry["change"] for entry in card["stepChanges"]}
    assert changes == {2: "updated", 3: "added"}
    # A multi-stage patch is never auto-applied wholesale.
    assert card["autoApply"] is False
    # The new stage carries its server-assigned id so a subset can be applied.
    upsert_ids = {node["id"] for node in card["patch"]["upsertNodes"]}
    assert upsert_ids == {2, 3}
    WorkflowDefinition.load(card["steps"]).validate()


@pytest.mark.anyio
async def test_partial_nodes_payload_is_merged_instead_of_replacing_canvas(
    gen_module, monkeypatch
):
    """Edit-mode ``nodes`` subsets must not erase untouched stages."""
    module, bus, _manager, project, _ = gen_module
    queue = bus.subscribe()
    base = {
        "nodes": [
            {"id": 1, "type": "req", "title": "需求"},
            {"id": 2, "type": "dev", "title": "开发"},
            {"id": 3, "type": "publish", "title": "发布"},
        ],
        "connections": [
            {"from": 1, "fromPort": 0, "to": 2, "toPort": 0},
            {"from": 2, "fromPort": 0, "to": 3, "toPort": 0},
        ],
    }
    raw = json.dumps({
        "reply": "已修改开发阶段",
        "flow_proposals": [{
            "title": "修改开发阶段",
            "steps": {
                "nodes": [{"id": 2, "type": "dev", "title": "开发 v2"}],
            },
            "autoApply": True,
        }],
    })

    async def fake_invoke(*args, **kwargs):
        return raw, [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    accepted = module.submit_message(
        project.id,
        None,
        "只修改开发阶段",
        "idem-partial-nodes",
        steps=base,
        context_mode="canvas_updated",
    )
    assert await _wait_turn(module, accepted.turn_id) == "completed"

    cards = None
    while True:
        event = await asyncio.wait_for(queue.get(), timeout=2)
        if event["type"] == "CUSTOM" and event["name"] == "workstep.flow_proposals":
            cards = event["value"]["proposals"]
            break

    card = cards[0]
    assert [node["id"] for node in card["steps"]["nodes"]] == [1, 2, 3]
    assert card["steps"]["nodes"][1]["title"] == "开发 v2"
    assert card["stepChanges"] == [{
        "id": 2,
        "key": "dev",
        "title": "开发 v2",
        "change": "updated",
    }]
    assert [node["id"] for node in card["patch"]["upsertNodes"]] == [2]
    assert card["autoApply"] is False


def test_incremental_patch_ignores_unchanged_upsert_nodes():
    base = {
        "nodes": [
            {"id": 1, "type": "req", "title": "需求"},
            {"id": 2, "type": "dev", "title": "开发"},
        ],
        "connections": [{"from": 1, "to": 2}],
    }
    merged, changes, resolved = apply_patch(base, {
        "upsertNodes": [
            {"id": 1, "type": "req", "title": "需求"},
            {"id": 2, "type": "dev", "title": "开发 v2"},
        ],
        "removeNodeIds": [],
    })

    assert [change["id"] for change in changes] == [2]
    assert [node["id"] for node in resolved["upsertNodes"]] == [2]
    assert merged["nodes"][0]["title"] == "需求"


@pytest.mark.anyio
@pytest.mark.parametrize("transport", ["body", "system", "developer"])
async def test_workflow_actual_input_native_and_fallback(gen_module, monkeypatch, transport):
    from engines.core.acp_base import AcpEngineBase
    from engines.core.events import InternalEvent
    import agent_assistants.base as base
    import agent_assistants.workflow_gen as workflow
    module, bus, manager, project, _ = gen_module
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
        SYSTEM_PROMPT_MODE = transport
        @property
        def supports_resume(self):
            return True
        async def spawn(self, **kwargs):
            calls.append(kwargs)
            yield InternalEvent("session_started", {"session_id":"native-flow"})
            yield InternalEvent("agent_message_chunk", {"content":{"text":json.dumps({"reply":"ok", "flow_proposals":[]})}})

    monkeypatch.setattr(base, "create_engine", lambda _: Engine())
    monkeypatch.setattr(workflow, "create_engine", lambda _: Engine())
    for index in range(2):
        accepted = module.submit_message(project.id, None, f"问题{index}", f"actual-{index}",
                                        workflow_id="actual-flow", steps={"nodes":[], "connections":[]}, context_mode="canvas_updated")
        assert await _wait_turn(module, accepted.turn_id) == "completed"
    history = module.history(project.id, "actual-flow")["messages"]
    replies = [item for item in history if item["role"] == "assistant"]
    for index, reply in enumerate(replies):
        assert calls[index]["prompt"] in reply["prompt"]
        assert f"问题{index}" in reply["prompt"]
        assert "Current canvas updated" in calls[index]["prompt"]
        if transport == "body":
            assert (SYSTEM_PROMPT in calls[index]["prompt"]) == (index == 0)
            assert "独立指令" not in reply["prompt"]
        else:
            assert calls[index]["system_prompt"] == SYSTEM_PROMPT
            assert SYSTEM_PROMPT not in calls[index]["prompt"]
            assert f"独立指令（{transport}）" in reply["prompt"]
    with manager.activate_project_by_id(project.id):
        from models import WorkflowGenSession
        assert json.loads(WorkflowGenSession.get().messages_json)[-1]["prompt"] == replies[-1]["prompt"]
    module._sessions.clear()
    assert module.history(project.id, "actual-flow")["messages"][-1]["prompt"] == replies[-1]["prompt"]


@pytest.mark.anyio
async def test_workflow_prompt_view_includes_actual_repair_call(gen_module, monkeypatch):
    from engines.core.acp_base import AcpEngineBase
    from engines.core.events import InternalEvent
    import agent_assistants.base as base
    module, _, manager, project, _ = gen_module
    calls = []
    class Engine(AcpEngineBase):
        SYSTEM_PROMPT_MODE = "system"
        is_installed = staticmethod(lambda: True)
        get_version = staticmethod(lambda: "test")
        resolve_binary = staticmethod(lambda: "test")
        async def spawn(self, **kwargs):
            calls.append(kwargs)
            content = "bad JSON" if len(calls) == 1 else json.dumps({"reply":"修复完成", "flow_proposals":[]})
            yield InternalEvent("agent_message_chunk", {"content":{"text":content}})
    monkeypatch.setattr(base, "create_engine", lambda _: Engine())
    accepted = module.submit_message(project.id, None, "设计流程", "repair-actual", workflow_id="repair-actual")
    assert await _wait_turn(module, accepted.turn_id) == "completed"
    assert len(calls) == 2
    assert calls[1]["prompt"] == "bad JSON"
    assert calls[1]["system_prompt"].startswith("Repair the following response")
    reply = module.history(project.id, "repair-actual")["messages"][-1]
    assert reply["prompt"].count("独立指令（system）") == 2
    for call in calls:
        assert call["prompt"] in reply["prompt"]
        assert call["system_prompt"] in reply["prompt"]
    records = await asyncio.to_thread((project.workstep_dir / reply["event_log_path"]).read_text)
    assert "prompt_input" not in records
    assert "Repair the following response" not in records


@pytest.mark.anyio
async def test_saving_partial_workflow_history_preserves_existing_prompt(gen_module):
    from agent_assistants.session_state import AssistantSession
    module, _, manager, project, _ = gen_module
    def save_partial(_):
        runtime = AssistantSession(session_id="old-flow", project_id=project.id, scope="workflow", scope_key="old-flow", engine="claude")
        runtime.messages = [{"id":"old-answer", "role":"assistant", "content":"回答", "prompt":"已存流程输入"}]
        module._config.persistence.save(runtime)
        runtime.messages[0].pop("prompt")
        module._config.persistence.save(runtime)
        return module.history(project.id, "old-flow")["messages"][0]["prompt"]
    assert await manager.run_db(project.id, save_partial) == "已存流程输入"

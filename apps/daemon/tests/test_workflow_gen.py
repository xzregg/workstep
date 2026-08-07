"""Tests for the in-memory workflow generation chat module."""

import asyncio
import json
import time
from types import SimpleNamespace

import pytest

from services.project import ProjectManager
from services.workflow_definition import WorkflowDefinition
from services.workflow_gen import WorkflowGenModule
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
        if state and state["status"] in ("completed", "error"):
            return state["status"]
        await asyncio.sleep(0.01)
    raise AssertionError("turn did not finish")


@pytest.fixture
async def gen_module(tmp_path, monkeypatch):
    import services.config as config_service
    import services.project as project_service
    import services.workflow_gen as wfgen_service

    config_store = MemoryConfigStore()
    monkeypatch.setattr(config_service, "config_store", config_store)
    monkeypatch.setattr(project_service, "config_store", config_store)
    monkeypatch.setattr(wfgen_service, "config_store", config_store)

    manager = ProjectManager()
    bus = EventBus()
    module = WorkflowGenModule(bus, manager)
    project = manager.init_project(tmp_path / "gen-proj")
    monkeypatch.setattr(
        wfgen_service, "create_engine", lambda engine_id: FakeEngine()
    )
    yield module, bus, manager, project, config_store
    await module.shutdown()
    await bus.close()
    manager.close_all()


@pytest.mark.anyio
async def test_submit_creates_session_and_is_idempotent(gen_module, monkeypatch):
    module, bus, manager, project, _ = gen_module

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None):
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

    replayed = module.submit_message(
        project.id, None, "帮我设计一个内容发布流程", "idem-1"
    )
    assert replayed.turn_id == accepted.turn_id
    assert replayed.session_id == accepted.session_id


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
                {"title": "标准版", "summary": "需求到发布", "steps": proposal}
            ],
        }
    )

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None):
        if on_event is not None:
            # Simulate a streamed JSON reply with an escaped reply field
            from engines.events import InternalEvent
            chunk = '"reply":"这是完整流程"'
            for char in chunk:
                await on_event(
                    InternalEvent(
                        type="text_delta",
                        data={"delta": char},
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

    proposal_events = [e for e in collected if e["type"] == "flow_proposals"]
    assert proposal_events, "expected a flow_proposals event"
    event = proposal_events[0]
    assert "task_id" not in event
    assert event["session_id"] == accepted.session_id
    assert event["channel"] == "flow_gen"
    cards = event["data"]["proposals"]
    assert len(cards) == 1
    assert cards[0]["title"] == "标准版"
    assert cards[0]["nodeCount"] == 2
    steps = cards[0]["steps"]
    WorkflowDefinition.load(steps).validate()

    deltas = [e for e in collected if e["type"] == "text_delta"]
    assert deltas
    streamed = "".join(e["data"]["delta"] for e in deltas)
    assert streamed == "这是完整流程"

    # No rows written to the project DB
    with manager.activate_project_by_id(project.id):
        from models import Task
        assert Task.select().count() == 0

    # Conversation history is kept in memory only
    session = module._sessions[(project.id, accepted.session_id)]
    assert [m["role"] for m in session.messages] == ["user", "assistant"]


@pytest.mark.anyio
async def test_invalid_proposal_is_repaired(gen_module, monkeypatch):
    module, bus, manager, project, _ = gen_module
    calls: list[str] = []

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None):
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
    assert session.messages[-1]["content"] == "已修复"


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

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None):
        return raw, [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    accepted = module.submit_message(project.id, None, "设计一个流程", "idem-5")
    status = await _wait_turn(module, accepted.turn_id)
    assert status == "completed"

    stop.set()
    await asyncio.wait_for(collector_task, timeout=2)
    proposal_events = [e for e in collected if e["type"] == "flow_proposals"]
    assert proposal_events
    cards = proposal_events[0]["data"]["proposals"]
    assert [card["title"] for card in cards] == ["简洁版"]


@pytest.mark.anyio
async def test_unrepairable_proposal_drops_proposal(gen_module, monkeypatch):
    module, bus, manager, project, _ = gen_module

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None):
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
async def test_resolve_engine_models_uses_coordinator_defaults(gen_module, monkeypatch):
    import services.workflow_gen as wfgen_service

    module, bus, manager, project, config_store = gen_module
    monkeypatch.setattr(
        wfgen_service, "create_engine", lambda engine_id: FakeEngine()
    )

    config_store.values["coordinator_default_engine"] = "api"
    config_store.values["coordinator_default_model"] = "gpt-x"
    config_store.values["coordinator_default_fast_model"] = "gpt-fast"
    engine_id, model, fast_model = module._resolve_engine_models()
    assert (engine_id, model, fast_model) == ("api", "gpt-x", "gpt-fast")

    config_store.values.clear()
    engine_id, model, fast_model = module._resolve_engine_models()
    assert engine_id == "claude"
    assert model is None


@pytest.mark.anyio
async def test_chat_http_contract(tmp_path, monkeypatch):
    import main
    import services.project as project_service
    from httpx import ASGITransport, AsyncClient
    from services.project import ProjectManager

    manager = ProjectManager()
    monkeypatch.setattr(project_service, "config_store", MemoryConfigStore())
    monkeypatch.setattr(main, "project_manager", manager)

    bus = EventBus()
    module = WorkflowGenModule(bus, manager)

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None):
        return json.dumps({"reply": "ok", "flow_proposals": []}), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    monkeypatch.setattr(main, "workflow_gen_module", module)

    project = manager.init_project(tmp_path / "http-proj")
    transport = ASGITransport(app=main.app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                "/api/workflow/generate/chat",
                json={"project_id": project.id, "content": "设计一个流程"},
                headers={"Idempotency-Key": "idem-http"},
            )
            assert resp.status_code == 200
            body = resp.json()
            assert body["session_id"]
            assert body["turn_id"]
            assert body["status"] == "queued"

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

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None):
        calls["count"] += 1
        return (json.dumps(fixed if calls["count"] > 1 else invalid), [], None)

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    accepted = module.submit_message(project.id, None, "设计一个流程", "idem-6")
    status = await _wait_turn(module, accepted.turn_id)
    assert status == "completed"

    stop.set()
    await asyncio.wait_for(collector_task, timeout=2)
    proposal_events = [e for e in collected if e["type"] == "flow_proposals"]
    assert proposal_events, "expected a flow_proposals event after repair"
    cards = proposal_events[0]["data"]["proposals"]
    assert [card["title"] for card in cards] == ["A"]
    rejected = [e for e in collected if e["type"] == "flow_proposals_rejected"]
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

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None):
        return json.dumps(invalid), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    accepted = module.submit_message(project.id, None, "设计一个流程", "idem-7")
    status = await _wait_turn(module, accepted.turn_id)
    assert status == "completed"

    stop.set()
    await asyncio.wait_for(collector_task, timeout=2)
    proposal_events = [e for e in collected if e["type"] == "flow_proposals"]
    assert not proposal_events
    rejected = [e for e in collected if e["type"] == "flow_proposals_rejected"]
    assert rejected, "expected a flow_proposals_rejected event"
    assert "校验" in rejected[0]["data"]["message"]


@pytest.mark.anyio
async def test_engine_model_overrides_are_session_scoped(gen_module, monkeypatch):
    """engine/model/fast_model overrides apply to the generation session
    (not persisted to global coordinator config) and bad engines are rejected."""
    import services.workflow_gen as wfgen_service

    module, bus, manager, project, config_store = gen_module
    config_store.values["coordinator_default_engine"] = "claude"
    config_store.values["coordinator_default_model"] = "claude-slow"
    config_store.values["coordinator_default_fast_model"] = "claude-fast"

    seen: list[tuple] = []

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None):
        seen.append((engine_id, model, session_id))
        return json.dumps({"reply": "ok", "flow_proposals": []}), [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    accepted = module.submit_message(
        project.id,
        None,
        "设计一个流程",
        "idem-override",
        engine="codex",
        model="gpt-5",
        fast_model="gpt-5-mini",
    )
    assert accepted.status == "queued"
    status = await _wait_turn(module, accepted.turn_id)
    assert status == "completed"
    assert seen, "expected _invoke to be called"
    engine_id, model, _sid = seen[0]
    assert engine_id == "codex"
    assert model == "gpt-5"
    session = module._sessions[(project.id, accepted.session_id)]
    assert session.engine == "codex"
    assert session.model == "gpt-5"
    assert session.fast_model == "gpt-5-mini"

    # Overrides are not persisted to the global config store.
    assert config_store.values.get("coordinator_default_engine") == "claude"
    assert config_store.values.get("coordinator_default_model") == "claude-slow"

    # Follow-up turn without overrides falls back to the defaults.
    seen.clear()
    follow = module.submit_message(
        project.id, accepted.session_id, "继续", "idem-override-2"
    )
    status = await _wait_turn(module, follow.turn_id)
    assert status == "completed"
    assert seen
    assert seen[0][0] == "claude"
    assert seen[0][1] == "claude-slow"
    assert session.engine == "claude"
    assert session.model == "claude-slow"

    # Unsupported engine raises ValueError (surfaced as 400 by the API route).
    monkeypatch.setattr(
        wfgen_service,
        "create_engine",
        lambda engine_id: FakeEngine() if engine_id == "claude" else None,
    )
    with pytest.raises(ValueError):
        module.submit_message(
            project.id,
            None,
            "设计一个流程",
            "idem-override-3",
            engine="unknown-engine",
        )

"""Tests for Codex-style session chats (chat_sessions / chat_messages)."""

import asyncio
import json
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient

from models import LATEST_SCHEMA_VERSION, SchemaVersion, init_db
from models.chat_session import ChatMessage, ChatSession, ProjectSetting
from models.fields import utc_now
from agent_assistants.base import extract_uploaded_images
from agent_assistants.chat_session import DEFAULT_QUICK_BUTTONS, SYSTEM_PROMPT, ChatSessionModule
from agent_assistants.event_truncation import LARGE_PAYLOAD_LIMIT
from engines.core.events import InternalEvent
from services.project import ProjectManager
from streaming.bus import EventBus


class MemoryConfigStore:
    """In-memory coordinator config store for chat module tests."""

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

    def get_assistant_defaults(self, name):
        defaults = {
            "engine": self.get_coordinator_default_engine(),
            "model": self.get_coordinator_default_model(),
            "fast_model": self.get_coordinator_default_fast_model(),
            "vision_model": "",
            "thinking_effort": "",
            "provider_id": "",
        }
        defaults.update(self.values.get("assistant_defaults", {}).get(name, {}))
        return defaults

    def get_assistant_config(self, name):
        return {
            key: value
            for key, value in self.values.get("assistant_defaults", {}).get(name, {}).items()
            if isinstance(value, str) and value.strip()
        }

    def get_engine_default_model(self, engine_id):
        return self.values.get("engine_default_models", {}).get(engine_id, "")

    def get_pydantic_ai_engine_config(self):
        return self.values.get("pydantic_ai_engine", {})

    def get_prompt_enhance_config(self):
        raw = self.values.get("prompt_enhance", {})
        return {
            "provider_id": raw.get("provider_id", ""),
            "model": raw.get("model", ""),
            "protocol": raw.get("protocol", ""),
        }

    def set_prompt_enhance_config(self, *, provider_id, model, protocol=""):
        self.values["prompt_enhance"] = {
            "provider_id": provider_id,
            "model": model,
            "protocol": protocol,
        }

    def get_provider(self, provider_id):
        for item in self.values.get("providers", []):
            if item.get("id") == provider_id:
                return item
        return None

    def get_user_name(self):
        return self.values.get("user_name", "本地用户")

    def get_device_identity(self):
        return {
            "device_id": self.values.get("device_id", "device-a"),
            "device_name": self.values.get("device_name", "电脑 A"),
        }


class FakeEngine:
    capabilities = SimpleNamespace(
        supports_coordinator=True,
        supports_live_step_message=True,
    )
    supports_resume = False
    supports_message_history = False

    @staticmethod
    def supports_provider(provider):
        return provider.get("protocol") == "openai_compatible"


def test_init_db_records_latest_schema_version(tmp_path):
    """Fresh databases create the chat tables and record the latest schema version."""
    db = init_db(str(tmp_path / "workstep.db"))
    try:
        assert SchemaVersion.get_by_id(1).version == LATEST_SCHEMA_VERSION == 0
        tables = {
            row[0]
            for row in db.execute_sql(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        assert "chat_sessions" in tables
        assert "chat_messages" in tables
        assert "project_settings" in tables
        columns = {
            row[1] for row in db.execute_sql("PRAGMA table_info(chat_sessions)")
        }
        assert "permission_mode" in columns
        assert {
            "parent_session_id",
            "forked_from_message_id",
            "fork_context_mode",
            "fork_context_json",
            "fork_status",
        }.issubset(columns)
    finally:
        db.close()


async def _wait_turn(module, turn_id, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = module._turn_states.get(turn_id)
        if state and state["status"] in ("completed", "error", "stopped"):
            return state["status"]
        await asyncio.sleep(0.01)
    raise AssertionError("turn did not finish")


@pytest.fixture
async def chat_module(tmp_path, monkeypatch):
    import agent_assistants.chat_session as chat_service
    import agent_assistants.base as assistant_base
    import services.config as config_service
    import services.project as project_service

    config_store = MemoryConfigStore()
    monkeypatch.setattr(config_service, "config_store", config_store)
    monkeypatch.setattr(project_service, "config_store", config_store)
    monkeypatch.setattr(chat_service, "config_store", config_store)
    monkeypatch.setattr(assistant_base, "config_store", config_store)
    monkeypatch.setattr(chat_service, "create_engine", lambda engine_id: FakeEngine())
    monkeypatch.setattr(assistant_base, "create_engine", lambda engine_id: FakeEngine())

    manager = ProjectManager()
    bus = EventBus()
    module = ChatSessionModule(bus, manager)
    project = manager.init_project(tmp_path / "chat-proj")
    yield module, bus, manager, project, config_store
    await module.shutdown()
    await bus.close()
    manager.close_all()


@pytest.mark.anyio
async def test_compact_requires_existing_engine_session(chat_module):
    module, _, _, project, _ = chat_module
    session = module.create_session(project.id)

    with pytest.raises(ValueError, match="没有可压缩"):
        module.submit_message(
            project.id, session["id"], "/compact", "compact-new",
            schedule=False,
        )


@pytest.mark.anyio
async def test_session_crud_round_trip(chat_module):
    """create / list / get / rename / delete keep rows in the new tables."""
    module, bus, manager, project, _ = chat_module
    workflow_id = "wf-1"

    created = module.create_session(project.id, workflow_id)
    session_id = created["id"]
    assert created["project_id"] == project.id
    assert created["workflow_id"] == workflow_id
    assert created["messages"] == []

    listed = module.list_sessions(project.id)
    assert [item["id"] for item in listed] == [session_id]

    renamed = module.rename_session(project.id, session_id, "  我的会话  ")
    assert renamed["title"] == "我的会话"

    with pytest.raises(ValueError):
        module.rename_session(project.id, session_id, "   ")

    detail = module.get_session(project.id, session_id)
    assert detail is not None
    assert detail["title"] == "我的会话"

    assert module.delete_session(project.id, session_id) is True
    assert module.get_session(project.id, session_id) is None
    with pytest.raises(ValueError):
        module.delete_session(project.id, session_id)


@pytest.mark.anyio
async def test_session_archive_round_trip(chat_module):
    module, _bus, _manager, project, _ = chat_module
    first = module.create_session(project.id)
    second = module.create_session(project.id)

    archived = module.set_archived(project.id, first["id"], True)
    assert archived["archived"] is True
    assert [row["id"] for row in module.list_sessions(project.id)] == [second["id"]]
    assert [row["id"] for row in module.list_sessions(project.id, archived=True)] == [first["id"]]
    assert module.get_session(project.id, first["id"])["archived"] is True

    restored = module.set_archived(project.id, first["id"], False)
    assert restored["archived"] is False
    assert {row["id"] for row in module.list_sessions(project.id)} == {first["id"], second["id"]}
    with pytest.raises(ValueError, match="not found"):
        module.set_archived(project.id, "missing", True)


@pytest.mark.anyio
async def test_session_summary_reports_persisted_running_turn(chat_module):
    module, _bus, _manager, project, _ = chat_module
    created = module.create_session(project.id, "wf-running")

    with module._project_ctx(project.id):
        row = ChatSession.get_by_id(created["id"])
        ChatMessage.create(
            id="running-assistant",
            session=row,
            role="assistant",
            content="处理中",
            status="running",
            created_at=utc_now(),
        )

    assert module.list_sessions(project.id)[0]["running"] is True
    assert module.get_session(project.id, created["id"])["running"] is True


@pytest.mark.anyio
async def test_session_summary_reports_failed_last_message(chat_module):
    module, _bus, _manager, project, _ = chat_module
    created = module.create_session(project.id, "wf-failed")

    with module._project_ctx(project.id):
        row = ChatSession.get_by_id(created["id"])
        ChatMessage.create(
            id="failed-assistant",
            session=row,
            role="assistant",
            content="执行失败",
            status="error",
            created_at=utc_now(),
        )

    assert module.list_sessions(project.id)[0]["last_message_status"] == "error"
    assert module.get_session(project.id, created["id"])["last_message_status"] == "error"


@pytest.mark.anyio
async def test_cross_engine_fork_creates_independent_session_with_smart_handoff(
    chat_module,
):
    module, _bus, _manager, project, _ = chat_module
    source = module.create_session(project.id, title="原会话", engine="claude")
    now = utc_now()
    with module._project_ctx(project.id):
        row = ChatSession.get_by_id(source["id"])
        ChatMessage.create(
            id="source-user",
            session=row,
            role="user",
            content="请实现登录功能",
            created_at=now,
        )
        ChatMessage.create(
            id="source-assistant",
            session=row,
            role="assistant",
            content="已决定修改 auth.py",
            status="succeeded",
            created_at=now + timedelta(seconds=1),
            ended_at=now + timedelta(seconds=1),
        )

    forked = await module.fork_session(
        project.id,
        source["id"],
        title="新引擎分支",
        engine="pydantic_ai",
        context_mode="smart",
    )

    assert forked["id"] != source["id"]
    assert forked["engine"] == "pydantic_ai"
    assert forked["parent_session_id"] == source["id"]
    assert forked["fork_context_mode"] == "smart"
    assert [item["content"] for item in forked["messages"]] == [
        "请实现登录功能",
        "已决定修改 auth.py",
    ]
    with module._project_ctx(project.id):
        row = ChatSession.get_by_id(forked["id"])
        assert row.engine_session_id is None
        assert row.engine_state_json is None


@pytest.mark.anyio
async def test_message_fork_only_copies_history_through_selected_reply(chat_module):
    module, _bus, _manager, project, _ = chat_module
    source = module.create_session(project.id, title="原会话", engine="claude")
    now = utc_now()
    messages = [
        ("turn-1-user", "user", "第一问"),
        ("turn-1-assistant", "assistant", "第一答"),
        ("turn-2-user", "user", "第二问"),
        ("turn-2-assistant", "assistant", "第二答"),
    ]
    with module._project_ctx(project.id):
        row = ChatSession.get_by_id(source["id"])
        for index, (message_id, role, content) in enumerate(messages):
            ChatMessage.create(
                id=message_id,
                session=row,
                role=role,
                content=content,
                status="succeeded",
                created_at=now + timedelta(seconds=index),
            )

    forked = await module.fork_session(
        project.id,
        source["id"],
        title="从第一答分叉",
        engine="pydantic_ai",
        context_mode="smart",
        fork_message_id="turn-1-assistant",
    )

    assert forked["forked_from_message_id"] == "turn-1-assistant"
    assert [item["content"] for item in forked["messages"]] == ["第一问", "第一答"]


@pytest.mark.anyio
async def test_native_fork_rejects_an_earlier_message(chat_module, monkeypatch):
    module, _bus, _manager, project, _ = chat_module

    class NativeForkEngine(FakeEngine):
        supports_session_fork = True

    monkeypatch.setattr(
        "agent_assistants.chat_session.create_engine",
        lambda engine_id: NativeForkEngine(),
    )
    source = module.create_session(project.id, title="原会话", engine="claude")
    now = utc_now()
    with module._project_ctx(project.id):
        row = ChatSession.get_by_id(source["id"])
        row.engine_session_id = "engine-source"
        row.save()
        for index, message_id in enumerate(("first", "latest")):
            ChatMessage.create(
                id=message_id,
                session=row,
                role="assistant",
                content=message_id,
                status="succeeded",
                created_at=now + timedelta(seconds=index),
            )

    with pytest.raises(ValueError, match="latest message"):
        await module.fork_session(
            project.id,
            source["id"],
            title="旧消息原生分叉",
            engine="claude",
            context_mode="native",
            fork_message_id="first",
        )


@pytest.mark.anyio
async def test_same_engine_uses_native_session_fork(chat_module, monkeypatch):
    module, _bus, _manager, project, _ = chat_module

    class NativeForkEngine(FakeEngine):
        supports_resume = True
        supports_session_fork = True

        async def fork_session(
            self, session_id, cwd, *, fork_point=None, model=None, provider_id=None
        ):
            assert session_id == "engine-source"
            return "engine-fork"

    monkeypatch.setattr(
        "agent_assistants.chat_session.create_engine",
        lambda engine_id: NativeForkEngine(),
    )
    monkeypatch.setattr(
        "agent_assistants.chat_session_transitions.create_engine",
        lambda engine_id: NativeForkEngine(),
    )
    source = module.create_session(project.id, title="原会话", engine="claude")
    with module._project_ctx(project.id):
        ChatSession.update(engine_session_id="engine-source").where(
            ChatSession.id == source["id"]
        ).execute()

    forked = await module.fork_session(
        project.id,
        source["id"],
        title="原生分支",
        engine="claude",
        context_mode="native",
    )

    assert forked["engine_session_id"] == "engine-fork"
    assert forked["parent_session_id"] == source["id"]


@pytest.mark.anyio
async def test_native_fork_engine_factory_does_not_block_event_loop(chat_module, monkeypatch):
    module, _bus, _manager, project, _ = chat_module

    class NativeForkEngine(FakeEngine):
        supports_resume = True
        supports_session_fork = True

        async def fork_session(self, session_id, cwd, **kwargs):
            return "engine-fork"

    def slow_factory(_engine_id):
        time.sleep(0.15)
        return NativeForkEngine()

    monkeypatch.setattr("agent_assistants.chat_session.create_engine", slow_factory)
    monkeypatch.setattr("agent_assistants.chat_session_transitions.create_engine", slow_factory)
    source = module.create_session(project.id, title="原会话", engine="claude")
    with module._project_ctx(project.id):
        ChatSession.update(engine_session_id="engine-source").where(
            ChatSession.id == source["id"]
        ).execute()

    started = time.monotonic()
    work = asyncio.create_task(module.fork_session(
        project.id, source["id"], title="原生分支", engine="claude",
        context_mode="native",
    ))
    try:
        await asyncio.sleep(0.01)
        assert time.monotonic() - started < 0.1
        forked = await work
        assert forked["engine_session_id"] == "engine-fork"
    finally:
        if not work.done():
            work.cancel()
            await asyncio.gather(work, return_exceptions=True)


@pytest.mark.anyio
async def test_native_fork_api_slow_factory_keeps_health_responsive(chat_module, monkeypatch):
    import main

    module, _bus, manager, project, _ = chat_module

    class NativeForkEngine(FakeEngine):
        supports_resume = True
        supports_session_fork = True

        async def fork_session(self, session_id, cwd, **kwargs):
            return "engine-fork"

    source = module.create_session(project.id, title="原会话", engine="claude")
    with module._project_ctx(project.id):
        ChatSession.update(engine_session_id="engine-source").where(
            ChatSession.id == source["id"]
        ).execute()
    entered = threading.Event()
    release = threading.Event()

    def slow_factory(_engine_id):
        entered.set()
        release.wait(timeout=2)
        return NativeForkEngine()

    monkeypatch.setattr("agent_assistants.chat_session.create_engine", slow_factory)
    monkeypatch.setattr("agent_assistants.chat_session_transitions.create_engine", slow_factory)
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        request = asyncio.create_task(client.post(
            f"/api/chat-sessions/{source['id']}/fork",
            json={
                "project_id": project.id,
                "title": "原生分支",
                "engine": "claude",
                "context_mode": "native",
            },
        ))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
            assert health.status_code == 200
        finally:
            release.set()
        forked = await request
        assert forked.status_code == 200
        assert forked.json()["engine_session_id"] == "engine-fork"


@pytest.mark.anyio
async def test_create_session_slow_engine_setup_keeps_health_responsive(chat_module, monkeypatch):
    import main

    module, _bus, manager, project, _ = chat_module
    entered = threading.Event()
    release = threading.Event()

    def slow_factory(_engine_id):
        entered.set()
        release.wait(timeout=2)
        return FakeEngine()

    monkeypatch.setattr("agent_assistants.chat_session.create_engine", slow_factory)
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        create = asyncio.create_task(client.post(
            "/api/chat-sessions", json={"project_id": project.id},
        ))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            assert not create.done()
            health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
            assert health.status_code == 200
        finally:
            release.set()
        response = await create
        assert response.status_code == 200


@pytest.mark.anyio
@pytest.mark.parametrize("engine_id", ["pydantic_ai", "codex_sdk"])
async def test_restarted_chat_rechecks_missing_engine_without_blocking_health(chat_module, monkeypatch, engine_id):
    import main
    import engines.core.registry as registry
    from engines.codex_sdk import CodexSDKEngine

    module, bus, manager, project, store = chat_module
    session = module.create_session(project.id, engine=engine_id)
    with module._project_ctx(project.id):
        ChatSession.update(engine_session_id="persisted-engine-session").where(
            ChatSession.id == session["id"]
        ).execute()
    await module.shutdown()
    restored = ChatSessionModule(bus, manager)
    entered = threading.Event()
    release = threading.Event()
    calls = []

    class RecoveredEngine(FakeEngine):
        supports_resume = True

        @staticmethod
        def is_installed():
            entered.set()
            assert release.wait(timeout=2)
            return True

    engine_class = RecoveredEngine
    if engine_id == "codex_sdk":
        # Exercise the real SDK engine's startup availability check and
        # capabilities, with a delayed import probe instead of an SDK process.
        monkeypatch.setattr(CodexSDKEngine, "_sdk_available", RecoveredEngine.is_installed)
        engine_class = CodexSDKEngine

    async def invoke(engine_id, model, cwd, prompt, session_id, on_event=None, **kwargs):
        calls.append((engine_id, session_id))
        return "继续成功", [], session_id

    store.values["execution_default_engine"] = engine_id
    monkeypatch.setattr(registry, "_ALL_ENGINES", {engine_id: engine_class})
    monkeypatch.setattr(registry, "ENGINE_REGISTRY", {})
    monkeypatch.setattr(registry, "_SCAN_CACHE", None)
    monkeypatch.setattr("agent_assistants.chat_session.create_engine", registry.create_engine)
    monkeypatch.setattr("agent_assistants.base.create_engine", registry.create_engine)
    monkeypatch.setattr(restored, "_invoke", invoke)
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", restored)
    try:
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
            request = asyncio.create_task(client.post(
                f"/api/chat-sessions/{session['id']}/chat",
                json={"project_id": project.id, "content": "继续"},
                headers={"Idempotency-Key": "restart-engine-recheck"},
            ))
            try:
                assert await asyncio.to_thread(entered.wait, 1)
                assert not request.done()
                health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
                assert health.status_code == 200
            finally:
                release.set()
            response = await request
            assert response.status_code == 200, response.text
            assert await _wait_turn(restored, response.json()["turn_id"]) == "completed"
            assert calls == [(engine_id, "persisted-engine-session")]
    finally:
        release.set()
        await restored.shutdown()


@pytest.mark.anyio
async def test_create_session_slow_sql_keeps_health_responsive(chat_module, monkeypatch):
    import main

    module, _bus, manager, project, _ = chat_module
    entered = threading.Event()
    release = threading.Event()
    original_execute_sql = project.db.execute_sql

    def slow_insert(sql, *args, **kwargs):
        if sql.startswith('INSERT INTO "chat_sessions"'):
            entered.set()
            release.wait(timeout=2)
        return original_execute_sql(sql, *args, **kwargs)

    monkeypatch.setattr(project.db, "execute_sql", slow_insert)
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        create = asyncio.create_task(client.post(
            "/api/chat-sessions", json={"project_id": project.id},
        ))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            assert not create.done()
            health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
            assert health.status_code == 200
        finally:
            release.set()
        response = await create
        assert response.status_code == 200


@pytest.mark.anyio
async def test_cross_engine_handoff_is_injected_once(chat_module, monkeypatch):
    module, _bus, _manager, project, _ = chat_module
    source = module.create_session(project.id, title="原会话", engine="claude")
    with module._project_ctx(project.id):
        row = ChatSession.get_by_id(source["id"])
        ChatMessage.create(
            id="handoff-source-user",
            session=row,
            role="user",
            content="旧目标：完成登录",
            created_at=utc_now(),
        )
    forked = await module.fork_session(
        project.id,
        source["id"],
        title="交接分支",
        engine="pydantic_ai",
        context_mode="smart",
    )
    prompts: list[str] = []

    async def fake_invoke(
        engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None
    ):
        prompts.append(prompt)
        return "完成", [], f"target-{len(prompts)}"

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    first = module.submit_message(
        project.id, forked["id"], "继续补测试", "handoff-first"
    )
    assert await _wait_turn(module, first.turn_id) == "completed"
    second = module.submit_message(
        project.id, forked["id"], "再检查边界", "handoff-second"
    )
    assert await _wait_turn(module, second.turn_id) == "completed"

    assert "<workstep_context_handoff>" in prompts[0]
    assert "旧目标：完成登录" in prompts[0]
    assert "继续补测试" in prompts[0]
    assert "<workstep_context_handoff>" not in prompts[1]


@pytest.mark.anyio
@pytest.mark.parametrize("provider_only", [False, True])
@pytest.mark.parametrize("reload_memory", [False, True])
@pytest.mark.parametrize("explicit_handoff", [False, True])
@pytest.mark.parametrize("original_provider", ["", "provider-a"])
async def test_unsent_handoffs_return_to_original_engine_session(
    chat_module, monkeypatch, provider_only, reload_memory, explicit_handoff, original_provider,
):
    module, _bus, manager, project, config = chat_module
    config.values["providers"] = [
        {"id": name, "protocol": "openai_compatible", "enabled": True}
        for name in ("provider-a", "provider-b", "provider-c")
    ]
    class ResumeEngine(FakeEngine):
        supports_resume = True

    monkeypatch.setattr("agent_assistants.chat_session.create_engine", lambda _: ResumeEngine())
    source = module.create_session(project.id, engine="claude", provider_id=original_provider)
    calls = []

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, **kwargs):
        calls.append((engine_id, prompt, session_id, kwargs.get("message_history")))
        return "完成", [], "original-thread"

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    first = module.submit_message(project.id, source["id"], "原始请求", "original")
    assert await _wait_turn(module, first.turn_id) == "completed"
    def seed_state(_project):
        row = ChatSession.get_by_id(source["id"])
        row.engine_state_json = json.dumps({"history": ["original-state"]})
        row.save()
    await manager.run_db(project.id, seed_state)
    module._sessions[module._session_identity(project.id, source["id"])[0]].engine_state = {"history": ["original-state"]}
    for engine, provider in [("pydantic_ai", "provider-b"), ("codex_sdk", "provider-c")]:
        await manager.run_db(project.id, lambda _project: module.handoff_session(
            project.id, source["id"], engine="claude" if provider_only else engine,
            provider_id=provider, context_mode="smart",
        ))
    if reload_memory:
        module._sessions.clear()
    if explicit_handoff:
        await manager.run_db(project.id, lambda _: module.handoff_session(
            project.id, source["id"], engine="claude", provider_id=original_provider, context_mode="smart",
        ))
    accepted = await manager.run_db(project.id, lambda _project: module.submit_message(
        project.id, source["id"], "切回原配置", "return-original",
        engine="claude", provider_id=original_provider, schedule=False,
    ))
    module.start_queued_turn(accepted.turn_id)
    assert await _wait_turn(module, accepted.turn_id) == "completed"
    assert calls[-1] == ("claude", "切回原配置", "original-thread", {"history": ["original-state"]})
    detail = await manager.run_db(project.id, lambda _: module.get_session(project.id, source["id"]))
    assert (detail["provider_id"] or "") == original_provider


@pytest.mark.anyio
async def test_new_message_prevents_restoring_unsent_handoff_state(chat_module):
    module, _bus, manager, project, _config = chat_module
    source = module.create_session(project.id, engine="claude")
    def switch(_project):
        row = ChatSession.get_by_id(source["id"])
        row.engine_session_id = "original-thread"
        row.save()
        module.handoff_session(project.id, source["id"], engine="pydantic_ai", context_mode="smart")
        ChatMessage.create(id="committed-message", session=row, role="user", content="新消息提交了当前选择", created_at=utc_now())
        module.handoff_session(project.id, source["id"], engine="claude", context_mode="smart")
        row = ChatSession.get_by_id(source["id"])
        assert row.engine_session_id is None
        assert json.loads(row.fork_context_json)["target_engine"] == "claude"
    await manager.run_db(project.id, switch)


@pytest.mark.anyio
async def test_handoff_return_chat_api_slow_database_keeps_health_responsive(chat_module, monkeypatch):
    import main
    module, _bus, manager, project, _config = chat_module
    source = module.create_session(project.id, engine="claude")
    await manager.run_db(project.id, lambda _: module.handoff_session(
        project.id, source["id"], engine="pydantic_ai", context_mode="smart",
    ))
    entered = threading.Event()
    release = threading.Event()
    original_execute_sql = project.db.execute_sql

    def slow_return_query(sql, params=None, commit=None):
        if not entered.is_set() and 'COUNT' in sql and 'chat_messages' in sql:
            entered.set()
            release.wait(timeout=2)
        return original_execute_sql(sql, params)

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, **kwargs):
        assert "<workstep_context_handoff>" not in prompt
        return "完成", [], "restored-thread"

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    monkeypatch.setattr(project.db, "execute_sql", slow_return_query)
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        request = asyncio.create_task(client.post(
            f"/api/chat-sessions/{source['id']}/chat",
            json={"project_id": project.id, "engine": "claude", "provider_id": "", "content": "切回原配置"},
            headers={"Idempotency-Key": "restore-api"},
        ))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
            assert health.status_code == 200
        finally:
            release.set()
        response = await request
        assert response.status_code == 200
        assert await _wait_turn(module, response.json()["turn_id"]) == "completed"


@pytest.mark.anyio
async def test_cross_engine_handoff_continues_the_same_session(chat_module, monkeypatch):
    module, _bus, _manager, project, _ = chat_module
    source = module.create_session(project.id, title="同一会话", engine="claude")
    with module._project_ctx(project.id):
        row = ChatSession.get_by_id(source["id"])
        ChatMessage.create(
            id="same-session-user",
            session=row,
            role="user",
            content="旧目标：完成登录",
            created_at=utc_now(),
        )

    prompts: list[str] = []

    async def fake_invoke(
        engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None
    ):
        prompts.append(prompt)
        return "继续完成", [], "target-engine-session"

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    handed_off = module.handoff_session(
        project.id,
        source["id"],
        engine="pydantic_ai",
        context_mode="smart",
    )
    assert handed_off["id"] == source["id"]
    assert handed_off["engine"] == "pydantic_ai"
    with module._project_ctx(project.id) as loaded_project:
        row = ChatSession.get_by_id(source["id"])
        handoff_meta = json.loads(row.fork_context_json)
        handoff_path = loaded_project.workstep_dir / handoff_meta["relative_path"]
    assert len(row.fork_context_json) < 1000
    assert "旧目标：完成登录" not in row.fork_context_json
    assert handoff_path.exists()
    assert "旧目标：完成登录" in handoff_path.read_text(encoding="utf-8")

    accepted = module.submit_message(
        project.id,
        source["id"],
        "请继续",
        "same-session-handoff",
    )
    assert accepted.session_id == source["id"]
    assert await _wait_turn(module, accepted.turn_id) == "completed"

    detail = module.get_session(project.id, source["id"])
    assert detail is not None
    assert detail["engine"] == "pydantic_ai"
    assert len(module.list_sessions(project.id)) == 1
    assert [item["content"] for item in detail["messages"]] == [
        "旧目标：完成登录",
        "请继续",
        "继续完成",
    ]
    assert "<workstep_context_handoff>" in prompts[0]
    assert str(handoff_path.resolve()) in prompts[0]
    assert "旧目标：完成登录" not in prompts[0]
    assert not detail["messages"][-1].get("prompt")  # Fake invocation did not capture its input.
    with module._project_ctx(project.id):
        row = ChatSession.get_by_id(source["id"])
        assert row.fork_context_json is None


@pytest.mark.anyio
async def test_chat_global_prompt_is_separate_and_view_records_actual_input(
    chat_module, monkeypatch
):
    """Fixed global rules are independent of user input on every native turn."""
    import agent_assistants.chat_session as chat_service

    module, _bus, _manager, project, _ = chat_module
    custom_system = "你是项目专属架构助手。"
    module.set_system_prompt(project.id, custom_system)
    session = module.create_session(project.id, title="系统提示展示", engine="claude")
    sent_prompts: list[str] = []
    sent_instructions: list[str] = []

    class ResumeEngine(FakeEngine):
        supports_resume = True

    monkeypatch.setattr(chat_service, "create_engine", lambda _engine_id: ResumeEngine())

    async def fake_invoke(
        engine_id, model, cwd, prompt, session_id, on_event=None,
        message_history=None, system_prompt=None,
    ):
        sent_prompts.append(prompt)
        sent_instructions.append(system_prompt)
        await on_event(InternalEvent(type="prompt_input", data={
            "engine": engine_id, "attempt": 1, "session_id": session_id,
            "instruction_transport": "developer", "prompt": prompt,
            "system_prompt": system_prompt,
        }))
        return "完成", [], "engine-session"

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    first = module.submit_message(project.id, session["id"], "第一次", "chat-display-1")
    assert await _wait_turn(module, first.turn_id) == "completed"
    second = module.submit_message(project.id, session["id"], "第二次", "chat-display-2")
    assert await _wait_turn(module, second.turn_id) == "completed"

    assert sent_prompts == ["第一次", "第二次"]
    assert sent_instructions == [custom_system, custom_system]
    visible_prompt = module.get_session(project.id, session["id"])["messages"][-1]["prompt"]
    assert custom_system in visible_prompt
    assert "### 独立指令（developer）" in visible_prompt
    assert "原始调用记录" not in visible_prompt
    assert "第二次" in visible_prompt


@pytest.mark.anyio
async def test_repeated_engine_handoffs_append_only_new_visible_messages(
    chat_module,
    monkeypatch,
):
    module, _bus, _manager, project, _ = chat_module
    source = module.create_session(project.id, title="多次交接", engine="claude")
    with module._project_ctx(project.id):
        row = ChatSession.get_by_id(source["id"])
        ChatMessage.create(
            id="handoff-once-user",
            session=row,
            role="user",
            content="第一段历史",
            created_at=utc_now(),
        )

    async def fake_invoke(
        engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None
    ):
        return "新引擎回复", [], f"session-{engine_id}"

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    module.handoff_session(
        project.id,
        source["id"],
        engine="pydantic_ai",
        context_mode="full",
    )
    accepted = module.submit_message(
        project.id, source["id"], "第一次交接请求", "handoff-repeat-1"
    )
    assert await _wait_turn(module, accepted.turn_id) == "completed"

    module.handoff_session(
        project.id,
        source["id"],
        engine="claude",
        context_mode="smart",
    )
    with module._project_ctx(project.id) as loaded_project:
        row = ChatSession.get_by_id(source["id"])
        meta = json.loads(row.fork_context_json)
        records = [
            json.loads(line)
            for line in (loaded_project.workstep_dir / meta["relative_path"])
            .read_text(encoding="utf-8")
            .splitlines()
            if line.strip()
        ]

    message_records = [item for item in records if item.get("type") == "message"]
    contents = [item["content"] for item in message_records]
    assert contents.count("第一段历史") == 1
    assert contents.count("第一次交接请求") == 1
    assert contents.count("新引擎回复") == 1
    assert len([item for item in records if item.get("type") == "handoff_start"]) == 2


@pytest.mark.anyio
async def test_new_session_uses_chat_assistant_defaults(chat_module):
    """A new project chat inherits its own assistant settings, not coordinator settings."""
    module, _bus, _manager, project, config_store = chat_module
    config_store.values.update({
        "coordinator_default_engine": "claude",
        "coordinator_default_model": "coordinator-model",
        "coordinator_default_fast_model": "coordinator-fast",
        "assistant_defaults": {
            "chat_session": {
                "engine": "pydantic_ai",
                "provider_id": "chat-provider",
                "model": "chat-reasoning",
                "fast_model": "chat-fast",
            },
        },
        "providers": [{
            "id": "chat-provider",
            "protocol": "openai_compatible",
            "enabled": True,
        }],
    })

    created = module.create_session(project.id)

    assert created["engine"] == "pydantic_ai"
    assert created["provider_id"] == "chat-provider"
    assert created["model"] == "chat-reasoning"
    assert created["fast_model"] == "chat-fast"


@pytest.mark.anyio
async def test_new_session_explicit_engine_does_not_inherit_other_engine_models(
    chat_module,
):
    """Selecting another engine falls back to that engine's model configuration."""
    module, _bus, _manager, project, config_store = chat_module
    config_store.values.update({
        "assistant_defaults": {
            "chat_session": {
                "engine": "pydantic_ai",
                "provider_id": "chat-provider",
                "model": "chat-reasoning",
                "fast_model": "chat-fast",
            },
        },
        "engine_default_models": {"claude": "claude-default"},
    })

    created = module.create_session(project.id, engine="claude")

    assert created["engine"] == "claude"
    assert created["provider_id"] is None
    assert created["model"] == "claude-default"
    assert created["fast_model"] == "claude-default"


@pytest.mark.anyio
async def test_existing_session_engine_switch_uses_target_engine_defaults(
    chat_module,
    monkeypatch,
):
    """切换会话引擎后，“跟随默认”使用目标引擎的供应商与模型。"""
    module, _bus, _manager, project, config_store = chat_module
    config_store.values.update({
        "assistant_defaults": {
            "chat_session": {
                "engine": "pydantic_ai",
                "provider_id": "chat-provider",
                "model": "qwen3.8-27b-mtplx-optimized-speed",
            },
        },
        "engine_default_models": {"codex_sdk": "gpt-5.6-codex"},
        "providers": [{
            "id": "chat-provider",
            "protocol": "openai_compatible",
            "enabled": True,
        }],
    })
    captured: dict = {}

    async def fake_invoke_engine(*args, **kwargs):
        captured["model"] = args[1]
        captured["config_overrides"] = kwargs.get("config_overrides")
        return "已切换", [], None

    monkeypatch.setattr("agent_assistants.base.invoke_engine", fake_invoke_engine)
    created = module.create_session(project.id)
    assert created["provider_id"] == "chat-provider"
    handed_off = module.handoff_session(
        project.id,
        created["id"],
        engine="codex_sdk",
        context_mode="smart",
    )
    assert handed_off["model"] is None
    config_store.values["engine_default_models"]["codex_sdk"] = "gpt-6-codex"

    accepted = module.submit_message(
        project.id,
        created["id"],
        "使用 Codex",
        "switch-engine-provider-default",
        engine="codex_sdk",
        model=None,
        provider_id=None,
    )

    assert await _wait_turn(module, accepted.turn_id) == "completed"
    detail = module.get_session(project.id, created["id"])
    assert detail["engine"] == "codex_sdk"
    assert detail["provider_id"] is None
    assert detail["model"] is None
    assert captured["model"] == "gpt-6-codex"
    assert captured["config_overrides"] is None


@pytest.mark.anyio
async def test_followup_message_inherits_session_provider_binding(
    chat_module,
    monkeypatch,
):
    """第二条消息只带 engine 不传 provider 时，沿用会话绑定的供应商。

    前端每条消息都携带 engine（空才省略），若后端以「请求没带 engine」
    作为是否继承会话配置的条件，第二条消息会丢失会话供应商、回落引擎
    默认，并且回写会把绑定抹掉。
    """
    module, _bus, _manager, project, config_store = chat_module
    config_store.values.update({
        "assistant_defaults": {
            "chat_session": {
                "engine": "pydantic_ai",
                "provider_id": "chat-provider",
                "model": "chat-model",
            },
        },
        "providers": [{
            "id": "chat-provider",
            "protocol": "openai_compatible",
            "enabled": True,
        }],
    })
    captured: dict = {}

    async def fake_invoke_engine(*args, **kwargs):
        captured.setdefault("calls", []).append(
            kwargs.get("config_overrides")
        )
        return "ok", [], None

    monkeypatch.setattr("agent_assistants.base.invoke_engine", fake_invoke_engine)
    created = module.create_session(project.id)
    assert created["provider_id"] == "chat-provider"

    first = module.submit_message(
        project.id, created["id"], "第一条", "bind-provider-1",
        engine="pydantic_ai", provider_id="chat-provider",
    )
    await _wait_turn(module, first.turn_id)

    # 第二条：前端本地状态缺 provider 时只发 engine。
    second = module.submit_message(
        project.id, created["id"], "第二条", "bind-provider-2",
        engine="pydantic_ai", provider_id=None,
    )
    assert await _wait_turn(module, second.turn_id) == "completed"

    assert captured["calls"][0] == {"provider_id": "chat-provider"}
    assert captured["calls"][1] == {"provider_id": "chat-provider"}
    detail = module.get_session(project.id, created["id"])
    assert detail["provider_id"] == "chat-provider"
    assert detail["model"] == "chat-model"


@pytest.mark.anyio
async def test_explicit_empty_provider_clears_session_binding(
    chat_module,
    monkeypatch,
):
    """显式传空 provider（选择「跟随默认」）会清掉会话绑定，而不是被忽略。"""
    module, _bus, _manager, project, config_store = chat_module
    config_store.values.update({
        "assistant_defaults": {
            "chat_session": {
                "engine": "pydantic_ai",
                "provider_id": "chat-provider",
            },
        },
        "providers": [{
            "id": "chat-provider",
            "protocol": "openai_compatible",
            "enabled": True,
        }],
    })
    captured: dict = {}

    async def fake_invoke_engine(*args, **kwargs):
        captured["config_overrides"] = kwargs.get("config_overrides")
        return "ok", [], None

    monkeypatch.setattr("agent_assistants.base.invoke_engine", fake_invoke_engine)
    created = module.create_session(project.id)

    accepted = module.submit_message(
        project.id, created["id"], "跟随默认", "clear-provider",
        engine="pydantic_ai", provider_id="",
    )
    assert await _wait_turn(module, accepted.turn_id) == "completed"
    assert captured["config_overrides"] is None
    detail = module.get_session(project.id, created["id"])
    assert detail["provider_id"] is None


@pytest.mark.anyio
async def test_engine_switch_inherits_compatible_provider(
    chat_module,
    monkeypatch,
):
    """显式换引擎且不传 provider：协议兼容的供应商跨引擎继承。"""
    module, _bus, _manager, project, config_store = chat_module
    config_store.values.update({
        "assistant_defaults": {
            "chat_session": {
                "engine": "pydantic_ai",
                "provider_id": "chat-provider",
                "model": "chat-model",
            },
        },
        "engine_default_models": {"claude": "claude-default"},
        "providers": [{
            "id": "chat-provider",
            "protocol": "openai_compatible",
            "enabled": True,
        }],
    })
    captured: dict = {}

    async def fake_invoke_engine(*args, **kwargs):
        captured["model"] = args[1]
        captured["config_overrides"] = kwargs.get("config_overrides")
        return "ok", [], None

    monkeypatch.setattr("agent_assistants.base.invoke_engine", fake_invoke_engine)
    created = module.create_session(project.id)

    accepted = module.submit_message(
        project.id, created["id"], "换引擎", "switch-engine-keep-provider",
        engine="claude", provider_id=None,
    )
    assert await _wait_turn(module, accepted.turn_id) == "completed"
    assert captured["config_overrides"] == {"provider_id": "chat-provider"}
    detail = module.get_session(project.id, created["id"])
    assert detail["engine"] == "claude"
    assert detail["provider_id"] == "chat-provider"
    # 模型是引擎特有的，不跨引擎继承。
    assert detail["model"] is None
    assert captured["model"] == "claude-default"


@pytest.mark.anyio
async def test_engine_switch_drops_incompatible_inherited_provider(
    chat_module,
    monkeypatch,
):
    """换引擎后继承的供应商协议不兼容：本轮跟随引擎默认并清掉绑定。"""
    module, _bus, _manager, project, config_store = chat_module
    config_store.values.update({
        "assistant_defaults": {
            "chat_session": {
                "engine": "pydantic_ai",
                "provider_id": "switched-provider",
                "model": "chat-model",
            },
        },
        "engine_default_models": {"claude": "claude-default"},
        "providers": [{
            "id": "switched-provider",
            "protocol": "openai_compatible",
            "enabled": True,
        }],
    })
    captured: dict = {}

    async def fake_invoke_engine(*args, **kwargs):
        captured["model"] = args[1]
        captured["config_overrides"] = kwargs.get("config_overrides")
        return "ok", [], None

    monkeypatch.setattr("agent_assistants.base.invoke_engine", fake_invoke_engine)
    created = module.create_session(project.id)

    # 供应商协议随后变更为与目标引擎不兼容（模拟供应商改协议 / 目标引擎
    # 只支持其它协议），再换引擎且不传 provider。
    config_store.values["providers"][0]["protocol"] = "anthropic_messages"

    accepted = module.submit_message(
        project.id, created["id"], "换引擎", "switch-engine-drop-provider",
        engine="claude", provider_id=None,
    )
    assert await _wait_turn(module, accepted.turn_id) == "completed"
    assert captured["config_overrides"] is None
    detail = module.get_session(project.id, created["id"])
    assert detail["engine"] == "claude"
    assert detail["provider_id"] is None
    assert captured["model"] == "claude-default"


@pytest.mark.anyio
async def test_chat_assistant_default_effort_follows_engine_config(
    chat_module,
    monkeypatch,
):
    """空思考强度不注入协调器默认值，由所选引擎自己的配置决定。"""
    module, _bus, _manager, project, config_store = chat_module
    config_store.values.update({
        "coordinator_default_engine": "claude",
        "coordinator_default_thinking_effort": "low",
        "assistant_defaults": {
            "chat_session": {
                "engine": "codex_sdk",
                "thinking_effort": "",
            },
        },
    })
    captured: dict = {}

    async def fake_invoke_engine(*args, **kwargs):
        captured.update(kwargs)
        return "已回复", [], None

    monkeypatch.setattr("agent_assistants.base.invoke_engine", fake_invoke_engine)
    created = module.create_session(project.id)
    accepted = module.submit_message(
        project.id,
        created["id"],
        "跟随引擎配置",
        "follow-engine-effort",
    )

    assert await _wait_turn(module, accepted.turn_id) == "completed"
    assert captured.get("thinking_effort") is None


@pytest.mark.anyio
async def test_chat_assistant_explicit_effort_still_overrides_engine(
    chat_module,
    monkeypatch,
):
    module, _bus, _manager, project, config_store = chat_module
    config_store.values.update({
        "coordinator_default_thinking_effort": "low",
        "assistant_defaults": {
            "chat_session": {"engine": "codex_sdk", "thinking_effort": "high"},
        },
    })
    captured: dict = {}

    async def fake_invoke_engine(*args, **kwargs):
        captured.update(kwargs)
        return "已回复", [], None

    monkeypatch.setattr("agent_assistants.base.invoke_engine", fake_invoke_engine)
    created = module.create_session(project.id)
    accepted = module.submit_message(
        project.id,
        created["id"],
        "使用显式强度",
        "explicit-effort",
    )

    assert await _wait_turn(module, accepted.turn_id) == "completed"
    assert captured.get("thinking_effort") == "high"


@pytest.mark.anyio
async def test_project_chat_routes_uploaded_image_message_to_vision_model(
    chat_module,
    monkeypatch,
):
    """An image message uses the project-chat vision model and forwards the image."""
    module, _bus, _manager, project, config_store = chat_module
    config_store.values["assistant_defaults"] = {
        "chat_session": {
            "engine": "pydantic_ai",
            "model": "chat-reasoning",
            "fast_model": "chat-fast",
            "vision_model": "chat-vision",
        },
    }
    upload = Path(project.workstep_dir) / "uploads" / "diagram.png"
    upload.parent.mkdir(parents=True, exist_ok=True)
    upload.write_bytes(b"fake-png")
    captured: dict = {}

    async def fake_invoke(
        engine_id,
        model,
        cwd,
        prompt,
        session_id,
        on_event=None,
        message_history=None,
        images=None,
    ):
        captured.update(model=model, images=images)
        return "看到了流程图", [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    session = module.create_session(project.id)
    accepted = module.submit_message(
        project.id,
        session["id"],
        "请分析这张图\n\n![流程图](.workstep/uploads/diagram.png)",
        "vision-message-1",
    )

    assert await _wait_turn(module, accepted.turn_id) == "completed"
    assert captured["model"] == "chat-vision"
    assert len(captured["images"]) == 1
    assert captured["images"][0].path == str(upload.resolve())


@pytest.mark.anyio
async def test_uploaded_image_extraction_accepts_legacy_project_display_name_path(
    chat_module,
):
    """Old messages remain readable when the display name differs from the folder."""
    _module, _bus, _manager, project, _config_store = chat_module
    project.name = "测试项目"
    upload = Path(project.workstep_dir) / "uploads" / "legacy.png"
    upload.parent.mkdir(parents=True, exist_ok=True)
    upload.write_bytes(b"fake-png")

    images = extract_uploaded_images(
        project,
        project.path,
        "![图片](测试项目/.workstep/uploads/legacy.png)",
    )

    assert [image.path for image in images] == [str(upload.resolve())]


@pytest.mark.anyio
async def test_reorder_sessions_persists_new_order(chat_module):
    """Drag-and-drop reorder reassigns sort_order and survives re-reads."""
    module, bus, manager, project, config_store = chat_module
    created = []
    for index in range(3):
        created.append(
            module.create_session(project.id, "wf-reorder", title=f"会话 {index}")
        )
    first_ids = [item["id"] for item in created]
    # New sessions are pinned at the top: newest first by default.
    assert [item["id"] for item in module.list_sessions(project.id)] == list(
        reversed(first_ids)
    )

    # Newest-first by default: the last created session is pinned at the top.
    module.reorder_sessions(project.id, [first_ids[2], first_ids[0], first_ids[1]])
    ordered = [item["id"] for item in module.list_sessions(project.id)]
    assert ordered == [first_ids[2], first_ids[0], first_ids[1]]

    # Persisted across a fresh list call (still the same DB rows).
    assert [item["id"] for item in module.list_sessions(project.id)] == [
        first_ids[2],
        first_ids[0],
        first_ids[1],
    ]

    # New sessions appear at the top of the manual order.
    fresh = module.create_session(project.id, "wf-reorder", title="新会话")
    assert [item["id"] for item in module.list_sessions(project.id)][0] == fresh["id"]


@pytest.mark.anyio
async def test_permission_mode_persists_on_session_and_submit(chat_module):
    """The composer's permission mode survives create / submit / get."""
    module, bus, manager, project, _ = chat_module

    created = module.create_session(
        project.id, "wf-perm", permission_mode="read-only"
    )
    session_id = created["id"]
    assert created["permission_mode"] == "read-only"

    listed = module.list_sessions(project.id)[0]
    assert listed["permission_mode"] == "read-only"

    detail = module.get_session(project.id, session_id)
    assert detail["permission_mode"] == "read-only"

    accepted = module.submit_message(
        project.id,
        session_id,
        "hello",
        idempotency_key="perm-key-1",
        permission_mode="auto",
    )
    assert accepted.status == "queued"
    detail = module.get_session(project.id, session_id)
    assert detail["permission_mode"] == "auto"

    with pytest.raises(ValueError):
        module.create_session(project.id, "wf-perm", permission_mode="bogus")
    with pytest.raises(ValueError):
        module.submit_message(
            project.id,
            session_id,
            "x",
            idempotency_key="perm-key-2",
            permission_mode="bogus",
        )


@pytest.mark.anyio
async def test_update_permission_mode_applies_to_running_engine_immediately(chat_module):
    """Changing a session permission updates both the active turn and persistence."""
    module, _bus, _manager, project, _ = chat_module
    session = module.create_session(
        project.id, "wf-live-permission", permission_mode="read-only"
    )

    class RunningEngine:
        def __init__(self):
            self.permission_modes: list[str] = []

        async def set_permission_mode(self, mode: str) -> None:
            self.permission_modes.append(mode)

    engine = RunningEngine()
    turn_id = "running-permission-turn"
    module._turn_states[turn_id] = {
        "session_id": session["id"],
        "status": "running",
        "permission_mode": "read-only",
    }
    module._running_engines[turn_id] = engine

    updated = await module.update_permission_mode(
        project.id, session["id"], "danger-full-access"
    )

    assert engine.permission_modes == ["danger-full-access"]
    assert module._turn_states[turn_id]["permission_mode"] == "danger-full-access"
    assert updated["permission_mode"] == "danger-full-access"
    assert module.get_session(project.id, session["id"])["permission_mode"] == (
        "danger-full-access"
    )


@pytest.mark.anyio
async def test_enhance_prompt_falls_back_to_default_engine(chat_module, monkeypatch):
    """Without Pydantic AI config, prompt enhancement falls back to the default chat engine."""
    module, bus, manager, project, config_store = chat_module
    calls: list[tuple] = []
    recorded_usage: list[dict] = []
    import main

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event, **kwargs):
        calls.append((engine_id, model, prompt, kwargs))
        return "改写后的清晰提示词。", [{
            "type": "usage_update",
            "data": {"input_tokens": 15, "output_tokens": 4},
        }], None

    async def record_usage(**kwargs):
        recorded_usage.append(kwargs)

    def kwargs_of(call):
        return call[3]

    config_store.set("coordinator_default_model", "slow-model")
    config_store.set("coordinator_default_fast_model", "fast-model")
    monkeypatch.setattr("agent_assistants.base.invoke_engine", fake_invoke)
    monkeypatch.setattr(main.gateway_client, "record_one_shot_usage", record_usage)
    result = await module.enhance_prompt(project.id, "帮我写个函数")
    assert result == "改写后的清晰提示词。"
    assert calls
    assert calls[0][0] in ("codex", "claude", "claude_agent_sdk")
    assert calls[0][1] == "fast-model"
    assert "帮我写个函数" in calls[0][2]
    assert kwargs_of(calls[0])["thinking_effort"] == "minimal"
    assert kwargs_of(calls[0])["permission_mode"] == "auto"
    assert recorded_usage == [{
        "project_id": project.id, "model": "fast-model", "provider": None,
        "usage": {"input_tokens": 15, "output_tokens": 4},
    }]

    with pytest.raises(ValueError):
        await module.enhance_prompt(project.id, "   ")


@pytest.mark.anyio
async def test_enhance_prompt_uses_configured_provider_protocol(chat_module, monkeypatch):
    """The configured provider protocol is forwarded to the one-shot request."""
    module, bus, manager, project, config_store = chat_module
    config_store.set_prompt_enhance_config(
        provider_id="p-1",
        model="fast-model-x",
        protocol="anthropic_messages",
    )
    config_store.values["providers"] = [
        {
            "id": "p-1",
            "base_url": "http://localhost:1/v1",
            "api_key": "k",
            "enabled": True,
            "protocols": ["anthropic_messages"],
            "prices": {"version": "v1"},
            "managed_revision": 3,
        }
    ]
    calls: list[dict] = []
    pydantic_calls: list = []
    invoke_calls: list = []
    recorded_usage: list[dict] = []

    import main

    async def record_usage(**kwargs):
        recorded_usage.append(kwargs)

    monkeypatch.setattr(main.gateway_client, "record_one_shot_usage", record_usage)

    async def fake_text_completion(provider, model, messages, **kwargs):
        calls.append({
            "provider": provider["id"],
            "model": model,
            "messages": messages,
            "protocol": kwargs.get("protocol"),
        })
        kwargs["usage_collector"].update({"input_tokens": 12, "output_tokens": 3})
        provider["prices"]["version"] = "v2"
        provider["managed_revision"] = 4
        return "改写后的清晰提示词。"

    async def fake_simple(prompt, **kwargs):
        pydantic_calls.append(prompt)
        return "回退后的提示词。"

    async def fake_invoke(*args, **kwargs):
        invoke_calls.append(args)
        return "", [], None

    monkeypatch.setattr(
        "services.providers.text_completion",
        fake_text_completion,
    )
    monkeypatch.setattr(
        "engines.pydantic_ai.engine.PydanticAIEngine.run_simple",
        fake_simple,
    )
    monkeypatch.setattr("agent_assistants.base.invoke_engine", fake_invoke)

    result = await module.enhance_prompt(project.id, "帮我写个函数")
    assert result == "改写后的清晰提示词。"
    assert calls and calls[0]["model"] == "fast-model-x"
    assert calls[0]["messages"][-1]["content"] == "帮我写个函数"
    assert calls[0]["messages"][0]["role"] == "system"
    assert calls[0]["protocol"] == "anthropic_messages"
    assert not pydantic_calls and not invoke_calls
    assert len(recorded_usage) == 1
    assert recorded_usage[0]["project_id"] == project.id
    assert recorded_usage[0]["model"] == "fast-model-x"
    assert recorded_usage[0]["provider"]["id"] == "p-1"
    assert recorded_usage[0]["provider"]["prices"]["version"] == "v1"
    assert recorded_usage[0]["provider"]["managed_revision"] == 3
    assert recorded_usage[0]["usage"] == {"input_tokens": 12, "output_tokens": 3}

    # 清空配置后回退 Pydantic AI 路径
    config_store.set_prompt_enhance_config(provider_id="", model="")
    await module.enhance_prompt(project.id, "帮我写个函数")
    assert pydantic_calls and not invoke_calls


@pytest.mark.anyio
async def test_enhance_prompt_uses_pydantic_ai_without_context(chat_module, monkeypatch):
    """Prompt enhancement prefers the built-in Pydantic AI one-shot (no context)."""
    module, bus, manager, project, config_store = chat_module
    config_store.values["pydantic_ai_engine"] = {
        "provider_id": "p-1",
        "model": "fast-model-x",
    }
    config_store.values["providers"] = [
        {"id": "p-1", "base_url": "http://localhost:1/v1", "api_key": "k", "enabled": True}
    ]
    prompts: list[str] = []
    invoke_calls: list = []
    recorded_usage: list[dict] = []
    import main

    async def fake_simple(prompt, usage_details=None):
        prompts.append(prompt)
        usage_details.update({
            "provider": {"id": "p-1", "prices": {"version": "v1"}},
            "model": "fast-model-x",
            "usage": {"input_tokens": 7, "output_tokens": 2},
        })
        return "改写后的清晰提示词。"

    async def fake_invoke(*args, **kwargs):
        invoke_calls.append(args)
        return "", [], None

    monkeypatch.setattr(
        "engines.pydantic_ai.engine.PydanticAIEngine.run_simple",
        fake_simple,
    )
    monkeypatch.setattr("agent_assistants.base.invoke_engine", fake_invoke)
    async def record_usage(**kwargs):
        recorded_usage.append(kwargs)
    monkeypatch.setattr(main.gateway_client, "record_one_shot_usage", record_usage)

    result = await module.enhance_prompt(project.id, "帮我写个函数")
    assert result == "改写后的清晰提示词。"
    assert prompts and "帮我写个函数" in prompts[0]
    assert not invoke_calls  # 不经过协调引擎
    assert recorded_usage == [{
        "project_id": project.id,
        "model": "fast-model-x",
        "provider": {"id": "p-1", "prices": {"version": "v1"}},
        "usage": {"input_tokens": 7, "output_tokens": 2},
    }]


async def test_session_auto_titles_from_first_sentence(chat_module, monkeypatch):
    """A session without a title takes its first user sentence as the title."""
    module, bus, manager, project, _ = chat_module

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None):
        return "好的", [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    session = module.create_session(project.id, "wf-title", title="")
    session_id = session["id"]
    assert session["title"] == "未命名会话"

    accepted = module.submit_message(
        project.id,
        session_id,
        "帮我实现用户登录模块，包括注册与找回密码。第二句别管。",
        "idem-title-1",
    )
    assert await _wait_turn(module, accepted.turn_id) == "completed"

    detail = module.get_session(project.id, session_id)
    assert detail["title"] == "帮我实现用户登录模块，包括注册与找回密码"


async def test_chat_messages_go_to_new_tables_not_task_tables(chat_module, monkeypatch):
    """A chat turn persists only into chat_messages — never tasks/messages."""
    module, bus, manager, project, _ = chat_module

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None):
        return "这是一段会话回复", [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    session = module.create_session(project.id, "wf-2")
    accepted = module.submit_message(
        project.id, session["id"], "帮我解释一下项目结构", "idem-1"
    )
    status = await _wait_turn(module, accepted.turn_id)
    assert status == "completed"

    rows = ChatMessage.select().where(ChatMessage.session == session["id"]).order_by(ChatMessage.created_at)
    assert [row.role for row in rows] == ["user", "assistant"]
    assert rows[0].content == "帮我解释一下项目结构"
    assert rows[1].content == "这是一段会话回复"
    assert rows[1].ended_at is not None
    assert rows[1].ended_at >= rows[1].created_at

    from models.message import Message
    from models.task import Task

    assert Message.select().count() == 0
    assert Task.select().count() == 0

    # The session row was auto-titled from the first user message.
    row = ChatSession.get_by_id(session["id"])
    assert row.title == "帮我解释一下项目结构"

    # A fresh runtime re-loads the conversation from the chat tables.
    reloaded = ChatSessionModule(bus, manager)
    history = reloaded.history(project.id, session["id"])
    assert history is not None
    assert [item["role"] for item in history["messages"]] == ["user", "assistant"]
    assert history["messages"][-1]["content"] == "这是一段会话回复"
    assert history["messages"][-1]["ended_at"]
    assert history["messages"][-1]["created_at"] <= history["messages"][-1]["ended_at"]
    await reloaded.shutdown()


@pytest.mark.anyio
async def test_chat_history_converts_legacy_visualize_markers(chat_module, monkeypatch):
    """已落库的旧消息在历史读取时也要转成 Markdown 文件链接。"""
    module, bus, manager, project, _ = chat_module

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None):
        return "旧回复", [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    session = module.create_session(project.id, "wf-legacy")
    accepted = module.submit_message(project.id, session["id"], "看看", "idem-legacy")
    assert await _wait_turn(module, accepted.turn_id) == "completed"

    path = (
        "/Users/example/workstep/.workstep/visualizations/"
        "stage-progress-card-prototypes.html"
    )
    marker = '\ue200visualize{"path":"<path>","mode":"wide"}\ue201'.replace("<path>", path)
    row = ChatMessage.select().where(ChatMessage.role == "assistant").get()
    ChatMessage.update(content=f"旧回复\n\n{marker}").where(
        ChatMessage.id == row.id
    ).execute()

    history = module.history(project.id, session["id"])
    assert history is not None
    content = history["messages"][-1]["content"]
    assert content == (
        "旧回复\n\n"
        "[stage-progress-card-prototypes.html]"
        f"(file://{path})"
    )
    assert "\ue200" not in content


@pytest.mark.anyio
async def test_chat_history_converts_bare_visualize_marker(chat_module, monkeypatch):
    """新版 Codex 裸标记 ``visualize{JSON}`` 没有私有分隔符，历史读取仍需转换。"""
    module, bus, manager, project, _ = chat_module

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None):
        return "旧回复", [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    session = module.create_session(project.id, "wf-bare")
    accepted = module.submit_message(project.id, session["id"], "看看", "idem-bare")
    assert await _wait_turn(module, accepted.turn_id) == "completed"

    path = (
        "/Users/example/workstep/.workstep/visualizations/"
        "stage-progress-card-prototypes.html"
    )
    bare = f'visualize{{"path":"{path}","mode":"wide"}}'
    row = ChatMessage.select().where(ChatMessage.role == "assistant").get()
    ChatMessage.update(content=f"旧回复\n\n{bare}").where(
        ChatMessage.id == row.id
    ).execute()

    history = module.history(project.id, session["id"])
    assert history is not None
    content = history["messages"][-1]["content"]
    assert content == (
        "旧回复\n\n"
        "[stage-progress-card-prototypes.html]"
        f"(file://{path})"
    )
    assert bare not in content


@pytest.mark.anyio
async def test_chat_history_converts_visualize_marker_in_events(chat_module, monkeypatch):
    """历史 events 里的正文 chunk 也要转换，避免前端交织渲染再次露出裸标记。"""
    module, bus, manager, project, _ = chat_module

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None):
        return "旧回复", [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    session = module.create_session(project.id, "wf-bare-events")
    accepted = module.submit_message(project.id, session["id"], "看看", "idem-bare-events")
    assert await _wait_turn(module, accepted.turn_id) == "completed"

    path = (
        "/Users/example/workstep/.workstep/visualizations/"
        "stage-progress-card-prototypes.html"
    )
    bare = f'visualize{{"path":"{path}","mode":"wide"}}'
    row = ChatMessage.select().where(ChatMessage.role == "assistant").get()
    with module._project_ctx(project.id):
        ChatMessage.update(
            engine="codex_sdk",
            content=f"旧回复\n\n{bare}",
            events_json=json.dumps([{
                "type": "agent_message_chunk",
                "data": {"content": {"text": f"旧回复\n\n{bare}"}},
            }], ensure_ascii=False),
        ).where(ChatMessage.id == row.id).execute()

    history = module.history(project.id, session["id"])
    assert history is not None
    events = history["messages"][-1]["events"]
    text = events[0]["data"]["content"]["text"]
    assert text == (
        "旧回复\n\n"
        "[stage-progress-card-prototypes.html]"
        f"(file://{path})"
    )
    assert bare not in text


@pytest.mark.anyio
async def test_submitted_user_message_survives_reload_while_turn_is_running(
    chat_module,
    monkeypatch,
):
    """重新进入执行中的会话时，已提交的用户消息仍能从历史记录恢复。"""
    module, _bus, _manager, project, _ = chat_module
    invoke_started = asyncio.Event()
    release_invoke = asyncio.Event()

    async def blocking_invoke(
        engine_id,
        model,
        cwd,
        prompt,
        session_id,
        on_event=None,
        message_history=None,
    ):
        invoke_started.set()
        await release_invoke.wait()
        return "回复", [], None

    monkeypatch.setattr(module, "_invoke", blocking_invoke)

    session = module.create_session(project.id, "wf-running-reload")
    accepted = module.submit_message(
        project.id,
        session["id"],
        "这条消息不能丢",
        "idem-running-reload-1",
    )
    await asyncio.wait_for(invoke_started.wait(), timeout=1)

    detail = module.get_session(project.id, session["id"])
    assert [(item["role"], item["content"]) for item in detail["messages"]] == [
        ("user", "这条消息不能丢"),
        ("assistant", ""),
    ]
    assert detail["messages"][-1]["status"] == "running"
    assert detail["messages"][-1]["event_detail"]["available"] is True

    release_invoke.set()
    assert await _wait_turn(module, accepted.turn_id) == "completed"


@pytest.mark.anyio
async def test_running_chat_accepts_and_persists_live_message(
    chat_module,
    monkeypatch,
):
    """运行中的会话允许像任务阶段一样插入普通用户消息。"""
    module, _bus, manager, project, _ = chat_module
    invoke_started = asyncio.Event()

    async def blocking_invoke(
        engine_id,
        model,
        cwd,
        prompt,
        session_id,
        on_event=None,
        message_history=None,
    ):
        invoke_started.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(module, "_invoke", blocking_invoke)
    session = module.create_session(project.id, "wf-live-message")
    accepted = module.submit_message(
        project.id,
        session["id"],
        "先执行一个长任务",
        "idem-live-message-1",
    )
    await asyncio.wait_for(invoke_started.wait(), timeout=1)

    from services.pending_message_inserts import (
        create_pending_insert,
        list_pending_inserts,
    )

    queued = await manager.run_db(
        project.id,
        lambda _project: create_pending_insert(
            accepted.assistant_message_id,
            "改为先补测试",
            "测试用户",
        ),
    )

    import agent_assistants.base as assistant_base

    original_factory = assistant_base.create_engine

    def slow_factory(engine_id):
        time.sleep(0.15)
        return original_factory(engine_id)

    monkeypatch.setattr(assistant_base, "create_engine", slow_factory)
    started = time.monotonic()
    insertion = asyncio.create_task(module.send_live_message(
        session["id"],
        "改为先补测试",
        pending_insert_ids=[queued["id"]],
    ))
    await asyncio.sleep(0.01)
    assert time.monotonic() - started < 0.1
    inserted = await insertion

    assert inserted["status"] == "queued"
    queue = module._turn_states[accepted.turn_id]["live_message_queue"]
    assert queue.get_nowait() == (inserted["message_id"], "改为先补测试")
    detail = module.get_session(project.id, session["id"])
    assert detail["messages"][-1]["role"] == "user"
    assert detail["messages"][-1]["content"] == "改为先补测试"
    assert await manager.run_db(
        project.id,
        lambda _project: list_pending_inserts(accepted.assistant_message_id),
    ) == []

    assert await module.stop_current(session["id"]) is True
    assert await _wait_turn(module, accepted.turn_id) == "stopped"


@pytest.mark.anyio
async def test_completed_chat_merges_persisted_pending_inserts_into_one_turn(
    chat_module,
    monkeypatch,
):
    """页面不参与调度；回复结束后后端合并队列并自动启动下一轮。"""
    module, _bus, manager, project, _ = chat_module
    release_first = asyncio.Event()
    prompts: list[str] = []

    async def invoke(
        engine_id,
        model,
        cwd,
        prompt,
        session_id,
        on_event=None,
        message_history=None,
    ):
        prompts.append(prompt)
        if len(prompts) == 1:
            await release_first.wait()
        return f"回复 {len(prompts)}", [], None

    monkeypatch.setattr(module, "_invoke", invoke)
    session = module.create_session(project.id, "wf-pending-inserts")
    first = module.submit_message(
        project.id,
        session["id"],
        "开始执行",
        "pending-first",
    )
    while module._turn_states[first.turn_id]["status"] != "running":
        await asyncio.sleep(0)

    from services.pending_message_inserts import (
        create_pending_insert,
        list_pending_inserts,
    )
    from services.remote_access import ActorSnapshot, actor_context

    with actor_context(ActorSnapshot(
        actor_id="user-xw", user_name="小王", username="xiaowang",
        device_id="device-xw", device_name="办公室电脑", source="managed",
    )):
        await manager.run_db(
            project.id,
            lambda _project: (
                create_pending_insert(first.assistant_message_id, "补充一", "小王"),
                create_pending_insert(first.assistant_message_id, "补充二", "小王"),
            ),
        )
    release_first.set()

    deadline = time.monotonic() + 2
    while len(prompts) < 2 and time.monotonic() < deadline:
        await asyncio.sleep(0.01)
    assert len(prompts) == 2
    second_turn_id = next(
        turn_id for turn_id in module._turn_states if turn_id != first.turn_id
    )
    assert await _wait_turn(module, second_turn_id) == "completed"

    detail = module.get_session(project.id, session["id"])
    assert [item["content"] for item in detail["messages"] if item["role"] == "user"] == [
        "开始执行",
        "补充一\n\n补充二",
    ]
    assert detail["messages"][2]["author_name"] == "小王"
    assert detail["messages"][2]["author_id"] == "user-xw"
    assert detail["messages"][2]["author_username"] == "xiaowang"
    assert detail["messages"][3]["initiated_by_user_id"] == "user-xw"
    remaining = await manager.run_db(
        project.id,
        lambda _project: list_pending_inserts(first.assistant_message_id),
    )
    assert remaining == []


@pytest.mark.anyio
@pytest.mark.parametrize("send_all", [False, True])
async def test_live_insert_keeps_other_pending_messages_on_new_reply(
    chat_module,
    monkeypatch,
    send_all,
):
    module, _bus, manager, project, _ = chat_module
    first_chunk_sent = asyncio.Event()
    allow_split = asyncio.Event()
    reply_split = asyncio.Event()
    finish_reply = asyncio.Event()

    async def injecting_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, **kwargs):
        await on_event(InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": "第一段输出"}},
        ))
        first_chunk_sent.set()
        state = next(state for state in module._turn_states.values()
                     if state.get("status") == "running")
        message_id, _content = await state["live_message_queue"].get()
        await allow_split.wait()
        await on_event(InternalEvent(
            type="live_message",
            data={"message_id": message_id, "status": "delivered"},
        ))
        reply_split.set()
        await finish_reply.wait()
        return "第二段输出", [], None

    monkeypatch.setattr(module, "_invoke", injecting_invoke)
    session = module.create_session(project.id, "wf-live-pending-order")
    accepted = module.submit_message(
        project.id, session["id"], "开始执行", "idem-live-pending-order",
    )
    await asyncio.wait_for(first_chunk_sent.wait(), timeout=1)

    from services.pending_message_inserts import create_pending_insert, list_pending_inserts

    queued = await manager.run_db(project.id, lambda _project: [
        create_pending_insert(accepted.assistant_message_id, content, "测试用户")
        for content in ("1", "2", "3", "4")
    ])
    selected = queued if send_all else [queued[2]]
    await module.send_live_message(
        session["id"],
        "\n\n".join(item["content"] for item in selected),
        pending_insert_ids=[item["id"] for item in selected],
    )
    entered_db = threading.Event()
    release_db = threading.Event()
    save_session = module._config.persistence.save

    def slow_save(*args, **kwargs):
        entered_db.set()
        release_db.wait(timeout=2)
        return save_session(*args, **kwargs)

    monkeypatch.setattr(module._config.persistence, "save", slow_save)
    try:
        canary_started = time.perf_counter()
        allow_split.set()
        assert await asyncio.to_thread(entered_db.wait, 1)
        await asyncio.wait_for(asyncio.sleep(0.01), timeout=0.2)
        assert time.perf_counter() - canary_started < 0.2
        release_db.set()
        await asyncio.wait_for(reply_split.wait(), timeout=1)
        next_target = module._turn_states[accepted.turn_id]["assistant_message_id"]
        old_pending = await manager.run_db(
            project.id,
            lambda _project: list_pending_inserts(accepted.assistant_message_id),
        )
        new_pending = await manager.run_db(
            project.id, lambda _project: list_pending_inserts(next_target),
        )
        assert old_pending == []
        assert [(item["id"], item["content"]) for item in new_pending] == (
            [] if send_all else [
                (queued[index]["id"], str(index + 1)) for index in (0, 1, 3)
            ]
        )
    finally:
        release_db.set()
        finish_reply.set()


@pytest.mark.anyio
async def test_opencode_live_interrupt_seals_old_reply_before_new_output(chat_module, monkeypatch):
    from .test_acp_live_interrupt import _FakeClient, _OpencodeProbe, _install_fake

    module, bus, manager, project, _ = chat_module
    engine = _OpencodeProbe()
    client = _FakeClient()
    _install_fake(monkeypatch, client)
    monkeypatch.setattr(engine, "_map_notification", lambda event: event)
    first_output = asyncio.Event()
    replacement_output = asyncio.Event()
    finish_replacement = asyncio.Event()
    streamed = bus.subscribe()

    async def prompt(session_id, prompt, **kwargs):
        client.prompts.append(list(prompt))
        first = len(client.prompts) == 1
        await client.handler.updates.put(InternalEvent(
            "agent_message_chunk", {"content": {"text": "旧回复" if first else "新回复"}},
        ))
        if first:
            await client.cancel_event.wait()
            return SimpleNamespace(stop_reason="cancelled")
        await finish_replacement.wait()
        return SimpleNamespace(stop_reason="end_turn")

    client.prompt = prompt

    async def invoke(engine_id, model, cwd, prompt, session_id, on_event=None, **kwargs):
        state = next(state for state in module._turn_states.values() if state["status"] == "running")
        events = []
        async for event in engine.spawn(
            prompt=prompt, cwd=cwd, live_message_queue=state["live_message_queue"],
        ):
            events.append(event.to_dict())
            await on_event(event)
            if event.type == "agent_message_chunk":
                if event.data["content"]["text"] == "旧回复":
                    first_output.set()
                else:
                    replacement_output.set()
        return "旧回复新回复", events, None

    monkeypatch.setattr(module, "_invoke", invoke)
    session = module.create_session(project.id, "wf-opencode-order")
    accepted = module.submit_message(project.id, session["id"], "原问题", "opencode-order")
    try:
        await asyncio.wait_for(first_output.wait(), timeout=2)
        inserted = await module.send_live_message(session["id"], "新问题")
        await asyncio.wait_for(replacement_output.wait(), timeout=2)
        # 新回复仍在运行时，旧回复已经完成，且新输出拥有独立消息 ID。
        events = []
        while not streamed.empty():
            events.append(streamed.get_nowait())
        old_end = next(i for i, e in enumerate(events)
                       if e["type"] == "TEXT_MESSAGE_END" and e["messageId"] == accepted.assistant_message_id)
        new_chunk = next(i for i, e in enumerate(events)
                         if e["type"] == "TEXT_MESSAGE_CHUNK" and e.get("delta") == "新回复")
        new_start = next(i for i, e in enumerate(events)
                         if e["type"] == "TEXT_MESSAGE_START" and e["messageId"] == events[new_chunk]["messageId"])
        user_start = next(i for i, e in enumerate(events)
                          if e["type"] == "TEXT_MESSAGE_START" and e["messageId"] == inserted["message_id"])
        assert user_start < new_start < new_chunk
        assert old_end < new_start
        assert events[new_chunk]["messageId"] != accepted.assistant_message_id
    finally:
        finish_replacement.set()
    assert await _wait_turn(module, accepted.turn_id) == "completed"
    detail = await manager.run_db(project.id, lambda _project: module.get_session(project.id, session["id"]))
    assert [m["content"] for m in detail["messages"]] == ["原问题", "旧回复", "新问题", "新回复"]
    assert [m["status"] for m in detail["messages"] if m["role"] == "assistant"] == ["succeeded", "succeeded"]


@pytest.mark.anyio
async def test_live_message_splits_chat_reply_around_inserted_user_message(
    chat_module,
    monkeypatch,
):
    """会话顺序与任务阶段一致：第一段输出 → 用户插入 → 第二段输出。"""
    module, _bus, _manager, project, _ = chat_module
    import main
    recorded_usage = []

    async def record_usage(**kwargs):
        recorded_usage.append(kwargs)

    monkeypatch.setattr(main.gateway_client, "record_message_usage", record_usage)
    first_chunk_sent = asyncio.Event()

    async def injecting_invoke(
        engine_id,
        model,
        cwd,
        prompt,
        session_id,
        on_event=None,
        message_history=None,
    ):
        first = InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": "第一段输出"}},
        )
        await on_event(first)
        first_chunk_sent.set()
        state = next(
            state for state in module._turn_states.values()
            if state.get("status") == "running"
        )
        message_id, _content = await state["live_message_queue"].get()
        delivered = InternalEvent(
            type="live_message",
            data={"message_id": message_id, "status": "delivered"},
        )
        await on_event(delivered)
        second = InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": "第二段输出"}},
        )
        await on_event(second)
        return "第一段输出第二段输出", [
            first.to_dict(), delivered.to_dict(), second.to_dict(),
        ], None

    monkeypatch.setattr(module, "_invoke", injecting_invoke)
    session = module.create_session(project.id, "wf-live-order")
    accepted = module.submit_message(
        project.id,
        session["id"],
        "开始执行",
        "idem-live-order-1",
    )
    await asyncio.wait_for(first_chunk_sent.wait(), timeout=1)
    await module.send_live_message(session["id"], "插入要求")
    assert await _wait_turn(module, accepted.turn_id) == "completed"

    detail = module.get_session(project.id, session["id"])
    assert [item["role"] for item in detail["messages"]] == [
        "user", "assistant", "user", "assistant",
    ]
    assert [item["content"] for item in detail["messages"]] == [
        "开始执行", "第一段输出", "插入要求", "第二段输出",
    ]
    assert detail["messages"][1]["status"] == "succeeded"
    assert detail["messages"][3]["status"] == "succeeded"
    assert "插入要求" in detail["messages"][3]["prompt"]
    assert detail["messages"][3]["author_id"] == detail["messages"][3]["engine"]
    assert detail["messages"][3]["author_type"] == "assistant"
    assert (detail["messages"][3]["initiated_by_user_id"]
            == detail["messages"][2]["author_id"])
    assert [item["message_id"] for item in recorded_usage] == [detail["messages"][3]["id"]]


@pytest.mark.anyio
@pytest.mark.parametrize("ending", ["completed", "error", "stopped"])
async def test_commentary_is_preserved_in_live_and_reloaded_chat_only_as_process(
    chat_module, monkeypatch, ending,
):
    module, bus, manager, project, _ = chat_module
    queue = bus.subscribe()

    async def invoke(engine_id, model, cwd, prompt, session_id, on_event=None, **kwargs):
        await on_event(InternalEvent("agent_message_chunk", {
            "content": {"text": "我先定位组件。"}, "phase": "commentary", "source_item_id": "progress",
        }))
        if ending == "error":
            raise RuntimeError("测试失败")
        if ending == "stopped":
            raise asyncio.CancelledError
        await on_event(InternalEvent("agent_message_chunk", {
            "content": {"text": "完成。"}, "phase": "final_answer", "source_item_id": "answer",
        }))
        return "完成。", [], None

    monkeypatch.setattr(module, "_invoke", invoke)
    session = module.create_session(project.id)
    accepted = module.submit_message(project.id, session["id"], "检查", f"phases-{ending}")
    assert await _wait_turn(module, accepted.turn_id) == ending
    streamed = []
    while not queue.empty():
        streamed.append(queue.get_nowait())
    commentary = [event for event in streamed if event.get("phase") == "commentary"]
    assert len(commentary) == 1
    assert commentary[0]["delta"] == "我先定位组件。"
    assert commentary[0]["source_item_id"] == "progress"

    restored = ChatSessionModule(bus, manager)
    try:
        history = restored.history(project.id, session["id"])
        message = history["messages"][-1]
        assert message["content"] == {
            "completed": "完成。", "stopped": "", "error": "（生成失败：测试失败）",
        }[ending]
        assert message["status"] == ("succeeded" if ending == "completed" else ending)
        assert message["event_summary"]["commentary_characters"] == 7
        page = restored.message_events(project.id, session["id"], message["id"])
        replay = [event for event in page["events"] if event.get("phase") == "commentary"]
        assert len(replay) == 1
        assert replay[0]["delta"] == "我先定位组件。"
    finally:
        await restored.shutdown()
        bus.unsubscribe(queue)


@pytest.mark.anyio
async def test_running_history_uses_journal_snapshot_and_details_are_separate(
    chat_module,
    monkeypatch,
):
    module, _bus, _manager, project, _ = chat_module
    invoke_started = asyncio.Event()
    release_invoke = asyncio.Event()
    # 超过思考聚合的字符预算（512）→ 立即合并落日志；
    # 运行中的历史快照（journal snapshot）应立刻可见该思考流。
    thought_text = "内部思考" + "缓" * 600

    async def streaming_invoke(
        engine_id, model, cwd, prompt, session_id, on_event=None, **kwargs
    ):
        await on_event(InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": "已经生成"}},
        ))
        await on_event(InternalEvent(
            type="agent_thought_chunk",
            data={"content": {"text": thought_text}},
        ))
        invoke_started.set()
        await release_invoke.wait()
        return "已经生成完成", [], None

    monkeypatch.setattr(module, "_invoke", streaming_invoke)
    session = module.create_session(project.id)
    accepted = module.submit_message(
        project.id, session["id"], "执行长任务", "journal-running-1"
    )
    await asyncio.wait_for(invoke_started.wait(), timeout=1)

    detail = module.get_session(project.id, session["id"])
    assistant = detail["messages"][-1]
    assert assistant["content"] == "已经生成"
    assert assistant["event_summary"]["thought_characters"] == len(thought_text)
    assert "内部思考" not in json.dumps(detail, ensure_ascii=False)

    events = module.message_events(project.id, session["id"], assistant["id"])
    assert any(
        event["type"] == "REASONING_MESSAGE_CHUNK"
        and event["delta"] == thought_text
        for event in events["events"]
    )

    release_invoke.set()
    assert await _wait_turn(module, accepted.turn_id) == "completed"


def test_history_messages_truncate_large_tool_payloads(chat_module):
    """history 出口必须截断超大工具载荷。

    events_json 按全量保真落库（单条 raw_output 可达数十 MB）；随 history
    整包下发会让前端 store 常驻数百 MB（多会话缓存叠加后压垮渲染进程）。
    """
    module, _bus, _manager, project, _ = chat_module
    session = module.create_session(project.id)
    huge = "x" * (LARGE_PAYLOAD_LIMIT * 2)
    message_id = "assistant-huge-history"
    with module._project_ctx(project.id):
        ChatMessage.create(
            id=message_id,
            session=session["id"],
            role="assistant",
            content="done",
            status="succeeded",
            events_json=json.dumps([{
                "type": "tool_call_update",
                "seq": 1,
                "data": {"tool_call_id": "t1", "raw_output": huge},
            }], ensure_ascii=False),
            created_at=utc_now(),
        )

    detail = module.get_session(project.id, session["id"])
    message = next(item for item in detail["messages"] if item["id"] == message_id)
    payload = json.dumps(message["events"], ensure_ascii=False)
    assert len(payload) < len(huge)
    assert "已截断" in payload


def test_startup_recovery_finalizes_interrupted_running_message(chat_module):
    module, _bus, _manager, project, _ = chat_module
    session = module.create_session(project.id, "wf-recovery")
    message_id = "assistant-recovery"
    ref = module._event_journal.start(project.workstep_dir, session["id"], message_id)
    module._event_journal.record(ref, {
        "type": "agent_message_chunk",
        "data": {"content": {"text": "异常退出前的部分回答"}},
    })
    module._event_journal.sync(ref, durable=True)
    with module._project_ctx(project.id):
        ChatMessage.create(
            id=message_id,
            session=session["id"],
            role="assistant",
            content="",
            status="running",
            event_log_path=ref.relative_path,
            created_at=utc_now(),
        )

    assert module.recover_interrupted_messages() == 1

    detail = module.get_session(project.id, session["id"])
    recovered = next(item for item in detail["messages"] if item["id"] == message_id)
    assert recovered["status"] == "stopped"
    assert recovered["content"] == "异常退出前的部分回答"
    assert recovered["event_detail"]["available"] is True


def test_startup_recovery_removes_incomplete_fork(chat_module):
    module, _bus, _manager, project, _ = chat_module
    pending = module.create_session(project.id, title="未完成分支")
    with module._project_ctx(project.id):
        ChatSession.update(fork_status="pending").where(
            ChatSession.id == pending["id"]
        ).execute()

    module.recover_interrupted_messages()

    assert module.get_session(project.id, pending["id"]) is None


@pytest.mark.anyio
async def test_legacy_messages_without_ended_at_are_repaired_on_read(chat_module):
    """旧数据回补：成功回合没有 ended_at、created_at 为完成时刻时，读取历史补全起止时间。"""
    module, bus, manager, project, _ = chat_module
    session = module.create_session(project.id, "wf-legacy")
    session_id = session["id"]
    with manager.activate_project(project.path):
        row = ChatSession.get_by_id(session_id)
        ChatMessage.create(
            id="legacy-msg-1",
            session=row,
            role="assistant",
            content="ok",
            status="succeeded",
            created_at=datetime.fromisoformat("2026-08-12T09:16:25.231045+00:00"),
            events_json=json.dumps([
                {"type": "session_started", "data": {}, "timestamp": 1786526183803},
                {
                    "type": "usage_update",
                    "data": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
                    "timestamp": 1786526185230,
                },
            ]),
        )

    detail = module.get_session(project.id, session_id)
    message = detail["messages"][0]
    assert message["role"] == "assistant"
    # 起点取最早事件时间、终点取原 created_at（完成时刻）。
    assert message["created_at"] == "2026-08-12T09:16:23.803000+00:00"
    assert message["ended_at"] == "2026-08-12T09:16:25.231045+00:00"
    # usage_update 事件保留，前端据此展示 Token 统计。
    assert any(event["type"] == "usage_update" for event in message["events"])


@pytest.mark.anyio
async def test_submit_is_idempotent_and_events_are_channel_scoped(chat_module, monkeypatch):
    """Replayed messages reuse the turn; events stream on session_chat."""
    from engines.core.events import InternalEvent

    module, bus, manager, project, _ = chat_module
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
            if event.get("type") == "TEXT_MESSAGE_END":
                stop.set()

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None):
        if on_event is not None:
            await on_event(InternalEvent(
                type="agent_message_chunk",
                data={"content": {"text": "流式回复"}},
            ))
        return "流式回复", [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    session = module.create_session(project.id, "wf-3")
    session_id = session["id"]
    accepted = module.submit_message(project.id, session_id, "第一轮", "idem-http-1")
    assert accepted.session_id == session_id

    task = asyncio.create_task(collector())
    assert await _wait_turn(module, accepted.turn_id) == "completed"
    await asyncio.wait_for(stop.wait(), timeout=2)
    await task

    channels = {event.get("channel") for event in collected}
    assert channels == {"session_chat"}
    for event in collected:
        assert event.get("session_id") == session_id
    assert any(event["type"] == "TEXT_MESSAGE_END" for event in collected)

    replayed = module.submit_message(project.id, session_id, "第一轮", "idem-http-1")
    assert replayed.turn_id == accepted.turn_id


@pytest.mark.anyio
async def test_chat_records_final_usage_once_after_message_persistence(chat_module, monkeypatch):
    module, _bus, manager, project, _ = chat_module
    import main
    recorded = []

    async def record_usage(**kwargs):
        recorded.append(kwargs)
        def read_persisted(_project):
            return ChatMessage.get_by_id(kwargs["message_id"]).usage_json
        assert await manager.run_db(project.id, read_persisted)

    monkeypatch.setattr(main.gateway_client, "record_message_usage", record_usage)

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None,
                          message_history=None):
        for tokens in (4, 9):
            await on_event(InternalEvent(type="usage_update", data={
                "input_tokens": tokens, "output_tokens": 2,
            }))
        return "回复", [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    session = module.create_session(project.id, "wf-usage")
    accepted = module.submit_message(project.id, session["id"], "第一轮", "idem-usage")
    assert await _wait_turn(module, accepted.turn_id) == "completed"
    detail = module.get_session(project.id, session["id"])
    assistant = next(item for item in detail["messages"] if item["role"] == "assistant")
    assert len(recorded) == 1
    assert recorded[0]["message_id"] == assistant["id"]
    assert recorded[0]["session_id"] == session["id"]
    assert json.loads(recorded[0]["usage_json"])["input_tokens"] == 9
    assert await manager.run_db(project.id, lambda _project:
        json.loads(ChatMessage.get_by_id(assistant["id"]).usage_json)["input_tokens"]) == 9
    assert module.submit_message(project.id, session["id"], "第一轮", "idem-usage").turn_id == accepted.turn_id
    assert len(recorded) == 1


@pytest.mark.anyio
async def test_chat_usage_provider_read_keeps_event_loop_responsive(chat_module, monkeypatch):
    module, _bus, _manager, project, config_store = chat_module
    import main
    entered = threading.Event()
    release = threading.Event()
    recorded = []
    config_store.values["providers"] = [{
        "id": "provider-1", "prices": {"model-a": {"input": "1"}},
        "managed_revision": 3,
    }]
    original_get_provider = config_store.get_provider

    def slow_get_provider(provider_id):
        entered.set()
        release.wait(timeout=2)
        return original_get_provider(provider_id)

    async def fake_invoke(*args, **kwargs):
        state = next(state for state in module._turn_states.values()
                     if state.get("status") == "running")
        state["resolved_provider_id"] = "provider-1"
        return "回复", [], None

    async def record_usage(**kwargs):
        recorded.append(kwargs)

    monkeypatch.setattr(config_store, "get_provider", slow_get_provider)
    monkeypatch.setattr(module, "_invoke", fake_invoke)
    monkeypatch.setattr(main.gateway_client, "record_message_usage", record_usage)
    try:
        session = module.create_session(project.id)
        accepted = module.submit_message(
            project.id, session["id"], "检查", "idem-slow-usage-provider",
        )
        assert await asyncio.to_thread(entered.wait, 2)
        await asyncio.wait_for(asyncio.sleep(0.01), timeout=0.1)
    finally:
        release.set()
    assert await _wait_turn(module, accepted.turn_id) == "completed"
    assert recorded[0]["provider"]["managed_revision"] == 3


@pytest.mark.anyio
async def test_chat_usage_keeps_provider_price_version_from_call_start(chat_module, monkeypatch):
    module, _bus, _manager, project, config_store = chat_module
    import main
    provider = {
        "id": "provider-1", "protocol": "openai_compatible", "enabled": True,
        "prices": {"version": "v1", "models": {"model-a": {
            "input_per_million": "1", "output_per_million": "2",
        }}},
        "managed_revision": 3,
    }
    config_store.values["providers"] = [provider]
    recorded = []

    async def fake_invoke_engine(*args, **kwargs):
        assert kwargs["config_overrides"] == {"provider_id": "provider-1"}
        await args[5](InternalEvent(
            type="usage_update", data={"input_tokens": 10, "output_tokens": 5},
        ))
        provider["prices"]["version"] = "v2"
        provider["managed_revision"] = 4
        return "回复", [], None

    async def record_usage(**kwargs):
        recorded.append(kwargs)

    monkeypatch.setattr("agent_assistants.base.invoke_engine", fake_invoke_engine)
    monkeypatch.setattr(main.gateway_client, "record_message_usage", record_usage)
    session = module.create_session(
        project.id, engine="claude", model="model-a", provider_id="provider-1",
    )
    accepted = module.submit_message(
        project.id, session["id"], "检查", "idem-price-snapshot",
    )
    assert await _wait_turn(module, accepted.turn_id) == "completed"
    assert len(recorded) == 1
    assert recorded[0]["provider"]["managed_revision"] == 3
    assert recorded[0]["provider"]["prices"]["version"] == "v1"


@pytest.mark.anyio
async def test_submit_publishes_user_message_live_event_with_actor(chat_module, monkeypatch):
    """会话聊天：用户消息也发实时事件并带发送者身份，远端可即时看到且头像按人显示。"""
    module, bus, manager, project, _ = chat_module
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
            if event.get("type") == "TEXT_MESSAGE_END":
                stop.set()

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None):
        return "回复", [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)

    session = module.create_session(project.id, "wf-live")
    session_id = session["id"]
    accepted = module.submit_message(project.id, session_id, "第一轮", "idem-live-1")

    task = asyncio.create_task(collector())
    assert await _wait_turn(module, accepted.turn_id) == "completed"
    await asyncio.wait_for(stop.wait(), timeout=2)
    await task

    user_start = next(
        event for event in collected
        if event.get("type") == "TEXT_MESSAGE_START"
        and event.get("role") == "user"
        and event.get("messageId") == accepted.turn_id
    )
    assert user_start["content"] == "第一轮"
    assert user_start["session_id"] == session_id
    assert user_start["actor"]["name"] == "本地用户"
    assert user_start["actor"]["device_id"] == "device-a"

    # 历史记录头像：持久化消息带作者身份，前端据此显示发送人的头像。
    detail = module.get_session(project.id, session_id)
    user_message = detail["messages"][0]
    assert user_message["role"] == "user"
    assert user_message["author_name"] == "本地用户"
    assert user_message["author_username"] == "本地用户"
    assert user_message["author_type"] == "user"
    assert user_message["initiated_by_user_id"] == user_message["author_id"]
    assert user_message["author_device_id"] == "device-a"
    assistant_message = detail["messages"][1]
    assert assistant_message["role"] == "assistant"
    assert assistant_message["author_id"] == assistant_message["engine"]
    assert assistant_message["author_type"] == "assistant"
    assert assistant_message["initiated_by_user_id"] == user_message["author_id"]
    assert assistant_message["initiated_by_username"] == "本地用户"
    assert assistant_message["author_device_id"] == "device-a"

    def persisted_snapshot():
        from models.chat_session import ChatMessage
        user_row = ChatMessage.get_by_id(accepted.turn_id)
        assistant_row = ChatMessage.get_by_id(assistant_message["id"])
        return (
            user_row.author_type, user_row.initiated_by_user_id,
            assistant_row.author_type, assistant_row.initiated_by_user_id,
        )

    assert await manager.run_db(project.id, lambda _project: persisted_snapshot()) == (
        "user", user_message["author_id"],
        "assistant", user_message["author_id"],
    )


@pytest.mark.anyio
async def test_managed_chat_preserves_account_username_and_display_name(chat_module, monkeypatch):
    from services.remote_access import ActorSnapshot, actor_context

    module, _bus, _manager, project, _config = chat_module

    async def fake_invoke(*_args, **_kwargs):
        return "回复", [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    session = module.create_session(project.id, "wf-managed")
    with actor_context(ActorSnapshot(
        actor_id="user-1", user_name="Alice Display", username="alice",
        device_id="device-1", device_name="Office PC", source="managed",
    )):
        accepted = module.submit_message(project.id, session["id"], "开始", "idem-managed")
    assert await _wait_turn(module, accepted.turn_id) == "completed"
    user_message, assistant_message = module.get_session(project.id, session["id"])["messages"]
    assert (user_message["author_name"], user_message["author_username"]) == (
        "Alice Display", "alice",
    )
    assert (assistant_message["author_type"],
            assistant_message["initiated_by_user_id"],
            assistant_message["initiated_by_username"]) == (
                "assistant", "user-1", "alice",
            )


@pytest.mark.anyio
async def test_chat_compacted_event_is_live_and_persisted(chat_module, monkeypatch):
    module, bus, manager, project, _ = chat_module
    queue = bus.subscribe()
    collected: list[dict] = []

    async def collector():
        while True:
            event = await queue.get()
            collected.append(event)
            if event.get("type") == "TEXT_MESSAGE_END":
                return

    compacted = InternalEvent(
        type="compacted",
        data={"summary": "保留会话目标"},
    )

    async def fake_invoke(
        engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None
    ):
        if on_event is not None:
            await on_event(compacted)
        return "压缩后继续", [compacted.to_dict()], session_id

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    session = module.create_session(project.id, "wf-compact")
    accepted = module.submit_message(project.id, session["id"], "继续", "idem-compact")
    collector_task = asyncio.create_task(collector())
    assert await _wait_turn(module, accepted.turn_id) == "completed"
    await asyncio.wait_for(collector_task, timeout=2)

    compacted_events = [
        event for event in collected
        if event.get("type") == "CUSTOM" and event.get("name") == "workstep.compacted"
    ]
    assert len(compacted_events) == 1
    assert compacted_events[0]["session_id"] == session["id"]

    detail = module.get_session(project.id, session["id"])
    assert compacted_events[0]["messageId"] == detail["messages"][-1]["id"]
    assert detail["messages"][-1]["events"] == [compacted.to_dict()]


@pytest.mark.anyio
async def test_delete_rejects_running_session(chat_module, monkeypatch):
    module, bus, manager, project, _ = chat_module
    session = module.create_session(project.id, "wf-4")
    started = asyncio.Event()

    async def blocking_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None):
        started.set()
        await asyncio.Event().wait()
        return "", [], None

    monkeypatch.setattr(module, "_invoke", blocking_invoke)
    accepted = module.submit_message(project.id, session["id"], "长任务", "idem-block")
    await asyncio.wait_for(started.wait(), timeout=2)
    with pytest.raises(ValueError):
        module.delete_session(project.id, session["id"])
    await module.stop_current(accepted.session_id)
    assert await _wait_turn(module, accepted.turn_id) == "stopped"
    assert module.delete_session(project.id, session["id"]) is True


@pytest.mark.anyio
async def test_delete_allows_session_with_stale_running_turn(chat_module):
    """A dead background task must not leave the session permanently locked."""
    module, _bus, _manager, project, _ = chat_module
    session = module.create_session(project.id, "wf-stale-running")
    turn_id = "stale-running-turn"
    module._turn_states[turn_id] = {
        "session_id": session["id"],
        "status": "running",
    }

    assert module.delete_session(project.id, session["id"]) is True
    assert turn_id not in module._turn_states
    assert module.get_session(project.id, session["id"]) is None


@pytest.mark.anyio
async def test_stop_finalizes_stale_running_turn(chat_module):
    module, _bus, _manager, project, _ = chat_module
    session = module.create_session(project.id, "wf-stale-stop")
    accepted = module.submit_message(
        project.id,
        session["id"],
        "已经失去后台任务的消息",
        "idem-stale-stop",
        schedule=False,
    )
    module._turn_states[accepted.turn_id]["status"] = "running"

    assert await module.stop_current(session["id"]) is True
    assert module._turn_states[accepted.turn_id]["status"] == "stopped"
    detail = module.get_session(project.id, session["id"])
    assert detail["messages"][-1]["status"] == "stopped"


@pytest.mark.anyio
@pytest.mark.parametrize("prune_reason", ["ttl", "capacity", "turn_history"])
async def test_pruning_keeps_long_running_session_stoppable(
    chat_module, monkeypatch, prune_reason
):
    import main

    module, _bus, manager, project, _ = chat_module
    session = module.create_session(project.id)
    started = asyncio.Event()

    async def blocking_invoke(*args, **kwargs):
        started.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(module, "_invoke", blocking_invoke)
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    accepted = module.submit_message(project.id, session["id"], "长任务", "prune-stop")
    await asyncio.wait_for(started.wait(), timeout=2)
    state = module._turn_states[accepted.turn_id]
    memory_key = state["memory_key"]
    turn_key = next(key for key, value in module._turn_keys.items() if value == accepted.turn_id)
    task = module._turn_tasks[accepted.turn_id]
    if prune_reason == "ttl":
        module._sessions[memory_key].last_active -= module._config.session_ttl_seconds + 1
    else:
        module._config.max_sessions = 1
        if prune_reason == "capacity":
            module._sessions[("idle",)] = SimpleNamespace(last_active=time.monotonic())
        else:
            for index in range(5):
                turn_id = f"finished-{index}"
                module._turn_states[turn_id] = {"status": "completed"}
                module._turn_keys[("finished", index)] = turn_id
    try:
        module._prune_sessions()
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
            response = await client.post(
                f"/api/chat-sessions/{session['id']}/stop",
                params={"project_id": project.id},
            )
        assert response.status_code == 200
        assert response.json() == {"stopped": True}
        assert await _wait_turn(module, accepted.turn_id) == "stopped"
        assert module._turn_keys[turn_key] == accepted.turn_id
        detail = await manager.run_db(
            project.id, lambda _project: module.get_session(project.id, session["id"])
        )
        assert detail["messages"][-1]["status"] == "stopped"
        if prune_reason == "capacity":
            assert ("idle",) not in module._sessions
        if prune_reason == "turn_history":
            assert len(module._turn_states) == len(module._turn_keys) == 5
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.anyio
@pytest.mark.parametrize("failure", ["missing_memory", "hung_engine_stop"])
async def test_stop_survives_missing_memory_and_hung_engine(chat_module, monkeypatch, failure):
    module, _bus, _manager, project, _ = chat_module
    session = module.create_session(project.id)
    started = asyncio.Event()

    async def blocked(*args, **kwargs):
        started.set()
        await asyncio.Event().wait()

    class HungEngine:
        async def stop(self):
            await asyncio.Event().wait()

    monkeypatch.setattr(module, "_invoke", blocked)
    monkeypatch.setattr("agent_assistants.base.SHUTDOWN_DRAIN_TIMEOUT_SECONDS", 0.05)
    accepted = module.submit_message(project.id, session["id"], "长任务", "force-stop")
    await started.wait()
    task = module._turn_tasks[accepted.turn_id]
    if failure == "missing_memory":
        module._sessions.pop(module._turn_states[accepted.turn_id]["memory_key"])
    else:
        module._running_engines[accepted.turn_id] = HungEngine()
    try:
        assert await module.stop_current(session["id"], project_id=project.id)
        assert await _wait_turn(module, accepted.turn_id, timeout=1) == "stopped"
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        module._running_engines.clear()


@pytest.mark.anyio
async def test_stop_orphan_is_idempotent_preserves_content_and_keeps_health_responsive(chat_module, monkeypatch):
    import main

    module, bus, manager, project, _ = chat_module
    session = module.create_session(project.id)
    accepted = module.submit_message(project.id, session["id"], "长任务", "orphan", schedule=False)
    ref = module._turn_states[accepted.turn_id]["journal_ref"]
    await module._event_journal.arecord(ref, {"type": "agent_message_chunk", "data": {"content": {"text": "已生成的正文"}}})
    module._sessions.clear()
    module._turn_states.clear()
    module._turn_keys.clear()
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    original = module._stop_orphaned_messages
    entered = threading.Event()

    def slow_cleanup(*args):
        entered.set()
        time.sleep(0.15)
        return original(*args)

    monkeypatch.setattr(module, "_stop_orphaned_messages", slow_cleanup)
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        url = f"/api/chat-sessions/{session['id']}/stop"
        request = asyncio.create_task(client.post(url, params={"project_id": project.id}))
        assert await asyncio.to_thread(entered.wait, 1)
        health = await asyncio.wait_for(client.get("/api/health"), timeout=0.1)
        assert health.status_code == 200
        assert (await request).json() == {"stopped": True}
        assert (await client.post(url, params={"project_id": project.id})).json() == {"stopped": True}
        detail = await client.get(f"/api/chat-sessions/{session['id']}", params={"project_id": project.id})
    last = detail.json()["messages"][-1]
    assert last["status"] == "stopped"
    assert last["content"] == "已生成的正文"
    assert last["ended_at"]


@pytest.mark.anyio
async def test_stop_cancels_running_and_queued_turns(chat_module, monkeypatch):
    module, _bus, _manager, project, _ = chat_module
    session = module.create_session(project.id)
    started = asyncio.Event()

    async def blocked(*args, **kwargs):
        started.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(module, "_invoke", blocked)
    first = module.submit_message(project.id, session["id"], "运行", "first-stop-all")
    await started.wait()
    second = module.submit_message(project.id, session["id"], "排队", "second-stop-all")
    assert await module.stop_current(session["id"], project_id=project.id)
    assert await _wait_turn(module, first.turn_id, timeout=1) == "stopped"
    assert await _wait_turn(module, second.turn_id, timeout=1) == "stopped"


@pytest.mark.anyio
async def test_shutdown_stops_engine_before_cancelling_turn(chat_module, monkeypatch):
    """Daemon shutdown must terminate the engine before cancelling the task.

    A Codex SDK subprocess reports EOF as a transport error. If the task is
    cancelled first, that error can win the race and be persisted as a normal
    generation failure. Stopping the engine first keeps shutdown as a
    deliberate stop.
    """
    module, _bus, _manager, project, _ = chat_module
    started = asyncio.Event()
    order: list[str] = []

    class ShutdownEngine(FakeEngine):
        async def spawn(self, **kwargs):
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                order.append("cancelled")
                raise
            if False:
                yield None

        async def stop(self):
            order.append("stopped")

    engine = ShutdownEngine()
    monkeypatch.setattr(
        "agent_assistants.chat_session.create_engine",
        lambda _engine_id: engine,
    )
    monkeypatch.setattr(
        "agent_assistants.base.create_engine",
        lambda _engine_id: engine,
    )

    session = module.create_session(project.id, "wf-shutdown")
    accepted = module.submit_message(
        project.id,
        session["id"],
        "长任务",
        "idem-shutdown",
    )
    await asyncio.wait_for(started.wait(), timeout=2)

    await module.shutdown()

    assert order[:2] == ["stopped", "cancelled"]
    detail = module.get_session(project.id, session["id"])
    message = next(
        item for item in reversed(detail["messages"]) if item["role"] == "assistant"
    )
    assert message["status"] == "stopped"
    assert "生成失败" not in message["content"]


@pytest.mark.anyio
async def test_shutdown_replaces_stopping_error_with_restart_notice(
    chat_module,
    monkeypatch,
):
    """A transport error racing shutdown must not become a generation failure."""
    module, _bus, _manager, project, _ = chat_module
    started = asyncio.Event()

    class TransportClosedEngine(FakeEngine):
        async def spawn(self, **kwargs):
            started.set()
            yield InternalEvent(
                type="session_started",
                data={"session_id": "thread-shutdown"},
            )
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

    engine = TransportClosedEngine()
    monkeypatch.setattr(
        "agent_assistants.chat_session.create_engine",
        lambda _engine_id: engine,
    )
    monkeypatch.setattr(
        "agent_assistants.base.create_engine",
        lambda _engine_id: engine,
    )

    session = module.create_session(project.id, "wf-shutdown-race")
    accepted = module.submit_message(
        project.id,
        session["id"],
        "长任务",
        "idem-shutdown-race",
    )
    await asyncio.wait_for(started.wait(), timeout=2)

    await module.shutdown()

    detail = module.get_session(project.id, session["id"])
    message = next(
        item for item in reversed(detail["messages"]) if item["role"] == "assistant"
    )
    assert message["status"] == "stopped"
    assert message["content"] == "后台服务已重启，本次生成已中断。"
    assert "stderr_tail" not in message["content"]


@pytest.mark.anyio
async def test_failed_turn_persists_started_engine_session_for_next_turn(
    chat_module, monkeypatch
):
    """引擎开始后报错，下一轮仍须用同一个引擎会话恢复上下文。"""
    import agent_assistants.chat_session as chat_service

    module, _bus, _manager, project, _ = chat_module
    resumable_engine = FakeEngine()
    resumable_engine.supports_resume = True
    monkeypatch.setattr(chat_service, "create_engine", lambda _engine_id: resumable_engine)

    calls: list[str | None] = []

    async def failing_then_succeeding_invoke(
        engine_id, model, cwd, prompt, session_id, on_event=None, **kwargs
    ):
        calls.append(session_id)
        resolved = session_id or "engine-session-after-error"
        await on_event(InternalEvent(
            type="session_started",
            data={"session_id": resolved},
        ))
        if len(calls) == 1:
            raise RuntimeError("provider failed after session start")
        return "继续成功", [], resolved

    monkeypatch.setattr(module, "_invoke", failing_then_succeeding_invoke)
    session = module.create_session(project.id, engine="pydantic_ai")

    first = module.submit_message(
        project.id, session["id"], "执行任务", "idem-session-error-1"
    )
    assert await _wait_turn(module, first.turn_id) == "error"

    # 模拟 daemon 重载：第二轮必须从项目数据库恢复，而非复用内存对象。
    module._sessions.clear()
    second = module.submit_message(
        project.id, session["id"], "继续上个任务", "idem-session-error-2"
    )
    assert await _wait_turn(module, second.turn_id) == "completed"
    assert calls == [None, "engine-session-after-error"]


@pytest.mark.anyio
async def test_missing_codex_rollout_rebuilds_session_with_history(
    chat_module, monkeypatch
):
    """Codex rollout 丢失时，下一轮重建线程并带上已有对话历史。"""
    import agent_assistants.chat_session as chat_service

    module, _bus, _manager, project, _ = chat_module
    resumable_engine = FakeEngine()
    resumable_engine.supports_resume = True
    monkeypatch.setattr(
        chat_service,
        "create_engine",
        lambda _engine_id: resumable_engine,
    )

    session = module.create_session(project.id, title="历史会话", engine="codex_sdk")
    with module._project_ctx(project.id):
        row = ChatSession.get_by_id(session["id"])
        row.engine_session_id = "01a0a357-3f26-7e41-b07a-cd0881953ede"
        row.save(only=[ChatSession.engine_session_id])
        base_time = utc_now()
        ChatMessage.create(
            id="history-user",
            session=row,
            role="user",
            content="之前讨论的实现方案",
            created_at=base_time,
        )
        ChatMessage.create(
            id="history-assistant",
            session=row,
            role="assistant",
            content="之前已经完成了登录模块。",
            status="succeeded",
            created_at=base_time + timedelta(seconds=1),
        )

    calls: list[tuple[str | None, str]] = []

    async def fake_invoke(
        engine_id,
        model,
        cwd,
        prompt,
        session_id,
        on_event=None,
        message_history=None,
    ):
        calls.append((session_id, prompt))
        if session_id:
            raise RuntimeError(
                "JSON-RPC error -32600: no rollout found for "
                f"thread id {session_id}"
            )
        return "继续完成", [], "rebuilt-session"

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    accepted = module.submit_message(
        project.id,
        session["id"],
        "继续补测试",
        "idem-missing-rollout",
        engine="codex_sdk",
    )

    assert await _wait_turn(module, accepted.turn_id) == "completed"
    assert calls[0][0] == "01a0a357-3f26-7e41-b07a-cd0881953ede"
    assert calls[1][0] is None
    assert "之前讨论的实现方案" in calls[1][1]
    assert "之前已经完成了登录模块。" in calls[1][1]
    assert "继续补测试" in calls[1][1]
    detail = module.get_session(project.id, session["id"])
    assert detail["engine_session_id"] == "rebuilt-session"
    assert any(
        item["content"] == "继续完成"
        for item in detail["messages"]
    )


@pytest.mark.anyio
async def test_stopped_turn_persists_started_engine_session_for_next_turn(
    chat_module, monkeypatch
):
    """用户停止已开始的引擎回合后，下一轮仍须恢复同一会话。"""
    import agent_assistants.chat_session as chat_service

    module, _bus, _manager, project, _ = chat_module
    resumable_engine = FakeEngine()
    resumable_engine.supports_resume = True
    monkeypatch.setattr(chat_service, "create_engine", lambda _engine_id: resumable_engine)
    started = asyncio.Event()

    async def blocking_invoke(
        engine_id, model, cwd, prompt, session_id, on_event=None, **kwargs
    ):
        await on_event(InternalEvent(
            type="session_started",
            data={"session_id": "engine-session-after-stop"},
        ))
        started.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(module, "_invoke", blocking_invoke)
    session = module.create_session(project.id, engine="pydantic_ai")
    first = module.submit_message(
        project.id, session["id"], "执行长任务", "idem-session-stop-1"
    )
    await asyncio.wait_for(started.wait(), timeout=2)
    assert await module.stop_current(session["id"]) is True
    assert await _wait_turn(module, first.turn_id) == "stopped"

    received_session_ids: list[str | None] = []

    async def succeeding_invoke(
        engine_id, model, cwd, prompt, session_id, on_event=None, **kwargs
    ):
        received_session_ids.append(session_id)
        return "继续成功", [], session_id

    module._sessions.clear()
    monkeypatch.setattr(module, "_invoke", succeeding_invoke)
    second = module.submit_message(
        project.id, session["id"], "继续上个任务", "idem-session-stop-2"
    )
    assert await _wait_turn(module, second.turn_id) == "completed"
    assert received_session_ids == ["engine-session-after-stop"]


@pytest.mark.anyio
async def test_quick_buttons_defaults_and_validation(chat_module):
    module, bus, manager, project, _ = chat_module

    defaults = module.get_quick_buttons(project.id)
    assert defaults == DEFAULT_QUICK_BUTTONS

    saved = module.set_quick_buttons(
        project.id,
        [
            {"label": "解释代码", "prompt": "请解释项目结构"},
            {
                "label": '<a href="https://example.com">打开文档</a>',
                "prompt": "",
            },
        ],
    )
    assert [item["label"] for item in saved] == [
        "解释代码",
        '<a href="https://example.com">打开文档</a>',
    ]
    assert saved[1]["prompt"] == ""
    assert module.get_quick_buttons(project.id) == saved

    with pytest.raises(ValueError):
        module.set_quick_buttons(project.id, [{"label": "", "prompt": "x"}])
    with pytest.raises(ValueError):
        module.set_quick_buttons(project.id, [{"label": "x", "prompt": "y"}] * 21)
    with pytest.raises(ValueError):
        module.set_quick_buttons(project.id, [{"label": "x", "prompt": "y"}, {"label": "x2", "prompt": "y2", "id": "dup"}, {"label": "x3", "prompt": "y3", "id": "dup"}])

    stored = ProjectSetting.get_or_none(
        ProjectSetting.project_id == project.id,
        ProjectSetting.key == "chat_quick_buttons",
    )
    assert stored is not None
    assert len(json.loads(stored.value_json)) == 2


@pytest.mark.anyio
async def test_action_quick_button_round_trip_and_script_validation(chat_module):
    module, _bus, _manager, project, _ = chat_module
    button = {
        "id": "restart",
        "label": "重启服务",
        "prompt": "",
        "kind": "action",
        "action_id": "restart-services",
        "script_path": "scripts/restart.sh",
        "cwd_mode": "task",
        "require_confirmation": False,
    }
    assert module.set_quick_buttons(project.id, [button])[0] == {
        **button,
        "immediate_send": False,
        "confirmation_input_prompt": "",
    }
    assert module.get_quick_buttons(project.id)[0]["script_path"] == "scripts/restart.sh"
    with pytest.raises(ValueError, match="脚本路径"):
        module.set_quick_buttons(project.id, [{**button, "script_path": "../escape.sh"}])
    with pytest.raises(ValueError, match="执行目录"):
        module.set_quick_buttons(project.id, [{**button, "cwd_mode": "elsewhere"}])


@pytest.mark.anyio
async def test_system_prompt_persistence_validation_and_clear(chat_module):
    module, bus, manager, project, _ = chat_module

    # Unset → empty; no built-in default is substituted.
    assert module.get_system_prompt(project.id) == ""

    custom = "你是项目专属助手。\n多轮对话保持上下文。"
    saved = module.set_system_prompt(project.id, "  " + custom + "  ")
    assert saved == custom
    assert module.get_system_prompt(project.id) == custom

    stored = ProjectSetting.get_or_none(
        ProjectSetting.project_id == project.id,
        ProjectSetting.key == "chat_system_prompt",
    )
    assert stored is not None
    assert json.loads(stored.value_json) == custom

    # Empty input clears the custom prompt; the assistant then has no system prompt.
    assert module.set_system_prompt(project.id, "   ") == ""
    assert module.get_system_prompt(project.id) == ""
    assert (
        ProjectSetting.get_or_none(
            ProjectSetting.project_id == project.id,
            ProjectSetting.key == "chat_system_prompt",
        )
        is None
    )

    # Over-length is rejected.
    with pytest.raises(ValueError):
        module.set_system_prompt(project.id, "x" * 20001)


@pytest.mark.anyio
async def test_chat_http_contract(tmp_path, monkeypatch):
    """Full HTTP contract: create/list/get/rename/chat/stop/quick-buttons."""
    import main
    import agent_assistants.chat_session as chat_service
    import services.config as config_service
    import services.project as project_service

    config_store = MemoryConfigStore()
    monkeypatch.setattr(config_service, "config_store", config_store)
    monkeypatch.setattr(project_service, "config_store", config_store)
    monkeypatch.setattr(chat_service, "config_store", config_store)
    monkeypatch.setattr(chat_service, "create_engine", lambda engine_id: FakeEngine())
    monkeypatch.setattr(main, "project_manager", ProjectManager())

    manager = main.project_manager
    bus = EventBus()
    module = ChatSessionModule(bus, manager)

    live_turn_started = asyncio.Event()

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None):
        if "插入接口长任务" in prompt:
            live_turn_started.set()
            await asyncio.Event().wait()
        return "HTTP 回复", [], None

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    monkeypatch.setattr(main, "chat_session_module", module)

    project = manager.init_project(tmp_path / "http-chat-proj")
    workflow_id = "wf-http"
    transport = ASGITransport(app=main.app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            # defaults
            resp = await client.get(
                "/api/chat-sessions/quick-buttons",
                params={"project_id": project.id},
            )
            assert resp.status_code == 200
            assert len(resp.json()["buttons"]) == len(DEFAULT_QUICK_BUTTONS)

            # create
            resp = await client.post(
                "/api/chat-sessions",
                json={"project_id": project.id, "workflow_id": workflow_id},
            )
            assert resp.status_code == 200
            session = resp.json()
            session_id = session["id"]
            assert session["messages"] == []

            # list
            resp = await client.get(
                "/api/chat-sessions",
                params={"project_id": project.id},
            )
            assert [item["id"] for item in resp.json()["sessions"]] == [session_id]

            # reorder endpoint
            resp = await client.post(
                "/api/chat-sessions/reorder",
                params={"project_id": project.id},
                json={"ordered_ids": [session_id]},
            )
            assert resp.status_code == 200
            assert resp.json()["ok"] is True

            # get
            resp = await client.get(
                "/api/chat-sessions/" + session_id,
                params={"project_id": project.id},
            )
            assert resp.status_code == 200
            assert resp.json()["id"] == session_id

            # Archiving is persisted through the project DB executor and does
            # not hold up the event loop when SQLite is slow.
            original_archive_execute_sql = project.db.execute_sql
            archive_write_started = threading.Event()

            def slow_archive_update(sql, params=None, commit=None):
                if not archive_write_started.is_set() and 'UPDATE "chat_sessions"' in sql:
                    archive_write_started.set()
                    time.sleep(0.35)
                return original_archive_execute_sql(sql, params)

            monkeypatch.setattr(project.db, "execute_sql", slow_archive_update)
            archive_request = asyncio.create_task(client.patch(
                f"/api/chat-sessions/{session_id}/archive",
                json={"project_id": project.id, "archived": True},
            ))
            await asyncio.to_thread(archive_write_started.wait, 1)
            archive_health_started = time.perf_counter()
            archive_health = await client.get("/api/health")
            assert archive_health.status_code == 200
            assert time.perf_counter() - archive_health_started < 0.2
            resp = await archive_request
            assert resp.status_code == 200
            assert resp.json()["archived"] is True
            monkeypatch.setattr(project.db, "execute_sql", original_archive_execute_sql)
            resp = await client.get("/api/chat-sessions", params={"project_id": project.id})
            assert resp.json()["sessions"] == []
            resp = await client.get("/api/chat-sessions", params={"project_id": project.id, "archived": True})
            assert [item["id"] for item in resp.json()["sessions"]] == [session_id]
            resp = await client.patch(f"/api/chat-sessions/{session_id}/archive", json={"project_id": project.id, "archived": False})
            assert resp.status_code == 200

            # Permission persistence stays on the project DB executor, so a
            # slow SQLite write cannot stall unrelated event-loop traffic.
            original_permission_execute_sql = project.db.execute_sql
            permission_write_started = threading.Event()

            def slow_permission_update(sql, params=None, commit=None):
                if (
                    not permission_write_started.is_set()
                    and 'UPDATE "chat_sessions"' in sql
                ):
                    permission_write_started.set()
                    time.sleep(0.35)
                return original_permission_execute_sql(sql, params)

            monkeypatch.setattr(project.db, "execute_sql", slow_permission_update)
            permission_started_at = time.perf_counter()
            permission_request = asyncio.create_task(client.patch(
                f"/api/chat-sessions/{session_id}/permission-mode",
                json={
                    "project_id": project.id,
                    "permission_mode": "workspace-write",
                },
            ))
            await asyncio.sleep(0.05)
            permission_health = await client.get("/api/health")
            permission_health_elapsed = time.perf_counter() - permission_started_at
            resp = await permission_request
            assert resp.status_code == 200
            assert resp.json()["permission_mode"] == "workspace-write"
            assert permission_write_started.is_set()
            assert permission_health.status_code == 200
            assert permission_health_elapsed < 0.2
            monkeypatch.setattr(
                project.db, "execute_sql", original_permission_execute_sql
            )

            # fork with explicit history handoff
            resp = await client.post(
                f"/api/chat-sessions/{session_id}/fork",
                json={
                    "project_id": project.id,
                    "title": "HTTP 分支",
                    "engine": session["engine"],
                    "context_mode": "smart",
                },
            )
            assert resp.status_code == 200
            forked = resp.json()
            assert forked["id"] != session_id
            assert forked["parent_session_id"] == session_id
            assert forked["fork_context_mode"] == "smart"

            # rename
            resp = await client.patch(
                "/api/chat-sessions/" + session_id,
                json={"project_id": project.id, "title": "HTTP 会话"},
            )
            assert resp.status_code == 200
            assert resp.json()["title"] == "HTTP 会话"

            # chat + idempotency + history
            resp = await client.post(
                f"/api/chat-sessions/{session_id}/chat",
                json={"project_id": project.id, "content": "你好"},
                headers={"Idempotency-Key": "idem-http-1"},
            )
            assert resp.status_code == 200
            accepted = resp.json()
            assert accepted["session_id"] == session_id
            assert await _wait_turn(module, accepted["turn_id"]) == "completed"

            # switching engines hands off context inside the same conversation
            original_execute_sql = project.db.execute_sql
            handoff_write_started = threading.Event()
            slowed_handoff_write = False

            def slow_handoff_update(sql, params=None, commit=None):
                nonlocal slowed_handoff_write
                if not slowed_handoff_write and 'UPDATE "chat_sessions"' in sql:
                    slowed_handoff_write = True
                    handoff_write_started.set()
                    time.sleep(0.35)
                return original_execute_sql(sql, params)

            monkeypatch.setattr(project.db, "execute_sql", slow_handoff_update)
            started_at = time.perf_counter()
            handoff_request = asyncio.create_task(client.post(
                f"/api/chat-sessions/{session_id}/handoff",
                json={
                    "project_id": project.id,
                    "engine": "pydantic_ai",
                    "context_mode": "smart",
                },
            ))

            async def health_canary():
                await asyncio.sleep(0.05)
                response = await client.get("/api/health")
                return response, time.perf_counter() - started_at

            health, health_completed_at = await health_canary()
            resp = await handoff_request
            assert handoff_write_started.is_set()
            assert health.status_code == 200
            assert health_completed_at < 0.2
            assert resp.status_code == 200
            assert resp.json()["id"] == session_id
            assert resp.json()["engine"] == "pydantic_ai"

            # plan mode is accepted and forwarded to the turn
            resp = await client.post(
                f"/api/chat-sessions/{session_id}/chat",
                json={"project_id": project.id, "content": "规划一下", "plan_mode": True},
                headers={"Idempotency-Key": "idem-plan-1"},
            )
            assert resp.status_code == 200
            plan_accepted = resp.json()
            assert await _wait_turn(module, plan_accepted["turn_id"]) == "completed"

            resp = await client.get(
                "/api/chat-sessions/" + session_id,
                params={"project_id": project.id},
            )
            body = resp.json()
            assert body["title"] == "HTTP 会话"
            assert body["engine"] == "pydantic_ai"
            assert [item["role"] for item in body["messages"]] == [
                "user", "assistant", "user", "assistant",
            ]
            assert body["messages"][-1]["content"] == "HTTP 回复"

            # running chat accepts a persisted live message through the API
            resp = await client.post(
                f"/api/chat-sessions/{session_id}/chat",
                json={"project_id": project.id, "content": "插入接口长任务"},
                headers={"Idempotency-Key": "idem-http-live-turn"},
            )
            assert resp.status_code == 200
            live_turn = resp.json()
            await asyncio.wait_for(live_turn_started.wait(), timeout=1)
            resp = await client.post(
                f"/api/chat-sessions/{session_id}/live-message",
                json={"project_id": project.id, "content": "运行中追加要求"},
            )
            assert resp.status_code == 200
            assert resp.json()["status"] == "queued"
            resp = await client.post(f"/api/chat-sessions/{session_id}/stop")
            assert resp.status_code == 200
            assert resp.json()["stopped"] is True
            assert await _wait_turn(module, live_turn["turn_id"]) == "stopped"

            # empty content rejected
            resp = await client.post(
                f"/api/chat-sessions/{session_id}/chat",
                json={"project_id": project.id, "content": "   "},
                headers={"Idempotency-Key": "idem-empty"},
            )
            assert resp.status_code == 400

            # missing session
            resp = await client.get(
                "/api/chat-sessions/not-there",
                params={"project_id": project.id},
            )
            assert resp.status_code == 404
            resp = await client.post(
                "/api/chat-sessions/not-there/chat",
                json={"project_id": project.id, "content": "hi"},
                headers={"Idempotency-Key": "idem-missing"},
            )
            assert resp.status_code == 404

            # Stop is idempotent even when the session has no running turn.
            resp = await client.post(f"/api/chat-sessions/{session_id}/stop")
            assert resp.status_code == 200
            assert resp.json()["stopped"] is True

            # quick buttons PUT with validation
            resp = await client.put(
                "/api/chat-sessions/quick-buttons",
                json={
                    "project_id": project.id,
                    "buttons": [
                        {
                            "label": '<a href="https://example.com">打开文档</a>',
                            "prompt": "",
                        }
                    ],
                },
            )
            assert resp.status_code == 200
            assert resp.json()["buttons"][0] == {
                "id": resp.json()["buttons"][0]["id"],
                "label": '<a href="https://example.com">打开文档</a>',
                "prompt": "",
                "kind": "prompt",
                "immediate_send": False,
            }
            display_button = {
                "id": "docs-link",
                "label": "打开文档",
                "prompt": "",
                "kind": "display",
                "content": '<a href="https://example.com">文档地址</a>',
            }
            resp = await client.put(
                "/api/chat-sessions/quick-buttons",
                json={"project_id": project.id, "buttons": [display_button]},
            )
            assert resp.status_code == 200
            assert resp.json()["buttons"][0]["content"] == display_button["content"]
            resp = await client.get(
                "/api/chat-sessions/quick-buttons",
                params={"project_id": project.id},
            )
            assert resp.json()["buttons"][0]["content"] == display_button["content"]
            resp = await client.put(
                "/api/chat-sessions/quick-buttons",
                json={
                    "project_id": project.id,
                    "buttons": [{"label": "", "prompt": "x"}],
                },
            )
            assert resp.status_code == 400

            # system prompt GET/PUT contract
            resp = await client.get(
                "/api/chat-sessions/system-prompt",
                params={"project_id": project.id},
            )
            assert resp.status_code == 200
            assert resp.json()["prompt"] == ""
            assert resp.json()["default_prompt"] == SYSTEM_PROMPT
            resp = await client.put(
                "/api/chat-sessions/system-prompt",
                json={"project_id": project.id, "prompt": "自定义提示词"},
            )
            assert resp.status_code == 200
            assert resp.json()["prompt"] == "自定义提示词"
            resp = await client.get(
                "/api/chat-sessions/system-prompt",
                params={"project_id": project.id},
            )
            assert resp.json()["prompt"] == "自定义提示词"
            resp = await client.put(
                "/api/chat-sessions/system-prompt",
                json={"project_id": project.id, "prompt": "x" * 20001},
            )
            assert resp.status_code == 400
            resp = await client.put(
                "/api/chat-sessions/system-prompt",
                json={"project_id": project.id, "prompt": ""},
            )
            assert resp.status_code == 200
            assert resp.json()["prompt"] == ""

            # delete
            resp = await client.delete(
                "/api/chat-sessions/" + session_id,
                params={"project_id": project.id},
            )
            assert resp.status_code == 200
            resp = await client.delete(
                "/api/chat-sessions/" + session_id,
                params={"project_id": project.id},
            )
            assert resp.status_code == 404
    finally:
        await module.shutdown()
        await bus.close()
        manager.close_all()


@pytest.mark.anyio
async def test_invoke_engine_plan_mode_injects_instruction(monkeypatch):
    """Plan mode appends the plan instruction and engine read-only overrides."""
    import agent_assistants.base as base

    captured: dict = {}

    class PlanEngine:
        capabilities = SimpleNamespace(supports_thinking_effort=False)
        supports_resume = False
        supports_message_history = False

        async def spawn(self, prompt, cwd, model, session_id, **kwargs):
            captured["prompt"] = prompt
            captured["config_overrides"] = kwargs.get("config_overrides")
            if False:
                yield None

    monkeypatch.setattr(base, "create_engine", lambda engine_id: PlanEngine())
    await base.invoke_engine(
        "codex",
        None,
        "/tmp",
        "请分析这段代码",
        None,
        plan_mode=True,
    )
    assert "Plan mode" in captured["prompt"]
    assert captured["config_overrides"] == {"sandbox_mode": "read-only"}

    # Without plan mode the prompt stays untouched and no overrides are added.
    captured.clear()
    await base.invoke_engine(
        "codex",
        None,
        "/tmp",
        "请分析这段代码",
        None,
        plan_mode=False,
    )
    assert "Plan mode" not in captured["prompt"]
    assert captured["config_overrides"] is None


@pytest.mark.anyio
async def test_invoke_engine_uses_native_plan_mode_without_prompt_injection(monkeypatch):
    """原生计划模式由引擎参数承载，不再重复污染用户提示词。"""
    import agent_assistants.base as base

    captured: dict = {}

    class NativePlanEngine:
        capabilities = SimpleNamespace(
            supports_thinking_effort=False,
            supports_plan_mode=True,
        )
        supports_resume = True
        supports_message_history = False

        async def spawn(self, prompt, cwd, model, session_id, **kwargs):
            captured["prompt"] = prompt
            captured["plan_mode"] = kwargs.get("plan_mode")
            captured["config_overrides"] = kwargs.get("config_overrides")
            if False:
                yield None

    monkeypatch.setattr(base, "create_engine", lambda engine_id: NativePlanEngine())

    await base.invoke_engine(
        "codex_sdk",
        "gpt-5.6-codex",
        "/tmp",
        "请分析这段代码",
        None,
        plan_mode=True,
    )
    assert captured == {
        "prompt": "请分析这段代码",
        "plan_mode": True,
        "config_overrides": {"sandbox": "read-only"},
    }

    captured.clear()
    await base.invoke_engine(
        "codex_sdk",
        "gpt-5.6-codex",
        "/tmp",
        "现在开始实现",
        "thread-1",
        plan_mode=False,
    )
    assert captured == {
        "prompt": "现在开始实现",
        "plan_mode": False,
        "config_overrides": None,
    }


@pytest.mark.anyio
async def test_invoke_engine_routes_goal_command_only_to_native_adapter(monkeypatch):
    import agent_assistants.base as base

    captured: dict = {}

    class GoalEngine:
        capabilities = SimpleNamespace(supports_goal_mode=True, supports_thinking_effort=False)
        supports_resume = True
        supports_message_history = False

        async def spawn(self, prompt, cwd, model, session_id, **kwargs):
            captured.update(prompt=prompt, goal_action=kwargs.get("goal_action"))
            if False:
                yield None

    monkeypatch.setattr(base, "create_engine", lambda engine_id: GoalEngine())
    await base.invoke_engine("codex_sdk", None, "/tmp", "/goal 修复性能问题", "thread-1")
    assert captured == {"prompt": "修复性能问题", "goal_action": "start"}

    captured.clear()
    await base.invoke_engine("codex_sdk", None, "/tmp", "/goal pause", "thread-1")
    assert captured == {"prompt": "", "goal_action": "pause"}


@pytest.mark.anyio
async def test_invoke_engine_falls_back_to_prompt_for_unsupported_goal_start(monkeypatch):
    import agent_assistants.base as base

    captured: dict = {}

    class PlainEngine:
        capabilities = SimpleNamespace(supports_goal_mode=False, supports_thinking_effort=False)
        supports_resume = False
        supports_message_history = False

        async def spawn(self, **kwargs):
            captured.update(prompt=kwargs.get("prompt"), goal_action=kwargs.get("goal_action"))
            if False:
                yield

    monkeypatch.setattr(base, "create_engine", lambda engine_id: PlainEngine())
    await base.invoke_engine("codex", None, "/tmp", "/goal 修复性能问题", None)
    assert captured.get("goal_action") is None
    assert "修复性能问题" in captured.get("prompt")
    assert "Goal mode" in captured.get("prompt")


@pytest.mark.anyio
async def test_invoke_engine_rejects_unsupported_goal_control(monkeypatch):
    import agent_assistants.base as base

    class PlainEngine:
        capabilities = SimpleNamespace(supports_goal_mode=False, supports_thinking_effort=False)
        supports_resume = False
        supports_message_history = False

        async def spawn(self, **kwargs):
            raise AssertionError("unsupported goal control must not become a normal prompt")
            yield

    monkeypatch.setattr(base, "create_engine", lambda engine_id: PlainEngine())
    with pytest.raises(ValueError, match="目标模式"):
        await base.invoke_engine("codex", None, "/tmp", "/goal pause", None)


@pytest.mark.anyio
async def test_invoke_engine_forwards_live_message_queue(monkeypatch):
    """共享助手运行时把当前回合的插入队列原样交给引擎。"""
    import agent_assistants.base as base

    captured: dict = {}

    class LiveEngine:
        capabilities = SimpleNamespace(
            supports_thinking_effort=False,
            supports_live_step_message=True,
        )
        supports_resume = False
        supports_message_history = False

        async def spawn(self, prompt, cwd, model, session_id, **kwargs):
            captured["queue"] = kwargs.get("live_message_queue")
            if False:
                yield None

    queue = asyncio.Queue()
    monkeypatch.setattr(base, "create_engine", lambda engine_id: LiveEngine())
    await base.invoke_engine(
        "codex",
        None,
        "/tmp",
        "执行任务",
        None,
        live_message_queue=queue,
    )
    assert captured["queue"] is queue


@pytest.mark.anyio
async def test_invoke_engine_factory_does_not_block_event_loop(monkeypatch):
    """A synchronous engine constructor must leave other coroutines runnable."""
    import agent_assistants.base as base

    class Engine:
        capabilities = SimpleNamespace(supports_thinking_effort=False)
        supports_resume = False
        supports_message_history = False

        async def spawn(self, prompt, cwd, model, session_id, **kwargs):
            if False:
                yield None

    def slow_factory(_engine_id):
        time.sleep(0.15)
        return Engine()

    monkeypatch.setattr(base, "create_engine", slow_factory)
    started = time.monotonic()
    work = asyncio.create_task(
        base.invoke_engine("codex", None, "/tmp", "执行任务", None)
    )
    try:
        await asyncio.sleep(0.01)
        assert time.monotonic() - started < 0.1
        await work
    finally:
        if not work.done():
            work.cancel()
            await asyncio.gather(work, return_exceptions=True)


@pytest.mark.anyio
async def test_invoke_engine_image_config_does_not_block_event_loop(monkeypatch):
    import agent_assistants.base as base
    from engines.core.schema import EngineImage

    class Engine:
        capabilities = SimpleNamespace(
            supports_vision=True, supports_thinking_effort=False,
        )
        supports_resume = False
        supports_message_history = False

        async def spawn(self, prompt, cwd, model, session_id, **kwargs):
            if False:
                yield None

    def slow_multimodal(_engine_id, _model, _provider_id):
        time.sleep(0.15)
        return True

    monkeypatch.setattr(base, "create_engine", lambda _engine_id: Engine())
    monkeypatch.setattr(
        base.config_store, "model_supports_multimodal", slow_multimodal
    )
    started = time.monotonic()
    work = asyncio.create_task(base.invoke_engine(
        "codex", "vision-model", "/tmp", "查看图片", None,
        images=[EngineImage(url="data:image/png;base64,AA==")],
    ))
    try:
        await asyncio.sleep(0.01)
        assert time.monotonic() - started < 0.1
        await work
    finally:
        if not work.done():
            work.cancel()
            await asyncio.gather(work, return_exceptions=True)


@pytest.mark.anyio
async def test_chat_turn_idle_timeout_errors_and_preserves_session(
    chat_module, monkeypatch
):
    """引擎流长时间无事件时，聊天回合应落为 error 而不是无限等待。"""
    module, _bus, _manager, project, config_store = chat_module
    config_store.values["engine_idle_timeout_seconds"] = 0.2
    session = module.create_session(project.id)

    async def stalled_invoke(
        engine_id, model, cwd, prompt, session_id, on_event=None, **kwargs
    ):
        await asyncio.sleep(30)
        return "", [], session_id or "never"

    monkeypatch.setattr(module, "_invoke", stalled_invoke)
    accepted = module.submit_message(project.id, session["id"], "hi", "idle-1")
    assert await _wait_turn(module, accepted.turn_id, timeout=10.0) == "error"
    detail = module.get_session(project.id, session["id"])
    assert detail is not None
    last = detail["messages"][-1]
    assert last["status"] == "error"
    assert "空闲超时" in (last.get("content") or "")


@pytest.mark.anyio
@pytest.mark.parametrize("memory_running", [False, True])
@pytest.mark.parametrize("prior_status", ["succeeded", "error"])
async def test_running_chat_can_fork_prior_reply_via_api_with_slow_db_canary(
    chat_module, monkeypatch, memory_running, prior_status,
):
    import main

    module, _bus, manager, project, _ = chat_module
    source = module.create_session(project.id, title="执行中的会话", engine="claude")
    now = utc_now()
    with module._project_ctx(project.id):
        row = ChatSession.get_by_id(source["id"])
        ChatMessage.create(id="prior-reply", session=row, role="assistant",
                           content="已经完成的结论", status=prior_status, created_at=now)
        ChatMessage.create(id="active-reply", session=row, role="assistant",
                           content="正在执行", status="running", created_at=now + timedelta(seconds=1))
    if memory_running:
        module._turn_states["active-turn"] = {"session_id": source["id"], "status": "running"}
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    entered = threading.Event()
    release = threading.Event()
    original_execute = project.db.execute_sql

    def slow_source_query(sql, params=None, commit=None):
        if not entered.is_set() and 'SELECT' in sql and 'chat_messages' in sql:
            entered.set()
            release.wait(timeout=2)
        return original_execute(sql, params)

    monkeypatch.setattr(project.db, "execute_sql", slow_source_query)
    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        request = asyncio.create_task(client.post(
            f"/api/chat-sessions/{source['id']}/fork",
            json={"project_id": project.id, "title": "历史分支", "engine": "claude",
                  "context_mode": "smart", "fork_message_id": "prior-reply"},
        ))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
            assert health.status_code == 200
        finally:
            release.set()
        response = await request
        assert response.status_code == 200, response.text
        branch = response.json()
        assert branch["id"] != source["id"]
        assert branch["fork_context_mode"] == "smart"
        assert [item["content"] for item in branch["messages"]] == ["已经完成的结论"]
        source_detail = await manager.run_db(project.id, lambda _project: module.get_session(project.id, source["id"]))
        assert source_detail["running"] is True
        assert source_detail["messages"][-1]["status"] == "running"
        for cutoff, mode in [("active-reply", "smart"), ("prior-reply", "native"), (None, "smart")]:
            refused = await client.post(
                f"/api/chat-sessions/{source['id']}/fork",
                json={"project_id": project.id, "title": "不稳定分支", "engine": "claude",
                      "context_mode": mode, "fork_message_id": cutoff},
            )
            assert refused.status_code == 409, refused.text


@pytest.mark.anyio
@pytest.mark.parametrize("overrides,expected_provider,expected_model,expected_resume", [
    ({"engine": "claude"}, "provider-a", "stored-model", "existing-engine-session"),
    ({"provider_id": "provider-b", "model": "new-model"}, "provider-b", "new-model", None),
    ({"provider_id": "", "model": ""}, None, None, None),
])
async def test_chat_config_api_inheritance_and_explicit_updates_with_slow_sql(
    chat_module, monkeypatch, overrides, expected_provider, expected_model, expected_resume,
):
    import main

    module, _bus, manager, project, config = chat_module
    config.values["providers"] = [
        {"id": name, "protocol": "openai_compatible", "enabled": True}
        for name in ("provider-a", "provider-b")
    ]
    source = module.create_session(
        project.id, engine="claude", provider_id="provider-a",
        model="stored-model", fast_model="stored-fast", vision_model="stored-vision",
    )
    with module._project_ctx(project.id):
        ChatSession.update(engine_session_id="existing-engine-session").where(
            ChatSession.id == source["id"],
        ).execute()
    captured = {}

    async def fake_invoke_engine(*args, **kwargs):
        captured["provider"] = (kwargs.get("config_overrides") or {}).get("provider_id")
        captured["resume"] = args[4]
        return "ok", [], args[4]

    monkeypatch.setattr("agent_assistants.base.invoke_engine", fake_invoke_engine)
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    entered = threading.Event()
    release = threading.Event()
    original_execute = project.db.execute_sql

    def slow_query(sql, *args, **kwargs):
        if not entered.is_set() and sql.startswith('SELECT') and 'chat_sessions' in sql:
            entered.set()
            release.wait(timeout=2)
        return original_execute(sql, *args, **kwargs)

    monkeypatch.setattr(project.db, "execute_sql", slow_query)
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        request = asyncio.create_task(client.post(
            f"/api/chat-sessions/{source['id']}/chat",
            headers={"Idempotency-Key": "config-api"},
            json={"project_id": project.id, "content": "hello", **overrides},
        ))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            assert not request.done()
            health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
            assert health.status_code == 200
        finally:
            release.set()
        response = await request
    assert response.status_code == 200, response.text
    assert await _wait_turn(module, response.json()["turn_id"]) == "completed"
    detail = await manager.run_db(project.id, lambda _project: module.get_session(project.id, source["id"]))
    assert captured == {"provider": expected_provider, "resume": expected_resume}
    assert detail["provider_id"] == expected_provider
    assert detail["model"] == expected_model
    assert detail["fast_model"] == "stored-fast"
    assert detail["vision_model"] == "stored-vision"


@pytest.mark.anyio
async def test_session_history_pages_and_slow_query_keep_health_responsive(chat_module, monkeypatch):
    import main

    module, _bus, manager, project, _ = chat_module
    def seed(_project):
        created = module.create_session(project.id, title="分页")
        with module._project_ctx(project.id):
            row = ChatSession.get_by_id(created["id"])
            for index in range(305):
                ChatMessage.create(id=f"page-{index:03}", session=row, role="user",
                                   content=str(index), created_at=datetime(2026, 1, 1) + timedelta(seconds=index))
        return created["id"]
    session_id = await manager.run_db(project.id, seed)
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    entered, release = threading.Event(), threading.Event()
    original = project.db.execute_sql
    queries = []
    def slow_query(sql, *args, **kwargs):
        if sql.startswith('SELECT') and 'FROM "chat_messages"' in sql and 'ORDER BY' in sql:
            queries.append(sql)
            entered.set()
            release.wait(timeout=2)
        return original(sql, *args, **kwargs)
    monkeypatch.setattr(project.db, "execute_sql", slow_query)
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        pending = asyncio.create_task(client.get(f"/api/chat-sessions/{session_id}", params={"project_id": project.id}))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            assert (await asyncio.wait_for(client.get("/api/health"), .2)).status_code == 200
        finally:
            release.set()
        first = (await pending).json()
        assert len(first["messages"]) == 300
        assert first["messages"][0]["content"] == "5"
        assert first["messages"][-1]["content"] == "304"
        assert all('LIMIT' in sql for sql in queries)
        older = (await client.get(f"/api/chat-sessions/{session_id}", params={"project_id": project.id, "offset": 300})).json()
        assert [m["content"] for m in older["messages"]] == [str(i) for i in range(5)]
        assert (await client.get(f"/api/chat-sessions/{session_id}", params={"project_id": project.id, "limit": 301})).status_code == 422


@pytest.mark.anyio
@pytest.mark.parametrize("transport", ["body", "system", "developer"])
async def test_chat_global_rules_transport_and_slow_read_keep_api_responsive(
    chat_module, monkeypatch, transport,
):
    import main
    from engines.core.acp_base import AcpEngineBase

    module, bus, manager, project, _ = chat_module
    calls = []

    class Engine(FakeEngine, AcpEngineBase):
        ENGINE_ID = "recording-chat"
        SYSTEM_PROMPT_MODE = transport
        supports_resume = True

        @staticmethod
        def is_installed():
            return True

        @staticmethod
        def get_version():
            return "test"

        @staticmethod
        def resolve_binary():
            return None

        async def spawn(self, prompt, cwd, model=None, session_id=None, **kwargs):
            calls.append((prompt, session_id, kwargs))
            yield InternalEvent(type="session_started", data={"session_id": "thread"})
            yield InternalEvent(type="agent_message_chunk", data={"content": {"type": "text", "text": "完成"}})
            yield InternalEvent(type="done", data={})

    monkeypatch.setattr("agent_assistants.chat_session.create_engine", lambda _id: Engine())
    monkeypatch.setattr("agent_assistants.base.create_engine", lambda _id: Engine())
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    session = module.create_session(project.id, engine="claude")
    module.set_system_prompt(project.id, "固定全局规则")
    entered, release = threading.Event(), threading.Event()
    original_get = module.get_system_prompt

    def slow_get(project_id):
        entered.set()
        assert release.wait(2)
        return original_get(project_id)

    monkeypatch.setattr(module, "get_system_prompt", slow_get)
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        response = await client.post(
            f"/api/chat-sessions/{session['id']}/chat",
            headers={"Idempotency-Key": "global-instruction-first"},
            json={"project_id": project.id, "content": "第一次"},
        )
        assert response.status_code == 200, response.text
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            assert (await asyncio.wait_for(client.get("/api/health"), .2)).status_code == 200
        finally:
            release.set()
        assert await _wait_turn(module, response.json()["turn_id"]) == "completed"
        monkeypatch.setattr(module, "get_system_prompt", original_get)
        response = await client.post(
            f"/api/chat-sessions/{session['id']}/chat",
            headers={"Idempotency-Key": "global-instruction-second"},
            json={"project_id": project.id, "content": "第二次"},
        )
        assert response.status_code == 200, response.text
        assert await _wait_turn(module, response.json()["turn_id"]) == "completed"
        detail = (await client.get(f"/api/chat-sessions/{session['id']}", params={"project_id": project.id})).json()
    assert [item["content"] for item in detail["messages"] if item["role"] == "user"] == ["第一次", "第二次"]
    assert [call[1] for call in calls] == [None, "thread"]
    if transport == "body":
        assert [call[0] for call in calls] == ["固定全局规则\n\n第一次", "第二次"]
        assert all("system_prompt" not in call[2] for call in calls)
        assert "固定全局规则" not in detail["messages"][-1]["prompt"]
    else:
        assert [call[0] for call in calls] == ["第一次", "第二次"]
        assert [call[2]["system_prompt"] for call in calls] == ["固定全局规则", "固定全局规则"]
        assert "固定全局规则" in detail["messages"][-1]["prompt"]
    assert "原始调用记录" not in detail["messages"][-1]["prompt"]
    assert "### 正文（user）" in detail["messages"][-1]["prompt"]
    saved_prompts = await manager.run_db(project.id, lambda _project: [
        row.prompt for row in ChatMessage.select().where(ChatMessage.session == session["id"])
    ])
    assert detail["messages"][-1]["prompt"] in saved_prompts
    await manager.run_db(project.id, lambda _project: module.set_system_prompt(project.id, "后来修改的规则"))
    unchanged = await manager.run_db(project.id, lambda _project: module.get_session(project.id, session["id"]))
    assert "后来修改的规则" not in unchanged["messages"][-1]["prompt"]
    assert unchanged["messages"][-1]["prompt"] == detail["messages"][-1]["prompt"]
    module._sessions.clear()
    reloaded = await manager.run_db(project.id, lambda _project: module.get_session(project.id, session["id"]))
    assert reloaded["messages"][-1]["prompt"] == detail["messages"][-1]["prompt"]


@pytest.mark.anyio
async def test_prompt_view_does_not_invent_historical_injection(chat_module, monkeypatch):
    import main
    module, _bus, manager, project, _config = chat_module
    session = await manager.run_db(project.id, lambda _project: module.create_session(project.id, engine="claude"))

    def seed(_project):
        row = ChatSession.get_by_id(session["id"])
        ChatMessage.create(id="source-user", session=row, role="user", content="原始问题", created_at=utc_now())
        ChatMessage.create(id="source-answer", session=row, role="assistant", content="回答", prompt="过去的冗长快照", created_at=utc_now())
        module.set_system_prompt(project.id, "当前全局规则")
    await manager.run_db(project.id, seed)
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    def forbidden_rules(_project_id):
        raise AssertionError("Viewing past inputs must not rebuild them from current rules")
    monkeypatch.setattr(module, "get_system_prompt", forbidden_rules)
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        response = await client.get(
            f"/api/chat-sessions/{session['id']}", params={"project_id": project.id, "limit": 1},
        )
    assert response.status_code == 200
    assert response.json()["messages"][0]["prompt"] == "过去的冗长快照"
    stored = await manager.run_db(project.id, lambda _project: ChatMessage.get_by_id("source-answer").prompt)
    assert stored == "过去的冗长快照"  # Viewing does not rewrite historical rows.


@pytest.mark.anyio
async def test_saving_partial_history_preserves_existing_prompt(chat_module):
    from agent_assistants.session_state import AssistantSession
    from agent_assistants.chat_row_persistence import ChatRowPersistence
    module, _, manager, project, _ = chat_module
    summary = await manager.run_db(project.id, lambda _: module.create_session(project.id, engine="claude"))
    def save_partial(_):
        row = ChatSession.get_by_id(summary["id"])
        ChatMessage.create(id="old-prompt", session=row, role="assistant", content="旧回答", prompt="以前存好的提示词", created_at=utc_now())
        runtime = AssistantSession(session_id=row.id, project_id=project.id, scope="chat", engine=row.engine)
        runtime.messages = [{"id":"old-prompt", "role":"assistant", "content":"旧回答", "prompt":""}]
        ChatRowPersistence().save(runtime)
        return ChatMessage.get_by_id("old-prompt").prompt
    assert await manager.run_db(project.id, save_partial) == "以前存好的提示词"

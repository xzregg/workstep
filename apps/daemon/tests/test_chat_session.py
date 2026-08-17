"""Tests for Codex-style session chats (chat_sessions / chat_messages)."""

import asyncio
import json
import time
from datetime import datetime
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient

from models import LATEST_SCHEMA_VERSION, SchemaVersion, init_db
from models.chat_session import ChatMessage, ChatSession, ProjectSetting
from agent_assistants.chat_session import DEFAULT_QUICK_BUTTONS, SYSTEM_PROMPT, ChatSessionModule
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

    def get_coordinator_default_model(self):
        return self.values.get("coordinator_default_model", "")

    def get_coordinator_default_fast_model(self):
        return self.values.get("coordinator_default_fast_model", "")

    def get_engine_default_model(self, engine_id):
        return self.values.get("engine_default_models", {}).get(engine_id, "")

    def get_pydantic_ai_engine_config(self):
        return self.values.get("pydantic_ai_engine", {})

    def get_prompt_enhance_config(self):
        raw = self.values.get("prompt_enhance", {})
        return {
            "provider_id": raw.get("provider_id", ""),
            "model": raw.get("model", ""),
        }

    def set_prompt_enhance_config(self, *, provider_id, model):
        self.values["prompt_enhance"] = {"provider_id": provider_id, "model": model}

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
    capabilities = SimpleNamespace(supports_coordinator=True)
    supports_resume = False
    supports_message_history = False


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
    import services.config as config_service
    import services.project as project_service

    config_store = MemoryConfigStore()
    monkeypatch.setattr(config_service, "config_store", config_store)
    monkeypatch.setattr(project_service, "config_store", config_store)
    monkeypatch.setattr(chat_service, "config_store", config_store)
    monkeypatch.setattr(chat_service, "create_engine", lambda engine_id: FakeEngine())

    manager = ProjectManager()
    bus = EventBus()
    module = ChatSessionModule(bus, manager)
    project = manager.init_project(tmp_path / "chat-proj")
    yield module, bus, manager, project, config_store
    await module.shutdown()
    await bus.close()
    manager.close_all()


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
async def test_enhance_prompt_falls_back_to_default_engine(chat_module, monkeypatch):
    """Without Pydantic AI config, prompt enhancement falls back to the default chat engine."""
    module, bus, manager, project, config_store = chat_module
    calls: list[tuple] = []

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event, **kwargs):
        calls.append((engine_id, model, prompt, kwargs))
        return "改写后的清晰提示词。", [], None

    def kwargs_of(call):
        return call[3]

    config_store.set("coordinator_default_model", "slow-model")
    config_store.set("coordinator_default_fast_model", "fast-model")
    monkeypatch.setattr("agent_assistants.base.invoke_engine", fake_invoke)
    result = await module.enhance_prompt(project.id, "帮我写个函数")
    assert result == "改写后的清晰提示词。"
    assert calls
    assert calls[0][0] in ("codex", "claude", "claude_agent_sdk")
    assert calls[0][1] == "fast-model"
    assert "帮我写个函数" in calls[0][2]
    assert kwargs_of(calls[0])["thinking_effort"] == "minimal"
    assert kwargs_of(calls[0])["permission_mode"] == "auto"

    with pytest.raises(ValueError):
        await module.enhance_prompt(project.id, "   ")


@pytest.mark.anyio
async def test_enhance_prompt_uses_configured_provider_direct_chat_completions(chat_module, monkeypatch):
    """With an enhance provider + model configured, the rewrite goes through direct chat/completions."""
    module, bus, manager, project, config_store = chat_module
    config_store.set_prompt_enhance_config(
        provider_id="p-1",
        model="fast-model-x",
    )
    config_store.values["providers"] = [
        {"id": "p-1", "base_url": "http://localhost:1/v1", "api_key": "k", "enabled": True}
    ]
    calls: list[dict] = []
    pydantic_calls: list = []
    invoke_calls: list = []

    async def fake_chat_completion(provider, model, messages, **kwargs):
        calls.append({"provider": provider["id"], "model": model, "messages": messages})
        return "改写后的清晰提示词。"

    async def fake_simple(prompt):
        pydantic_calls.append(prompt)
        return "回退后的提示词。"

    async def fake_invoke(*args, **kwargs):
        invoke_calls.append(args)
        return "", [], None

    monkeypatch.setattr(
        "services.providers.chat_completion",
        fake_chat_completion,
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
    assert not pydantic_calls and not invoke_calls

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

    async def fake_simple(prompt):
        prompts.append(prompt)
        return "改写后的清晰提示词。"

    async def fake_invoke(*args, **kwargs):
        invoke_calls.append(args)
        return "", [], None

    monkeypatch.setattr(
        "engines.pydantic_ai.engine.PydanticAIEngine.run_simple",
        fake_simple,
    )
    monkeypatch.setattr("agent_assistants.base.invoke_engine", fake_invoke)

    result = await module.enhance_prompt(project.id, "帮我写个函数")
    assert result == "改写后的清晰提示词。"
    assert prompts and "帮我写个函数" in prompts[0]
    assert not invoke_calls  # 不经过协调引擎


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
    assert user_message["author_device_id"] == "device-a"


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
async def test_quick_buttons_defaults_and_validation(chat_module):
    module, bus, manager, project, _ = chat_module

    defaults = module.get_quick_buttons(project.id)
    assert defaults == DEFAULT_QUICK_BUTTONS

    saved = module.set_quick_buttons(
        project.id,
        [
            {"label": "解释代码", "prompt": "请解释项目结构"},
            {"label": "写测试", "prompt": "请设计单元测试"},
        ],
    )
    assert [item["label"] for item in saved] == ["解释代码", "写测试"]
    assert module.get_quick_buttons(project.id) == saved

    with pytest.raises(ValueError):
        module.set_quick_buttons(project.id, [{"label": "", "prompt": "x"}])
    with pytest.raises(ValueError):
        module.set_quick_buttons(project.id, [{"label": "x", "prompt": ""}])
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
async def test_system_prompt_defaults_validation_and_restore(chat_module):
    module, bus, manager, project, _ = chat_module

    # Unset → built-in default.
    assert module.get_system_prompt(project.id) == SYSTEM_PROMPT

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

    # Empty input restores the default and removes the row.
    assert module.set_system_prompt(project.id, "   ") == SYSTEM_PROMPT
    assert module.get_system_prompt(project.id) == SYSTEM_PROMPT
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

    async def fake_invoke(engine_id, model, cwd, prompt, session_id, on_event=None, message_history=None):
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
            assert [item["role"] for item in body["messages"]] == [
                "user", "assistant", "user", "assistant",
            ]
            assert body["messages"][-1]["content"] == "HTTP 回复"

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

            # stop (no running turn → False, still 200)
            resp = await client.post(f"/api/chat-sessions/{session_id}/stop")
            assert resp.status_code == 200
            assert resp.json()["stopped"] is False

            # quick buttons PUT with validation
            resp = await client.put(
                "/api/chat-sessions/quick-buttons",
                json={
                    "project_id": project.id,
                    "buttons": [{"label": "解释", "prompt": "请解释"}],
                },
            )
            assert resp.status_code == 200
            assert resp.json()["buttons"][0]["label"] == "解释"
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
            assert resp.json()["prompt"] == SYSTEM_PROMPT
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
            assert resp.json()["prompt"] == SYSTEM_PROMPT

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
    assert "计划模式" in captured["prompt"]
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
    assert "计划模式" not in captured["prompt"]
    assert captured["config_overrides"] is None

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
    capabilities = SimpleNamespace(
        supports_coordinator=True,
        supports_live_stage_message=True,
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
    assert detail["messages"][-1]["prompt"] == prompts[0]
    assert "<workstep_context_handoff>" in detail["messages"][-1]["prompt"]
    assert str(handoff_path.resolve()) in detail["messages"][-1]["prompt"]
    with module._project_ctx(project.id):
        row = ChatSession.get_by_id(source["id"])
        assert row.fork_context_json is None


@pytest.mark.anyio
async def test_resumed_chat_prompt_view_keeps_custom_system_injection_visible(
    chat_module, monkeypatch
):
    """查看提示词应展示引擎会话中仍然生效的项目自定义系统提示。"""
    import agent_assistants.chat_session as chat_service

    module, _bus, _manager, project, _ = chat_module
    custom_system = "你是项目专属架构助手。"
    module.set_system_prompt(project.id, custom_system)
    session = module.create_session(project.id, title="系统提示展示", engine="claude")
    sent_prompts: list[str] = []

    class ResumeEngine(FakeEngine):
        supports_resume = True

    monkeypatch.setattr(chat_service, "create_engine", lambda _engine_id: ResumeEngine())

    async def fake_invoke(
        engine_id, model, cwd, prompt, session_id, on_event=None,
        message_history=None,
    ):
        sent_prompts.append(prompt)
        return "完成", [], "engine-session"

    monkeypatch.setattr(module, "_invoke", fake_invoke)
    first = module.submit_message(project.id, session["id"], "第一次", "chat-display-1")
    assert await _wait_turn(module, first.turn_id) == "completed"
    second = module.submit_message(project.id, session["id"], "第二次", "chat-display-2")
    assert await _wait_turn(module, second.turn_id) == "completed"

    assert custom_system not in sent_prompts[1]
    visible_prompt = module.get_session(project.id, session["id"])["messages"][-1]["prompt"]
    assert visible_prompt.startswith(custom_system)
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
        "/Users/xzr/Desktop/workstep/.workstep/visualizations/"
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
        "/Users/xzr/Desktop/workstep/.workstep/visualizations/"
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
        "/Users/xzr/Desktop/workstep/.workstep/visualizations/"
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
    module, _bus, _manager, project, _ = chat_module
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

    inserted = await module.send_live_message(session["id"], "改为先补测试")

    assert inserted["status"] == "queued"
    queue = module._turn_states[accepted.turn_id]["live_message_queue"]
    assert queue.get_nowait() == (inserted["message_id"], "改为先补测试")
    detail = module.get_session(project.id, session["id"])
    assert detail["messages"][-1]["role"] == "user"
    assert detail["messages"][-1]["content"] == "改为先补测试"

    assert await module.stop_current(session["id"]) is True
    assert await _wait_turn(module, accepted.turn_id) == "stopped"


@pytest.mark.anyio
async def test_live_message_splits_chat_reply_around_inserted_user_message(
    chat_module,
    monkeypatch,
):
    """会话顺序与任务阶段一致：第一段输出 → 用户插入 → 第二段输出。"""
    module, _bus, _manager, project, _ = chat_module
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
    assert detail["messages"][3]["prompt"] == "插入要求"


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
async def test_invoke_engine_forwards_live_message_queue(monkeypatch):
    """共享助手运行时把当前回合的插入队列原样交给引擎。"""
    import agent_assistants.base as base

    captured: dict = {}

    class LiveEngine:
        capabilities = SimpleNamespace(
            supports_thinking_effort=False,
            supports_live_stage_message=True,
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

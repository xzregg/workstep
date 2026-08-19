"""DeepSeek Harness SDK 引擎契约。"""

import asyncio
import sys
from types import SimpleNamespace

import pytest

from engines.core.base import EngineCapabilities
from engines.deepseek_harness import DeepSeekHarnessEngine


def notification(method: str, payload: dict):
    return SimpleNamespace(method=method, payload=payload)


@pytest.fixture
def deepseek_provider():
    return {
        "id": "deepseek-official",
        "name": "DeepSeek 官方",
        "type": "deepseek",
        "base_url": "https://api.deepseek.com",
        "api_key": "secret",
        "enabled": True,
    }


def test_deepseek_harness_declares_sdk_install_and_safe_capabilities(monkeypatch):
    monkeypatch.setattr(DeepSeekHarnessEngine, "is_configured", staticmethod(lambda: True))

    assert DeepSeekHarnessEngine.install_command() == (
        "pip install deepseek-harness-sdk==0.1.0rc6"
    )
    assert DeepSeekHarnessEngine().capabilities == EngineCapabilities(
        supports_coordinator=True,
        supports_resume=True,
        supports_tool_disable=False,
        supports_native_schema=False,
        supports_live_stage_message=False,
        supports_sessions=True,
        supports_tool_approval=False,
        supports_vision=False,
        supports_workstep_tools=False,
        supports_thinking_effort=False,
    )


def test_deepseek_harness_config_only_accepts_enabled_deepseek_provider(
    monkeypatch,
    deepseek_provider,
):
    saved = {}
    monkeypatch.setattr(
        "engines.deepseek_harness.config_store.get_provider",
        lambda provider_id: deepseek_provider if provider_id == deepseek_provider["id"] else None,
    )
    monkeypatch.setattr(
        "engines.deepseek_harness.config_store.get_deepseek_harness_config",
        lambda: {
            "provider_id": "",
            "model": "deepseek-v4-flash",
            "max_tokens": "",
            "preset": "standard",
        },
    )
    monkeypatch.setattr(
        "engines.deepseek_harness.config_store.set_deepseek_harness_config",
        lambda **values: saved.update(values),
    )

    engine = DeepSeekHarnessEngine()
    asyncio.run(engine.save_config_values({"provider_id": "deepseek-official"}))

    assert saved == {
        "provider_id": "deepseek-official",
        "model": "deepseek-v4-flash",
        "max_tokens": "",
        "preset": "standard",
    }

    deepseek_provider["type"] = "openai"
    with pytest.raises(ValueError, match="DeepSeek"):
        asyncio.run(engine.save_config_values({"provider_id": "deepseek-official"}))


def test_deepseek_harness_is_configured_requires_provider_credentials(
    monkeypatch,
    deepseek_provider,
):
    monkeypatch.setattr(
        "engines.deepseek_harness.config_store.get_deepseek_harness_config",
        lambda: {"provider_id": "deepseek-official", "model": "deepseek-v4-flash"},
    )
    monkeypatch.setattr(
        "engines.deepseek_harness.config_store.get_provider",
        lambda _provider_id: deepseek_provider,
    )

    assert DeepSeekHarnessEngine.is_configured() is True
    deepseek_provider["api_key"] = ""
    assert DeepSeekHarnessEngine.is_configured() is False


def test_deepseek_harness_uses_workstep_standard_composition(
    monkeypatch,
    tmp_path,
    deepseek_provider,
):
    captured = {}

    class FakeHarness:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setitem(
        sys.modules,
        "deepseek_harness",
        SimpleNamespace(DeepSeekHarness=FakeHarness),
    )

    engine = DeepSeekHarnessEngine()
    engine._build_harness(
        cwd=str(tmp_path),
        provider=deepseek_provider,
        model="deepseek-v4-flash",
        max_tokens=None,
        preset="standard",
    )

    composition = captured["cordis"]
    assert composition.endswith("data/deepseek-harness/standard.cordis.yml")
    assert captured["provider"] == "deepseek-official"
    assert captured["cwd"] == str(tmp_path)


def test_deepseek_harness_rejects_unknown_preset(
    tmp_path,
    deepseek_provider,
):
    with pytest.raises(ValueError, match="preset"):
        DeepSeekHarnessEngine()._build_harness(
            cwd=str(tmp_path),
            provider=deepseek_provider,
            model="deepseek-v4-flash",
            max_tokens=None,
            preset="code",
        )


def test_deepseek_harness_maps_stream_tool_usage_plan_and_compaction():
    engine = DeepSeekHarnessEngine()

    text = engine._map_notification(notification("session.event", {
        "sessionId": "root",
        "event": {"type": "assistant/chunk", "data": {
            "turn": 1,
            "step": 2,
            "chunk": {"type": "text-delta", "index": 0, "text": "你好"},
        }},
    }), "root")
    thought = engine._map_notification(notification("session.event", {
        "sessionId": "root",
        "event": {"type": "assistant/chunk", "data": {
            "turn": 1,
            "step": 2,
            "chunk": {"type": "reasoning-delta", "index": 1, "text": "思考"},
        }},
    }), "root")
    call = engine._map_notification(notification("session.event", {
        "sessionId": "root",
        "event": {"type": "tool/call", "data": {
            "callId": "call-1", "name": "read", "arguments": '{"path":"a.py"}',
        }},
    }), "root")
    result = engine._map_notification(notification("session.event", {
        "sessionId": "root",
        "event": {"type": "tool/result", "data": {
            "message": {
                "content": [{"type": "text", "text": "ok"}],
                "source": {"kind": "tool", "callId": "call-1"},
            },
            "isError": False,
        }},
    }), "root")
    message = engine._map_notification(notification("session.event", {
        "sessionId": "root",
        "event": {"type": "assistant/message", "data": {
            "turn": 1,
            "step": 2,
            "message": {"content": [{"type": "text", "text": "你好"}]},
            "usage": {"inputTokens": 10, "outputTokens": 3},
        }},
    }), "root")
    plan = engine._map_notification(notification("session.event", {
        "sessionId": "root",
        "event": {"type": "todo/write", "data": {"todos": [
            {"content": "读代码", "status": "in_progress"},
            {"content": "写测试", "status": "pending"},
        ]}},
    }), "root")
    compacted = engine._map_notification(notification("session.event", {
        "sessionId": "root",
        "event": {"type": "compaction/summary", "data": {
            "summary": [{"type": "text", "text": "已压缩历史"}],
        }},
    }), "root")

    assert [(event.type, event.data) for event in text] == [
        ("agent_message_chunk", {"content": {"text": "你好"}}),
    ]
    assert thought[0].type == "agent_thought_chunk"
    assert call[0].data == {
        "tool_call_id": "call-1",
        "title": "read",
        "kind": "other",
        "raw_input": {"path": "a.py"},
    }
    assert result[0].data == {
        "tool_call_id": "call-1",
        "status": "completed",
        "raw_output": "ok",
    }
    assert [event.type for event in message] == ["usage_update"]
    assert message[0].data["input_tokens"] == 10
    assert message[0].data["output_tokens"] == 3
    assert plan[0].type == "plan"
    assert [entry["status"] for entry in plan[0].data["entries"]] == [
        "in_progress", "pending",
    ]
    assert compacted[0].data == {"summary": "已压缩历史"}


def test_deepseek_harness_keeps_root_text_separate_from_subagents_and_unknown_events():
    engine = DeepSeekHarnessEngine()

    child_message = engine._map_notification(notification("session.event", {
        "sessionId": "child",
        "event": {"type": "assistant/chunk", "data": {
            "chunk": {"type": "text-delta", "index": 0, "text": "child text"},
        }},
    }), "root")
    started = engine._map_notification(notification("subagent.started", {
        "parentSessionId": "root", "childSessionId": "child",
    }), "root")
    unknown = engine._map_notification(notification("session.event", {
        "sessionId": "root",
        "event": {"type": "future/event", "data": {"value": 1}},
    }), "root")

    assert child_message == []
    assert started[0].type == "subagent"
    assert started[0].data == {
        "task_id": "child",
        "status": "running",
        "stage": "started",
        "description": "DeepSeek Harness 子代理 child",
    }
    assert unknown[0].type == "acp_raw"
    assert unknown[0].data["type"] == "future/event"


def test_deepseek_harness_surfaces_terminal_provider_error():
    engine = DeepSeekHarnessEngine()
    events = engine._map_notification(notification("session.event", {
        "sessionId": "root",
        "event": {"type": "turn/end", "data": {"reason": {
            "kind": "error",
            "error": {"code": "AUTH", "message": "API key is invalid"},
        }}},
    }), "root")

    assert [(event.type, event.data) for event in events] == [
        ("error", {"message": "API key is invalid", "code": "AUTH"}),
    ]


def test_deepseek_harness_spawn_streams_notifications_and_reuses_session(
    monkeypatch,
    tmp_path,
    deepseek_provider,
):
    captured = {}

    class FakeHarness:
        def run(self, prompt, *, session_id, on_notification):
            captured.update(prompt=prompt, session_id=session_id)
            on_notification(notification("session.event", {
                "sessionId": session_id,
                "event": {"type": "assistant/chunk", "data": {
                    "turn": 0, "step": 0,
                    "chunk": {"type": "text-delta", "index": 0, "text": "完成"},
                }},
            }))
            return SimpleNamespace(finish_reason="completed")

        def close(self):
            captured["closed"] = True

    monkeypatch.setattr(
        "engines.deepseek_harness.config_store.get_deepseek_harness_config",
        lambda: {"provider_id": "deepseek-official", "model": "deepseek-v4-flash", "max_tokens": "4096"},
    )
    monkeypatch.setattr(
        "engines.deepseek_harness.config_store.get_provider",
        lambda _provider_id: deepseek_provider,
    )
    monkeypatch.setattr(
        DeepSeekHarnessEngine,
        "_build_harness",
        lambda self, **kwargs: captured.update(kwargs) or FakeHarness(),
    )
    monkeypatch.setattr(DeepSeekHarnessEngine, "is_installed", staticmethod(lambda: True))

    async def collect():
        return [
            event
            async for event in DeepSeekHarnessEngine().spawn(
                "修复测试",
                str(tmp_path),
                session_id="session-existing",
            )
        ]

    events = asyncio.run(collect())

    assert captured == {
        "cwd": str(tmp_path),
        "provider": deepseek_provider,
        "model": "deepseek-v4-flash",
        "max_tokens": 4096,
        "preset": "standard",
        "prompt": "修复测试",
        "session_id": "session-existing",
        "closed": True,
    }
    assert [event.type for event in events] == [
        "status", "session_started", "status", "agent_message_chunk", "status",
    ]
    assert events[0].data["status"] == "initializing"
    assert events[1].data["session_id"] == "session-existing"
    assert events[-1].data["status"] == "done"


def test_deepseek_harness_spawn_reports_sdk_failure(monkeypatch, tmp_path, deepseek_provider):
    class BrokenHarness:
        def run(self, *_args, **_kwargs):
            raise RuntimeError("runtime crashed")

        def close(self):
            return None

    monkeypatch.setattr(
        "engines.deepseek_harness.config_store.get_deepseek_harness_config",
        lambda: {"provider_id": "deepseek-official", "model": "deepseek-v4-flash", "max_tokens": ""},
    )
    monkeypatch.setattr(
        "engines.deepseek_harness.config_store.get_provider",
        lambda _provider_id: deepseek_provider,
    )
    monkeypatch.setattr(
        DeepSeekHarnessEngine,
        "_build_harness",
        lambda self, **_kwargs: BrokenHarness(),
    )
    monkeypatch.setattr(DeepSeekHarnessEngine, "is_installed", staticmethod(lambda: True))

    async def collect():
        return [event async for event in DeepSeekHarnessEngine().spawn("go", str(tmp_path))]

    events = asyncio.run(collect())
    assert events[-1].type == "error"
    assert events[-1].data["message"] == "runtime crashed"

"""CursorSdkEngine（Cursor 官方 Python SDK 适配器）单元测试。"""

import pytest

from engines.cursor_sdk import CursorSdkEngine


def test_registry_discovery():
    from engines.core.registry import list_all_engines

    assert list_all_engines()["cursor"] is CursorSdkEngine


def test_sdk_not_acp_native():
    assert CursorSdkEngine()._is_acp_native is False
    assert CursorSdkEngine().get_command() == []


def test_install_surface():
    assert CursorSdkEngine.install_command() == "pip install cursor-sdk"
    assert CursorSdkEngine.RUNTIME_PACKAGE.name == "cursor-sdk"
    assert CursorSdkEngine.RUNTIME_PACKAGE.kind == "pypi"


def test_installed_state_consistent():
    installed = CursorSdkEngine.is_installed()
    if installed:
        assert CursorSdkEngine.get_version() is not None
        assert CursorSdkEngine.resolve_binary() is not None
    else:
        assert CursorSdkEngine.get_version() is None
        assert CursorSdkEngine.resolve_binary() is None


def test_capabilities_honest():
    e = CursorSdkEngine()
    # 能力随安装态降级：未安装时 resume 不可用，其余为保守声明。
    assert e.supports_resume == CursorSdkEngine.is_installed()
    assert e.supports_vision is False
    assert e.supports_thinking_effort is False
    assert e.supports_tool_approval is False
    assert e.supported_provider_protocols() == set()


def test_acp_events_declares_content_events():
    events = CursorSdkEngine().acp_events
    assert events == {
        "agent_message_chunk", "agent_thought_chunk",
        "tool_call", "tool_call_update", "usage_update",
    }


def test_config_schema_requires_api_key():
    schema = CursorSdkEngine.config_schema()
    assert [f.key for f in schema] == ["api_key"]
    assert schema[0].required is True


def test_is_configured_requires_key(monkeypatch):
    monkeypatch.delenv("CURSOR_API_KEY", raising=False)
    assert CursorSdkEngine().is_configured() is False


def test_spawn_without_key_yields_error(monkeypatch):
    monkeypatch.delenv("CURSOR_API_KEY", raising=False)

    import asyncio

    async def collect():
        events = []
        async for ev in CursorSdkEngine().spawn(prompt="hi", cwd="/tmp"):
            events.append(ev)
        return events

    events = asyncio.run(collect())
    assert events[-1].type == "done"
    assert "error" in events[-1].data


def test_map_sdk_event_fallback():
    class FakeEvent:
        def model_dump(self, **kw):
            return {"foo": "bar"}

    ev = CursorSdkEngine()._map_sdk_event(FakeEvent())
    assert ev.type == "acp_raw"
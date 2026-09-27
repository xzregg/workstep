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
    assert schema[0].type == "password"
    assert schema[0].sensitive is True


@pytest.mark.anyio
async def test_configured_cursor_key_is_saved_masked_and_revealable(monkeypatch):
    import engines.cursor_sdk as cursor_module

    class Store:
        value = ""

        def get(self, key, default=None):
            assert key == "cursor_sdk_api_key"
            return self.value or default

        def set(self, key, value):
            assert key == "cursor_sdk_api_key"
            self.value = value

        def delete(self, key):
            assert key == "cursor_sdk_api_key"
            self.value = ""

    store = Store()
    monkeypatch.setattr(cursor_module, "config_store", store, raising=False)
    monkeypatch.delenv("CURSOR_API_KEY", raising=False)
    engine = CursorSdkEngine()
    await engine.save_config_values({"api_key": "saved-key"})
    assert engine._api_key() == "saved-key"
    assert engine.get_config_values() == {"api_key": ""}
    assert engine.get_config_secrets() == {"api_key": True}
    assert engine.reveal_config_value("api_key") == "saved-key"
    await engine.save_config_values({"api_key": ""}, clear={"api_key": True})
    assert engine._api_key() == ""


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


def test_maps_documented_cursor_sdk_messages():
    from types import SimpleNamespace as Item

    engine = CursorSdkEngine()
    assistant = Item(type="assistant", message=Item(content=[Item(type="text", text="Hello")]))
    thinking = Item(type="thinking", text="Reasoning")
    tool_start = Item(type="tool_call", call_id="call-1", name="shell", status="running", args={"cmd": "pwd"})
    tool_end = Item(type="tool_call", call_id="call-1", name="shell", status="completed", result={"exit": 0})
    usage = Item(type="usage", usage=Item(input_tokens=3, output_tokens=2, total_tokens=5))

    assert engine._map_sdk_event(assistant).type == "agent_message_chunk"
    assert engine._map_sdk_event(assistant).data["text"] == "Hello"
    assert engine._map_sdk_event(thinking).type == "agent_thought_chunk"
    assert engine._map_sdk_event(tool_start).type == "tool_call"
    assert engine._map_sdk_event(tool_end).type == "tool_call_update"
    assert engine._map_sdk_event(usage).data["total_tokens"] == 5


@pytest.mark.anyio
async def test_spawn_uses_documented_async_client_and_message_stream(monkeypatch):
    import sys
    from types import ModuleType, SimpleNamespace as Item

    calls = []

    class Run:
        async def messages(self):
            yield Item(type="assistant", message=Item(content=[Item(type="text", text="Done")]))

        async def wait(self):
            return Item(status="finished", usage=Item(input_tokens=1, output_tokens=2, total_tokens=3))

    class Agent:
        agent_id = "agent-1"

        async def send(self, prompt, options=None):
            calls.append(("send", prompt))
            return Run()

        async def close(self):
            calls.append(("close_agent",))

    class Agents:
        async def create(self, **kwargs):
            calls.append(("create", kwargs))
            return Agent()

    class Client:
        agents = Agents()

        @classmethod
        async def launch_bridge(cls, **kwargs):
            calls.append(("launch", kwargs))
            return cls()

        async def aclose(self):
            calls.append(("close_client",))

    sdk = ModuleType("cursor_sdk")
    sdk.AsyncClient = Client
    sdk.AgentOptions = lambda **kwargs: Item(**kwargs)
    sdk.LocalAgentOptions = lambda **kwargs: Item(**kwargs)
    sdk.SendOptions = lambda **kwargs: Item(**kwargs)
    monkeypatch.setitem(sys.modules, "cursor_sdk", sdk)
    monkeypatch.setattr(CursorSdkEngine, "_api_key", lambda self: "configured-key")

    events = [event async for event in CursorSdkEngine().spawn(
        prompt="test", cwd="/tmp/project", model="composer-2.5"
    )]
    assert calls[0] == ("launch", {"workspace": "/tmp/project"})
    assert calls[1][0] == "create"
    assert calls[1][1]["api_key"] == "configured-key"
    assert [event.type for event in events] == [
        "session_started", "agent_message_chunk", "usage_update", "done"
    ]
    assert events[1].data["text"] == "Done"
    assert ("close_client",) in calls


@pytest.mark.anyio
async def test_spawn_resumes_existing_agent(monkeypatch):
    import sys
    from types import ModuleType, SimpleNamespace as Item

    calls = []

    class Agent:
        agent_id = "existing"

        async def send(self, prompt, options):
            class Run:
                async def messages(self):
                    if False:
                        yield None

                async def wait(self):
                    return Item(status="finished", usage=None)

            return Run()

        async def close(self):
            pass

    class Agents:
        async def resume(self, session_id, options):
            calls.append((session_id, options.api_key, options.model))
            return Agent()

    class Client:
        agents = Agents()

        @classmethod
        async def launch_bridge(cls, **kwargs):
            return cls()

        async def aclose(self):
            pass

    sdk = ModuleType("cursor_sdk")
    sdk.AsyncClient = Client
    sdk.AgentOptions = lambda **kwargs: Item(**kwargs)
    sdk.LocalAgentOptions = lambda **kwargs: Item(**kwargs)
    sdk.SendOptions = lambda **kwargs: Item(**kwargs)
    monkeypatch.setitem(sys.modules, "cursor_sdk", sdk)
    monkeypatch.setattr(CursorSdkEngine, "_api_key", lambda self: "configured-key")

    events = [event async for event in CursorSdkEngine().spawn(
        prompt="follow up", cwd="/tmp/project", model="composer-2.5", session_id="existing"
    )]
    assert calls == [("existing", "configured-key", "composer-2.5")]
    assert events[-1].data["stop_reason"] == "finished"


@pytest.mark.anyio
async def test_catalog_and_connection_use_explicit_key_without_changing_environment(monkeypatch):
    import sys
    from types import ModuleType, SimpleNamespace as Item

    calls = []

    class Models:
        async def list(self, *, api_key):
            calls.append(("models", api_key))
            return [Item(id="composer-2.5", name="Composer 2.5")]

    class Client:
        models = Models()

        @classmethod
        async def launch_bridge(cls, **kwargs):
            return cls()

        async def me(self, *, api_key):
            calls.append(("me", api_key))
            return Item(user_email="user@example.com")

        async def aclose(self):
            pass

    sdk = ModuleType("cursor_sdk")
    sdk.AsyncClient = Client
    monkeypatch.setitem(sys.modules, "cursor_sdk", sdk)
    monkeypatch.setattr(CursorSdkEngine, "is_installed", staticmethod(lambda: True))
    monkeypatch.setattr(CursorSdkEngine, "_api_key", lambda self: "configured-key")
    monkeypatch.delenv("CURSOR_API_KEY", raising=False)

    engine = CursorSdkEngine()
    assert (await engine.test_connection())["ok"] is True
    models = await engine.list_models("/tmp/project")
    assert [model.id for model in models] == ["composer-2.5"]
    assert calls == [("me", "configured-key"), ("models", "configured-key")]
    assert "CURSOR_API_KEY" not in __import__("os").environ

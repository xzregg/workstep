from contextlib import asynccontextmanager

import pytest
from acp import schema

from engines.core.acp_base import AcpEngineBase
from engines.core.agui import to_agui_events
from engines.core.schema import EngineImage


class ProbeEngine(AcpEngineBase):
    ENGINE_ID = "acp-probe"
    COMMAND = ["acp-probe"]

    @staticmethod
    def is_installed():
        return True

    @staticmethod
    def get_version():
        return "1"

    @staticmethod
    def resolve_binary():
        return "acp-probe"


def _initialize_response(**capability_values):
    return schema.InitializeResponse(
        protocolVersion=1,
        agentCapabilities=schema.AgentCapabilities(**capability_values),
    )


def test_acp_prompt_blocks_include_base64_image():
    blocks = ProbeEngine._acp_prompt_blocks(
        "inspect",
        [EngineImage(url="data:image/png;base64,aGVsbG8=")],
    )

    assert blocks[0].text == "inspect"
    assert blocks[1].type == "image"
    assert blocks[1].mime_type == "image/png"
    assert blocks[1].data == "aGVsbG8="


@pytest.mark.anyio
async def test_spawn_forwards_images_and_mcp_servers(monkeypatch):
    mcp_servers = [schema.McpServerStdio(
        name="tools", command="tool-server", args=[], env=[]
    )]

    class Client:
        session_kwargs = None
        prompt_blocks = None

        async def initialize(self, **kwargs):
            return _initialize_response(
                promptCapabilities=schema.PromptCapabilities(image=True),
                mcpCapabilities=schema.McpCapabilities(),
            )

        async def new_session(self, **kwargs):
            self.session_kwargs = kwargs
            return type("Session", (), {"session_id": "s1"})()

        async def set_config_option(self, **kwargs):
            return None

        async def prompt(self, *, prompt, **kwargs):
            self.prompt_blocks = prompt
            return type("Response", (), {"usage": None, "stop_reason": "end_turn"})()

    client = Client()

    @asynccontextmanager
    async def fake_spawn(*args, **kwargs):
        yield client, object()

    monkeypatch.setattr("engines.core.acp_base.acp.spawn_agent_process", fake_spawn)
    events = [event async for event in ProbeEngine().spawn(
        "inspect",
        "/tmp",
        images=[EngineImage(url="data:image/png;base64,aGVsbG8=")],
        config_overrides={"mcp_servers": mcp_servers},
    )]

    assert not [event for event in events if event.type == "error"]
    assert client.session_kwargs["mcp_servers"] == mcp_servers
    assert client.prompt_blocks[1].type == "image"


@pytest.mark.anyio
async def test_spawn_uses_resume_when_load_is_not_advertised(monkeypatch):
    class Client:
        resumed = False

        async def initialize(self, **kwargs):
            return _initialize_response(
                sessionCapabilities=schema.SessionCapabilities(
                    resume=schema.SessionResumeCapabilities(),
                ),
            )

        async def resume_session(self, **kwargs):
            self.resumed = True
            return object()

        async def set_config_option(self, **kwargs):
            return None

        async def prompt(self, **kwargs):
            return type("Response", (), {"usage": None, "stop_reason": "end_turn"})()

    client = Client()

    @asynccontextmanager
    async def fake_spawn(*args, **kwargs):
        yield client, object()

    monkeypatch.setattr("engines.core.acp_base.acp.spawn_agent_process", fake_spawn)
    events = [event async for event in ProbeEngine().spawn(
        "continue", "/tmp", session_id="s1"
    )]

    assert client.resumed is True
    assert not [event for event in events if event.type == "error"]


@pytest.mark.anyio
async def test_mode_auth_and_fork_use_native_acp_methods(monkeypatch):
    class Client:
        calls = []

        async def initialize(self, **kwargs):
            return _initialize_response(
                sessionCapabilities=schema.SessionCapabilities(
                    fork=schema.SessionForkCapabilities(),
                ),
            )

        async def set_session_mode(self, **kwargs):
            self.calls.append(("mode", kwargs))

        async def authenticate(self, **kwargs):
            self.calls.append(("auth", kwargs))
            return schema.AuthenticateResponse()

        async def fork_session(self, **kwargs):
            self.calls.append(("fork", kwargs))
            return schema.ForkSessionResponse(sessionId="forked")

    client = Client()

    @asynccontextmanager
    async def fake_spawn(*args, **kwargs):
        yield client, object()

    monkeypatch.setattr("engines.core.acp_base.acp.spawn_agent_process", fake_spawn)
    engine = ProbeEngine()

    await engine.set_session_mode("plan", "s1")
    assert await engine.authenticate("oauth", "/tmp") is True
    assert await engine.fork_session("s1", "/tmp") == "forked"
    assert [name for name, _ in client.calls] == ["mode", "auth", "fork"]


@pytest.mark.anyio
async def test_nes_draft_methods_use_acp_extension_transport(monkeypatch):
    class Client:
        calls = []

        async def initialize(self, **kwargs):
            return _initialize_response()

        async def ext_method(self, method, params):
            self.calls.append((method, params))
            return {"ok": True}

        async def ext_notification(self, method, params):
            self.calls.append((method, params))

    client = Client()

    @asynccontextmanager
    async def fake_spawn(*args, **kwargs):
        yield client, object()

    monkeypatch.setattr("engines.core.acp_base.acp.spawn_agent_process", fake_spawn)
    engine = ProbeEngine()
    assert await engine.nes_start({"cwd": "/tmp"}) == {"ok": True}
    assert await engine.nes_suggest({"sessionId": "n1"}) == {"ok": True}
    await engine.nes_accept({"sessionId": "n1", "id": "s1"})
    await engine.nes_reject({"sessionId": "n1", "id": "s2"})
    assert await engine.nes_close({"sessionId": "n1"}) == {"ok": True}
    assert [method for method, _ in client.calls] == [
        "nes/start", "nes/suggest", "nes/accept", "nes/reject", "nes/close"
    ]


def test_session_input_capabilities_are_enforced():
    response = _initialize_response()

    with pytest.raises(RuntimeError, match="additionalDirectories"):
        ProbeEngine._validate_session_inputs(response, ["/tmp/extra"], [])

    http = schema.HttpMcpServer(
        type="http", name="http", url="https://example.com/mcp", headers=[]
    )
    with pytest.raises(RuntimeError, match="HTTP MCP"):
        ProbeEngine._validate_session_inputs(response, [], [http])


def test_agui_keeps_rich_acp_tool_fields():
    events = to_agui_events({
        "type": "tool_call",
        "data": {
            "tool_call_id": "t1",
            "title": "edit",
            "status": "in_progress",
            "content": [{"type": "diff", "path": "a.py"}],
            "locations": [{"path": "a.py", "line": 2}],
            "_meta": {"provider": "probe"},
        },
    })

    assert events[0]["status"] == "in_progress"
    assert events[0]["content"][0]["type"] == "diff"
    assert events[0]["locations"][0]["path"] == "a.py"
    assert events[0]["_meta"] == {"provider": "probe"}

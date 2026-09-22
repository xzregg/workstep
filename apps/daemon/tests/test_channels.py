"""Channels API, persistence and message-routing integration tests."""

import asyncio
from pathlib import Path
import sys
import time

import pytest
from httpx import ASGITransport, AsyncClient

import main
from services.channels.base import ChannelBase, IncomingMessage, LoginResult
from services.channels.manager import ChannelManager
from services.channels.wechat import WeChatChannel
from services.channels.responder import ChatSessionResponder
from services.project import ProjectManager
from streaming.bus import EventBus
from streaming.ws import WsSubscription, matches_subscription
from agent_assistants.base import AssistantConfig, SCOPE_CHAT, assistant_registry
from agent_assistants.channel_chat import ChannelChatModule


class FakeWeChatChannel(ChannelBase):
    channel_type = "wechat"
    display_name = "微信"
    icon = "wechat"

    def __init__(self, project_id: str, session_dir: Path):
        super().__init__(project_id, session_dir)
        self.logged_in = False
        self.sent: list[tuple[str, str]] = []
        self.started = False
        self.login_calls = 0

    async def start(self):
        self.started = True

    async def stop(self):
        self.started = False

    async def login(self):
        self.login_calls += 1
        result = LoginResult(status="pending", qr_code="data:image/png;base64,QR")
        await self.emit_login_state(result)
        return result

    async def logout(self):
        self.logged_in = False
        await self.emit_login_state(LoginResult(status="not_started"))

    async def is_logged_in(self):
        return self.logged_in

    async def send_text(self, chat_id: str, text: str):
        self.sent.append((chat_id, text))

    async def complete_login(self):
        self.logged_in = True
        await self.emit_login_state(LoginResult(status="success", account_id="wx-user"))


@pytest.fixture
async def channel_client(tmp_path, monkeypatch):
    manager = ProjectManager()
    project = manager.init_project(tmp_path / "channel-project")
    bus = EventBus()
    responses: list[tuple[str | None, str]] = []

    async def respond(project_id, session_id, content, assistant_id, model):
        responses.append((session_id, content))
        return session_id or "session-1", f"AI: {content}"

    channels = ChannelManager(bus, manager, respond)
    channels.register("wechat", FakeWeChatChannel)
    monkeypatch.setattr(main, "channel_manager", channels)
    client = AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test")
    yield client, project, channels, responses
    await client.aclose()
    await channels.shutdown()
    manager.close_all()


async def test_channel_login_config_and_message_route(channel_client):
    client, project, channels, responses = channel_client
    response = await client.get("/api/channels", params={"project_id": project.id})
    assert response.status_code == 200
    assert response.json()[0]["assistant_id"] == "channel_chat"

    response = await client.put(
        "/api/channels/wechat/config",
        json={"project_id": project.id, "enabled": True, "assistant_id": "channel_chat"},
    )
    assert response.status_code == 400

    response = await client.post(
        "/api/channels/wechat/login", params={"project_id": project.id}
    )
    assert response.status_code == 200
    assert response.json()["qr_code"].startswith("data:image/png")
    repeated = await client.post(
        "/api/channels/wechat/login", params={"project_id": project.id}
    )
    assert repeated.json()["qr_code"] == response.json()["qr_code"]

    instance = channels._instance(project.id, "wechat")
    assert instance.login_calls == 1
    await instance.complete_login()
    response = await client.put(
        "/api/channels/wechat/config",
        json={
            "project_id": project.id,
            "enabled": True,
            "assistant_id": "channel_chat",
            "model": "test-model",
        },
    )
    assert response.status_code == 200
    assert response.json()["enabled"] is True

    await instance.emit_message(
        IncomingMessage(chat_id="chat-1", sender_id="wx-user", text="你好")
    )
    await instance.emit_message(
        IncomingMessage(chat_id="chat-1", sender_id="wx-user", text="继续")
    )
    assert instance.sent == [("chat-1", "AI: 你好"), ("chat-1", "AI: 继续")]
    assert responses == [(None, "你好"), ("session-1", "继续")]


async def test_logout_disables_channel_and_stops_routing(channel_client):
    client, project, channels, responses = channel_client
    instance = channels._instance(project.id, "wechat")
    await instance.complete_login()
    await client.put(
        "/api/channels/wechat/config",
        json={"project_id": project.id, "enabled": True, "assistant_id": "channel_chat"},
    )
    response = await client.post(
        "/api/channels/wechat/logout", params={"project_id": project.id}
    )
    assert response.status_code == 200

    await instance.emit_message(
        IncomingMessage(chat_id="chat-1", sender_id="wx-user", text="不应响应")
    )
    assert responses == []
    listed = await client.get("/api/channels", params={"project_id": project.id})
    assert listed.json()[0]["enabled"] is False
    assert listed.json()[0]["status"] == "not_logged_in"


async def test_same_chat_messages_are_serialized_and_reuse_one_session(channel_client):
    _client, project, channels, _responses = channel_client
    instance = channels._instance(project.id, "wechat")
    await instance.complete_login()
    await channels.update_config(project.id, "wechat", {
        "enabled": True, "assistant_id": "channel_chat", "model": "",
    })
    entered = asyncio.Event()
    release = asyncio.Event()
    calls = []

    async def ordered_responder(project_id, session_id, content, assistant_id, model):
        calls.append((session_id, content))
        if content == "first":
            entered.set()
            await release.wait()
        return session_id or "shared-session", f"AI: {content}"

    channels._responder = ordered_responder
    first = asyncio.create_task(instance.emit_message(
        IncomingMessage(chat_id="same-chat", sender_id="user", text="first")
    ))
    await entered.wait()
    second = asyncio.create_task(instance.emit_message(
        IncomingMessage(chat_id="same-chat", sender_id="user", text="second")
    ))
    await asyncio.sleep(0.02)
    assert calls == [(None, "first")]
    release.set()
    await asyncio.gather(first, second)
    assert calls == [(None, "first"), ("shared-session", "second")]
    assert instance.sent == [
        ("same-chat", "AI: first"),
        ("same-chat", "AI: second"),
    ]


async def test_wechat_session_is_persisted_and_restored(tmp_path):
    class RestoringBridge:
        def __init__(self):
            self.restored = None

        async def start(self, session, channel):
            self.restored = session
            if session:
                await channel.login_succeeded(session["account_id"], session)

        async def stop(self):
            return None

        async def login(self, channel):
            return LoginResult(status="pending", qr_code="qr")

        async def logout(self):
            return None

        async def send_text(self, chat_id, text):
            return None

    session_dir = tmp_path / "sessions"
    first_bridge = RestoringBridge()
    first = WeChatChannel("project-1", session_dir, first_bridge)
    await first.login_succeeded("wx-persisted", {"account_id": "wx-persisted", "token": "secret"})
    assert (session_dir / "wechat.json").is_file()

    second_bridge = RestoringBridge()
    restored = WeChatChannel("project-1", session_dir, second_bridge)
    await restored.start()
    assert await restored.is_logged_in() is True
    assert second_bridge.restored["token"] == "secret"


async def test_slow_channel_database_read_does_not_block_health(channel_client, monkeypatch):
    client, project, channels, _responses = channel_client
    original = channels._ensure_row

    def slow_ensure_row(project_id, channel_type):
        time.sleep(0.2)
        return original(project_id, channel_type)

    monkeypatch.setattr(channels, "_ensure_row", slow_ensure_row)
    channel_request = asyncio.create_task(
        client.get("/api/channels", params={"project_id": project.id})
    )
    await asyncio.sleep(0.02)
    health = await asyncio.wait_for(client.get("/api/health"), timeout=0.1)
    assert health.status_code == 200
    assert (await channel_request).status_code == 200


def test_channel_subscription_requires_matching_project():
    subscription = WsSubscription(
        active=True,
        project_id="project-a",
        channels={"channel_wechat"},
    )
    assert matches_subscription(
        {"channel": "channel_wechat", "project_id": "project-a"}, subscription
    )
    assert not matches_subscription(
        {"channel": "channel_wechat", "project_id": "project-b"}, subscription
    )


async def test_login_does_not_overwrite_qr_emitted_during_request(tmp_path):
    class RacingBridge:
        async def start(self, session, channel):
            return None

        async def stop(self):
            return None

        async def login(self, channel):
            await channel.qr_received("data:image/png;base64,FAST")
            return LoginResult(status="pending")

        async def logout(self):
            return None

        async def send_text(self, chat_id, text):
            return None

    channel = WeChatChannel("project-1", tmp_path, RacingBridge())
    states = []
    channel.on_login_state_change(lambda result: _append_state(states, result))
    result = await channel.login()
    assert result.qr_code == "data:image/png;base64,FAST"
    assert states[-1].qr_code == "data:image/png;base64,FAST"


async def _append_state(states, result):
    states.append(result)


async def test_subprocess_bridge_keeps_reading_while_message_routes(tmp_path):
    sidecar = tmp_path / "fake_wechat_sidecar.py"
    sidecar.write_text(
        """import json, sys
for raw in sys.stdin:
    command = json.loads(raw)
    if command['action'] == 'login':
        print('invalid-json', flush=True)
        print(json.dumps({'event':'message','chat_id':'chat-1','sender_id':'user-1','text':'hello'}), flush=True)
        print(json.dumps({'event':'qr_code','qr_code':'data:image/png;base64,LATE'}), flush=True)
    if command['action'] == 'send_text':
        print(json.dumps({'event':'qr_code','qr_code':'data:image/png;base64,AFTER_ERROR'}), flush=True)
    if command['action'] == 'stop':
        break
""",
        encoding="utf-8",
    )
    from services.channels.wechat import SubprocessWeChatBridge

    bridge = SubprocessWeChatBridge(f"{sys.executable} -u {sidecar}")
    channel = WeChatChannel("project-1", tmp_path / "sessions", bridge)
    release = asyncio.Event()
    message_started = asyncio.Event()
    qr_received = asyncio.Event()
    after_error = asyncio.Event()

    async def slow_message(_message):
        message_started.set()
        await release.wait()
        raise RuntimeError("assistant failed")

    async def login_state(result):
        if result.qr_code and result.qr_code.endswith("LATE"):
            qr_received.set()
        if result.qr_code and result.qr_code.endswith("AFTER_ERROR"):
            after_error.set()

    channel.on_message(slow_message)
    channel.on_login_state_change(login_state)
    await channel.login()
    await asyncio.wait_for(message_started.wait(), timeout=2)
    await asyncio.wait_for(qr_received.wait(), timeout=2)
    release.set()
    await asyncio.wait_for(after_error.wait(), timeout=2)
    await channel.stop()


async def test_subprocess_exit_marks_channel_failed(tmp_path):
    sidecar = tmp_path / "exiting_wechat_sidecar.py"
    sidecar.write_text(
        """import json, sys
for raw in sys.stdin:
    if json.loads(raw)['action'] == 'login':
        break
""",
        encoding="utf-8",
    )
    from services.channels.wechat import SubprocessWeChatBridge

    bridge = SubprocessWeChatBridge(f"{sys.executable} -u {sidecar}")
    channel = WeChatChannel("project-1", tmp_path / "sessions", bridge)
    failed = asyncio.Event()

    async def login_state(result):
        if result.status == "failed":
            failed.set()

    channel.on_login_state_change(login_state)
    await channel.login()
    await asyncio.wait_for(failed.wait(), timeout=2)
    assert await channel.is_logged_in() is False
    await channel.stop()


def test_selected_assistant_uses_its_own_runtime_prompt():
    bus = EventBus()
    manager = ProjectManager()
    base_module = ChannelChatModule(bus, manager)
    assistant_registry.register(AssistantConfig(
        name="channel-specialist",
        channel="specialist",
        scope=SCOPE_CHAT,
        system_prompt="SPECIALIST PROMPT",
    ))
    responder = ChatSessionResponder(bus, manager, base_module)
    selected = responder._module_for("channel-specialist")
    assert selected is not base_module
    assert selected._config.name == "channel-specialist"
    assert selected._config.system_prompt == "SPECIALIST PROMPT"


async def test_responder_ignores_other_message_completion(tmp_path):
    from types import SimpleNamespace

    bus = EventBus()
    manager = ProjectManager()

    class FakeModule:
        def create_session(self, *args, **kwargs):
            return {"id": "session-1"}

        def submit_message(self, *args, **kwargs):
            return SimpleNamespace(
                session_id="session-1",
                turn_id="turn-1",
                assistant_message_id="answer-1",
                status="queued",
            )

        def start_queued_turn(self, turn_id):
            async def publish():
                common = {"project_id": project.id, "session_id": "session-1"}
                await bus.publish({**common, "type": "TEXT_MESSAGE_CHUNK", "messageId": "other", "delta": "wrong"})
                await bus.publish({**common, "type": "RUN_FINISHED", "messageId": "other"})
                await bus.publish({**common, "type": "TEXT_MESSAGE_CHUNK", "messageId": "answer-1", "delta": "right"})
                await bus.publish({**common, "type": "RUN_FINISHED", "messageId": "answer-1"})
            asyncio.create_task(publish())

    project = manager.init_project(tmp_path / "reply-filter-project")
    responder = ChatSessionResponder(bus, manager, FakeModule())
    session_id, reply = await responder(
        project.id, "session-1", "hello", "channel_chat", ""
    )
    assert session_id == "session-1"
    assert reply == "right"
    manager.close_all()


async def test_unknown_project_channel_endpoints_return_404(channel_client):
    client, _project, _channels, _responses = channel_client
    for method, path in (
        ("post", "/api/channels/wechat/login"),
        ("get", "/api/channels/wechat/login-status"),
        ("post", "/api/channels/wechat/logout"),
    ):
        response = await getattr(client, method)(path, params={"project_id": "missing"})
        assert response.status_code == 404


def test_bundled_bridge_command_resolution(tmp_path, monkeypatch):
    from services.channels import wechat as wechat_mod
    from services.channels.wechat import MissingWeChatBridge, SubprocessWeChatBridge

    # When the sidecar script exists and node is on PATH, the bundled bridge is
    # used automatically — this is what makes the QR code appear without the
    # operator having to set WORKSTEP_WECHAT_BRIDGE_COMMAND.
    real_node = __import__("shutil").which("node")
    if real_node:
        monkeypatch.delenv("WORKSTEP_WECHAT_BRIDGE_COMMAND", raising=False)
        bridge = wechat_mod.default_wechat_bridge()
        assert isinstance(bridge, SubprocessWeChatBridge)
        assert "wechat-bridge" in bridge._command[-1]

    # Without node on PATH (and no env override) we fall back to the explicit
    # "not configured" bridge so the UI can show an actionable error.
    monkeypatch.setattr(wechat_mod.shutil, "which", lambda _name: None)
    monkeypatch.delenv("WORKSTEP_WECHAT_BRIDGE_COMMAND", raising=False)
    assert isinstance(wechat_mod.default_wechat_bridge(), MissingWeChatBridge)


async def test_sidecar_start_failure_returns_503_and_persists_error(channel_client, monkeypatch):
    client, project, channels, _responses = channel_client
    monkeypatch.setenv("WORKSTEP_WECHAT_BRIDGE_COMMAND", "/missing/workstep-wechat-sidecar")
    channels.register("wechat", WeChatChannel)
    response = await client.post(
        "/api/channels/wechat/login", params={"project_id": project.id}
    )
    assert response.status_code == 503
    listed = await client.get("/api/channels", params={"project_id": project.id})
    assert listed.json()[0]["status"] == "error"
    assert "启动失败" in listed.json()[0]["error_message"]


async def test_startup_restore_failure_does_not_abort_manager(tmp_path, monkeypatch):
    from models.channel import Channel
    from models.fields import utc_now

    monkeypatch.setenv("WORKSTEP_WECHAT_BRIDGE_COMMAND", "/missing/workstep-wechat-sidecar")
    manager = ProjectManager()
    project = manager.init_project(tmp_path / "restore-failure-project")
    await manager.run_db(project.id, lambda _project: Channel.create(
        id="wechat",
        project_id=project.id,
        channel_type="wechat",
        enabled=True,
        status="logged_in",
        updated_at=utc_now(),
    ))
    channels = ChannelManager(EventBus(), manager, lambda *_args: None)
    await channels.start()
    listed = await channels.list_channels(project.id)
    assert listed[0]["status"] == "error"
    assert listed[0]["enabled"] is False
    await channels.shutdown()
    manager.close_all()

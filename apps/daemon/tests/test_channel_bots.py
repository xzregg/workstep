"""Bot credentials, task group routing, and event-loop isolation."""

import asyncio
import threading
import time
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient

import main
from agent_assistants.channel_chat import ChannelChatModule
from models.chat_session import ChatMessage, ChatSession
from models.task import Task
from services.channels.bots import BotManager, IncomingMessage
from services.channels.responder import ChatSessionResponder
from services.project import ProjectManager
from services.remote_access import get_current_actor
from streaming.bus import EventBus


class MemoryStore:
    def __init__(self):
        self.values = {}

    def get(self, key, default=None):
        return self.values.get(key, default)

    def set(self, key, value):
        self.values[key] = value


class FakeAdapter:
    def __init__(self, bot, on_message, on_state):
        self.bot = bot
        self.on_message = on_message
        self.on_state = on_state
        self.sent = []
        self.started = False

    async def start(self):
        self.started = True
        await self.on_state("connected", "")

    async def stop(self):
        self.started = False

    async def send_text(self, message, text):
        self.sent.append((message.conversation_id, text))


@pytest.fixture
async def bots(tmp_path, monkeypatch):
    projects = ProjectManager()
    first = projects.init_project(tmp_path / "first")
    second = projects.init_project(tmp_path / "second")
    for project, task_id in ((first, "task-1"), (second, "task-2")):
        await projects.run_db(project.id, lambda _project: Task.create(
            id=task_id, title=task_id, cwd=str(project.path),
            created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z",
        ))
    bus = EventBus()
    submissions = []
    project_chats = []

    class Coordinator:
        async def submit_message(self, project_id, task_id, content, key, **kwargs):
            submissions.append((project_id, task_id, content, key))
            message_id = f"reply-{len(submissions)}"
            async def finish():
                await bus.publish({
                    "type": "TEXT_MESSAGE_CONTENT", "project_id": project_id,
                    "task_id": task_id, "channel": "coordinator",
                    "messageId": message_id, "content": f"任务回复：{content}",
                })
                await bus.publish({
                    "type": "TEXT_MESSAGE_END", "project_id": project_id,
                    "task_id": task_id, "channel": "coordinator",
                    "messageId": message_id, "status": "succeeded",
                })
            asyncio.create_task(finish())
            return type("Accepted", (), {"assistant_message_id": message_id})()

    async def respond(project_id, session_id, content, assistant_id, model):
        project_chats.append((project_id, session_id, content))
        return session_id or "session-1", f"项目回复：{content}"

    adapters = {}
    def adapter_factory(bot, on_message, on_state):
        adapter = FakeAdapter(bot, on_message, on_state)
        adapters[bot["id"]] = adapter
        return adapter

    manager = BotManager(
        MemoryStore(), projects, bus, Coordinator(), respond,
        {"wecom": adapter_factory, "dingtalk": adapter_factory},
    )
    monkeypatch.setattr(main, "channel_bot_manager", manager)
    yield manager, first, second, submissions, project_chats, adapters
    await manager.shutdown()
    projects.close_all()


async def test_two_platforms_credentials_are_masked_and_groups_route_to_tasks(bots):
    manager, first, second, submissions, _project_chats, adapters = bots
    wecom = await manager.create_bot({
        "platform": "wecom", "name": "企业微信", "app_id": "wx-bot",
        "secret": "wx-secret", "enabled": True,
        "default_target_type": "project", "default_project_id": first.id,
    })
    dingtalk = await manager.create_bot({
        "platform": "dingtalk", "name": "钉钉", "app_id": "ding-app",
        "secret": "ding-secret", "enabled": True,
        "default_target_type": "project", "default_project_id": second.id,
    })
    assert all("secret" not in item for item in await manager.list_bots())
    assert all(item["has_secret"] for item in await manager.list_bots())
    await manager.bind_group(first.id, "task-1", wecom["id"], "group-a")
    await manager.bind_group(second.id, "task-2", dingtalk["id"], "group-b")

    await adapters[wecom["id"]].on_message(IncomingMessage(
        bot_id=wecom["id"], message_id="msg-1", conversation_type="group",
        conversation_id="group-a", sender_id="u1", text="进度？",
    ))
    await adapters[dingtalk["id"]].on_message(IncomingMessage(
        bot_id=dingtalk["id"], message_id="msg-2", conversation_type="group",
        conversation_id="group-b", sender_id="u2", text="状态？",
    ))
    assert [(item[1], item[2]) for item in submissions] == [
        ("task-1", "进度？"), ("task-2", "状态？"),
    ]
    assert adapters[wecom["id"]].sent == [("group-a", "任务回复：进度？")]
    assert adapters[dingtalk["id"]].sent == [("group-b", "任务回复：状态？")]


async def test_unbound_chat_uses_default_project_and_duplicate_is_ignored(bots):
    manager, first, _second, _submissions, project_chats, adapters = bots
    bot = await manager.create_bot({
        "platform": "wecom", "name": "默认项目", "app_id": "wx-bot",
        "secret": "secret", "enabled": True,
        "default_target_type": "project", "default_project_id": first.id,
    })
    message = IncomingMessage(
        bot_id=bot["id"], message_id="same-id", conversation_type="single",
        conversation_id="user-1", sender_id="user-1", text="你好",
    )
    await adapters[bot["id"]].on_message(message)
    await adapters[bot["id"]].on_message(message)
    assert project_chats == [(first.id, None, "你好")]
    assert adapters[bot["id"]].sent == [("user-1", "项目回复：你好")]


async def test_channel_messages_snapshot_sender_in_task_and_project_chat(bots):
    manager, first, _second, _submissions, _project_chats, adapters = bots
    observed = []
    original_submit = manager._coordinator.submit_message
    original_respond = manager._responder

    async def submit(*args, **kwargs):
        observed.append(("task", get_current_actor(), kwargs.get("author_name")))
        return await original_submit(*args, **kwargs)

    async def respond(*args, **kwargs):
        observed.append(("chat", get_current_actor(), None))
        return await original_respond(*args, **kwargs)

    manager._coordinator.submit_message = submit
    manager._responder = respond
    task_bot = await manager.create_bot({
        "platform": "dingtalk", "name": "任务机器人", "app_id": "task-bot",
        "secret": "secret", "enabled": True,
        "default_target_type": "task", "default_project_id": first.id,
        "default_task_id": "task-1",
    })
    chat_bot = await manager.create_bot({
        "platform": "wecom", "name": "项目机器人", "app_id": "chat-bot",
        "secret": "secret", "enabled": True,
        "default_target_type": "project", "default_project_id": first.id,
    })
    await adapters[task_bot["id"]].on_message(IncomingMessage(
        bot_id=task_bot["id"], message_id="task-msg", conversation_type="single",
        conversation_id="staff-1", sender_id="staff-1", sender_name="小王",
        text="任务进度",
    ))
    await adapters[chat_bot["id"]].on_message(IncomingMessage(
        bot_id=chat_bot["id"], message_id="chat-msg", conversation_type="single",
        conversation_id="staff-2", sender_id="staff-2", sender_name="小李",
        text="项目进度",
    ))
    assert [(kind, actor.actor_id, actor.username, actor.user_name)
            for kind, actor, _ in observed] == [
        ("task", "channel:dingtalk:staff-1", "staff-1", "钉钉 · 小王"),
        ("chat", "channel:wecom:staff-2", "staff-2", "企业微信 · 小李"),
    ]
    assert observed[0][2] == observed[0][1].user_name


async def test_one_bot_routes_two_groups_across_projects_and_clears_deleted_task(bots):
    manager, first, second, submissions, _chats, adapters = bots
    bot = await manager.create_bot({
        "platform": "wecom", "name": "共享机器人", "app_id": "shared",
        "secret": "secret", "enabled": True,
        "default_target_type": "task", "default_project_id": first.id,
        "default_task_id": "task-1",
    })
    await manager.bind_group(first.id, "task-1", bot["id"], "group-1")
    await manager.bind_group(second.id, "task-2", bot["id"], "group-2")
    for message_id, group_id in (("m1", "group-1"), ("m2", "group-2")):
        await adapters[bot["id"]].on_message(IncomingMessage(
            bot_id=bot["id"], message_id=message_id, conversation_type="group",
            conversation_id=group_id, sender_id="u1", text=message_id,
        ))
    assert [(row[0], row[1]) for row in submissions] == [
        (first.id, "task-1"), (second.id, "task-2"),
    ]
    with pytest.raises(ValueError, match="已绑定"):
        await manager.bind_group(first.id, "task-1", bot["id"], "group-2")
    await manager.remove_task_bindings(first.id, "task-1")
    assert await manager.list_task_groups(first.id, "task-1") == []
    remaining = await manager.list_bots()
    assert remaining[0]["default_target_type"] == ""
    assert len(await manager.list_task_groups(second.id, "task-2")) == 1


async def test_slow_task_lookup_does_not_block_health(bots, monkeypatch):
    manager, first, _second, _submissions, _project_chats, _adapters = bots
    bot = await manager.create_bot({
        "platform": "wecom", "name": "慢盘测试", "app_id": "slow",
        "secret": "secret", "enabled": False,
    })
    original = manager._project_manager.run_db
    entered = threading.Event()

    async def slow_run_db(project_id, operation):
        def slow_operation(project):
            entered.set()
            time.sleep(0.6)
            return operation(project)
        return await original(project_id, slow_operation)

    monkeypatch.setattr(manager._project_manager, "run_db", slow_run_db)
    bind = asyncio.create_task(manager.bind_group(first.id, "task-1", bot["id"], "group"))
    assert await asyncio.to_thread(entered.wait, 2)
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        health = await asyncio.wait_for(client.get("/api/health"), timeout=0.3)
    assert health.status_code == 200
    assert (await bind)["task_id"] == "task-1"


async def test_bot_and_group_api_use_real_project_validation(bots):
    _manager, first, _second, _submissions, _project_chats, _adapters = bots
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        created = await client.post("/api/channel-bots", json={
            "platform": "dingtalk", "name": "企业机器人", "app_id": "app-key",
            "secret": "private", "default_target_type": "project",
            "default_project_id": first.id,
        })
        assert created.status_code == 200
        bot = created.json()
        assert bot["has_secret"] is True
        assert "secret" not in bot
        bound = await client.post("/api/task/task-1/discussion-groups", json={
            "project_id": first.id, "bot_id": bot["id"], "group_id": "group-1",
        })
        assert bound.status_code == 200
        listed = await client.get(
            "/api/task/task-1/discussion-groups", params={"project_id": first.id},
        )
        assert listed.json() == [bound.json()]
        missing = await client.post("/api/task/other/discussion-groups", json={
            "project_id": first.id, "bot_id": bot["id"], "group_id": "group-2",
        })
        assert missing.status_code == 400


@pytest.mark.parametrize("reset", ["delete", "archive"])
async def test_channel_session_reset_replaces_mapping_and_reuses_new_session(bots, monkeypatch, reset):
    manager, project, _second, _submissions, _chats, adapters = bots
    projects, bus = manager._project_manager, manager._event_bus
    module = ChannelChatModule(bus, projects)
    monkeypatch.setattr(module, "_validate_engine", lambda _engine: None)
    old = await projects.run_db(project.id, lambda _project: module.create_session(
        project.id, title="渠道对话", engine="codex_sdk", model="gpt-6.1-sol",
    ))
    submitted = []

    def submit(project_id, session_id, content, key, **kwargs):
        assert ChatSession.get_by_id(session_id).archived is False
        submitted.append(session_id)
        return SimpleNamespace(turn_id="turn", assistant_message_id="answer")

    def start(_turn_id):
        async def finish():
            await bus.publish({
                "type": "TEXT_MESSAGE_END", "project_id": project.id,
                "session_id": submitted[-1], "messageId": "answer",
                "status": "succeeded", "content": "新对话回复",
            })
        asyncio.create_task(finish())

    monkeypatch.setattr(module, "submit_message", submit)
    monkeypatch.setattr(module, "start_queued_turn", start)
    manager._responder = ChatSessionResponder(bus, projects, module)
    bot = await manager.create_bot({
        "platform": "wecom", "name": "默认项目", "app_id": "wx-bot",
        "secret": "secret", "enabled": True,
        "default_target_type": "project", "default_project_id": project.id,
    })
    session_key = f"{bot['id']}:single:user-1"
    data = await manager._load()
    data["sessions"][session_key] = old["id"]
    await manager._save(data)
    if reset == "delete":
        await projects.run_db(project.id, lambda _project: module.delete_session(project.id, old["id"]))
    else:
        await projects.run_db(project.id, lambda _project: module.set_archived(project.id, old["id"], True))

    # A slow session lookup must not block the daemon's health endpoint.
    entered, release = threading.Event(), threading.Event()
    original_select = ChatSession.select

    def slow_select(*args, **kwargs):
        entered.set()
        assert release.wait(2)
        return original_select(*args, **kwargs)

    monkeypatch.setattr(ChatSession, "select", slow_select)
    pending = asyncio.create_task(manager.handle_message(IncomingMessage(
        bot_id=bot["id"], message_id="after-reset", conversation_type="single",
        conversation_id="user-1", sender_id="user-1", text="你好",
    )))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
            health = await asyncio.wait_for(client.get("/api/health"), timeout=0.5)
            assert health.status_code == 200
    finally:
        release.set()
    await asyncio.wait_for(pending, timeout=2)
    replacement = (await manager._load())["sessions"][session_key]
    assert replacement != old["id"]
    assert (await manager._load())["session_sources"][replacement] == {
        "conversation_type": "single", "conversation_id": "user-1", "peer_name": "user-1",
    }
    assert submitted == [replacement]
    assert adapters[bot["id"]].sent == [("user-1", "新对话回复")]
    monkeypatch.setattr(ChatSession, "select", original_select)
    await manager.handle_message(IncomingMessage(
        bot_id=bot["id"], message_id="continue", conversation_type="single",
        conversation_id="user-1", sender_id="user-1", text="继续",
    ))
    assert submitted == [replacement, replacement]
    assert (await manager._load())["sessions"][session_key] == replacement
    if reset == "archive":
        archived = await projects.run_db(project.id, lambda _project: module.get_session(project.id, old["id"]))
        assert archived["archived"] is True


@pytest.mark.parametrize("platform", ["wecom", "dingtalk"])
@pytest.mark.parametrize("conversation_type", ["single", "group"])
@pytest.mark.parametrize("legacy", [False, True])
async def test_channel_source_survives_rename_and_archive_without_title_guessing(bots, monkeypatch, platform, conversation_type, legacy):
    manager, project, *_ = bots
    module = ChannelChatModule(manager._event_bus, manager._project_manager)
    monkeypatch.setattr(module, "_validate_engine", lambda _engine: None)

    from services.config import config_store
    metadata = {}
    mappings = {}
    original_get = config_store.get
    monkeypatch.setattr(config_store, "get", lambda key, default=None: {
        "bots": [{"id": "bot-1", "name": "Echo", "platform": platform}],
        "session_sources": metadata,
        "sessions": mappings,
    } if key == "channel_bots" else original_get(key, default))

    def operation(_project):
        channel = module.create_session(project.id, title="Echo", engine="codex_sdk")
        metadata[channel["id"]] = {"conversation_type": conversation_type, "conversation_id": "group:123" if conversation_type == "group" else "user-1", "peer_name": "小王" if conversation_type == "single" else "group:123"}
        if legacy:
            identity = metadata.pop(channel["id"])
            mappings[f"bot-1:{conversation_type}:{identity['conversation_id']}"] = channel["id"]
        ordinary = module.create_session(project.id, title="渠道对话", engine="codex_sdk")
        ChatMessage.create(
            id="channel-source", session=channel["id"], role="user", content="你好",
            author_id=f"channel:{platform}:user-1", author_device_id="channel:bot-1",
            author_name="平台 · 小王",
            created_at="2026-10-03T00:00:00Z",
        )
        assert module.get_session(project.id, channel["id"])["source"] == "channel"
        assert module.get_session(project.id, ordinary["id"])["source"] == "chat"
        module.rename_session(project.id, channel["id"], "新名字")
        archived = module.set_archived(project.id, channel["id"], True)
        assert archived["source"] == "channel"
        assert archived["channel_platform"] == platform
        assert archived["channel_name"] == "Echo"
        assert archived["channel_conversation_type"] == conversation_type
        assert archived["channel_peer_name"] == ("小王" if conversation_type == "single" else "group:123")
        assert archived["title"] == "新名字"
        assert module.list_sessions(project.id, archived=True)[0]["source"] == "channel"

    await manager._project_manager.run_db(project.id, operation)


@pytest.mark.parametrize("failure", [False, True])
async def test_wecom_waiting_reply_precedes_work_and_finishes_on_error_or_empty_reply(bots, failure):
    manager, project, *_rest, adapters = bots
    bot = await manager.create_bot({
        "platform": "wecom", "name": "机器人", "app_id": "wx-bot", "secret": "secret",
        "enabled": True, "default_target_type": "project", "default_project_id": project.id,
    })
    adapter = adapters[bot["id"]]
    progress = []
    async def start_reply(message):
        progress.append(message.message_id)
    adapter.start_reply = start_reply

    async def respond(*args):
        assert progress == ["message"]
        if failure:
            raise RuntimeError("engine failed")
        return "session", ""
    manager._responder = respond
    await manager.handle_message(IncomingMessage(
        bot_id=bot["id"], message_id="message", conversation_type="single",
        conversation_id="user", sender_id="user", text="hello",
    ))
    expected = "处理失败，请稍后重试。" if failure else "处理完成，暂无回复内容。"
    assert adapter.sent == [("user", expected)]
    await manager.handle_message(IncomingMessage(
        bot_id=bot["id"], message_id="message", conversation_type="single",
        conversation_id="user", sender_id="user", text="hello",
    ))
    assert progress == ["message"]


async def test_queued_channel_messages_show_waiting_and_reuse_latest_session(bots):
    manager, project, *_rest, adapters = bots
    bot = await manager.create_bot({
        "platform": "wecom", "name": "机器人", "app_id": "wx-bot", "secret": "secret",
        "enabled": True, "default_target_type": "project", "default_project_id": project.id,
    })
    adapter = adapters[bot["id"]]
    first_running, second_waiting, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    sessions = []
    async def start_reply(message):
        if message.message_id == "second":
            second_waiting.set()
    adapter.start_reply = start_reply
    async def respond(project_id, session_id, content, *args):
        sessions.append(session_id)
        if content == "first":
            first_running.set()
            await release.wait()
        return session_id or "new-session", "回答"
    manager._responder = respond
    def incoming(id):
        return IncomingMessage(bot_id=bot["id"], message_id=id, conversation_type="single",
            conversation_id="user", sender_id="user", text=id)
    first = asyncio.create_task(manager.handle_message(incoming("first")))
    second = None
    try:
        await asyncio.wait_for(first_running.wait(), 1)
        second = asyncio.create_task(manager.handle_message(incoming("second")))
        await asyncio.wait_for(second_waiting.wait(), 1)
        assert sessions == [None]
    finally:
        release.set()
        await first
        if second:
            await second
    assert sessions == [None, "new-session"]


async def test_slow_channel_waiting_reply_does_not_block_health(bots):
    manager, project, *_rest, adapters = bots
    bot = await manager.create_bot({
        "platform": "wecom", "name": "机器人", "app_id": "wx-bot", "secret": "secret",
        "enabled": True, "default_target_type": "project", "default_project_id": project.id,
    })
    entered, release = asyncio.Event(), asyncio.Event()
    async def delayed_network_reply(message):
        entered.set()
        await release.wait()
    adapters[bot["id"]].start_reply = delayed_network_reply
    pending = asyncio.create_task(manager.handle_message(IncomingMessage(
        bot_id=bot["id"], message_id="slow", conversation_type="single",
        conversation_id="user", sender_id="user", text="hello",
    )))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
            response = await asyncio.wait_for(client.get("/api/health"), timeout=0.5)
            assert response.status_code == 200
    finally:
        release.set()
        await pending

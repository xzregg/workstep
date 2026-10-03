"""Completed replies from local channel chats return to the exact mapped recipient."""
import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

import main
from models.chat_session import ChatMessage, ChatSession
from services.channels.bots import IncomingMessage
from services.channels.reply_forwarder import ChannelReplyForwarder
from services.project import ProjectManager
from streaming.bus import EventBus


@pytest.mark.parametrize('conversation_type', ['single', 'group'])
async def test_reply_forwarding_isolated_deduplicated_and_async(tmp_path, monkeypatch, conversation_type):
    projects = ProjectManager()
    project = projects.init_project(tmp_path / 'forward')
    bus = EventBus()
    adapter = SimpleNamespace(send_text=AsyncMock())
    data = {'bots': [{'id': 'bot', 'enabled': True}],
            'sessions': {f'bot:{conversation_type}:chat:1': 'channel-session'},
            'session_sources': {}}
    async def load(): return data
    def seed(_project):
        for session_id in ('channel-session', 'ordinary'):
            ChatSession.create(id=session_id, project_id=project.id, workflow_id='', engine='codex', created_at='2026-10-03', updated_at='2026-10-03')
        for message_id, session_id, device in [('local', 'channel-session', None), ('inbound', 'channel-session', 'channel:bot'), ('ordinary-reply', 'ordinary', None)]:
            ChatMessage.create(id=message_id, session=session_id, role='assistant', content='完成回复', author_device_id=device, created_at='2026-10-03')
        ChatMessage.create(id='source',session='channel-session',role='user',author_id='channel:dingtalk:user-1', author_device_id='channel:bot',created_at='2026-10-02')
    await projects.run_db(project.id, seed)
    forwarder = ChannelReplyForwarder(bus, projects, load, {'bot': adapter})
    await forwarder.start()
    def event(message_id, **extra):
        return {'type': 'TEXT_MESSAGE_END', 'project_id': project.id, 'session_id': 'channel-session', 'messageId': message_id, 'status': 'succeeded', 'content': '完成回复', **extra}
    class Module:
        def submit_message(self, project_id, session_id, content, key, **kwargs):
            assert (project_id, session_id, content) == (project.id, 'channel-session', '请回复')
            return SimpleNamespace(turn_id='turn', to_dict=lambda: {'turn_id': 'turn'})
        def start_queued_turn(self, turn_id):
            async def finish():
                await bus.publish(event('local'))
            asyncio.create_task(finish())
    monkeypatch.setattr(main, 'project_manager', projects)
    monkeypatch.setattr(main, 'chat_session_module', Module())
    entered, release = threading.Event(), threading.Event()
    original = ChatMessage.get_or_none
    def slow(*args, **kwargs):
        entered.set()
        assert release.wait(2)
        return original(*args, **kwargs)
    monkeypatch.setattr(ChatMessage, 'get_or_none', slow)
    try:
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url='http://test') as client:
            response = await client.post('/api/chat-sessions/channel-session/chat',
                                         json={'project_id': project.id, 'content': '请回复'},
                                         headers={'Idempotency-Key': 'local-request'})
            assert response.status_code == 200
        assert await asyncio.to_thread(entered.wait, 1)
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'), .5)).status_code == 200
        release.set()
        for _ in range(100):
            if adapter.send_text.await_count: break
            await asyncio.sleep(.01)
        adapter.send_text.assert_awaited_once()
        destination, text = adapter.send_text.await_args.args
        assert isinstance(destination, IncomingMessage)
        assert (destination.bot_id,destination.conversation_type,destination.conversation_id,destination.sender_id,text) == ('bot',conversation_type,'chat:1','user-1','完成回复')
        await bus.publish(event('local'))
        await bus.publish(event('inbound'))
        await bus.publish(event('ordinary-reply', session_id='ordinary'))
        await bus.publish(event('local', project_id='wrong-project'))
        await bus.publish(event('local', status='stopped'))
        await asyncio.sleep(.05)
        adapter.send_text.assert_awaited_once()
    finally:
        release.set()
        await forwarder.shutdown()
        assert not bus._subscribers
        projects.close_all()

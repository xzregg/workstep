"""QQ official API v2: credentials, gateway frames, routing and I/O canaries."""
import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import pytest

from services.channels.base import IncomingMessage, OutgoingMessage, ChannelAttachment
from services.channels.registry import discover_channels
from tests.test_channel_bots import bots


def adapter(on_message=None, on_state=None):
    return discover_channels()['qq']({'id': 'b', 'app_id': '123', 'secret': 'private-secret'},
                                     on_message or AsyncMock(), on_state or AsyncMock())


@pytest.mark.parametrize('group', [False, True])
async def test_qq_frames_use_openids_and_preserve_the_native_reply_id(group):
    channel = adapter()
    channel._user_id = 'bot-user'
    event = 'GROUP_AT_MESSAGE_CREATE' if group else 'C2C_MESSAGE_CREATE'
    body = {'id': 'native-message', 'content': '<@!bot-user> 你好' if group else '你好',
            'author': {'member_openid' if group else 'user_openid': 'sender', 'username': '小明'},
            'group_openid': 'group'}
    await channel._handle_message(event, body)
    await channel._drain_messages()
    incoming = channel._on_message.await_args.args[0]
    assert incoming.text == '你好'
    assert incoming.sender_id == 'sender' and incoming.sender_name == '小明'
    assert incoming.conversation_id == ('group' if group else 'sender')
    assert incoming.conversation_type == ('group' if group else 'single')
    assert incoming.reply_context['msg_id'] == 'native-message'
    await channel._handle_message('GROUP_MESSAGE_CREATE', body)
    await channel._handle_message(event, {**body, 'author': {**body['author'], 'bot': True}})
    await channel._handle_message(event, {**body, 'content': ''})
    await channel._handle_message(event, {**body, 'author': {}})
    await channel._drain_messages()
    assert channel._on_message.await_count == 1


async def test_qq_authentication_is_cached_and_api_errors_do_not_expose_tokens():
    channel = adapter()
    requests = []
    async def request(request):
        requests.append(request)
        if request.url.path == '/app/getAppAccessToken':
            assert json.loads(request.content) == {'appId': '123', 'clientSecret': 'private-secret'}
            return httpx.Response(200, json={'access_token': 'private-access-token', 'expires_in': '7200'})
        assert request.headers['authorization'] == 'QQBot private-access-token'
        return httpx.Response(200, json={'url': 'wss://api.bot.qq.com/websocket/'})
    channel._http = httpx.AsyncClient(transport=httpx.MockTransport(request))
    try:
        await asyncio.gather(*(channel._api('GET', '/gateway') for _ in range(3)))
        assert sum(request.url.path == '/app/getAppAccessToken' for request in requests) == 1
        channel._expires = 0
        await channel._api('GET', '/gateway')
        assert sum(request.url.path == '/app/getAppAccessToken' for request in requests) == 2
    finally:
        await channel.stop()
    channel = adapter()
    channel._http = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200,
        json={'code': 100016, 'message': 'private-secret private-access-token'})))
    try:
        with pytest.raises(RuntimeError) as error:
            await channel._api('GET', '/gateway')
        assert 'private-' not in str(error.value)
        assert '100016' in str(error.value)
    finally:
        await channel.stop()


async def test_qq_unauthorized_refreshes_once_and_does_not_replay_other_errors():
    channel = adapter()
    auths, calls = [], []
    def request(request):
        if request.url.path == '/app/getAppAccessToken':
            auths.append(request)
            return httpx.Response(200, json={'access_token': f'token-{len(auths)}', 'expires_in': 7200})
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(401, json={'code': 11244})
        return httpx.Response(200, json={'id': 'sent'})
    channel._http = httpx.AsyncClient(transport=httpx.MockTransport(request))
    try:
        await channel._api('GET', '/gateway')
        assert len(auths) == len(calls) == 2
        assert calls[-1].headers['authorization'] == 'QQBot token-2'
    finally:
        await channel.stop()


@pytest.mark.parametrize('group', [False, True])
async def test_qq_reply_chunks_have_distinct_sequences_and_respect_passive_quota(group):
    channel = adapter()
    channel._api = AsyncMock(return_value={'id': 'sent'})
    recipient = IncomingMessage('b', 'internal-id', 'group' if group else 'single', 'target', 'sender', '',
                                reply_context={'msg_id': 'native-id', 'msg_seq': 0})
    await channel.send_text(recipient, '😀' * 1100)
    await channel.send_text(recipient, '补充')
    calls = channel._api.await_args_list
    assert len(calls) == 3
    assert [row.kwargs['json']['msg_seq'] for row in calls] == [1, 2, 3]
    assert all(row.kwargs['json']['msg_id'] == 'native-id' for row in calls)
    assert all(row.args[1] == ('/v2/groups/target/messages' if group else '/v2/users/target/messages') for row in calls)
    assert ''.join(row.kwargs['json']['content'] for row in calls[:2]) == '😀' * 1100
    await channel.send_text(recipient, '长' * 20000)
    bodies = [row.kwargs['json'] for row in channel._api.await_args_list]
    assert len(bodies) == (5 if group else 4)
    assert '完整结果请在 WorkStep 查看' in bodies[-1]['content']
    with pytest.raises(RuntimeError, match='次数'):
        await channel.send_text(recipient, '再发')
    with pytest.raises(ValueError, match='不支持发送'):
        await channel.send(recipient, OutgoingMessage(attachments=(ChannelAttachment('image', data=b'x'),)))


async def test_qq_active_messages_do_not_reuse_a_stale_inbound_id():
    channel = adapter()
    channel._api = AsyncMock(return_value={'id': 'sent'})
    await channel.send_text(IncomingMessage('b', 'generated-id', 'single', 'user-openid', 'user-openid', ''), '通知')
    body = channel._api.await_args.kwargs['json']
    assert body == {'content': '通知', 'msg_type': 0}


@pytest.mark.parametrize('resume', [False, True])
async def test_qq_gateway_identify_resume_heartbeat_and_invalidation(monkeypatch, resume):
    channel = adapter()
    channel._api = AsyncMock(return_value={'url': 'wss://api.bot.qq.com/websocket/'})
    channel._access_token = AsyncMock(return_value='access-token')
    if resume:
        channel._session_id, channel._sequence = 'old-session', 4
    frames = [
        {'op': 0, 't': 'READY', 's': 5, 'd': {'session_id': 'session', 'user': {'id': 'bot'}}},
        {'op': 1}, {'op': 11},
        {'op': 0, 't': 'C2C_MESSAGE_CREATE', 's': 6, 'd': {'id': 'm', 'author': {'user_openid': 'u'}, 'content': '你好'}},
        {'op': 9, 'd': False},
    ]
    class Socket:
        def __init__(self): self.sent = []
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def recv(self): return json.dumps({'op': 10, 'd': {'heartbeat_interval': 60000}})
        async def send(self, value): self.sent.append(json.loads(value))
        def __aiter__(self): return self
        async def __anext__(self):
            if not frames: raise StopAsyncIteration
            return json.dumps(frames.pop(0))
    socket = Socket()
    monkeypatch.setattr('services.channels.qq.websockets.connect', lambda *a, **k: socket)
    await asyncio.wait_for(channel._connect(), 1)
    await channel._drain_messages()
    assert socket.sent[0]['op'] == (6 if resume else 2)
    assert socket.sent[0]['d']['token'] == 'QQBot access-token'
    if not resume:
        assert socket.sent[0]['d']['intents'] == 1 << 25
        assert socket.sent[0]['d']['shard'] == [0, 1]
    assert {'op': 1, 'd': 5} in socket.sent
    assert channel._session_id == '' and channel._sequence is None
    channel._on_state.assert_awaited_with('connected', '')
    channel._on_message.assert_awaited_once()


async def test_qq_slow_network_and_stop_keep_health_responsive():
    import main
    entered, release = asyncio.Event(), asyncio.Event()
    async def slow(request):
        entered.set()
        await release.wait()
        return httpx.Response(200, json={})
    channel = adapter()
    channel._http = httpx.AsyncClient(transport=httpx.MockTransport(slow))
    await channel.start()
    try:
        await asyncio.wait_for(entered.wait(), 1)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'), .5)).status_code == 200
    finally:
        await asyncio.wait_for(channel.stop(), 1)
        release.set()
    assert channel._task is None and not channel._messages


async def test_qq_bot_api_and_frames_reuse_whitelist_task_binding_and_deduplication(bots):
    import main
    manager, project, _, submissions, chats, _ = bots
    instances = {}
    def factory(bot, on_message, on_state):
        channel = discover_channels()['qq'](bot, on_message, on_state)
        async def start(): await on_state('connected', '')
        channel.start = start
        channel._api = AsyncMock(return_value={'id': 'sent'})
        instances[bot['id']] = channel
        return channel
    manager._factories['qq'] = factory
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test') as client:
        response = await client.post('/api/channel-bots', json={'platform': 'qq', 'name': 'QQ助手',
            'app_id': '123', 'secret': 'secret', 'enabled': True, 'default_project_id': project.id})
        assert response.status_code == 200
        bot = response.json()
        assert bot['capabilities']['send'] == ['text'] and 'secret' not in bot
        channel = instances[bot['id']]
        async def receive(mid, group=False):
            await channel._handle_message('GROUP_AT_MESSAGE_CREATE' if group else 'C2C_MESSAGE_CREATE',
                {'id': mid, 'content': '你好', 'author': {'member_openid' if group else 'user_openid': 'u'}, 'group_openid': 'g'})
            await channel._drain_messages()
        await receive('m1')
        assert len(chats) == 1
        await manager.save_private_whitelist(bot['id'], True, [])
        await receive('m2')
        assert len(chats) == 1
        await manager.bind_group(project.id, 'task-1', bot['id'], 'g')
        await receive('m3', True)
        await receive('m3', True)
        assert len(submissions) == 1

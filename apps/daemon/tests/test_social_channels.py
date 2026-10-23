"""Official bot protocols, lifecycle, and slow-network responsiveness."""
import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import pytest

from services.channels.base import IncomingMessage, OutgoingMessage, ChannelAttachment
from services.channels.registry import discover_channels
from tests.test_channel_bots import bots


@pytest.mark.parametrize('platform', ['telegram', 'discord', 'slack'])
async def test_social_channels_are_discovered_and_send_bounded_plain_text(platform):
    adapter = discover_channels()[platform]({'id': 'b', 'app_id': '123', 'secret': 'token', 'app_token': 'app-token'}, AsyncMock(), AsyncMock())
    calls = []
    async def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        return {'ok': True, 'result': {}, 'id': 'sent'}
    adapter._api = request
    recipient = IncomingMessage('b', 'm', 'group', 'room', 'u', '')
    await adapter.send(recipient, OutgoingMessage(text='😀' * 4100))
    bodies = [row[2]['json'] for row in calls]
    key = 'content' if platform == 'discord' else 'text'
    assert ''.join(row[key] for row in bodies) == '😀' * 4100
    assert all(len(row[key].encode('utf-16-le')) // 2 <= (2000 if platform == 'discord' else 4096) for row in bodies)
    if platform == 'discord':
        assert all(row['allowed_mentions'] == {'parse': []} for row in bodies)
    with pytest.raises(ValueError, match='不支持发送'):
        await adapter.send(recipient, OutgoingMessage(attachments=(ChannelAttachment('file', 'a.txt', data=b'a'),)))


async def test_telegram_groups_require_bot_mention_or_reply_and_preserve_topic():
    received = AsyncMock()
    adapter = discover_channels()['telegram']({'id': 'b', 'app_id': '123', 'secret': '123:token'}, received, AsyncMock())
    adapter._username = 'workstep_bot'
    body = {'message_id': 42, 'chat': {'id': -9, 'type': 'supergroup', 'title': '研发'},
            'from': {'id': 7, 'first_name': '小明'}, 'text': '@workstep_bot 你好', 'message_thread_id': 3}
    await adapter._handle_message(body)
    await adapter._drain_messages()
    message = received.await_args.args[0]
    assert (message.conversation_type, message.conversation_id, message.sender_id, message.text) == ('group', '-9', '7', '你好')
    assert message.conversation_name == '研发'
    assert message.reply_context == {'message_thread_id': 3}
    await adapter._handle_message({**body, 'text': '普通群消息'})
    await adapter._drain_messages()
    assert received.await_count == 1
    await adapter._handle_message({**body, 'text': '回复', 'reply_to_message': {'from': {'id': 123}}})
    await adapter._drain_messages()
    assert received.await_count == 2
    await adapter._handle_message({**body, 'from': {'id': 8, 'is_bot': True}})
    await adapter._drain_messages()
    assert received.await_count == 2


async def test_discord_messages_ignore_bots_and_unmentioned_guild_messages():
    received = AsyncMock()
    adapter = discover_channels()['discord']({'id': 'b', 'app_id': '123', 'secret': 'token'}, received, AsyncMock())
    body = {'id': 'm', 'channel_id': 'c', 'guild_id': 'g', 'author': {'id': 'u', 'username': 'alice'},
            'content': '<@123> hello', 'mentions': [{'id': '123'}]}
    await adapter._handle_message(body)
    await adapter._drain_messages()
    message = received.await_args.args[0]
    assert (message.conversation_type, message.conversation_id, message.sender_name, message.text) == ('group', 'c', 'alice', 'hello')
    await adapter._handle_message({**body, 'mentions': []})
    await adapter._handle_message({**body, 'author': {'id': 'u', 'bot': True}})
    await adapter._drain_messages()
    assert received.await_count == 1
    await adapter._handle_message({**body, 'guild_id': None, 'mentions': [], 'content': '私聊'})
    await adapter._drain_messages()
    assert received.await_args.args[0].conversation_type == 'single'


async def test_slack_ack_is_sent_before_slow_message_handler_and_threads_are_preserved():
    entered, release = asyncio.Event(), asyncio.Event()
    async def receive(message):
        entered.set()
        await release.wait()
        assert message.text == '你好'
        assert message.reply_context == {'thread_ts': '1.0'}
    adapter = discover_channels()['slack']({'id': 'b', 'app_id': 'A1', 'secret': 'token', 'app_token': 'app-token'}, receive, AsyncMock())
    adapter._user_id = 'U123'
    socket = AsyncMock()
    await adapter._handle_frame(socket, {'envelope_id': 'envelope', 'type': 'events_api', 'payload': {
        'event_id': 'event', 'event': {'type': 'app_mention', 'channel': 'C1', 'user': 'U1', 'ts': '2.0',
                                    'thread_ts': '1.0', 'text': '<@U123> 你好'}}})
    socket.send.assert_awaited_once_with(json.dumps({'envelope_id': 'envelope'}))
    await asyncio.wait_for(entered.wait(), 1)
    release.set()
    await adapter._drain_messages()
    await adapter._handle_frame(socket, {'envelope_id': 'e2', 'type': 'events_api', 'payload': {'event': {
        'type': 'message', 'channel_type': 'channel', 'channel': 'C1', 'user': 'U1', 'text': '普通消息', 'ts': '3.0'}}})
    assert not adapter._messages


@pytest.mark.parametrize('platform', ['telegram', 'discord', 'slack'])
async def test_slow_social_network_does_not_block_health_and_stop_cancels_requests(platform):
    import main
    entered, release = asyncio.Event(), asyncio.Event()
    async def slow(request):
        entered.set()
        await release.wait()
        return httpx.Response(200, json={'ok': True, 'result': {'id': 123, 'username': 'workstep_bot'},
                                       'id': '123', 'user_id': 'U123', 'url': 'wss://unused.invalid'})
    state = AsyncMock()
    adapter = discover_channels()[platform]({'id': 'b', 'app_id': '123', 'secret': 'token', 'app_token': 'app-token'}, AsyncMock(), state)
    adapter._http = httpx.AsyncClient(transport=httpx.MockTransport(slow))
    await adapter.start()
    try:
        await asyncio.wait_for(entered.wait(), 1)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'), .5)).status_code == 200
    finally:
        await asyncio.wait_for(adapter.stop(), 1)
        release.set()
    assert adapter._task is None
    assert not adapter._messages


@pytest.mark.parametrize('platform', ['telegram', 'discord', 'slack'])
async def test_social_http_failures_never_expose_credential_urls(platform):
    adapter = discover_channels()[platform]({'id': 'b', 'app_id': '123', 'secret': 'private-token', 'app_token': 'private-app-token'}, AsyncMock(), AsyncMock())
    def fail(request):
        raise httpx.ConnectError('secret at ' + str(request.url), request=request)
    adapter._http = httpx.AsyncClient(transport=httpx.MockTransport(fail))
    try:
        with pytest.raises(RuntimeError) as error:
            await adapter._api('POST', 'getMe' if platform == 'telegram' else '/users/@me' if platform == 'discord' else 'auth.test')
        assert 'private-' not in str(error.value)
        assert error.value.__suppress_context__
    finally:
        await adapter.stop()


async def test_social_bot_api_masks_both_slack_tokens_and_routes_through_shared_sessions(bots):
    import main
    from tests.test_channel_bots import FakeAdapter
    manager, project, _, _, chats, _ = bots
    manager._factories.update({platform: FakeAdapter for platform in ('telegram', 'discord', 'slack')})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test') as client:
        values = {'platform': 'slack', 'name': '助手', 'app_id': 'A123', 'secret': 'bot-secret',
                  'app_token': 'app-secret', 'default_project_id': project.id, 'enabled': True}
        created = await client.post('/api/channel-bots', json=values)
        assert created.status_code == 200
        bot = created.json()
        assert bot['has_secret'] and bot['has_app_token']
        assert 'app_token' not in bot and 'secret' not in bot
        await manager.handle_message(IncomingMessage(bot['id'], 'in', 'single', 'C1', 'U1', '你好'))
        assert len(chats) == 1
        assert '你好' in chats[0][2]
        updated = await client.patch('/api/channel-bots/' + bot['id'], json={'name': '新助手', 'app_token': ''})
        assert updated.status_code == 200
        assert updated.json()['has_app_token']
        listed = await client.get('/api/channel-bots')
        assert 'app-secret' not in listed.text and 'bot-secret' not in listed.text
        assert manager._store.values['channel_bots']['bots'][0]['app_token'] == 'app-secret'
        missing = await client.post('/api/channel-bots', json={**values, 'app_id': 'A2', 'app_token': ''})
        assert missing.status_code == 400
        telegram = await client.post('/api/channel-bots', json={**values, 'platform': 'telegram', 'app_id': '', 'secret': '123:token', 'app_token': ''})
        assert telegram.status_code == 200
        assert telegram.json()['app_id'] == '123'


async def test_telegram_poll_offsets_are_advanced_and_message_ids_are_scoped_to_chat():
    received, state = AsyncMock(), AsyncMock()
    adapter = discover_channels()['telegram']({'id': 'b', 'app_id': '123', 'secret': '123:token'}, received, state)
    polls = []
    async def api(method, path, **kwargs):
        if path == 'getMe':
            return {'id': 123, 'username': 'workstep_bot'}
        if path == 'getUpdates':
            polls.append(kwargs['json'])
            if len(polls) > 1:
                raise asyncio.CancelledError()
            return [{'update_id': n, 'message': {'message_id': 1, 'chat': {'type': 'private', 'id': n},
                'from': {'id': n}, 'text': '你好'}} for n in (7, 8)]
    adapter._api = api
    with pytest.raises(asyncio.CancelledError):
        await adapter._connect()
    await adapter._drain_messages()
    assert polls[1]['offset'] == 9
    assert len({call.args[0].message_id for call in received.await_args_list}) == 2
    state.assert_awaited_with('connected', '')


@pytest.mark.parametrize('resume', [False, True])
async def test_discord_gateway_identifies_or_resumes_and_handles_reconnect(monkeypatch, resume):
    adapter = discover_channels()['discord']({'id': 'b', 'app_id': '123', 'secret': 'token'}, AsyncMock(), AsyncMock())
    if resume:
        adapter._session_id, adapter._resume_url, adapter._sequence = 'old', 'wss://gateway.discord.gg', 4
    adapter._api = AsyncMock(side_effect=[{'id': '123'}, {'url': 'wss://gateway.discord.gg'}])
    frames = [
        {'op': 0, 't': 'READY', 's': 5, 'd': {'session_id': 'session', 'resume_gateway_url': 'wss://gateway.discord.gg'}},
        {'op': 1}, {'op': 11}, {'op': 0, 't': 'MESSAGE_CREATE', 's': 6,
         'd': {'id': 'm', 'channel_id': 'c', 'author': {'id': 'u'}, 'content': 'hi'}}, {'op': 7},
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
    monkeypatch.setattr('services.channels.discord.websockets.connect', lambda *a, **k: socket)
    await asyncio.wait_for(adapter._connect(), 1)
    await adapter._drain_messages()
    assert socket.sent[0]['op'] == (6 if resume else 2)
    assert socket.sent[0]['d']['token'] == 'token'
    assert {'op': 1, 'd': 5} in socket.sent
    assert adapter._session_id == 'session' and adapter._sequence == 6
    adapter._on_message.assert_awaited_once()


async def test_slack_socket_authentication_and_outbound_use_different_tokens(monkeypatch):
    adapter = discover_channels()['slack']({'id': 'b', 'app_id': 'A1', 'secret': 'xoxb-token', 'app_token': 'xapp-token'}, AsyncMock(), AsyncMock())
    requests = []
    async def request(request):
        requests.append(request)
        if request.url.path.endswith('/auth.test'): return httpx.Response(200, json={'ok': True, 'user_id': 'U123'})
        if request.url.path.endswith('/apps.connections.open'): return httpx.Response(200, json={'ok': True, 'url': 'wss://socket.slack.com/'})
        return httpx.Response(200, json={'ok': True})
    adapter._http = httpx.AsyncClient(transport=httpx.MockTransport(request))
    frames = [{'type': 'hello'}, {'type': 'disconnect'}]
    class Socket:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        def __aiter__(self): return self
        async def __anext__(self): return json.dumps(frames.pop(0))
    monkeypatch.setattr('services.channels.slack.websockets.connect', lambda *a, **k: Socket())
    try:
        await adapter._connect()
        adapter._on_state.assert_awaited_with('connected', '')
        await adapter.send_text(IncomingMessage('b', 'm', 'group', 'C1', 'U1', '', reply_context={'thread_ts': '1.0'}), '结果')
        assert [request.headers['authorization'] for request in requests] == ['Bearer xoxb-token', 'Bearer xapp-token', 'Bearer xoxb-token']
        assert json.loads(requests[-1].content)['thread_ts'] == '1.0'
    finally:
        await adapter.stop()


async def test_telegram_http_logging_redacts_the_bot_token(caplog):
    import logging
    adapter = discover_channels()['telegram']({'id': 'b', 'app_id': '123', 'secret': '123:private-token'}, AsyncMock(), AsyncMock())
    adapter._http = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={'ok': True, 'result': {}})))
    try:
        with caplog.at_level(logging.INFO, logger='httpx'):
            await adapter._api('POST', 'getMe')
        assert 'private-token' not in caplog.text
    finally:
        await adapter.stop()


@pytest.mark.parametrize('platform', ['telegram', 'discord', 'slack'])
async def test_social_platform_frames_use_shared_project_whitelist_and_task_routes(bots, platform):
    manager, project, _, submissions, chats, _ = bots
    adapters = {}
    def factory(bot, on_message, on_state):
        adapter = discover_channels()[platform](bot, on_message, on_state)
        async def start():
            await on_state('connected', '')
        adapter.start = start
        adapter._api = AsyncMock(return_value={})
        adapter._username, adapter._user_id = 'workstep_bot', '123'
        adapters[bot['id']] = adapter
        return adapter
    manager._factories[platform] = factory
    bot = await manager.create_bot({'platform': platform, 'name': '助手', 'app_id': '123',
        'secret': '123:token', 'app_token': 'app-token', 'enabled': True,
        'default_target_type': 'project', 'default_project_id': project.id})
    adapter = adapters[bot['id']]
    async def receive(message_id, group=False):
        if platform == 'telegram':
            await adapter._handle_message({'message_id': message_id, 'chat': {'id': '-99' if group else '99',
                'type': 'group' if group else 'private'}, 'from': {'id': '99'},
                'text': '@workstep_bot 你好' if group else '你好'})
        elif platform == 'discord':
            await adapter._handle_message({'id': str(message_id), 'channel_id': '-99' if group else '99',
                'guild_id': 'guild' if group else None, 'author': {'id': '99'},
                'mentions': [{'id': '123'}], 'content': '<@123> 你好'})
        else:
            await adapter._handle_frame(AsyncMock(), {'envelope_id': 'e', 'type': 'events_api', 'payload': {
                'event_id': str(message_id), 'event': {'type': 'app_mention' if group else 'message',
                    'channel_type': 'channel' if group else 'im', 'channel': '-99' if group else '99',
                    'user': '99', 'ts': str(message_id), 'text': '<@123> 你好'}}})
        await adapter._drain_messages()
    await receive(1)
    assert len(chats) == 1
    assert platform in chats[0][2]
    adapter._api.assert_awaited()
    await manager.save_private_whitelist(bot['id'], True, [])
    await receive(2)
    assert len(chats) == 1
    await manager.bind_group(project.id, 'task-1', bot['id'], '-99')
    await receive(3, group=True)
    await receive(3, group=True)
    assert len(submissions) == 1
    assert submissions[0][1] == 'task-1'


async def test_social_tls_client_initialization_does_not_block_health(monkeypatch):
    import threading
    import main
    entered, release = threading.Event(), threading.Event()
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={'ok': True, 'result': {}})))
    health = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test')
    def slow_client(**kwargs):
        entered.set()
        assert release.wait(2)
        return client
    monkeypatch.setattr('services.channels.social.httpx.AsyncClient', slow_client)
    adapter = discover_channels()['telegram']({'id': 'b', 'app_id': '123', 'secret': '123:token'}, AsyncMock(), AsyncMock())
    pending = asyncio.create_task(adapter._api('POST', 'getMe'))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        assert (await asyncio.wait_for(health.get('/api/health'), .5)).status_code == 200
    finally:
        release.set()
        await pending
        await adapter.stop()
        await health.aclose()

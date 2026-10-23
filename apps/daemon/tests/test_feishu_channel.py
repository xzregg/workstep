"""Offline native Feishu/Lark message, media and interactive-card behavior."""
import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import pytest

from services.channels.base import ChannelAction, ChannelAttachment, ChannelButton, ChannelCard, IncomingMessage, OutgoingMessage
from services.channels.feishu import FeishuAdapter, LarkAdapter
from tests.test_channel_bots import bots
from tests.test_channel_controls import controls


def adapter(kind=FeishuAdapter):
    return kind({'id': 'bot', 'app_id': 'cli_app', 'secret': 'secret'}, AsyncMock(), AsyncMock())


def event(kind='text', content=None, *, group=True, mention=True, sender_type='user'):
    return {'header': {'event_type': 'im.message.receive_v1', 'app_id': 'cli_app'}, 'event': {
        'sender': {'sender_type': sender_type, 'sender_id': {'open_id': 'ou_user'}},
        'message': {'message_id': 'om_message', 'chat_id': 'oc_chat', 'chat_type': 'group' if group else 'p2p',
            'message_type': kind, 'content': json.dumps(content or {'text': '@_user_1 请处理'}),
            'mentions': [{'key': '@_user_1', 'id': {'open_id': 'ou_bot'}, 'name': '助手'}] if mention else []},
    }}


async def test_message_normalization_filters_bot_unmentioned_groups_and_preserves_people_mentions():
    bot = adapter()
    bot._bot_open_id = 'ou_bot'
    bot._api = AsyncMock(return_value={})
    await bot._handle_event(event())
    message = bot._on_message.await_args.args[0]
    assert (message.conversation_id, message.sender_id, message.text) == ('oc_chat', 'ou_user', '请处理')
    bot._on_message.reset_mock()
    await bot._handle_event(event(mention=False))
    await bot._handle_event(event(sender_type='app'))
    bot._on_message.assert_not_awaited()
    await bot._handle_event(event(group=False, mention=False, content={'text': '私聊'}))
    assert bot._on_message.await_args.args[0].conversation_type == 'single'


async def test_media_and_post_normalize_to_shared_attachment_contract():
    bot = adapter()
    bot._bot_open_id = 'ou_bot'
    bot._api = AsyncMock(return_value={})
    await bot._handle_event(event('image', {'image_key': 'img_key'}))
    message = bot._on_message.await_args.args[0]
    assert message.attachments[0].kind == 'image'
    assert message.attachments[0].reference == {'message_id': 'om_message', 'file_key': 'img_key'}
    await bot._handle_event(event('file', {'file_key': 'file_key', 'file_name': '报告.pdf'}))
    assert bot._on_message.await_args.args[0].attachments[0].name == '报告.pdf'
    await bot._handle_event(event('post', {'zh_cn': {'title': '标题', 'content': [[{'tag': 'text', 'text': '说明'}, {'tag': 'img', 'image_key': 'image'}]]}}))
    message = bot._on_message.await_args.args[0]
    assert '说明' in message.text and message.attachments[0].kind == 'image'


@pytest.mark.parametrize('kind,host', [(FeishuAdapter, 'open.feishu.cn'), (LarkAdapter, 'open.larksuite.com')])
async def test_outbound_region_recipients_and_token_cache(kind, host):
    bot = adapter(kind)
    calls = []
    def handle(request):
        calls.append(request)
        assert request.url.host == host
        if request.url.path.endswith('/tenant_access_token/internal'):
            return httpx.Response(200, json={'code': 0, 'tenant_access_token': 'token', 'expire': 7200})
        assert request.headers['Authorization'] == 'Bearer token'
        return httpx.Response(200, json={'code': 0, 'data': {'message_id': 'om_sent'}})
    bot._http = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    try:
        for kind, recipient in [('single', 'ou_user'), ('group', 'oc_group')]:
            await bot.send_text(IncomingMessage('bot', '', kind, recipient, 'ou_user', ''), '通知')
            assert calls[-1].url.params['receive_id_type'] == ('open_id' if kind == 'single' else 'chat_id')
            assert json.loads(calls[-1].content)['receive_id'] == recipient
        assert sum(r.url.path.endswith('/tenant_access_token/internal') for r in calls) == 1
    finally:
        await bot._http.aclose()


async def test_cards_share_streamed_body_and_dispatch_callback_with_original_identity():
    bot = adapter()
    bot._api = AsyncMock(return_value={'message_id': 'om_card'})
    recipient = IncomingMessage('bot', 'om_in', 'group', 'oc_chat', 'ou_user', '')
    card = ChannelCard('card', '处理中', '正文', (ChannelButton('0', '中止'),), running=True, message_id='assistant')
    await bot.send_card(recipient, card)
    await bot.update_reply(recipient, '更新正文')
    assert '更新正文' in json.dumps(bot._api.await_args.kwargs, ensure_ascii=False)
    bot.set_action_handler(AsyncMock(return_value='已停止'))
    await bot._handle_action({'event': {'operator': {'open_id': 'ou_user'}, 'context': {'open_chat_id': 'oc_chat', 'open_message_id': 'om_card'}, 'action': {'value': {'card_id': 'card', 'key': '0'}, 'form_value': {'comment': '意见'}}}})
    action = bot._on_action.await_args.args[0]
    assert (action.card_id, action.sender_id, action.conversation_id, action.comment) == ('card', 'ou_user', 'oc_chat', '意见')
    await bot.send_text(recipient, '最终正文')
    assert '最终正文' in json.dumps(bot._api.await_args.kwargs, ensure_ascii=False)
    assert '中止' not in json.dumps(bot._api.await_args.kwargs, ensure_ascii=False)


async def test_slow_send_does_not_block_health():
    bot = adapter()
    entered, release = asyncio.Event(), asyncio.Event()
    async def handle(request):
        if request.url.path.endswith('/tenant_access_token/internal'):
            return httpx.Response(200, json={'code': 0, 'tenant_access_token': 'token', 'expire': 7200})
        entered.set()
        await release.wait()
        return httpx.Response(200, json={'code': 0, 'data': {'message_id': 'om_sent'}})
    bot._http = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    pending = asyncio.create_task(bot.send_text(IncomingMessage('bot', '', 'single', 'ou_user', 'ou_user', ''), '消息'))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        import main
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'), .5)).status_code == 200
    finally:
        release.set()
        await pending
        await bot._http.aclose()


async def test_waiting_and_stop_controls_reuse_one_card_and_long_final_content_is_not_lost():
    bot = adapter()
    bot._api = AsyncMock(return_value={'message_id': 'om_card'})
    recipient = IncomingMessage('bot', 'om_in', 'single', 'oc_chat', 'ou_user', '')
    await bot.start_reply(recipient)
    await bot.send_card(recipient, ChannelCard('stop', '处理中', '中止此回复', (ChannelButton('0', '中止'),), running=True))
    assert sum(call.args[0] == 'POST' for call in bot._api.await_args_list) == 1
    await bot.update_reply(recipient, '流式正文')
    body = '完整正文🙂\\\n' * 6000
    bot._api.reset_mock()
    await bot.send_text(recipient, body)
    payloads = [json.loads(call.kwargs['json']['content']) for call in bot._api.await_args_list]
    assert payloads[0]['elements'][0]['content'] + ''.join(item['text'] for item in payloads[1:]) == body
    assert '中止' not in json.dumps(payloads[0], ensure_ascii=False)
    assert not bot._reply_cards


async def test_native_media_upload_and_bounded_authenticated_download(tmp_path):
    bot = adapter(LarkAdapter)
    calls = []
    def handle(request):
        calls.append(request)
        assert request.url.host == 'open.larksuite.com'
        if request.url.path.endswith('/internal'):
            return httpx.Response(200, json={'code': 0, 'tenant_access_token': 'token', 'expire': 7200})
        assert request.headers['Authorization'] == 'Bearer token'
        if '/resources/' in request.url.path:
            assert request.url.params['type'] == 'image'
            return httpx.Response(200, content=b'png', headers={'Content-Type': 'image/png'})
        if request.url.path.endswith('/images'):
            assert b'image_type' in request.content and b'message' in request.content
            return httpx.Response(200, json={'code': 0, 'data': {'image_key': 'img_key'}})
        if request.url.path.endswith('/files'):
            assert b'file_type' in request.content and b'stream' in request.content
            return httpx.Response(200, json={'code': 0, 'data': {'file_key': 'file_key'}})
        return httpx.Response(200, json={'code': 0, 'data': {'message_id': 'om_sent'}})
    bot._http = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    try:
        await bot.send(IncomingMessage('bot', '', 'single', 'oc_chat', 'ou_user', ''), OutgoingMessage('报告', (
            ChannelAttachment('image', '截图.png', data=b'png'), ChannelAttachment('file', '报告.txt', data=b'text'),
        )))
        sent = [json.loads(call.content) for call in calls if call.url.path.endswith('/messages')]
        assert [item['msg_type'] for item in sent] == ['text', 'image', 'file']
        attachment = ChannelAttachment('image', reference={'message_id': 'om_in', 'file_key': 'img_key'})
        assert await bot.download(attachment) == (b'png', 'image.png')
        from services.channels.media import incoming_content
        project = type('Project', (), {'path': tmp_path, 'workstep_dir': tmp_path / '.workstep', 'name': 'demo'})()
        content = await incoming_content(project, bot, IncomingMessage('bot', 'om_in', 'single', 'oc_chat', 'ou_user', '', attachments=(attachment,)))
        assert '.png)' in content
        from agent_assistants.base import extract_uploaded_images
        assert len(await asyncio.to_thread(extract_uploaded_images, project, str(tmp_path), content)) == 1
        from dataclasses import replace
        bot.CAPABILITIES = replace(bot.CAPABILITIES, max_image_bytes=2)
        with pytest.raises(ValueError, match='超过'):
            await bot.download(attachment)
    finally:
        await bot._http.aclose()


@pytest.mark.parametrize('same_chat', [True, False])
async def test_reply_quote_keeps_media_in_the_original_chat(same_chat):
    bot = adapter()
    bot._bot_open_id = 'ou_bot'
    bot._api = AsyncMock(return_value={'items': [{
        'message_id': 'om_parent', 'chat_id': 'oc_chat' if same_chat else 'other', 'msg_type': 'file',
        'body': {'content': json.dumps({'file_key': 'file', 'file_name': '报告.pdf'})},
    }]})
    incoming = event()
    incoming['event']['message']['content'] = json.dumps({'text': '@_user_1'})
    incoming['event']['message']['parent_id'] = 'om_parent'
    await bot._handle_event(incoming)
    if same_chat:
        message = bot._on_message.await_args.args[0]
        assert message.quote.attachments[0].reference['message_id'] == 'om_parent'
    else:
        bot._on_message.assert_not_awaited()


@pytest.mark.parametrize('platform', ['feishu', 'lark'])
async def test_native_card_callback_confirms_original_proposal_and_preserves_user_group_guards(controls, platform):
    broker, _, coordinator, _, scope, _, config = controls
    kind = FeishuAdapter if platform == 'feishu' else LarkAdapter
    bot = kind({'id': 'b', 'app_id': 'cli_app', 'secret': 'secret'}, AsyncMock(), AsyncMock())
    bot._api = AsyncMock(return_value={'message_id': 'om_proposal'})
    bot.set_action_handler(broker.handle)
    config['bots'][0]['platform'] = platform
    broker._adapters['b'] = bot
    await broker.event(scope, {'type': 'CUSTOM', 'name': 'workstep.action_proposal', 'value': {'id': 'proposal', 'status': 'pending'}})
    card_id = next(iter(bot._cards))
    callback = {'event': {'operator': {'open_id': 'intruder'}, 'context': {'open_chat_id': 'g', 'open_message_id': 'om_proposal'},
                          'action': {'value': {'card_id': card_id, 'key': '0'}}}}
    await bot._handle_action(callback)
    coordinator.confirm_action.assert_not_awaited()
    assert bot._cards[card_id].buttons
    callback['event']['operator']['open_id'] = 'u'
    callback['event']['context']['open_chat_id'] = 'other'
    await bot._handle_action(callback)
    coordinator.confirm_action.assert_not_awaited()
    callback['event']['context']['open_chat_id'] = 'g'
    await bot._handle_action(callback)
    coordinator.confirm_action.assert_awaited_once_with('p', 't', 'proposal', 'channel-card:' + card_id)
    await bot._handle_action(callback)
    assert coordinator.confirm_action.await_count == 1


async def test_reply_status_uses_actual_metadata_and_stops_when_completed():
    bot = adapter()
    bot._api = AsyncMock(return_value={'message_id': 'om_card'})
    recipient = IncomingMessage('bot', 'om_in', 'single', 'oc_chat', 'ou_user', '')
    bot.set_reply_metadata(recipient, {'engine': 'codex_sdk', 'model': 'test-model'})
    await bot.start_reply(recipient)
    bot.observe_reply(recipient, {'type': 'CUSTOM', 'name': 'workstep.usage', 'value': {'input_tokens': 100, 'output_tokens': 20}})
    bot.observe_reply(recipient, {'type': 'TEXT_MESSAGE_END', 'status': 'stopped'})
    await bot.send_text(recipient, '已停止')
    content = json.loads(bot._api.await_args.kwargs['json']['content'])
    assert content['header']['title']['content'].endswith('已停止')
    rendered = json.dumps(content, ensure_ascii=False)
    assert 'Codex * test-model' in rendered and '↑100' in rendered and '↓20' in rendered


async def test_websocket_cancellation_during_ping_does_not_wait_for_heartbeat_interval():
    bot = adapter()
    entered = asyncio.Event()
    async def write(data):
        entered.set()
        await asyncio.Event().wait()
    protocol = type('Protocol', (), {'_service_id': '1', '_ping_interval': 120, '_write_message': staticmethod(write)})()
    socket = type('Socket', (), {'close': AsyncMock()})()
    task = asyncio.create_task(bot._ping(protocol, socket))
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, .5)


async def test_long_connection_bootstrap_disconnect_status_and_shutdown_are_async(monkeypatch):
    import services.channels.feishu as module
    bot = adapter(LarkAdapter)
    connected, disconnect, retrying = asyncio.Event(), asyncio.Event(), asyncio.Event()
    async def state(status, error):
        if status == 'connected': connected.set()
        if status == 'reconnecting': retrying.set()
    bot._on_state = state
    def handle(request):
        assert request.url.host == 'open.larksuite.com'
        if request.url.path.endswith('/internal'):
            return httpx.Response(200, json={'code': 0, 'tenant_access_token': 'token', 'expire': 7200})
        if request.url.path.endswith('/info'):
            return httpx.Response(200, json={'code': 0, 'bot': {'open_id': 'ou_bot'}})
        assert json.loads(request.content) == {'AppID': 'cli_app', 'AppSecret': 'secret'}
        return httpx.Response(200, json={'code': 0, 'data': {'URL': 'wss://socket.example.test/endpoint?service_id=1',
            'ClientConfig': {'ReconnectCount': -1, 'ReconnectInterval': 3, 'ReconnectNonce': 0, 'PingInterval': 120}}})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    bot._http = client
    class Socket:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        def __aiter__(self): return self
        async def __anext__(self):
            await disconnect.wait()
            raise StopAsyncIteration
        async def send(self, data): pass
        async def close(self): disconnect.set()
    monkeypatch.setattr(module.websockets, 'connect', lambda uri, **kwargs: Socket())
    await bot.start()
    try:
        await asyncio.wait_for(connected.wait(), 5)
        assert bot._bot_open_id == 'ou_bot'
        disconnect.set()
        await asyncio.wait_for(retrying.wait(), 1)
    finally:
        await asyncio.wait_for(bot.stop(), 1)
    assert client.is_closed and not bot._tasks


async def test_reply_card_failure_falls_back_to_complete_text():
    bot = adapter()
    bot._api = AsyncMock(return_value={'message_id': 'om_card'})
    recipient = IncomingMessage('bot', 'om_in', 'single', 'oc_chat', 'ou_user', '')
    await bot.start_reply(recipient)
    async def failing(method, path, **kwargs):
        if method == 'PATCH': raise RuntimeError('平台拒绝卡片')
        return {'message_id': 'om_text'}
    bot._api = AsyncMock(side_effect=failing)
    body = '完整回复' * 5000
    await bot.send_text(recipient, body)
    texts = [json.loads(call.kwargs['json']['content'])['text'] for call in bot._api.await_args_list if call.args[0] == 'POST']
    assert ''.join(texts) == body
    assert not bot._reply_cards


async def test_official_ws_frames_ack_before_assistant_and_actions_bypass_message_queue():
    from services.channels.feishu import _Dispatcher
    from lark_oapi.ws.client import Client
    from lark_oapi.ws.pb.pbbp2_pb2 import Frame
    bot = adapter()
    bot._bot_open_id = 'ou_bot'
    bot._api = AsyncMock(return_value={})
    entered, release, clicked = asyncio.Event(), asyncio.Event(), asyncio.Event()
    async def on_message(message):
        entered.set()
        await release.wait()
    bot._on_message = on_message
    async def on_action(click, **kwargs):
        clicked.set()
    bot.set_action_handler(on_action)
    protocol = Client('cli_app', 'secret', event_handler=_Dispatcher(bot), auto_reconnect=False)
    socket = type('Socket', (), {'send': AsyncMock()})()
    protocol._conn = socket
    def frame(payload, identifier):
        value = Frame(SeqID=0, LogID=0, service=1, method=1, payload=json.dumps(payload).encode())
        for key, content in {'message_id': identifier, 'trace_id': 'trace', 'sum': '1', 'seq': '0', 'type': 'event'}.items():
            header = value.headers.add(); header.key = key; header.value = content
        return value.SerializeToString()
    try:
        await asyncio.wait_for(protocol._handle_message(frame(event(), 'receive')), .5)
        response = Frame(); response.ParseFromString(socket.send.await_args.args[0])
        assert json.loads(response.payload)['code'] == 200
        await asyncio.wait_for(entered.wait(), 1)
        callback = {'header': {'app_id': 'cli_app', 'event_type': 'card.action.trigger'}, 'event': {
            'operator': {'open_id': 'ou_user'}, 'context': {'open_chat_id': 'oc_chat', 'open_message_id': 'om_card'},
            'action': {'value': {'card_id': 'control', 'key': '0'}},
        }}
        await asyncio.wait_for(protocol._handle_message(frame(callback, 'click')), .5)
        await asyncio.wait_for(clicked.wait(), .5)
        assert not release.is_set()
        response.ParseFromString(socket.send.await_args.args[0])
        assert json.loads(response.payload)['code'] == 200
    finally:
        release.set()
        await bot.stop()
        protocol._cache._cron.cancel()
        await asyncio.gather(protocol._cache._cron, return_exceptions=True)


@pytest.mark.parametrize('platform', ['feishu', 'lark'])
async def test_new_channels_reuse_project_sessions_task_bindings_and_duplicate_filter(bots, platform):
    manager, project, second, submissions, chats, adapters = bots
    manager._factories[platform] = manager._factories['dingtalk']
    bot = await manager.create_bot({'platform': platform, 'name': '助手', 'app_id': 'cli_app', 'secret': 'secret',
        'enabled': True, 'default_target_type': 'project', 'default_project_id': project.id})
    incoming = IncomingMessage(bot['id'], 'om_first', 'single', 'oc_private', 'ou_user', '问题')
    await manager.handle_message(incoming)
    await manager.handle_message(incoming)
    assert len(chats) == 1
    await manager.bind_group(second.id, 'task-2', bot['id'], 'oc_group')
    await manager.handle_message(IncomingMessage(bot['id'], 'om_group', 'group', 'oc_group', 'ou_user', '任务问题'))
    assert submissions[-1][0:2] == (second.id, 'task-2')
    assert all('secret' not in row and row['has_secret'] for row in await manager.list_bots())

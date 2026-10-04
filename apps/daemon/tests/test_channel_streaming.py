import asyncio
from unittest.mock import AsyncMock

import pytest

from services.channels.base import ChannelAttachment, IncomingMessage, OutgoingMessage
from services.channels.wecom import WeComAdapter
from services.channels.reply_stream import ChannelReplyStream


@pytest.mark.asyncio
async def test_progress_coalesces_while_network_is_slow_and_stops_before_final():
    entered, release = asyncio.Event(), asyncio.Event()
    sent = []

    async def send(text):
        sent.append(text)
        entered.set()
        await release.wait()

    stream = ChannelReplyStream(send, interval=0.01)
    stream.update('一')
    await asyncio.wait_for(entered.wait(), 1)
    for index in range(2000):
        stream.update(f'最新正文 {index}')
    # A stalled network does not block the producer or the event loop.
    await asyncio.wait_for(asyncio.sleep(0), 0.1)
    release.set()
    for _ in range(100):
        if len(sent) == 2:
            break
        await asyncio.sleep(0.005)
    assert sent == ['一', '最新正文 1999']
    await stream.close()
    stream.update('结束后不再发送')
    await asyncio.sleep(0.02)
    assert len(sent) == 2


@pytest.mark.asyncio
async def test_progress_failure_does_not_escape_or_keep_retrying():
    send = AsyncMock(side_effect=RuntimeError('disconnected'))
    stream = ChannelReplyStream(send, interval=0.01)
    stream.update('正文')
    await asyncio.sleep(0.02)
    stream.update('更多正文')
    await asyncio.sleep(0.02)
    await stream.close()
    assert send.await_count == 1


@pytest.mark.asyncio
async def test_wecom_progress_uses_same_bubble_and_final_body_is_complete():
    adapter = WeComAdapter({'id': 'bot'}, AsyncMock(), AsyncMock())
    adapter._client = type('Client', (), {'reply_stream': AsyncMock(), 'reply_stream_with_card': AsyncMock(), 'send_message': AsyncMock()})()
    message = IncomingMessage('bot', 'message', 'single', 'user', 'user', '问题', reply_context={'headers': {'req_id': 'req'}})
    await adapter.start_reply(message)
    await adapter.update_reply(message, '部分正文')
    await adapter.send_text(message, '完整正文')
    calls = adapter._client.reply_stream.await_args_list
    assert [call.args[2] for call in calls] == ['', '部分正文', '完整正文']
    assert len({call.args[1] for call in calls}) == 1
    assert [call.kwargs['finish'] for call in calls] == [False, False, True]


@pytest.mark.asyncio
async def test_wecom_long_utf8_body_is_bounded_without_losing_text():
    adapter = WeComAdapter({'id': 'bot'}, AsyncMock(), AsyncMock())
    adapter._client = type('Client', (), {'reply_stream': AsyncMock(), 'send_message': AsyncMock()})()
    message = IncomingMessage('bot', 'message', 'single', 'user', 'user', '问题', reply_context={'headers': {'req_id': 'req'}})
    body = '中🙂' * 6000
    await adapter.update_reply(message, body)
    assert len(adapter._client.reply_stream.await_args.args[2].encode()) <= 20480
    await adapter.send_text(message, body)
    first = adapter._client.reply_stream.await_args.args[2]
    rest = [call.args[1]['markdown']['content'] for call in adapter._client.send_message.await_args_list]
    assert first + ''.join(rest) == body
    assert all(len(part.encode()) <= 4096 for part in rest)


@pytest.mark.asyncio
async def test_wecom_attachment_only_reply_finishes_waiting_bubble(monkeypatch):
    monkeypatch.setattr('services.channels.wecom_media.upload_media', AsyncMock(return_value='media'))
    adapter = WeComAdapter({'id': 'bot'}, AsyncMock(), AsyncMock())
    adapter._client = type('Client', (), {'reply_stream': AsyncMock(), 'send_message': AsyncMock()})()
    message = IncomingMessage('bot', 'message', 'single', 'user', 'user', '问题', reply_context={'headers': {'req_id': 'req'}})
    await adapter.send(message, OutgoingMessage(attachments=(ChannelAttachment(kind='image', data=b'image'),)))
    assert adapter._client.reply_stream.await_args.kwargs == {'finish': True}
    adapter._client.send_message.assert_awaited_once_with('user', {'msgtype': 'image', 'image': {'media_id': 'media'}})


async def test_dingtalk_progress_replaces_one_card_and_final_does_not_add_text():
    from services.channels.dingtalk import DingTalkAdapter
    adapter = DingTalkAdapter({'id':'bot','app_id':'client','secret':'secret'}, AsyncMock(), AsyncMock())
    adapter._card_api = AsyncMock(return_value={})
    adapter._send_text = AsyncMock()
    message = IncomingMessage('bot','message','group','group','','')
    assert adapter.supports_streaming_reply(message)
    await adapter.update_reply(message, '@编写\n正在执行…')
    await adapter.update_reply(message, '@编写\n部分正文')
    await adapter.send_text(message, '@编写\n完整正文\n\n已完成')
    calls = adapter._card_api.await_args_list
    assert [c.args[0] for c in calls] == ['POST','PUT','PUT']
    assert len({c.args[1]['outTrackId'] for c in calls}) == 1
    assert calls[-1].args[1]['cardData']['cardParamMap']['markdown'] == '@编写\n完整正文\n\n已完成'
    adapter._send_text.assert_not_awaited()
    assert not adapter._reply_cards
    # An explicit retry of the same logical message starts a fresh card instance.
    first_id = calls[0].args[1]['outTrackId']
    await adapter.update_reply(message, '重试正文')
    assert adapter._card_api.await_args.args[1]['outTrackId'] != first_id
    adapter.release_reply(message)


async def test_wecom_active_messages_do_not_claim_streaming_support():
    adapter = WeComAdapter({'id':'bot'}, AsyncMock(), AsyncMock())
    message = IncomingMessage('bot','message','group','group','','')
    assert not adapter.supports_streaming_reply(message)


async def test_dingtalk_card_network_latency_keeps_health_responsive(monkeypatch):
    from services.channels.dingtalk import DingTalkAdapter
    from httpx import ASGITransport, AsyncClient
    import main
    entered, release = asyncio.Event(), asyncio.Event()
    class Response:
        async def __aenter__(self):
            entered.set()
            await release.wait()
            return self
        async def __aexit__(self, *args): pass
        def raise_for_status(self): pass
        async def json(self): return {}
    class Session:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        def request(self, *args, **kwargs): return Response()
    monkeypatch.setattr('services.channels.dingtalk.aiohttp.ClientSession', Session)
    adapter = DingTalkAdapter({'id':'bot','app_id':'client','secret':'secret'}, AsyncMock(), AsyncMock())
    adapter._token = AsyncMock(return_value='token')
    message = IncomingMessage('bot','message','group','group','','')
    pending = asyncio.create_task(adapter.update_reply(message,'部分正文'))
    try:
        await asyncio.wait_for(entered.wait(),1)
        async with AsyncClient(transport=ASGITransport(app=main.app),base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'),.5)).status_code == 200
    finally:
        release.set()
        await pending
        adapter.release_reply(message)


async def test_dingtalk_failed_final_card_update_falls_back_to_full_text():
    from services.channels.dingtalk import DingTalkAdapter
    adapter = DingTalkAdapter({'id':'bot','app_id':'client','secret':'secret'}, AsyncMock(), AsyncMock())
    adapter._card_api = AsyncMock(return_value={})
    adapter._send_text = AsyncMock()
    message = IncomingMessage('bot','message','group','group','','')
    await adapter.update_reply(message,'部分正文')
    adapter._card_api.side_effect = RuntimeError('card expired')
    await adapter.send_text(message,'完整正文')
    adapter._send_text.assert_awaited_once_with(message,'完整正文')
    assert not adapter._reply_cards


async def test_dingtalk_stop_button_stays_on_the_streaming_reply_and_finish_keeps_body():
    import json
    from services.channels.base import ChannelButton, ChannelCard
    from services.channels.dingtalk import DingTalkAdapter
    adapter = DingTalkAdapter({'id':'bot','app_id':'client','secret':'secret'}, AsyncMock(), AsyncMock())
    adapter._card_api = AsyncMock(return_value={})
    message = IncomingMessage('bot','message','group','group','user','问题')
    await adapter.send_card(message, ChannelCard('stop-card','正在处理','等待回复',
        (ChannelButton('0','终止'),), running=True))
    await adapter.update_reply(message, '部分正文')
    await adapter.update_reply(message, '更多正文')
    calls = adapter._card_api.await_args_list
    assert [c.args[0] for c in calls] == ['POST', 'PUT', 'PUT']
    assert {c.args[1]['outTrackId'] for c in calls} == {'stop-card'}
    for call in calls:
        buttons = json.loads(call.args[1]['cardData']['cardParamMap']['sys_full_json_obj'])['msgButtons']
        assert [button['text'] for button in buttons] == ['终止']
    await adapter.send_text(message, '完整正文')
    await adapter.update_card(message, ChannelCard('stop-card','已结束','点击终止可停止本次运行。', running=True))
    final = adapter._card_api.await_args.args[1]['cardData']['cardParamMap']
    assert final['markdown'] == '完整正文'
    assert json.loads(final['sys_full_json_obj'])['msgButtons'] == []


@pytest.mark.parametrize('conversation_type', ['single', 'group'])
async def test_wecom_running_reply_uses_independent_stop_card(conversation_type):
    from aibot import WSClient, WSClientOptions
    from services.channels.base import ChannelButton, ChannelCard
    adapter = WeComAdapter({'id':'bot'}, AsyncMock(), AsyncMock())
    client = WSClient(WSClientOptions(bot_id='bot', secret='test'))
    client._ws_manager.send_reply = AsyncMock()
    adapter._client = client
    message = IncomingMessage('bot','message',conversation_type,'room','user','问题',
        reply_context={'headers':{'req_id':'req'}})
    await adapter.start_reply(message)
    await adapter.send_card(message, ChannelCard('stop','处理中','点击中止',
        (ChannelButton('0','中止', danger=True),), running=True, message_id='assistant'))
    await adapter.update_reply(message, '部分正文')
    await adapter.send_card(message, ChannelCard('choice','请选择','是否继续？',
        (ChannelButton('yes','确认'),)))
    await adapter.send_text(message, '完整正文')
    bodies = [c.args[1] for c in client._ws_manager.send_reply.await_args_list]
    assert [b['msgtype'] for b in bodies] == ['stream','template_card','stream','template_card','stream']
    assert bodies[1]['chatid'] == 'room'
    assert bodies[1]['template_card']['main_title']['title'] == '处理中'
    assert bodies[1]['template_card']['button_list'][0]['style'] == 3
    assert '消息 ID: assistant' in bodies[1]['template_card']['sub_title_text']
    assert bodies[0]['stream']['content'] == ('' if conversation_type == 'single' else '正在处理…')
    assert bodies[4]['stream']['content'] == '完整正文' + ('\n\n<@user>' if conversation_type == 'group' else '')
    assert bodies[4]['stream']['finish'] is True
    assert len({b['stream']['id'] for b in bodies if 'stream' in b}) == 1
    adapter.release_reply(message)


async def test_wecom_slow_independent_card_does_not_block_text_or_health():
    from httpx import ASGITransport, AsyncClient
    import main
    from services.channels.base import ChannelButton, ChannelCard
    entered, release = asyncio.Event(), asyncio.Event()
    async def slow_card(*args):
        entered.set()
        await release.wait()
    adapter = WeComAdapter({'id':'bot'}, AsyncMock(), AsyncMock())
    adapter._client = type('Client', (), {'reply_stream':AsyncMock(),
        'reply_stream_with_card':AsyncMock(), 'send_message':AsyncMock(side_effect=slow_card)})()
    message = IncomingMessage('bot','message','single','user','user','问题',
        reply_context={'headers':{'req_id':'req'}})
    await adapter.start_reply(message)
    pending = asyncio.create_task(adapter.send_card(message, ChannelCard('stop','处理中','点击中止',
        (ChannelButton('0','中止'),), running=True)))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        await asyncio.wait_for(adapter.update_reply(message, '最新正文'), .5)
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'), .5)).status_code == 200
        assert not pending.done()
    finally:
        release.set()
        await pending
    assert [c.args[2] for c in adapter._client.reply_stream.await_args_list] == ['','最新正文']
    adapter._client.reply_stream_with_card.assert_not_awaited()


async def test_dingtalk_stop_callback_preserves_reply_and_releases_completed_control():
    from services.channels.base import ChannelAction, ChannelButton, ChannelCard
    from services.channels.dingtalk import DingTalkAdapter
    adapter = DingTalkAdapter({'id':'bot','app_id':'client','secret':'secret'}, AsyncMock(), AsyncMock())
    adapter._card_api = AsyncMock(return_value={})
    message = IncomingMessage('bot','message','group','group','user','问题')
    await adapter.send_card(message, ChannelCard('stop','正在处理','等待回复',
        (ChannelButton('0','终止'),), running=True))
    await adapter.update_reply(message,'部分正文')
    async def stop(click, on_claimed):
        await on_claimed()
        await adapter.update_reply(message,'停止前最后一段正文')
        await adapter.send_text(message,'已停止。')
        await adapter.update_card(message,ChannelCard('stop','已结束','操作提示',running=True))
        return '已停止'
    adapter.set_action_handler(stop)
    await adapter._card_action(ChannelAction('bot','stop','0','user',conversation_id='group'))
    assert adapter._card_api.await_args.args[1]['cardData']['cardParamMap']['markdown'] == '已停止。'
    assert not adapter._reply_cards
    assert not adapter._running_reply_cards

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
    adapter._client = type('Client', (), {'reply_stream': AsyncMock(), 'send_message': AsyncMock()})()
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

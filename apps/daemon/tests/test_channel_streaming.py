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

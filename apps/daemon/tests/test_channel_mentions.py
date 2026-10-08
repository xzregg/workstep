"""Group reply mentions belong to platform delivery, never LLM content."""
import asyncio
import json
from unittest.mock import AsyncMock

import pytest

from services.channels.base import IncomingMessage
from services.channels.dingtalk import DingTalkAdapter
from services.channels.wecom import WeComAdapter
from tests.test_channel_controls import controls


@pytest.mark.parametrize('group,context,sender,mention', [
    (True, True, 'u1', True), (False, True, 'u1', False),
    (True, False, 'u1', False), (True, True, '', False),
])
async def test_wecom_mentions_sender_only_in_final_group_reply(group, context, sender, mention):
    adapter = WeComAdapter({'id': 'bot'}, AsyncMock(), AsyncMock())
    adapter._client = type('Client', (), {'reply_stream': AsyncMock(), 'send_message': AsyncMock()})()
    message = IncomingMessage('bot', 'm', 'group' if group else 'single', 'room', sender, '',
                              reply_context={'headers': {'req_id': 'request'}} if context else None)
    await adapter.update_reply(message, '部分正文')
    await adapter.send_text(message, '@协调\n完整正文')
    calls = adapter._client.reply_stream.await_args_list
    if context:
        assert calls[0].args[2] == '部分正文'
        assert calls[-1].args[2] == '@协调\n完整正文' + ('\n\n<@u1>' if mention else '')
        assert calls[-1].kwargs['finish'] is True
    else:
        assert adapter._client.send_message.await_args.args[1]['markdown']['content'] == '@协调\n完整正文'


async def test_wecom_mention_survives_stream_fallback_once():
    adapter = WeComAdapter({'id': 'bot'}, AsyncMock(), AsyncMock())
    adapter._client = type('Client', (), {
        'reply_stream': AsyncMock(side_effect=RuntimeError('expired')), 'send_message': AsyncMock(),
    })()
    message = IncomingMessage('bot', 'm', 'group', 'room', 'u1', '',
                              reply_context={'headers': {'req_id': 'request'}})
    await adapter.send_text(message, '正文' * 3000)
    contents = [c.args[1]['markdown']['content'] for c in adapter._client.send_message.await_args_list]
    assert ''.join(contents) == '正文' * 3000 + '\n\n<@u1>'
    assert sum(c.count('<@u1>') for c in contents) == 1


def webhook(monkeypatch):
    calls = []
    entered, release = asyncio.Event(), asyncio.Event()
    release.set()
    class Response:
        async def __aenter__(self):
            entered.set()
            await release.wait()
            return self
        async def __aexit__(self, *args): pass
        def raise_for_status(self): pass
        async def text(self): return json.dumps({'errcode': 0})
    class Session:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        def post(self, url, **kwargs):
            calls.append(kwargs['json'])
            return Response()
    monkeypatch.setattr('services.channels.dingtalk.aiohttp.ClientSession', Session)
    return calls, entered, release


@pytest.mark.parametrize('group,sender', [(True, 'u1'), (False, 'u1'), (True, '')])
async def test_dingtalk_final_webhook_reply_mentions_original_sender(monkeypatch, group, sender):
    calls, _, _ = webhook(monkeypatch)
    adapter = DingTalkAdapter({'id': 'bot', 'app_id': 'app', 'secret': 'secret'}, AsyncMock(), AsyncMock())
    message = IncomingMessage('bot', 'm', 'group' if group else 'single', 'room', sender, '',
                              reply_context='https://example.invalid/reply')
    await adapter.send_text(message, '完整正文')
    assert len(calls) == 1
    if group and sender:
        assert calls[0]['at'] == {'atUserIds': [sender], 'isAtAll': False}
        assert calls[0]['text']['content'] == '@u1\n完整正文'
    else:
        assert 'at' not in calls[0]
        assert calls[0]['text']['content'] == '完整正文'


async def test_dingtalk_stream_card_notifies_once_on_completion_and_keeps_loop_responsive(monkeypatch):
    calls, entered, release = webhook(monkeypatch)
    adapter = DingTalkAdapter({'id': 'bot', 'app_id': 'app', 'secret': 'secret'}, AsyncMock(), AsyncMock())
    adapter._card_api = AsyncMock(return_value={})
    message = IncomingMessage('bot', 'm', 'group', 'room', 'u1', '',
                              reply_context='https://example.invalid/reply')
    await adapter.update_reply(message, '部分正文')
    assert calls == []
    release.clear()
    pending = asyncio.create_task(adapter.send_text(message, '完整正文'))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        from httpx import ASGITransport, AsyncClient
        import main
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'), .5)).status_code == 200
    finally:
        release.set()
        await pending
    assert len(calls) == 1
    assert calls[0]['at']['atUserIds'] == ['u1']
    assert calls[0]['text']['content'] == '@u1\n回复已完成，请查看上方消息。'
    assert next(c for c in reversed(adapter._card_api.await_args_list) if c.args[0] in ('POST', 'PUT')).args[1]['cardData']['cardParamMap']['markdown'] == '完整正文'


async def test_dingtalk_card_failure_sends_full_reply_with_one_mention(monkeypatch):
    calls, _, _ = webhook(monkeypatch)
    adapter = DingTalkAdapter({'id': 'bot', 'app_id': 'app', 'secret': 'secret'}, AsyncMock(), AsyncMock())
    message = IncomingMessage('bot', 'm', 'group', 'room', 'u1', '',
                              reply_context='https://example.invalid/reply')
    adapter._reply_cards[adapter._reply_key(message)] = 'card'
    adapter.update_card = AsyncMock(side_effect=RuntimeError('expired'))
    await adapter.send_text(message, '完整正文')
    assert len(calls) == 1
    assert calls[0]['text']['content'] == '@u1\n完整正文'


async def test_stop_card_shows_assistant_message_id(controls):
    _, adapter, _, _, _, store, _ = controls
    card = adapter.send_card.await_args.args[1]
    assert card.message_id == 'a'
    assert '消息 ID: a' in card.text
    assert card.buttons[0].label == '中止'
    assert next(iter(store.rows.values()))[card.id]['assistant_message_id'] == 'a'


async def test_dingtalk_stop_card_keeps_message_id_in_stream_updates():
    from services.channels.base import ChannelCard, ChannelButton
    adapter = DingTalkAdapter({'id': 'bot', 'app_id': 'app', 'secret': 'secret'}, AsyncMock(), AsyncMock())
    adapter._card_api = AsyncMock(return_value={})
    message = IncomingMessage('bot', 'm', 'group', 'room', 'u1', '')
    await adapter.send_card(message, ChannelCard('stop', '处理中', '点击中止',
        (ChannelButton('0', '中止'),), running=True, message_id='assistant-id'))
    await adapter.update_reply(message, '正文更新')
    assert next(c for c in reversed(adapter._card_api.await_args_list) if c.args[0] in ('POST', 'PUT')).args[1]['cardData']['cardParamMap']['tips'] == '消息 ID: assistant-id'
    buttons = json.loads(next(c for c in reversed(adapter._card_api.await_args_list) if c.args[0] in ('POST', 'PUT')).args[1]['cardData']['cardParamMap']['sys_full_json_obj'])['msgButtons']
    assert buttons[0]['text'] == '中止'
    await adapter.send_text(message, '最终正文')
    await adapter.update_card(message, ChannelCard('stop', '已结束', '点击中止', running=True, message_id='assistant-id'))
    data = next(c for c in reversed(adapter._card_api.await_args_list) if c.args[0] in ('POST', 'PUT')).args[1]['cardData']['cardParamMap']
    assert data['tips'] == '消息 ID: assistant-id'
    assert data['markdown'] == '最终正文'

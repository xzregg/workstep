"""The v2 template has separate writing-content and completed-block renderers."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

from services.channels.base import ChannelButton, ChannelCard, IncomingMessage
from services.channels.dingtalk import DingTalkAdapter, _CardHandler
from tests.test_channel_controls import controls


async def test_real_template_stop_action_reaches_the_original_stop_service(controls):
    broker, _, coordinator, message, scope, *_ = controls
    adapter = DingTalkAdapter({'id': 'b', 'app_id': 'app', 'secret': 'secret'}, AsyncMock(), AsyncMock())
    adapter._card_api = AsyncMock(return_value={})
    broker._adapters['b'] = adapter
    adapter.set_action_handler(broker.handle)
    rows = await broker._load()
    card_id = next(iter(rows))
    await adapter.send_card(message, ChannelCard(card_id, '回复', '…', (ChannelButton('0', '中止', danger=True),), running=True))
    await _CardHandler(adapter).process(SimpleNamespace(data={'outTrackId': card_id, 'userId': 'u', 'spaceId': 'dtv1.card//IM_GROUP.g',
        'content': json.dumps({'cardPrivateData': {'actionIds': ['btn_stop']}})}))
    await asyncio.gather(*adapter._action_tasks)
    coordinator.stop_current.assert_awaited_once_with('p', 't', expected_message_id='a')
    await broker.finish(scope)
    await adapter.stop()


async def test_short_body_uses_native_streaming_then_commits_completed_blocks():
    adapter = DingTalkAdapter({'id': 'b', 'app_id': 'app', 'secret': 'secret'}, AsyncMock(), AsyncMock())
    adapter._card_api = AsyncMock(return_value={})
    message = IncomingMessage('b', 'm', 'single', 'cid', 'u', '你好')
    await adapter.send_card(message, ChannelCard('reply', '回复', '…', (ChannelButton('0', '中止'),), running=True))
    await adapter.update_reply(message, '你好，')
    await adapter.update_reply(message, '你好，我是 WorkStep。')
    streams = [call.args[1] for call in adapter._card_api.await_args_list if call.args[0] == 'STREAM']
    assert [s['content'] for s in streams] == ['你好，', '你好，我是 WorkStep。']
    assert all(s['key'] == 'content' and s['isFull'] and not s['isFinalize'] for s in streams)
    assert len({s['guid'] for s in streams}) == 2
    await adapter.send_text(message, '你好，我是 WorkStep。')
    final = adapter._card_api.await_args.args[1]['cardData']['cardParamMap']
    assert final['flowStatus'] == '3'
    assert final['hasAction'] == 'false'
    assert ''.join(b['markdown'] for b in json.loads(final['blockList'])) == '你好，我是 WorkStep。'
    assert final['copy_content'] == '你好，我是 WorkStep。'
    assert any(call.args[0] == 'STREAM' and call.args[1]['isFinalize'] for call in adapter._card_api.await_args_list)
    await adapter.update_card(message, ChannelCard('reply', '已结束', '过期提示', running=True))
    assert ''.join(b['markdown'] for b in json.loads(adapter._card_api.await_args.args[1]['cardData']['cardParamMap']['blockList'])) == '你好，我是 WorkStep。'
    await adapter.stop()


async def test_stop_callback_accepts_embedded_value_and_robot_private_space():
    adapter = DingTalkAdapter({'id': 'b', 'app_id': 'app', 'secret': 'secret'}, AsyncMock(), AsyncMock())
    adapter._card_api = AsyncMock(return_value={})
    action = AsyncMock(return_value='已停止')
    adapter.set_action_handler(action)
    await adapter.send_card(IncomingMessage('b', 'm', 'single', 'cid', 'u', 'hi'), ChannelCard('reply', '回复', '…', (ChannelButton('0', '中止'),), running=True))
    await _CardHandler(adapter).process(SimpleNamespace(data={'outTrackId': 'reply', 'userId': 'u', 'spaceId': 'dtv1.card//IM_ROBOT.u',
        'value': json.dumps({'cardPrivateData': {'actionIds': ['btn_stop']}})}))
    await asyncio.gather(*adapter._action_tasks)
    click = action.await_args.args[0]
    assert click.key == 'stop'
    assert click.sender_id == 'u'
    assert click.conversation_id == ''
    await adapter.stop()


async def test_native_stream_http_latency_keeps_health_responsive(monkeypatch):
    from httpx import ASGITransport, AsyncClient
    import main
    entered, release = asyncio.Event(), asyncio.Event()
    requests = []
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
        def request(self, method, url, **kwargs):
            requests.append((method, url, kwargs))
            return Response()
    monkeypatch.setattr('services.channels.dingtalk.aiohttp.ClientSession', Session)
    adapter = DingTalkAdapter({'id': 'b', 'app_id': 'app', 'secret': 'secret'}, AsyncMock(), AsyncMock())
    adapter._token = AsyncMock(return_value='token')
    pending = asyncio.create_task(adapter._stream_card('reply', '实时正文'))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'), .5)).status_code == 200
        assert not pending.done()
    finally:
        release.set()
        await pending
    assert requests[0][:2] == ('PUT', 'https://api.dingtalk.com/v1.0/card/streaming')
    assert requests[0][2]['json']['content'] == '实时正文'


async def test_failed_stream_finalize_still_commits_visible_final_body():
    adapter = DingTalkAdapter({'id': 'b', 'app_id': 'app', 'secret': 'secret'}, AsyncMock(), AsyncMock())
    adapter._card_api = AsyncMock(return_value={})
    adapter._send_text = AsyncMock()
    message = IncomingMessage('b', 'm', 'single', 'cid', 'u', '问题')
    await adapter.send_card(message, ChannelCard('reply', '回复', '…', (ChannelButton('0', '中止'),), running=True))
    await adapter.update_reply(message, '部分正文')
    async def fail_finalize(method, payload):
        if method == 'STREAM' and payload['isFinalize']:
            raise RuntimeError('stream unavailable')
        return {}
    adapter._card_api.side_effect = fail_finalize
    await adapter.send_text(message, '完整正文')
    final = adapter._card_api.await_args.args[1]['cardData']['cardParamMap']
    assert final['flowStatus'] == '3'
    assert json.loads(final['blockList'])[0]['markdown'] == '完整正文'
    adapter._send_text.assert_not_awaited()
    await adapter.stop()

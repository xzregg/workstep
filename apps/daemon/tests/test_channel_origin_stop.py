"""Every task reply destination gets one stop control, including its origin."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

from services.channels.base import ChannelAction, IncomingMessage
from services.channels.controls import ChannelControls
from tests.test_channel_controls import controls
from tests.test_channel_task_forwarder import setup, until


async def test_coordinator_origin_gets_stop_card_without_relying_on_submitter(setup):
    forwarder, bus, event, adapter, _, _, project = setup
    values = {}
    store = SimpleNamespace(get=lambda key, default=None: values.get(key, default),
                            set=lambda key, value: values.__setitem__(key, value))
    adapter.send_card = AsyncMock()
    adapter.update_card = AsyncMock()
    coordinator = SimpleNamespace(stop_current=AsyncMock(return_value=True))
    broker = ChannelControls(store, forwarder._load, forwarder._adapters, coordinator, SimpleNamespace(), AsyncMock())
    forwarder._controls = broker
    origin = IncomingMessage('bot', 'inbound', 'group', 'one', 'user', '开始',
                             reply_context={'headers': {'req_id': 'request'}})
    assert forwarder.register_origin(project.id, 'task', 'coord', origin)
    await bus.publish(event('coord', 'TEXT_MESSAGE_START', channel='coordinator'))
    await until(lambda: adapter.send_card.await_count >= 1)
    await asyncio.sleep(.03)
    original_cards = [c.args[1] for c in adapter.send_card.await_args_list if c.args[0].conversation_id == 'one']
    assert len(original_cards) == 1
    assert adapter.send_card.await_count == 1  # Only the inbound conversation has a stop control.
    card = original_cards[0]
    assert card.message_id == 'coord'
    assert card.buttons[0].label == '中止'
    assert await broker.handle(ChannelAction('bot', card.id, '0', 'user', conversation_id='one')) == '已停止'
    coordinator.stop_current.assert_awaited_once_with(project.id, 'task', expected_message_id='coord')
    await bus.publish(event('coord', 'TEXT_MESSAGE_END', channel='coordinator', status='stopped'))
    await until(lambda: not forwarder._messages)
    assert not broker._active


async def test_running_control_is_shared_by_inbound_and_forwarder(controls):
    broker, adapter, _, message, existing, *_ = controls
    results = await asyncio.gather(*(
        broker.begin(message, 'p', task_id='t', assistant_message_id='a', turn_id='turn') for _ in range(2)
    ))
    assert results == [existing, existing]
    assert adapter.send_card.await_count == 1
    await broker.finish(existing)
    await broker.finish(existing)
    assert not broker._active


async def test_confirmation_card_uses_its_message_body_and_identifier(controls):
    broker, adapter, _, _, scope, *_ = controls
    body = '从第一个阶段「编写」重跑，请确认后执行。'
    await broker.event(scope, {'type': 'TEXT_MESSAGE_CONTENT', 'messageId': 'a', 'content': body})
    await broker.event(scope, {'type': 'CUSTOM', 'name': 'workstep.action_proposal',
                              'value': {'id': 'proposal', 'status': 'pending',
                                        'impact': {'summary': "Restart step 'write' and its downstream steps"}}})
    card = adapter.send_card.await_args.args[1]
    assert card.text == body
    assert card.message_id == 'a'


async def test_wecom_confirmation_and_long_explanation_keep_visible_message_id():
    from services.channels.base import ChannelCard, ChannelButton
    from services.channels.wecom import WeComAdapter
    adapter = WeComAdapter({'id': 'bot'}, AsyncMock(), AsyncMock())
    adapter._client = SimpleNamespace(send_message=AsyncMock())
    recipient = IncomingMessage('bot', 'inbound', 'group', 'room', 'user', '')
    for text in ['请确认从编写阶段重跑。', '这次操作的说明。' * 40]:
        await adapter.send_card(recipient, ChannelCard('proposal', '请确认操作', text,
            (ChannelButton('0', '确认'), ChannelButton('1', '取消')), message_id='assistant-id'))
        template = adapter._client.send_message.await_args.args[1]['template_card']
        assert '消息 ID: assistant-id' in template['sub_title_text']
        assert len(template['sub_title_text']) <= 112


async def test_stop_uses_red_platform_style_but_confirmation_does_not(controls):
    import json
    from services.channels.dingtalk import DingTalkAdapter
    from services.channels.wecom import WeComAdapter
    broker, adapter, _, message, scope, *_ = controls
    stop = adapter.send_card.await_args.args[1]
    assert stop.buttons[0].danger is True
    wecom = WeComAdapter({'id': 'bot'}, AsyncMock(), AsyncMock())
    wecom._client = SimpleNamespace(send_message=AsyncMock())
    await wecom.send_card(message, stop)
    assert wecom._client.send_message.await_args.args[1]['template_card']['button_list'][0]['style'] == 3
    dingtalk = DingTalkAdapter({'id': 'bot', 'app_id': 'app', 'secret': 'secret'}, AsyncMock(), AsyncMock())
    assert json.loads(dingtalk._card_data(stop)['sys_full_json_obj'])['msgButtons'][0]['color'] == 'red'
    await broker.event(scope, {'type': 'CUSTOM', 'name': 'workstep.action_proposal',
                              'value': {'id': 'proposal', 'status': 'pending'}})
    confirmation = adapter.send_card.await_args.args[1]
    assert all(not button.danger for button in confirmation.buttons)
    await wecom.send_card(message, confirmation)
    assert all('style' not in b for b in wecom._client.send_message.await_args.args[1]['template_card']['button_list'])


async def test_pending_control_send_is_shared_without_blocking_health(controls):
    broker, adapter, _, message, *_ = controls
    entered, release = asyncio.Event(), asyncio.Event()
    async def slow_send(*args):
        entered.set()
        await release.wait()
    adapter.send_card.side_effect = slow_send
    first = asyncio.create_task(broker.begin(message, 'p', task_id='t', assistant_message_id='next'))
    second = None
    try:
        await asyncio.wait_for(entered.wait(), 1)
        second = asyncio.create_task(broker.begin(message, 'p', task_id='t', assistant_message_id='next'))
        from httpx import ASGITransport, AsyncClient
        import main
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'), .5)).status_code == 200
        assert not first.done()
    finally:
        release.set()
        scopes = await asyncio.gather(first, *([second] if second else []))
        for scope in scopes:
            await broker.finish(scope)
    assert scopes[0] is scopes[1]
    assert adapter.send_card.await_count == 2  # Fixture's original card plus this reply.

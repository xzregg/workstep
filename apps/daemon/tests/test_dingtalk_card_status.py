import json
from unittest.mock import AsyncMock

from services.channels.base import ChannelAction, ChannelButton, ChannelCard, IncomingMessage
from services.channels.card_status import CardStatus
from services.channels.dingtalk import DingTalkAdapter, _CardHandler
from tests.test_channel_task_forwarder import setup


def test_status_uses_latest_usage_snapshot_and_freezes_elapsed(monkeypatch):
    monkeypatch.setattr('services.channels.card_status.time.monotonic', lambda: 100)
    status = CardStatus({'engine': 'codex', 'model': 'qwen', 'thinking_effort': 'high', 'assistant': '渠道助手'})
    status.api_calls = 3
    event = {'type': 'CUSTOM', 'name': 'workstep.usage', 'value': {'input_tokens': 1200, 'output_tokens': 350, 'cache_read_input_tokens': 800}}
    status.observe(event)
    status.observe(event)
    monkeypatch.setattr('services.channels.card_status.time.monotonic', lambda: 233)
    status.observe({'type': 'TEXT_MESSAGE_END'})
    monkeypatch.setattr('services.channels.card_status.time.monotonic', lambda: 500)
    assert status.render() == 'Codex * qwen\n2m13s | ↑1.2k(C:800) ↓350'
    assert '↑' not in CardStatus().render()


async def test_soimy_template_status_and_stop_are_bound_to_one_reply():
    adapter = DingTalkAdapter({'id': 'bot', 'app_id': 'app', 'secret': 'secret'}, AsyncMock(), AsyncMock())
    adapter._card_api = AsyncMock(return_value={})
    message = IncomingMessage('bot', 'inbound', 'single', 'u', 'u', '几点')
    adapter.set_reply_metadata(message, {'engine': 'codex', 'model': 'qwen', 'thinking_effort': 'high', 'assistant': '渠道助手'})
    await adapter.send_card(message, ChannelCard('reply', '回复控制', '', (ChannelButton('0', '中止', danger=True),), running=True))
    payload = adapter._card_api.await_args.args[1]
    assert payload['cardTemplateId'] == '675cde2f-f526-40cb-b828-f5b2b57b8b77.schema'
    data = payload['cardData']['cardParamMap']
    assert data['quoteContent'] == '几点'
    assert data['hasAction'] == 'true'
    assert 'Codex * qwen' in data['statusLine']
    assert '渠道助手' not in data['statusLine'] and 'DAPI' not in data['statusLine']
    adapter.observe_reply(message, {'type': 'CUSTOM', 'name': 'workstep.usage', 'value': {'input_tokens': 1200, 'output_tokens': 350}})
    await adapter.update_reply(message, '正文')
    data = next(c for c in reversed(adapter._card_api.await_args_list) if c.args[0] in ('POST', 'PUT')).args[1]['cardData']['cardParamMap']
    assert adapter._card_api.await_args.args[1]['content'] == '正文'
    assert '↑1.2k ↓350' in data['statusLine']
    assert json.loads(data['blockList']) == []
    clicks = []
    async def action(click, on_claimed=None):
        clicks.append(click)
        await on_claimed()
        return '已停止'
    adapter.set_action_handler(action)
    from types import SimpleNamespace
    await _CardHandler(adapter).process(SimpleNamespace(data={'outTrackId': 'reply', 'userId': 'u', 'content': json.dumps({'cardPrivateData': {'actionIds': ['btn_stop']}})}))
    import asyncio
    await asyncio.gather(*adapter._action_tasks)
    assert clicks[0].key == 'stop'
    assert next(c for c in reversed(adapter._card_api.await_args_list) if c.args[0] in ('POST', 'PUT')).args[1]['cardData']['cardParamMap']['hasAction'] == 'false'
    assert next(c for c in reversed(adapter._card_api.await_args_list) if c.args[0] in ('POST', 'PUT')).args[1]['cardData']['cardParamMap']['quoteContent'] == '几点'


async def test_coordinator_status_reads_resolved_config_off_loop_and_routes_usage(setup, monkeypatch):
    import asyncio
    import threading
    from services.channels.controls import ChannelControls
    from tests.test_channel_controls import Store
    from agent_assistants.coordinator import CoordinatorModule
    from models.task import Task
    _, bus, _, _, config, projects, project = setup
    await projects.run_db(project.id, lambda p: Task.update(coordinator_engine='codex', coordinator_model='qwen', coordinator_thinking_effort='high').where(Task.id == 'task').execute())
    coordinator = CoordinatorModule(bus, projects, None)
    entered, release = threading.Event(), threading.Event()
    original = coordinator._get_config_sync
    def slow_config(*args):
        entered.set()
        release.wait(2)
        return original(*args)
    monkeypatch.setattr(coordinator, '_get_config_sync', slow_config)
    adapter = DingTalkAdapter({'id': 'bot', 'app_id': 'app', 'secret': 'secret'}, AsyncMock(), AsyncMock())
    adapter._card_api = AsyncMock(return_value={})
    controls = ChannelControls(Store(), AsyncMock(return_value=config), {'bot': adapter}, coordinator, object(), AsyncMock())
    message = IncomingMessage('bot', 'inbound', 'group', 'one', 'u', '开始')
    pending = asyncio.create_task(controls.begin(message, project.id, task_id='task', assistant_message_id='coord'))
    try:
        while not entered.is_set():
            await asyncio.sleep(.005)
        from httpx import ASGITransport, AsyncClient
        import main
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'), .5)).status_code == 200
        assert not pending.done()
    finally:
        release.set()
    scope = await pending
    assert 'Codex * qwen' in next(c for c in reversed(adapter._card_api.await_args_list) if c.args[0] in ('POST', 'PUT')).args[1]['cardData']['cardParamMap']['statusLine']
    await controls.event(scope, {'type': 'CUSTOM', 'name': 'workstep.usage', 'messageId': 'other', 'value': {'output_tokens': 999}})
    await controls.event(scope, {'type': 'CUSTOM', 'name': 'workstep.usage', 'messageId': 'coord', 'value': {'output_tokens': 35}})
    await adapter.update_reply(message, '回复')
    line = next(c for c in reversed(adapter._card_api.await_args_list) if c.args[0] in ('POST', 'PUT')).args[1]['cardData']['cardParamMap']['statusLine']
    assert '↓35' in line and '999' not in line
    await controls.finish(scope)
    await adapter.stop()


def test_responder_metadata_matches_the_accepted_turn():
    from services.channels.responder import ChatSessionResponder
    from types import SimpleNamespace
    module = SimpleNamespace(_turn_states={'turn': {'memory_key': ('p', 's'), 'thinking_effort': 'high'}},
                             _sessions={('p', 's'): SimpleNamespace(model='qwen', engine='pydantic-ai')})
    responder = ChatSessionResponder(None, None, module)
    assert responder.reply_metadata('turn') == {'model': 'qwen', 'engine': 'pydantic-ai', 'thinking_effort': 'high', 'assistant': '渠道助手'}


async def test_task_broadcast_card_gets_model_usage_and_no_stop_button(setup):
    from tests.test_channel_task_forwarder import until
    forwarder, bus, event, _, _, _, _ = setup
    adapter = DingTalkAdapter({'id': 'bot', 'app_id': 'app', 'secret': 'secret'}, AsyncMock(), AsyncMock())
    adapter._card_api = AsyncMock(return_value={})
    forwarder._adapters['bot'] = adapter
    await bus.publish(event('a', 'TEXT_MESSAGE_START', model='qwen'))
    await until(lambda: adapter._card_api.await_count >= 2)
    await bus.publish(event('a', 'CUSTOM', name='workstep.usage', value={'input_tokens': 1234, 'output_tokens': 56}))
    await bus.publish(event('a', 'TEXT_MESSAGE_END', content='结果', status='succeeded'))
    await until(lambda: not forwarder._messages)
    final_updates = [call.args[1]['cardData']['cardParamMap'] for call in adapter._card_api.await_args_list if call.args[0] == 'PUT']
    assert len(final_updates) == 2
    for data in final_updates:
        assert 'qwen' in data['statusLine']
        assert '↑1.2k ↓56' in data['statusLine']
        assert data['hasAction'] == 'false'
        assert data['flowStatus'] == '3'
    assert not adapter._card_status
    await adapter.stop()


async def test_confirmation_uses_button_template_even_with_explicit_builtin_id():
    adapter = DingTalkAdapter({'id': 'bot', 'app_id': 'app', 'secret': 'secret',
                              'card_template_id': '675cde2f-f526-40cb-b828-f5b2b57b8b77.schema'}, AsyncMock(), AsyncMock())
    adapter._card_api = AsyncMock(return_value={})
    await adapter.send_card(IncomingMessage('bot', 'm', 'single', 'u', 'u', ''),
                            ChannelCard('confirm', '确认', '是否继续？', (ChannelButton('0', '确认'),)))
    assert adapter._card_api.await_args.args[1]['cardTemplateId'] == '1366a1eb-bc54-4859-ac88-517c56a9acb1.schema'
    await adapter.stop()


def test_long_reply_blocks_keep_the_entire_unicode_body():
    adapter = DingTalkAdapter({'id': 'bot', 'app_id': 'app', 'secret': 'secret'}, AsyncMock(), AsyncMock())
    text = '测试🙂' * 3000
    data = adapter._card_data(ChannelCard('reply', '问题', text))
    blocks = json.loads(data['blockList'])
    assert data['content'] == ''
    assert ''.join(block['markdown'] for block in blocks) == text
    assert max(len(block['markdown']) for block in blocks) <= 2500
    assert data['copy_content'] == text


def test_status_sdk_engine_and_model_share_one_line():
    status = CardStatus({'engine': 'codex_sdk', 'model': 'gpt-6.1-sol'})
    assert status.render().splitlines()[0] == 'Codex * gpt-6.1-sol'


def test_status_header_handles_missing_metadata():
    assert CardStatus({'model': 'gpt-6.1-sol'}).render().splitlines()[0] == 'gpt-6.1-sol'
    assert CardStatus({'engine': 'custom'}).render().splitlines()[0] == 'custom'

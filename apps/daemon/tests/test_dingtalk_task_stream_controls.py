"""Automatic stages share one streaming card and a message-scoped stop action."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

import main
from services.channels.base import ChannelAction
from services.channels.controls import ChannelControls
from services.channels.dingtalk import DingTalkAdapter, _CardHandler
from tests.test_channel_controls import Store
from tests.test_channel_task_forwarder import setup, until


def connect(forwarder):
    adapter = DingTalkAdapter({'id': 'bot', 'app_id': 'app', 'secret': 'secret'}, AsyncMock(), AsyncMock())
    adapter._card_api = AsyncMock(return_value={})
    adapter._send_text = AsyncMock()
    adapter._send_active = AsyncMock()
    forwarder._adapters['bot'] = adapter
    runtime = SimpleNamespace(cancel_message=AsyncMock(return_value=True))
    coordinator = SimpleNamespace(get_config=AsyncMock(), stop_current=AsyncMock())
    broker = ChannelControls(Store(), forwarder._load, forwarder._adapters, coordinator,
                             object(), AsyncMock(), workflow_runtime=runtime)
    adapter.set_action_handler(broker.handle)
    forwarder._controls = broker
    return adapter, broker, runtime, coordinator


def posts(adapter):
    return [call.args[1] for call in adapter._card_api.await_args_list if call.args[0] == 'POST']


@pytest.mark.parametrize('message_id,status', [('a', 'succeeded'), ('review', 'failed'), ('a', 'stopped')])
async def test_automatic_stage_streams_and_finishes_same_stop_card(setup, message_id, status):
    forwarder, bus, event, _, _, _, _ = setup
    adapter, broker, runtime, coordinator = connect(forwarder)
    await bus.publish(event(message_id, 'TEXT_MESSAGE_START', engine='codex_sdk', model='step-model'))
    await until(lambda: len(posts(adapter)) == 2 and len(adapter._streamed_cards) == 2)
    created = posts(adapter)
    assert {row['openSpaceId'] for row in created} == {'dtv1.card//IM_GROUP.one', 'dtv1.card//IM_GROUP.two'}
    for row in created:
        data = row['cardData']['cardParamMap']
        assert data['hasAction'] == 'true' and data['flowStatus'] == '2'
        assert 'step-model' in data['statusLine']
        assert message_id in data['tips']
        assert '编写' in data['quoteContent']
    coordinator.get_config.assert_not_awaited()
    await bus.publish(event(message_id, 'TEXT_MESSAGE_CHUNK', delta='实时正文'))
    await until(lambda: sum(call.args[0] == 'STREAM' and '实时正文' in call.args[1]['content']
                            for call in adapter._card_api.await_args_list) == 2)
    await bus.publish(event(message_id, 'TEXT_MESSAGE_END', status=status, content='最终正文', error='测试错误'))
    await until(lambda: not forwarder._messages)
    assert len(posts(adapter)) == 2
    for row in created:
        updates = [call.args[1]['cardData']['cardParamMap'] for call in adapter._card_api.await_args_list
                   if call.args[0] == 'PUT' and call.args[1]['outTrackId'] == row['outTrackId']]
        assert updates[-1]['hasAction'] == 'false' and updates[-1]['flowStatus'] == '3'
        assert '最终正文' in updates[-1]['copy_content']
        assert ('测试错误' in updates[-1]['copy_content']) == (status == 'failed')
        assert '失效' in await broker.handle(ChannelAction('bot', row['outTrackId'], 'stop', 'member',
                                                          conversation_id=row['openSpaceId'].split('.')[-1]))
    assert not broker._active and not adapter._reply_cards and not adapter._running_reply_cards
    runtime.cancel_message.assert_not_awaited()
    adapter._send_text.assert_not_awaited()
    await adapter.stop()


async def test_native_stop_callback_is_scoped_and_deduplicated_across_groups(setup):
    forwarder, bus, event, _, _, _, project = setup
    adapter, broker, runtime, _ = connect(forwarder)
    await bus.publish(event('a', 'TEXT_MESSAGE_START'))
    await until(lambda: len(posts(adapter)) == 2 and len(adapter._streamed_cards) == 2)
    cards = {row['openSpaceId'].split('.')[-1]: row['outTrackId'] for row in posts(adapter)}
    assert '不属于' in await broker.handle(ChannelAction('bot', cards['one'], 'stop', 'member', conversation_id='other'))
    runtime.cancel_message.assert_not_awaited()
    await _CardHandler(adapter).process(SimpleNamespace(data={
        'outTrackId': cards['one'], 'userId': 'member', 'spaceId': 'dtv1.card//IM_GROUP.one',
        'content': {'cardPrivateData': {'actionIds': ['btn_stop']}},
    }))
    await until(lambda: not adapter._action_tasks)
    runtime.cancel_message.assert_awaited_once_with(project.id, 'task', 'a')
    assert '失效' in await broker.handle(ChannelAction('bot', cards['two'], 'stop', 'other-member', conversation_id='two'))
    await bus.publish(event('a', 'TEXT_MESSAGE_END', status='stopped', content='已产生的正文'))
    await until(lambda: not forwarder._messages)
    await bus.publish(event('b', 'TEXT_MESSAGE_START'))
    await until(lambda: len(posts(adapter)) == 4)
    assert '失效' in await broker.handle(ChannelAction('bot', cards['one'], 'stop', 'member', conversation_id='one'))
    assert runtime.cancel_message.await_count == 1
    await bus.publish(event('b', 'TEXT_MESSAGE_END', status='succeeded', content='下一阶段'))
    await until(lambda: not forwarder._messages)
    await adapter.stop()


async def test_slow_card_creation_does_not_block_health_or_other_group(setup):
    forwarder, bus, event, _, _, _, _ = setup
    adapter, _, _, _ = connect(forwarder)
    entered, release = asyncio.Event(), asyncio.Event()
    async def slow(method, payload):
        if method == 'POST' and payload['openSpaceId'].endswith('.one'):
            entered.set()
            await release.wait()
        return {}
    adapter._card_api.side_effect = slow
    try:
        await bus.publish(event('a', 'TEXT_MESSAGE_START'))
        await asyncio.wait_for(entered.wait(), 1)
        await until(lambda: len(adapter._streamed_cards) == 1)
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url='http://test') as client:
            response = await asyncio.wait_for(client.get('/api/health'), .5)
        assert response.status_code == 200
        await bus.publish(event('a', 'TEXT_MESSAGE_END', status='succeeded', content='结果'))
        release.set()
        await until(lambda: not forwarder._messages)
        assert len(posts(adapter)) == 2
    finally:
        release.set()
        await forwarder.shutdown()
        await adapter.stop()


async def test_unbinding_expires_stop_and_finishes_existing_card(setup):
    forwarder, bus, event, _, config, _, _ = setup
    adapter, broker, runtime, _ = connect(forwarder)
    await bus.publish(event('a', 'TEXT_MESSAGE_START'))
    await until(lambda: len(adapter._streamed_cards) == 2)
    card = next(row for row in posts(adapter) if row['openSpaceId'].endswith('.one'))
    config['groups'] = [row for row in config['groups'] if row['group_id'] != 'one']
    assert '绑定已改变' in await broker.handle(ChannelAction('bot', card['outTrackId'], 'stop', 'member', conversation_id='one'))
    runtime.cancel_message.assert_not_awaited()
    await bus.publish(event('a', 'TEXT_MESSAGE_END', status='succeeded', content='结果'))
    await until(lambda: not forwarder._messages)
    updates = [call.args[1]['cardData']['cardParamMap'] for call in adapter._card_api.await_args_list
               if call.args[0] == 'PUT' and call.args[1]['outTrackId'] == card['outTrackId']]
    assert updates[-1]['hasAction'] == 'false'
    assert not broker._active and not adapter._reply_cards
    await adapter.stop()


async def test_card_failure_falls_back_to_final_text_without_blocking_other_group(setup):
    forwarder, bus, event, _, _, _, _ = setup
    adapter, broker, _, _ = connect(forwarder)
    failed = set()
    async def fail_one_group(method, payload):
        if method == 'POST' and payload['openSpaceId'].endswith('.one'):
            failed.add(payload['outTrackId'])
            raise RuntimeError('卡片权限不足')
        if payload.get('outTrackId') in failed:
            raise RuntimeError('卡片不存在')
        return {}
    adapter._card_api.side_effect = fail_one_group
    await bus.publish(event('a', 'TEXT_MESSAGE_START'))
    await until(lambda: len(adapter._streamed_cards) == 1 and adapter._send_text.await_count == 1)
    await bus.publish(event('a', 'TEXT_MESSAGE_END', status='succeeded', content='完整结果'))
    await until(lambda: not forwarder._messages)
    assert any(call.args[0].conversation_id == 'one' and '完整结果' in call.args[1]
               for call in adapter._send_text.await_args_list)
    assert any(call.args[0] == 'PUT' and '完整结果' in call.args[1]['cardData']['cardParamMap']['copy_content']
               for call in adapter._card_api.await_args_list)
    assert not broker._active
    await adapter.stop()

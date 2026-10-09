"""DingTalk renders a full button card before the first reply token."""
import json
from unittest.mock import AsyncMock

from services.channels.base import ChannelButton, ChannelCard, IncomingMessage
from services.channels.dingtalk import DingTalkAdapter


async def test_native_ai_card_runs_and_finishes_on_the_same_instance():
    adapter = DingTalkAdapter({'id': 'bot', 'app_id': 'app', 'secret': 'secret'}, AsyncMock(), AsyncMock())
    adapter._card_api = AsyncMock(return_value={})
    message = IncomingMessage('bot', 'inbound', 'single', 'user', 'user', '问题')
    await adapter.send_card(message, ChannelCard('reply', '正在处理', '…',
        (ChannelButton('0', '中止', danger=True),), running=True, message_id='assistant'))
    initial = adapter._card_api.await_args.args[1]
    assert initial['cardTemplateId'] == '675cde2f-f526-40cb-b828-f5b2b57b8b77.schema'
    data = initial['cardData']['cardParamMap']
    assert data['flowStatus'] == '2'
    assert data['title'] == '问题'
    assert data['markdown'] == '…'
    assert data['msgContent'] == '…'
    assert data['msgTitle'] == '问题'
    layout = json.loads(data['sys_full_json_obj'])
    assert layout['order'] == ['msgTitle', 'msgContent', 'msgButtons']
    assert layout['msgButtons'] == [{'text': '中止', 'id': '0', 'request': True, 'color': 'red'}]
    await adapter.update_reply(message, '回复内容')
    data = next(c for c in reversed(adapter._card_api.await_args_list) if c.args[0] in ('POST', 'PUT')).args[1]['cardData']['cardParamMap']
    assert data['flowStatus'] == '2'
    assert data['msgContent'] == '回复内容'
    assert data['title'] == '问题'
    assert json.loads(data['sys_full_json_obj'])['msgButtons'] == layout['msgButtons']
    await adapter.send_text(message, '完整结果')
    await adapter.update_card(message, ChannelCard('reply', '已结束', '旧提示', running=True))
    data = next(c for c in reversed(adapter._card_api.await_args_list) if c.args[0] in ('POST', 'PUT')).args[1]['cardData']['cardParamMap']
    assert data['flowStatus'] == '3'
    assert data['msgContent'] == '完整结果'
    assert data['title'] == '问题'
    assert json.loads(data['sys_full_json_obj'])['msgButtons'] == []
    assert {call.args[1]['outTrackId'] for call in adapter._card_api.await_args_list} == {'reply'}


async def test_custom_markdown_template_keeps_its_existing_fields():
    adapter = DingTalkAdapter({'id': 'bot', 'app_id': 'app', 'secret': 'secret',
                              'card_template_id': 'custom.schema'}, AsyncMock(), AsyncMock())
    adapter._card_api = AsyncMock(return_value={})
    await adapter.send_card(IncomingMessage('bot', 'inbound', 'group', 'room', 'user', ''),
                            ChannelCard('reply', '标题', '正文', message_id='assistant'))
    payload = adapter._card_api.await_args.args[1]
    assert payload['cardTemplateId'] == 'custom.schema'
    data = payload['cardData']['cardParamMap']
    assert (data['title'], data['markdown'], data['tips']) == ('标题', '正文', '消息 ID: assistant')

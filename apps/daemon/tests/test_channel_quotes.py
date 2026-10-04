"""Quoted channel messages are retained in user content, including media."""
from types import SimpleNamespace
from unittest.mock import AsyncMock
from pathlib import Path

import pytest

from services.channels.base import IncomingMessage
from services.channels.wecom import WeComAdapter
from services.channels.media import incoming_content
from tests.test_channel_bots import bots


@pytest.mark.parametrize('quote,expected,kind', [
    ({'msgtype':'text','text':{'content':'@协调 主流程已完成\n额外阶段已取消'}}, '@协调 主流程已完成\n额外阶段已取消', None),
    ({'msgtype':'voice','voice':{'content':'继续执行交付'}}, '继续执行交付', None),
    ({'msgtype':'image','image':{'url':'https://files.qq.com/image','aeskey':'private-key'}}, '', 'image'),
    ({'msgtype':'file','file':{'url':'https://files.qq.com/file','aeskey':'private-key'}}, '', 'file'),
    ({'msgtype':'mixed','mixed':{'msg_item':[{'msgtype':'text','text':{'content':'截图说明'}},{'msgtype':'image','image':{'url':'https://files.qq.com/image','aeskey':'private-key'}}]}}, '截图说明', 'image'),
])
async def test_wecom_quote_reaches_user_message_with_original_reply_context(tmp_path,monkeypatch,quote,expected,kind):
    handlers={}
    class Client:
        def __init__(self,*args): pass
        connect=AsyncMock()
        disconnect=lambda self:None
        def on(self,event):
            def register(handler): handlers[event]=handler; return handler
            return register
    monkeypatch.setattr('services.channels.wecom.WSClient',Client)
    messages=[]
    async def receive(message): messages.append(message)
    adapter=WeComAdapter({'id':'bot','app_id':'platform','secret':'secret'},receive,AsyncMock())
    adapter.download=AsyncMock(return_value=(b'content', 'quoted.png' if kind=='image' else 'quoted.pdf'))
    frame={'headers':{'req_id':'req'},'body':{'msgtype':'text','msgid':'m','chattype':'group','chatid':'group','from':{'userid':'user'},'text':{'content':'@workstep 重新激活最后一个'},'quote':quote}}
    await adapter.start()
    try:
        await handlers['message.text'](frame)
        message=messages[0]
        assert message.reply_context is frame
        assert message.text=='@workstep 重新激活最后一个'
        assert message.quote.text==expected
        project=SimpleNamespace(path=tmp_path,workstep_dir=tmp_path/'.workstep')
        content=await incoming_content(project,adapter,message)
        assert content.startswith('引用消息：\n> ')
        assert content.endswith('本次消息：\n@workstep 重新激活最后一个')
        if expected:
            assert '\n'.join('> '+line for line in expected.splitlines()) in content
        if kind:
            assert message.quote.attachments[0].kind==kind
            assert '.workstep/uploads/' in content
            assert len(list((project.workstep_dir/'uploads').iterdir()))==1
            adapter.download.assert_awaited_once()
        else:
            adapter.download.assert_not_awaited()
        assert 'private-key' not in content
        assert 'https://files.qq.com' not in content
    finally:
        await adapter.stop()


@pytest.mark.parametrize('target',['task','project'])
async def test_quote_text_is_submitted_with_user_input_on_both_routes(bots,target):
    from services.channels.base import ChannelQuote
    manager,project,_,submissions,chats,_=bots
    bot=await manager.create_bot({'platform':'wecom','name':'BOT','app_id':'bot','secret':'secret','enabled':True,
        'default_target_type':target,'default_project_id':project.id,'default_task_id':'task-1' if target=='task' else ''})
    await manager.handle_message(IncomingMessage(bot['id'],'quote-request','group','group','user','重新激活最后一个',quote=ChannelQuote(text='额外阶段已取消')))
    content=(submissions if target=='task' else chats)[0][2]
    assert '引用消息：\n> 额外阶段已取消\n\n本次消息：\n重新激活最后一个' in content
    assert content.count('额外阶段已取消')==1


async def test_no_quote_keeps_original_content(tmp_path):
    project=SimpleNamespace(path=tmp_path,workstep_dir=tmp_path/'.workstep')
    adapter=AsyncMock()
    message=IncomingMessage('bot','m','single','user','user','原文')
    assert await incoming_content(project,adapter,message)=='原文'
    adapter.download.assert_not_awaited()


async def test_quoted_image_disk_io_keeps_health_responsive(bots,monkeypatch):
    import asyncio
    import threading
    from httpx import ASGITransport, AsyncClient
    import main
    from services.channels.base import ChannelQuote, ChannelAttachment, ChannelCapabilities
    manager,project,_,submissions,_,adapters=bots
    bot=await manager.create_bot({'platform':'wecom','name':'BOT','app_id':'bot','secret':'secret','enabled':True,
        'default_target_type':'task','default_project_id':project.id,'default_task_id':'task-1'})
    adapter=adapters[bot['id']]
    adapter.CAPABILITIES=ChannelCapabilities()
    adapter.download=AsyncMock(return_value=(b'image','image.png'))
    entered,release=threading.Event(),threading.Event()
    original=Path.write_bytes
    def slow(path,data):
        if path.parent.name=='uploads':
            entered.set()
            assert release.wait(2)
        return original(path,data)
    monkeypatch.setattr(Path,'write_bytes',slow)
    message=IncomingMessage(bot['id'],'quoted-image','group','group','user','修改这张图',
        quote=ChannelQuote(attachments=(ChannelAttachment('image',reference={'url':'https://files.qq.com/image'}),)))
    pending=asyncio.create_task(manager.handle_message(message))
    try:
        assert await asyncio.to_thread(entered.wait,1)
        async with AsyncClient(transport=ASGITransport(app=main.app),base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'),.5)).status_code==200
    finally:
        release.set()
        await pending
    assert '引用消息：\n> ![' in submissions[0][2]
    assert submissions[0][2].endswith('本次消息：\n修改这张图')

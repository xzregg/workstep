"""Channel adapter protocol and project media integration contracts."""
import asyncio
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from services.channels.base import ChannelAdapter, ChannelAttachment, ChannelCapabilities, IncomingMessage, OutgoingMessage
from services.channels.registry import discover_channels
from services.channels.media import incoming_content, load_outgoing_attachment


def test_registry_discovers_concrete_channels_and_declares_media_capabilities():
    channels = discover_channels()
    assert {'wecom', 'dingtalk'} <= channels.keys()
    for key in ('wecom','dingtalk'):
        assert issubclass(channels[key],ChannelAdapter)
        assert channels[key].CHANNEL_ID == key
        caps = channels[key].CAPABILITIES
        assert {'text','image','file'} <= caps.receive
        assert {'text','image','file'} <= caps.send
    assert channels['wecom'].CAPABILITIES.waiting
    assert not channels['dingtalk'].CAPABILITIES.waiting


async def test_incoming_media_saved_in_project_uploads_and_images_visible_to_engine(tmp_path):
    adapter=AsyncMock()
    adapter.CAPABILITIES = ChannelCapabilities()
    adapter.download.return_value=(b'\x89PNG\r\n\x1a\nimage','../../photo.png')
    message=IncomingMessage(bot_id='b',message_id='m',conversation_type='single',conversation_id='u',sender_id='u',text='看一下',
                            attachments=(ChannelAttachment(kind='image',name='../../photo.png',reference={'download_code':'opaque'}),))
    project=type('Project',(),{'path':tmp_path,'workstep_dir':tmp_path/'.workstep','name':'test'})()
    content=await incoming_content(project,adapter,message)
    assert content.startswith('看一下\n')
    assert '![' in content and '.workstep/uploads/' in content
    from agent_assistants.base import extract_uploaded_images
    images=await asyncio.to_thread(extract_uploaded_images,project,str(tmp_path),content)
    assert len(images)==1
    task_cwd=tmp_path/'.workstep/artifacts/workflow/task'
    task_cwd.mkdir(parents=True)
    task_images=await asyncio.to_thread(extract_uploaded_images,project,str(task_cwd),content)
    assert len(task_images)==1
    assert Path(images[0].path).read_bytes()==b'\x89PNG\r\n\x1a\nimage'
    assert Path(images[0].path).is_relative_to(project.workstep_dir/'uploads')
    assert 'opaque' not in content


async def test_outgoing_media_validates_project_containment_and_size(tmp_path):
    project=type('Project',(),{'path':tmp_path})()
    (tmp_path/'file.txt').write_text('hello')
    attachment=await load_outgoing_attachment(project,'file','file.txt',20)
    assert attachment.name=='file.txt'
    assert attachment.data==b'hello'
    with pytest.raises(ValueError):
        await load_outgoing_attachment(project,'file','../outside.txt',20)
    with pytest.raises(ValueError):
        await load_outgoing_attachment(project,'file','file.txt',2)
    outside=tmp_path.parent/'secret.txt';outside.write_text('secret')
    (tmp_path/'link').symlink_to(outside)
    with pytest.raises(ValueError):
        await load_outgoing_attachment(project,'file','link',20)


async def test_attachment_capability_and_markdown_references_use_shared_outgoing_protocol(tmp_path):
    from services.channels.wecom import WeComAdapter
    from services.channels.media import outgoing_content
    project=type('Project',(),{'path':tmp_path})()
    uploads=tmp_path/'.workstep/uploads';uploads.mkdir(parents=True)
    (uploads/'image.png').write_bytes(b'png')
    adapter=WeComAdapter({'id':'b'},AsyncMock(),AsyncMock())
    outgoing=await outgoing_content(project,adapter,'图片：![截图](.workstep/uploads/image.png) 外链 [网站](https://example.com)')
    assert len(outgoing.attachments)==1
    assert outgoing.attachments[0].kind=='image'
    assert '.workstep' not in outgoing.text
    assert 'https://example.com' in outgoing.text


async def test_wecom_media_upload_chunks_then_sends_native_image_and_file():
    from services.channels.wecom import WeComAdapter
    adapter=WeComAdapter({'id':'b'},AsyncMock(),AsyncMock())
    async def reply(frame,body,cmd):
        if cmd.endswith('_init'): return {'body':{'upload_id':'upload'}}
        if cmd.endswith('_finish'): return {'body':{'media_id':'media'}}
        return {}
    client=type('Client',(),{'reply':AsyncMock(side_effect=reply),'send_message':AsyncMock()})()
    adapter._client=client
    recipient=IncomingMessage('b','m','group','g','u','')
    await adapter.send(recipient,OutgoingMessage(attachments=(ChannelAttachment('image','a.png',data=b'x'*600000),ChannelAttachment('file','a.pdf',data=b'pdf'))))
    commands=[call.args[2] for call in client.reply.await_args_list]
    assert commands==['aibot_upload_media_init','aibot_upload_media_chunk','aibot_upload_media_chunk','aibot_upload_media_finish','aibot_upload_media_init','aibot_upload_media_chunk','aibot_upload_media_finish']
    assert client.reply.await_args_list[0].args[1]['total_chunks']==2
    assert [call.args[1]['msgtype'] for call in client.send_message.await_args_list]==['image','file']
    assert all(call.args[0]=='g' for call in client.send_message.await_args_list)


@pytest.mark.parametrize('platform', ['wecom','dingtalk'])
@pytest.mark.parametrize('kind', ['image','file'])
async def test_attachment_only_inbound_routes_into_existing_project_chat(bots, platform, kind):
    manager,project,*rest,adapters=bots
    bot=await manager.create_bot({'platform':platform,'name':'Echo','app_id':platform,'secret':'secret','enabled':True,
        'default_target_type':'project','default_project_id':project.id})
    adapter=adapters[bot['id']]
    adapter.CAPABILITIES=ChannelCapabilities()
    adapter.download=AsyncMock(return_value=(b'attachment','photo.png' if kind=='image' else 'report.pdf'))
    message=IncomingMessage(bot['id'],'media-in','single','u','u','',attachments=(ChannelAttachment(kind),))
    await manager.handle_message(message)
    await manager.handle_message(message)
    adapter.download.assert_awaited_once()
    chats=rest[2]  # fixture's project_chats
    assert len(chats)==1
    assert '.workstep/uploads/' in chats[0][2]
    assert ('![' in chats[0][2]) == (kind=='image')
    assert len(list((Path(project.workstep_dir)/'uploads').iterdir()))==1


@pytest.mark.parametrize('upgrade_http', [False, True])
async def test_media_download_is_bounded_and_does_not_block_health(monkeypatch, upgrade_http):
    from services.channels.media import fetch_media
    from httpx import ASGITransport,AsyncClient
    import main
    entered,release=asyncio.Event(),asyncio.Event()
    class Content:
        async def iter_chunked(self,size):
            entered.set()
            await release.wait()
            yield b'x'*11
    class Response:
        status=200
        headers={}
        content=Content()
        async def __aenter__(self): return self
        async def __aexit__(self,*args): pass
        def raise_for_status(self): pass
    class Session:
        def __init__(self,**kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self,*args): pass
        def get(self,*args,**kwargs): return Response()
    monkeypatch.setattr('services.channels.media.aiohttp.ClientSession',Session)
    pending=asyncio.create_task(fetch_media(('http' if upgrade_http else 'https') + '://files.qq.com/image',10,('qq.com',), upgrade_http=upgrade_http))
    try:
        await asyncio.wait_for(entered.wait(),1)
        async with AsyncClient(transport=ASGITransport(app=main.app),base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'),.5)).status_code==200
    finally: release.set()
    with pytest.raises(ValueError,match='超过'):
        await pending
    with pytest.raises(ValueError,match='HTTPS'):
        await fetch_media('http://127.0.0.1/secret',10,('qq.com',))


# Reuse the channel fixture with real project database executors.
from tests.test_channel_bots import bots


async def test_slow_media_disk_io_is_offloaded(tmp_path,monkeypatch):
    import threading
    from httpx import ASGITransport,AsyncClient
    import main
    project=type('Project',(),{'path':tmp_path})()
    target=tmp_path/'report.pdf';target.write_bytes(b'pdf')
    entered,release=threading.Event(),threading.Event()
    original=Path.open
    def slow(path,*args,**kwargs):
        if path==target:
            entered.set()
            assert release.wait(2)
        return original(path,*args,**kwargs)
    monkeypatch.setattr(Path,'open',slow)
    pending=asyncio.create_task(load_outgoing_attachment(project,'file','report.pdf',100))
    try:
        assert await asyncio.to_thread(entered.wait,1)
        async with AsyncClient(transport=ASGITransport(app=main.app),base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'),.5)).status_code==200
    finally:release.set()
    assert (await pending).data==b'pdf'


async def test_channel_discovery_io_is_offloaded(bots,monkeypatch):
    import threading
    from httpx import ASGITransport,AsyncClient
    import main
    manager,*_=bots
    entered,release=threading.Event(),threading.Event()
    original=discover_channels
    def slow():
        entered.set()
        assert release.wait(2)
        return original()
    monkeypatch.setattr('services.channels.bots.discover_channels',slow)
    pending=asyncio.create_task(manager.list_bots())
    try:
        assert await asyncio.to_thread(entered.wait,1)
        async with AsyncClient(transport=ASGITransport(app=main.app),base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'),.5)).status_code==200
    finally:release.set()
    assert await pending==[]


def test_new_adapter_discovery_and_duplicate_ids(monkeypatch):
    from types import SimpleNamespace
    import services.channels.registry as registry
    async def noop(self,*args): pass
    def adapter(module):
        return type('ExampleAdapter',(ChannelAdapter,),{'__module__':module,'CHANNEL_ID':'example',
            'DISPLAY_NAME':'Example','start':noop,'stop':noop,'send':noop})
    first=adapter('services.channels.example')
    second=adapter('services.channels.duplicate')
    modules={'services.channels.example':SimpleNamespace(Adapter=first,__name__="services.channels.example"),'services.channels.duplicate':SimpleNamespace(Adapter=second,__name__="services.channels.duplicate")}
    monkeypatch.setattr(registry.importlib,'import_module',lambda name:modules[name])
    monkeypatch.setattr(registry.pkgutil,'iter_modules',lambda paths:[SimpleNamespace(name='example')])
    assert registry.discover_channels.__wrapped__()=={'example':first}
    monkeypatch.setattr(registry.pkgutil,'iter_modules',lambda paths:[SimpleNamespace(name='example'),SimpleNamespace(name='duplicate')])
    with pytest.raises(ValueError,match='重复'):
        registry.discover_channels.__wrapped__()


async def test_dingtalk_unsupported_file_type_is_rejected_before_delivery():
    from services.channels.dingtalk import DingTalkAdapter
    adapter=DingTalkAdapter({'id':'b','app_id':'ding','secret':'secret'},AsyncMock(),AsyncMock())
    adapter._send_active=AsyncMock()
    with pytest.raises(ValueError,match='文件格式'):
        await adapter.send(IncomingMessage('b','m','single','u','u',''),OutgoingMessage(attachments=(ChannelAttachment('file','script.py',data=b'code'),)))
    adapter._send_active.assert_not_awaited()

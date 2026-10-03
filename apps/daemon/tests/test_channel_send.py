"""CLI-facing send API validates targets and stays responsive during delivery."""
import asyncio

import pytest
from httpx import ASGITransport, AsyncClient

import main
from models.chat_session import ChatMessage, ChatSession
from tests.test_channel_bots import bots  # shared real project databases and fake platform adapters


@pytest.mark.parametrize('platform', ['wecom', 'dingtalk'])
@pytest.mark.parametrize('target', ['session', 'user', 'group'])
async def test_channel_send_api_resolves_exact_recipient(bots, platform, target):
    manager, project, second, _, chats, adapters = bots
    bot = await manager.create_bot({'platform':platform,'name':'Echo','app_id':platform,'secret':'secret','enabled':True,
                                    'default_target_type':'project','default_project_id':project.id})
    def seed(_project):
        ChatSession.create(id='s1',project_id=project.id,workflow_id='',engine='codex',title='Echo',created_at='2026-10-03',updated_at='2026-10-03')
        ChatMessage.create(id='m1',session='s1',role='user',content='你好',author_id=f'channel:{platform}:u1',author_device_id=f'channel:{bot["id"]}',created_at='2026-10-03')
    await manager._project_manager.run_db(project.id,seed)
    data = await manager._load()
    data['sessions'][f'{bot["id"]}:single:chat:1']='s1'
    await manager._save(data)
    body={'project_id':project.id,'text':'通知内容'}
    body.update({'session_id':'s1'} if target=='session' else {'bot_id':bot['id'],f'{target}_id':'u1' if target=='user' else 'g1'})
    async with AsyncClient(transport=ASGITransport(app=main.app),base_url='http://test') as client:
        sessions=await client.get('/api/channel-bots/sessions',params={'project_id':project.id})
        assert sessions.status_code==200
        assert sessions.json()['sessions'][0]['session_id']=='s1'
        response=await client.post('/api/channel-bots/send',json=body)
        assert response.status_code==200
        assert response.json()['sent'] is True
        assert adapters[bot['id']].sent==[('chat:1' if target=='session' else ('u1' if target=='user' else 'g1'),'通知内容')]
        assert not chats  # raw notification must never start an LLM turn
        assert (await client.post('/api/channel-bots/send',json={**body,'project_id':second.id})).status_code in (403,404)
        for invalid in ({**body,'text':' '}, {**body,'user_id':'extra','group_id':'g'}, {'project_id':project.id,'text':'通知'}):
            assert (await client.post('/api/channel-bots/send',json=invalid)).status_code==422
        if target=='session':
            await manager._project_manager.run_db(project.id,lambda _: ChatSession.update(archived=True).where(ChatSession.id=='s1').execute())
            assert (await client.post('/api/channel-bots/send',json=body)).status_code==409
        await manager.update_bot(bot['id'],{'enabled':False})
        direct={ 'project_id':project.id,'bot_id':bot['id'],'user_id':'u1','text':'通知'}
        assert (await client.post('/api/channel-bots/send',json=direct)).status_code==409


async def test_channel_send_network_delay_and_failure_are_visible(bots):
    manager, project, *_rest, adapters = bots
    bot=await manager.create_bot({'platform':'wecom','name':'Echo','app_id':'wx','secret':'secret','enabled':True,
                                  'default_target_type':'project','default_project_id':project.id})
    entered,release=asyncio.Event(),asyncio.Event()
    async def delayed(*args):
        entered.set()
        await release.wait()
        raise RuntimeError('private transport error')
    adapters[bot['id']].send_text=delayed
    async with AsyncClient(transport=ASGITransport(app=main.app),base_url='http://test') as client:
        pending=asyncio.create_task(client.post('/api/channel-bots/send',json={'project_id':project.id,'bot_id':bot['id'],'user_id':'u1','text':'通知'}))
        try:
            await asyncio.wait_for(entered.wait(),1)
            assert (await asyncio.wait_for(client.get('/api/health'),.5)).status_code==200
        finally: release.set()
        response=await pending
        assert response.status_code==502
        assert 'private transport error' not in response.text


async def test_channel_send_session_db_delay_and_project_scope(bots, monkeypatch):
    import threading
    from types import SimpleNamespace
    manager, project, second, *_rest = bots
    bot=await manager.create_bot({'platform':'wecom','name':'Echo','app_id':'wx','secret':'secret','enabled':True,
                                  'default_target_type':'project','default_project_id':project.id})
    await manager._project_manager.run_db(project.id,lambda _: ChatSession.create(id='s',project_id=project.id,workflow_id='',engine='codex',created_at='2026-10-03',updated_at='2026-10-03'))
    data=await manager._load()
    data['sessions'][f'{bot["id"]}:single:u']='s'
    await manager._save(data)
    original=ChatSession.get_or_none
    entered,release=threading.Event(),threading.Event()
    def slow(*args):
        entered.set()
        assert release.wait(2)
        return original(*args)
    monkeypatch.setattr(ChatSession,'get_or_none',slow)
    body={'project_id':project.id,'session_id':'s','text':'通知'}
    async with AsyncClient(transport=ASGITransport(app=main.app),base_url='http://test') as client:
        pending=asyncio.create_task(client.post('/api/channel-bots/send',json=body))
        try:
            assert await asyncio.to_thread(entered.wait,1)
            assert (await asyncio.wait_for(client.get('/api/health'),.5)).status_code==200
        finally: release.set()
        assert (await pending).status_code==200
        monkeypatch.setattr('services.remote_access.get_current_actor',lambda: SimpleNamespace(project_id=second.id))
        assert (await client.post('/api/channel-bots/send',json=body)).status_code==403
        assert (await client.get('/api/channel-bots/sessions',params={'project_id':project.id})).status_code==403


async def test_explicit_group_binding_grants_only_that_recipient(bots):
    manager, first, second, *_rest, adapters=bots
    bot=await manager.create_bot({'platform':'wecom','name':'Echo','app_id':'wx','secret':'secret','enabled':True,
                                  'default_target_type':'project','default_project_id':second.id})
    await manager.bind_group(first.id,'task-1',bot['id'],'bound-group')
    body={'project_id':first.id,'bot_id':bot['id'],'text':'任务通知'}
    async with AsyncClient(transport=ASGITransport(app=main.app),base_url='http://test') as client:
        assert (await client.post('/api/channel-bots/send',json={**body,'group_id':'bound-group'})).status_code==200
        assert (await client.post('/api/channel-bots/send',json={**body,'group_id':'other-group'})).status_code==403
        assert (await client.post('/api/channel-bots/send',json={**body,'user_id':'u'})).status_code==403
        assert adapters[bot['id']].sent==[('bound-group','任务通知')]

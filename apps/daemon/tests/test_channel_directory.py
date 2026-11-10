import asyncio
from unittest.mock import AsyncMock
import pytest
from services.channels.directory import ChannelDirectoryService, DirectoryError


def bot(**changes):
    return {'id':'b', 'platform':'fake', 'app_id':'app', 'secret':'secret', 'enabled':True, 'directory_enabled':True, **changes}


def member(id='u1', name='张三'):
    return {'contact_id':id, 'name':name, 'departments':['研发'], 'user_id':id}


async def test_cache_and_failure():
    fetch = AsyncMock(return_value=[member()])
    service = ChannelDirectoryService(lambda _: fetch)
    try:
        service.configure(bot())
        await service.wait('b')
        for _ in range(3):
            assert (await service.contacts(bot(), '张三'))['contacts'][0]['user_id'] == 'u1'
            assert await service.resolve(bot(), user_name='张三') == 'u1'
        assert fetch.await_count == 1
        fetch.side_effect = RuntimeError('secret transport detail')
        service.refresh(bot())
        await service.wait('b')
        assert await service.resolve(bot(), user_name='张三') == 'u1'
        assert 'secret transport' not in str(service.status('b'))
        service.configure(bot(directory_enabled=False))
        with pytest.raises(DirectoryError):
            await service.contacts(bot(directory_enabled=False))
        assert service.status('b')['count'] == 0
    finally:
        await service.close()


async def test_ambiguity_and_identity():
    fetch = AsyncMock(return_value=[member(), member('u2'), {**member('u3','李四'), 'user_id':''}])
    service = ChannelDirectoryService(lambda _: fetch)
    try:
        service.configure(bot())
        await service.wait('b')
        with pytest.raises(DirectoryError) as error:
            await service.resolve(bot(), user_name='张三')
        assert error.value.code == 'ambiguous_recipient'
        assert len(error.value.candidates) == 2
        assert await service.resolve(bot(), contact_id='u2') == 'u2'
        with pytest.raises(DirectoryError, match='身份'):
            await service.resolve(bot(), contact_id='u3')
    finally:
        await service.close()


async def test_deduplication_and_invalidation():
    entered, release = asyncio.Event(), asyncio.Event()
    async def fetch():
        entered.set()
        await release.wait()
        return [member()]
    service = ChannelDirectoryService(lambda _: fetch)
    try:
        service.configure(bot())
        task = service._tasks['b']
        service.refresh(bot())
        assert service._tasks['b'] is task
        await asyncio.wait_for(entered.wait(), 1)
        assert service.status('b')['status'] == 'loading'
        service.configure(bot(app_id='new', directory_enabled=False))
        release.set()
        await asyncio.sleep(0)
        assert service.status('b')['count'] == 0
    finally:
        await service.close()

from httpx import ASGITransport, AsyncClient
import main
from tests.test_channel_bots import bots


async def test_directory_api_and_named_send_are_scoped_and_cached(bots, monkeypatch):
    from services.channels.directory_providers.dingtalk import DingTalkDirectory
    fetch = AsyncMock(return_value=[member(), member('u2'), member('u3', '李四')])
    monkeypatch.setattr(DingTalkDirectory, 'fetch_snapshot', fetch)
    manager, project, second, *_rest, adapters = bots
    created = await manager.create_bot({'platform':'dingtalk','name':'研发','app_id':'app','secret':'secret',
        'enabled':True,'directory_enabled':True,'default_target_type':'project','default_project_id':project.id})
    id = created['id']
    await manager.directory.wait(id)
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url='http://test') as client:
        base = f'/api/channel-bots/{id}'
        response = await client.get(base+'/contacts', params={'project_id':project.id,'query':'张三'})
        assert response.status_code == 200
        assert response.json()['total'] == 2
        assert (await client.get(base+'/contacts',params={'project_id':second.id})).status_code == 403
        body = {'project_id':project.id,'bot_id':id,'text':'查看任务','user_name':'张三'}
        response = await client.post('/api/channel-bots/send', json=body)
        assert response.status_code == 409
        assert response.json()['detail']['code'] == 'ambiguous_recipient'
        assert not adapters[id].sent
        assert (await client.post('/api/channel-bots/send', json={**body,'user_name':'李四'})).status_code == 200
        assert adapters[id].sent == [('u3','查看任务')]
        assert fetch.await_count == 1
        assert (await client.post('/api/channel-bots/send', json={**body,'user_id':'u1'})).status_code == 422
        await manager.update_bot(id, {'directory_enabled':False})
        assert (await client.get(base+'/contacts')).status_code == 409
        assert (await client.post('/api/channel-bots/send',json={k:v for k,v in body.items() if k!='user_name'} | {'user_id':'u1'})).status_code == 200
        assert 'directory_secret' not in created
        assert 'proactive_send_enabled' not in created


async def test_slow_directory_network_and_index_do_not_block_health(bots, monkeypatch):
    import threading
    import services.channels.directory as module
    from services.channels.directory_providers.dingtalk import DingTalkDirectory
    entered, release = asyncio.Event(), asyncio.Event()
    indexing, finish_index = threading.Event(), threading.Event()
    async def fetch(self):
        entered.set()
        await release.wait()
        return [member()]
    original = module._index
    def slow_index(rows):
        indexing.set()
        assert finish_index.wait(3)
        return original(rows)
    monkeypatch.setattr(DingTalkDirectory, 'fetch_snapshot', fetch)
    monkeypatch.setattr(module, '_index', slow_index)
    manager, project, *_ = bots
    async with AsyncClient(transport=ASGITransport(app=main.app),base_url='http://test') as client:
        created = await manager.create_bot({'platform':'dingtalk','name':'研发','app_id':'app','secret':'secret',
            'enabled':True,'directory_enabled':True,'default_target_type':'project','default_project_id':project.id})
        try:
            await asyncio.wait_for(entered.wait(), 1)
            assert (await asyncio.wait_for(client.get('/api/health'), .5)).status_code == 200
            refresh = await client.post(f"/api/channel-bots/{created['id']}/directory/refresh")
            assert refresh.status_code == 202
            release.set()
            assert await asyncio.to_thread(indexing.wait, 1)
            assert (await asyncio.wait_for(client.get('/api/health'), .5)).status_code == 200
        finally:
            release.set(); finish_index.set()
        await manager.directory.wait(created['id'])


async def test_project_actor_cannot_read_unscoped_directory_or_change_credentials(bots, monkeypatch):
    from types import SimpleNamespace
    manager, project, *_ = bots
    created = await manager.create_bot({'platform':'wecom','name':'企微','app_id':'app','secret':'bot-secret',
        'enabled':False,'directory_secret':'directory-secret','default_target_type':'project','default_project_id':project.id})
    assert 'directory-secret' not in str(await manager.list_bots())
    monkeypatch.setattr('services.remote_access.get_current_actor', lambda: SimpleNamespace(project_id=project.id))
    async with AsyncClient(transport=ASGITransport(app=main.app),base_url='http://test') as client:
        base=f"/api/channel-bots/{created['id']}"
        assert (await client.get(base+'/contacts')).status_code==403
        assert (await client.post(base+'/directory/refresh')).status_code==403
        assert (await client.patch(base,json={'directory_enabled':True})).status_code==403


async def test_wecom_observed_exact_bot_id_enables_directory_send(bots, monkeypatch):
    from services.channels.directory_providers.wecom import WeComDirectory
    from services.channels.base import IncomingMessage
    monkeypatch.setattr(WeComDirectory, 'fetch_snapshot', AsyncMock(return_value=[{**member(), 'user_id':''}]))
    manager, project, *_rest, adapters = bots
    created=await manager.create_bot({'platform':'wecom','name':'企微','app_id':'wx','secret':'secret',
        'directory_corp_id':'corp','directory_agent_id':'1','directory_secret':'directory-secret',
        'enabled':True,'directory_enabled':True,'default_target_type':'project','default_project_id':project.id})
    id=created['id']
    await manager.directory.wait(id)
    values={'project_id':project.id,'bot_id':id,'text':'通知','user_name':'张三'}
    with pytest.raises(DirectoryError,match='身份'):
        await manager.send_message(**values)
    # An encrypted/different ID with the same display name proves nothing.
    manager.directory.observe_sender(id, 'encrypted_u1')
    with pytest.raises(DirectoryError):
        await manager.send_message(**values)
    await manager.handle_message(IncomingMessage(id,'incoming','single','u1','u1','你好',sender_name='任意昵称'))
    await manager.send_message(**values)
    assert adapters[id].sent[-1] == ('u1','通知')
    assert (await manager.directory.contacts(await manager.directory_bot(id)))['contacts'][0]['user_id']=='u1'
    assert '张三' not in str(manager._store.values)  # directory rows never enter persistent bot config

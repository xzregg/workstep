import asyncio
import time
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from models.chat_session import ChatMessage
from models.fields import utc_now
from services import digital_person_memory as memory, digital_person_memory_index as index, memory_knowledge as knowledge
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime

async def seed(current, project):
    sid = (await current.main_session())['id']
    def write(_):
        ChatMessage.create(id='visual-source', session=sid, role='user', status='completed', content='只通知最终结果。' * 600, created_at=utc_now())
        memory.capture_session(sid, 'local')
    await current.projects.run_db(project.id, write)
    rows = await asyncio.to_thread(index.candidates, 'local')
    mid = rows[0]['id']
    await asyncio.to_thread(knowledge.store_extraction, {'memories':[{'summary':'只通知最终结果', 'kind':'preference', 'outcome':'stated', 'source_ids':[f'memory:{mid}'], 'entities':[{'kind':'person','name':'我','aliases':['本人']}]}]}, rows)
    return mid

async def test_visualization_real_knowledge_source_paging_and_forgetting(runtime):
    from services import memory_visualization as view
    current, project, _ = runtime
    mid = await seed(current, project)
    result = await view.browse(current.projects)
    derived = next(r for r in result['items'] if r['interpretation'])
    assert derived['kind'] == 'preference'
    assert (await view.browse(current.projects, project.name))['items']
    assert not (await view.browse(current.projects, '完全不匹配的检索词xyz'))['items']
    assert derived['entities'][0]['name'] == '我'
    assert derived['sources'][0]['project_name'] == project.name
    first = await view.read(current.projects, f'memory:{mid}', offset=0, limit=100)
    second = await view.read(current.projects, f'memory:{mid}', offset=first['next_offset'], limit=100)
    assert first['has_more'] and first['total_chars'] > 100
    assert second['offset'] == 100
    await asyncio.to_thread(index.forget, mid)
    assert not (await view.browse(current.projects))['items']
    with pytest.raises(LookupError):
        await view.read(current.projects, f'memory:{mid}')

async def test_visualization_api_does_not_block_and_rejects_project_actor(runtime, monkeypatch):
    import main
    from api.digital_person import router
    from services import memory_visualization as view
    from services.remote_access import ActorSnapshot, actor_context
    current, project, _ = runtime
    await seed(current, project)
    monkeypatch.setattr(main, 'digital_person_runtime', current)
    app=FastAPI();app.include_router(router)
    @app.get('/health')
    async def health(): return {'ok':True}
    original=index.candidates
    def slow(*a, **kw):
        time.sleep(.15)
        return original(*a, **kw)
    monkeypatch.setattr(index, 'candidates', slow)
    async with AsyncClient(transport=ASGITransport(app),base_url='http://test') as client:
        pending=asyncio.create_task(client.get('/api/digital-person/memory/view'))
        await asyncio.sleep(.03)
        assert not pending.done()
        assert (await asyncio.wait_for(client.get('/health'),.1)).status_code == 200
        assert (await pending).status_code == 200
        assert (await client.get('/api/digital-person/memory/source/bad')).status_code == 400
        with actor_context(ActorSnapshot(actor_id='u',user_name='u',device_id='d',device_name='d',source='remote_project',project_id=project.id,access_level='edit')):
            assert (await client.get('/api/digital-person/memory/view')).status_code == 403
            assert (await client.get('/api/digital-person/memory/source/memory:1')).status_code == 403

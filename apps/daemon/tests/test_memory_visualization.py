import asyncio
import time
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from models.chat_session import ChatMessage
from tests.memory_turn_fixture import create_completed_user
from models.fields import utc_now
from services import digital_person_memory as memory, digital_person_memory_index as index, memory_knowledge as knowledge
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime

async def seed(current, project):
    sid = (await current.main_session())['id']
    def write(_):
        create_completed_user(id='visual-source', session=sid, role='user', status='completed', content='只通知最终结果。' * 600, created_at=utc_now())
        memory.capture_session(sid, 'local')
    await current.projects.run_db(project.id, write)
    rows = await asyncio.to_thread(index.candidates, 'local')
    mid = next(row['id'] for row in rows if row['source_message_id']=='visual-source')
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
    assert all(row['id'] != f'memory:{mid}' and not row['interpretation'] for row in (await view.browse(current.projects))['items'])
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


async def test_library_stats_are_global_unbounded_and_exclude_invalid_sources(runtime):
    from services import memory_visualization as view
    current, project, _ = runtime
    mid = await seed(current, project)
    result = await view.browse(current.projects, '完全不匹配的检索词xyz')
    assert not result['items']
    stats = result['stats']
    assert stats['knowledge_count'] == 1
    assert stats['by_kind'] == {'preference':1, 'experience':0, 'fact':0, 'event':0}
    assert stats['indexed_count'] == 2  # user + completed assistant, not source fragments
    assert stats['processed_count'] + stats['pending_count'] == 2
    assert stats['latest_knowledge_at']
    def add_rows():
        with index.connect() as db:
            for i in range(65):
                db.execute("INSERT INTO memories(project_id,session_id,source_message_id,offset,scope,summary,source_hash,role,source_time,activated_at) VALUES(?,?,?,0,'local','','h','user','2026-11-16','2026-11-16')", (project.id,'s',f'count-{i}'))
            db.execute("INSERT INTO memories(project_id,session_id,source_message_id,offset,scope,summary,source_hash,role,source_time,activated_at) VALUES('removed','s','hidden',0,'local','','h','user','2026-11-16','2026-11-16')")
    await asyncio.to_thread(add_rows)
    stats = (await view.browse(current.projects, '完全不匹配的检索词xyz'))['stats']
    assert stats['indexed_count'] == 67
    await asyncio.to_thread(index.forget, mid)
    stats = (await view.browse(current.projects, '完全不匹配的检索词xyz'))['stats']
    assert stats['knowledge_count'] == 0
    assert stats['indexed_count'] == 66
    assert stats['latest_knowledge_at'] is None


async def test_stats_slow_sql_stays_off_event_loop(runtime, monkeypatch):
    from services import memory_visualization as view
    current, project, _ = runtime
    await seed(current, project)
    original = view.library_stats
    def slow(*args):
        time.sleep(.15)
        return original(*args)
    monkeypatch.setattr(view, 'library_stats', slow)
    pending = asyncio.create_task(view.browse(current.projects))
    await asyncio.sleep(.03)
    assert not pending.done()
    # This lightweight canary can run while the statistics SQL worker sleeps.
    await asyncio.wait_for(asyncio.sleep(.01), .08)
    assert (await pending)['stats']['knowledge_count'] == 1


async def test_stats_count_all_valid_knowledge_and_current_processing_receipts(runtime):
    from services import memory_visualization as view
    current, project, _ = runtime
    mid = await seed(current, project)
    await asyncio.to_thread(view.library_stats, [project.id])
    def add():
        with index.connect() as db:
            source = db.execute('SELECT * FROM memories WHERE id=?',(mid,)).fetchone()
            db.execute("INSERT INTO memory_extraction_jobs VALUES(?,?,'done',1,0)",(mid,source['source_hash']))
            db.execute("INSERT INTO digital_reflections VALUES(?,'current','r','silent')",(mid,))
            for i in range(65):
                cursor = db.execute("INSERT INTO memory_knowledge(scope,fingerprint,summary,kind,outcome,event_time,valid_until,state,supersedes_json,entities_json,relations_json,created_at) SELECT scope,?,summary,kind,outcome,event_time,valid_until,state,supersedes_json,entities_json,relations_json,created_at FROM memory_knowledge LIMIT 1",(f'count-{i}',))
                db.execute('INSERT INTO memory_knowledge_sources VALUES(?,?,?)',(cursor.lastrowid,mid,source['source_hash']))
    await asyncio.to_thread(add)
    stats = (await view.browse(current.projects, '完全不匹配的检索词xyz'))['stats']
    assert stats['knowledge_count'] == 66
    assert stats['by_kind']['preference'] == 66
    assert stats['processed_count'] == 1
    assert stats['pending_count'] == 1
    def expire():
        with index.connect() as db:
            db.execute("UPDATE memory_knowledge SET valid_until='2000-01-01T00:00:00+00:00' WHERE fingerprint='count-0'")
            db.execute("UPDATE memory_knowledge SET state='invalid' WHERE fingerprint='count-1'")
    await asyncio.to_thread(expire)
    stats = await asyncio.to_thread(view.library_stats,[project.id])
    assert stats['knowledge_count'] == 64
    assert (await asyncio.to_thread(view.library_stats,[]))['indexed_count'] == 0

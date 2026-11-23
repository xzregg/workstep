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
    companion = first['companion']
    assert companion['role'] == 'assistant'
    assert 'companion' not in second
    reply = await view.read(current.projects, companion['id'])
    assert reply['content'] == '已收到。'
    assert reply['companion']['id'] == f'memory:{mid}'
    await asyncio.to_thread(index.forget, mid)
    assert 'companion' not in (await view.read(current.projects, companion['id']))
    assert all(row['id'] != f'memory:{mid}' and not row['interpretation'] for row in (await view.browse(current.projects))['items'])
    with pytest.raises(LookupError):
        await view.read(current.projects, f'memory:{mid}')

async def test_visualization_api_does_not_block_and_rejects_project_actor(runtime, monkeypatch):
    import main
    from api.digital_person import router
    from services import memory_visualization as view
    from services.remote_access import ActorSnapshot, actor_context
    current, project, _ = runtime
    mid = await seed(current, project)
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
        pair_started = asyncio.Event()
        loop = asyncio.get_running_loop()
        original_pair = view._turn_companion
        def slow_pair(row):
            loop.call_soon_threadsafe(pair_started.set)
            time.sleep(.15)
            return original_pair(row)
        monkeypatch.setattr(view, '_turn_companion', slow_pair)
        pending = asyncio.create_task(client.get(f'/api/digital-person/memory/source/memory:{mid}'))
        await asyncio.wait_for(pair_started.wait(), 1)
        assert not pending.done()
        assert (await asyncio.wait_for(client.get('/health'),.1)).status_code == 200
        assert (await pending).json()['companion']['role'] == 'assistant'
        assert (await client.get('/api/digital-person/memory/source/bad')).status_code == 400
        with actor_context(ActorSnapshot(actor_id='u',user_name='u',device_id='d',device_name='d',source='remote_project',project_id=project.id,access_level='edit')):
            assert (await client.get('/api/digital-person/memory/view')).status_code == 403
            assert (await client.get('/api/digital-person/memory/view', params={'kind': 'preference', 'project_id': project.id, 'page': 2})).status_code == 403
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


async def test_browse_filters_before_limit_and_pages_ranked_preferences(runtime, tmp_path, monkeypatch):
    import main
    from api.digital_person import router
    current, project, _ = runtime
    mid = await seed(current, project)
    second = await asyncio.to_thread(current.projects.init_project, tmp_path / 'second')
    def add_second_source(_):
        session = current.chats.create_session(second.id)['id']
        create_completed_user(id='other-source', session=session, role='user', status='completed',
                              content='其次项目提供的依据', created_at=utc_now())
        memory.capture_session(session, 'local')
    await current.projects.run_db(second.id, add_second_source)

    def add():
        with index.connect() as db:
            evidence = db.execute('SELECT source_hash FROM memories WHERE id=?', (mid,)).fetchone()[0]
            for kind, count in [('preference', 121), ('event', 70)]:
                for i in range(count):
                    cursor = db.execute("""INSERT INTO memory_knowledge
                      (scope,fingerprint,summary,kind,outcome,state,supersedes_json,entities_json,relations_json,created_at)
                      VALUES ('local',?,?,?,'stated','active','[]','[]','[]','2026-11-16T00:00:00+00:00')""",
                      (f'{kind}-{i}', '最终结果', kind))
                    kid = cursor.lastrowid
                    db.execute('INSERT INTO memory_knowledge_sources VALUES(?,?,?)', (kid, mid, evidence))
                    db.execute('INSERT INTO memory_knowledge_search(rowid, terms) VALUES(?,?)',
                               (kid, ' '.join(index.terms('最终结果'))))
                    if kind == 'preference' and i % 3 == 0:
                        db.execute('INSERT INTO memory_entities VALUES(?,?,?,?)', (kid, 'object', '最终结果', '最终结果'))
            other = db.execute("SELECT id, source_hash FROM memories WHERE project_id=? AND source_message_id='other-source'",
                               (second.id,)).fetchone()
            cross = db.execute("SELECT id FROM memory_knowledge WHERE fingerprint='preference-0'").fetchone()[0]
            db.execute('INSERT INTO memory_knowledge_sources VALUES(?,?,?)', (cross, *other))
            return f'knowledge:{cross}'

    cross = await asyncio.to_thread(add)
    monkeypatch.setattr(main, 'digital_person_runtime', current)
    app = FastAPI()
    app.include_router(router)
    url = '/api/digital-person/memory/view'
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        initial = (await client.get(url)).json()
        assert initial['stats']['by_kind']['preference'] == 122
        assert sum(row['interpretation'] for row in initial['items']) == 50
        assert sum(row['kind'] == 'preference' for row in initial['items']) == 3
        assert {'id': project.id, 'name': project.name} in initial['projects']

        params = {'kind': 'preference', 'project_id': project.id, 'query': '最终结果'}
        results = []
        for page in range(1, 5):
            response = await client.get(url, params={**params, 'page': page})
            assert response.status_code == 200
            result = response.json()
            assert result['has_next'] is (page < 4)
            assert result['stats']['by_kind']['preference'] == 122
            assert all(row['kind'] == 'preference' and row['interpretation'] for row in result['items'])
            results.extend(row['id'] for row in result['items'])
        assert len(results) == len(set(results)) == 122
        scoped = (await client.get(url, params={**params, 'project_id': second.id})).json()
        assert [row['id'] for row in scoped['items']] == [cross]
        assert {s['project_id'] for s in scoped['items'][0]['sources']} == {project.id, second.id}
        assert (await client.get(url, params={'project_id': 'unregistered'})).json()['items'] == []
        assert (await client.get(url, params={'kind': 'unknown'})).status_code == 422
        monkeypatch.setattr(current.projects, 'iter_projects', lambda: iter((project,)))
        scoped = (await client.get(url, params=params)).json()
        assert scoped['stats']['by_kind']['preference'] == 121
        assert all(row['id'] != cross for row in scoped['items'])

from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime
from tests.test_memory_query import seed, extract_seed_knowledge


async def test_atlas_pages_verified_knowledge_in_order(runtime):
    from services import memory_atlas
    current, _, _ = await seed(runtime, ['部署完成', '迁移失败'])
    await extract_seed_knowledge()
    page = await memory_atlas.page(current.projects, 0, 1)
    second = await memory_atlas.page(current.projects, page['next_cursor'], 1)
    assert page['items'][0]['id'] != second['items'][0]['id']
    assert 0 <= page['items'][0]['importance'] <= 1
    star = second['items'][0]
    assert set(star) == {'id', 'kind', 'time', 'importance'}
    assert star['kind'] == 'fact'
    assert star['time']
    selected = await memory_atlas.page(current.projects, 0, 1, [int(star['id'].split(':')[1])])
    assert selected['items'] == [star]
    detail = await memory_atlas.detail(current.projects, int(star['id'].split(':')[1]))
    assert detail['summary'] and detail['sources']
    assert await memory_atlas.detail(current.projects, 0) is None


async def test_atlas_links_only_returned_stars_with_shared_evidence(runtime):
    from services import digital_person_memory_index as index
    from services import memory_atlas

    current, _, _ = await seed(runtime, ['部署完成', '迁移失败', '整理文档'])
    await extract_seed_knowledge()
    page = await memory_atlas.page(current.projects, 0, 3)
    first, second, unrelated = [star['id'] for star in page['items']]
    with index.connect() as db:
        db.executemany('INSERT INTO memory_entities VALUES(?,?,?,?)', [
            (int(star.split(':')[1]), 'object', '部署服务', '部署服务')
            for star in (first, second)
        ])
    page = await memory_atlas.page(current.projects, 0, 3)
    assert page['links'] == [{'from': second, 'to': first}]
    with index.connect() as db:
        db.execute('UPDATE memory_knowledge SET supersedes_json=? WHERE id=?',
                   (f'[{int(unrelated.split(":")[1])}]', int(first.split(':')[1])))
    page = await memory_atlas.page(current.projects, 0, 3)
    assert page['links'] == [{'from': unrelated, 'to': first}, {'from': second, 'to': first}]
    overview = await memory_atlas.page(current.projects, 0, 500)
    assert overview['items'] == page['items']
    assert overview['links'] == []
    detail = await memory_atlas.detail(current.projects, int(first.split(':')[1]))
    assert detail['links'] == page['links']
    isolated = await memory_atlas.page(current.projects, 0, 3, [int(unrelated.split(':')[1])])
    assert isolated['links'] == []


async def test_atlas_overview_caps_at_500_without_building_relationships(runtime, monkeypatch):
    from services import digital_person_memory_index as index
    from services import memory_atlas

    current, _, _ = await seed(runtime, ['部署完成'])
    await extract_seed_knowledge()
    with index.connect() as db:
        first = db.execute('SELECT id FROM memory_knowledge').fetchone()[0]
        db.executemany("""INSERT INTO memory_knowledge
            (scope,fingerprint,summary,kind,outcome,event_time,valid_until,state,supersedes_json,entities_json,relations_json,created_at)
            SELECT scope,?,summary,kind,outcome,event_time,valid_until,state,supersedes_json,entities_json,relations_json,created_at
            FROM memory_knowledge WHERE id=?""", [(f'fixture-{i}', first) for i in range(500)])
        db.execute("""INSERT INTO memory_knowledge_sources
            SELECT k.id,s.memory_id,s.source_hash FROM memory_knowledge k
            JOIN memory_knowledge_sources s ON s.knowledge_id=? WHERE k.id!=?""", (first, first))

    def unexpected_links(*args):
        raise AssertionError('The overview must not build the relationship graph')

    monkeypatch.setattr(memory_atlas, '_links', unexpected_links)
    page = await memory_atlas.page(current.projects, 0, 500)
    assert len(page['items']) == 500
    assert all(set(star) == {'id', 'kind', 'time', 'importance'} for star in page['items'])
    assert page['links'] == []
    assert page['next_cursor'] == first + 1


async def test_atlas_routes_keep_host_scope_and_async_access(runtime, monkeypatch):
    import asyncio
    import threading

    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from api import digital_person
    from services import memory_atlas
    from services.remote_access import ActorSnapshot, actor_context

    current, project, _ = await seed(runtime, ['当前记忆'])
    await extract_seed_knowledge()
    monkeypatch.setattr(digital_person, 'runtime', lambda: current)
    app = FastAPI()
    app.include_router(digital_person.router)
    entered, release = threading.Event(), threading.Event()
    markers = memory_atlas._markers

    def slow_markers(*args):
        entered.set()
        assert release.wait(3)
        return markers(*args)

    monkeypatch.setattr(memory_atlas, '_markers', slow_markers)
    path = '/api/digital-person/memory/atlas'
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        pending = asyncio.create_task(client.get(path))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            assert (await asyncio.wait_for(client.get('/openapi.json'), .5)).status_code == 200
        finally:
            release.set()
        response = await pending
        assert response.status_code == 200
        marker = response.json()['items'][0]
        knowledge_id = marker['id'].split(':')[1]
        picked = await client.get(path, params={'ids': knowledge_id})
        assert picked.status_code == 200 and picked.json()['items'] == [marker]
        assert (await client.get(path, params={'ids': 2**63})).status_code == 422
        assert (await client.get(path, params={'limit': 500})).status_code == 200
        assert (await client.get(path, params={'limit': 501})).status_code == 422
        detail = await client.get(f'{path}/{knowledge_id}')
        assert detail.status_code == 200 and detail.json()['sources'][0]['project_name'] == project.name
        actor = ActorSnapshot(actor_id='u', user_name='u', device_id='d', device_name='d',
                              source='remote_project', project_id=project.id, access_level='edit')
        with actor_context(actor):
            assert (await client.get(path)).status_code == 403
            assert (await client.get(f'{path}/{knowledge_id}')).status_code == 403

from tests.test_digital_person_runtime import chat_module, runtime


async def test_delegation_lists_group_execution_sessions_before_pagination(runtime, monkeypatch):
    import main
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from api.digital_person import router
    from models.chat_session import ChatMessage
    from models.fields import utc_now

    current, home, _ = runtime
    records = [
        {'id': 'old', 'project_id': 'p', 'session_id': 'same', 'origin_session_id': 'main',
         'title': 'Original', 'instruction': 'work', 'status': 'completed',
         'followup_state': 'continued', 'created_at': '2026-11-23T01:00:00'},
        {'id': 'other', 'project_id': 'p', 'session_id': 'other', 'origin_session_id': 'main',
         'title': 'Other', 'instruction': 'work', 'status': 'completed',
         'created_at': '2026-11-23T02:00:00'},
        {'id': 'latest', 'project_id': 'p', 'session_id': 'same', 'origin_session_id': 'main',
         'title': 'Latest', 'instruction': 'verify', 'status': 'running',
         'followup_state': 'pending', 'created_at': '2026-11-23T03:00:00'},
        {'id': 'cross-project', 'project_id': 'q', 'session_id': 'same', 'origin_session_id': 'main',
         'title': 'Separate', 'instruction': 'work', 'status': 'completed',
         'created_at': '2026-11-23T04:00:00'},
    ]
    def create(_):
        sessions = {key: current.chats.create_session(home.id, title=key)['id'] for key in ('same', 'other')}
        for row in records:
            row['message_id'] = row['id'] + '-result'
            if row['project_id'] != 'p':
                continue
            row.update(project_id=home.id, session_id=sessions[row['session_id']])
            ChatMessage.create(id=row['message_id'], session=row['session_id'], role='assistant',
                               content='', status=row['status'], created_at=utc_now())
    await current.projects.run_db(home.id, create)
    await current.mutate(lambda state: state.update(delegations=records))
    monkeypatch.setattr(main, 'digital_person_runtime', current)
    app = FastAPI()
    app.include_router(router)
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        pages = [(await client.get('/api/digital-person/activity/records',
                                  params={'delegation_offset': i, 'limit': 1})).json() for i in range(4)]
    assert [page['delegation_total'] for page in pages] == [3] * 4
    assert [row['id'] for page in pages for row in page['delegations']] == ['cross-project', 'old', 'other']
    assert pages[1]['delegations'][0]['execution_id'] == 'latest'
    assert pages[1]['delegations'][0]['title'] == 'Latest'
    assert pages[1]['delegations'][0]['status'] == 'running'
    listing = await current.list_delegations()
    assert [row['id'] for row in listing['items']] == ['cross-project', 'old', 'other']
    assert len((await current.state())['delegations']) == 3
    assert len((await current.state())['delegation_executions']) == 1
    detail = await current.list_delegations(delegation_id='old')
    assert detail['items'][0]['id'] == 'old'
    assert detail['items'][0]['execution_id'] == 'latest'
    assert [row['execution_id'] for row in detail['items'][0]['executions']] == ['old', 'latest']
    assert (await current.list_delegations(delegation_id='latest'))['items'][0]['id'] == 'old'


async def test_conversation_projects_only_latest_attempt_per_execution_session(runtime, monkeypatch):
    current, home, _ = runtime
    records = [
        {'id': 'old', 'project_id': home.id, 'session_id': 'same', 'message_id': 'old-result',
         'origin_session_id': 'main', 'instruction': 'old work', 'status': 'completed',
         'followup_state': 'completed', 'created_at': '2026-11-23T01:00:00'},
        {'id': 'latest', 'project_id': home.id, 'session_id': 'same', 'message_id': 'new-result',
         'origin_session_id': 'main', 'instruction': 'new work', 'status': 'running',
         'followup_state': 'pending', 'created_at': '2026-11-23T02:00:00'},
    ]
    async def read(items):
        return items
    monkeypatch.setattr(current.delegation_management, 'read', read)
    result = await current.delegation_management.for_conversation('main', {'delegations': records})
    assert [row['id'] for row in result] == ['latest']


async def test_archived_execution_projects_to_delegation_and_restores(runtime, monkeypatch):
    import main
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from api.digital_person import router
    from models.chat_session import ChatMessage, ChatSession

    from models.fields import utc_now

    current, home, _ = runtime
    def create(_):
        sid = current.chats.create_session(home.id, title='Archived work')['id']
        ChatMessage.create(id='archive-result', session=sid, role='assistant',
                           content='Saved result', status='completed', created_at=utc_now())
        ChatSession.update(archived=True).where(ChatSession.id == sid).execute()
        return sid
    sid = await current.projects.run_db(home.id, create)
    await current.mutate(lambda state: state.update(delegations=[{
        'id': 'archive-task', 'project_id': home.id, 'session_id': sid,
        'message_id': 'archive-result', 'origin_session_id': 'main',
        'instruction': 'work', 'status': 'completed', 'followup_state': 'completed',
    }]))
    monkeypatch.setattr(main, 'digital_person_runtime', current)
    app = FastAPI()
    app.include_router(router)
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        for archived in (True, False):
            await current.projects.run_db(home.id, lambda _: ChatSession.update(
                archived=archived).where(ChatSession.id == sid).execute())
            records = (await client.get('/api/digital-person/activity/records')).json()
            item = records['delegations'][0]
            assert item['archived'] is archived
            assert item['status'] == 'completed'
            listing = (await client.get('/api/digital-person/delegations')).json()
            assert listing['items'][0]['archived'] is archived
            detail = (await client.get('/api/digital-person/delegations',
                                       params={'delegation_id': 'archive-task'})).json()
            assert detail['items'][0]['archived'] is archived
            assert detail['items'][0]['result'] == 'Saved result'

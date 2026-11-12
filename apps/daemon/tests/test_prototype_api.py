import asyncio
import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
import main
from api.prototype import router
from api.fs import router as fs_router
from services.remote_access import ActorSnapshot, actor_context
from services.prototype_workspace import PrototypeWorkspace


@pytest.fixture
async def editor(tmp_path, monkeypatch, preview_directory):
    root = tmp_path / 'project'
    root.mkdir()
    (root / 'index.html').write_text('<button>First</button><button>Second</button>')
    (root / 'other.html').write_text('<p>Other</p>')
    project = SimpleNamespace(id='p', path=root, workstep_dir=root / '.workstep')
    monkeypatch.setattr(main, 'project_manager', SimpleNamespace(get_project_by_id=lambda pid: project if pid == 'p' else None))
    app = FastAPI()
    app.include_router(router)
    app.include_router(fs_router)
    @app.get('/health')
    async def health():
        return {'ok': True}
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        with actor_context(ActorSnapshot('local','Tester','d','Device','local')):
            yield client, root


async def test_open_preview_edit_and_sandbox(editor):
    client, root = editor
    response = await client.post('/api/prototype/open', json={'project_id':'p','path':'index.html'})
    assert response.status_code == 200, response.text
    work = response.json()['id']
    doc = (await client.get(f'/api/prototype/{work}/document', params={'project_id':'p','path':'index.html'})).json()
    grant = doc['html_preview']
    preview = await client.get(f"/api/fs/html-resource/p/{grant['token']}/{grant['entry']}")
    assert preview.status_code == 200
    assert 'workstep-prototype' in preview.text and 'data-ws-node="n2"' in preview.text
    assert 'allow-same-origin' not in preview.headers['content-security-policy']
    saved = await client.post(f'/api/prototype/{work}/edit?project_id=p', json={
        'path':'index.html','node_id':'n2','operation':'text','values':{'text':'Changed'},'version':doc['version']})
    assert saved.status_code == 200, saved.text
    assert (root / 'index.html').read_text() == '<button>First</button><button>Changed</button>'


async def test_project_read_and_cross_project_cannot_edit(editor):
    client, _ = editor
    for project_id, level in [('p','read'),('other','edit')]:
        with actor_context(ActorSnapshot('u','User','d','Device','remote',project_id=project_id,access_level=level)):
            response = await client.post('/api/prototype/open',json={'project_id':'p','path':'index.html'})
            assert response.status_code == 403


async def test_slow_disk_does_not_block_health(editor, monkeypatch):
    client, _ = editor
    original = PrototypeWorkspace.open.__func__
    def slow(cls, *args, **kwargs):
        time.sleep(.15)
        return original(cls, *args, **kwargs)
    monkeypatch.setattr(PrototypeWorkspace, 'open', classmethod(slow))
    request = asyncio.create_task(client.post('/api/prototype/open', json={'project_id':'p','path':'index.html'}))
    await asyncio.sleep(.02)
    start = time.monotonic()
    assert (await client.get('/health')).status_code == 200
    assert time.monotonic() - start < .08
    assert (await request).status_code == 200


async def test_gateway_editor_routes_are_project_scoped_and_edit_only():
    from workstep_gateway_protocol.project_scope import project_http_route_allowed
    workspace_id = 'a' * 32
    for method, suffix, extra in [('POST','open',[]), ('GET',workspace_id,[]),
            ('GET',workspace_id+'/document',[('path','index.html')]),
            ('GET',workspace_id+'/diff',[('revision','pending')]),
            ('POST',workspace_id+'/chat',[]), ('POST',workspace_id+'/action/clean_history',[])]:
        path = '/api/prototype/' + suffix
        query = [('project_id','p'),*extra]
        assert project_http_route_allowed(method,path,query,'p',access_level='edit')
        assert not project_http_route_allowed(method,path,query,'p',access_level='read')
        assert not project_http_route_allowed(method,path,query,'other',access_level='edit')


def test_prototype_websocket_requires_edit_scope_and_explicit_session():
    from streaming.ws import WsSubscription, _make_subscription_predicate
    event = {'project_id':'p','channel':'prototype','session_id':'s','type':'RUN_STARTED'}
    sub = WsSubscription(project_id='p',prototype_edit=True,active=True,session_ids={'s'})
    predicate = _make_subscription_predicate(sub)
    assert predicate(event)
    assert not predicate({**event,'project_id':'other'})
    assert not predicate({**event,'session_id':'other'})
    sub.prototype_edit = False
    assert not predicate(event)


async def test_external_project_data_copy_keeps_original_preview_boundary(editor, monkeypatch):
    from api import fs_paths
    client, root = editor
    main.project_manager.get_project_by_id('p').workstep_dir = root.parent / 'external-data'
    monkeypatch.setattr(fs_paths,'_file_access_root',lambda:root.resolve())
    opened=await client.post('/api/prototype/open',json={'project_id':'p','path':'index.html'})
    assert opened.status_code==200,opened.text
    work=opened.json()['id']
    for editing in ['true','false']:
        response=await client.get(f'/api/prototype/{work}/document',params={'project_id':'p','path':'index.html','editing':editing})
        grant=response.json()['html_preview']
        preview=await client.get(f"/api/fs/html-resource/p/{grant['token']}/{grant['entry']}")
        assert preview.status_code==200,preview.text
        assert ('workstep-prototype' in preview.text)==(editing=='true')
        if editing=='true':
            assert f"script-src 'nonce-{grant['token']}'" in preview.text


async def test_upload_relative_path_opens_own_registered_document_after_parent(editor):
    client, root = editor
    parent = await client.post('/api/prototype/open', json={'project_id':'p','path':'index.html'})
    assert parent.status_code == 200, parent.text
    relative = '.workstep/uploads/digital-person-prototype/human-brain.html'
    entry = root / relative
    entry.parent.mkdir(parents=True)
    entry.write_text('<h1>Brain</h1>')
    opened = await client.post('/api/prototype/open', json={'project_id':'p','path':relative})
    assert opened.status_code == 200, opened.text
    work = opened.json()
    assert work['id'] != parent.json()['id']
    assert work['path'] == 'human-brain.html'
    assert work['path'] in [doc['path'] for doc in work['documents']]
    params = {'project_id':'p','path':work['path']}
    document = await client.get(f"/api/prototype/{work['id']}/document", params=params)
    assert document.status_code == 200, document.text
    grant = document.json()['html_preview']
    preview = await client.get(f"/api/fs/html-resource/p/{grant['token']}/{grant['entry']}")
    assert preview.status_code == 200, preview.text
    assert 'Brain' in preview.text
    reopened = await client.post('/api/prototype/open', json={'project_id':'p','path':relative})
    assert reopened.json()['id'] == work['id']
    assert reopened.json()['documents'] == work['documents']

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
        assert ('data-ws-editor-overlay' in preview.text)==(editing=='true')
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


async def test_dependency_scan_is_off_loop_and_ignores_unrelated_large_files(editor, monkeypatch):
    import services.prototype_workspace as module
    client, root = editor
    (root / 'unrelated.json').write_bytes(b'x' * 2000)
    (root / 'index.html').write_text('<img src="used.svg"><button>Demo</button>')
    (root / 'used.svg').write_text('<svg/>')
    monkeypatch.setattr(module, 'MAX_FILE', 1000)
    collect = module.collect_resources
    def slow(*args, **kwargs):
        time.sleep(.15)
        return collect(*args, **kwargs)
    monkeypatch.setattr(module, 'collect_resources', slow)
    request = asyncio.create_task(client.post('/api/prototype/open', json={'project_id':'p','path':'index.html'}))
    await asyncio.sleep(.02)
    start = time.monotonic()
    assert (await client.get('/health')).status_code == 200
    assert time.monotonic() - start < .08
    response = await request
    assert response.status_code == 200, response.text
    work = response.json()
    assert set(work['files']) == {'index.html', 'other.html', 'used.svg'}
    document = await client.get(f"/api/prototype/{work['id']}/document", params={'project_id':'p','path':work['path']})
    grant = document.json()['html_preview']
    image = await client.get(f"/api/fs/html-resource/p/{grant['token']}/used.svg")
    assert image.status_code == 200, image.text


async def test_open_new_html_recovers_workspace_with_removed_source_directory(editor):
    client, root = editor
    old = root / 'old/page.html'
    old.parent.mkdir()
    old.write_text('<p>Old</p>')
    first = await client.post('/api/prototype/open', json={'project_id':'p','path':'index.html'})
    first_id = first.json()['id']
    await client.post('/api/prototype/open', json={'project_id':'p','path':'old/page.html'})
    old.unlink()
    old.parent.rmdir()
    sample = root / 'tmp/prototype-editor-sample/index.html'
    sample.parent.mkdir(parents=True)
    sample.write_text('<h1>Sample</h1>')
    opened = await client.post('/api/prototype/open', json={'project_id':'p','path':str(sample)})
    assert opened.status_code == 200, opened.text
    assert opened.json()['id'] == first_id
    document = await client.get(f'/api/prototype/{first_id}/document', params={'project_id':'p','path':opened.json()['path']})
    assert document.status_code == 200, document.text
    grant = document.json()['html_preview']
    preview = await client.get(f"/api/fs/html-resource/p/{grant['token']}/{grant['entry']}")
    assert preview.status_code == 200, preview.text
    assert 'Sample' in preview.text
    assert (await client.post('/api/prototype/open', json={'project_id':'p','path':'not-found.html'})).status_code == 404


async def test_stale_selection_is_rejected_off_loop_before_starting_engine(editor, monkeypatch):
    import agent_assistants.prototype as module
    from types import SimpleNamespace
    client, root = editor
    opened = (await client.post('/api/prototype/open', json={'project_id':'p','path':'index.html'})).json()
    monkeypatch.setattr(main, 'prototype_module', SimpleNamespace())
    original = module.selection_context
    def slow(*args):
        time.sleep(.15)
        return original(*args)
    monkeypatch.setattr(module, 'selection_context', slow)
    request = asyncio.create_task(client.post(f"/api/prototype/{opened['id']}/chat?project_id=p", headers={'Idempotency-Key':'stale'}, json={
        'path':'index.html','content':'改成9','selection':{'node_id':'n1','version':'old-version','tag':'p','text':'08'},
    }))
    await asyncio.sleep(.02)
    start = time.monotonic()
    assert (await client.get('/health')).status_code == 200
    assert time.monotonic() - start < .08
    response = await request
    assert response.status_code == 409, response.text
    assert 'reselect' in response.json()['detail']


async def test_history_file_patches_and_times_keep_health_responsive(editor, monkeypatch):
    client, _ = editor
    opened = (await client.post('/api/prototype/open',json={'project_id':'p','path':'index.html'})).json()
    document = (await client.get(f"/api/prototype/{opened['id']}/document",params={'project_id':'p','path':'index.html'})).json()
    saved = await client.post(f"/api/prototype/{opened['id']}/edit?project_id=p",json={
        'path':'index.html','node_id':'n1','operation':'text','values':{'text':'Updated'},'version':document['version'],
    })
    assert saved.status_code == 200, saved.text
    revision = saved.json()['history'][-1]
    assert isinstance(revision['time'],(int,float))
    original = PrototypeWorkspace.diff
    def slow(self,*args):
        time.sleep(.15)
        return original(self,*args)
    monkeypatch.setattr(PrototypeWorkspace,'diff',slow)
    request = asyncio.create_task(client.get(f"/api/prototype/{opened['id']}/diff",params={'project_id':'p','revision':revision['id']}))
    await asyncio.sleep(.02)
    start = time.monotonic()
    assert (await client.get('/health')).status_code == 200
    assert time.monotonic() - start < .08
    response = await request
    assert response.status_code == 200, response.text
    file = response.json()['files'][0]
    assert file['path'] == 'index.html'
    assert '-<button>First</button><button>Second</button>\n' in file['patch']
    assert '+<button>Updated</button><button>Second</button>\n' in file['patch']


async def test_prototype_navigation_reports_actual_resource_in_browse_and_select(editor):
    client,root=editor
    (root/'index.html').write_text('<a href="other.html">Next</a>')
    opened=(await client.post('/api/prototype/open',json={'project_id':'p','path':'index.html'})).json()
    for editing in (False,True):
        doc=(await client.get(f"/api/prototype/{opened['id']}/document",params={'project_id':'p','path':'index.html','editing':editing})).json()
        grant=doc['html_preview']
        target=await client.get(f"/api/fs/html-resource/p/{grant['token']}/other.html")
        assert target.status_code==200
        assert 'workstep-prototype-navigation' in target.text
        assert '"path": "other.html"' in target.text
        assert grant['token'] in target.text
        if editing:
            assert f"frame-src http://test/api/fs/html-resource/p/{grant['token']}/" in target.text


async def test_local_iframe_editor_uses_scoped_frames_and_per_file_metadata(editor):
    client,root=editor
    (root/'index.html').write_text('<meta http-equiv="refresh" content="0;url=https://external.invalid"><nav>Menu</nav><iframe name="content" src="other.html"></iframe>')
    opened=(await client.post('/api/prototype/open',json={'project_id':'p','path':'index.html'})).json()
    doc=(await client.get(f"/api/prototype/{opened['id']}/document",params={'project_id':'p','path':'index.html'})).json()
    grant=doc['html_preview']
    parent=await client.get(f"/api/fs/html-resource/p/{grant['token']}/index.html")
    child=await client.get(f"/api/fs/html-resource/p/{grant['token']}/other.html")
    assert parent.status_code==child.status_code==200
    assert "frame-src 'none'" not in parent.text
    assert 'workstep-prototype-frames' in child.text
    assert 'data-ws-disabled-refresh' in parent.text
    assert 'http-equiv="refresh"' in (root/'index.html').read_text(), 'preview restriction never rewrites original HTML'
    assert '"path": "other.html"' in child.text
    assert "frame-ancestors 'self'" not in child.headers['content-security-policy']
    assert 'allow-same-origin' not in child.headers['content-security-policy']
    assert f'/api/fs/html-resource/p/{grant["token"]}/' in parent.text
    child_doc=(await client.get(f"/api/prototype/{opened['id']}/document",params={'project_id':'p','path':'other.html'})).json()
    outer_before=(root/'index.html').read_text()
    response=await client.post(f"/api/prototype/{opened['id']}/edit?project_id=p",json={'path':'other.html','node_id':'n1','operation':'text','values':{'text':'Child saved'},'version':child_doc['version']})
    assert response.status_code==200,response.text
    assert (root/'other.html').read_text()=='<p>Child saved</p>'
    assert (root/'index.html').read_text()==outer_before
    undone=await client.post(f"/api/prototype/{opened['id']}/action/undo?project_id=p")
    assert undone.status_code==200
    assert (root/'other.html').read_text()=='<p>Other</p>'
    assert (root/'index.html').read_text()==outer_before


async def test_react_shell_uses_inspection_without_direct_source_edits(editor):
    client,root=editor
    source='<div id="root"></div><script>document.getElementById("root").innerHTML="<p>Runtime UI</p>"</script>'
    (root/'index.html').write_text(source)
    work=(await client.post('/api/prototype/open',json={'project_id':'p','path':'index.html'})).json()
    doc=(await client.get(f"/api/prototype/{work['id']}/document",params={'project_id':'p','path':'index.html'})).json()
    assert doc['inspection_only'] is True
    grant=doc['html_preview']
    preview=await client.get(f"/api/fs/html-resource/p/{grant['token']}/index.html")
    assert "script-src 'nonce-" not in preview.text
    assert 'const inspectionOnly = typeof true' in preview.text
    rejected=await client.post(f"/api/prototype/{work['id']}/edit?project_id=p",json={'path':'index.html','node_id':'n1','operation':'text','values':{'text':'Unsafe DOM snapshot'},'version':doc['version']})
    assert rejected.status_code==422
    assert (root/'index.html').read_text()==source

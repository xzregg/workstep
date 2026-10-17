"""The preview is a read-only capability, never a browser login session."""

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

import api.fs as fs_api
import main
from api.desktop_security import DesktopSecurityMiddleware


@pytest.fixture
async def preview_site(tmp_path, monkeypatch):
    root = tmp_path / 'project'
    site = root / 'prototype'
    site.mkdir(parents=True)
    (site / 'index.html').write_text('<button onclick="this.textContent=\'OK\'">Run</button><script src="app.js"></script>')
    (site / 'app.js').write_text('document.body.dataset.loaded="yes"')
    (site / 'data.json').write_text('{"value":42}')
    (site / '.env').write_text('SECRET=private')
    (root / 'private.json').write_text('{"secret":true}')
    (site / 'escape.json').symlink_to(root / 'private.json')
    project = SimpleNamespace(id='project-1', path=root, workstep_dir=root / '.workstep')
    monkeypatch.setattr(main, 'project_manager', SimpleNamespace(get_project_by_id=lambda value: project if value == project.id else None))
    monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME', '1')
    monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN', 'test-desktop-token')
    app = FastAPI()
    app.include_router(fs_api.router)
    app.add_middleware(DesktopSecurityMiddleware)
    @app.get('/api/health')
    async def health():
        return {'ok': True}
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://preview.test') as client:
        yield client, site


async def test_preview_issues_scoped_resource_capability_without_exposing_login(preview_site):
    client, _ = preview_site
    response = await client.get('/api/fs/preview', params={'project_id': 'project-1', 'path': 'prototype/index.html'}, headers={'x-workstep-desktop-token': 'test-desktop-token'})
    assert response.status_code == 200, response.text
    grant = response.json()['html_preview']
    base = f"/api/fs/html-resource/project-1/{grant['token']}/"
    document = await client.get(base + grant['entry'])
    assert document.status_code == 200, document.text
    policy = document.headers['content-security-policy']
    assert 'sandbox allow-scripts' in policy
    assert 'allow-same-origin' not in policy
    assert "form-action 'none'" in policy
    assert base in policy
    assert 'test-desktop-token' not in document.text
    for filename in ('app.js', 'data.json'):
        resource = await client.get(base + filename, headers={'Origin': 'null'})
        assert resource.status_code == 200, resource.text
        assert resource.headers['access-control-allow-origin'] == 'null'
        assert resource.headers['access-control-allow-credentials'] == 'true'
    for filename in ('.env', 'escape.json', '%2e%2e/private.json', '%2fprivate.json'):
        assert (await client.get(base + filename)).status_code in (403, 404)
    assert (await client.post(base + 'data.json', json={})).status_code in (401, 405)
    assert (await client.get(base.replace('/project-1/', '/other-project/') + 'data.json')).status_code in (403, 404)
    assert (await client.get(base.replace(grant['token'], 'invalid-token') + 'data.json')).status_code == 404
    assert (await client.get('/api/fs/preview', params={'project_id': 'project-1', 'path': 'prototype/index.html'})).status_code == 401


async def test_direct_html_and_upload_responses_enforce_sandbox(preview_site):
    import base64
    client, _ = preview_site
    for path in ('/api/fs/project-raw/project-1/prototype/index.html', '/api/fs/file?path=prototype/index.html&project_id=project-1'):
        response = await client.get(path, headers={'x-workstep-desktop-token': 'test-desktop-token'})
        assert response.status_code == 200
        assert 'sandbox allow-scripts' in response.headers['content-security-policy']
        assert "connect-src 'none'" in response.headers['content-security-policy']
    for filename, media, content in (
        ('prototype.html', 'text/html', '<script>parent.document.title="attack"</script>'),
        ('prototype.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>parent.document.title="attack"</script></svg>'),
    ):
        headers = {'x-workstep-desktop-token': 'test-desktop-token'}
        uploaded = await client.post('/api/fs/upload/file?project_id=project-1', headers=headers, json={
            'filename': filename, 'data_url': f'data:{media};base64,' + base64.b64encode(content.encode()).decode(),
        })
        assert uploaded.status_code == 200, uploaded.text
        served = await client.get('/api/fs/serve/' + uploaded.json()['filename'] + '?project_id=project-1', headers=headers)
        assert served.status_code == 200, served.text
        assert served.text == content
        assert 'sandbox allow-scripts' in served.headers['content-security-policy']
        assert 'allow-same-origin' not in served.headers['content-security-policy']


async def test_expired_resource_ticket_cannot_read_files(preview_site, monkeypatch):
    import services.html_preview as preview
    client, _ = preview_site
    monkeypatch.setattr(preview, 'TTL_SECONDS', -1)
    response = await client.get('/api/fs/preview', params={'project_id': 'project-1', 'path': 'prototype/index.html'}, headers={'x-workstep-desktop-token': 'test-desktop-token'})
    ticket = response.json()['html_preview']['token']
    assert (await client.get(f'/api/fs/html-resource/project-1/{ticket}/data.json')).status_code == 404


@pytest.mark.parametrize('source', ['preview', 'resource'])
async def test_preview_slow_disk_keeps_health_responsive(preview_site, monkeypatch, source):
    import threading
    client, _ = preview_site
    entered, release = threading.Event(), threading.Event()
    import services.html_preview as preview_service
    headers = {'x-workstep-desktop-token': 'test-desktop-token'}
    params = {'project_id': 'project-1', 'path': 'prototype/index.html'}
    path = '/api/fs/preview'
    owner, name = fs_api, '_resolve_project_file'
    if source == 'resource':
        ticket = (await client.get(path, params=params, headers=headers)).json()['html_preview']['token']
        path, params = f'/api/fs/html-resource/project-1/{ticket}/data.json', {}
        owner, name = preview_service, 'resource_file'
    original = getattr(owner, name)
    def slow(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        return original(*args, **kwargs)
    monkeypatch.setattr(owner, name, slow)
    pending = asyncio.create_task(client.get(path, params=params, headers=headers))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        result = await asyncio.wait_for(client.get('/api/health', headers=headers), .3)
        assert result.status_code == 200
        assert not pending.done()
    finally:
        release.set()
        await pending


@pytest.mark.parametrize('transport_mode', ['local', 'remote', 'gateway', 'gateway-remote'])
async def test_real_chromium_interaction_and_identity_isolation(preview_site, transport_mode, tmp_path, monkeypatch):
    """Opt-in browser regression; starts only an ephemeral fixture HTTP server."""
    import os
    import socket
    from pathlib import Path
    from fastapi.responses import HTMLResponse
    import uvicorn
    if not os.environ.get('WORKSTEP_PLAYWRIGHT_MODULE') or not os.environ.get('WORKSTEP_CHROMIUM'):
        pytest.skip('Set WORKSTEP_PLAYWRIGHT_MODULE and WORKSTEP_CHROMIUM for real-browser validation')
    client, site = preview_site
    (site / 'index.html').write_text('''<!doctype html>
<link rel="stylesheet" href="theme.css"><script type="module" src="app.mjs"></script>
<button id="run" onclick="this.textContent='OK'">Run</button><p id="styled">Styled</p>
<style>#styled { color: light-dark(rgb(1, 2, 3), rgb(4, 5, 6)); }</style>
<img src="image.svg"><a id="anchor" href="#section">Section</a><h2 id="section">Section</h2>
<iframe srcdoc="<button onclick=&quot;this.textContent='Nested OK'&quot;>Nested</button>"></iframe>
<script>
try { parent.document.title='compromised'; document.body.dataset.parent='accessible'; } catch { document.body.dataset.parent='denied'; }
try { localStorage.getItem('admin-secret'); document.body.dataset.storage='accessible'; } catch { document.body.dataset.storage='denied'; }
fetch('data.json').then(r=>r.json()).then(data=>document.body.dataset.ready=data.value);
const xhr=new XMLHttpRequest(); xhr.open('GET','data.json'); xhr.onload=()=>document.body.dataset.xhr=JSON.parse(xhr.responseText).value; xhr.send();
fetch('/api/admin/elevate',{method:'POST'}).catch(()=>{});
const attack=new XMLHttpRequest(); attack.open('POST','/api/admin/elevate'); attack.onerror=()=>{}; attack.send();
try { navigator.sendBeacon('/api/admin/elevate','attack'); } catch {}
const image=new Image(); image.src='/api/admin/read-secret';
</script>''')
    (site / 'theme.css').write_text('#styled { color: rgb(1, 2, 3) }')
    (site / 'app.mjs').write_text("import { ready } from './dep.mjs'; document.body.dataset.module=ready;")
    (site / 'dep.mjs').write_text("export const ready='yes';")
    (site / 'image.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')
    app = client._transport.app
    attempts = {'writes': 0, 'reads': 0}
    @app.get('/')
    def parent():
        return HTMLResponse('<!doctype html><title>WorkStep fixture</title>')
    @app.post('/api/admin/elevate')
    def elevate():
        attempts['writes'] += 1
        return {'ok': True}
    @app.get('/api/admin/read-secret')
    def read_secret():
        attempts['reads'] += 1
        return {'secret': 'private'}
    @app.get('/attempts')
    def count():
        return attempts
    preview = (await client.get('/api/fs/preview', params={'project_id': 'project-1', 'path': 'prototype/index.html'}, headers={'x-workstep-desktop-token': 'test-desktop-token'})).json()['html_preview']
    repository = Path(__file__).resolve().parents[3]
    prototypes = []
    for index, source in enumerate(('work/prototypes/provider-layout.html', 'work/prototypes/provider-layout-preview.html', 'plans/prototypes/desktop-sidebar.html', 'ui/prototypes/task-execution-analysis.html')):
        filename = f'previous-{index}.html'
        (site / filename).write_text((repository / source).read_text())
        prototypes.append(f"/api/fs/html-resource/project-1/{preview['token']}/{filename}")
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        port = listener.getsockname()[1]
        from tests.html_preview_transports import browser_transport
        from contextlib import AsyncExitStack
        stack = AsyncExitStack()
        transport = await stack.enter_async_context(browser_transport(app, transport_mode, f'http://127.0.0.1:{port}', tmp_path, monkeypatch))
        if transport.app is not app:
            transport.app.add_api_route('/attempts', count)
            transport.app.add_api_route('/api/admin/elevate', elevate, methods=['POST'])
            transport.app.add_api_route('/api/admin/read-secret', read_secret)
        response = await transport.client.get(transport.prefix + '/api/fs/preview', params={'project_id': transport.project_id, 'path': 'prototype/index.html'}, headers={'x-workstep-desktop-token': 'test-desktop-token'})
        assert response.status_code == 200, response.text
        preview = response.json()['html_preview']
        from urllib.parse import quote
        resource_root = transport.prefix + f"/api/fs/html-resource/{quote(transport.project_id, safe='')}/{preview['token']}/"
        prototypes = [resource_root + f'previous-{i}.html' for i in range(4)]
        server = uvicorn.Server(uvicorn.Config(transport.app, log_level='error', lifespan='off'))
        running = asyncio.create_task(server.serve(sockets=[listener]))
        try:
            async with asyncio.timeout(5):
                while not server.started:
                    await asyncio.sleep(.01)
            process = await asyncio.create_subprocess_exec('node', '--loader', str(repository / 'apps/web/scripts/test-loader.mjs'), str(Path(__file__).with_name('html_preview_browser.mjs')),
                f'http://127.0.0.1:{port}', resource_root + 'index.html', __import__('json').dumps(prototypes),
                __import__('json').dumps({'cookies': transport.cookies, 'prefix': transport.prefix, 'projectId': transport.project_id}),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            async with asyncio.timeout(20):
                stdout, stderr = await process.communicate()
            assert process.returncode == 0, stdout.decode() + stderr.decode()
            print(stdout.decode())
            if transport.revoke:
                async with AsyncClient(transport=ASGITransport(app=transport.app), base_url=f'http://127.0.0.1:{port}') as anonymous:
                    assert (await anonymous.get(resource_root + 'data.json', headers={'Origin': 'null'})).status_code == 200
                    assert (await anonymous.get('/api/admin/users')).status_code == 401
                    assert (await anonymous.get((resource_root + 'data.json').replace('/device-1/', '/other-device/'))).status_code == 401
                    await transport.revoke()
                    assert (await anonymous.get(resource_root + 'data.json', headers={'Origin': 'null'})).status_code == 401
        finally:
            server.should_exit = True
            await running
            await stack.aclose()

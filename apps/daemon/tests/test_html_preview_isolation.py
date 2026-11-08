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
async def preview_site(tmp_path, monkeypatch, preview_directory):
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


@pytest.mark.parametrize('extension', ['html', 'htm'])
async def test_html_preview_accepts_large_documents_up_to_resource_limit(preview_site, extension):
    from services.html_preview import MAX_RESOURCE_BYTES
    client, site = preview_site
    document = site / f'large.{extension}'
    content = '<!doctype html><p>Large diagram</p>'
    content += ' ' * (2548843 - len(content))
    document.write_text(content)
    headers = {'x-workstep-desktop-token': 'test-desktop-token'}
    params = {'project_id': 'project-1', 'path': f'prototype/{document.name}'}
    response = await client.get('/api/fs/preview', params=params, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()['content'] == content
    grant = response.json()['html_preview']
    resource = await client.get(f"/api/fs/html-resource/project-1/{grant['token']}/{grant['entry']}")
    assert resource.status_code == 200
    assert 'Large diagram' in resource.text
    assert 'sandbox allow-scripts' in resource.headers['content-security-policy']

    # The preview metadata and actual resource enforce the same upper bound.
    with document.open('r+b') as stream:
        stream.truncate(MAX_RESOURCE_BYTES)
    assert (await client.get('/api/fs/preview', params=params, headers=headers)).status_code == 200
    with document.open('r+b') as stream:
        stream.truncate(MAX_RESOURCE_BYTES + 1)
    assert (await client.get('/api/fs/preview', params=params, headers=headers)).status_code == 413


async def test_non_html_preview_keeps_one_mib_limit(preview_site):
    client, site = preview_site
    (site / 'large.txt').write_bytes(b'x' * (1024 * 1024 + 1))
    response = await client.get('/api/fs/preview',
        params={'project_id': 'project-1', 'path': 'prototype/large.txt'},
        headers={'x-workstep-desktop-token': 'test-desktop-token'})
    assert response.status_code == 413


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

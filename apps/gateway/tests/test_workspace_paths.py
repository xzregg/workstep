import pytest
from gateway.services.workspace_paths import rewrite_workspace_html

@pytest.mark.asyncio
async def test_html_assets_and_base_are_scoped_across_chunks():
    async def chunks():
        yield b'<html><head><script src="/ass'
        yield b'ets/main.js"></script></head><body></body></html>'
    result=b''.join([chunk async for chunk in rewrite_workspace_html(chunks(), '/workspace/one/')])
    assert b'<base href="/workspace/one/">' in result
    assert b'src="/workspace/one/assets/main.js?_workstep_asset=' in result


@pytest.mark.parametrize('path,accept,expected', [
    ('/chat', 'text/html', 303), ('/', '*/*', 303),
    ('/api/tasks', 'text/html', 502), ('/assets/app.js', '*/*', 502),
])
def test_workspace_connection_failure_recovers_document_only(tmp_path, monkeypatch, path, accept, expected):
    from fastapi.testclient import TestClient
    from gateway.app import create_app
    from gateway.config import GatewaySettings
    from gateway.services.errors import GatewayError
    async def failed(call):
        raise GatewayError('upstream_failed', 'Device data connection unavailable')
    monkeypatch.setattr('gateway.app.proxy_remote_request', failed)
    app = create_app(GatewaySettings(data_dir=tmp_path, public_origin='https://gateway.test'))
    with TestClient(app, base_url='https://gateway.test') as client:
        response = client.get('/workspace/device-1' + path, headers={'Accept': accept}, follow_redirects=False)
        assert response.status_code == expected
        if expected == 303:
            assert response.headers['location'] == '/?workspace_recovery=1'
            assert response.headers['cache-control'] == 'private, no-store'
        else:
            assert response.json()['error']['message'] == 'Device data connection unavailable'


@pytest.mark.asyncio
async def test_workspace_entry_versions_assets_to_escape_old_partial_cache():
    import re
    async def render(source):
        async def chunks(): yield source
        return b''.join([chunk async for chunk in rewrite_workspace_html(chunks(), '/workspace/device/')])
    source = b'<html><head><script src="/assets/app.js"></script><link href="/assets/app.css?v=1#theme"></head></html>'
    first = await render(source)
    assert re.search(rb'/assets/app.js\?_workstep_asset=[a-f0-9]{16}', first)
    assert b'app.css?v=1&amp;_workstep_asset=' in first
    assert b'#theme' in first
    assert first == await render(source)
    assert first != await render(source.replace(b'app.js', b'new.js'))


def test_workspace_static_and_error_responses_are_not_publicly_cached(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from fastapi.responses import Response
    from gateway.app import create_app
    from gateway.config import GatewaySettings
    async def asset(call):
        return Response('script', media_type='application/javascript', headers={'Cache-Control':'public,max-age=3600'})
    monkeypatch.setattr('gateway.app.proxy_remote_request', asset)
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path)), base_url='https://gateway.test') as client:
        response = client.get('/workspace/device/assets/app.js')
        assert response.status_code == 200
        assert response.headers['cache-control'] == 'private, no-store'

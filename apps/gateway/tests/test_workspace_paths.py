import pytest
from gateway.services.workspace_paths import rewrite_workspace_html

@pytest.mark.asyncio
async def test_html_assets_and_base_are_scoped_across_chunks():
    async def chunks():
        yield b'<html><head><script src="/ass'
        yield b'ets/main.js"></script></head><body></body></html>'
    result=b''.join([chunk async for chunk in rewrite_workspace_html(chunks(), '/workspace/one/')])
    assert b'<base href="/workspace/one/">' in result
    assert b'src="/workspace/one/assets/main.js"' in result


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
            assert response.headers['cache-control'] == 'no-store'
        else:
            assert response.json()['error']['message'] == 'Device data connection unavailable'

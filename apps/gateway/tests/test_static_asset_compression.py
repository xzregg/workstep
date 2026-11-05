import gzip

import pytest
from fastapi.testclient import TestClient
from starlette.responses import Response

from gateway.app import create_app
from gateway.config import GatewaySettings


@pytest.mark.parametrize('path', ['/assets/portal.js', '/workspace-assets/viewer.js', '/'])
@pytest.mark.parametrize('encoding,compressed', [('gzip', True), ('identity', False), ('gzip;q=0', False)])
def test_gateway_static_files_are_compressed_with_correct_negotiation(tmp_path, path, encoding, compressed):
    portal = tmp_path / 'portal'
    (portal / 'assets').mkdir(parents=True)
    viewer = tmp_path / 'viewer'
    viewer.mkdir()
    data = b'const script="complete";\n' * 10000
    (portal / 'assets/portal.js').write_bytes(data)
    (portal / 'index.html').write_bytes(data)
    (viewer / 'viewer.js').write_bytes(data)
    settings = GatewaySettings(data_dir=tmp_path / 'data', web_dist=portal, workspace_web_dist=viewer)
    with TestClient(create_app(settings), base_url='http://gateway.test') as client:
        response = client.get(path, headers={'Accept-Encoding':encoding})
        assert response.status_code == 200
        assert response.content == data
        assert response.headers.get('content-encoding') == ('gzip' if compressed else None)
        if compressed:
            assert 'Accept-Encoding' in response.headers['vary']
        ranged = client.get('/assets/portal.js', headers={'Accept-Encoding':'gzip', 'Range':'bytes=0-19'})
        assert ranged.status_code == 206
        assert ranged.content == data[:20]
        assert 'content-encoding' not in ranged.headers


def test_gateway_preserves_already_compressed_device_resources(tmp_path, monkeypatch):
    data = b'const device="ready";\n' * 1000
    compressed = gzip.compress(data)
    async def upstream(call):
        return Response(compressed, media_type='text/javascript', headers={'Content-Encoding':'gzip'})
    monkeypatch.setattr('gateway.app.proxy_remote_request', upstream)
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path)), base_url='https://gateway.test') as client:
        response = client.get('/workspace/device/assets/script.js', headers={'Accept-Encoding':'gzip'})
        assert response.headers['content-encoding'] == 'gzip'
        assert response.content == data, 'A single decompression must recover the complete resource'

import gzip

import httpx
import pytest
from fastapi import FastAPI
from starlette.responses import FileResponse, StreamingResponse

from api.static_asset_compression import StaticAssetCompressionMiddleware


@pytest.mark.asyncio
@pytest.mark.parametrize('path_url', ['/assets/script.js', '/static/script.js', '/landing/assets/script.js', '/', '/index.html'])
@pytest.mark.parametrize('accept,compressed', [('gzip', True), ('identity', False), ('gzip;q=0', False)])
async def test_static_script_compression_round_trips_and_preserves_range(tmp_path, accept, compressed, path_url):
    body = b'const script="complete";\n' * 40000
    path = tmp_path / 'script.js'
    path.write_bytes(body)
    app = FastAPI()
    app.add_middleware(StaticAssetCompressionMiddleware)
    @app.get('/assets/script.js')
    async def script():
        return FileResponse(path, media_type='text/javascript')
    if path_url != '/assets/script.js':
        app.add_api_route(path_url, script, methods=['GET'])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://local') as client:
        async with client.stream('GET', path_url, headers={'Accept-Encoding': accept}) as response:
            raw = b''.join([part async for part in response.aiter_raw()])
            if compressed:
                assert response.headers['content-encoding'] == 'gzip'
                assert 'Accept-Encoding' in response.headers['vary']
                assert len(raw) < len(body) // 2
                assert gzip.decompress(raw) == body
            else:
                assert 'content-encoding' not in response.headers
                assert raw == body
        ranged = await client.get('/assets/script.js', headers={'Accept-Encoding':'gzip', 'Range':'bytes=0-19'})
        assert ranged.status_code == 206
        assert 'content-encoding' not in ranged.headers
        assert ranged.content == body[:20]


@pytest.mark.asyncio
async def test_api_stream_is_delivered_without_gzip_buffering():
    app = FastAPI()
    app.add_middleware(StaticAssetCompressionMiddleware)
    @app.get('/api/events')
    async def events():
        async def chunks():
            yield b'data: hello\n\n'
        return StreamingResponse(chunks(), media_type='text/event-stream')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://local') as client:
        response = await client.get('/api/events', headers={'Accept-Encoding':'gzip'})
    assert 'content-encoding' not in response.headers
    assert response.content == b'data: hello\n\n'

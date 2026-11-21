import asyncio
import time
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from api import fs, fs_paths

pytestmark = pytest.mark.usefixtures("preview_directory")


@pytest.mark.asyncio
@pytest.mark.parametrize(('name', 'payload', 'kind', 'mime'), [
    ('dialogue.ts', 'export const message: string = "你好";\n'.encode(), 'text', 'text/plain'),
    ('dialogue.TS', b'/' * 4095 + '你'.encode() + b'\n', 'text', 'text/plain'),
    ('segment.ts', (b'\x47\x1f\xff\x10' + b'\xff' * 184) * 6000, 'video', 'video/mp2t'),
])
async def test_ts_preview_distinguishes_source_and_video(tmp_path, monkeypatch, name, payload, kind, mime):
    source = tmp_path / name
    source.write_bytes(payload)
    monkeypatch.setattr(fs_paths, '_project', lambda _: SimpleNamespace(path=tmp_path, workstep_dir=tmp_path / '.workstep'))
    app = FastAPI()
    app.include_router(fs.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        response = await client.get('/api/fs/preview', params={'path': name, 'project_id': 'p'})
    assert response.status_code == 200
    assert response.json() == {
        'type': kind, 'content_type': mime, 'content': payload.decode() if kind == 'text' else '',
        'file_size': len(payload), 'extension': source.suffix, 'relative_path': name,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(('name', 'kind', 'mime'), [
    ('intro.mp4', 'video', 'video/mp4'),
    ('月光替我回答-纯音乐试听.wav', 'audio', 'audio/x-wav'),
    ('song.mp3', 'audio', 'audio/mpeg'),
])
async def test_large_media_preview_is_metadata_and_raw_supports_ranges(tmp_path, monkeypatch, name, kind, mime):
    source = tmp_path / name
    with source.open('wb') as output:
        output.write(b'video-header')
        output.truncate(9842309)
    monkeypatch.setattr(fs_paths, '_project', lambda _: SimpleNamespace(path=tmp_path, workstep_dir=tmp_path / '.workstep'))
    app = FastAPI()
    app.include_router(fs.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        response = await client.get('/api/fs/preview', params={'path': name, 'project_id': 'p'})
        assert response.status_code == 200
        assert response.json() == {
            'type': kind, 'content_type': mime, 'content': '',
            'file_size': 9842309, 'extension': source.suffix, 'relative_path': name,
        }
        response = await client.get(f'/api/fs/project-raw/p/{name}', headers={'Range': 'bytes=0-11'})
        assert response.status_code == 206
        assert response.content == b'video-header'
        assert response.headers['content-type'] == mime
        assert response.headers['content-range'] == 'bytes 0-11/9842309'
        response = await client.get('/api/fs/preview', params={'path': '../outside.mp4', 'project_id': 'p'})
        assert response.status_code == 403
        (tmp_path / 'large.txt').write_bytes(b'x' * (1024 * 1024 + 1))
        response = await client.get('/api/fs/preview', params={'path': 'large.txt', 'project_id': 'p'})
        assert response.status_code == 413


@pytest.mark.asyncio
@pytest.mark.parametrize('name', ['intro.mp4', 'song.wav', 'dialogue.ts'])
async def test_slow_media_metadata_keeps_health_responsive(tmp_path, monkeypatch, name):
    source = tmp_path / name
    source.write_bytes(b'video')
    original_open = type(source).open

    def slow_open(path, *args, **kwargs):
        if path == source and args == ('rb',):
            time.sleep(.15)
        return original_open(path, *args, **kwargs)

    def slow_resolve(*args, **kwargs):
        if source.suffix != '.ts':
            time.sleep(.15)
        return source

    monkeypatch.setattr(type(source), 'open', slow_open)
    monkeypatch.setattr(fs, '_resolve_preview_file', slow_resolve)
    monkeypatch.setattr(fs, '_project_relative_path', lambda *args: name)
    app = FastAPI()
    app.include_router(fs.router)
    @app.get('/health')
    async def health():
        return {'ok': True}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        pending = asyncio.create_task(client.get('/api/fs/preview', params={'path': name}))
        await asyncio.sleep(.02)
        assert not pending.done()
        assert (await asyncio.wait_for(client.get('/health'), .05)).status_code == 200
        assert (await pending).status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize(('name', 'mime'), [('intro.mp4', 'video/mp4'), ('song.wav', 'audio/x-wav')])
async def test_shared_media_content_has_media_mime_and_range_support(tmp_path, monkeypatch, name, mime):
    from unittest.mock import AsyncMock
    from api import platform_share
    source = tmp_path / name
    source.write_bytes(b'video-header')
    monkeypatch.setattr(platform_share, '_share_scope', lambda _: {})
    monkeypatch.setattr(platform_share, '_share_artifact_path', AsyncMock(return_value=str(source)))
    app = FastAPI()
    app.include_router(platform_share.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        response = await client.get('/api/platform-share/artifacts/video/content', headers={'Range': 'bytes=0-4'})
        assert response.status_code == 206
        assert response.content == b'video'
        assert response.headers['content-type'] == mime

import asyncio
import time
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from api import fs, fs_paths


@pytest.mark.asyncio
async def test_large_video_preview_is_metadata_and_raw_supports_ranges(tmp_path, monkeypatch):
    source = tmp_path / 'intro.mp4'
    with source.open('wb') as output:
        output.write(b'video-header')
        output.truncate(9842309)
    monkeypatch.setattr(fs_paths, '_project', lambda _: SimpleNamespace(path=tmp_path, workstep_dir=tmp_path / '.workstep'))
    app = FastAPI()
    app.include_router(fs.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        response = await client.get('/api/fs/preview', params={'path': 'intro.mp4', 'project_id': 'p'})
        assert response.status_code == 200
        assert response.json() == {
            'type': 'video', 'content_type': 'video/mp4', 'content': '',
            'file_size': 9842309, 'extension': '.mp4', 'relative_path': 'intro.mp4',
        }
        response = await client.get('/api/fs/project-raw/p/intro.mp4', headers={'Range': 'bytes=0-11'})
        assert response.status_code == 206
        assert response.content == b'video-header'
        assert response.headers['content-type'] == 'video/mp4'
        assert response.headers['content-range'] == 'bytes 0-11/9842309'
        response = await client.get('/api/fs/preview', params={'path': '../outside.mp4', 'project_id': 'p'})
        assert response.status_code == 403
        (tmp_path / 'large.txt').write_bytes(b'x' * (1024 * 1024 + 1))
        response = await client.get('/api/fs/preview', params={'path': 'large.txt', 'project_id': 'p'})
        assert response.status_code == 413


@pytest.mark.asyncio
async def test_slow_video_metadata_keeps_health_responsive(tmp_path, monkeypatch):
    source = tmp_path / 'intro.mp4'
    source.write_bytes(b'video')
    def slow_resolve(*args, **kwargs):
        time.sleep(.15)
        return source
    monkeypatch.setattr(fs, '_resolve_project_file', slow_resolve)
    monkeypatch.setattr(fs, '_project_relative_path', lambda *args: 'intro.mp4')
    app = FastAPI()
    app.include_router(fs.router)
    @app.get('/health')
    async def health():
        return {'ok': True}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        pending = asyncio.create_task(client.get('/api/fs/preview', params={'path': 'intro.mp4'}))
        await asyncio.sleep(.02)
        assert not pending.done()
        assert (await asyncio.wait_for(client.get('/health'), .05)).status_code == 200
        assert (await pending).status_code == 200


@pytest.mark.asyncio
async def test_shared_video_content_has_video_mime_and_range_support(tmp_path, monkeypatch):
    from unittest.mock import AsyncMock
    from api import platform_share
    source = tmp_path / 'intro.mp4'
    source.write_bytes(b'video-header')
    monkeypatch.setattr(platform_share, '_share_scope', lambda _: {})
    monkeypatch.setattr(platform_share, '_share_artifact_path', AsyncMock(return_value=str(source)))
    app = FastAPI()
    app.include_router(platform_share.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        response = await client.get('/api/platform-share/artifacts/video/content', headers={'Range': 'bytes=0-4'})
        assert response.status_code == 206
        assert response.content == b'video'
        assert response.headers['content-type'] == 'video/mp4'

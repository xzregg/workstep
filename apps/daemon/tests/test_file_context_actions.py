import asyncio
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from api import fs, fs_paths


@pytest.mark.asyncio
async def test_open_file_preserves_file_and_enforces_project_boundary(tmp_path, monkeypatch):
    source = tmp_path / 'a.txt'
    source.write_text('hello')
    monkeypatch.setattr(fs_paths, '_project', lambda _: SimpleNamespace(path=tmp_path, workstep_dir=tmp_path / '.workstep'))
    monkeypatch.setattr(fs, '_run_open_command', AsyncMock())
    monkeypatch.setattr(fs.platform, 'system', lambda: 'Darwin')
    monkeypatch.setattr(fs, '_mac_app_exists', lambda _: True)
    app = FastAPI()
    app.include_router(fs.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        for opener, command in [('vscode', ['open', '-a', 'Visual Studio Code', str(source)]),
                                ('default', ['open', str(source)]),
                                ('file_manager', ['open', '-R', str(source)]),
                                ('terminal', ['open', '-a', 'Terminal', str(tmp_path)])]:
            response = await client.post('/api/fs/open-file', json={'project_id': 'p', 'path': 'a.txt', 'opener': opener})
            assert response.status_code == 200
            assert fs._run_open_command.call_args.args[0] == command
        response = await client.post('/api/fs/open-file', json={'project_id': 'p', 'path': '../outside.txt'})
        assert response.status_code == 403
        response = await client.post('/api/fs/open-file', json={'project_id': 'p', 'path': 'a.txt', 'opener': 'unknown'})
        assert response.status_code == 400


@pytest.mark.asyncio
async def test_slow_file_resolution_does_not_block_health(tmp_path, monkeypatch):
    source = tmp_path / 'a.txt'
    source.write_text('hello')
    def slow_resolve(*args, **kwargs):
        time.sleep(.15)
        return source
    monkeypatch.setattr(fs, '_resolve_project_file', slow_resolve)
    monkeypatch.setattr(fs, '_run_open_command', AsyncMock())
    monkeypatch.setattr(fs.platform, 'system', lambda: 'Darwin')
    app = FastAPI()
    app.include_router(fs.router)
    @app.get('/health')
    async def health():
        return {'ok': True}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        pending = asyncio.create_task(client.post('/api/fs/open-file', json={'project_id': 'p', 'path': 'a.txt'}))
        await asyncio.sleep(.02)
        assert not pending.done()
        response = await asyncio.wait_for(client.get('/health'), .05)
        assert response.status_code == 200
        assert (await pending).status_code == 200


@pytest.mark.asyncio
async def test_remote_actor_cannot_launch_host_apps(monkeypatch):
    import services.remote_access as access
    monkeypatch.setattr(access, 'get_current_actor', lambda: SimpleNamespace(project_id='p'))
    app = FastAPI()
    app.include_router(fs.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        response = await client.post('/api/fs/open-file', json={'project_id': 'p', 'path': 'a.txt'})
        assert response.status_code == 403

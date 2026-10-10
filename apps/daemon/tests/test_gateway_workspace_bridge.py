import asyncio
import base64
import os
import threading
import time
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import pytest
import httpx

from api.desktop_security import DesktopSecurityMiddleware
from services.gateway_client.bridge import ManagedHttpBridge
from services.gateway_client.identity import ManagedLocalSessions


@pytest.mark.asyncio
async def test_project_bridge_serves_workspace_assets_without_exposing_global_routes(tmp_path, monkeypatch):
    assets = tmp_path / 'assets'
    assets.mkdir()
    (assets / 'app.js').write_text('/* existing workspace bundle */')
    index = tmp_path / 'index.html'
    index.write_text('<title>WorkStep</title><script src="/assets/app.js"></script>')
    app = FastAPI()
    app.state.gateway_client = SimpleNamespace(managed_config=object(), local_sessions=ManagedLocalSessions())
    app.add_middleware(DesktopSecurityMiddleware)
    app.mount('/assets', StaticFiles(directory=assets))

    @app.get('/api/health')
    async def health():
        return {'status': 'ok'}

    @app.get('/api/project/list')
    async def global_projects():
        raise AssertionError('Project ticket reached global project enumeration')

    @app.get('/{path:path}')
    async def workspace(path: str, request: Request):
        assert request.state.managed_actor.project_id == 'project-1'
        return FileResponse(index)

    async def fetch(path, query=''):
        frames = []
        async def capture(frame):
            frames.append(frame)
        bridge = ManagedHttpBridge(app, 'workspace', {
            'method': 'GET', 'path': path, 'query': query, 'headers': [],
            'user_id': 'user-1', 'username': 'alice', 'project_id': 'project-1',
            'access_level': 'read',
        }, capture, 'device-1')
        bridge.start_task()
        await asyncio.wait_for(bridge._task, timeout=2)
        body = b''.join(base64.b64decode(frame.payload['data']) for frame in frames
                        if frame.payload.get('phase') == 'body')
        return frames[0].payload['status'], body

    assert await fetch('/') == (200, index.read_bytes())
    assert await fetch('/tasks', 'project=Visible&workflow=flow-1') == (200, index.read_bytes())
    assert await fetch('/assets/app.js') == (200, (assets / 'app.js').read_bytes())
    for path in ('/admin', '/api/project/list', '/assets/.env', '/landing'):
        assert (await fetch(path))[0] == 403

    entered = threading.Event()
    original_stat = os.stat
    def slow_stat(path, *args, **kwargs):
        if isinstance(path, (str, Path)) and str(path) == str(assets / 'app.js'):
            entered.set()
            time.sleep(0.2)
        return original_stat(path, *args, **kwargs)
    monkeypatch.setattr(os, 'stat', slow_stat)
    pending = asyncio.create_task(fetch('/assets/app.js'))
    assert await asyncio.to_thread(entered.wait, 1)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://localhost') as client:
        assert (await asyncio.wait_for(client.get('/api/health'), timeout=0.15)).status_code == 200
    assert (await pending)[0] == 200

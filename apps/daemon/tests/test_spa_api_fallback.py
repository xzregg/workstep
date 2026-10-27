"""Missing API routes must not be served as successful SPA pages."""

import os
import subprocess
import sys
from pathlib import Path


def test_spa_fallback_keeps_missing_api_routes_json(tmp_path):
    web = tmp_path / "web"
    web.mkdir()
    (web / "index.html").write_text("<!doctype html><title>WorkStep</title>")
    (web / "assets").mkdir()
    (web / "assets" / "current.js").write_text("export default true")
    # Even a matching static file cannot turn the API namespace into a page.
    (web / "api").mkdir()
    (web / "api" / "missing").write_text("<!doctype html><title>Wrong API</title>")
    script = """
import asyncio
import threading
import time
import main
from httpx import ASGITransport, AsyncClient
from main import app

async def check():
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        for path in ['/api', '/api/missing', '/api/workflow/generate/history/messages/missing/unknown']:
            response = await client.get(path)
            assert response.status_code == 404, (path, response.status_code)
            assert response.headers['content-type'].startswith('application/json')
            assert response.json()['detail'] == 'Not found'
        page = await client.get('/canvas')
        assert page.status_code == 200
        assert page.text.startswith('<!doctype html>')
        assert page.headers['cache-control'] == 'no-store'
        for path in ['/', '/index.html']:
            assert (await client.get(path)).headers['cache-control'] == 'no-store'
        for path in ['/assets/old-build.js', '/assets/old-build.css']:
            missing = await client.get(path)
            assert missing.status_code == 404
            assert missing.headers['cache-control'] == 'no-store'
        script = await client.get('/assets/current.js')
        assert script.status_code == 200
        assert script.text == 'export default true'
        assert (await client.get('/api/health')).status_code == 200
        entered = threading.Event()
        resolve = main._resolve_static
        def slow_resolve(root, rel):
            if rel == 'assets/old-build.js':
                entered.set()
                time.sleep(0.3)
            return resolve(root, rel)
        main._resolve_static = slow_resolve
        pending = asyncio.create_task(client.get('/assets/old-build.js'))
        assert await asyncio.to_thread(entered.wait, 1)
        health = await asyncio.wait_for(client.get('/api/health'), timeout=0.15)
        assert health.status_code == 200
        assert (await pending).status_code == 404

asyncio.run(check())
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=Path(__file__).resolve().parents[1],
        env={**os.environ, "WORKSTEP_WEB_DIST": str(web),
             "WORKSTEP_LANDING_DIST": str(tmp_path / "absent")},
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr

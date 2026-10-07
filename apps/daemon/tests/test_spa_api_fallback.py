"""Missing API routes must not be served as successful SPA pages."""

import os
import subprocess
import sys
from pathlib import Path


def test_spa_fallback_keeps_missing_api_routes_json(tmp_path):
    web = tmp_path / "web"
    web.mkdir()
    (web / "index.html").write_text("<!doctype html><title>WorkStep</title>")
    # Even a matching static file cannot turn the API namespace into a page.
    (web / "api").mkdir()
    (web / "api" / "missing").write_text("<!doctype html><title>Wrong API</title>")
    script = """
import asyncio
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
        assert (await client.get('/api/health')).status_code == 200

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

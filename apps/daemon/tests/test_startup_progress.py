"""Startup diagnostics must survive slow work without blocking the event loop."""

import asyncio
import threading

import pytest

from services import startup_progress


@pytest.mark.anyio
async def test_startup_progress_marks_success_and_failure(capsys):
    async with startup_progress.startup_stage('配置迁移'):
        pass
    with pytest.raises(ValueError, match='fixture-secret'):
        async with startup_progress.startup_stage('项目恢复'):
            raise ValueError('fixture-secret')
    output = capsys.readouterr().err
    assert 'STARTUP 配置迁移 start' in output
    assert 'STARTUP 配置迁移 complete elapsed_ms=' in output
    assert 'STARTUP 项目恢复 failed elapsed_ms=' in output
    assert 'fixture-secret' not in output


@pytest.mark.anyio
async def test_slow_startup_log_does_not_block_health(monkeypatch):
    from httpx import ASGITransport, AsyncClient
    from main import app

    entered, release = threading.Event(), threading.Event()

    def slow_write(*args, **kwargs):
        entered.set()
        assert release.wait(3)

    monkeypatch.setattr(startup_progress, '_write', slow_write)

    async def initialize():
        async with startup_progress.startup_stage('慢日志'):
            pass

    task = asyncio.create_task(initialize())
    try:
        assert await asyncio.to_thread(entered.wait, 3)
        async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
            response = await asyncio.wait_for(client.get('/api/health'), 0.5)
        assert response.status_code == 200
        assert not task.done()
    finally:
        release.set()
        await task

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from engines.core.session_pool import ManagedConnection, get_session_pool, close_session_pools
from engines.codex_sdk_clients import CodexClientPool


def test_codex_idle_default_is_ten_minutes():
    assert CodexClientPool().idle_seconds == 600


@pytest.mark.anyio
async def test_managed_connection_enters_and_closes_in_same_owner_task():
    tasks = []
    @asynccontextmanager
    async def context():
        tasks.append(asyncio.current_task())
        try:
            yield SimpleNamespace(process=None)
        finally:
            tasks.append(asyncio.current_task())
    resource = ManagedConnection(context)
    value = await asyncio.create_task(resource.open())
    assert value is resource.value
    await asyncio.create_task(resource.close())
    assert tasks[0] is tasks[1]


@pytest.mark.anyio
async def test_pool_reuses_across_instances_and_separates_engine_identity():
    closes = []
    @asynccontextmanager
    async def context():
        try:
            yield SimpleNamespace(process=None)
        finally:
            closes.append(True)
    pool = get_session_pool('first')
    assert pool.idle_seconds == 600 and pool.max_idle == 8
    one = await pool.acquire('/project', 'sid', 'config', lambda: ManagedConnection(context))
    await one.client.open()
    pool.bind(one, 'sid', True)
    await pool.release(one, reusable=True)
    assert await pool.acquire('/project', 'sid', 'config', lambda: None) is one
    other = get_session_pool('second')
    assert other is not pool
    await close_session_pools()
    assert closes == [True]


@pytest.mark.anyio
async def test_owner_initialization_cancel_closes_late_resources():
    started, proceed, closed = asyncio.Event(), asyncio.Event(), asyncio.Event()
    @asynccontextmanager
    async def context():
        started.set()
        try:
            await proceed.wait()
            yield SimpleNamespace(process=None)
        finally:
            closed.set()
    resource = ManagedConnection(context)
    opening = asyncio.create_task(resource.open())
    await started.wait()
    closing = asyncio.create_task(resource.close())
    proceed.set()
    await asyncio.gather(opening, closing, return_exceptions=True)
    assert closed.is_set()


def test_startup_fingerprint_tracks_identity_and_settings_files(tmp_path):
    from engines.core.session_pool import startup_fingerprint
    from services.conversation_context import conversation_context
    from services.coordinator_source import coordinator_source
    before = startup_fingerprint(str(tmp_path))
    (tmp_path / 'unrelated.txt').write_text('run output')
    assert startup_fingerprint(str(tmp_path)) == before
    (tmp_path / '.mcp.json').write_text('{}')
    assert startup_fingerprint(str(tmp_path)) != before
    with conversation_context('p', 'a'):
        one = startup_fingerprint(str(tmp_path))
    with conversation_context('p', 'b'):
        assert startup_fingerprint(str(tmp_path)) != one
    with coordinator_source('turn'):
        assert startup_fingerprint(str(tmp_path)) != before


@pytest.mark.anyio
async def test_owner_cleanup_failure_is_observed_and_owner_is_joined():
    @asynccontextmanager
    async def context():
        yield SimpleNamespace(process=None)
        raise RuntimeError('cleanup failed')
    connection = ManagedConnection(context)
    await connection.open()
    with pytest.raises(RuntimeError, match='cleanup failed'):
        await connection.close()
    assert connection._owner.done() and not connection.is_alive()


def test_claude_usage_statistics_do_not_invalidate_connection_but_mcp_does(tmp_path, monkeypatch):
    import json
    from pathlib import Path
    from engines.core.session_pool import startup_fingerprint
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    config = tmp_path / '.claude.json'
    config.write_text(json.dumps({'numStartups': 1, 'mcpServers': {}}))
    initial = startup_fingerprint({'model': 'same'})
    config.write_text(json.dumps({'numStartups': 2, 'mcpServers': {}}))
    assert startup_fingerprint({'model': 'same'}) == initial
    config.write_text(json.dumps({'numStartups': 2, 'mcpServers': {'added': {'command': 'peer'}}}))
    assert startup_fingerprint({'model': 'same'}) != initial


@pytest.mark.parametrize('content', ['null', '[]', '{"projects": []}', '{invalid'])
def test_malformed_foreign_native_config_does_not_break_other_engines(tmp_path, monkeypatch, content):
    from pathlib import Path
    from engines.core.session_pool import startup_fingerprint
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    (tmp_path / '.claude.json').write_text(content)
    assert startup_fingerprint({'engine': 'other'})


def test_rewriting_generated_config_with_same_content_keeps_fingerprint(tmp_path):
    import os
    from engines.core.session_pool import startup_fingerprint
    config = tmp_path / 'opencode.json'
    config.write_text('{"model":"one"}')
    first = startup_fingerprint(str(config))
    previous = config.stat().st_mtime_ns
    config.write_text('{"model":"one"}')
    os.utime(config, ns=(previous+1000000, previous+1000000))
    assert startup_fingerprint(str(config)) == first
    config.write_text('{"model":"two"}')
    assert startup_fingerprint(str(config)) != first

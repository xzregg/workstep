import asyncio
from pathlib import Path
import sys

import pytest

from engines.cursor_sdk import CursorSdkEngine
from engines.core.session_pool import get_session_pool, close_session_pools


@pytest.fixture
async def cursor(monkeypatch, tmp_path):
    sdk = pytest.importorskip('cursor_sdk')
    original = sdk.AsyncClient.launch_bridge
    peer = Path(__file__).parent / 'fixtures/cursor_bridge_stub.py'
    async def launch(**kwargs):
        return await original(command=[sys.executable, str(peer), str(tmp_path)], **kwargs)
    monkeypatch.setattr(sdk.AsyncClient, 'launch_bridge', launch)
    monkeypatch.setattr(CursorSdkEngine, '_api_key', lambda self: 'offline-not-a-real-api-key')
    errors = []
    loop = asyncio.get_running_loop()
    previous = loop.get_exception_handler()
    loop.set_exception_handler(lambda loop, context: errors.append(context))
    try:
        yield tmp_path
    finally:
        await close_session_pools()
        await asyncio.sleep(0)
        loop.set_exception_handler(previous)
        assert not errors, errors


async def collect(root, prompt, sid=None, engine=None):
    return [e async for e in (engine or CursorSdkEngine()).spawn(prompt, str(root), session_id=sid)]


def session(events):
    return next(e.data['session_id'] for e in events if e.type == 'session_started')


def text(events):
    return ''.join(e.data['text'] for e in events if e.type == 'agent_message_chunk')


@pytest.mark.anyio
async def test_real_cursor_sdk_reuses_bridge_agent_and_resumes_after_ttl(cursor):
    first = await asyncio.wait_for(collect(cursor, 'hello'), 5)
    assert text(first) == 'hello', [e.to_dict() for e in first]
    sid = session(first)
    pool = get_session_pool('cursor')
    entry = pool._entries[(str(cursor), sid)]
    process = entry.client.value.process
    second = await collect(cursor, 'large', sid)
    assert text(second) == 'x' * 100_000 and pool._entries[(str(cursor), sid)] is entry
    pool.idle_seconds = 0.01
    await collect(cursor, 'again', sid)
    await asyncio.sleep(0.03)
    await asyncio.wait_for(asyncio.shield(entry.closing), 5)
    assert process.returncode is not None
    resumed = await collect(cursor, 'resumed', sid)
    assert text(resumed) == 'resumed' and session(resumed) == sid


@pytest.mark.anyio
async def test_real_cursor_sdk_stop_is_owned_and_crash_discards(cursor):
    first = await collect(cursor, 'seed')
    sid = session(first)
    engine = CursorSdkEngine()
    stream = engine.spawn('wait', str(cursor), session_id=sid)
    try:
        assert (await anext(stream)).type == 'session_started'
        # send() primes a real stream before stop is invoked.
        next_event = asyncio.create_task(anext(stream))
        for _ in range(100):
            if engine._active_runs:
                break
            await asyncio.sleep(0.01)
        other = await collect(cursor, 'other')
        await asyncio.wait_for(engine.stop(), 5)
        await asyncio.gather(next_event, return_exceptions=True)
        await stream.aclose()
        assert text(await collect(cursor, 'alive', session(other))) == 'alive'
        failed = await collect(cursor, 'crash', sid)
        assert any(e.data.get('stop_reason') == 'error' for e in failed)
        assert text(await collect(cursor, 'recovered', sid)) == 'recovered'
    finally:
        await stream.aclose()

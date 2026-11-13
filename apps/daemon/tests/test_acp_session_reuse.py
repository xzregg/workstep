import asyncio
import json
from pathlib import Path
import sys

import pytest

from engines.hermes import HermesEngine
from engines.opencode import OpencodeEngine
from engines.core.base import ProviderRuntimeConfig
from engines.core.session_pool import close_session_pools, get_session_pool


@pytest.fixture(params=[HermesEngine, OpencodeEngine], ids=['hermes', 'opencode'])
async def engine_config(request, monkeypatch, tmp_path):
    cls = request.param
    peer = Path(__file__).parent / 'fixtures/acp_session_stub.py'
    monkeypatch.setattr(cls, 'get_command', lambda self: [sys.executable, str(peer), str(tmp_path)])
    monkeypatch.setattr(cls, 'project_skill_env', lambda *args: {})
    monkeypatch.setattr(cls, 'get_permission_mode', lambda *args: 'ask')
    monkeypatch.setattr(cls, 'resolve_provider_runtime', lambda *args, **kwargs: ProviderRuntimeConfig())
    errors = []
    loop = asyncio.get_running_loop()
    previous = loop.get_exception_handler()
    loop.set_exception_handler(lambda loop, context: errors.append(context))
    try:
        yield cls, tmp_path
    finally:
        await close_session_pools()
        await asyncio.sleep(0)
        loop.set_exception_handler(previous)
        assert not errors, errors


async def collect(config, prompt, sid=None, **kwargs):
    cls, root = config
    return [e async for e in cls().spawn(prompt, str(root), session_id=sid, **kwargs)]


def sid(events):
    return next(e.data['session_id'] for e in events if e.type == 'session_started')


def text(events):
    return ''.join(e.data['content']['text'] for e in events if e.type == 'agent_message_chunk')


@pytest.mark.anyio
async def test_acp_real_transport_reuses_session_and_long_output(engine_config):
    cls, root = engine_config
    first = await asyncio.wait_for(collect(engine_config, 'hello'), 5)
    assert text(first) == 'hello', [e.to_dict() for e in first]
    session = sid(first)
    pool = get_session_pool(cls.ENGINE_ID)
    entry = pool._entries[(str(root), session)]
    second = await asyncio.wait_for(collect(engine_config, 'large', session), 5)
    assert text(second) == 'x' * 100_000
    assert pool._entries[(str(root), session)] is entry
    lines = [json.loads(line) for line in (root / 'wire.jsonl').read_text().splitlines()]
    assert sum(row.get('method') == 'initialize' for row in lines) == 1
    assert not any(row.get('method') in {'session/load', 'session/resume'} for row in lines)


@pytest.mark.anyio
async def test_acp_real_transport_expiry_crash_and_resume(engine_config):
    cls, root = engine_config
    pool = get_session_pool(cls.ENGINE_ID)
    pool.idle_seconds = 0.01
    first = await collect(engine_config, 'hello')
    session = sid(first)
    original = pool._entries[(str(root), session)].client.value.process
    await asyncio.sleep(0.1)
    assert original.returncode is not None
    pool.idle_seconds = 600
    assert text(await collect(engine_config, 'resumed', session)) == 'resumed'
    crashed = await asyncio.wait_for(collect(engine_config, 'crash', session), 5)
    assert any(e.type == 'error' for e in crashed)
    assert text(await collect(engine_config, 'recovered', session)) == 'recovered'


@pytest.mark.anyio
@pytest.mark.parametrize('decision', ['allow', 'deny', 'stop'])
async def test_acp_parallel_approval_and_stop_isolation(engine_config, decision):
    cls, root = engine_config
    engine = cls()
    await engine.set_permission_mode('ask')
    ready = asyncio.Queue()
    output = []
    async def run():
        async for event in engine.spawn('approve', str(root)):
            output.append(event)
            if event.type == 'interaction_request':
                await ready.put(event)
    task = asyncio.create_task(run())
    try:
        event = await asyncio.wait_for(ready.get(), 5)
        other = await collect(engine_config, 'other')
        if decision == 'stop':
            await asyncio.wait_for(engine.stop(), 3)
        else:
            await engine.approve_tool_option(event.data['tool_call']['tool_call_id'], decision)
        await asyncio.wait_for(task, 5)
        if decision != 'stop':
            assert text(output) == ('accepted' if decision == 'allow' else 'denied')
        assert text(await collect(engine_config, 'survived', sid(other))) == 'survived'
    finally:
        if not task.done():
            await engine.stop()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.anyio
async def test_acp_cancel_and_early_close_release_prompt_tasks(engine_config):
    cls, root = engine_config
    first = await collect(engine_config, 'seed')
    session = sid(first)
    pool = get_session_pool(cls.ENGINE_ID)
    entry = pool._entries[(str(root), session)]
    stream = cls().spawn('unused', str(root), session_id=session)
    try:
        for _ in range(10):
            if (await anext(stream)).type == 'session_started':
                break
    finally:
        await stream.aclose()
    assert entry.client.value.process.returncode is not None
    engine = cls()
    task = asyncio.create_task(collect(engine_config, 'wait', session))
    # Wait until the native prompt is received, then cancel its consumer.
    for _ in range(100):
        lines = (root / 'wire.jsonl').read_text().splitlines()
        if any('wait' in line and 'session/prompt' in line for line in lines):
            break
        await asyncio.sleep(.01)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert not pool._entries

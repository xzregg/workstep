import asyncio
from pathlib import Path
import sys

import pytest

from engines.claude_code import ClaudeCodeEngine
from engines.core.base import ProviderRuntimeConfig
from engines.core.session_pool import get_session_pool, close_session_pools


@pytest.fixture
async def cli(monkeypatch, tmp_path):
    peer = tmp_path / 'peer'
    peer.write_text('#!' + sys.executable + '\n' + (Path(__file__).parent / 'fixtures/bidirectional_sdk_stub.py').read_text())
    peer.chmod(0o755)
    monkeypatch.setenv('WORKSTEP_TEST_PEER_ROOT', str(tmp_path))
    monkeypatch.setattr(ClaudeCodeEngine, 'resolve_binary', staticmethod(lambda: str(peer)))
    monkeypatch.setattr(ClaudeCodeEngine, 'project_skills', lambda *args: [])
    monkeypatch.setattr(ClaudeCodeEngine, 'resolve_provider_runtime', lambda *args, **kwargs: ProviderRuntimeConfig(model='synthetic'))
    monkeypatch.setattr('services.skill_runtime.prepare_claude_plugin', lambda *args: (tmp_path, []))
    monkeypatch.setattr('services.config.config_store.get_claude_permission_mode', lambda: 'acceptEdits')
    try:
        yield tmp_path
    finally:
        await close_session_pools()


async def collect(root, prompt, sid=None, **kwargs):
    return [e async for e in ClaudeCodeEngine().spawn(prompt, str(root), session_id=sid, **kwargs)]


def sid(events):
    return next(e.data['session_id'] for e in events if e.type == 'session_started')


def text(events):
    return ''.join(e.data['content']['text'] for e in events if e.type == 'agent_message_chunk')


@pytest.mark.anyio
async def test_cli_two_turns_same_pid_large_output_and_expiry(cli):
    pool = get_session_pool('claude')
    first = await asyncio.wait_for(collect(cli, 'hello'), 5)
    assert text(first) == 'hello'
    session = sid(first)
    entry = pool._entries[(str(cli), session)]
    process = entry.client.value.process
    second = await asyncio.wait_for(collect(cli, 'large', session), 5)
    assert text(second) == 'x' * 100_000 and pool._entries[(str(cli), session)] is entry
    assert sid(second) == session
    pool.idle_seconds = 0.01
    await collect(cli, 'again', session)
    await asyncio.sleep(0.1)
    assert process.returncode is not None
    resumed = await collect(cli, 'resumed', session)
    assert sid(resumed) == session and text(resumed) == 'resumed'


@pytest.mark.anyio
async def test_cli_parallel_sessions_busy_stop_and_crash_recovery(cli):
    first = await collect(cli, 'seed')
    session = sid(first)
    engine = ClaudeCodeEngine()
    stream = engine.spawn('wait', str(cli), session_id=session)
    try:
        while (event := await anext(stream)).type != 'session_started':
            pass
        pool = get_session_pool('claude')
        entry = pool._entries[(str(cli), session)]
        with pytest.raises(RuntimeError, match='session is executing'):
            await collect(cli, 'conflict', session)
        other = await collect(cli, 'other')
        await engine.stop()
        await stream.aclose()
        assert entry.client.value.process.returncode is not None
        assert text(await collect(cli, 'still-alive', sid(other))) == 'still-alive'
        crashed = await collect(cli, 'crash', session)
        assert any(e.type == 'error' for e in crashed)
        assert text(await collect(cli, 'recovered', session)) == 'recovered'
    finally:
        await stream.aclose()


@pytest.mark.anyio
async def test_cli_live_messages_wait_for_all_inflight_results(cli):
    queue = asyncio.Queue()
    queue.put_nowait(('one', 'follow-up'))
    events = await asyncio.wait_for(collect(cli, 'first', live_message_queue=queue), 5)
    assert text(events) == 'firstfollow-up'
    assert any(e.type == 'live_message' and e.data['status'] == 'delivered' for e in events)
    assert text(await collect(cli, 'next', sid(events))) == 'next'

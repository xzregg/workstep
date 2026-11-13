import asyncio
import json
from pathlib import Path
import sys

import pytest

from engines.claude_agent_sdk import ClaudeAgentSDKEngine
from engines.qoder_sdk import QoderSDKEngine
from engines.core.base import ProviderRuntimeConfig
from engines.core.session_pool import get_session_pool, close_session_pools


@pytest.fixture(params=[ClaudeAgentSDKEngine, QoderSDKEngine], ids=['claude', 'qoder'])
async def sdk_engine(request, monkeypatch, tmp_path):
    cls = request.param
    pytest.importorskip('claude_agent_sdk' if cls is ClaudeAgentSDKEngine else 'qoder_agent_sdk')
    peer = tmp_path / 'peer'
    peer.write_text('#!' + sys.executable + '\n' + (Path(__file__).parent / 'fixtures/bidirectional_sdk_stub.py').read_text())
    peer.chmod(0o755)
    monkeypatch.setenv('WORKSTEP_TEST_PEER_ROOT', str(tmp_path))
    monkeypatch.setattr(cls, 'resolve_binary', staticmethod(lambda: str(peer)))
    monkeypatch.setattr(cls, 'is_configured', staticmethod(lambda: True))
    monkeypatch.setattr(cls, 'project_skills', lambda *args: [])
    monkeypatch.setattr(cls, 'resolve_provider_runtime', lambda *args, **kwargs: ProviderRuntimeConfig(model='synthetic'))
    monkeypatch.setattr('services.skill_runtime.prepare_claude_plugin', lambda *args: (tmp_path, []))
    monkeypatch.setattr('services.skill_runtime.prepare_qoder_plugin', lambda *args: (tmp_path, []))
    monkeypatch.setattr('services.config.config_store.get_claude_agent_sdk_config', lambda: {
        'permission_mode': 'acceptEdits', 'max_turns': '', 'fallback_model': '',
    })
    monkeypatch.setattr('services.config.config_store.get_qoder_sdk_config', lambda: {
        'model': 'synthetic', 'permission_mode': 'default', 'include_partial_messages': True,
        'personal_access_token': 'offline-peer-not-a-real-credential',
    })
    try:
        yield cls, tmp_path
    finally:
        await close_session_pools()


async def collect(config, prompt, sid=None, engine=None, **kwargs):
    cls, root = config
    engine = engine or cls()
    events = [event async for event in engine.spawn(prompt, str(root), session_id=sid, **kwargs)]
    assert not [e.to_dict() for e in events if e.type == 'error']
    return events


def session(events):
    return next(e.data['session_id'] for e in events if e.type == 'session_started')


def text(events):
    return ''.join(e.data['content']['text'] for e in events if e.type == 'agent_message_chunk')


@pytest.mark.anyio
async def test_native_sdk_two_turns_keep_process_and_long_events(sdk_engine):
    cls, root = sdk_engine
    first = await asyncio.wait_for(collect(sdk_engine, 'hello'), 5)
    assert text(first) == 'hello'
    sid = session(first)
    pool = get_session_pool(cls.ENGINE_ID)
    entry = pool._entries[(str(root), sid)]
    process = entry.client.value.process
    assert process.returncode is None
    second = await asyncio.wait_for(collect(sdk_engine, 'large', sid), 5)
    assert text(second) == 'x' * 100_000
    assert session(second) == sid
    assert pool._entries[(str(root), sid)] is entry
    await close_session_pools()
    assert process.returncode is not None


@pytest.mark.anyio
async def test_native_sdk_idle_expiry_and_closed_session_resume(sdk_engine):
    cls, root = sdk_engine
    get_session_pool(cls.ENGINE_ID).idle_seconds = 0.01
    first = await collect(sdk_engine, 'hello')
    sid = session(first)
    process = get_session_pool(cls.ENGINE_ID)._entries[(str(root), sid)].client.value.process
    await asyncio.sleep(0.08)
    assert process.returncode is not None
    second = await collect(sdk_engine, 'resumed', sid)
    assert session(second) == sid and text(second) == 'resumed'
    await cls().close_session(sid, str(root))
    assert not get_session_pool(cls.ENGINE_ID)._entries


@pytest.mark.anyio
async def test_native_sdk_parallel_sessions_and_stop_pending_approval(sdk_engine, monkeypatch):
    cls, root = sdk_engine
    engine = cls()
    monkeypatch.setattr(engine, 'runtime_permission_decision', lambda: None)
    ready = asyncio.Queue()
    async def run():
        async for event in engine.spawn('approve', str(root)):
            if event.type == 'interaction_request':
                await ready.put(event)
    task = asyncio.create_task(run())
    try:
        await asyncio.wait_for(ready.get(), 5)
        other = await asyncio.wait_for(collect(sdk_engine, 'other'), 5)
        other_sid = session(other)
        await asyncio.wait_for(engine.stop(), 3)
        await asyncio.wait_for(task, 3)
        assert text(await collect(sdk_engine, 'still-alive', other_sid)) == 'still-alive'
        assert not engine._pending_interaction_responses
    finally:
        if not task.done():
            await engine.stop()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.anyio
@pytest.mark.parametrize('decision', ['allow_once', 'reject_once'])
async def test_native_sdk_rebinds_approval_callbacks_on_each_turn(sdk_engine, monkeypatch, decision):
    cls, root = sdk_engine
    seed = await collect(sdk_engine, 'seed')
    sid = session(seed)
    first_entry = get_session_pool(cls.ENGINE_ID)._entries[(str(root), sid)]
    for _ in range(2):
        engine = cls()
        monkeypatch.setattr(engine, 'runtime_permission_decision', lambda: None)
        events = []
        async def run():
            async for event in engine.spawn('approve', str(root), session_id=sid):
                events.append(event)
                if event.type == 'interaction_request':
                    assert await engine.respond_interaction(event.data, {'outcome': {'option_id': decision}})
        await asyncio.wait_for(run(), 5)
        assert text(events) == ('accepted' if decision == 'allow_once' else 'denied')
        assert get_session_pool(cls.ENGINE_ID)._entries[(str(root), sid)] is first_entry


@pytest.mark.anyio
async def test_native_sdk_same_session_busy_and_crash_recovery(sdk_engine):
    cls, root = sdk_engine
    seed = await collect(sdk_engine, 'seed')
    sid = session(seed)
    engine = cls()
    stream = engine.spawn('wait', str(root), session_id=sid)
    try:
        while (await anext(stream)).type != 'session_started':
            pass
        conflicting = [e async for e in cls().spawn('conflict', str(root), session_id=sid)]
        assert any(e.type == 'error' for e in conflicting)
        await engine.stop()
        await stream.aclose()
        crashed = [e async for e in cls().spawn('crash', str(root), session_id=sid)]
        assert any(e.type == 'error' for e in crashed)
        recovered = await collect(sdk_engine, 'recovered', sid)
        assert text(recovered) == 'recovered' and session(recovered) == sid
    finally:
        await engine.stop()
        await stream.aclose()


@pytest.mark.anyio
async def test_native_sdk_configuration_changes_rebuild_and_early_close_discards(sdk_engine):
    cls, root = sdk_engine
    seed = await collect(sdk_engine, 'seed', system_prompt='initial rules')
    sid = session(seed)
    pool = get_session_pool(cls.ENGINE_ID)
    old = pool._entries[(str(root), sid)]
    updated = await collect(sdk_engine, 'updated', sid, system_prompt='changed rules')
    assert text(updated) == 'updated' and old.client.value.process.returncode is not None
    current = pool._entries[(str(root), sid)]
    engine = cls()
    stream = engine.spawn('wait', str(root), session_id=sid)
    try:
        while (await anext(stream)).type != 'session_started':
            pass
    finally:
        await stream.aclose()
    assert current.client.value.process.returncode is not None


@pytest.mark.anyio
async def test_native_sdk_injections_finish_before_next_request(sdk_engine):
    queue = asyncio.Queue()
    queue.put_nowait(('follow-up-id', 'follow-up'))
    events = await asyncio.wait_for(collect(sdk_engine, 'first', live_message_queue=queue), 5)
    assert text(events) == 'firstfollow-up'
    assert any(e.type == 'live_message' and e.data['status'] == 'delivered' for e in events)
    sid = session(events)
    assert text(await collect(sdk_engine, 'next', sid)) == 'next'


@pytest.mark.anyio
async def test_native_sdk_slow_config_metadata_keeps_event_loop_responsive(sdk_engine, monkeypatch):
    import threading
    import time
    _, root = sdk_engine
    entered = threading.Event()
    original = Path.stat
    def slow_stat(path, *args, **kwargs):
        if path == root / '.mcp.json':
            entered.set()
            time.sleep(.2)
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'stat', slow_stat)
    task = asyncio.create_task(collect(sdk_engine, 'hello'))
    try:
        for _ in range(100):
            if entered.is_set():
                break
            await asyncio.sleep(.005)
        assert entered.is_set()
        started = time.monotonic()
        await asyncio.sleep(.02)
        assert time.monotonic() - started < .1
        assert text(await asyncio.wait_for(task, 5)) == 'hello'
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)

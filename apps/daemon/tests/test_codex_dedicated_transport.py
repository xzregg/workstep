"""Exercise dedicated/main isolation through real SDK pipes and child processes."""
import asyncio

import psutil
import pytest

from engines.codex_sdk import CodexSDKEngine
from engines.core.session_retention import session_retention, release_session_retention
from tests.test_codex_sdk_transport_lifecycle import transport, collect, session, text, wire

pytestmark = [pytest.mark.asyncio,
    pytest.mark.filterwarnings('error::pytest.PytestUnhandledThreadExceptionWarning'),
    pytest.mark.filterwarnings('error::pytest.PytestUnraisableExceptionWarning'),
    pytest.mark.filterwarnings('error::RuntimeWarning')]


async def main_turn(transport, prompt, sid=None, owner='main'):
    with session_retention(owner):
        return await collect(transport, prompt, sid=sid)


def entry(transport, sid):
    return transport.pool._entries[(str(transport.root), sid)]


async def test_private_main_runs_while_six_ordinary_turns_share_five_plus_one(transport):
    sid = session(await main_turn(transport, 'main'))
    private = entry(transport, sid).client._client._sync._proc
    engines = [CodexSDKEngine() for _ in range(6)]
    queues = [asyncio.Queue() for _ in engines]
    ready = asyncio.Queue()

    async def run(i):
        result = []
        async for event in engines[i].spawn(prompt='wait', cwd=str(transport.root), live_message_queue=queues[i]):
            result.append(event)
            transport.track()
            if event.type == 'session_started':
                await ready.put((i, event.data['session_id']))
        return result

    tasks = [asyncio.create_task(run(i)) for i in range(6)]
    try:
        ids = dict([await asyncio.wait_for(ready.get(), 5) for _ in engines])
        pids = [entry(transport, ids[i]).client._client._sync._proc.pid for i in range(6)]
        assert sorted(pids.count(p) for p in set(pids)) == [1, 5]
        assert private.pid not in pids
        assert text(await main_turn(transport, 'main-is-live', sid)) == 'main-is-live'
        assert entry(transport, sid).client._client._sync._proc is private
        assert all(not task.done() for task in tasks)
        for i, queue in enumerate(queues):
            queue.put_nowait((str(i), 'finish'))
        results = await asyncio.wait_for(asyncio.gather(*tasks), 5)
        assert all(text(result) == 'steered' for result in results)
    finally:
        await asyncio.gather(*(engine.stop() for engine in engines))
        await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.parametrize('decision', ['allow_once', 'reject_once', 'stop'])
async def test_private_approval_does_not_block_shared_process(transport, monkeypatch, decision):
    engine = CodexSDKEngine()
    monkeypatch.setattr(engine, 'runtime_permission_decision', lambda: None)
    stream = engine.spawn(prompt='approve', cwd=str(transport.root))
    sid = None
    try:
        with session_retention('main'):
            async for event in stream:
                transport.track()
                if event.type == 'session_started':
                    sid = event.data['session_id']
                if event.type == 'interaction_request':
                    request = event
                    break
        private = entry(transport, sid).client._client._sync._proc
        normal = await asyncio.wait_for(collect(transport, 'ordinary'), 5)
        normal_sid = session(normal)
        shared = entry(transport, normal_sid).client._client._sync._proc
        assert shared.pid != private.pid and text(normal) == 'ordinary'
        overlapping = await main_turn(transport, 'another-main-context')
        assert any(event.type == 'error' for event in overlapping)
        assert len(transport.clients) == 2
        if decision == 'stop':
            await asyncio.wait_for(engine.stop(), 5)
            await stream.aclose()
            assert private.poll() is not None
        else:
            assert await engine.respond_interaction(request.data, {'outcome': {'option_id': decision}})
            rest = await asyncio.wait_for(_drain(stream), 5)
            assert text(rest) == ('accepted' if decision == 'allow_once' else 'denied')
        assert shared.poll() is None
        assert text(await collect(transport, 'still-alive', sid=normal_sid)) == 'still-alive'
        assert not engine._pending_interaction_responses
    finally:
        await engine.stop()
        await stream.aclose()


async def _drain(stream):
    return [event async for event in stream]


@pytest.mark.parametrize('crashed', ['main', 'shared'])
async def test_crash_in_one_partition_preserves_other_and_resumes_old_id(transport, crashed):
    main_sid = session(await main_turn(transport, 'main'))
    shared_sid = session(await collect(transport, 'ordinary'))
    private = entry(transport, main_sid).client._client._sync._proc
    shared = entry(transport, shared_sid).client._client._sync._proc
    victim = private if crashed == 'main' else shared
    await asyncio.to_thread(victim.kill)
    await asyncio.to_thread(victim.wait, 3)
    if crashed == 'main':
        assert text(await collect(transport, 'ordinary-alive', sid=shared_sid)) == 'ordinary-alive'
        recovered = await main_turn(transport, 'main-restored', main_sid)
        assert session(recovered) == main_sid
        assert entry(transport, main_sid).client._client._sync._proc.pid != private.pid
        assert entry(transport, shared_sid).client._client._sync._proc is shared
    else:
        assert text(await main_turn(transport, 'main-alive', main_sid)) == 'main-alive'
        recovered = await collect(transport, 'ordinary-restored', sid=shared_sid)
        assert session(recovered) == shared_sid
        assert entry(transport, shared_sid).client._client._sync._proc.pid != shared.pid
        assert entry(transport, main_sid).client._client._sync._proc is private


@pytest.mark.parametrize('new_owner', ['main', 'replacement-main'])
async def test_reset_and_host_replacement_keep_private_pid_and_unload_old_thread(transport, new_owner):
    old_sid = session(await main_turn(transport, 'old-main'))
    private = entry(transport, old_sid).client._client._sync._proc
    normal_sid = session(await collect(transport, 'normal'))
    shared = entry(transport, normal_sid).client._client._sync._proc
    await release_session_retention('main')
    new_sid = session(await main_turn(transport, 'new-main', owner=new_owner))
    assert new_sid != old_sid
    assert entry(transport, new_sid).client._client._sync._proc is private
    assert (str(transport.root), old_sid) not in transport.pool._entries
    assert len(entry(transport, new_sid).worker.entries) == 1
    assert any(row['params']['threadId'] == old_sid for row in wire(transport, 'thread/unsubscribe'))
    assert text(await collect(transport, 'normal-alive', sid=normal_sid)) == 'normal-alive'
    assert entry(transport, normal_sid).client._client._sync._proc is shared


async def test_closing_private_tree_leaves_shared_tree_running(transport):
    main = await main_turn(transport, 'spawn-helper')
    main_sid = session(main)
    private = entry(transport, main_sid).client._client._sync._proc
    private_helper = psutil.Process(int(text(main)))
    normal = await collect(transport, 'spawn-helper')
    normal_sid = session(normal)
    shared = entry(transport, normal_sid).client._client._sync._proc
    shared_helper = psutil.Process(int(text(normal)))
    assert private_helper.ppid() == private.pid and shared_helper.ppid() == shared.pid
    await CodexSDKEngine().close_session(main_sid, str(transport.root))
    assert private.poll() is not None and shared.poll() is None
    try:
        assert not private_helper.is_running() or private_helper.status() == psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        pass
    assert shared_helper.is_running()

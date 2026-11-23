"""Exercise the real optional SDK and real subprocesses with an offline peer."""
import asyncio
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import psutil
import pytest
import pytest_asyncio

from engines.codex_sdk import CodexSDKEngine
from engines.codex_sdk_clients import CodexClientPool
from engines.core.base import ProviderRuntimeConfig

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.filterwarnings('error::pytest.PytestUnhandledThreadExceptionWarning'),
    pytest.mark.filterwarnings('error::pytest.PytestUnraisableExceptionWarning'),
    pytest.mark.filterwarnings('error::RuntimeWarning'),
]


# The pool and its background cleanup must share the test event loop.
@pytest_asyncio.fixture
async def transport(monkeypatch, tmp_path):
    monkeypatch.setenv('CODEX_HOME', str(tmp_path / 'codex-home'))
    sdk = pytest.importorskip('openai_codex')
    original = sdk.AsyncCodex
    clients, processes, routers = [], [], []
    pool = CodexClientPool(idle_seconds=60, max_idle_workers=2, keep_warm=False)
    def client(*, config):
        config.launch_args_override = (sys.executable, str(Path(__file__).parent / 'fixtures/codex_app_server_stub.py'), str(tmp_path))
        instance = original(config=config)
        native_close = instance.close
        async def close():
            process = instance._client._sync._proc
            if process is not None and process not in processes:
                processes.append(process)
            await native_close()
        instance.close = close
        clients.append(instance)
        return instance
    monkeypatch.setattr(sdk, 'AsyncCodex', client)
    monkeypatch.setattr('engines.codex_sdk.get_codex_client_pool', lambda: pool)
    monkeypatch.setattr(CodexSDKEngine, 'get_binary_override', staticmethod(lambda: None))
    monkeypatch.setattr(CodexSDKEngine, 'project_skills', lambda *args: [])
    monkeypatch.setattr(CodexSDKEngine, 'resolve_provider_runtime', lambda *args, **kwargs: ProviderRuntimeConfig(model='synthetic'))
    monkeypatch.setattr('services.skill_runtime.prepare_codex_skills', lambda *args: ([], 'skills=[]'))
    monkeypatch.setattr('engines.codex_sdk.config_store.get_codex_sdk_config', lambda: {
        'sandbox': 'read-only', 'approval_mode': '', 'model_reasoning_effort': '',
    })
    def track():
        for worker in pool._workers:
            if worker.router and worker.router not in routers:
                routers.append(worker.router)
        for c in clients:
            p = c._client._sync._proc
            if p is not None and p not in processes:
                processes.append(p)
        return [p.pid for p in processes]
    try:
        yield SimpleNamespace(pool=pool, clients=clients, processes=processes, track=track, root=tmp_path)
    finally:
        track()
        await pool.close()
        assert not [p.pid for p in processes if p.poll() is None], 'Codex app-server processes still running'
        assert not [thread for client in clients for name in ('_reader_thread','_stderr_thread')
                    if (thread := getattr(client._client._sync, name, None)) is not None and thread.is_alive()]
        assert not [thread for router in routers for thread in router.background_threads() if thread.is_alive()]


async def collect(transport, prompt, *, sid=None, engine=None, cwd=None, **kwargs):
    events = []
    engine = engine or CodexSDKEngine()
    async for event in engine.spawn(prompt=prompt, cwd=str(cwd or transport.root), session_id=sid, **kwargs):
        events.append(event)
        transport.track()
    return events


def session(events):
    return next(e.data['session_id'] for e in events if e.type == 'session_started')


def text(events):
    return ''.join(e.data['content']['text'] for e in events if e.type == 'agent_message_chunk')


async def test_six_active_turns_use_two_processes_and_stopping_one_keeps_neighbors(transport):
    engines = [CodexSDKEngine() for _ in range(6)]
    queues = [asyncio.Queue() for _ in engines]
    ready = asyncio.Queue()

    async def run(i):
        output = []
        async for event in engines[i].spawn(prompt='wait', cwd=str(transport.root), live_message_queue=queues[i]):
            output.append(event)
            transport.track()
            if event.type == 'session_started':
                await ready.put((i, event.data['session_id']))
        return output

    tasks = [asyncio.create_task(run(i)) for i in range(6)]
    try:
        ids = dict([await asyncio.wait_for(ready.get(), 5) for _ in engines])
        entries = [transport.pool._entries[(str(transport.root), ids[i])] for i in range(6)]
        clients = [e.client for e in entries]
        assert len({id(c) for c in clients}) == 2
        assert sorted(sum(c is x for c in clients) for x in set(clients)) == [1, 5]
        assert len(transport.processes) == 2
        shared = next(c for c in set(clients) if clients.count(c) == 5)
        stopped = clients.index(shared)
        await asyncio.wait_for(engines[stopped].stop(), 5)
        await asyncio.wait_for(tasks[stopped], 5)
        assert shared._client._sync._proc.poll() is None
        for i in range(6):
            if i != stopped:
                queues[i].put_nowait((f'insert-{i}', f'only-{i}'))
        results = await asyncio.wait_for(asyncio.gather(*tasks), 5)
        assert all(text(output) == 'steered' for i,output in enumerate(results) if i != stopped)
        assert all(p.poll() is None for p in transport.processes)
    finally:
        await asyncio.gather(*(e.stop() for e in engines))
        await asyncio.gather(*tasks, return_exceptions=True)


async def test_two_pending_approvals_are_routed_independently_and_stop_is_local(transport, monkeypatch):
    engines = [CodexSDKEngine(), CodexSDKEngine()]
    ready = asyncio.Queue()
    for engine in engines:
        monkeypatch.setattr(engine, 'runtime_permission_decision', lambda: None)

    async def run(i):
        output = []
        async for event in engines[i].spawn(prompt='approve', cwd=str(transport.root)):
            output.append(event)
            transport.track()
            if event.type == 'interaction_request':
                await ready.put((i,event))
        return output

    tasks = [asyncio.create_task(run(i)) for i in range(2)]
    try:
        requests = dict([await asyncio.wait_for(ready.get(), 5) for _ in engines])
        assert len(transport.clients) == 1
        approval_process = transport.processes[0]
        for name in ('idle-a', 'idle-b', 'idle-c'):
            cwd = transport.root / name
            cwd.mkdir()
            assert text(await collect(transport, name, cwd=cwd)) == name
        assert len(transport.pool._workers) == 3  # Two idle, one awaiting approvals.
        assert approval_process.poll() is None
        # Wrong engine cannot consume the other thread's approval response.
        assert not await engines[1].respond_interaction(requests[0].data, {'outcome': {'option_id':'allow_once'}})
        await asyncio.wait_for(engines[0].stop(), 5)
        await asyncio.wait_for(tasks[0], 5)
        assert not tasks[1].done()
        assert transport.processes[0].poll() is None
        assert await engines[1].respond_interaction(requests[1].data, {'outcome': {'option_id':'reject_once'}})
        output = await asyncio.wait_for(tasks[1], 5)
        assert text(output) == 'denied'
        assert not any(e._pending_interaction_responses for e in engines)
    finally:
        await asyncio.gather(*(e.stop() for e in engines))
        await asyncio.gather(*tasks, return_exceptions=True)


async def test_shared_native_crash_fails_active_neighbor_and_resumes_both(transport):
    seed_a = await collect(transport, 'seed-a')
    seed_b = await collect(transport, 'seed-b')
    sid_a, sid_b = session(seed_a), session(seed_b)
    assert len(transport.clients) == 1
    engine = CodexSDKEngine()
    ready = asyncio.Event()

    async def run():
        output = []
        async for event in engine.spawn(prompt='wait', cwd=str(transport.root), session_id=sid_b):
            output.append(event)
            if event.type == 'session_started':
                ready.set()
        return output

    task = asyncio.create_task(run())
    try:
        await asyncio.wait_for(ready.wait(), 5)
        crashed = await asyncio.wait_for(collect(transport, 'crash', sid=sid_a), 5)
        neighbor = await asyncio.wait_for(task, 5)
        assert any(e.type == 'error' for e in crashed)
        assert any(e.type == 'error' for e in neighbor)
        assert transport.processes[0].poll() is not None
        assert not getattr(engine, '_pending_interaction_responses', {})
        for sid in [sid_a, sid_b]:
            resumed = await asyncio.wait_for(collect(transport, 'recovered', sid=sid), 5)
            assert session(resumed) == sid and text(resumed) == 'recovered'
        assert len(transport.clients) == 2
    finally:
        if not task.done():
            await engine.stop()
        await asyncio.gather(task, return_exceptions=True)


async def test_stop_during_turn_start_response_recovers_turn_id_without_stopping_neighbor(transport, monkeypatch):
    import openai_codex
    a = session(await collect(transport, 'seed-a'))
    b = session(await collect(transport, 'seed-b'))
    original = openai_codex.AsyncThread.turn
    entered = asyncio.Event()
    async def delayed(thread, *args, **kwargs):
        handle = await original(thread, *args, **kwargs)
        if thread.id == a:
            entered.set()
            await asyncio.Event().wait()
        return handle
    monkeypatch.setattr(openai_codex.AsyncThread, 'turn', delayed)
    engine = CodexSDKEngine()
    task = asyncio.create_task(collect(transport, 'wait', sid=a, engine=engine))
    try:
        await asyncio.wait_for(entered.wait(), 5)
        await asyncio.wait_for(engine.stop(), 5)
        await asyncio.wait_for(task, 5)
        assert any(row['params']['threadId'] == a for row in wire(transport, 'turn/interrupt'))
        assert text(await collect(transport, 'neighbor-alive', sid=b)) == 'neighbor-alive'
        assert len(transport.clients) == 1 and transport.processes[0].poll() is None
    finally:
        if not task.done():
            await engine.stop()
        await asyncio.gather(task, return_exceptions=True)


async def test_process_death_invalidates_visible_approval_and_old_click_cannot_authorize_restart(transport, monkeypatch):
    from agent_assistants.engine_invocation import run_engine_turn
    from services.intervention import intervention_manager
    engine = CodexSDKEngine()
    monkeypatch.setattr(engine, 'runtime_permission_decision', lambda: None)
    ready = asyncio.Queue()
    output = []
    async def on_event(event):
        output.append(event)
        transport.track()
        if event.type == 'interaction_request':
            await ready.put(event)
    async def invoke(sid=None):
        return await run_engine_turn('codex_sdk', None, str(transport.root), 'approve', sid,
            on_event=on_event, engine_factory=lambda _: engine, settings_store=SimpleNamespace(),
            run_key='crash-approval',
            spawner=lambda e, **kwargs: e.spawn(prompt='approve', cwd=str(transport.root), session_id=sid, **kwargs))
    task = asyncio.create_task(invoke())
    try:
        request = await asyncio.wait_for(ready.get(), 5)
        old_id = request.data['interaction_id']
        sid = next(e.data['session_id'] for e in output if e.type == 'session_started')
        transport.processes[0].kill()
        with pytest.raises(RuntimeError):
            await asyncio.wait_for(task, 2)
        assert not intervention_manager.deliver_response(old_id, {'outcome':{'option_id':'allow_once'}})
        assert any(e.type=='interaction_response' and e.data['interaction_id']==old_id
                   and e.data['response']['outcome']['outcome']=='cancelled' for e in output)
        assert not getattr(engine, '_pending_interaction_responses', {})
        task = asyncio.create_task(invoke(sid))
        fresh = await asyncio.wait_for(ready.get(), 5)
        assert fresh.data['interaction_id'] != old_id
        assert not intervention_manager.deliver_response(old_id, {'outcome':{'option_id':'allow_once'}})
        assert not task.done()
        assert intervention_manager.deliver_response(fresh.data['interaction_id'], {'outcome':{'option_id':'reject_once'}})
        reply,_,actual_sid = await asyncio.wait_for(task, 5)
        assert reply == 'denied' and actual_sid == sid
    finally:
        intervention_manager.cancel_for_task('crash-approval')
        if not task.done():
            await engine.stop()
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_stop_while_process_is_starting_does_not_leave_late_process(transport, monkeypatch):
    import subprocess
    import threading
    entered,unblock,spawned = threading.Event(),threading.Event(),threading.Event()
    original = subprocess.Popen
    created = []
    def delayed(args,*pos,**kwargs):
        if any('codex_app_server_stub.py' in str(arg) for arg in args):
            entered.set()
            assert unblock.wait(3)
            process = original(args,*pos,**kwargs)
            created.append(process)
            spawned.set()
            return process
        return original(args,*pos,**kwargs)
    monkeypatch.setattr(subprocess,'Popen',delayed)
    engine = CodexSDKEngine()
    task = asyncio.create_task(collect(transport,'hello',engine=engine))
    stopping = None
    try:
        assert await asyncio.to_thread(entered.wait,1)
        assert engine._client_lease is not None
        assert engine._client_lease.worker.router.start_lock.locked()
        stopping = asyncio.create_task(engine.stop())
        await asyncio.sleep(.03)
        waited_for_start = not stopping.done()
        unblock.set()
        await asyncio.wait_for(stopping,5)
        await asyncio.wait_for(task,5)
        assert waited_for_start
        assert all(p.poll() is not None for p in created)
    finally:
        unblock.set()
        if stopping:
            await asyncio.gather(stopping,return_exceptions=True)
        await asyncio.gather(task,return_exceptions=True)
        if entered.is_set():
            await asyncio.to_thread(spawned.wait,1)
        for process in created:
            if process.poll() is None:
                process.terminate()
                await asyncio.to_thread(process.wait,timeout=3)
        for client in transport.clients:
            await client.close()


async def test_real_sdk_reuse_streaming_and_native_crash_recovery(transport):
    first = await asyncio.wait_for(collect(transport, 'hello'), 5)
    assert text(first) == 'hello'
    sid = session(first)
    second = await asyncio.wait_for(collect(transport, 'large', sid=sid), 5)
    assert text(second) == 'x' * 100_000
    assert len(transport.clients) == 1
    assert transport.processes[0].poll() is None
    failed = await asyncio.wait_for(collect(transport, 'crash', sid=sid), 5)
    assert any(e.type == 'error' for e in failed)
    assert transport.processes[0].poll() is not None
    assert all(getattr(transport.processes[0], name).closed for name in ('stdin','stdout','stderr'))
    resumed = await asyncio.wait_for(collect(transport, 'recovered', sid=sid), 5)
    assert session(resumed) == sid and text(resumed) == 'recovered'
    assert len(transport.clients) == 2


@pytest.mark.parametrize('decision', ['allow_once', 'reject_once'])
async def test_real_sdk_parallel_approval_isolation_and_stop(transport, monkeypatch, decision):
    first = await collect(transport, 'seed')
    sid = session(first)
    a, b = CodexSDKEngine(), CodexSDKEngine()
    monkeypatch.setattr(a, 'runtime_permission_decision', lambda: None)
    events = asyncio.Queue()
    async def consume():
        async for event in a.spawn(prompt='approve', cwd=str(transport.root), session_id=sid):
            transport.track()
            await events.put(event)
    waiting = asyncio.create_task(consume())
    try:
        while True:
            event = await asyncio.wait_for(events.get(), 5)
            if event.type == 'interaction_request':
                break
        # A's approval is pending; the SAME SDK reader still dispatches B.
        response_b = await asyncio.wait_for(collect(transport, 'other', engine=b), 5)
        assert text(response_b) == 'other' and not waiting.done()
        assert await a.respond_interaction(event.data, {'outcome': {'option_id': decision}})
        await asyncio.wait_for(waiting, 5)
        output = []
        while not events.empty():
            output.append(events.get_nowait())
        assert text(output) == ('accepted' if decision == 'allow_once' else 'denied')
        assert len(transport.processes) == 1
        assert all(p.poll() is None for p in transport.processes)

        stream = a.spawn(prompt='wait', cwd=str(transport.root), session_id=sid)
        async for item in stream:
            if item.type == 'session_started':
                break
        await a.stop()
        await stream.aclose()
        assert transport.processes[0].poll() is None
        assert (str(transport.root), sid) not in transport.pool._entries
        assert text(await collect(transport, 'still-alive', sid=session(response_b))) == 'still-alive'
    finally:
        if not waiting.done():
            await a.stop()
        await asyncio.gather(waiting, return_exceptions=True)


async def test_real_sdk_live_injection_plan_and_idle_cleanup(transport):
    first = await collect(transport, 'seed')
    sid = session(first)
    queue = asyncio.Queue()
    queue.put_nowait(('message-1', 'injected'))
    events = await asyncio.wait_for(collect(transport, 'wait', sid=sid, live_message_queue=queue), 5)
    assert text(events) == 'steered'
    assert any(e.type == 'live_message' and e.data['status'] == 'delivered' for e in events)
    await asyncio.wait_for(collect(transport, 'plan', sid=sid, plan_mode=True), 5)
    wire = [json.loads(line) for line in (transport.root / 'wire.jsonl').read_text().splitlines()]
    assert any(row['method'] == 'turn/start' and row['params'].get('collaborationMode', {}).get('mode') == 'plan' for row in wire)
    assert sum(row['method'] == 'thread/start' for row in wire) == 1
    assert not any(row['method'] == 'thread/resume' for row in wire)
    transport.pool.idle_seconds = 0.01
    await collect(transport, 'done', sid=sid)
    await asyncio.sleep(0.1)
    assert all(p.poll() is not None for p in transport.processes)


async def test_real_sdk_idle_worker_cap_reaps_process_tree_and_resumes(transport):
    first = await collect(transport, 'spawn-helper')
    sid = session(first)
    original = transport.processes[0]
    helper = psutil.Process(int(text(first)))
    assert helper.ppid() == original.pid

    for name in ('second-project', 'third-project'):
        cwd = transport.root / name
        cwd.mkdir()
        assert text(await collect(transport, name, cwd=cwd)) == name

    # Resume immediately while the evicted transport may still be closing.
    resumed = await asyncio.wait_for(collect(transport, 'resumed', sid=sid), 5)
    assert session(resumed) == sid
    assert text(resumed) == 'resumed'
    assert original.poll() is not None
    try:
        assert not helper.is_running() or helper.status() == psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        pass
    assert len(transport.pool._workers) == 2
    assert any(row['params']['threadId'] == sid for row in wire(transport, 'thread/resume'))


async def test_real_sdk_one_warm_worker_survives_ttl_and_reaps_replaced_tree(transport):
    transport.pool.keep_warm = True
    transport.pool.max_idle_workers = 1
    transport.pool.idle_seconds = .01
    first = await collect(transport, 'spawn-helper')
    sid = session(first)
    original = transport.processes[0]
    helper = psutil.Process(int(text(first)))
    await asyncio.sleep(.1)
    assert original.poll() is None
    assert session(await collect(transport, 'warm', sid=sid)) == sid
    assert len(transport.clients) == 1
    assert not wire(transport, 'thread/resume')

    cwd = transport.root / 'other'
    cwd.mkdir()
    await collect(transport, 'other', cwd=cwd)
    await asyncio.sleep(.1)
    assert original.poll() is not None
    assert len(transport.pool._workers) == 1
    try:
        assert not helper.is_running() or helper.status() == psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        pass
    resumed = await collect(transport, 'restored', sid=sid)
    assert session(resumed) == sid and text(resumed) == 'restored'
    assert any(row['params']['threadId'] == sid for row in wire(transport, 'thread/resume'))
    assert len(transport.pool._workers) == 1


async def test_real_sdk_retained_thread_survives_expiry_and_other_projects_then_transfers(transport):
    from engines.core.session_retention import session_retention, release_session_retention
    pool = transport.pool
    pool.max_idle_workers = 1
    pool.idle_seconds = .01
    with session_retention('data-center'):
        sid = session(await collect(transport, 'seed'))
    original = transport.processes[0]
    await collect(transport, 'neighbor')
    await asyncio.sleep(.1)
    assert original.poll() is None
    assert (str(transport.root), sid) in pool._entries
    other = transport.root / 'ordinary-project'
    other.mkdir()
    await collect(transport, 'ordinary', cwd=other)
    assert len(pool._workers) == 1
    with session_retention('data-center'):
        resumed = await collect(transport, 'same', sid=sid)
    assert session(resumed) == sid and original.poll() is None
    assert not wire(transport, 'thread/resume')
    pool.idle_seconds = 60
    old = pool._entries[(str(transport.root), sid)]
    await release_session_retention('data-center')
    with session_retention('data-center'):
        new_sid = session(await collect(transport, 'new-context'))
    pool._expire(old)
    await asyncio.shield(old.closing)
    await asyncio.sleep(.1)
    assert new_sid != sid and original.poll() is None
    assert (str(transport.root), sid) not in pool._entries
    assert pool._entries[(str(transport.root), new_sid)].retention_owner == 'data-center'


async def test_real_sdk_warm_instructions_images_compaction_and_fork(transport):
    from engines.core.schema import EngineImage
    first = await collect(transport, 'seed', system_prompt='first rules')
    sid = session(first)
    image = transport.root / 'image.png'
    image.write_bytes(b'synthetic image reference; fixture never decodes it')
    updated = await collect(transport, 'image request', sid=sid, system_prompt='updated rules',
                            images=[EngineImage(path=str(image))])
    assert text(updated).strip() == 'image request'
    compacted = await asyncio.wait_for(collect(transport, '/compact', sid=sid), 5)
    assert any(e.type == 'compacted' for e in compacted)
    forked = await CodexSDKEngine().fork_session(sid, str(transport.root))
    assert forked and forked != sid
    wire = [json.loads(line) for line in (transport.root / 'wire.jsonl').read_text().splitlines()]
    updates = [row for row in wire if row['method'] == 'thread/inject_items']
    assert len(updates) == 1 and 'updated rules' in json.dumps(updates[0])
    image_turn = next(row for row in wire if row['method'] == 'turn/start' and any(
        part.get('type') == 'localImage' for part in row['params']['input']))
    assert any(part.get('path') == str(image) for part in image_turn['params']['input'])
    # Fork's short-lived client closed; the main session is still reusable.
    assert transport.processes[0].poll() is None


@pytest.mark.parametrize('shutdown', ['stop', 'pool'])
@pytest.mark.parametrize('retained', [False, True])
async def test_real_sdk_stop_while_reader_waits_for_approval(transport, monkeypatch, shutdown, retained):
    from engines.core.session_retention import session_retention
    engine = CodexSDKEngine()
    monkeypatch.setattr(engine, 'runtime_permission_decision', lambda: None)
    stream = engine.spawn(prompt='approve-wait', cwd=str(transport.root))
    try:
        with session_retention('main' if retained else None):
            async for event in stream:
                transport.track()
                if event.type == 'interaction_request':
                    break
        assert transport.processes and transport.processes[0].poll() is None
        if shutdown == 'stop':
            await engine.stop()
        else:
            await transport.pool.close()
        await stream.aclose()
        assert transport.processes[0].poll() is not None
        assert not engine._pending_interaction_responses
    finally:
        await engine.stop()
        await stream.aclose()


async def test_codex_and_speech_shutdown_do_not_kill_each_other(transport):
    from services.speech_runtime import SpeechRuntime
    worker = transport.root / 'speech-peer.py'
    worker.write_text("import sys,json\nfor line in sys.stdin:\n r=json.loads(line);print(json.dumps({'session_id':r['session_id'],'text':'speech-ok'}),flush=True)\n")
    speech = SpeechRuntime()
    command = [sys.executable, '-u', str(worker)]
    try:
        assert await speech.infer(command, b'', 'voice', False) == 'speech-ok'
        voice_proc = speech.process
        first = await collect(transport, 'hello')
        sid = session(first)
        await CodexSDKEngine().close_session(sid, str(transport.root))
        assert transport.processes[0].poll() is not None
        assert voice_proc.returncode is None
        assert await speech.infer(command, b'', 'voice', True) == 'speech-ok'
        await collect(transport, 'resumed', sid=sid)
        codex_proc = transport.processes[-1]
        await speech.close()
        assert voice_proc.returncode is not None
        assert codex_proc.poll() is None
    finally:
        await speech.close()


def wire(transport, method):
    return [row for line in (transport.root / 'wire.jsonl').read_text().splitlines()
            if (row := json.loads(line))['method'] == method]


def goal_status(events):
    return [e.data['status'] for e in events if e.type == 'goal_update']


async def test_real_sdk_plan_default_switching_and_other_session_isolation(transport):
    first = await collect(transport, 'effective-mode', plan_mode=True)
    sid = session(first)
    assert text(first) == 'plan'
    for enabled in [False, True, False]:
        events = await collect(transport, 'effective-mode', sid=sid, plan_mode=enabled)
        assert text(events) == ('plan' if enabled else 'default')
    assert len(transport.clients) == 1
    other = await collect(transport, 'effective-mode', plan_mode=False)
    assert session(other) != sid and text(other) == 'default'
    assert len(transport.clients) == 1


@pytest.mark.parametrize('recovery', ['warm', 'ttl', 'lru', 'config'])
async def test_real_sdk_goal_after_plan_and_resume_after_reclamation(transport, monkeypatch, recovery):
    first = await collect(transport, 'effective-mode', plan_mode=True)
    sid = session(first)
    if recovery == 'ttl':
        transport.pool.idle_seconds = 0.01
    paused = await asyncio.wait_for(collect(transport, 'goal-pause', sid=sid, goal_action='start'), 5)
    assert not any(e.type == 'error' for e in paused)
    assert goal_status(paused)[-1] == 'paused'
    assert text(paused) == 'goal-firstgoal-second', [e.to_dict() for e in paused]
    original = transport.processes[0]
    if recovery == 'ttl':
        await asyncio.sleep(0.1)
        assert original.poll() is not None
        transport.pool.idle_seconds = 60
    elif recovery == 'lru':
        transport.pool.max_idle = 1
        await collect(transport, 'other-session')
        assert original.poll() is None
        assert (str(transport.root), sid) not in transport.pool._entries
    elif recovery == 'config':
        monkeypatch.setattr('engines.codex_sdk.config_store.get_codex_sdk_config', lambda: {
            'sandbox': 'read-only', 'approval_mode': '', 'model_reasoning_effort': 'high',
        })
    # Resume generates native continuation turns, without resending the objective.
    resumed = await asyncio.wait_for(collect(transport, '', sid=sid, goal_action='resume'), 5)
    assert not any(e.type == 'error' for e in resumed)
    assert goal_status(resumed)[-1] == 'paused'
    assert text(resumed) == 'goal-firstgoal-second'
    if recovery == 'warm':
        assert len(transport.clients) == 1 and original.poll() is None
    else:
        assert (original.poll() is None) == (recovery == 'lru')
        assert any(row['params']['threadId'] == sid for row in wire(transport, 'thread/resume'))
    latest = await collect(transport, '', sid=sid, goal_action='status')
    assert goal_status(latest) == ['paused']
    paused_again = await collect(transport, '', sid=sid, goal_action='pause')
    assert goal_status(paused_again) == ['paused']
    cleared = await collect(transport, '', sid=sid, goal_action='clear')
    assert goal_status(cleared) == ['cleared']
    assert goal_status(await collect(transport, '', sid=sid, goal_action='status')) == ['cleared']
    normal = await collect(transport, 'effective-mode', sid=sid, plan_mode=False)
    assert text(normal) == 'default'
    goal_start = next(row for row in wire(transport, 'turn/start')
                      if row['params']['input'][0].get('text') == 'goal-pause')
    assert goal_start['params']['collaborationMode']['mode'] == 'default'


@pytest.mark.parametrize('stop_kind', ['stop', 'cancel_session', 'task_cancel', 'pool_close'])
async def test_real_sdk_active_goal_never_expires_and_cleans_up_on_stop(transport, stop_kind):
    transport.pool.idle_seconds = 0.01
    engine = CodexSDKEngine()
    events = []
    ready = asyncio.Event()
    async def run():
        async for event in engine.spawn(prompt='goal-wait', cwd=str(transport.root), goal_action='start'):
            transport.track()
            events.append(event)
            if event.type == 'goal_update' and event.data['status'] == 'active':
                ready.set()
    task = asyncio.create_task(run())
    try:
        await asyncio.wait_for(ready.wait(), 5)
        sid = session(events)
        process = transport.processes[0]
        await asyncio.sleep(0.06)
        assert process.poll() is None and not task.done()
        if stop_kind != 'pool_close':
            # A separate session stays active/idle independently of goal cancellation.
            transport.pool.idle_seconds = 60
            other = await collect(transport, 'other', plan_mode=True)
            other_process = transport.processes[-1]
        if stop_kind == 'stop':
            await engine.stop()
        elif stop_kind == 'cancel_session':
            await engine.cancel_session(sid, str(transport.root))
        elif stop_kind == 'task_cancel':
            task.cancel()
        else:
            await transport.pool.close()
        await asyncio.wait_for(task, 5)
        assert (process.poll() is not None) == (stop_kind == 'pool_close')
        assert (str(transport.root), sid) not in transport.pool._entries
        assert engine._goal_state is None
        if stop_kind != 'pool_close':
            assert other_process.poll() is None
            after = await collect(transport, 'effective-mode', sid=session(other), plan_mode=False)
            assert text(after) == 'default'
        if stop_kind in {'stop', 'cancel_session', 'task_cancel'}:
            assert any(row['params'].get('status') == 'paused'
                       for row in wire(transport, 'thread/goal/set'))
            status = await collect(transport, '', sid=sid, goal_action='status')
            assert goal_status(status) == ['paused']
    finally:
        if not task.done():
            await engine.stop()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize('objective', ['goal-set-fail', 'goal-crash'])
async def test_real_sdk_goal_failure_discards_transport_and_resumes_session(transport, objective):
    seed = await collect(transport, 'seed')
    sid = session(seed)
    failed = await asyncio.wait_for(collect(transport, objective, sid=sid, goal_action='start'), 5)
    assert any(e.type == 'error' for e in failed)
    assert transport.processes[0].poll() is not None
    if objective == 'goal-set-fail':
        assert wire(transport, 'turn/interrupt')
    recovered = await collect(transport, 'effective-mode', sid=sid, plan_mode=False)
    assert session(recovered) == sid and text(recovered) == 'default'


@pytest.mark.parametrize('decision', ['allow_once', 'reject_once'])
async def test_real_sdk_goal_approval_parallel_normal_turn(transport, monkeypatch, decision):
    first = await collect(transport, 'plan', plan_mode=True)
    sid = session(first)
    engine = CodexSDKEngine()
    monkeypatch.setattr(engine, 'runtime_permission_decision', lambda: None)
    outputs = []
    ready = asyncio.Queue()
    async def run():
        async for event in engine.spawn(prompt='goal-approve', cwd=str(transport.root),
                                       session_id=sid, goal_action='start'):
            outputs.append(event)
            transport.track()
            if event.type == 'interaction_request':
                await ready.put(event)
    task = asyncio.create_task(run())
    try:
        interaction = await asyncio.wait_for(ready.get(), 5)
        other = await collect(transport, 'effective-mode', plan_mode=False)
        assert text(other) == 'default' and not task.done()
        assert await engine.respond_interaction(interaction.data, {'outcome': {'option_id': decision}})
        await asyncio.wait_for(task, 5)
        assert goal_status(outputs)[-1] == ('complete' if decision == 'allow_once' else 'blocked')
        assert text(outputs) == ('accepted' if decision == 'allow_once' else 'denied')
        assert len(transport.clients) == 1
        assert text(await collect(transport, 'effective-mode', sid=sid, plan_mode=False)) == 'default'
    finally:
        if not task.done():
            await engine.stop()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize(('objective', 'expected'), [
    ('goal-complete', 'complete'), ('goal-blocked', 'blocked'),
    ('goal-budget', 'budgetLimited'), ('goal-usage', 'usageLimited'),
    ('goal-turn-fail', 'blocked'),
])
async def test_real_sdk_terminal_goal_preserves_final_text_and_failure(transport, objective, expected):
    first = await collect(transport, 'seed')
    sid = session(first)
    result = await asyncio.wait_for(collect(transport, objective, sid=sid, goal_action='start'), 5)
    assert goal_status(result) == ['active', expected]
    assert text(result) == 'goal-firstgoal-second'
    errors = [e for e in result if e.type == 'error']
    if objective == 'goal-turn-fail':
        assert errors and transport.processes[0].poll() is not None
    else:
        assert not errors and transport.processes[0].poll() is None
        assert len(transport.clients) == 1


@pytest.mark.parametrize('shutdown', ['stop', 'pool', 'task_cancel'])
async def test_real_sdk_goal_stop_during_pending_approval(transport, monkeypatch, shutdown):
    engine = CodexSDKEngine()
    monkeypatch.setattr(engine, 'runtime_permission_decision', lambda: None)
    ready = asyncio.Event()
    events = []
    async def run():
        async for event in engine.spawn(prompt='goal-approve', cwd=str(transport.root), goal_action='start'):
            transport.track()
            events.append(event)
            if event.type == 'interaction_request':
                ready.set()
    task = asyncio.create_task(run())
    try:
        await asyncio.wait_for(ready.wait(), 5)
        if shutdown == 'stop':
            await asyncio.wait_for(engine.stop(), 2)
        elif shutdown == 'pool':
            await asyncio.wait_for(transport.pool.close(), 2)
        else:
            task.cancel()
        await asyncio.wait_for(task, 2)
        assert engine._goal_state is None
        assert not engine._pending_interaction_responses
        assert all(p.poll() is not None for p in transport.processes)
    finally:
        await transport.pool.close()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)

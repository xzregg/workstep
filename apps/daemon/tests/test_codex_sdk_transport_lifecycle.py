"""Exercise the real optional SDK and real subprocesses with an offline peer."""
import asyncio
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

from engines.codex_sdk import CodexSDKEngine
from engines.codex_sdk_clients import CodexClientPool
from engines.core.base import ProviderRuntimeConfig


@pytest.fixture
async def transport(monkeypatch, tmp_path):
    monkeypatch.setenv('CODEX_HOME', str(tmp_path / 'codex-home'))
    sdk = pytest.importorskip('openai_codex')
    original = sdk.AsyncCodex
    clients, processes = [], []
    pool = CodexClientPool(idle_seconds=60)
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
        assert all(p.poll() is not None for p in processes)


async def collect(transport, prompt, *, sid=None, engine=None, **kwargs):
    events = []
    engine = engine or CodexSDKEngine()
    async for event in engine.spawn(prompt=prompt, cwd=str(transport.root), session_id=sid, **kwargs):
        events.append(event)
        transport.track()
    return events


def session(events):
    return next(e.data['session_id'] for e in events if e.type == 'session_started')


def text(events):
    return ''.join(e.data['content']['text'] for e in events if e.type == 'agent_message_chunk')


@pytest.mark.anyio
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
    resumed = await asyncio.wait_for(collect(transport, 'recovered', sid=sid), 5)
    assert session(resumed) == sid and text(resumed) == 'recovered'
    assert len(transport.clients) == 2


@pytest.mark.anyio
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
        # A's SDK reader is blocked in its synchronous approval callback.
        response_b = await asyncio.wait_for(collect(transport, 'other', engine=b), 5)
        assert text(response_b) == 'other' and not waiting.done()
        assert await a.respond_interaction(event.data, {'outcome': {'option_id': decision}})
        await asyncio.wait_for(waiting, 5)
        output = []
        while not events.empty():
            output.append(events.get_nowait())
        assert text(output) == ('accepted' if decision == 'allow_once' else 'denied')
        assert len(transport.processes) == 2
        assert all(p.poll() is None for p in transport.processes)

        stream = a.spawn(prompt='wait', cwd=str(transport.root), session_id=sid)
        async for item in stream:
            if item.type == 'session_started':
                break
        await a.stop()
        await stream.aclose()
        assert transport.processes[0].poll() is not None
        assert transport.processes[1].poll() is None
    finally:
        if not waiting.done():
            await a.stop()
        await asyncio.gather(waiting, return_exceptions=True)


@pytest.mark.anyio
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


@pytest.mark.anyio
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


@pytest.mark.anyio
@pytest.mark.parametrize('shutdown', ['stop', 'pool'])
async def test_real_sdk_stop_while_reader_waits_for_approval(transport, monkeypatch, shutdown):
    engine = CodexSDKEngine()
    monkeypatch.setattr(engine, 'runtime_permission_decision', lambda: None)
    stream = engine.spawn(prompt='approve-wait', cwd=str(transport.root))
    try:
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


@pytest.mark.anyio
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


@pytest.mark.anyio
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
    assert len(transport.clients) == 2


@pytest.mark.anyio
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
        assert original.poll() is not None
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
        assert original.poll() is not None
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


@pytest.mark.anyio
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
        assert process.poll() is not None
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


@pytest.mark.anyio
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


@pytest.mark.anyio
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
        assert len(transport.clients) == 2
        assert text(await collect(transport, 'effective-mode', sid=sid, plan_mode=False)) == 'default'
    finally:
        if not task.done():
            await engine.stop()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.anyio
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


@pytest.mark.anyio
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

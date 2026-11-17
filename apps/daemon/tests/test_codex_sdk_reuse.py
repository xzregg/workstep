"""Session-scoped Codex transport ownership and adapter regression tests."""
import asyncio
from types import SimpleNamespace

import pytest

from engines.codex_sdk_clients import CodexClientPool


def test_fingerprint_tracks_runtime_identity_and_files_without_exposing_secrets(tmp_path):
    from engines.codex_sdk_clients import client_fingerprint
    config = SimpleNamespace(codex_bin=None, cwd=str(tmp_path), config_overrides=('skills=[]',),
                             env={'CODEX_HOME': str(tmp_path), 'API_KEY': 'synthetic-secret'})
    kwargs = {'config': {}, 'developer_instructions': 'initial rules'}
    first = client_fingerprint(config, kwargs)
    assert len(first) == 64 and 'synthetic-secret' not in first
    assert first == client_fingerprint(config, {'config': {}})
    config.env['API_KEY'] = 'changed'
    second = client_fingerprint(config, kwargs)
    assert second != first
    (tmp_path / 'auth.json').write_text('{}')
    assert client_fingerprint(config, kwargs) != second
    instructions = tmp_path / 'rules.md'
    instructions.write_text('one')
    kwargs['config']['model_instructions_file'] = '"rules.md"'
    before = client_fingerprint(config, kwargs)
    instructions.write_text('a different set of rules')
    assert client_fingerprint(config, kwargs) != before


class Client:
    def __init__(self):
        self.closed = 0

    async def close(self):
        self.closed += 1


@pytest.mark.anyio
async def test_reuse_is_exclusive_and_configuration_changes_rebuild():
    pool = CodexClientPool(idle_seconds=60)
    first = await pool.acquire('/project', None, 'config-a', Client)
    pool.bind(first, 'session-a', SimpleNamespace(id='session-a'))
    with pytest.raises(RuntimeError, match='正在执行'):
        await pool.acquire('/project', 'session-a', 'config-a', Client)
    await pool.release(first, reusable=True)
    second = await pool.acquire('/project', 'session-a', 'config-a', Client)
    assert second is first and second.client.closed == 0
    await pool.release(second, reusable=True)
    changed = await pool.acquire('/project', 'session-a', 'config-b', Client)
    assert changed is not first and first.client.closed == 1
    await pool.release(changed, reusable=False)
    assert changed.client.closed == 1
    await pool.close()


@pytest.mark.anyio
async def test_sessions_and_projects_are_isolated_and_busy_entries_never_evicted():
    pool = CodexClientPool(idle_seconds=60, max_idle=1)
    a = await pool.acquire('/one', 'a', 'same', Client)
    b = await pool.acquire('/one', 'b', 'same', Client)
    c = await pool.acquire('/two', 'a', 'same', Client)
    for entry in (a, b, c):
        pool.bind(entry, entry.key[1], SimpleNamespace(id=entry.key[1]))
    assert a.client is b.client and c.client is not a.client
    await pool.release(b, reusable=True)
    await pool.release(c, reusable=True)
    assert b.client.closed == 0 and a.client.closed == 0
    assert ('/one', 'b') not in pool._entries
    await pool.close()
    assert all(e.client.closed == 1 for e in (a, b, c))
    # Late completion after shutdown cannot put a client back into the pool.
    await pool.release(a, reusable=True)
    assert a.client.closed == 1


@pytest.mark.anyio
async def test_idle_timeout_and_dead_process_are_reclaimed():
    pool = CodexClientPool(idle_seconds=0.01)
    entry = await pool.acquire('/one', 'a', 'same', Client)
    pool.bind(entry, 'a', SimpleNamespace(id='a'))
    await pool.release(entry, reusable=True)
    await asyncio.sleep(0.05)
    assert entry.client.closed == 1
    dead = await pool.acquire('/one', 'a', 'same', Client)
    pool.bind(dead, 'a', SimpleNamespace(id='a'))
    dead.client._client = SimpleNamespace(_sync=SimpleNamespace(_proc=SimpleNamespace(poll=lambda: 9)))
    await pool.release(dead, reusable=True)
    replaced = await pool.acquire('/one', 'a', 'same', Client)
    assert replaced is not dead and dead.client.closed == 1
    await pool.close()


@pytest.mark.anyio
async def test_shutdown_during_process_probe_cannot_return_a_closed_lease():
    import threading
    entered = threading.Event()
    unblock = threading.Event()
    pool = CodexClientPool()
    entry = await pool.acquire('/one', 'a', 'same', Client)
    pool.bind(entry, 'a', SimpleNamespace(id='a'))
    def slow_poll():
        entered.set()
        unblock.wait(2)
        return None
    entry.client._client = SimpleNamespace(_sync=SimpleNamespace(_proc=SimpleNamespace(poll=slow_poll)))
    await pool.release(entry, reusable=True)
    acquiring = asyncio.create_task(pool.acquire('/one', 'a', 'same', Client))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        await pool.close()
        unblock.set()
        with pytest.raises(RuntimeError, match='已关闭'):
            await acquiring
        assert entry.client.closed == 1
    finally:
        unblock.set()
        await pool.close()


@pytest.mark.anyio
async def test_idle_eviction_rechecks_lease_ownership_after_awaiting_close():
    from engines.core.session_pool import SessionClientPool
    pool = SessionClientPool(max_idle=3)
    entered, unblock = asyncio.Event(), asyncio.Event()
    entries = []
    for sid in ('a', 'b', 'c'):
        entry = await pool.acquire('/one', sid, 'same', Client)
        pool.bind(entry, sid, SimpleNamespace(id=sid))
        entries.append(entry)
    a, b, c = entries
    await pool.release(a, reusable=True)
    await pool.release(b, reusable=True)
    original_close = a.client.close
    async def slow_close():
        entered.set()
        await unblock.wait()
        await original_close()
    a.client.close = slow_close
    pool.max_idle = 0
    releasing = asyncio.create_task(pool.release(c, reusable=True))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        assert await pool.acquire('/one', 'b', 'same', Client) is b
        unblock.set()
        await releasing
        assert b.busy and b.client.closed == 0
    finally:
        unblock.set()
        await releasing
        await pool.close()


@pytest.fixture
def fake_sdk(monkeypatch):
    import sys
    from types import ModuleType
    openai_codex = ModuleType('openai_codex')
    openai_codex.CodexConfig = SimpleNamespace
    openai_codex.AsyncTurnHandle = SimpleNamespace
    openai_codex.ApprovalMode = lambda value: value
    openai_codex.Sandbox = SimpleNamespace(read_only='read-only', workspace_write='workspace-write', full_access='full')
    monkeypatch.setitem(sys.modules, 'openai_codex', openai_codex)
    from engines.codex_sdk import CodexSDKEngine
    from engines.core.base import ProviderRuntimeConfig
    pool = CodexClientPool()
    monkeypatch.setattr('engines.codex_sdk.get_codex_client_pool', lambda: pool)

    clients = []
    gate = asyncio.Event()

    class Turn:
        def __init__(self, prompt, client, thread_id):
            self.prompt = prompt
            self.client = client
            self.thread_id = thread_id

        async def interrupt(self):
            pass

        async def stream(self):
            if self.prompt == 'wait':
                await gate.wait()
            if self.prompt == 'fail':
                raise RuntimeError('synthetic transport failure')
            if self.prompt == 'ask':
                result = await asyncio.to_thread(
                    self.client._client._sync._approval_handler,
                    'item/tool/requestUserInput',
                    {'threadId': self.thread_id, 'questions': [
                        {'id': 'choice', 'header': 'Choice', 'question': 'Which?',
                         'options': [{'label': 'A', 'description': 'First'}]},
                    ]},
                )
                self.client.answers.append(result)
            if self.prompt == 'approve':
                result = await asyncio.to_thread(
                    self.client._client._sync._approval_handler,
                    'item/commandExecution/requestApproval',
                    {'threadId': self.thread_id, 'command': 'synthetic command', 'itemId': 'tool-1'},
                )
                self.client.answers.append(result)
            if False:
                yield

    class Thread:
        def __init__(self, thread_id, client):
            self.id = thread_id
            self.client = client

        async def turn(self, prompt, **kwargs):
            return Turn(prompt, self.client, self.id)

    class SDKClient(Client):
        def __init__(self, **kwargs):
            super().__init__()
            self._client = SimpleNamespace(_sync=SimpleNamespace(_approval_handler=None))
            self.starts = self.resumes = 0
            self.answers = []
            clients.append(self)

        async def thread_start(self, **kwargs):
            self.starts += 1
            return Thread(f'session-{len(clients)}-{self.starts}', self)

        async def thread_resume(self, session_id, **kwargs):
            self.resumes += 1
            return Thread(session_id, self)

    openai_codex.AsyncCodex = SDKClient
    monkeypatch.setattr(CodexSDKEngine, '_sdk_available', staticmethod(lambda: True))
    monkeypatch.setattr(CodexSDKEngine, 'project_skills', lambda *args: [])
    monkeypatch.setattr(CodexSDKEngine, 'get_binary_override', staticmethod(lambda: None))
    monkeypatch.setattr(CodexSDKEngine, 'resolve_provider_runtime', lambda *args, **kwargs: ProviderRuntimeConfig())
    monkeypatch.setattr('services.skill_runtime.prepare_codex_skills', lambda *args: ([], 'skills=[]'))
    monkeypatch.setattr('engines.codex_sdk.config_store.get_codex_sdk_config', lambda: {
        'sandbox': 'read-only', 'approval_mode': '', 'model_reasoning_effort': '',
    })
    return SimpleNamespace(clients=clients, gate=gate, pool=pool)


async def collect(engine, cwd, prompt='hello', session_id=None, **kwargs):
    return [event async for event in engine.spawn(prompt=prompt, cwd=str(cwd), session_id=session_id, **kwargs)]


@pytest.mark.anyio
async def test_adapter_reuses_across_engine_instances_and_rebinds_approval_handler(fake_sdk, tmp_path):
    from engines.codex_sdk import CodexSDKEngine

    try:
        first = CodexSDKEngine()
        events = await collect(first, tmp_path)
        sid = next(e.data['session_id'] for e in events if e.type == 'session_started')
        client = fake_sdk.clients[0]
        assert client.closed == 0
        idle_handler = client._client._sync._approval_handler
        assert idle_handler('item/commandExecution/requestApproval', {}) == {'decision': 'deny'}
        second = CodexSDKEngine()
        bindings = []
        original = fake_sdk.pool.set_handler
        def install(c, handler):
            bindings.append(handler)
            original(c, handler)
        fake_sdk.pool.set_handler = install
        await collect(second, tmp_path, session_id=sid)
        assert len(fake_sdk.clients) == 1
        assert (client.starts, client.resumes, client.closed) == (1, 0, 0)
        assert bindings[0] is not idle_handler
        await second.close_session(sid, str(tmp_path))
        assert client.closed == 1
    finally:
        await fake_sdk.pool.close()


@pytest.mark.anyio
async def test_adapter_rebinds_questions_and_waiting_approval_does_not_block_other_session(fake_sdk, tmp_path):
    from engines.codex_sdk import CodexSDKEngine

    queue = asyncio.Queue()
    async def consume(engine):
        async for event in engine.spawn(prompt='ask', cwd=str(tmp_path), session_id='a'):
            await queue.put(event)

    async def question():
        while True:
            event = await queue.get()
            if event.type == 'interaction_request':
                return event

    try:
        old, current = CodexSDKEngine(), CodexSDKEngine()
        await collect(old, tmp_path, session_id='a')
        task = asyncio.create_task(consume(current))
        event = await asyncio.wait_for(question(), 1)
        await asyncio.wait_for(collect(CodexSDKEngine(), tmp_path, session_id='b'), 1)
        assert not getattr(old, '_pending_interaction_responses', {})
        await old.respond_interaction(event.data, {'action': 'accept', 'content': {'choice': 'A'}})
        await asyncio.sleep(0)
        assert not task.done()
        assert await current.respond_interaction(event.data, {'action': 'accept', 'content': {'choice': 'A'}})
        await asyncio.wait_for(task, 1)
        assert fake_sdk.clients[0].answers == [{'answers': {'choice': {'answers': ['A']}}}]
        assert len(fake_sdk.clients) == 1

        # Stopping while the SDK reader waits on a response must unblock it,
        # retire just this session and leave the shared process reusable.
        task = asyncio.create_task(consume(current))
        await asyncio.wait_for(question(), 1)
        await current.stop()
        await asyncio.wait_for(task, 1)
        assert not current._pending_interaction_responses
        assert fake_sdk.clients[0].closed == 0
        assert ('%s' % tmp_path, 'a') not in fake_sdk.pool._entries
    finally:
        await fake_sdk.pool.close()


@pytest.mark.anyio
async def test_adapter_early_stream_close_and_same_instance_concurrency(fake_sdk, tmp_path):
    from engines.codex_sdk import CodexSDKEngine

    engine = CodexSDKEngine()
    stream = engine.spawn(prompt='wait', cwd=str(tmp_path), session_id='a')
    try:
        async for event in stream:
            if event.type == 'session_started':
                break
        conflict = await collect(engine, tmp_path, session_id='b')
        assert any(e.type == 'error' and '正在执行' in e.data['message'] for e in conflict)
        await stream.aclose()
        assert fake_sdk.clients[0].closed == 1
        assert not engine._spawn_active and not engine._running
        await collect(engine, tmp_path, session_id='a')
        assert len(fake_sdk.clients) == 2
    finally:
        await stream.aclose()
        await fake_sdk.pool.close()


@pytest.mark.anyio
async def test_slow_config_probe_and_close_leave_loop_responsive(fake_sdk, monkeypatch, tmp_path):
    import time
    from engines.codex_sdk import CodexSDKEngine
    from engines.codex_sdk_clients import client_fingerprint

    entered = asyncio.Event()
    loop = asyncio.get_running_loop()
    def slow_probe(*args):
        loop.call_soon_threadsafe(entered.set)
        time.sleep(0.15)
        return client_fingerprint(*args)
    monkeypatch.setattr('engines.codex_sdk.client_fingerprint', slow_probe)
    try:
        task = asyncio.create_task(collect(CodexSDKEngine(), tmp_path))
        await asyncio.wait_for(entered.wait(), 1)
        # The disk probe is still sleeping in its worker while this canary runs.
        await asyncio.wait_for(asyncio.sleep(0.01), 0.05)
        assert not task.done()
        await task
        original_close = fake_sdk.clients[0].close
        async def slow_close():
            await asyncio.to_thread(time.sleep, 0.15)
            await original_close()
        fake_sdk.clients[0].close = slow_close
        closing = asyncio.create_task(fake_sdk.pool.close())
        await asyncio.wait_for(asyncio.sleep(0.01), 0.05)
        assert not closing.done()
        await closing
    finally:
        await fake_sdk.pool.close()


@pytest.mark.anyio
async def test_stop_during_preparation_does_not_start_a_late_client(fake_sdk, monkeypatch, tmp_path):
    import threading
    from engines.codex_sdk import CodexSDKEngine
    from engines.codex_sdk_clients import client_fingerprint
    entered = threading.Event()
    unblock = threading.Event()
    def slow_probe(*args):
        entered.set()
        unblock.wait(2)
        return client_fingerprint(*args)
    monkeypatch.setattr('engines.codex_sdk.client_fingerprint', slow_probe)
    engine = CodexSDKEngine()
    task = asyncio.create_task(collect(engine, tmp_path))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        await engine.stop()
        unblock.set()
        events = await asyncio.wait_for(task, 1)
        assert not fake_sdk.clients
        assert any(e.type == 'status' and e.data['status'] == 'cancelled' for e in events)
    finally:
        unblock.set()
        await fake_sdk.pool.close()


@pytest.mark.anyio
async def test_native_tool_approval_on_reused_client_uses_current_engine(fake_sdk, monkeypatch, tmp_path):
    from engines.codex_sdk import CodexSDKEngine
    try:
        await collect(CodexSDKEngine(), tmp_path, session_id='a')
        current = CodexSDKEngine()
        monkeypatch.setattr(current, 'runtime_permission_decision', lambda: None)
        seen = []
        async for event in current.spawn(prompt='approve', cwd=str(tmp_path), session_id='a'):
            seen.append(event)
            if event.type == 'interaction_request':
                assert await current.respond_interaction(event.data, {'outcome': {'option_id': 'allow_once'}})
        assert any(e.type == 'interaction_request' for e in seen)
        assert fake_sdk.clients[0].answers == [{'decision': 'accept'}]
        assert fake_sdk.clients[0].closed == 0
        assert not current._pending_interaction_responses
    finally:
        await fake_sdk.pool.close()


@pytest.mark.anyio
async def test_adapter_failure_stop_and_different_sessions_are_isolated(fake_sdk, tmp_path):
    from engines.codex_sdk import CodexSDKEngine

    try:
        a, b = CodexSDKEngine(), CodexSDKEngine()
        running = asyncio.create_task(collect(a, tmp_path, 'wait', 'a'))
        while a._client is None:
            await asyncio.sleep(0)
        # A slow active turn cannot block a distinct session or the event loop.
        await asyncio.wait_for(collect(b, tmp_path, session_id='b'), 1)
        blocked = await collect(CodexSDKEngine(), tmp_path, session_id='a')
        assert any(e.type == 'error' and '正在执行' in e.data['message'] for e in blocked)
        assert fake_sdk.clients[0].closed == 0
        await a.stop()
        await asyncio.wait_for(running, 1)
        assert fake_sdk.clients[0].closed == 0
        assert ('%s' % tmp_path, 'a') not in fake_sdk.pool._entries
        await collect(CodexSDKEngine(), tmp_path, 'fail', 'b')
        assert fake_sdk.clients[0].closed == 1
        await collect(CodexSDKEngine(), tmp_path, session_id='b')
        assert len(fake_sdk.clients) == 2 and fake_sdk.clients[1].resumes == 1
    finally:
        await fake_sdk.pool.close()


@pytest.mark.anyio
async def test_pool_close_has_no_unhandled_event_loop_callback():
    loop = asyncio.get_running_loop()
    previous = loop.get_exception_handler()
    errors = []
    loop.set_exception_handler(lambda _loop, context: errors.append(context))
    pool = CodexClientPool()
    try:
        await pool.acquire('/one', 'a', 'same', Client)
        await pool.close()
        await asyncio.sleep(0)
        assert not errors
    finally:
        loop.set_exception_handler(previous)
        await pool.close()

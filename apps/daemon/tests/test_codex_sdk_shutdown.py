"""Reader callbacks must never escape into a stopped/closed owner loop."""
import asyncio
import gc
import threading
from types import SimpleNamespace
import warnings

import pytest

from engines.codex_sdk_approvals import CodexApprovalRouter

pytestmark = [
    pytest.mark.filterwarnings('error::pytest.PytestUnhandledThreadExceptionWarning'),
    pytest.mark.filterwarnings('error::pytest.PytestUnraisableExceptionWarning'),
    pytest.mark.filterwarnings('error::RuntimeWarning'),
]


def peer():
    failures, writes = [], []
    sync = SimpleNamespace(
        _approval_handler=None,
        _router=SimpleNamespace(fail_all=lambda exc: failures.append(exc)),
        _handle_server_request=lambda request: {},
        _write_message=lambda message: writes.append(message),
    )
    return SimpleNamespace(_client=SimpleNamespace(_sync=sync)), sync, failures, writes


def reader_call(callback):
    errors = []
    values = []
    def invoke():
        try:
            values.append(callback())
        except BaseException as exc:
            errors.append(exc)
    thread = threading.Thread(target=invoke)
    thread.start()
    thread.join(2)
    assert not thread.is_alive()
    assert not errors, errors
    return values[0]


@pytest.mark.parametrize('close_router', [False, True])
def test_reader_eof_after_loop_closed_preserves_native_failure_without_scheduling(close_router):
    client,sync,failures,_ = peer()
    notified = []
    async def initialize():
        router = CodexApprovalRouter(client, lambda: notified.append(True))
        if close_router:
            router.close()
        return router
    router = asyncio.run(initialize())
    assert router.loop.is_closed()
    error = RuntimeError('synthetic EOF')
    reader_call(lambda: sync._router.fail_all(error))
    assert failures == [error] and notified == []


@pytest.mark.parametrize('method,expected', [
    ('item/commandExecution/requestApproval', {'decision':'deny'}),
    ('item/tool/requestUserInput', {'answers':{}}),
    ('mcpServer/elicitation/request', {'action':'cancel','content':None,'_meta':None}),
])
def test_late_server_request_does_not_create_unawaited_coroutine(method,expected):
    # Collect previous tests' SDK objects before observing this request's
    # coroutine lifetime; unrelated objects are not part of this probe.
    gc.collect()
    client,sync,_,_ = peer()
    async def initialize():
        return CodexApprovalRouter(client)
    router = asyncio.run(initialize())
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter('always')
        result = reader_call(lambda: sync._handle_server_request({'id':'late','method':method,'params':{'threadId':'a'}}))
        gc.collect()
    assert result == expected
    assert not captured, [(w.category.__name__,str(w.message)) for w in captured]
    assert not router.pending


@pytest.mark.anyio
async def test_failure_queued_before_close_is_not_delivered_after_close():
    client,sync,failures,_ = peer()
    notified = []
    router = CodexApprovalRouter(client, lambda: notified.append(True))
    reader_call(lambda: sync._router.fail_all(RuntimeError('EOF')))
    router.close()
    await asyncio.sleep(0)
    assert len(failures)==1 and not notified


@pytest.mark.anyio
async def test_live_reader_failure_still_notifies_owner_once():
    client,sync,failures,_ = peer()
    notified = []
    router = CodexApprovalRouter(client, lambda: notified.append(True))
    reader_call(lambda: sync._router.fail_all(RuntimeError('EOF')))
    await asyncio.sleep(0)
    assert len(failures)==1 and notified==[True]
    router.close()


class ClosingLoop:
    """Close in between the availability check and thread-safe scheduling."""
    closed = False
    def is_closed(self):
        return self.closed
    def is_running(self):
        return not self.closed
    def call_soon_threadsafe(self, *args, **kwargs):
        self.closed = True
        raise RuntimeError('Event loop is closed')


@pytest.mark.anyio
@pytest.mark.parametrize('server_request', [False,True])
async def test_loop_closes_during_schedule_without_thread_or_coroutine_warning(server_request):
    client,sync,failures,_ = peer()
    router = CodexApprovalRouter(client, lambda: None)
    router.loop = ClosingLoop()
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter('always')
        if server_request:
            result = reader_call(lambda: sync._handle_server_request({
                'id':'race','method':'item/commandExecution/requestApproval','params':{'threadId':'a'},
            }))
            assert result == {'decision':'deny'}
        else:
            reader_call(lambda: sync._router.fail_all(RuntimeError('EOF')))
            assert len(failures)==1
        gc.collect()
    assert not captured
    router.close()


@pytest.mark.anyio
async def test_pool_waits_for_native_reader_even_when_sdk_close_raises():
    from engines.codex_sdk_clients import CodexClientPool
    close_called = threading.Event()
    exited = threading.Event()
    release = threading.Event()
    def read():
        close_called.wait(2)
        release.wait(2)
        exited.set()
    thread = threading.Thread(target=read)
    thread.start()
    class Client:
        _client = SimpleNamespace(_sync=SimpleNamespace(_reader_thread=thread))
        async def close(self):
            close_called.set()
            raise BrokenPipeError('synthetic SDK close failure')
    pool = CodexClientPool()
    try:
        await pool.acquire('/project', 'a', 'same', Client)
        closing = asyncio.create_task(pool.close())
        assert await asyncio.to_thread(close_called.wait,1)
        await asyncio.wait_for(asyncio.sleep(.01),.05)
        assert not closing.done()
        release.set()
        await closing
        assert exited.is_set() and not thread.is_alive()
    finally:
        close_called.set()
        release.set()
        await asyncio.to_thread(thread.join,2)


@pytest.mark.parametrize('schedule_race',[False,True])
def test_legacy_sync_callback_fails_closed_without_coroutine_warning(schedule_race):
    from engines.codex_sdk import CodexSDKEngine
    gc.collect()
    async def initialize():
        loop = ClosingLoop() if schedule_race else asyncio.get_running_loop()
        return CodexSDKEngine()._build_approval_handler(asyncio.Queue(),loop,'a')
    handler = asyncio.run(initialize())
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter('always')
        result = reader_call(lambda: handler('item/commandExecution/requestApproval',{}))
        gc.collect()
    assert result == {'decision':'deny'}
    assert not captured


@pytest.mark.anyio
async def test_approval_response_is_not_starved_by_sdk_notification_waiters():
    from concurrent.futures import ThreadPoolExecutor
    loop=asyncio.get_running_loop()
    old_executor=loop._default_executor
    executor=ThreadPoolExecutor(max_workers=1)
    loop.set_default_executor(executor)
    occupied,release=threading.Event(),threading.Event()
    def notification_waiter():
        occupied.set()
        release.wait(2)
    client,sync,_,writes=peer()
    router=CodexApprovalRouter(client)
    owner=object()
    async def async_handler(method,params):
        return {'decision':'accept'}
    def handler(*args):
        raise AssertionError('must use asynchronous approval')
    handler.async_handler=async_handler
    router.bind('a',owner,handler)
    blocker=asyncio.create_task(asyncio.to_thread(notification_waiter))
    try:
        while not occupied.is_set():
            await asyncio.sleep(0)
        route=router.routes['a']
        await asyncio.wait_for(router.respond('approval','item/commandExecution/requestApproval',{'threadId':'a'},route),.3)
        assert writes==[{'id':'approval','result':{'decision':'accept'}}]
    finally:
        release.set()
        await blocker
        router.close()
        loop._default_executor=old_executor
        await asyncio.to_thread(executor.shutdown,wait=True)
        for thread in router.background_threads():
            await asyncio.to_thread(thread.join,1)
            assert not thread.is_alive()

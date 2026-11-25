import asyncio
import threading
import types
import sys

import pytest


@pytest.mark.asyncio
async def test_quota_requests_merge_and_limit_parallel_collectors():
    from services.engine_quota import QuotaRequests
    requests = QuotaRequests()
    active = peak = calls = 0
    async def collect():
        nonlocal active, peak, calls
        active += 1
        calls += 1
        peak = max(peak, active)
        try:
            await asyncio.sleep(.03)
            return {'ok': True}
        finally:
            active -= 1
    await asyncio.gather(*(requests.run(('same', ''), collect) for _ in range(20)))
    assert calls == 1
    await asyncio.gather(*(requests.run((str(i), ''), collect) for i in range(8)))
    assert peak == 2


@pytest.mark.asyncio
async def test_cancelled_waiter_does_not_cancel_another_but_last_waiter_cleans_up():
    from services.engine_quota import QuotaRequests
    requests = QuotaRequests()
    entered, cleaned, finish = asyncio.Event(), asyncio.Event(), asyncio.Event()
    async def collect():
        entered.set()
        try:
            await finish.wait()
            return {'ok': True}
        finally:
            cleaned.set()
    first = asyncio.create_task(requests.run(('same', ''), collect))
    second = asyncio.create_task(requests.run(('same', ''), collect))
    await entered.wait()
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    assert not cleaned.is_set()
    second.cancel()
    with pytest.raises(asyncio.CancelledError):
        await second
    assert cleaned.is_set()


@pytest.mark.asyncio
async def test_slow_codex_construction_does_not_block_event_loop(monkeypatch):
    from engines.codex_sdk import CodexSDKEngine
    entered, finish = threading.Event(), threading.Event()
    class Client:
        def __init__(self, config):
            entered.set()
            finish.wait(2)
            self._client = self
        async def start(self): pass
        async def __aenter__(self): return self
        async def close(self): pass
    module = types.ModuleType('openai_codex')
    module.AsyncCodex = Client
    module.CodexConfig = lambda **kw: kw
    monkeypatch.setitem(sys.modules, 'openai_codex', module)
    async def read(*args): return {'primary': {'remaining_percent': 75}}
    monkeypatch.setattr(CodexSDKEngine, '_read_account_quota', read)
    task = asyncio.create_task(CodexSDKEngine().get_quota(''))
    try:
        # If construction blocks the loop, this assertion runs only after its timeout.
        await asyncio.sleep(.03)
        assert entered.is_set()
        assert not task.done()
    finally:
        finish.set()
        await task


@pytest.mark.asyncio
async def test_quota_subprocess_output_is_bounded_and_reaped(monkeypatch, tmp_path):
    import engines.core.antigravity_quota as native
    original = asyncio.create_subprocess_exec
    processes, parsed = [], []
    async def start(*args, **kwargs):
        process = await original(sys.executable, '-c',
            'import sys,time; sys.stdout.write("x"*300000); sys.stdout.flush(); time.sleep(60)', **kwargs)
        processes.append(process)
        return process
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', start)
    monkeypatch.setattr(native, 'parse_quota', lambda value: parsed.append(len(value)))
    result = await native.read_quota('agy', str(tmp_path), .5)
    assert result is None
    assert parsed == []
    assert processes[0].returncode is not None


@pytest.mark.asyncio
async def test_codex_cancel_during_slow_start_waits_before_closing(monkeypatch):
    from engines.codex_sdk import CodexSDKEngine
    entered, finish, started, closed = (threading.Event() for _ in range(4))
    def blocking_start():
        entered.set()
        finish.wait(2)
        started.set()
    class Client:
        def __init__(self, config): self._client = self
        async def start(self): await asyncio.to_thread(blocking_start)
        async def __aenter__(self): return self
        async def close(self):
            assert started.is_set()
            closed.set()
    module = types.ModuleType('openai_codex')
    module.AsyncCodex = Client
    module.CodexConfig = lambda **kw: kw
    monkeypatch.setitem(sys.modules, 'openai_codex', module)
    task = asyncio.create_task(CodexSDKEngine().get_quota(''))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        task.cancel()
        await asyncio.sleep(.02)
        assert not task.done()
        assert not closed.is_set()
    finally:
        finish.set()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert closed.is_set()


@pytest.mark.asyncio
async def test_quota_queue_is_bounded():
    from services.engine_quota import QuotaRequests, QuotaBusyError
    requests = QuotaRequests()
    finish = asyncio.Event()
    async def collect(): await finish.wait()
    tasks = [asyncio.create_task(requests.run((str(i), ''), collect)) for i in range(32)]
    await asyncio.sleep(0)
    try:
        with pytest.raises(QuotaBusyError):
            await requests.run(('overflow', ''), collect)
    finally:
        finish.set()
        await asyncio.gather(*tasks)

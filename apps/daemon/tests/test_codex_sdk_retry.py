"""Capacity failures use bounded backoff through both execution entry points."""

import asyncio
from types import SimpleNamespace as N

import pytest

from engines.codex_sdk import CodexSDKEngine
from engines.core.events import InternalEvent

CAPACITY = "Selected model is at capacity. Please try a different model."


class CapacityEngine(CodexSDKEngine):
    def __init__(self, failures, message=CAPACITY, raises=False):
        super().__init__()
        self.failures = failures
        self.message = message
        self.raises = raises
        self.calls = []

    async def spawn(self, prompt, cwd, session_id=None, **kwargs):
        self.calls.append((prompt, session_id, kwargs.get("model")))
        yield InternalEvent("session_started", {"session_id": session_id or "thread"})
        if len(self.calls) <= self.failures:
            if self.raises:
                raise RuntimeError(self.message)
            for event in self._map_notification(N(method="turn/completed", payload=N(
                turn=N(status=N(value="failed"), error=N(message=self.message)),
            )), {}):
                yield event
        else:
            yield InternalEvent("status", {"status": "done"})

    async def spawn_coordinator(self, **kwargs):
        async for event in self.spawn(**kwargs):
            yield event


@pytest.mark.anyio
@pytest.mark.parametrize("entry", ["spawn_with_retry", "spawn_coordinator_with_retry"])
@pytest.mark.parametrize("raises", [False, True])
async def test_capacity_recovers_after_backoff(monkeypatch, tmp_path, entry, raises):
    delays = []

    async def sleep(delay):
        delays.append(delay)

    monkeypatch.setattr("engines.core.acp_base.asyncio.sleep", sleep)
    engine = CapacityEngine(3, raises=raises)
    events = [event async for event in getattr(engine, entry)(
        prompt="hello", cwd=str(tmp_path), session_id="existing", model="chosen",
    )]
    assert len(engine.calls) == 4
    assert engine.calls == [("hello", "existing", "chosen")] * 4
    assert delays == [5, 10, 20]
    retries = [e.data for e in events if e.data.get("status") == "retrying"]
    assert [e["attempt"] for e in retries] == [2, 3, 4]
    assert all(e["max_attempts"] == 5 for e in retries)
    assert not any(e.type == "error" for e in events)
    assert events[-1].data["status"] == "done"


@pytest.mark.anyio
async def test_capacity_exhaustion_reports_final_error(monkeypatch, tmp_path):
    delays = []

    async def sleep(delay):
        delays.append(delay)

    monkeypatch.setattr("engines.core.acp_base.asyncio.sleep", sleep)
    engine = CapacityEngine(10)
    events = [e async for e in engine.spawn_with_retry(prompt="hello", cwd=str(tmp_path))]
    assert len(engine.calls) == 5
    assert delays == [5, 10, 20, 40]
    assert [e.data["message"] for e in events if e.type == "error"] == [CAPACITY]
    # A new thread without turn progress must still restart rather than resume.
    assert all(call[1] is None for call in engine.calls)


@pytest.mark.anyio
async def test_other_errors_keep_single_immediate_retry(monkeypatch, tmp_path):
    async def sleep(delay):
        pytest.fail("ordinary failures must not use capacity backoff")

    monkeypatch.setattr("engines.core.acp_base.asyncio.sleep", sleep)
    engine = CapacityEngine(10, message="invalid credentials")
    events = [e async for e in engine.spawn_with_retry(prompt="hello", cwd=str(tmp_path))]
    assert len(engine.calls) == 2
    assert len([e for e in events if e.type == "error"]) == 1


@pytest.mark.anyio
@pytest.mark.parametrize("stop_engine", [False, True])
async def test_capacity_wait_is_nonblocking_and_cancellable(tmp_path, stop_engine):
    engine = CapacityEngine(10)
    waiting = asyncio.Event()

    async def run():
        async for event in engine.spawn_with_retry(prompt="hello", cwd=str(tmp_path)):
            if event.data.get("status") == "retrying":
                waiting.set()

    task = asyncio.create_task(run())
    try:
        await asyncio.wait_for(waiting.wait(), timeout=1)
        # A lightweight coroutine can run while the real five-second delay waits.
        await asyncio.wait_for(asyncio.sleep(0.01), timeout=0.5)
        assert len(engine.calls) == 1
        if stop_engine:
            await engine.stop()
        else:
            task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=0.5)
        assert len(engine.calls) == 1
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

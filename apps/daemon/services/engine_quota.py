"""Low-priority, bounded quota collection independent of chat transports."""
import asyncio
from contextlib import suppress
from dataclasses import dataclass
from weakref import WeakKeyDictionary, ref

from engines.core.process_cleanup import finish_cleanup


class QuotaBusyError(Exception):
    pass


@dataclass
class _Pending:
    task: asyncio.Task
    waiters: int = 0


class _State:
    def __init__(self):
        self.limit = asyncio.Semaphore(2)
        self.pending = {}


class QuotaRequests:
    """Merge identical requests; cap collectors and queued keys per event loop."""
    def __init__(self):
        self._loops = WeakKeyDictionary()

    async def run(self, key, operation):
        loop = asyncio.get_running_loop()
        state_ref = self._loops.get(loop)
        state = state_ref() if state_ref else None
        if state is None:
            state = _State()
            self._loops[loop] = ref(state)
        limit, pending = state.limit, state.pending
        entry = pending.get(key)
        if entry is None:
            if len(pending) >= 32:
                raise QuotaBusyError()
            async def collect():
                async with asyncio.timeout(25):
                    async with limit:
                        return await operation()
            entry = pending[key] = _Pending(asyncio.create_task(collect()))
        entry.waiters += 1
        try:
            return await asyncio.shield(entry.task)
        finally:
            entry.waiters -= 1
            if entry.waiters == 0:
                if pending.get(key) is entry:
                    pending.pop(key)
                async def cleanup():
                    if not entry.task.done():
                        entry.task.cancel()
                    with suppress(asyncio.CancelledError, Exception):
                        await entry.task
                await finish_cleanup(cleanup())


quota_requests = QuotaRequests()

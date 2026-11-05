"""Request-local permission rechecks, shared by HTTP upload and download."""
import asyncio
from time import monotonic


class StreamAuthorizationCheck:
    def __init__(self, check, *, interval: float):
        self._check = check
        self._interval = interval
        self._next_check = float('-inf')
        self._lock = asyncio.Lock()
        self._failure: Exception | None = None

    async def __call__(self):
        if self._failure is not None:
            raise self._failure
        if monotonic() < self._next_check:
            return
        async with self._lock:
            if self._failure is not None:
                raise self._failure
            now = monotonic()
            if now < self._next_check:
                return
            try:
                await self._check()
            except Exception as exc:
                # Denial also stops the other transfer direction from reusing
                # the previous successful result.
                self._failure = exc
                raise
            # Slow queries must not extend the freshness window.
            self._next_check = now + self._interval

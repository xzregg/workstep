"""Coalesce reply snapshots without making engine consumption wait on network I/O."""

import asyncio
import logging
from collections.abc import Awaitable, Callable

logger = logging.getLogger(__name__)


class ChannelReplyStream:
    def __init__(self, send: Callable[[str], Awaitable[None]], *, interval: float = 0.5):
        self._send = send
        self._interval = interval
        self._latest = ''
        self._wake = asyncio.Event()
        self._closed = False
        self._task = asyncio.create_task(self._run())

    def update(self, text: str) -> None:
        if not self._closed and text and text != self._latest:
            self._latest = text
            self._wake.set()

    async def _run(self) -> None:
        try:
            while True:
                await self._wake.wait()
                self._wake.clear()
                await asyncio.wait_for(self._send(self._latest), timeout=5)
                await asyncio.sleep(self._interval)
        except asyncio.CancelledError:
            raise
        except Exception:
            self._closed = True
            logger.warning('Channel progress reply failed; final delivery will retry', exc_info=True)

    async def close(self) -> None:
        self._closed = True
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass

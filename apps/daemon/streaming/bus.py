"""EventBus — global event distribution for WebSocket broadcasting."""

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)


class EventBus:
    """Fan-out event bus: one publisher, many subscribers.

    Each subscriber gets an asyncio.Queue. publish() puts events
    into all subscriber queues. Used by WebSocket handler to
    receive events from engine/task services.
    """

    def __init__(self):
        self._subscribers: list[asyncio.Queue] = []
        self._closed = False

    def subscribe(self) -> asyncio.Queue:
        """Create a new subscriber queue."""
        if self._closed:
            raise RuntimeError("EventBus is closed")
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        """Remove a subscriber queue."""
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass

    async def publish(self, event: dict[str, Any]):
        """Broadcast an event to all subscribers."""
        if self._closed:
            return
        dead = []
        for q in self._subscribers:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                logger.warning("Subscriber queue full, dropping event")
                dead.append(q)
        for q in dead:
            self.unsubscribe(q)

    async def close(self):
        """Shutdown: send sentinel to all subscribers."""
        self._closed = True
        for q in self._subscribers:
            try:
                q.put_nowait(None)  # sentinel
            except asyncio.QueueFull:
                pass
        self._subscribers.clear()

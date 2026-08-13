"""EventBus — global event distribution for WebSocket broadcasting."""

import asyncio
import logging
from typing import Any, Callable

logger = logging.getLogger(__name__)

Event = dict[str, Any]
EventFilter = Callable[[Event], bool] | None


class EventBus:
    """Fan-out event bus: one publisher, many subscribers.

    Each subscriber gets an asyncio.Queue. publish() puts events
    into all subscriber queues. Used by WebSocket handler to
    receive events from engine/task services.

    A subscriber may attach a per-subscription filter predicate
    (``set_filter``); events rejected by the predicate are never queued,
    so slow clients no longer pay for events they don't care about.
    """

    def __init__(self):
        self._subscribers: list[tuple[asyncio.Queue, EventFilter]] = []
        self._closed = False

    def subscribe(self, predicate: EventFilter = None) -> asyncio.Queue:
        """Create a new subscriber queue with an optional filter predicate."""
        if self._closed:
            raise RuntimeError("EventBus is closed")
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._subscribers.append((q, predicate))
        return q

    def set_filter(self, q: asyncio.Queue, predicate: EventFilter):
        """Replace the filter predicate of an existing subscriber."""
        for i, (sub_q, _) in enumerate(self._subscribers):
            if sub_q is q:
                self._subscribers[i] = (q, predicate)
                return
        logger.warning("set_filter on unknown subscriber queue")

    def unsubscribe(self, q: asyncio.Queue):
        """Remove a subscriber queue."""
        before = len(self._subscribers)
        self._subscribers = [(sq, f) for sq, f in self._subscribers if sq is not q]
        if len(self._subscribers) == before:
            logger.debug("unsubscribe of unknown queue")

    async def publish(self, event: dict[str, Any]):
        """Broadcast an event to all subscribers."""
        if self._closed:
            return
        dead = []
        for q, predicate in self._subscribers:
            if predicate is not None and not predicate(event):
                continue
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
        for q, _ in self._subscribers:
            try:
                q.put_nowait(None)  # sentinel
            except asyncio.QueueFull:
                pass
        self._subscribers.clear()

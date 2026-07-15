"""Tests for FastAPI skeleton: health, WebSocket, EventBus."""

import asyncio
import pytest
from httpx import AsyncClient, ASGITransport
from main import app, event_bus


@pytest.fixture
async def client():
    """Async HTTP client for FastAPI."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.mark.anyio
async def test_health(client):
    resp = await client.get("/api/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert "version" in data


@pytest.mark.anyio
async def test_event_bus_pubsub():
    """EventBus: one publish, one subscriber receives."""
    q = event_bus.subscribe()
    try:
        await event_bus.publish({"type": "test", "data": "hello"})
        event = await asyncio.wait_for(q.get(), timeout=1)
        assert event["type"] == "test"
        assert event["data"] == "hello"
    finally:
        event_bus.unsubscribe(q)


@pytest.mark.anyio
async def test_event_bus_multiple_subscribers():
    """EventBus: publish fans out to all subscribers."""
    q1 = event_bus.subscribe()
    q2 = event_bus.subscribe()
    try:
        await event_bus.publish({"type": "multi", "n": 42})
        e1 = await asyncio.wait_for(q1.get(), timeout=1)
        e2 = await asyncio.wait_for(q2.get(), timeout=1)
        assert e1 == e2 == {"type": "multi", "n": 42}
    finally:
        event_bus.unsubscribe(q1)
        event_bus.unsubscribe(q2)


@pytest.mark.anyio
async def test_event_bus_unsubscribe():
    """Unsubscribed queue no longer receives events."""
    q = event_bus.subscribe()
    event_bus.unsubscribe(q)
    await event_bus.publish({"type": "after_unsub"})
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(q.get(), timeout=0.1)

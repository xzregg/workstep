"""Tests for FastAPI skeleton: health, WebSocket, EventBus."""

import asyncio
from datetime import datetime, timezone
import pytest
from fastapi.encoders import jsonable_encoder
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


def test_websocket_events_encode_datetime_values():
    """WebSocket events remain JSON-safe after timestamp fields became datetime."""
    encoded = jsonable_encoder({
        "type": "action_proposal",
        "created_at": datetime(2026, 8, 4, 10, 29, tzinfo=timezone.utc),
        "data": {
            "updated_at": datetime(2026, 8, 4, 10, 30, tzinfo=timezone.utc),
        },
    })

    assert encoded == {
        "type": "action_proposal",
        "created_at": "2026-08-04T10:29:00+00:00",
        "data": {"updated_at": "2026-08-04T10:30:00+00:00"},
    }


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


@pytest.mark.anyio
async def test_lifespan_waits_for_workflows_before_closing_resources(monkeypatch):
    """Daemon shutdown drains owned workflow tasks before DB and event teardown."""
    import main

    events = []

    class RuntimeStub:
        async def recover_running_workflows(self):
            events.append("workflows-recover")
            return 0

        async def shutdown(self):
            events.append("runtime-shutdown")

    class BusStub:
        async def close(self):
            events.append("bus-close")

    class ProjectManagerStub:
        def _load_saved_projects(self):
            events.append("projects-load")

        def close_all(self):
            events.append("projects-close")

    class ScheduleStub:
        async def start(self):
            events.append("schedules-start")

        async def shutdown(self):
            events.append("schedules-shutdown")

    monkeypatch.setattr(main, "event_bus", BusStub())
    monkeypatch.setattr(main, "ensure_global_templates", lambda: None)
    monkeypatch.setattr(main, "project_manager", ProjectManagerStub())
    monkeypatch.setattr(main, "TaskService", lambda bus: object())
    monkeypatch.setattr(
        main,
        "WorkflowRuntime",
        lambda bus, project_manager: RuntimeStub(),
    )
    monkeypatch.setattr(
        main,
        "ScheduleModule",
        lambda project_manager, task_service, runtime: ScheduleStub(),
    )

    async with main.lifespan(main.app):
        events.append("serving")

    assert events == [
        "projects-load",
        "workflows-recover",
        "schedules-start",
        "serving",
        "schedules-shutdown",
        "runtime-shutdown",
        "bus-close",
        "projects-close",
    ]


@pytest.mark.anyio
async def test_websocket_cancel_reaches_the_pipeline_runtime(monkeypatch):
    """The WebSocket cancel command targets the owner of multi-step runs."""
    import json
    import main

    cancelled = []

    class RuntimeStub:
        async def cancel(self, task_id):
            cancelled.append(task_id)
            return True

    monkeypatch.setattr(main, "workflow_runtime", RuntimeStub())
    monkeypatch.setattr(main, "task_service", None)

    await main._handle_client_message(
        json.dumps({"type": "cancel", "task_id": "task-1"})
    )

    assert cancelled == ["task-1"]

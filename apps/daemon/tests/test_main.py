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
async def test_event_bus_predicate_filter():
    """EventBus: a filtered subscriber only receives matching events."""
    filtered = event_bus.subscribe(lambda e: e.get("task_id") == "t1")
    unfiltered = event_bus.subscribe()
    try:
        await event_bus.publish({"type": "x", "task_id": "t1", "n": 1})
        await event_bus.publish({"type": "x", "task_id": "t2", "n": 2})
        received = []
        while not filtered.empty():
            received.append(await filtered.get())
        assert received == [{"type": "x", "task_id": "t1", "n": 1}]
        assert unfiltered.qsize() == 2
    finally:
        event_bus.unsubscribe(filtered)
        event_bus.unsubscribe(unfiltered)


@pytest.mark.anyio
async def test_event_bus_set_filter_updates_live():
    """EventBus: set_filter replaces the predicate of a subscriber."""
    q = event_bus.subscribe()
    try:
        event_bus.set_filter(q, lambda e: e.get("task_id") == "t1")
        await event_bus.publish({"type": "x", "task_id": "t2"})
        assert q.empty()
        event_bus.set_filter(q, None)
        await event_bus.publish({"type": "y", "task_id": "t2"})
        assert (await asyncio.wait_for(q.get(), timeout=1))["type"] == "y"
    finally:
        event_bus.unsubscribe(q)


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

        async def requeue_queued_tasks(self):
            events.append("workflows-requeue")
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

        def iter_projects(self):
            return []

    class ScheduleStub:
        async def start(self):
            events.append("schedules-start")

        async def shutdown(self):
            events.append("schedules-shutdown")

    class ChatStub:
        def recover_interrupted_messages(self):
            events.append("chats-recover")
            return 1

        async def shutdown(self):
            events.append("chats-shutdown")

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
        lambda project_manager, task_service, runtime, task_agent=None: ScheduleStub(),
    )
    monkeypatch.setattr(
        main,
        "ChatSessionModule",
        lambda bus, project_manager: ChatStub(),
    )

    async with main.lifespan(main.app):
        events.append("serving")

    assert events == [
        "projects-load",
        "workflows-recover",
        "workflows-requeue",
        "chats-recover",
        "schedules-start",
        "serving",
        "schedules-shutdown",
        "chats-shutdown",
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


def test_parse_subscription_defaults_to_full_broadcast():
    """A subscribe message without subscription keys resets to full mode."""
    from main import parse_subscription

    sub = parse_subscription({"type": "subscribe"})
    assert sub.active is False


def test_parse_subscription_dimensions():
    """subscribe lists become string sets; unknown keys are ignored."""
    from main import parse_subscription

    sub = parse_subscription({
        "type": "subscribe",
        "task_ids": ["t1", "t2"],
        "status_only_task_ids": ["t3"],
        "session_ids": ["s1"],
        "channels": ["execution"],
        "junk": 42,
    })
    assert sub.active is True
    assert sub.task_ids == {"t1", "t2"}
    assert sub.status_only_task_ids == {"t3"}
    assert sub.session_ids == {"s1"}
    assert sub.channels == {"execution"}


def test_matches_subscription():
    """Events are routed by task / status-only / session / channel."""
    from main import WsSubscription, matches_subscription

    full = WsSubscription()
    assert matches_subscription({"type": "RUN_STARTED", "task_id": "x"}, full)

    detail = WsSubscription(active=True, task_ids={"t1"})
    assert matches_subscription({"type": "TEXT_MESSAGE_CHUNK", "task_id": "t1"}, detail)
    assert not matches_subscription({"type": "TEXT_MESSAGE_CHUNK", "task_id": "t2"}, detail)

    status_only = WsSubscription(active=True, status_only_task_ids={"t2"})
    assert matches_subscription({"type": "RUN_STARTED", "task_id": "t2"}, status_only)
    assert matches_subscription(
        {"type": "CUSTOM", "name": "workstep.status", "task_id": "t2"}, status_only
    )
    assert not matches_subscription(
        {"type": "TEXT_MESSAGE_CHUNK", "task_id": "t2"}, status_only
    )
    assert not matches_subscription({"type": "RUN_STARTED", "task_id": "t1"}, status_only)

    session = WsSubscription(active=True, session_ids={"s1"})
    assert matches_subscription({"type": "TEXT_MESSAGE_CHUNK", "session_id": "s1"}, session)
    assert not matches_subscription({"type": "TEXT_MESSAGE_CHUNK", "session_id": "s2"}, session)

    channel = WsSubscription(active=True, channels={"execution"})
    assert matches_subscription({"type": "TOOL_CALL_START", "channel": "execution"}, channel)
    assert not matches_subscription({"type": "TOOL_CALL_START", "channel": "review"}, channel)


@pytest.mark.anyio
async def test_handle_client_message_subscribe_updates_filter(monkeypatch):
    """A subscribe message narrows the connection's event filter."""
    import json
    import main
    from main import WsSubscription

    q = event_bus.subscribe()
    sub = WsSubscription()
    try:
        await main._handle_client_message(
            json.dumps({"type": "subscribe", "task_ids": ["t1"]}),
            sub,
            q,
        )
        assert sub.active is True
        assert sub.task_ids == {"t1"}
        # Matching event reaches the queue…
        await event_bus.publish({"type": "TEXT_MESSAGE_CHUNK", "task_id": "t1"})
        assert (await asyncio.wait_for(q.get(), timeout=1))["task_id"] == "t1"
        # …non-matching does not.
        await event_bus.publish({"type": "TEXT_MESSAGE_CHUNK", "task_id": "t2"})
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(q.get(), timeout=0.1)
    finally:
        event_bus.unsubscribe(q)


@pytest.mark.anyio
async def test_project_websocket_subscription_cannot_escape_project_or_send_commands(monkeypatch):
    import json
    import main
    from streaming.ws import _make_subscription_predicate
    from main import WsSubscription

    sub = WsSubscription(project_id="project-1")
    q = event_bus.subscribe(_make_subscription_predicate(sub))
    try:
        await event_bus.publish({"type": "RUN_STARTED", "project_id": "project-2", "task_id": "t"})
        await event_bus.publish({"type": "RUN_STARTED", "task_id": "t"})
        await event_bus.publish({"type": "TEXT_MESSAGE_CHUNK", "project_id": "project-1",
                                 "channel": "session_chat", "session_id": "private"})
        assert q.empty()
        await event_bus.publish({"type": "RUN_STARTED", "project_id": "project-1", "task_id": "t"})
        assert (await q.get())["project_id"] == "project-1"
        await event_bus.publish({"type": "TEXT_MESSAGE_CHUNK", "project_id": "project-1",
                                 "channel": "execution", "task_id": "t"})
        assert (await q.get())["channel"] == "execution"
        await event_bus.publish({"type": "TEXT_MESSAGE_CHUNK", "project_id": "project-1",
                                 "channel": "coordinator", "task_id": "t"})
        assert (await q.get())["channel"] == "coordinator"
        for channel in ("review", "archive_experience"):
            await event_bus.publish({"type": "TEXT_MESSAGE_CHUNK", "project_id": "project-2",
                                     "channel": channel, "task_id": "t"})
            await event_bus.publish({"type": "TEXT_MESSAGE_CHUNK", "project_id": "project-1",
                                     "channel": channel, "task_id": "t"})
            assert (await q.get())["channel"] == channel
            await event_bus.publish({"type": "TEXT_MESSAGE_CHUNK", "project_id": "project-1",
                                     "channel": channel})
            assert q.empty()

        await main._handle_client_message(json.dumps({
            "type": "subscribe", "project_id": "project-2", "task_ids": ["t"],
            "session_ids": ["visible-chat"],
        }), sub, q)
        assert sub.project_id == "project-1"
        await event_bus.publish({"type": "TEXT_MESSAGE_CHUNK", "project_id": "project-1",
                                 "channel": "session_chat", "session_id": "visible-chat"})
        assert (await q.get())["session_id"] == "visible-chat"
        await event_bus.publish({"type": "TEXT_MESSAGE_CHUNK", "project_id": "project-1",
                                 "channel": "session_chat", "session_id": "other-chat"})
        await event_bus.publish({"type": "TEXT_MESSAGE_CHUNK", "project_id": "project-2",
                                 "channel": "session_chat", "session_id": "visible-chat"})
        await event_bus.publish({"type": "TEXT_MESSAGE_CHUNK", "project_id": "project-1",
                                 "channel": "flow_gen", "session_id": "visible-chat"})
        assert q.empty()
        for channel in ("review", "archive_experience"):
            await event_bus.publish({"type": "TEXT_MESSAGE_CHUNK", "project_id": "project-1",
                                     "channel": channel, "task_id": "other"})
            await event_bus.publish({"type": "TEXT_MESSAGE_CHUNK", "project_id": "project-1",
                                     "channel": channel, "task_id": "t"})
            assert (await q.get())["channel"] == channel
            assert q.empty()
        await event_bus.publish({"type": "RUN_STARTED", "project_id": "project-2", "task_id": "t"})
        assert q.empty()
        await event_bus.publish({"type": "RUN_STARTED", "project_id": "project-1", "task_id": "t"})
        assert (await q.get())["project_id"] == "project-1"

        class Runtime:
            async def cancel(self, task_id):
                raise AssertionError("project websocket cancelled a task")

        monkeypatch.setattr(main, "workflow_runtime", Runtime())
        await main._handle_client_message(json.dumps({"type": "cancel", "task_id": "t"}), sub, q)
        await main._handle_client_message(json.dumps({
            "type": "respond", "intervention_id": "other-project",
        }), sub, q)
    finally:
        event_bus.unsubscribe(q)


@pytest.mark.anyio
async def test_task_runner_events_carry_executor_project_into_agui_feed():
    from services.task_runner import TaskRunner
    from types import SimpleNamespace

    runner = object.__new__(TaskRunner)
    runner._event_bus = event_bus
    runner._database_executor = SimpleNamespace(project_id="project-1")
    q = event_bus.subscribe(lambda event: event.get("project_id") == "project-1")
    try:
        await runner._publish("task-1", "do", {
            "type": "status", "data": {"status": "running", "task_id": "task-1"},
        })
        assert not q.empty()
        assert (await q.get())["project_id"] == "project-1"
        await runner._publish("task-1", "do", {
            "type": "status", "project_id": "project-2",
            "data": {"status": "ready", "task_id": "task-1"},
        })
        assert (await q.get())["project_id"] == "project-1"
    finally:
        event_bus.unsubscribe(q)

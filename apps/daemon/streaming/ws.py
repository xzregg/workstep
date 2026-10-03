"""WebSocket endpoints: real-time event stream, share stream, remote-project socket.

This module owns every ``/ws*`` route (the main event stream, the read-only
share stream, and the daemon-to-daemon remote-project socket) plus the
subscription parsing/filtering helpers, keeping ``main.py`` as a thin entry
point.

The daemon's service singletons (``event_bus``, ``workflow_runtime``,
``remote_project_client`` …) are resolved lazily from :mod:`main` at call
time. That mirrors how other modules wire themselves (e.g.
``api.remote_project`` does ``from main import ...`` inside functions) and
keeps monkeypatch-based tests working without creating an import cycle.
"""

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.encoders import jsonable_encoder

from engines.core.agui import is_status_event
from services.remote_project import (
    RemoteRouteDispatcher,
    serve_remote_project_socket,
    websocket_access_allowed,
)
from services.desktop_security import desktop_websocket_allowed

logger = logging.getLogger(__name__)


def _main():
    """Return the daemon entry-point module (lazy to avoid an import cycle)."""
    import main  # noqa: PLC0415 — resolved at call time, not import time

    return main


def _local_project_summary(project_id: str) -> dict[str, Any] | None:
    return next(
        (
            {**project, "type": "local", "connection_status": "local"}
            for project in _main().project_manager.list_projects()
            if project.get("id") == project_id
        ),
        None,
    )


_SUBSCRIBE_KEYS = ("task_ids", "status_only_task_ids", "session_ids", "channels")
_PROJECT_EVENT_CHANNELS = frozenset({
    "execution", "coordinator", "review", "archive_experience", "session_chat", "channel_bots",
})


@dataclass
class WsSubscription:
    """单个 WebSocket 连接的订阅状态。

    首次 ``subscribe`` 消息之前保持"全量"（向后兼容）；收到 subscribe 后
    事件满足任一维度即推送：
    - ``task_ids`` — 订阅任务的全量事件流（任务详情页）；
    - ``status_only_task_ids`` — 仅订阅这些任务的状态类事件（任务列表）；
    - ``session_ids`` — 按助手会话订阅（``session_chat`` / ``flow_gen`` 等）；
    - ``channels`` — 按 channel 订阅。
    """

    task_ids: set[str] = field(default_factory=set)
    status_only_task_ids: set[str] = field(default_factory=set)
    session_ids: set[str] = field(default_factory=set)
    channels: set[str] = field(default_factory=set)
    project_id: str = ""
    active: bool = False


def parse_subscription(msg: dict[str, Any]) -> WsSubscription:
    """把 subscribe 消息解析为订阅状态；不含任何订阅键时重置为全量。"""
    if not any(key in msg for key in _SUBSCRIBE_KEYS) and not msg.get("project_id"):
        return WsSubscription()
    sub = WsSubscription(active=True)
    sub.project_id = str(msg.get("project_id") or "")
    for key in _SUBSCRIBE_KEYS:
        values = msg.get(key)
        if isinstance(values, (list, set, tuple)):
            setattr(sub, key, {str(v) for v in values if v})
    return sub


def matches_subscription(event: dict[str, Any], sub: WsSubscription) -> bool:
    """判断事件是否命中订阅；未激活订阅（全量模式）恒为 True。"""
    if not sub.active:
        return True
    if (
        event.get("type") == "CUSTOM"
        and event.get("name") == "workstep.remote_project_status"
        and event.get("project_id") == sub.project_id
    ):
        return True
    task_id = event.get("task_id")
    if task_id:
        if task_id in sub.task_ids:
            return True
        if task_id in sub.status_only_task_ids:
            if is_status_event(event):
                return True
    session_id = event.get("session_id")
    if session_id and session_id in sub.session_ids:
        return True
    channel = event.get("channel")
    if channel and channel in sub.channels:
        return not sub.project_id or event.get("project_id") == sub.project_id
    return False


def _make_subscription_predicate(sub: WsSubscription):
    """返回基于当前订阅状态的过滤谓词（供 EventBus 使用）。"""

    def predicate(event: dict[str, Any]) -> bool:
        if sub.project_id:
            if event.get("project_id") != sub.project_id:
                return False
            channel = event.get("channel")
            if channel is not None and channel not in _PROJECT_EVENT_CHANNELS:
                return False
            if channel in ("review", "archive_experience") and not event.get("task_id"):
                return False
            if channel == "session_chat":
                return bool(sub.active and event.get("session_id") in sub.session_ids)
            if event.get("session_id") and not event.get("task_id"):
                return False
        return matches_subscription(event, sub)

    return predicate


async def _handle_client_message(
    raw: str,
    subscription: WsSubscription | None = None,
    queue: asyncio.Queue | None = None,
):
    """Process incoming WebSocket messages from client."""
    main = _main()
    try:
        msg = json.loads(raw)
        msg_type = msg.get("type")

        # Project sessions may narrow their feed, but never select another
        # project or invoke global intervention/task controls.
        scoped_project_id = subscription.project_id if subscription is not None else ""
        if scoped_project_id and msg_type != "subscribe":
            logger.warning("Project WebSocket command denied: %s", msg_type)
            return

        if msg_type == "subscribe":
            if subscription is None or queue is None:
                logger.warning("WS subscribe ignored (no connection context)")
                return
            new_sub = parse_subscription(msg)
            subscription.task_ids = new_sub.task_ids
            subscription.status_only_task_ids = new_sub.status_only_task_ids
            subscription.session_ids = new_sub.session_ids
            subscription.channels = new_sub.channels
            subscription.project_id = scoped_project_id or new_sub.project_id
            subscription.active = new_sub.active
            main.event_bus.set_filter(queue, _make_subscription_predicate(subscription))
            project_id = str(msg.get("project_id") or "")
            if not scoped_project_id and main.remote_project_registry.get(project_id) is not None:
                try:
                    await main.remote_project_client.subscribe(project_id, msg)
                except Exception as exc:
                    logger.info("Remote project subscription deferred: %s", exc)
            logger.info(
                "WS subscribe: tasks=%d status_only=%d sessions=%d channels=%d",
                len(subscription.task_ids),
                len(subscription.status_only_task_ids),
                len(subscription.session_ids),
                len(subscription.channels),
            )

        elif msg_type == "respond":
            intervention_id = msg.get("intervention_id")
            data = msg.get("data", {})
            if intervention_id:
                delivered = main.intervention_manager.deliver_response(
                    intervention_id, data
                )
                logger.info("WS intervention respond: %s → %s", intervention_id, delivered)
            else:
                logger.warning("WS respond missing intervention_id")

        elif msg_type == "cancel":
            task_id = msg.get("task_id")
            if task_id and main.workflow_runtime:
                await main.workflow_runtime.cancel(task_id)
                logger.info("Cancelled task: %s", task_id)

        else:
            logger.warning("Unknown WS message type: %s", msg_type)

    except json.JSONDecodeError:
        logger.warning("Invalid JSON from client: %s", raw[:100])


# Event types that shouldn't leak to external share viewers.
_SHARE_SCRUBBED_EVENT_TYPES = {
    "interaction_request",
    "interaction_response",
    "engine_state",
    "subagent",
}


def register_websocket_routes(app: FastAPI) -> None:
    """Attach all ``/ws*`` endpoints (main, share, remote-project) to the app."""

    @app.websocket("/ws/remote-project")
    async def remote_project_ws_endpoint(ws: WebSocket):
        if not desktop_websocket_allowed(ws):
            await ws.close(code=4401, reason="desktop authentication required")
            return
        dispatcher = RemoteRouteDispatcher(app)
        try:
            await serve_remote_project_socket(
                ws,
                dispatcher=dispatcher,
                access_service=_main().remote_access_service,
                event_bus=_main().event_bus,
                project_summary=_local_project_summary,
            )
        finally:
            await dispatcher.aclose()

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket):
        """WebSocket endpoint for real-time event streaming.

        - Server → Client: task events, status updates
        - Client → Server: respond, cancel commands

        Events are fanned out globally by the EventBus; each connection may
        send ``{"type":"subscribe", ...}`` to narrow what it receives (see
        ``WsSubscription``). Before the first subscribe message the connection
        receives everything (backward compatible).
        """
        main = _main()
        if not desktop_websocket_allowed(ws):
            await ws.close(code=4401, reason="desktop authentication required")
            return
        if not await asyncio.to_thread(
            websocket_access_allowed, ws, main.remote_access_service
        ):
            await ws.close(code=4401, reason="remote access locked")
            return
        await ws.accept()
        actor = ws.scope.get("managed_actor")
        project_id = actor.project_id if actor is not None else None
        subscription = WsSubscription(project_id=project_id or "")
        queue = main.event_bus.subscribe(
            _make_subscription_predicate(subscription) if project_id else None
        )
        try:
            while True:
                bus_task = asyncio.create_task(queue.get())
                ws_task = asyncio.create_task(ws.receive_text())

                done, pending = await asyncio.wait(
                    [bus_task, ws_task], return_when=asyncio.FIRST_COMPLETED
                )

                for task in pending:
                    task.cancel()

                if bus_task in done:
                    event = bus_task.result()
                    if event is None:  # shutdown sentinel
                        break
                    await ws.send_json(jsonable_encoder(event))

                if ws_task in done:
                    raw = ws_task.result()
                    await _handle_client_message(raw, subscription, queue)

        except WebSocketDisconnect:
            logger.debug("WebSocket client disconnected")
        finally:
            main.event_bus.unsubscribe(queue)

    @app.websocket("/ws/share")
    async def ws_share_endpoint(ws: WebSocket, session: str = ""):
        """Read-only WebSocket for share viewers.

        Authenticates via the ``session`` query parameter (a session token
        minted by ``POST /api/task-share/public/{token}/unlock``). Subscribes
        to the event bus and forwards only events belonging to the shared
        task, with coordinator and sensitive event types filtered out.
        """
        from services.share import resolve_share_session

        if not desktop_websocket_allowed(ws):
            await ws.close(code=4401, reason="desktop authentication required")
            return

        ctx = resolve_share_session(session) if session else None
        if ctx is None:
            await ws.close(code=4401, reason="unauthorized")
            return

        task_id = ctx["task_id"]
        await ws.accept()

        def share_predicate(event: dict[str, Any]) -> bool:
            if event.get("task_id") != task_id:
                return False
            channel = event.get("channel")
            # Only forward execution events; drop coordinator and
            # assistant traffic, which is private.
            if channel is not None and channel != "execution":
                return False
            if event.get("type") in _SHARE_SCRUBBED_EVENT_TYPES:
                return False
            return True

        main = _main()
        queue = main.event_bus.subscribe(share_predicate)
        try:
            while True:
                bus_task = asyncio.create_task(queue.get())
                ws_task = asyncio.create_task(ws.receive_text())

                done, pending = await asyncio.wait(
                    [bus_task, ws_task], return_when=asyncio.FIRST_COMPLETED
                )
                for fut in pending:
                    fut.cancel()

                if ws_task in done:
                    # Share viewers are strictly read-only — any incoming
                    # message is unexpected, so treat it as a disconnect.
                    break

                if bus_task in done:
                    event = bus_task.result()
                    if event is None:  # shutdown sentinel
                        break
                    await ws.send_json(jsonable_encoder(event))
        except WebSocketDisconnect:
            logger.debug("Share WS disconnected for task %s", task_id)
        finally:
            main.event_bus.unsubscribe(queue)

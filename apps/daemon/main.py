"""WorkStep Daemon — FastAPI entry point."""

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.encoders import jsonable_encoder
from fastapi.staticfiles import StaticFiles

from settings import settings
from streaming.bus import EventBus
from api.project import router as project_router
from api.task import router as task_router
from api.history import router as history_router
from api.fs import router as fs_router
from api.fs import uploads_router
from api.search import router as search_router
from api.templates import ensure_global_templates
from api.templates import router as templates_router
from api.engine import router as engine_router
from api.provider import router as provider_router
from api.workflow import router as workflow_router
from api.workflow_gen import router as workflow_gen_router
from api.task_draft import router as task_draft_router
from api.schedule import router as schedule_router
from api.chat_session import router as chat_session_router
from api.statistics import router as statistics_router
from api.share import router as share_router
from services.project import project_manager
from services.task import TaskService
from services.intervention import intervention_manager
from services.workflow_runtime import WorkflowRuntime
from services.config import config_store
from services.coordinator import CoordinatorModule
from services.workflow_gen import WorkflowGenModule
from services.task_draft import TaskDraftModule
from services.schedule import ScheduleModule
from services.chat_session import ChatSessionModule

logger = logging.getLogger(__name__)

# Global event bus
event_bus = EventBus()

# Task service — initialized in lifespan
task_service: TaskService | None = None
workflow_runtime: WorkflowRuntime | None = None
coordinator_module: CoordinatorModule | None = None
workflow_gen_module: WorkflowGenModule | None = None
task_draft_module: TaskDraftModule | None = None
schedule_module: ScheduleModule | None = None
chat_session_module: ChatSessionModule | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle."""
    global task_service, workflow_runtime, coordinator_module, workflow_gen_module, task_draft_module, schedule_module, chat_session_module
    logger.info("WorkStep Daemon starting on %s:%d", settings.host, settings.port)
    config_store.migrate_legacy_config()
    ensure_global_templates()
    project_manager._load_saved_projects()
    task_service = TaskService(event_bus)
    workflow_runtime = WorkflowRuntime(event_bus, project_manager)
    recovered = await workflow_runtime.recover_running_workflows()
    if recovered:
        logger.info(
            "Recovered %d interrupted workflow run(s) from the last completed stage",
            recovered,
        )
    coordinator_module = CoordinatorModule(
        event_bus,
        project_manager,
        workflow_runtime,
    )
    workflow_gen_module = WorkflowGenModule(event_bus, project_manager)
    task_draft_module = TaskDraftModule(event_bus, project_manager)
    schedule_module = ScheduleModule(project_manager, task_service, workflow_runtime)
    chat_session_module = ChatSessionModule(event_bus, project_manager)
    await schedule_module.start()
    try:
        yield
    finally:
        logger.info("WorkStep Daemon shutting down")
        if workflow_gen_module is not None:
            await workflow_gen_module.shutdown()
        if task_draft_module is not None:
            await task_draft_module.shutdown()
        if schedule_module is not None:
            await schedule_module.shutdown()
        if chat_session_module is not None:
            await chat_session_module.shutdown()
        await coordinator_module.shutdown()
        await workflow_runtime.shutdown()
        await event_bus.close()
        project_manager.close_all()


app = FastAPI(title="WorkStep Daemon", lifespan=lifespan)

# Register routers
app.include_router(project_router)
app.include_router(task_router)
app.include_router(history_router)
app.include_router(fs_router)
app.include_router(uploads_router)
app.include_router(search_router)
app.include_router(templates_router)
app.include_router(engine_router)
app.include_router(provider_router)
app.include_router(workflow_router)
app.include_router(workflow_gen_router)
app.include_router(task_draft_router)
app.include_router(schedule_router)
app.include_router(chat_session_router)
app.include_router(statistics_router)
app.include_router(share_router)


# --- REST API ---


@app.get("/api/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "version": "0.1.0"}


# --- WebSocket ---


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    """WebSocket endpoint for real-time event streaming.

    - Server → Client: task events, status updates
    - Client → Server: respond, cancel commands
    """
    await ws.accept()
    queue = event_bus.subscribe()
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
                await _handle_client_message(raw)

    except WebSocketDisconnect:
        logger.debug("WebSocket client disconnected")
    finally:
        event_bus.unsubscribe(queue)


async def _handle_client_message(raw: str):
    """Process incoming WebSocket messages from client."""
    try:
        msg = json.loads(raw)
        msg_type = msg.get("type")

        if msg_type == "respond":
            intervention_id = msg.get("intervention_id")
            data = msg.get("data", {})
            if intervention_id:
                delivered = intervention_manager.deliver_response(intervention_id, data)
                logger.info("WS intervention respond: %s → %s", intervention_id, delivered)
            else:
                logger.warning("WS respond missing intervention_id")

        elif msg_type == "cancel":
            task_id = msg.get("task_id")
            if task_id and workflow_runtime:
                await workflow_runtime.cancel(task_id)
                logger.info("Cancelled task: %s", task_id)

        else:
            logger.warning("Unknown WS message type: %s", msg_type)

    except json.JSONDecodeError:
        logger.warning("Invalid JSON from client: %s", raw[:100])


# --- Share WebSocket (read-only event stream) ---

# Event types that shouldn't leak to external share viewers.
_SHARE_SCRUBBED_EVENT_TYPES = {
    "interaction_request",
    "interaction_response",
    "engine_state",
    "subagent",
}


@app.websocket("/ws/share")
async def ws_share_endpoint(ws: WebSocket, session: str = ""):
    """Read-only WebSocket for share viewers.

    Authenticates via the ``session`` query parameter (a session token
    minted by ``POST /api/task-share/public/{token}/unlock``). Subscribes
    to the event bus and forwards only events belonging to the shared
    task, with coordinator and sensitive event types filtered out.
    """
    from services.share import resolve_share_session

    ctx = resolve_share_session(session) if session else None
    if ctx is None:
        await ws.close(code=4401, reason="unauthorized")
        return

    task_id = ctx["task_id"]
    await ws.accept()
    queue = event_bus.subscribe()
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
                if event.get("task_id") != task_id:
                    continue
                channel = event.get("channel")
                # Only forward execution events; drop coordinator and
                # assistant traffic, which is private.
                if channel is not None and channel != "execution":
                    continue
                if event.get("type") in _SHARE_SCRUBBED_EVENT_TYPES:
                    continue
                await ws.send_json(jsonable_encoder(event))
    except WebSocketDisconnect:
        logger.debug("Share WS disconnected for task %s", task_id)
    finally:
        event_bus.unsubscribe(queue)


# --- Static file serving (production) ---

web_dist = Path(settings.web_dist)
if web_dist.exists():
    from starlette.responses import FileResponse as _FileResponse

    _web_dist_index = web_dist / "index.html"
    # Pre-computed set of static asset files (everything in web_dist that
    # is served verbatim — js/css/images/etc.). Used by the SPA fallback.
    _static_files: set[str] = set()
    for _entry in web_dist.rglob("*"):
        if _entry.is_file() and _entry.name != "index.html":
            _static_files.add(str(_entry.relative_to(web_dist)))

    @app.get("/{fullpath:path}", include_in_schema=False)
    async def _spa_fallback(fullpath: str):
        # Serve real assets verbatim; fall back to index.html for SPA
        # client routes like /share/:token.
        if fullpath in _static_files:
            return _FileResponse(web_dist / fullpath)
        if _web_dist_index.is_file():
            return _FileResponse(_web_dist_index)
        from fastapi.responses import JSONResponse
        return JSONResponse({"detail": "Not found"}, status_code=404)

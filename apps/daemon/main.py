"""WorkStep Daemon — FastAPI entry point."""

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from settings import settings
from streaming.bus import EventBus
from api.project import router as project_router
from api.task import router as task_router
from services.project import project_manager
from services.task import TaskService

logger = logging.getLogger(__name__)

# Global event bus
event_bus = EventBus()

# Task service — initialized in lifespan
task_service: TaskService | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle."""
    global task_service
    logger.info("WorkStep Daemon starting on %s:%d", settings.host, settings.port)
    project_manager._load_saved_projects()
    task_service = TaskService(event_bus)
    yield
    logger.info("WorkStep Daemon shutting down")
    await event_bus.close()
    project_manager.close_all()


app = FastAPI(title="WorkStep Daemon", lifespan=lifespan)

# Register routers
app.include_router(project_router)
app.include_router(task_router)


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
                await ws.send_json(event)

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
            logger.info("Received respond for run_id=%s", msg.get("run_id"))
            # TODO: inject response into running engine via task_service

        elif msg_type == "cancel":
            task_id = msg.get("task_id")
            if task_id and task_service:
                await task_service.cancel_task(task_id)
                logger.info("Cancelled task: %s", task_id)

        else:
            logger.warning("Unknown WS message type: %s", msg_type)

    except json.JSONDecodeError:
        logger.warning("Invalid JSON from client: %s", raw[:100])


# --- Static file serving (production) ---

web_dist = Path(settings.web_dist)
if web_dist.exists():
    app.mount("/", StaticFiles(directory=str(web_dist), html=True), name="static")

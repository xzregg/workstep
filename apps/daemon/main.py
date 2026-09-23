"""WorkStep Daemon — FastAPI entry point."""

import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from settings import settings

os.environ.setdefault("WORKSTEP_DAEMON_DIR", str(Path(__file__).resolve().parent))
os.environ.setdefault("WORKSTEP_CLI_PYTHON", sys.executable)
os.environ.setdefault(
    "WORKSTEP_DAEMON_URL",
    f"http://127.0.0.1:{settings.port}",
)
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
from api.task_dispatch import router as task_dispatch_router
from api.schedule import router as schedule_router
from api.chat_session import router as chat_session_router
from api.statistics import router as statistics_router
from api.share import router as share_router
from api.assistant import router as assistant_router
from api.system_settings import router as system_settings_router
from api.git import router as git_router
from services.git import git_service
from api.skills import router as skills_router
from api.project_settings import router as project_settings_router
from api.pending_message_inserts import router as pending_message_inserts_router
from api.channels import router as channels_router
import api.remote_project as remote_project_api
from api.remote_project import router as remote_project_router
from services.project import project_manager
from services.task import TaskService
from services.intervention import intervention_manager
from services.workflow_runtime import WorkflowRuntime
from services.config import config_store
from services.desktop_security import DesktopSecurityMiddleware
from agent_assistants.coordinator import CoordinatorModule
from agent_assistants.workflow_gen import WorkflowGenModule
from agent_assistants.task_draft import TaskDraftModule
from services.schedule import ScheduleModule
from services.observability import configure_observability, instrument_fastapi
from agent_assistants.chat_session import ChatSessionModule
from agent_assistants.channel_chat import ChannelChatModule
from services.channels.manager import ChannelManager
from streaming.ws import (
    WsSubscription,
    _handle_client_message,
    matches_subscription,
    parse_subscription,
    register_websocket_routes,
)
from services.remote_project import (
    ActorSnapshot,
    BrowserActorMiddleware,
    RemoteAccessService,
    RemoteAccessGuardMiddleware,
    RemoteProjectClientManager,
    RemoteProjectProxyMiddleware,
    RemoteProjectRegistry,
)

logger = logging.getLogger(__name__)
configure_observability()

# Global event bus
event_bus = EventBus()


def _local_actor() -> ActorSnapshot:
    device = config_store.get_device_identity()
    user_name = config_store.get_user_name()
    if not user_name:
        raise ValueError("请先在系统设置中填写使用者名称")
    return ActorSnapshot(
        actor_id=device["device_id"],
        user_name=user_name,
        device_id=device["device_id"],
        device_name=device["device_name"],
        source="local",
    )


remote_access_service: RemoteAccessService = remote_project_api.remote_access_service
remote_project_registry: RemoteProjectRegistry = remote_project_api.remote_project_registry
remote_project_client = RemoteProjectClientManager(
    registry=remote_project_registry,
    actor_provider=_local_actor,
    event_sink=event_bus.publish,
)
remote_project_api.client_manager = remote_project_client

# Task service — initialized in lifespan
task_service: TaskService | None = None
workflow_runtime: WorkflowRuntime | None = None
coordinator_module: CoordinatorModule | None = None
workflow_gen_module: WorkflowGenModule | None = None
task_draft_module: TaskDraftModule | None = None
schedule_module: ScheduleModule | None = None
chat_session_module: ChatSessionModule | None = None
channel_chat_module: ChannelChatModule | None = None
channel_manager: ChannelManager | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle."""
    global task_service, workflow_runtime, coordinator_module, workflow_gen_module, task_draft_module, schedule_module, chat_session_module, channel_chat_module, channel_manager
    logger.info("WorkStep Daemon starting on %s:%d", settings.host, settings.port)
    await asyncio.to_thread(config_store.migrate_legacy_config)
    await asyncio.to_thread(ensure_global_templates)
    await asyncio.to_thread(project_manager._load_saved_projects)
    # Load concurrency limits into the in-memory gate (global defaults +
    # every project's persisted override) before any workflow starts.
    from services.concurrency import concurrency_gate
    from services.project_settings import sync_all_project_configs

    concurrency_gate.configure(
        **await asyncio.to_thread(config_store.get_concurrency_config)
    )
    await sync_all_project_configs(project_manager)
    task_service = TaskService(event_bus)
    workflow_runtime = WorkflowRuntime(event_bus, project_manager)
    recovered = await workflow_runtime.recover_running_workflows()
    if recovered:
        logger.info(
            "Recovered %d interrupted workflow run(s) from the last completed step",
            recovered,
        )
    requeued = await workflow_runtime.requeue_queued_tasks()
    if requeued:
        logger.info("Re-queued %d task(s) waiting for a concurrency slot", requeued)
    coordinator_module = CoordinatorModule(
        event_bus,
        project_manager,
        workflow_runtime,
    )
    recovered_coordinator = await coordinator_module.start()
    if recovered_coordinator:
        logger.info(
            "Recovered %d interrupted coordinator state item(s)",
            recovered_coordinator,
        )
    workflow_gen_module = WorkflowGenModule(event_bus, project_manager)
    task_draft_module = TaskDraftModule(event_bus, project_manager)
    schedule_module = ScheduleModule(
        project_manager,
        task_service,
        workflow_runtime,
        task_agent=task_draft_module,
    )
    chat_session_module = ChatSessionModule(event_bus, project_manager)
    channel_chat_module = ChannelChatModule(event_bus, project_manager)
    from services.channels.responder import ChatSessionResponder
    channel_manager = ChannelManager(
        event_bus,
        project_manager,
        ChatSessionResponder(event_bus, project_manager, channel_chat_module),
    )
    await channel_manager.start()
    recovered_chats = await asyncio.to_thread(
        chat_session_module.recover_interrupted_messages
    )
    if recovered_chats:
        logger.info(
            "Recovered %d interrupted chat message(s) from event journals",
            recovered_chats,
        )
    await schedule_module.start()
    try:
        yield
    finally:
        await git_service.close()
        from services.engine_runtime import runtime_manager
        await runtime_manager.shutdown()
        logger.info("WorkStep Daemon shutting down")
        if workflow_gen_module is not None:
            await workflow_gen_module.shutdown()
        if task_draft_module is not None:
            await task_draft_module.shutdown()
        if schedule_module is not None:
            await schedule_module.shutdown()
        if channel_manager is not None:
            await channel_manager.shutdown()
        if channel_chat_module is not None:
            await channel_chat_module.shutdown()
        if chat_session_module is not None:
            await chat_session_module.shutdown()
        await remote_project_client.close()
        await coordinator_module.shutdown()
        await workflow_runtime.shutdown()
        shutdown_task_service = getattr(task_service, "shutdown", None)
        if callable(shutdown_task_service):
            await shutdown_task_service()
        await event_bus.close()
        await asyncio.to_thread(project_manager.close_all)


app = FastAPI(title="WorkStep Daemon", lifespan=lifespan, favicon_url="/static/favicon.svg")
instrument_fastapi(app)
app.mount("/static", StaticFiles(directory="static"), name="static")
app.add_middleware(DesktopSecurityMiddleware)
app.add_middleware(
    RemoteProjectProxyMiddleware,
    registry=remote_project_registry,
    client_manager=remote_project_client,
)
app.add_middleware(
    RemoteAccessGuardMiddleware,
    access_service=remote_access_service,
)
app.add_middleware(BrowserActorMiddleware)

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
app.include_router(task_dispatch_router)
app.include_router(schedule_router)
app.include_router(chat_session_router)
app.include_router(pending_message_inserts_router)
app.include_router(statistics_router)
app.include_router(share_router)
app.include_router(assistant_router)
app.include_router(project_settings_router)
app.include_router(channels_router)
app.include_router(system_settings_router)
app.include_router(git_router)
app.include_router(skills_router)
app.include_router(remote_project_router)


# --- REST API ---


@app.get("/api/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "version": settings.version}


# --- WebSocket routes (see streaming.ws) ---
register_websocket_routes(app)


# --- Static file serving (production) ---

web_dist = Path(settings.web_dist)
landing_dist = Path(settings.landing_dist)  # 官网构建，托管在 "/landing"


def _resolve_static(root: Path, rel: str) -> Path | None:
    """Resolve a relative path inside ``root``; None when unsafe or missing.

    Dist 构建会更换哈希文件名，因此按请求实时检查文件系统，避免启动时
    的静态文件快照过期导致 /landing 等页面资源回退成 index.html。
    """
    if not rel or rel.startswith(("/", "\\", "..")):
        return None
    base = root.resolve()
    candidate = (root / rel).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


if web_dist.exists() or landing_dist.exists():
    from starlette.responses import FileResponse as _FileResponse

    from fastapi.responses import JSONResponse as _JSONResponse

    _web_dist_index = web_dist / "index.html" if web_dist.exists() else None
    _landing_dist_index = landing_dist / "index.html" if landing_dist.exists() else None

    @app.get("/{fullpath:path}", include_in_schema=False)
    async def _spa_fallback(fullpath: str):
        # "/landing" 指向官网（apps/landing）构建；home "/" 仍是 Web 应用。
        if fullpath == "landing" or fullpath.startswith("landing/"):
            rel = fullpath[len("landing/") :] if fullpath.startswith("landing/") else ""
            if _landing_dist_index is not None:
                if rel:
                    candidate = await asyncio.to_thread(
                        _resolve_static, landing_dist, rel
                    )
                    if candidate is not None:
                        return _FileResponse(candidate)
                return _FileResponse(_landing_dist_index)
            return _JSONResponse({"detail": "Not found"}, status_code=404)
        # Web 应用接管 home。
        if fullpath:
            candidate = await asyncio.to_thread(_resolve_static, web_dist, fullpath)
            if candidate is not None:
                return _FileResponse(candidate)
        if _web_dist_index is not None:
            return _FileResponse(_web_dist_index)
        return _JSONResponse({"detail": "Not found"}, status_code=404)

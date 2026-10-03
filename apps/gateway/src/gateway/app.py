import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException
from workstep_gateway_protocol import PROTOCOL_VERSION

from .config import GatewaySettings
from .database import GatewayDatabase
from .identity_api import router as identity_router
from .external_identity_api import router as external_identity_router
from .directory_callbacks import router as directory_callbacks_router
from .identity_connectors import DingTalkConnector, WeComConnector
from .rate_limit import IdentityRateLimiter
from .reconciliation import DirectoryReconciler
from .signing import GatewaySigner
from .desktop_authorization_api import router as desktop_authorization_router
from .client_releases import router as client_releases_router
from .control_connection import ControlConnections, router as control_router
from .capabilities import router as capabilities_router
from .user_devices_api import router as user_devices_router
from .remote_access_api import (router as remote_access_router,
                                websocket_router as remote_websocket_router,
                                proxy_remote_request)
from .providers_api import router as providers_router
from .device_commands import router as device_commands_router
from .usage_ledger import router as usage_router
from .usage_rollups import run_periodic as run_usage_rollups
from .audit_ledger import router as audit_router
from .groups_api import router as groups_router
from .skills_api import (router as skills_router,
                         admin_group_router as admin_group_skills_router,
                         project_skill_router, device_skill_router)
from .project_access_api import router as project_access_router
from .platform_shares import router as platform_shares_router
from .admin_shares import router as admin_shares_router
from .admin_overview import router as admin_overview_router
from .org_api import router as org_router
from .device_groups_api import router as device_groups_router


def create_app(settings: GatewaySettings | None = None) -> FastAPI:
    settings = settings or GatewaySettings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        database = GatewayDatabase(settings)
        await database.start()
        app.state.database = database
        app.state.gateway_signer = await asyncio.to_thread(
            GatewaySigner.load_or_create, settings.data_dir / "gateway-signing-key.pem",
        )
        app.state.ready = True
        stop_reconciliation = asyncio.Event()
        callback_wake = asyncio.Event()
        app.state.directory_callback_wake = callback_wake
        reconciler = DirectoryReconciler(database, app.state.identity_connectors)
        app.state.directory_reconciler = reconciler
        reconciliation_task = asyncio.create_task(reconciler.run_periodic(
            stop_reconciliation, interval_seconds=settings.directory_reconcile_seconds,
        ))
        callback_task = asyncio.create_task(reconciler.run_callback_periodic(
            stop_reconciliation, callback_wake,
        ))
        rollup_task = asyncio.create_task(run_usage_rollups(database, stop_reconciliation))
        try:
            yield
        finally:
            app.state.ready = False
            stop_reconciliation.set()
            callback_wake.set()
            await app.state.control_connections.shutdown()
            await reconciliation_task
            await callback_task
            await rollup_task
            await database.close()

    app = FastAPI(title="WorkStep Gateway", lifespan=lifespan)
    app.state.ready = False
    app.state.settings = settings
    app.state.protocol_version = PROTOCOL_VERSION
    app.state.identity_rate_limiter = IdentityRateLimiter()
    app.state.identity_connectors = {"dingtalk": DingTalkConnector(), "wecom": WeComConnector()}
    app.state.control_connections = ControlConnections()
    app.state.command_scheduler_lock = asyncio.Lock()
    app.state.usage_ledger_lock = asyncio.Lock()
    app.state.usage_batch_slots = asyncio.Semaphore(2)
    app.state.share_upload_slots = asyncio.Semaphore(2)
    app.state.usage_batch_timeout_seconds = 10.0

    from .request_audit import audit_admin_request
    app.middleware("http")(audit_admin_request)

    @app.middleware("http")
    async def device_host_boundary(request: Request, call_next):
        if settings.public_origin:
            host = request.headers.get("host", "").lower()
            if settings.is_device_authority(host):
                if request.url.path not in ("/api/remote/redeem", "/api/remote/session",
                                            "/api/remote/project-grants"):
                    try:
                        return await proxy_remote_request(request)
                    except HTTPException as exc:
                        return await http_error(request, exc)
        return await call_next(request)

    @app.exception_handler(HTTPException)
    async def http_error(_request: Request, exc: HTTPException) -> JSONResponse:
        code = "not_found" if exc.status_code == 404 else "http_error"
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": code, "message": str(exc.detail)}},
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, _exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={"error": {"code": "validation_error", "message": "Invalid request"}},
        )

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(identity_router)
    app.include_router(admin_overview_router)
    app.include_router(org_router)
    app.include_router(device_groups_router)
    app.include_router(external_identity_router)
    app.include_router(directory_callbacks_router)
    app.include_router(desktop_authorization_router)
    app.include_router(client_releases_router)
    app.include_router(control_router)
    app.include_router(capabilities_router)
    app.include_router(user_devices_router)
    app.include_router(remote_access_router)
    app.include_router(remote_websocket_router)
    app.include_router(providers_router)
    app.include_router(device_commands_router)
    app.include_router(usage_router)
    app.include_router(audit_router)
    app.include_router(groups_router)
    app.include_router(skills_router)
    app.include_router(admin_group_skills_router)
    app.include_router(project_skill_router)
    app.include_router(device_skill_router)
    app.include_router(project_access_router)
    app.include_router(platform_shares_router)
    app.include_router(admin_shares_router)

    if settings.web_dist and settings.web_dist.is_dir():
        assets = settings.web_dist / "assets"
        if assets.is_dir():
            app.mount("/assets", StaticFiles(directory=assets), name="gateway-assets")

        @app.get("/{path:path}", include_in_schema=False)
        async def portal(path: str) -> FileResponse:
            if path.startswith("api/") or "." in path:
                raise HTTPException(status_code=404)
            return FileResponse(settings.web_dist / "index.html")
    return app


app = create_app()

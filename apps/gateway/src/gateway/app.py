import asyncio
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException
from workstep_gateway_protocol import PROTOCOL_VERSION

from gateway.config import GatewaySettings
from gateway.api.share_viewer import install_share_viewer
from gateway.database import GatewayDatabase
from gateway.api.errors import identity_error_response, gateway_error_response
from gateway.services.errors import GatewayError
from gateway.api.adapters import invoke
from gateway.services.identity_errors import IdentityError
from gateway.api.identity_api import router as identity_router
from gateway.api.external_identity_api import router as external_identity_router
from gateway.api.directory_callbacks import router as directory_callbacks_router
from gateway.services.identity_connectors import DingTalkConnector, WeComConnector
from gateway.services.rate_limit import IdentityRateLimiter
from gateway.services.reconciliation import DirectoryReconciler
from gateway.services.signing import GatewaySigner
from gateway.api.desktop_authorization_api import router as desktop_authorization_router
from gateway.api.client_releases import router as client_releases_router
from gateway.services.control_connection import ControlConnections
from gateway.api.control_connection import router as control_router
from gateway.api.capabilities import router as capabilities_router
from gateway.api.permissions import router as permissions_router
from gateway.api.user_devices_api import router as user_devices_router
from gateway.api.remote_access_api import router as remote_access_router, websocket_router as remote_websocket_router
from gateway.services.remote_access_api import proxy_remote_request
from gateway.api.providers_api import router as providers_router
from gateway.api.device_commands import router as device_commands_router
from gateway.api.usage_ledger import router as usage_router
from gateway.services.usage_rollups import run_periodic as run_usage_rollups
from gateway.api.audit_ledger import router as audit_router
from gateway.api.groups_api import router as groups_router
from gateway.api.skills_api import router as skills_router, admin_group_router as admin_group_skills_router, project_skill_router, device_skill_router
from gateway.api.project_access_api import router as project_access_router
from gateway.api.project_invitations import router as project_invitations_router
from gateway.api.platform_shares import router as platform_shares_router
from gateway.api.admin_shares import router as admin_shares_router
from gateway.api.admin_overview import router as admin_overview_router
from gateway.api.org_api import router as org_router
from gateway.api.device_groups_api import router as device_groups_router
from gateway.api.notifications import router as notifications_router,compat_router as legacy_notifications_router
from gateway.services.notifications import NotificationService


def create_app(settings: GatewaySettings | None = None) -> FastAPI:
    if settings is None:
        settings = GatewaySettings()
        apps_dir = Path(__file__).resolve().parents[3]
        settings.web_dist = settings.web_dist or apps_dir / "gateway-web" / "dist"
        settings.workspace_web_dist = settings.workspace_web_dist or apps_dir / "web" / "dist-gateway-share"

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        database = GatewayDatabase(settings)
        await database.start()
        from gateway.services.platform_address import restore_platform_address
        await restore_platform_address(database, settings)
        app.state.database = database
        app.state.gateway_signer = await asyncio.to_thread(
            GatewaySigner.load_or_create, settings.data_dir / "gateway-signing-key.pem",
        )
        app.state.ready = True
        app.state.notifications = NotificationService(database,app.state.control_connections,settings)
        app.state.notifications.task = asyncio.create_task(app.state.notifications.run())
        stop_reconciliation = asyncio.Event()
        callback_wake = asyncio.Event()
        app.state.directory_callback_wake = callback_wake
        reconciler = DirectoryReconciler(database, app.state.identity_connectors)
        app.state.directory_reconciler = reconciler
        await reconciler.jobs.recover()
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
            await app.state.notifications.close()
            stop_reconciliation.set()
            callback_wake.set()
            await reconciler.jobs.close()
            await app.state.control_connections.shutdown()
            await reconciliation_task
            await callback_task
            await rollup_task
            await database.close()

    app = FastAPI(title="WorkStep Gateway", lifespan=lifespan)
    app.add_exception_handler(IdentityError, identity_error_response)
    app.add_exception_handler(GatewayError, gateway_error_response)
    app.state.ready = False
    app.state.settings = settings
    app.state.protocol_version = PROTOCOL_VERSION
    app.state.identity_rate_limiter = IdentityRateLimiter()
    async def resolve_identity_secret(source):
        from gateway.services.organization_settings import application_secret
        return await application_secret(app.state.database, app.state.gateway_signer, source)
    app.state.identity_connectors = {"dingtalk": DingTalkConnector(secret_resolver=resolve_identity_secret), "wecom": WeComConnector(secret_resolver=resolve_identity_secret)}
    app.state.control_connections = ControlConnections()
    app.state.command_scheduler_lock = asyncio.Lock()
    app.state.usage_ledger_lock = asyncio.Lock()
    app.state.usage_batch_slots = asyncio.Semaphore(2)
    app.state.share_upload_slots = asyncio.Semaphore(2)
    app.state.usage_batch_timeout_seconds = 10.0

    from gateway.api.request_audit import audit_admin_request
    app.middleware("http")(audit_admin_request)

    @app.middleware("http")
    async def device_host_boundary(request: Request, call_next):
        path_parts = request.url.path.split('/', 3)
        if len(path_parts) == 4 and path_parts[1] == 'workspace' and path_parts[2]:
            local_path = '/' + path_parts[3]
            gateway_route = (local_path in ('/api/remote/redeem', '/api/remote/session', '/api/remote/project-grants', '/api/remote/devices')
                or (local_path.startswith('/api/remote/devices/') and local_path.endswith('/access') and len(local_path.split('/')) == 6))
            if not gateway_route:
                try:
                    return await invoke(proxy_remote_request, request=request)
                except IdentityError as exc:
                    return await identity_error_response(request, exc)
                except GatewayError as exc:
                    return await gateway_error_response(request, exc)
        if settings.public_origin:
            host = request.headers.get("host", "").lower()
            if settings.is_device_authority(host):
                is_device_switch = (request.method == 'GET' and (request.url.path == '/api/remote/devices'
                    or (request.url.path.startswith('/api/remote/devices/') and request.url.path.endswith('/access')
                        and len(request.url.path.split('/')) == 6)))
                if not is_device_switch and request.url.path not in ("/api/remote/redeem", "/api/remote/session",
                                            "/api/remote/project-grants"):
                    try:
                        return await invoke(proxy_remote_request, request=request)
                    except IdentityError as exc:
                        return await identity_error_response(request, exc)
                    except GatewayError as exc:
                        return await gateway_error_response(request, exc)
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
    app.include_router(notifications_router)
    app.include_router(legacy_notifications_router)
    app.include_router(admin_overview_router)
    app.include_router(org_router)
    app.include_router(device_groups_router)
    app.include_router(external_identity_router)
    app.include_router(directory_callbacks_router)
    app.include_router(desktop_authorization_router)
    app.include_router(client_releases_router)
    app.include_router(control_router)
    app.include_router(capabilities_router)
    app.include_router(permissions_router)
    app.include_router(user_devices_router)
    app.include_router(remote_access_router)
    app.include_router(remote_access_router, prefix="/workspace/{workspace_device_id}")
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
    app.include_router(project_invitations_router)
    app.include_router(platform_shares_router)
    app.include_router(admin_shares_router)
    install_share_viewer(app, settings)

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
